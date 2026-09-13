import { Solidity, Structures } from './geometry.ts';
import type { SmokeField } from './smoke.ts';
import type { Terrain } from './terrain.ts';

/** Eye and silhouette heights, in metres above the ground you are standing on. */
export const Stature = {
  standingEye: 1.62,
  crouchedEye: 1.04,
  proneEye: 0.42,
  standingTop: 1.78,
  crouchedTop: 1.18,
  proneTop: 0.48,
} as const;

export interface Sighting {
  /** Any part of the target is visible. */
  visible: boolean
  /** 0..1 — how much of the target's silhouette is in the open. */
  exposure: number;
  /** 0..1 — vegetation and smoke on the line. Hides without protecting. */
  concealment: number;
  distance: number;
}

const BLOCKED: Sighting = { visible: false, exposure: 0, concealment: 0, distance: 0 };

/**
 * Absolute height of anything solid, per cell.
 *
 * Rasterising structures into a heightfield once turns every sightline query
 * into a march over two arrays, instead of a segment-intersection test against
 * every wall near the line. Line of sight runs far more often than anything
 * knocks a wall down, so the trade is heavily in favour of precomputing.
 */
export class OcclusionField {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /**
   * World height of whatever stops a sightline here — the ground itself, or
   * the top of anything solid standing on it, whichever is higher.
   *
   * Folding terrain in at build time is what makes a sightline one array read
   * per step instead of a bilinear terrain sample plus a lookup. Over a hundred
   * metres that is the difference between six microseconds and one.
   */
  readonly blockTop: Float32Array;
  /** World height of the top of solid geometry, or -Infinity where there is none. */
  readonly solidTop: Float32Array;
  /** World height of the top of vegetation, or -Infinity. */
  readonly coverTop: Float32Array;
  /** 0..1 density of whatever is growing there. */
  readonly density: Float32Array;
  /** Which segment put the solid height here, so a round can damage it. */
  readonly segmentAt: Int32Array;
  /** Which prop put it here, if a prop did. */
  readonly propAt: Int32Array;

