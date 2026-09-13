import { type Vec2 } from './math.ts';
import { World } from './world.ts';
import { lineWalkable } from './los.ts';

/** Min-heap keyed by f-score. Plain arrays; this runs many times a second. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < this.items.length && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [
  { dx: 1, dy: 0, cost: 1 },
  { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 },
  { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: SQRT2 },
  { dx: 1, dy: -1, cost: SQRT2 },
  { dx: -1, dy: 1, cost: SQRT2 },
  { dx: -1, dy: -1, cost: SQRT2 },
];

// Scratch buffers, reused across calls so pathing does not churn the heap.
let gScore = new Float32Array(0);
let cameFrom = new Int32Array(0);
let visitGen = new Int32Array(0);
let closedGen = new Int32Array(0);
let generation = 0;

function ensureBuffers(size: number): void {
  if (gScore.length >= size) return;
  gScore = new Float32Array(size);
  cameFrom = new Int32Array(size);
  visitGen = new Int32Array(size);
  closedGen = new Int32Array(size);
  generation = 0;
}

/** Octile distance — the exact cost of an unobstructed 8-way walk. */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * A* over the tile grid. Returns world-space waypoints, already string-pulled,
 * or null if the goal is unreachable.
 */
export function findPath(world: World, from: Vec2, to: Vec2): Vec2[] | null {
  const startT = World.toTile(from);
  let goalT = World.toTile(to);

  if (!world.walkable(goalT.tx, goalT.ty)) {
    const fallback = nearestWalkable(world, goalT.tx, goalT.ty, 4);
    if (!fallback) return null;
    goalT = fallback;
  }
  if (!world.walkable(startT.tx, startT.ty)) {
    const fallback = nearestWalkable(world, startT.tx, startT.ty, 3);
    if (!fallback) return null;
    startT.tx = fallback.tx;
    startT.ty = fallback.ty;
  }

  const w = world.width;
  const size = w * world.height;
  ensureBuffers(size);
  generation++;

  const startIdx = startT.ty * w + startT.tx;
  const goalIdx = goalT.ty * w + goalT.tx;
  if (startIdx === goalIdx) return [{ ...to }];

  const open = new Heap();
  gScore[startIdx] = 0;
  cameFrom[startIdx] = -1;
  visitGen[startIdx] = generation;
  open.push(startIdx, heuristic(startT.tx, startT.ty, goalT.tx, goalT.ty));

  let found = false;

  while (open.size > 0) {
    const current = open.pop();
    // The heap holds stale duplicates for any tile we found a cheaper route to.
    // Without this check they get re-expanded, the search burns its budget on
    // work it already did, and reachable goals come back as unreachable.
    if (closedGen[current] === generation) continue;
    closedGen[current] = generation;

    if (current === goalIdx) {
      found = true;
      break;
    }
    const cx = current % w;
    const cy = (current / w) | 0;
    const cg = gScore[current];

    for (const n of NEIGHBOURS) {
      const nx = cx + n.dx;
      const ny = cy + n.dy;
      if (!world.walkable(nx, ny)) continue;
      // No squeezing through the diagonal gap between two blockers.
      if (n.dx !== 0 && n.dy !== 0) {
        if (!world.walkable(cx + n.dx, cy) || !world.walkable(cx, cy + n.dy)) continue;
      }
      const nIdx = ny * w + nx;
      const tentative = cg + n.cost;
      if (visitGen[nIdx] === generation && tentative >= gScore[nIdx]) continue;
      visitGen[nIdx] = generation;
      gScore[nIdx] = tentative;
      cameFrom[nIdx] = current;
      open.push(nIdx, tentative + heuristic(nx, ny, goalT.tx, goalT.ty));
    }
  }

  if (!found) return null;

  const tilePath: Vec2[] = [];
  for (let idx = goalIdx; idx !== -1; idx = cameFrom[idx]) {
    tilePath.push(World.centre(idx % w, (idx / w) | 0));
    if (idx === startIdx) break;
  }
  tilePath.reverse();
  tilePath[tilePath.length - 1] = { ...to };

  return smooth(world, from, tilePath);
}

/**
 * String-pulling: drop any waypoint you can see straight past. Without this,
 * units visibly stair-step along tile centres and read as robots.
 */
function smooth(world: World, from: Vec2, path: Vec2[]): Vec2[] {
  if (path.length <= 1) return path;
  const out: Vec2[] = [];
  let anchor = from;
  let i = 0;
  while (i < path.length) {
    let furthest = i;
    for (let j = path.length - 1; j > i; j--) {
      if (lineWalkable(world, anchor, path[j])) {
        furthest = j;
        break;
      }
    }
    out.push(path[furthest]);
    anchor = path[furthest];
    if (furthest === path.length - 1) break;
    i = furthest + 1;
  }
  return out;
}

/** Spiral outward for a walkable tile — used when an order lands on a wall. */
export function nearestWalkable(
  world: World,
  tx: number,
  ty: number,
  maxRadius: number,
): { tx: number; ty: number } | null {
  if (world.walkable(tx, ty)) return { tx, ty };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (world.walkable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return null;
}
