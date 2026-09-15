import type { Vec2 } from '../sim/math.ts';
import { rect } from '../sim/world/builder.ts';
import type { StructureOp, TerrainOp } from '../sim/world/level-data.ts';
import type { AnyOp } from './document.ts';

/**
 * Every operation, reduced to points you can grab and lines you can see.
 *
 * The alternative is a tool per operation type — a road tool, a wall tool, a
 * building tool, each with its own idea of what dragging means — and twelve
 * near-identical implementations of "move the thing under the cursor". Boiling
 * each op down to a list of handles and an outline means one drag
 * implementation serves all of them, and a new operation becomes editable by
 * saying where its points are.
 */

export interface Handle {
  /** Which point of the operation this is, in the order `moveHandle` expects. */
  index: number;
  pos: Vec2;
  kind: 'point' | 'centre' | 'corner' | 'radius' | 'opening';
}

/** Points the author can drag, in the operation's own order. */
export function handlesOf(op: AnyOp): Handle[] {
  const path = (points: Vec2[]): Handle[] =>
    points.map((p, index) => ({ index, pos: p, kind: 'point' as const }));

  switch (op.op) {
    case 'bank':
    case 'cut':
    case 'road':
    case 'revetment':
    case 'hedgerow':
      return path(op.path);
    case 'wall':
      return [
        { index: 0, pos: op.a, kind: 'point' },
        { index: 1, pos: op.b, kind: 'point' },
        ...(op.openings ?? []).map((o, i) => ({
          index: 2 + i,
          pos: alongWall(op.a, op.b, o.at),
          kind: 'opening' as const,
        })),
      ];
    case 'mound':
    case 'crater':
    case 'obstacle':
      return [
        { index: 0, pos: op.at, kind: 'centre' },
        { index: 1, pos: { x: op.at.x + op.radius, y: op.at.y }, kind: 'radius' },
      ];
    case 'paint':
      return [
        { index: 0, pos: op.min, kind: 'corner' },
        { index: 1, pos: op.max, kind: 'corner' },
      ];
    case 'building': {
      const footprint = footprintOf(op);
      // Corners first, then the openings, because `moveHandle` addresses them
      // by position in this list and a building's corner count is what tells
      // the two apart.
      return [
        ...footprint.map((p, index) => ({ index, pos: p, kind: 'corner' as const })),
        ...(op.openings ?? []).map((o, i) => ({
          index: footprint.length + i,
          pos: openingPos(footprint, o.side ?? 0, o.at),
          kind: 'opening' as const,
        })),
      ];
    }
    default:
      return [];
  }
}

/** Closed or open runs to draw when the operation is selected or hovered. */
export function outlineOf(op: AnyOp): { points: Vec2[]; closed: boolean }[] {
  switch (op.op) {
    case 'bank':
    case 'cut':
    case 'road':
    case 'revetment':
    case 'hedgerow':
      return [{ points: op.path, closed: false }];
    case 'wall':
      return [{ points: [op.a, op.b], closed: false }];
    case 'building':
      return [{ points: footprintOf(op), closed: true }];
    case 'paint':
      return [{
        points: [
          op.min, { x: op.max.x, y: op.min.y }, op.max, { x: op.min.x, y: op.max.y },
        ],
        closed: true,
      }];
    case 'mound':
    case 'crater':
    case 'obstacle':
      return [{ points: ring(op.at, op.radius), closed: true }];
    default:
      return [];
  }
}

/** A building's corners, whether it was written as a polygon or as a rectangle. */
export function footprintOf(op: StructureOp & { op: 'building' }): Vec2[] {
  if (op.footprint) return op.footprint;
  if (op.rect) return rect(op.rect.at, op.rect.width, op.rect.depth, op.rect.angle ?? 0);
  return [];
}

/**
 * Dragging a rectangle's corner turns it into a polygon.
 *
 * A rectangle is sugar for the common case, not a constraint the author agreed
 * to. The moment he pulls one corner out of square, keeping the rect and
 * ignoring him would be the wrong answer, so the sugar is spent and the real
 * shape takes over.
 */
function unsweeten(op: StructureOp & { op: 'building' }): Vec2[] {
  if (!op.footprint) {
    op.footprint = footprintOf(op).map((p) => ({ ...p }));
    delete op.rect;
  }
  return op.footprint;
}

