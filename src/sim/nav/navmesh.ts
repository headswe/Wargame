import earcut from 'earcut';
import type { Vec2 } from '../math.ts';
import type { Polygon } from './contour.ts';

/** Min-heap over triangle indices, keyed by f-score. */
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

const EPSILON = 1e-9;

/**
 * A navigation mesh: convex cells with shared-edge adjacency.
 *
 * Paths come out as free polylines rather than a run of cell centres, because
 * the corridor of triangles is pulled taut with the funnel algorithm. That is
 * the whole reason for a navmesh over a grid — an operator crossing a field
 * should walk the line they would actually walk, not the one the data
 * structure happens to be made of.
 */
export class NavMesh {
  readonly vertices: Float64Array;
  readonly triangles: Int32Array;
  /** Neighbour triangle across edge e of triangle t, or -1. */
  readonly neighbours: Int32Array;
  readonly triangleCount: number;

  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly buckets: number[][];

  constructor(vertices: number[], triangles: number[], width: number, height: number) {
    this.vertices = Float64Array.from(vertices);
    this.triangles = Int32Array.from(triangles);
    this.triangleCount = triangles.length / 3;
    this.neighbours = new Int32Array(triangles.length).fill(-1);
    this.buildAdjacency();

    this.cellSize = 8;
    this.cols = Math.ceil(width / this.cellSize) + 1;
    this.rows = Math.ceil(height / this.cellSize) + 1;
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    this.buildLookup();
  }

  vertexX(v: number): number {
    return this.vertices[v * 2];
  }

  vertexY(v: number): number {
    return this.vertices[v * 2 + 1];
  }

  /** Two triangles are neighbours when they share an edge, keyed by vertex pair. */
  private buildAdjacency(): void {
    const seen = new Map<number, { tri: number; edge: number }>();
    for (let t = 0; t < this.triangleCount; t++) {
      for (let e = 0; e < 3; e++) {
        const a = this.triangles[t * 3 + e];
        const b = this.triangles[t * 3 + ((e + 1) % 3)];
        const key = a < b ? a * 1e7 + b : b * 1e7 + a;
        const match = seen.get(key);
        if (match) {
          this.neighbours[t * 3 + e] = match.tri;
          this.neighbours[match.tri * 3 + match.edge] = t;
          seen.delete(key);
        } else {
          seen.set(key, { tri: t, edge: e });
        }
      }
    }
  }

