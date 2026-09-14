/** Small 2D math helpers. The sim is top-down: x is east, y is south. */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** Heading in radians, measured from +x, increasing toward +y. */
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (r: number): Vec2 => ({ x: Math.cos(r), y: Math.sin(r) });

/** Shortest signed delta between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Maps v from [inLo, inHi] onto [0,1], clamped. */
export function invLerpClamped(v: number, inLo: number, inHi: number): number {
  if (inHi === inLo) return v >= inHi ? 1 : 0;
  return clamp((v - inLo) / (inHi - inLo), 0, 1);
}

/** Shortest distance from point p to the segment ab. */
export function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/**
 * A smooth path through the given control points, sampled every `step` metres.
 *
 * Roads, ditches and hedgerows are drawn as a handful of points, and a straight
 * polyline through them corners like a railway siding — the kink gets carved
 * into the heightfield as a crease you can see from the far side of the map.
 * Catmull-Rom passes through every point the author placed while curving
 * between them, so what ends up in the ground is the road he meant rather than
 * the vertices he could be bothered to type.
 *
 * The ends are held by duplicating the first and last points, which makes the
 * curve leave and arrive along the direction of its own first and last span
 * instead of flicking outward.
 */
export function spline(points: Vec2[], step = 1): Vec2[] {
  if (points.length < 3) return points.map(clone);

  const at = (i: number): Vec2 => points[i < 0 ? 0 : i >= points.length ? points.length - 1 : i];
  const out: Vec2[] = [clone(points[0])];

  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const pieces = Math.max(1, Math.ceil(dist(p1, p2) / step));
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
          + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
          + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
          + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
          + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}
