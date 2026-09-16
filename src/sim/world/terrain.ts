import { type Vec2, clamp, distPointToSegment, spline } from '../math.ts';

/** What the ground underfoot is made of. */
export const Surface = {
  Dirt: 0,
  Grass: 1,
  Crop: 2,
  Road: 3,
  Gravel: 4,
  Concrete: 5,
  Mud: 6,
  Rubble: 7,
  Sand: 8,
  Water: 9,
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

/**
 * What each one does to a man walking on it.
 *
 * `footing` multiplies his speed, and that is the whole reason a surface is not
 * just a colour. A road is the fastest way across a map and the most exposed;
 * a ploughed field or a flooded ditch is slow enough that choosing it is a
 * decision rather than a texture. `going` is how hard it is to do quietly and
 * feeds nothing yet — it is here so that noise has somewhere to read from when
 * it arrives, rather than every surface needing revisiting then.
 */
export const SURFACE: Record<number, { footing: number; going: number }> = {
  [Surface.Dirt]: { footing: 1.0, going: 1.0 },
  [Surface.Grass]: { footing: 0.98, going: 0.8 },
  [Surface.Crop]: { footing: 0.86, going: 1.3 },
  [Surface.Road]: { footing: 1.12, going: 1.2 },
  [Surface.Gravel]: { footing: 1.02, going: 1.6 },
  [Surface.Concrete]: { footing: 1.1, going: 1.3 },
  [Surface.Mud]: { footing: 0.72, going: 1.1 },
  [Surface.Rubble]: { footing: 0.68, going: 1.8 },
  [Surface.Sand]: { footing: 0.82, going: 0.7 },
  [Surface.Water]: { footing: 0.55, going: 2.0 },
};

/** Common options for the linear ground features: ditches, banks and roads. */
export interface ShapeOptions {
  /** Paint the ground it lands on as well as reshaping it. */
  surface?: Surface;
  /**
   * Treat the points as a curve rather than as corners. On by default, because
   * a ditch or a road that turns a hard corner reads as a modelling mistake
   * from anywhere on the map, and nobody wants to type forty control points to
   * avoid one.
   */
  curve?: boolean;
}

/** The value that means "this cell has no opinion about the ground". */
export const SURFACE_KEEP = 255;

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

  /**
   * The made surfaces laid over the ground, kept so they can be drawn as what
   * they are.
   *
   * A road is carved into the heightfield and painted into the surface grid,
   * and that is the whole truth as far as the simulation is concerned — footing
   * and going come from the surface under a man's feet. It is not the whole
   * truth for a renderer: a road painted into a grid is a smear, because the
   * ground mesh interpolates colour between samples a metre apart and a road
   * has an edge. Keeping the centreline lets it be drawn as a ribbon following
   * the curve it was always described by.
   *
   * These are the densified spline, not the author's control points, so the
   * drawn road and the carved road are the same curve by construction rather
   * than by two pieces of code agreeing about Catmull-Rom.
   */
  readonly ribbons: { centre: Vec2[]; width: number; surface: Surface }[] = [];

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
  cut(path: Vec2[], width: number, depth: number, options: ShapeOptions = {}): this {
    const { surface, curve = true } = options;
    const line = curve ? spline(path, Math.max(1, width / 2)) : path;
    const half = width / 2;
    const floor = half * 0.45;
    this.forEachNear(line, half + 1, (i, j, x, y) => {
      const d = this.distanceToPath(line, x, y);
      if (d > half) return;
      const t = d <= floor ? 1 : 0.5 + 0.5 * Math.cos(((d - floor) / (half - floor)) * Math.PI);
      const index = this.index(i, j);
      this.heights[index] -= depth * t;
      if (surface !== undefined && t > 0.4) this.surface[index] = surface;
    });
    return this;
  }

  /** Raise a bank — a berm, a railway embankment, a spoil heap. */
  bank(path: Vec2[], width: number, rise: number, options: ShapeOptions = {}): this {
    const { surface, curve = true } = options;
    const line = curve ? spline(path, Math.max(1, width / 2)) : path;
    const half = width / 2;
    this.forEachNear(line, half + 1, (i, j, x, y) => {
      const d = this.distanceToPath(line, x, y);
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
  road(path: Vec2[], width: number, options: ShapeOptions = {}): this {
    const { surface = Surface.Road, curve = true } = options;
    path = curve ? spline(path, Math.max(1, width / 2)) : path;
    const half = width / 2;
    // Sample the centreline at road resolution, not at the author's vertices.
    // Interpolating between two far-apart vertices is how a road ends up
    // bulldozing straight through the hill it was supposed to ride over.
    const centre = densify(path, Math.max(1, half));
    const centreHeights = centre.map((p) => this.heightAt(p.x, p.y));
    this.ribbons.push({ centre: centre.map((p) => ({ ...p })), width, surface });

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

  /**
   * Lay down a whole surface at once from a coarse control grid.
   *
   * The procedural operations below compose a landscape out of verbs — roll
   * this, mound that, cut a ditch through it — which is excellent for ground
   * that has a tactical job to do and hopeless for ground that just has to look
   * like somewhere. A control grid is the other half: an author (or, later, an
   * editor, or an imported real heightfield) hands over the shape he wants and
   * this resamples it onto the simulation's much finer field.
   *
   * Sampling is bilinear with a smoothstep on each axis, which costs nothing
   * and is the difference between rolling ground and a lampshade: straight
   * bilinear leaves a visible crease along every control-grid line, because the
   * surface is continuous but its slope is not.
   */
  heightmap(
    grid: { cols: number; rows: number; heights: ArrayLike<number> },
    options: { scale?: number; base?: number; blend?: 'set' | 'add' } = {},
  ): this {
    const { cols, rows, heights } = grid;
    if (cols < 2 || rows < 2) return this;
    const scale = options.scale ?? 1;
    const base = options.base ?? 0;
    const add = options.blend === 'add';

    const sample = (u: number, v: number): number => {
      const gx = clamp(u * (cols - 1), 0, cols - 1);
      const gy = clamp(v * (rows - 1), 0, rows - 1);
      const i = Math.min(cols - 2, Math.floor(gx));
      const j = Math.min(rows - 2, Math.floor(gy));
      const fx = smoothstep(gx - i);
      const fy = smoothstep(gy - j);
      const h00 = heights[j * cols + i];
      const h10 = heights[j * cols + i + 1];
      const h01 = heights[(j + 1) * cols + i];
      const h11 = heights[(j + 1) * cols + i + 1];
      return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
    };

    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const h = base + scale * sample(i / (this.cols - 1), j / (this.rows - 1));
        const index = this.index(i, j);
        this.heights[index] = add ? this.heights[index] + h : h;
      }
    }
    this.mark(0, 0, this.width, this.height);
    return this;
  }

  /**
   * Lay down painted ground from a coarse grid, leaving anything marked
   * untouched alone.
   *
   * The companion to `heightmap`, and for the same reason: broad rectangles
   * express a ploughed field perfectly and a muddy track round the back of a
   * barn not at all. `SURFACE_KEEP` is the "no opinion" value, which is what
   * makes this composable with the rectangles rather than a replacement for
   * them — a brush stroke is a sparse overlay, not a new ground layer.
   */
  surfacemap(grid: { cols: number; rows: number; cells: ArrayLike<number> }): this {
    const { cols, rows, cells } = grid;
    if (cols < 2 || rows < 2) return this;
    for (let j = 0; j < this.rows; j++) {
      const gy = Math.round((j / (this.rows - 1)) * (rows - 1));
      for (let i = 0; i < this.cols; i++) {
        const gx = Math.round((i / (this.cols - 1)) * (cols - 1));
        const value = cells[gy * cols + gx];
        if (value === SURFACE_KEEP) continue;
        this.surface[this.index(i, j)] = value;
      }
    }
    this.mark(0, 0, this.width, this.height);
    return this;
  }

  /** Paint surface without touching height. */
  /**
   * Level the ground inside a polygon and put a surface on it: a floor.
   *
   * A house standing on rolling ground had the rolling ground running through
   * it. That is wrong in every way it can be: a man walking across a room was
   * charged a slope penalty, two men on opposite sides of one room were at
   * different heights so the sightline between them curved, and the walls stood
   * at visibly different heights where the ground rose under them.
   *
   * The floor is terrain rather than a mesh laid over it. Everything that asks
   * the ground a question — the navmesh, the occlusion field, a man's eye
   * height, how fast he crosses a room — asks the same array, so a floor that
   * were only drawn would be a floor only the player could see.
   *
   * The skirt is what stops it reading as a mesa. Ground within a metre or so
   * outside the wall is eased toward the floor height, which is what a real pad
   * does to the dirt around it, and it keeps the doorway walkable when the
   * ground outside falls away.
   */
  pad(polygon: Vec2[], height: number, options: { surface?: Surface; skirt?: number } = {}): this {
    if (polygon.length < 3) return this;
    const { surface, skirt = 1.4 } = options;
    const inside = (x: number, y: number): boolean => {
      let hit = false;
      for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
        const p = polygon[a];
        const q = polygon[b];
        if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) {
          hit = !hit;
        }
      }
      return hit;
    };

    this.forEachNear(polygon, skirt + 0.5, (i, j, x, y) => {
      const idx = this.index(i, j);
      if (inside(x, y)) {
        this.heights[idx] = height;
        if (surface !== undefined) this.surface[idx] = surface;
        return;
      }
      if (skirt <= 0) return;
      // Outside: blend toward the floor over the skirt, by distance to the
      // nearest edge rather than to a centre, so a long building's skirt is the
      // same width everywhere along it.
      const d = distanceToPolygon(polygon, x, y);
      if (d > skirt) return;
      const t = 0.5 + 0.5 * Math.cos((d / skirt) * Math.PI);
      this.heights[idx] += (height - this.heights[idx]) * t;
    });
    return this;
  }

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

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Shortest distance from a point to a polygon's edges. */
function distanceToPolygon(polygon: Vec2[], x: number, y: number): number {
  let best = Infinity;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const p = polygon[b];
    const q = polygon[a];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / len2))
      : 0;
    best = Math.min(best, Math.hypot(x - (p.x + dx * t), y - (p.y + dy * t)));
  }
  return best;
}
