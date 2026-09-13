import {
  type Vec2, angleOf, dist, dot, fromAngle, invLerpClamped, normalize, sub, vec,
} from './math.ts';
import { World, type CoverNode } from './world.ts';
import { hasLineOfSight } from './los.ts';
import { nearestWalkable } from './pathfind.ts';
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
const MIN_SPACING = 1.6;

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

/**
 * Score a cover node for an operator who is about to fight facing `threatDir`.
 *
 * The non-obvious term is the last one: cover you cannot shoot out of is a
 * hiding place, not a fighting position. Without it, squads reliably tuck
 * themselves behind the wrong side of a wall and win nothing.
 */
function scoreNode(
  world: World,
  node: CoverNode,
  dest: Vec2,
  threatDir: Vec2,
  taken: Vec2[],
): number {
  let protection = 0;
  for (const arc of node.arcs) {
    const alignment = dot(arc.dir, threatDir);
    if (alignment <= 0.2) continue;
    protection = Math.max(protection, arc.value * invLerpClamped(alignment, 0.2, 0.7));
  }
  if (protection <= 0) return -Infinity;

  const d = dist(node.pos, dest);
  if (d > COVER_SEARCH_RADIUS) return -Infinity;
  const proximity = 1 - d / COVER_SEARCH_RADIUS;

  // Keep the team spread out.
  let crowding = 0;
  for (const t of taken) {
    const sep = dist(node.pos, t);
    if (sep < MIN_SPACING) crowding += (MIN_SPACING - sep) / MIN_SPACING;
  }

  // Can we actually engage from here?
  const lookout = {
    x: node.pos.x + threatDir.x * 9,
    y: node.pos.y + threatDir.y * 9,
  };
  const canFire = hasLineOfSight(world, node.pos, lookout) ? 1 : 0;

  return protection * 2.2 + proximity * 1.4 + canFire * 1.1 - crowding * 2.0;
}

/** Wedge offsets, in squad-local space (x right, y back from the threat). */
const WEDGE: Vec2[] = [
  { x: 0, y: 0 },
  { x: -1.5, y: 1.3 },
  { x: 1.5, y: 1.3 },
  { x: -3.0, y: 2.6 },
  { x: 3.0, y: 2.6 },
  { x: 0, y: 2.6 },
];

function formationSlot(
  world: World,
  dest: Vec2,
  threatDir: Vec2,
  index: number,
): Vec2 {
  const offset = WEDGE[index % WEDGE.length];
  // Local +y points away from the threat; +x is to its right.
  const back = { x: -threatDir.x, y: -threatDir.y };
  const right = { x: -threatDir.y, y: threatDir.x };
  const p = {
    x: dest.x + right.x * offset.x + back.x * offset.y,
    y: dest.y + right.y * offset.x + back.y * offset.y,
  };
  const t = World.toTile(p);
  const ok = nearestWalkable(world, t.tx, t.ty, 4);
  return ok ? World.centre(ok.tx, ok.ty) : { ...dest };
}

/**
 * Turn one squad-level order into one destination per operator.
 *
 * Tactical moves fan the team out across the best cover facing the threat.
 * Sprints do not bother — speed is the entire point of a sprint, and a team
 * that stops to admire a wall halfway across open ground dies there.
 */
export function assignSlots(
  world: World,
  squad: Squad,
  units: Map<number, Unit>,
  order: SquadOrder,
): void {
  const members = squad.memberIds
    .map((id) => units.get(id))
    .filter((u): u is Unit => !!u && u.state === UnitState.Active);
  if (members.length === 0) return;

  const threatDir = resolveThreatDir(squad, order, members);
  squad.threatDir = threatDir;

  for (const u of members) {
    if (u.claimedNode) {
      u.claimedNode.claimedBy = null;
      u.claimedNode = null;
    }
  }

  if (order.mode === MoveMode.Sprint) {
    members.forEach((u, i) => {
      u.slot = formationSlot(world, order.dest, threatDir, i);
      u.postFacing = order.facing;
    });
    return;
  }

  const candidates = world
    .coverNear(order.dest, COVER_SEARCH_RADIUS)
    .filter((n) => n.claimedBy === null);

  // Whoever carries the belt-fed gets first pick: the support weapon's position
  // decides where the squad can suppress from, and everything else follows it.
  const ordered = [...members].sort(
    (a, b) => rolePriority(b) - rolePriority(a),
  );

  const taken: Vec2[] = [];
  let formationIndex = 0;

  for (const u of ordered) {
    let bestNode: CoverNode | null = null;
    let bestScore = -Infinity;
    for (const node of candidates) {
      if (node.claimedBy !== null) continue;
      const s = scoreNode(world, node, order.dest, threatDir, taken);
      if (s > bestScore) {
        bestScore = s;
        bestNode = node;
      }
    }

    if (bestNode && bestScore > -Infinity) {
      bestNode.claimedBy = u.id;
      u.claimedNode = bestNode;
      u.slot = { ...bestNode.pos };
      taken.push(bestNode.pos);
    } else {
      u.slot = formationSlot(world, order.dest, threatDir, formationIndex++);
      taken.push(u.slot);
    }
    u.postFacing = order.facing ?? angleOf(threatDir);
  }
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
  if (nearest && nearestD < 40) {
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