  private buildLookup(): void {
    for (let t = 0; t < this.triangleCount; t++) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let e = 0; e < 3; e++) {
        const v = this.triangles[t * 3 + e];
        const x = this.vertexX(v);
        const y = this.vertexY(v);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const i0 = this.clampCol(Math.floor(minX / this.cellSize));
      const i1 = this.clampCol(Math.floor(maxX / this.cellSize));
      const j0 = this.clampRow(Math.floor(minY / this.cellSize));
      const j1 = this.clampRow(Math.floor(maxY / this.cellSize));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) this.buckets[j * this.cols + i].push(t);
      }
    }
  }

  private clampCol(i: number): number {
    return i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
  }

  private clampRow(j: number): number {
    return j < 0 ? 0 : j >= this.rows ? this.rows - 1 : j;
  }

  centroid(t: number): Vec2 {
    let x = 0;
    let y = 0;
    for (let e = 0; e < 3; e++) {
      const v = this.triangles[t * 3 + e];
      x += this.vertexX(v);
      y += this.vertexY(v);
    }
    return { x: x / 3, y: y / 3 };
  }

  /** Which cell contains this point, or -1 if it is off the mesh. */
  findTriangle(x: number, y: number): number {
    const i = this.clampCol(Math.floor(x / this.cellSize));
    const j = this.clampRow(Math.floor(y / this.cellSize));
    for (const t of this.buckets[j * this.cols + i]) {
      if (this.contains(t, x, y)) return t;
    }
    return -1;
  }

  /** Nearest cell to a point that may be just off the mesh — a wall, say. */
  nearestTriangle(x: number, y: number, searchRadius = 6): number {
    const direct = this.findTriangle(x, y);
    if (direct >= 0) return direct;

    let best = -1;
    let bestDistance = searchRadius * searchRadius;
    const i0 = this.clampCol(Math.floor((x - searchRadius) / this.cellSize));
    const i1 = this.clampCol(Math.floor((x + searchRadius) / this.cellSize));
    const j0 = this.clampRow(Math.floor((y - searchRadius) / this.cellSize));
    const j1 = this.clampRow(Math.floor((y + searchRadius) / this.cellSize));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const t of this.buckets[j * this.cols + i]) {
          const c = this.centroid(t);
          const d = (c.x - x) ** 2 + (c.y - y) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            best = t;
          }
        }
      }
    }
    return best;
  }

  contains(t: number, x: number, y: number): boolean {
    const a = this.triangles[t * 3];
    const b = this.triangles[t * 3 + 1];
    const c = this.triangles[t * 3 + 2];
    const d1 = cross(this.vertexX(a), this.vertexY(a), this.vertexX(b), this.vertexY(b), x, y);
    const d2 = cross(this.vertexX(b), this.vertexY(b), this.vertexX(c), this.vertexY(c), x, y);
    const d3 = cross(this.vertexX(c), this.vertexY(c), this.vertexX(a), this.vertexY(a), x, y);
    const hasNegative = d1 < -EPSILON || d2 < -EPSILON || d3 < -EPSILON;
    const hasPositive = d1 > EPSILON || d2 > EPSILON || d3 > EPSILON;
    return !(hasNegative && hasPositive);
  }

  /**
   * A* across cells, then pulled taut. Returns world waypoints, or null when
   * the two points are not connected.
   */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const startTri = this.nearestTriangle(from.x, from.y);
    const goalTri = this.nearestTriangle(to.x, to.y);
    if (startTri < 0 || goalTri < 0) return null;
    if (startTri === goalTri) return [{ ...to }];

    const count = this.triangleCount;
    const gScore = new Float64Array(count).fill(Infinity);
    const cameFrom = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    const open = new Heap();

    const goal = this.centroid(goalTri);
    gScore[startTri] = 0;
    open.push(startTri, Math.hypot(goal.x - from.x, goal.y - from.y));

    let found = false;
    while (open.size > 0) {
      const current = open.pop();
      if (closed[current]) continue;
      closed[current] = 1;
      if (current === goalTri) {
        found = true;
        break;
      }

      const here = this.centroid(current);
      for (let e = 0; e < 3; e++) {
        const next = this.neighbours[current * 3 + e];
        if (next < 0 || closed[next]) continue;
        const there = this.centroid(next);
        const tentative = gScore[current] + Math.hypot(there.x - here.x, there.y - here.y);
        if (tentative >= gScore[next]) continue;
        gScore[next] = tentative;
        cameFrom[next] = current;
        open.push(next, tentative + Math.hypot(goal.x - there.x, goal.y - there.y));
      }
    }

    if (!found) return null;

    const corridor: number[] = [];
    for (let t = goalTri; t !== -1; t = cameFrom[t]) {
      corridor.push(t);
      if (t === startTri) break;
    }
    corridor.reverse();

    return this.funnel(corridor, from, to);
  }

  /**
   * The Simple Stupid Funnel Algorithm. Walks the corridor's shared edges,
   * narrowing a left/right wedge from the current apex, and plants a waypoint
   * only where the wedge actually closes — which is exactly at the corners the
   * path has to go round.
   */
  private funnel(corridor: number[], from: Vec2, to: Vec2): Vec2[] {
    const portals: { left: Vec2; right: Vec2 }[] = [{ left: from, right: from }];

    for (let i = 0; i + 1 < corridor.length; i++) {
      const t = corridor[i];
      const next = corridor[i + 1];
      let edge = -1;
      for (let e = 0; e < 3; e++) {
        if (this.neighbours[t * 3 + e] === next) {
          edge = e;
          break;
        }
      }
      if (edge < 0) continue;
      const a = this.triangles[t * 3 + edge];
      const b = this.triangles[t * 3 + ((edge + 1) % 3)];
      portals.push({
        left: { x: this.vertexX(a), y: this.vertexY(a) },
        right: { x: this.vertexX(b), y: this.vertexY(b) },
      });
    }
    portals.push({ left: to, right: to });

    const path: Vec2[] = [];
    let apex = from;
    let left = from;
    let right = from;
    let apexIndex = 0;
    let leftIndex = 0;
    let rightIndex = 0;

    for (let i = 1; i < portals.length; i++) {
      const pLeft = portals[i].left;
      const pRight = portals[i].right;

      if (area2(apex, right, pRight) <= 0) {
        if (same(apex, right) || area2(apex, left, pRight) > 0) {
          right = pRight;
          rightIndex = i;
        } else {
          // The right side crossed over the left: the corner at `left` is a
          // real one, so plant it and restart the funnel from there.
          path.push({ ...left });
          apex = left;
          apexIndex = leftIndex;
          right = apex;
          left = apex;
          rightIndex = apexIndex;
          leftIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }

      if (area2(apex, left, pLeft) >= 0) {
        if (same(apex, left) || area2(apex, right, pLeft) < 0) {
          left = pLeft;
          leftIndex = i;
        } else {
          path.push({ ...right });
          apex = right;
          apexIndex = rightIndex;
          left = apex;
          right = apex;
          leftIndex = apexIndex;
          rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
    }

    path.push({ ...to });
    return path;
  }
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (px - ax) * (by - ay);
}

function area2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

function same(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

/**
 * Triangulate walkable polygons into a mesh. Windings are normalised on the
 * way in so the funnel's left and right mean the same thing everywhere; a
 * single flipped triangle produces paths that cut corners through walls.
 */
export function buildNavMesh(polygons: Polygon[], width: number, height: number): NavMesh {
  const vertices: number[] = [];
  const triangles: number[] = [];

  for (const polygon of polygons) {
    const flat: number[] = [];
    const holeIndices: number[] = [];

    for (const p of polygon.outer) flat.push(p.x, p.y);
    for (const hole of polygon.holes) {
      holeIndices.push(flat.length / 2);
      for (const p of hole) flat.push(p.x, p.y);
    }

    const indices = earcut(flat, holeIndices);
    if (indices.length === 0) continue;

    const base = vertices.length / 2;
    for (const value of flat) vertices.push(value);

    for (let i = 0; i < indices.length; i += 3) {
      const a = base + indices[i];
      const b = base + indices[i + 1];
      const c = base + indices[i + 2];
      const signed =
        (vertices[b * 2] - vertices[a * 2]) * (vertices[c * 2 + 1] - vertices[a * 2 + 1]) -
        (vertices[c * 2] - vertices[a * 2]) * (vertices[b * 2 + 1] - vertices[a * 2 + 1]);
      if (signed < 0) triangles.push(a, c, b);
      else triangles.push(a, b, c);
    }
  }

  return new NavMesh(vertices, triangles, width, height);
}
