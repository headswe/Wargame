import { type Vec2, angleOf, dist, fromAngle, normalize, sub, vec } from './math.ts';
import type { Scene } from './world/scene.ts';
import { Stature } from './world/occlusion.ts';
import { Faction, MoveMode, UnitState, type Unit } from './units.ts';

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
}

/** How far from the order point an operator will range to find real cover. */
const COVER_SEARCH_RADIUS = 9;
/** Operators any closer than this share a grenade. */
const MIN_SPACING = 2.0;
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
  const members = squad.memberIds
    .map((id) => units.get(id))
    .filter((u): u is Unit => !!u && u.state === UnitState.Active);
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
        return { unitId: u.id, pos, facing: order.facing ?? facing, ...measure(scene, pos, order.dest, threatPoint) };
      }),
    };
  }

  const candidates = scene.findCover(order.dest, COVER_SEARCH_RADIUS, threatPoint, {
    crouchTop: Stature.crouchedTop,
    eye: Stature.crouchedEye,
  });

  // Whoever carries the belt-fed picks first: the support weapon's position
  // decides where the squad can suppress from, and the rest works around it.
  const ordered = [...members].sort((a, b) => rolePriority(b) - rolePriority(a));
  const taken: Vec2[] = [];
  const slots: PlannedSlot[] = [];
  let formationIndex = 0;

  for (const u of ordered) {
    const pick = candidates.find((c) => !taken.some((t) => dist(t, c.pos) < MIN_SPACING));
    if (pick) {
      taken.push(pick.pos);
      slots.push({
        unitId: u.id, pos: { ...pick.pos }, facing,
        exposure: pick.exposure, canFire: pick.canFire,
      });
    } else {
      const pos = formationSlot(scene, order.dest, threatDir, formationIndex++);
      taken.push(pos);
      slots.push({ unitId: u.id, pos, facing, ...measure(scene, pos, order.dest, threatPoint) });
    }
  }
  return { threatDir, slots };
}

/** Apply a plan. The only thing in here that writes to a unit. */
export function assignSlots(
  scene: Scene,
  squad: Squad,
  units: Map<number, Unit>,
  order: SquadOrder,
): void {
  const plan = planSlots(scene, squad, units, order);
  squad.threatDir = plan.threatDir;

  for (const slot of plan.slots) {
    const u = units.get(slot.unitId);
    if (!u) continue;
    u.coverSpot = null;
    u.slot = { ...slot.pos };
    u.postFacing = order.mode === MoveMode.Sprint ? order.facing : slot.facing;
  }
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