  constructor(width: number, height: number, cellSize = 0.5) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.blockTop = new Float32Array(this.cols * this.rows);
    this.solidTop = new Float32Array(this.cols * this.rows).fill(-Infinity);
    this.coverTop = new Float32Array(this.cols * this.rows).fill(-Infinity);
    this.density = new Float32Array(this.cols * this.rows);
    this.segmentAt = new Int32Array(this.cols * this.rows).fill(-1);
    this.propAt = new Int32Array(this.cols * this.rows).fill(-1);
  }

  build(terrain: Terrain, structures: Structures): void {
    this.rebuild(terrain, structures, 0, 0, terrain.width, terrain.height);
  }

  rebuild(
    terrain: Terrain,
    structures: Structures,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const i0 = Math.max(0, Math.floor(minX / this.cellSize));
    const j0 = Math.max(0, Math.floor(minY / this.cellSize));
    const i1 = Math.min(this.cols - 1, Math.ceil(maxX / this.cellSize));
    const j1 = Math.min(this.rows - 1, Math.ceil(maxY / this.cellSize));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.cols + i;
        this.solidTop[k] = -Infinity;
        this.coverTop[k] = -Infinity;
        this.density[k] = 0;
        this.segmentAt[k] = -1;
        this.propAt[k] = -1;
        this.blockTop[k] = terrain.heightAt((i + 0.5) * this.cellSize, (j + 0.5) * this.cellSize);
      }
    }

    const pad = 2;
    for (const id of structures.segmentsInBox(minX - pad, minY - pad, maxX + pad, maxY + pad)) {
      const segment = structures.segments[id];
      if (segment.destroyed) continue;
      this.stampSegment(terrain, segment, i0, j0, i1, j1);
    }
    for (const id of structures.propsInBox(minX - pad, minY - pad, maxX + pad, maxY + pad)) {
      const prop = structures.props[id];
      if (prop.destroyed) continue;
      this.stampProp(terrain, prop, i0, j0, i1, j1);
    }
  }

  private stampSegment(
    terrain: Terrain,
    segment: Structures['segments'][number],
    bi0: number, bj0: number, bi1: number, bj1: number,
  ): void {
    // A cell is claimed by whether its centre falls inside the wall, so a wall
    // thinner than a cell lands between centres and rasterises to nothing at
    // all — a garden wall or a fence that stops no bullet and hides nobody.
    // Widening the stamp to the cell's half-diagonal guarantees that every cell
    // the wall passes through is claimed. It costs a few centimetres of
    // thickness on the thinnest geometry, which is the right way round: a wall
    // slightly fatter than drawn is invisible to the player, a wall that isn't
    // there is a hole in the map.
    const half = Math.max(segment.thickness / 2, this.cellSize * Math.SQRT1_2);
    const i0 = Math.max(bi0, Math.floor((Math.min(segment.a.x, segment.b.x) - half) / this.cellSize));
    const i1 = Math.min(bi1, Math.ceil((Math.max(segment.a.x, segment.b.x) + half) / this.cellSize));
    const j0 = Math.max(bj0, Math.floor((Math.min(segment.a.y, segment.b.y) - half) / this.cellSize));
    const j1 = Math.min(bj1, Math.ceil((Math.max(segment.a.y, segment.b.y) + half) / this.cellSize));

    const abx = segment.b.x - segment.a.x;
    const aby = segment.b.y - segment.a.y;
    const lenSq = abx * abx + aby * aby;
    const concealing = segment.solidity === Solidity.Concealment;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * this.cellSize;
        const y = (j + 0.5) * this.cellSize;
        let t = lenSq < 1e-9 ? 0 : ((x - segment.a.x) * abx + (y - segment.a.y) * aby) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - (segment.a.x + abx * t), y - (segment.a.y + aby * t)) > half) continue;

        const k = j * this.cols + i;
        const top = terrain.heightAt(x, y) + segment.top;
        if (concealing) {
          if (top > this.coverTop[k]) this.coverTop[k] = top;
          this.density[k] = Math.max(this.density[k], 0.75);
        } else if (top > this.solidTop[k]) {
          this.solidTop[k] = top;
          this.segmentAt[k] = segment.id;
          if (top > this.blockTop[k]) this.blockTop[k] = top;
        }
      }
    }
  }

  private stampProp(
    terrain: Terrain,
    prop: Structures['props'][number],
    bi0: number, bj0: number, bi1: number, bj1: number,
  ): void {
    // No clamp for props, unlike walls: something narrower than the grid is a
    // post or a bollard, and you can see past one.
    const i0 = Math.max(bi0, Math.floor((prop.pos.x - prop.radius) / this.cellSize));
    const i1 = Math.min(bi1, Math.ceil((prop.pos.x + prop.radius) / this.cellSize));
    const j0 = Math.max(bj0, Math.floor((prop.pos.y - prop.radius) / this.cellSize));
    const j1 = Math.min(bj1, Math.ceil((prop.pos.y + prop.radius) / this.cellSize));
    const concealing = prop.solidity === Solidity.Concealment;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * this.cellSize;
        const y = (j + 0.5) * this.cellSize;
        if (Math.hypot(x - prop.pos.x, y - prop.pos.y) > prop.radius) continue;
        const k = j * this.cols + i;
        const top = terrain.heightAt(x, y) + prop.top;
        if (concealing) {
          if (top > this.coverTop[k]) this.coverTop[k] = top;
          this.density[k] = Math.max(this.density[k], 0.7);
        } else if (top > this.solidTop[k]) {
          this.solidTop[k] = top;
          this.propAt[k] = prop.id;
          if (top > this.blockTop[k]) this.blockTop[k] = top;
        }
      }
    }
  }

  /** What occupies a cell, so fire can be attributed to something breakable. */
  occupantAt(x: number, y: number): { segment: number; prop: number } {
    const i = Math.floor(x / this.cellSize);
    const j = Math.floor(y / this.cellSize);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return { segment: -1, prop: -1 };
    const k = j * this.cols + i;
    return { segment: this.segmentAt[k], prop: this.propAt[k] };
  }

  solidAt(x: number, y: number): number {
    const i = Math.floor(x / this.cellSize);
    const j = Math.floor(y / this.cellSize);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -Infinity;
    return this.solidTop[j * this.cols + i];
  }
}

export interface Viewer {
  x: number;
  y: number;
  /** Eye height above the ground underfoot. */
  eye: number;
}

export interface Target {
  x: number;
  y: number;
  /** Bottom and top of the silhouette, above the ground underfoot. */
  base: number;
  top: number;
}

/**
 * How much of a target is actually in the open, along one line.
 *
 * Rather than asking "is it blocked", this solves for the lowest point on the
 * target that clears every obstruction on the way. An obstruction of height H
 * at fraction t along the line hides everything below
 *
 *     h = eye + (H - eye) / t
 *
 * so taking the highest such h over the whole walk gives the waterline of the
 * target: below it is hidden, above it is exposed.
 *
 * One pass therefore answers both questions at once, and a wall, a crest, a
 * ditch lip and a crouching man all become the same arithmetic. That is the
 * point — cover stops being a table of special cases and becomes geometry.
 */