/**
 * Where an opening sits in the world.
 *
 * The file says "two metres along the north wall", which is how anybody would
 * describe it and useless for drawing a handle. This is the one place that
 * turns the description back into a point, so the viewport, the picker and the
 * drag all agree about where a door is.
 */
export function alongWall(a: Vec2, b: Vec2, at: number | 'centre'): Vec2 {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const d = at === 'centre' ? length / 2 : at;
  const t = length > 1e-6 ? Math.max(0, Math.min(1, d / length)) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function openingPos(footprint: Vec2[], side: number, at: number | 'centre'): Vec2 {
  if (footprint.length === 0) return { x: 0, y: 0 };
  const i = ((side % footprint.length) + footprint.length) % footprint.length;
  return alongWall(footprint[i], footprint[(i + 1) % footprint.length], at);
}

/** How far along a wall a point falls, and how far off it is. */
export function projectOntoWall(
  a: Vec2, b: Vec2, p: Vec2,
): { at: number; away: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    : 0;
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { at: t * Math.sqrt(len2), away: Math.hypot(p.x - x, p.y - y) };
}

/**
 * Which wall of a footprint a point is nearest, and where along it.
 *
 * This is what makes "put a window here" a click rather than an arithmetic
 * problem the author does in his head about which wall `w2` was.
 */
export function nearestSide(
  footprint: Vec2[], p: Vec2,
): { side: number; at: number; away: number } {
  let best = { side: 0, at: 0, away: Infinity };
  for (let side = 0; side < footprint.length; side++) {
    const hit = projectOntoWall(footprint[side], footprint[(side + 1) % footprint.length], p);
    if (hit.away < best.away) best = { side, at: hit.at, away: hit.away };
  }
  return best;
}

/** Move one of an operation's points to somewhere new. */
export function moveHandle(op: AnyOp, index: number, to: Vec2): void {
  switch (op.op) {
    case 'bank':
    case 'cut':
    case 'road':
    case 'revetment':
    case 'hedgerow':
      if (op.path[index]) op.path[index] = { ...to };
      break;
    case 'wall': {
      if (index === 0) { op.a = { ...to }; break; }
      if (index === 1) { op.b = { ...to }; break; }
      const opening = (op.openings ?? [])[index - 2];
      if (!opening) break;
      opening.at = clampAlong(op.a, op.b, projectOntoWall(op.a, op.b, to).at, opening.width);
      break;
    }
    case 'mound':
    case 'crater':
    case 'obstacle':
      if (index === 0) op.at = { ...to };
      else op.radius = Math.max(0.5, Math.hypot(to.x - op.at.x, to.y - op.at.y));
      break;
    case 'paint':
      if (index === 0) op.min = { ...to };
      else op.max = { ...to };
      break;
    case 'building': {
      const footprint = unsweeten(op);
      if (index < footprint.length) {
        footprint[index] = { ...to };
        break;
      }
      // Past the corners: an opening. Dragged round a corner it changes which
      // wall it belongs to, which is what makes moving a door to the other face
      // a drag rather than an edit to a number and a dropdown.
      const opening = (op.openings ?? [])[index - footprint.length];
      if (!opening) break;
      const hit = nearestSide(footprint, to);
      opening.side = hit.side;
      opening.at = clampAlong(footprint[hit.side],
        footprint[(hit.side + 1) % footprint.length], hit.at, opening.width);
      break;
    }
    default:
      break;
  }
}

/**
 * Keep an opening inside the wall it is cut into.
 *
 * Half its own width clear of each end, because an opening that runs off the
 * corner is not an opening: `wall()` widens every gap by STAMP_FLOOR before
 * cutting it, so one placed at the very end quietly takes the corner with it
 * and the building stops being closed.
 */
function clampAlong(a: Vec2, b: Vec2, at: number, width: number): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const margin = Math.min(width / 2 + 0.6, length / 2);
  const held = Math.max(margin, Math.min(length - margin, at));
  // To the centimetre. A door is not placed to within a thousandth of a
  // millimetre, and a level file full of 11.737070086477031 is a level file
  // nobody can read a diff of.
  return Math.round(held * 100) / 100;
}

