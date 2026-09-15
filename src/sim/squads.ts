import { type Vec2, angleOf, dist, fromAngle, normalize, sub, vec } from './math.ts';
import type { Scene } from './world/scene.ts';
import { Stature } from './world/occlusion.ts';
import { type SquadMorale, freshMorale, willFollow } from './morale.ts';
import { type Faction, MoveMode, type Unit } from './units.ts';

export interface SquadOrder {
  dest: Vec2;
  mode: MoveMode;
  /** Set when the player dragged a direction; otherwise inferred from threats. */
  facing: number | null;
  issuedAt: number;
}

export interface Squad {
  id: number;
  name: string;
  faction: Faction;
  memberIds: number[];
  order: SquadOrder | null;
  /** Direction the squad believes danger lies in. Drives every cover choice. */
  threatDir: Vec2;
  /** How it is holding up, summed from the men. Read-only: nerve is theirs. */
  morale: SquadMorale;
}

export { freshMorale };

/** How far from the order point an operator will range to find real cover. */
const COVER_SEARCH_RADIUS = 11;
/** Operators any closer than this share a grenade. */
const MIN_SPACING = 2.4;
/** Over this distance, standing near a mate stops counting against a position. */
const SPREAD = 4.5;
/** How hard the team pushes apart along whatever cover it is using. */
const CROWD_WEIGHT = 0.85;
/** How much a position's field of fire counts against its cover. */
const FIRE_WEIGHT = 0.8;
/** Covering this much of the sector is a real fighting position. */
const GOOD_FIELD_OF_FIRE = 0.35;
/** And below this it is a hiding place, which the player should be told. */
const MIN_FIELD_OF_FIRE = 0.12;
/** Sightlines are not free, so only the best cover gets its view priced. */
const FIRE_BUDGET = 44;
/**
 * How hard a position is pulled back towards the point the player clicked —
 * split into depth and frontage, because a firing line is wide and shallow.
 *
 * A single circular pull cannot tell "further along the wall" from "further
 * back from it", so the team settles into a blob around the cursor with its
 * last man in the second rank. Charging four times as much for depth as for
 * frontage says the thing the player actually meant: spread out along this,
 * and stay on it.
 */
const DEPTH_WEIGHT = 0.85;
const FRONTAGE_WEIGHT = 0.2;
/** How far out the imaginary threat is placed when measuring a position. */
const THREAT_DISTANCE = 70;

export function squadCentre(squad: Squad, units: Map<number, Unit>): Vec2 {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of squad.memberIds) {
    const u = units.get(id);
    if (!u) continue;
    x += u.pos.x;
    y += u.pos.y;
    n++;
  }
  return n === 0 ? vec(0, 0) : vec(x / n, y / n);
}

/** Wedge offsets, in squad-local space (x right, y back from the threat). */
const WEDGE: Vec2[] = [
  { x: 0, y: 0 },
  { x: -2.0, y: 1.8 },
  { x: 2.0, y: 1.8 },
  { x: -4.0, y: 3.6 },
  { x: 4.0, y: 3.6 },
  { x: 0, y: 3.6 },
];

function formationSlot(scene: Scene, dest: Vec2, threatDir: Vec2, index: number): Vec2 {
  const offset = WEDGE[index % WEDGE.length];
  const back = { x: -threatDir.x, y: -threatDir.y };
  const right = { x: -threatDir.y, y: threatDir.x };
  const p = {
    x: dest.x + right.x * offset.x + back.x * offset.y,
    y: dest.y + right.y * offset.x + back.y * offset.y,
  };
  if (scene.walkable(p.x, p.y)) return p;

  // Spiral out until we find ground a body fits on.
  for (let r = 1; r <= 6; r++) {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const q = { x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r };
      if (scene.walkable(q.x, q.y)) return q;
    }
  }
  return { ...dest };
}

/** One operator's share of an order: where he goes and what it costs him. */
export interface PlannedSlot {
  unitId: number;
  pos: Vec2;
  /** 0..1 of him that would show from the direction the trouble is in. */
  exposure: number;
  /** Whether he could fight from there, or would only be hidden. */
  canFire: boolean;
  /** 0..1 of the sector he could actually engage from there. */
  fire: number;
  facing: number;
}

export interface SquadPlan {
  threatDir: Vec2;
  slots: PlannedSlot[];
}