export function sightline(
  terrain: Terrain,
  field: OcclusionField,
  viewer: Viewer,
  target: Target,
  maxRange = Infinity,
  smoke: SmokeField | null = null,
): Sighting {
  const dx = target.x - viewer.x;
  const dy = target.y - viewer.y;
  const distance = Math.hypot(dx, dy);
  if (distance > maxRange) return { ...BLOCKED, distance };
  if (distance < 1e-3) return { visible: true, exposure: 1, concealment: 0, distance };

  const eyeH = terrain.heightAt(viewer.x, viewer.y) + viewer.eye;
  const groundAtTarget = terrain.heightAt(target.x, target.y);
  const footH = groundAtTarget + target.base;
  const headH = groundAtTarget + target.top;

  let waterline = footH;
  let concealment = 0;

  const { cols, rows, cellSize, blockTop, coverTop, density } = field;
  // Nothing burning anywhere on the map costs one branch, not a second lookup
  // per cell for the whole game.
  const haze = smoke !== null && smoke.active ? smoke : null;

  // Every cell the line crosses, and no others.
  //
  // Sampling at a fixed stride does not work here however fine the stride: a
  // cell is entered for as little as a hair's breadth where the line clips its
  // corner, so any stride at all will eventually step over a wall and report a
  // clear shot straight through a building. Walking the grid instead (the
  // standard Amanatides-Woo traversal) removes the failure mode rather than
  // making it rarer, and costs less on short lines into the bargain.
  let i = Math.floor(viewer.x / cellSize);
  let j = Math.floor(viewer.y / cellSize);
  const iEnd = Math.floor(target.x / cellSize);
  const jEnd = Math.floor(target.y / cellSize);
  const stepI = dx >= 0 ? 1 : -1;
  const stepJ = dy >= 0 ? 1 : -1;
  const invX = dx === 0 ? Infinity : 1 / Math.abs(dx);
  const invY = dy === 0 ? Infinity : 1 / Math.abs(dy);
  // All parameters are fractions of the whole line, so `t` plugs straight into
  // the waterline equation.
  const spanX = cellSize * invX;
  const spanY = cellSize * invY;
  let nextX = dx === 0 ? Infinity
    : (dx > 0 ? (i + 1) * cellSize - viewer.x : viewer.x - i * cellSize) * invX;
  let nextY = dy === 0 ? Infinity
    : (dy > 0 ? (j + 1) * cellSize - viewer.y : viewer.y - j * cellSize) * invY;

  let entry = 0;
  // A line cannot cross more cells than the grid is wide plus tall.
  let guard = cols + rows + 4;

  while (guard-- > 0) {
    const exit = nextX < nextY ? nextX : nextY;

    // The viewer's own cell never blocks — you can always see out of where you
    // are standing — and neither does the target's, or a man pressed against a
    // wall would be hidden by it from every direction at once.
    if (entry > 0 && !(i === iEnd && j === jEnd) && i >= 0 && j >= 0 && i < cols && j < rows) {
      const k = j * cols + i;
      const obstruction = blockTop[k];

      // An obstruction constrains hardest at the earliest point it occupies, so
      // the cell is charged at the parameter where the line entered it.
      if (obstruction > eyeH || obstruction > eyeH + (waterline - eyeH) * entry) {
        const needed = eyeH + (obstruction - eyeH) / entry;
        if (needed > waterline) {
          waterline = needed;
          if (waterline >= headH) return { visible: false, exposure: 0, concealment, distance };
        }
      }

      // Vegetation on the line hides without protecting, so it is accumulated
      // separately and never touches the exposure figure. Charged by the length
      // actually travelled inside the cell: a single bush is a nuisance, a
      // hedgerow seen through the long way is total.
      const veg = coverTop[k];
      const travelled = (Math.min(exit, 1) - entry) * distance;
      if (veg > -Infinity && eyeH + (headH - eyeH) * entry < veg) {
        concealment += density[k] * travelled / 10;
      }
      // Smoke is the same axis, deliberately: it is the one thing a team can
      // put on the field to buy the cover the ground refuses to give them, and
      // it has to be worth exactly what a hedgerow is worth, no more.
      if (haze !== null && haze.top[k] > -Infinity && eyeH + (headH - eyeH) * entry < haze.top[k]) {
        concealment += haze.density[k] * travelled / 5.5;
      }
    }

    if ((i === iEnd && j === jEnd) || exit >= 1) break;
    if (nextX < nextY) {
      i += stepI;
      nextX += spanX;
    } else {
      j += stepJ;
      nextY += spanY;
    }
    entry = exit;
  }

  const span = headH - footH;
  const exposure = span <= 1e-6 ? 1 : clamp01((headH - waterline) / span);
  return {
    visible: exposure > 0,
    exposure,
    concealment: clamp01(concealment),
    distance,
  };
}

/** Eye height for a posture, raised as an operator leans out to shoot. */
export function eyeHeight(crouched: boolean, exposure: number): number {
  const low = crouched ? Stature.crouchedEye : Stature.standingEye;
  const high = Stature.standingEye;
  return low + (high - low) * clamp01(exposure);
}

/** Silhouette height for a posture. Crouching is worth cover all by itself. */
export function silhouetteTop(crouched: boolean, prone: boolean): number {
  if (prone) return Stature.proneTop;
  return crouched ? Stature.crouchedTop : Stature.standingTop;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
