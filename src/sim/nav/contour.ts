import type { Vec2 } from '../math.ts';

export interface Loop {
  /** World-space points, closed implicitly (last does not repeat the first). */
  points: Vec2[];
  /** Positive for an outer boundary, negative for a hole. */
  signedArea: number;
}

export interface Polygon {
  outer: Vec2[];
  holes: Vec2[][];
}

/**
 * Turn a walkability bitmap back into polygons.
 *
 * Walking cell boundaries rather than marching squares keeps this exact: the
 * region really is a union of unit squares, so its outline really is a
 * staircase of cell edges, and there is nothing to interpolate or disambiguate.
 * Winding falls out of it too — trace with walkable ground always on the same
 * side and outer rings come out positive, holes negative.
 */
export function traceContours(
  walkable: Uint8Array,
  cols: number,
  rows: number,
  cellSize: number,
): Loop[] {
  const grid = removeDiagonalPinches(walkable, cols, rows);

  // Directed boundary edges, kept in flat arrays with a per-corner linked list.
  // This runs over every cell on the map on every rebuild, so it is written for
  // the machine rather than for the reader: no closures, no per-edge objects,
  // and direct indexing instead of a bounds-checked accessor.
  const strideCorners = cols + 1;
  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  const head = new Map<number, number>();
  const nextEdge: number[] = [];

  const addEdge = (ax: number, ay: number, bx: number, by: number): void => {
    const from = ay * strideCorners + ax;
    const id = edgeFrom.length;
    edgeFrom.push(from);
    edgeTo.push(by * strideCorners + bx);
    nextEdge.push(head.get(from) ?? -1);
    head.set(from, id);
  };

  for (let j = 0; j < rows; j++) {
    const row = j * cols;
    const above = row - cols;
    const below = row + cols;
    for (let i = 0; i < cols; i++) {
      if (grid[row + i] !== 1) continue;
      if (i === 0 || grid[row + i - 1] !== 1) addEdge(i, j + 1, i, j);
      if (j === 0 || grid[above + i] !== 1) addEdge(i, j, i + 1, j);
      if (i === cols - 1 || grid[row + i + 1] !== 1) addEdge(i + 1, j, i + 1, j + 1);
      if (j === rows - 1 || grid[below + i] !== 1) addEdge(i + 1, j + 1, i, j + 1);
    }
  }

  const count = edgeFrom.length;
  const used = new Uint8Array(count);
  const loops: Loop[] = [];

  for (let start = 0; start < count; start++) {
    if (used[start] === 1) continue;

    const points: Vec2[] = [];
    let current = start;
    let guard = 0;

    while (guard++ <= count) {
      used[current] = 1;
      const from = edgeFrom[current];
      points.push({
        x: (from % strideCorners) * cellSize,
        y: Math.floor(from / strideCorners) * cellSize,
      });

      let next = -1;
      for (let e = head.get(edgeTo[current]) ?? -1; e !== -1; e = nextEdge[e]) {
        if (used[e] === 0) {
          next = e;
          break;
        }
      }
      if (next === -1) break;
      current = next;
    }

    if (points.length >= 4) loops.push({ points, signedArea: shoelace(points) });
  }

  return loops;
}

/**
 * Two walkable cells meeting only at a corner make a point where the boundary
 * can be linked two ways, and one of those ways is a self-intersecting loop
 * that triangulates into nonsense. Opening the pinch costs one cell and makes
 * the tracing unambiguous.
 */
function removeDiagonalPinches(walkable: Uint8Array, cols: number, rows: number): Uint8Array {
  const grid = walkable.slice();
  for (let j = 0; j + 1 < rows; j++) {
    const row = j * cols;
    const below = row + cols;
    for (let i = 0; i + 1 < cols; i++) {
      const a = grid[row + i];
      const b = grid[row + i + 1];
      const c = grid[below + i];
      const d = grid[below + i + 1];
      if (a === 1) {
        if (d === 1 && b === 0 && c === 0) grid[below + i + 1] = 0;
      } else if (b === 1 && c === 1 && d === 0) {
        grid[below + i] = 0;
      }
    }
  }
  return grid;
}

function shoelace(points: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Douglas-Peucker over a closed ring. Splitting at the vertex furthest from
 * the first one gives the recursion two well-separated anchors; run naively
 * from a single point and a ring can collapse to nothing.
 */
export function simplifyLoop(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 4) return points;

  let furthest = 0;
  let furthestDistance = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > furthestDistance) {
      furthestDistance = d;
      furthest = i;
    }
  }

  const first = simplifyRun(points.slice(0, furthest + 1), tolerance);
  const second = simplifyRun([...points.slice(furthest), points[0]], tolerance);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  return merged.length >= 3 ? merged : points;
}

function simplifyRun(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return points;
  let index = 0;
  let maxDistance = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }

  if (maxDistance <= tolerance) return [first, last];
  const left = simplifyRun(points.slice(0, index + 1), tolerance);
  const right = simplifyRun(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(lenSq);
}

/** Sort loops into outer rings with their holes, ready for triangulation. */
export function groupIntoPolygons(loops: Loop[], minArea = 0.5): Polygon[] {
  const outers = loops.filter((l) => l.signedArea > minArea);
  const holes = loops.filter((l) => l.signedArea < -minArea);

  const polygons: Polygon[] = outers
    .sort((a, b) => b.signedArea - a.signedArea)
    .map((l) => ({ outer: l.points, holes: [] as Vec2[][] }));

  for (const hole of holes) {
    // Smallest containing ring wins, so a hole inside a courtyard inside a
    // compound attaches to the courtyard rather than the compound.
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < polygons.length; i++) {
      const area = Math.abs(shoelace(polygons[i].outer));
      if (area < bestArea && pointInPolygon(hole.points[0], polygons[i].outer)) {
        best = i;
        bestArea = area;
      }
    }
    if (best >= 0) polygons[best].holes.push(hole.points);
  }

  return polygons;
}

export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