/**
 * Turn one squad-level order into one fighting position per operator.
 *
 * Positions are no longer looked up from a table of cover. Candidates around
 * the order point are measured directly — how much of me shows from over
 * there, and can I shoot back from here — so a ditch, a reverse slope and a
 * garden wall all compete on the same terms without any of them being a
 * special case.
 *
 * Nothing here touches a unit, so the same call answers "where would they go"
 * for the cursor preview as answers "where do they go" for the order itself.
 * The player therefore sees the plan he is about to buy, rather than a guess
 * at it.
 */
export function planSlots(
  scene: Scene,
  squad: Squad,
  units: Map<number, Unit>,
  order: SquadOrder,
): SquadPlan {
  // Only the men who would actually go. A broken man is not listening and a
  // shaken one will not be walked forward, so planning them a fighting position
  // would draw the player a line to ground nobody is going to hold.
  const members = squad.memberIds
    .map((id) => units.get(id))
    .filter((u): u is Unit => !!u && willFollow(u, order.dest));
  const threatDir = resolveThreatDir(squad, order, members);
  if (members.length === 0) return { threatDir, slots: [] };

  const threatPoint = vec(
    order.dest.x + threatDir.x * THREAT_DISTANCE,
    order.dest.y + threatDir.y * THREAT_DISTANCE,
  );
  const facing = order.facing ?? angleOf(threatDir);

  if (order.mode === MoveMode.Sprint) {
    // Speed is the entire point of a sprint. A team that stops to admire a
    // wall halfway across open ground dies there. The exposure is still
    // measured, because that is exactly what the player needs to know before
    // ordering one.
    return {
      threatDir,
      slots: members.map((u, i) => {
        const pos = formationSlot(scene, order.dest, threatDir, i);
        const measured = measure(scene, pos, order.dest, threatPoint);
        // A sprint is not a fighting position and is not pretending to be, so
        // its field of fire is whatever the geometry happens to give.
        return {
          unitId: u.id, pos, facing: order.facing ?? facing,
          exposure: measured.exposure,
          canFire: measured.canFire,
          fire: measured.canFire ? 1 : 0,
        };
      }),
    };
  }

  const candidates = scene.findCover(order.dest, COVER_SEARCH_RADIUS, threatPoint, {
    crouchTop: Stature.crouchedTop,
    eye: Stature.crouchedEye,
  });

  // What this team is being asked to cover, which is the question the defence
  // has always asked of its own positions and the player's orders never did.
  //
  // Without it the planner ranks by cover alone, and behind a solid wall every
  // candidate scores a perfect nothing-shows. The ordering then collapses to
  // "nearest", the team is posted somewhere it cannot shoot from, and the
  // player has bought a hiding place while believing he bought a position.
  const sector = scene.sectorFan(order.dest, facing);

  // Priced lazily down the cover-ranked list: a field of fire costs fifteen
  // sightlines and this runs under the cursor, so only the ground worth
  // standing on gets asked what it can see.
  const graded: { spot: (typeof candidates)[number]; fire: number }[] = [];
  for (const spot of candidates) {
    if (graded.length >= FIRE_BUDGET) break;
    const fire = sector.length === 0
      ? (spot.canFire ? 1 : 0)
      : scene.fieldOfFire(spot.pos, sector, Stature.crouchedEye);
    graded.push({ spot, fire });
  }

  // Whoever carries the belt-fed picks first: the support weapon's position
  // decides where the squad can suppress from, and the rest works around it.
  const ordered = [...members].sort((a, b) => rolePriority(b) - rolePriority(a));
  const taken: Vec2[] = [];
  const slots: PlannedSlot[] = [];
  let formationIndex = 0;

  for (const u of ordered) {
    let best: (typeof graded)[number] | null = null;
    let bestCost = Infinity;

    for (const g of graded) {
      if (taken.some((t) => dist(t, g.spot.pos) < MIN_SPACING)) continue;
      // Soft rather than a hard minimum. A hard floor lets four men satisfy it
      // inside five metres and call that a firing line; a cost that fades out
      // over seven strings them along whatever they are using.
      const crowd = taken.reduce(
        (a, t) => a + Math.max(0, 1 - dist(t, g.spot.pos) / SPREAD), 0,
      ) * CROWD_WEIGHT;
      const blind = 1 - Math.min(1, g.fire / GOOD_FIELD_OF_FIRE);
      const offX = g.spot.pos.x - order.dest.x;
      const offY = g.spot.pos.y - order.dest.y;
      const depth = Math.abs(offX * threatDir.x + offY * threatDir.y);
      const frontage = Math.abs(offX * -threatDir.y + offY * threatDir.x);
      const stray = (depth * DEPTH_WEIGHT + frontage * FRONTAGE_WEIGHT) / COVER_SEARCH_RADIUS;
      const cost = g.spot.exposure + blind * FIRE_WEIGHT + crowd + stray;
      if (cost < bestCost) {
        bestCost = cost;
        best = g;
      }
    }

    if (best) {
      taken.push(best.spot.pos);
      slots.push({
        unitId: u.id, pos: { ...best.spot.pos }, facing,
        exposure: best.spot.exposure,
        fire: best.fire,
        canFire: best.fire >= MIN_FIELD_OF_FIRE,
      });
    } else {
      const pos = formationSlot(scene, order.dest, threatDir, formationIndex++);
      taken.push(pos);
      const measured = measure(scene, pos, order.dest, threatPoint);
      const fire = sector.length === 0
        ? (measured.canFire ? 1 : 0)
        : scene.fieldOfFire(pos, sector, Stature.crouchedEye);
      slots.push({
        unitId: u.id, pos, facing,
        exposure: measured.exposure, fire, canFire: fire >= MIN_FIELD_OF_FIRE,
      });
    }
  }
  return { threatDir, slots };
}