/** Shift a whole operation. */
export function translate(op: AnyOp, dx: number, dy: number): void {
  const shift = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy });
  switch (op.op) {
    case 'bank':
    case 'cut':
    case 'road':
    case 'revetment':
    case 'hedgerow':
      op.path = op.path.map(shift);
      break;
    case 'wall':
      op.a = shift(op.a);
      op.b = shift(op.b);
      break;
    case 'mound':
    case 'crater':
    case 'obstacle':
      op.at = shift(op.at);
      break;
    case 'paint':
      op.min = shift(op.min);
      op.max = shift(op.max);
      break;
    case 'building':
      if (op.rect) op.rect.at = shift(op.rect.at);
      else if (op.footprint) op.footprint = op.footprint.map(shift);
      break;
    default:
      break;
  }
}

/** Turn a whole operation about a point. */
export function rotate(op: AnyOp, about: Vec2, radians: number): void {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const spin = (p: Vec2): Vec2 => {
    const dx = p.x - about.x;
    const dy = p.y - about.y;
    return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
  };
  switch (op.op) {
    case 'bank':
    case 'cut':
    case 'road':
    case 'revetment':
    case 'hedgerow':
      op.path = op.path.map(spin);
      break;
    case 'wall':
      op.a = spin(op.a);
      op.b = spin(op.b);
      break;
    case 'mound':
    case 'crater':
    case 'obstacle':
      op.at = spin(op.at);
      break;
    case 'building':
      if (op.rect) {
        op.rect.at = spin(op.rect.at);
        op.rect.angle = (op.rect.angle ?? 0) + radians;
      } else if (op.footprint) {
        op.footprint = op.footprint.map(spin);
      }
      break;
    default:
      // A painted rectangle is axis-aligned by definition; turning it would
      // have to become a polygon, and a surface patch is not worth that.
      break;
  }
}

/** Where an operation is, for framing the camera on it and for rotating it. */
export function centreOf(op: AnyOp): Vec2 {
  const points = handlesOf(op).filter((h) => h.kind !== 'radius').map((h) => h.pos);
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((a, p) => a + p.x, 0) / points.length,
    y: points.reduce((a, p) => a + p.y, 0) / points.length,
  };
}

/** Axis-aligned bounds, for hit-testing and for framing. */
export function boundsOf(op: AnyOp): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const run of outlineOf(op)) {
    for (const p of run.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * How far a point is from an operation, in metres, for picking.
 *
 * Anywhere inside a closed shape counts as on it. Measuring only to the edges
 * means clicking the middle of a building selects nothing, which is the first
 * thing anybody tries and the last thing they expect to fail.
 */
export function distanceTo(op: AnyOp, at: Vec2): number {
  let best = Infinity;
  for (const run of outlineOf(op)) {
    const points = run.points;
    if (run.closed && contains(points, at)) return 0;
    const last = run.closed ? points.length : points.length - 1;
    for (let i = 0; i < last; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      best = Math.min(best, pointToSegment(at, a, b));
    }
    if (points.length === 1) best = Math.min(best, Math.hypot(at.x - points[0].x, at.y - points[0].y));
  }
  return best;
}

/** Even-odd crossing test: is this point inside that ring? */
function contains(polygon: Vec2[], at: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > at.y) !== (b.y > at.y)
      && at.x < ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

function ring(centre: Vec2, radius: number, steps = 28): Vec2[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return { x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius };
  });
}

/** A readable name for the outline panel, whether or not the author gave one. */
export function labelOf(op: AnyOp): string {
  if (op.name) return op.name;
  switch (op.op) {
    case 'building':
      return 'building';
    case 'wall':
      return 'wall';
    case 'revetment':
      return 'low wall';
    case 'hedgerow':
      return 'hedge';
    case 'obstacle':
      return 'obstacle';
    case 'road':
      return 'road';
    case 'cut':
      return 'ditch';
    case 'bank':
      return 'bank';
    case 'mound':
      return 'mound';
    case 'crater':
      return 'crater';
    case 'paint':
      return 'ground';
    case 'rolling':
      return 'rolling ground';
    case 'heightmap':
      return 'heightmap';
    default:
      return (op as TerrainOp).op;
  }
}
