import { type Vec2, clamp, distPointToSegment } from '../math.ts';

/** Surface materials. Cosmetic, plus a small effect on movement. */
export const Surface = {
  Dirt: 0,
  Grass: 1,
  Crop: 2,
  Road: 3,
  Gravel: 4,
  Concrete: 5,
  Mud: 6,
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The ground, as a heightfield.
 *
 * Elevation is not decoration — it is what lets terrain do tactical work. A
 * fold you can cross unseen, a crest a defender sits behind, a ditch you are
 * genuinely *below* rather than beside: none of those can be expressed by a
 * flat plane with things standing on it, however many things you stand on it.
 *
 * Roads and ditches are operations on this surface rather than objects placed
 * on top of it, which is the only way to get ground that goes down.
 */
/** Subdivide a polyline so no segment is longer than `step`. */
function densify(path: Vec2[], step: number): Vec2[] {
  if (path.length < 2) return path;
  const out: Vec2[] = [path[0]];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= pieces; k++) {
      out.push({ x: a.x + (b.x - a.x) * (k / pieces), y: a.y + (b.y - a.y) * (k / pieces) });
    }
  }
  return out;
}

export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly spacing: number;
  readonly cols: number;
  readonly rows: number;
  readonly heights: Float32Array;
  readonly surface: Uint8Array;

  private dirtyBounds: Bounds | null = null;

  constructor(width: number, height: number, spacing = 0.5) {
    this.width = width;
    this.height = height;
    this.spacing = spacing;
    this.cols = Math.floor(width / spacing) + 1;
    this.rows = Math.floor(height / spacing) + 1;
    this.heights = new Float32Array(this.cols * this.rows);
    this.surface = new Uint8Array(this.cols * this.rows).fill(Surface.Dirt);
  }

  private index(i: number, j: number): number {
    return j * this.cols + i;
  }

  private clampCol(i: number): number {
    return i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
  }

  private clampRow(j: number): number {
    return j < 0 ? 0 : j >= this.rows ? this.rows - 1 : j;
  }

  /** Height at any world position, bilinearly interpolated between samples. */
  heightAt(x: number, y: number): number {
    const gx = x / this.spacing;
    const gy = y / this.spacing;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;

    const i0 = this.clampCol(i);
    const i1 = this.clampCol(i + 1);
    const j0 = this.clampRow(j);
    const j1 = this.clampRow(j + 1);

    const h00 = this.heights[this.index(i0, j0)];
    const h10 = this.heights[this.index(i1, j0)];
    const h01 = this.heights[this.index(i0, j1)];
    const h11 = this.heights[this.index(i1, j1)];

    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fy;
  }

  surfaceAt(x: number, y: number): Surface {
    const i = this.clampCol(Math.round(x / this.spacing));
    const j = this.clampRow(Math.round(y / this.spacing));
    return this.surface[this.index(i, j)] as Surface;
  }

  /** Rise over run, by central difference. Drives walkability and move cost. */
  slopeAt(x: number, y: number): number {
    const d = this.spacing;
    const dzdx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dzdy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    return Math.hypot(dzdx, dzdy);
  }

  /** Upward surface normal, for lighting and for leaning into slopes. */
  normalAt(x: number, y: number): { x: number; y: number; z: number } {
    const d = this.spacing;
    const dzdx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dzdy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    const len = Math.hypot(dzdx, dzdy, 1);
    return { x: -dzdx / len, y: -dzdy / len, z: 1 / len };
  }

  // ---------------------------------------------------------------- shaping

  /** Gentle rolling ground, so nothing starts out billiard-table flat. */
  rolling(amplitude: number, wavelength: number, seed = 1): this {
    const a = seed * 0.618;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const x = i * this.spacing;
        const y = j * this.spacing;
        this.heights[this.index(i, j)] +=
          Math.sin(x / wavelength + a) * Math.cos(y / (wavelength * 1.3) + a * 2) * amplitude +
          Math.sin((x + y) / (wavelength * 2.1) + a * 3) * amplitude * 0.5;
      }
    }
    this.dirtyBounds = { minX: 0, minY: 0, maxX: this.width, maxY: this.height };
    return this;
  }

  /** A broad rise or hollow — a knoll, a shallow bowl. */
  mound(centre: Vec2, radius: number, peak: number): this {
    this.forEachNear([centre], radius, (i, j, x, y) => {
      const d = Math.hypot(x - centre.x, y - centre.y);
      if (d > radius) return;
      // Cosine falloff, so there is no crease at the edge.
      this.heights[this.index(i, j)] += peak * (0.5 + 0.5 * Math.cos((d / radius) * Math.PI));
    });
    return this;
  }

  /**
   * Cut a channel. Flat-bottomed with sloped sides, which is what makes a ditch
   * usable: you can stand in it below the line of fire rather than scrambling
   * about on a V.
   */
  cut(path: Vec2[], width: number, depth: number, surface?: Surface): this {
    const half = width / 2;
    const floor = half * 0.45;
    this.forEachNear(path, half + 1, (i, j, x, y) => {
      const d = this.distanceToPath(path, x, y);
      if (d > half) return;
      const t = d <= floor ? 1 : 0.5 + 0.5 * Math.cos(((d - floor) / (half - floor)) * Math.PI);
      const index = this.index(i, j);
      this.heights[index] -= depth * t;
      if (surface !== undefined && t > 0.4) this.surface[index] = surface;
    });
    return this;
  }

  /** Raise a bank — a berm, a railway embankment, a spoil heap. */
  bank(path: Vec2[], width: number, rise: number, surface?: Surface): this {
    const half = width / 2;
    this.forEachNear(path, half + 1, (i, j, x, y) => {
      const d = this.distanceToPath(path, x, y);
      if (d > half) return;
      const index = this.index(i, j);
      this.heights[index] += rise * (0.5 + 0.5 * Math.cos((d / half) * Math.PI));
      if (surface !== undefined && d < half * 0.6) this.surface[index] = surface;
    });
    return this;
  }

  /**
   * Lay a road: flat across its width, but still following the lie of the land
   * along its length. Sampling the centreline first is what stops it
   * bulldozing the hill it runs over.
   */
  road(path: Vec2[], width: number, surface: Surface = Surface.Road): this {
    const half = width / 2;
    // Sample the centreline at road resolution, not at the author's vertices.
    // Interpolating between two far-apart vertices is how a road ends up
    // bulldozing straight through the hill it was supposed to ride over.
    const centre = densify(path, Math.max(1, half));
    const centreHeights = centre.map((p) => this.heightAt(p.x, p.y));

    this.forEachNear(centre, half + 2, (i, j, x, y) => {
      const { distance, t, segment } = this.projectToPath(centre, x, y);
      if (distance > half + 1.5) return;
      const target =
        centreHeights[segment] + (centreHeights[segment + 1] - centreHeights[segment]) * t;
      const k = clamp(distance <= half ? 1 : 1 - (distance - half) / 1.5, 0, 1);
      const index = this.index(i, j);
      this.heights[index] = this.heights[index] * (1 - k) + target * k;
      if (distance <= half) this.surface[index] = surface;
    });
    return this;
  }

  /** Paint surface without touching height. */
  paint(min: Vec2, max: Vec2, surface: Surface): this {
    const j0 = this.clampRow(Math.floor(min.y / this.spacing));
    const j1 = this.clampRow(Math.ceil(max.y / this.spacing));
    const i0 = this.clampCol(Math.floor(min.x / this.spacing));
    const i1 = this.clampCol(Math.ceil(max.x / this.spacing));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) this.surface[this.index(i, j)] = surface;
    }
    return this;
  }

  /**
   * Blow a hole in the ground. The lip matters as much as the hollow — it is
   * what turns a shell hole into a fighting position.
   */
  crater(centre: Vec2, radius: number, depth: number): void {
    this.forEachNear([centre], radius * 1.35, (i, j, x, y) => {
      const d = Math.hypot(x - centre.x, y - centre.y) / radius;
      if (d > 1.35) return;
      const index = this.index(i, j);
      if (d <= 1) {
        this.heights[index] -= depth * (1 - d * d);
      } else {
        const lip = (1.35 - d) / 0.35;
        this.heights[index] += depth * 0.22 * lip * lip;
      }
      this.surface[index] = Surface.Mud;
    });
  }

  // ------------------------------------------------------------- bookkeeping

  /** The region changed since this was last called, then reset. */
  takeDirty(): Bounds | null {
    const bounds = this.dirtyBounds;
    this.dirtyBounds = null;
    return bounds;
  }

  private mark(minX: number, minY: number, maxX: number, maxY: number): void {
    if (!this.dirtyBounds) {
      this.dirtyBounds = { minX, minY, maxX, maxY };
      return;
    }
    const b = this.dirtyBounds;
    if (minX < b.minX) b.minX = minX;
    if (minY < b.minY) b.minY = minY;
    if (maxX > b.maxX) b.maxX = maxX;
    if (maxY > b.maxY) b.maxY = maxY;
  }

  /** Visit every sample within `pad` of any point on `path`. */
  private forEachNear(
    path: Vec2[],
    pad: number,
    visit: (i: number, j: number, x: number, y: number) => void,
  ): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of path) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const i0 = this.clampCol(Math.floor((minX - pad) / this.spacing));
    const i1 = this.clampCol(Math.ceil((maxX + pad) / this.spacing));
    const j0 = this.clampRow(Math.floor((minY - pad) / this.spacing));
    const j1 = this.clampRow(Math.ceil((maxY + pad) / this.spacing));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) visit(i, j, i * this.spacing, j * this.spacing);
    }
    this.mark(minX - pad, minY - pad, maxX + pad, maxY + pad);
  }

  private distanceToPath(path: Vec2[], x: number, y: number): number {
    if (path.length === 1) return Math.hypot(x - path[0].x, y - path[0].y);
    let best = Infinity;
    for (let s = 0; s + 1 < path.length; s++) {
      const d = distPointToSegment({ x, y }, path[s], path[s + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  /** Nearest point on a polyline, as a segment index plus a fraction along it. */
  private projectToPath(
    path: Vec2[],
    x: number,
    y: number,
  ): { distance: number; segment: number; t: number } {
    let best = { distance: Infinity, segment: 0, t: 0 };
    for (let s = 0; s + 1 < path.length; s++) {
      const a = path[s];
      const b = path[s + 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      const t = clamp(lenSq < 1e-9 ? 0 : ((x - a.x) * abx + (y - a.y) * aby) / lenSq, 0, 1);
      const distance = Math.hypot(x - (a.x + abx * t), y - (a.y + aby * t));
      if (distance < best.distance) best = { distance, segment: s, t };
    }
    return best;
  }
}