/**
 * Apply a plan. The only thing in here that writes to a unit.
 *
 * Returns the men who took it, which may be fewer than the team has — an order
 * a team only half obeys is a thing the caller needs to be able to say.
 */
export function assignSlots(
  scene: Scene,
  squad: Squad,
  units: Map<number, Unit>,
  order: SquadOrder,
): Unit[] {
  const plan = planSlots(scene, squad, units, order);
  squad.threatDir = plan.threatDir;

  const moved: Unit[] = [];
  for (const slot of plan.slots) {
    const u = units.get(slot.unitId);
    if (!u) continue;
    u.coverSpot = null;
    u.slot = { ...slot.pos };
    u.postFacing = order.mode === MoveMode.Sprint ? order.facing : slot.facing;
    moved.push(u);
  }
  return moved;
}

/** What a given patch of ground costs an operator who stands on it. */
function measure(scene: Scene, pos: Vec2, around: Vec2, threat: Vec2) {
  return scene.stance(
    pos, scene.threatArc(around, threat), Stature.crouchedTop, Stature.crouchedEye,
  );
}

/**
 * Fan multiple selected teams out so one order does not stack them.
 *
 * It lives beside the planner because the cursor preview has to offset teams
 * exactly the way the order will, or it shows the player the wrong plan.
 */
export function spreadOffset(index: number, total: number): Vec2 {
  if (total <= 1) return vec(0, 0);
  const angle = (index / total) * Math.PI * 2;
  const radius = 2.2;
  return vec(Math.cos(angle) * radius, Math.sin(angle) * radius);
}

function rolePriority(u: Unit): number {
  switch (u.role) {
    case 'Automatic Rifleman':
      return 3;
    case 'Marksman':
      return 2;
    case 'Team Leader':
      return 1;
    default:
      return 0;
  }
}

/**
 * Which way is the danger? An explicit drag from the player wins. Failing that,
 * the squad's own memory of where it last saw someone. Failing that, forward.
 */
function resolveThreatDir(squad: Squad, order: SquadOrder, members: Unit[]): Vec2 {
  if (order.facing !== null) return fromAngle(order.facing);

  let nearest: Vec2 | null = null;
  let nearestD = Infinity;
  for (const u of members) {
    for (const [, mem] of u.memory) {
      const d = dist(mem.pos, order.dest);
      if (d < nearestD) {
        nearestD = d;
        nearest = mem.pos;
      }
    }
  }
  if (nearest && nearestD < 90) {
    const dir = normalize(sub(nearest, order.dest));
    if (dir.x !== 0 || dir.y !== 0) return dir;
  }

  const centre = members.reduce(
    (acc, u) => ({ x: acc.x + u.pos.x / members.length, y: acc.y + u.pos.y / members.length }),
    vec(0, 0),
  );
  const travel = normalize(sub(order.dest, centre));
  return travel.x === 0 && travel.y === 0 ? squad.threatDir : travel;
}
