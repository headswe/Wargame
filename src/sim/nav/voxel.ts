import { Solidity, Structures } from '../world/geometry.ts';
import type { Terrain } from '../world/terrain.ts';

export interface VoxelOptions {
  /** Cell size in metres. Finer means smoother contours and more cost. */
  cellSize: number;
  /** Rise over run past which a slope is not walkable. 0.8 is about 39 degrees. */
  maxSlope: number;
  /** Half-width of an operator. Walkable space is eroded by this. */
  agentRadius: number;
  /**
   * How far contour simplification is allowed to stray from the true boundary.
   *
   * This is not a cosmetic knob. Douglas-Peucker moves vertices OUTWARD as
   * readily as inward, so a simplified contour can bulge into space the
   * erosion just cleared, and a funnelled path will happily cut that corner
   * straight through a wall. The margin is therefore added to the erosion, so
   * simplification error eats into slack rather than into real clearance.
   */
  contourTolerance: number;
  /**
   * How far across a too-steep band an operator will scramble, in metres.
   *
   * A slope threshold alone cannot tell a hillside from a ditch bank, and they
   * are not the same thing: nobody walks up a forty-degree hill, and everybody
   * slides into a drainage ditch. The difference is width. A steep band no
   * wider than this, with walkable ground on both sides, is crossed rather
   * than skirted — which is what makes trenches, sunken roads and embankments
   * usable terrain instead of fences.
   */
  scrambleRun: number;
  /** Height an operator will scramble up or down across such a band. */
  scrambleRise: number;
}

export const DEFAULT_VOXEL_OPTIONS: VoxelOptions = {
  cellSize: 0.25,
  maxSlope: 0.8,
  agentRadius: 0.35,
  contourTolerance: 0.2,
  scrambleRun: 3.2,
  scrambleRise: 2.4,
};

/**
 * The walkable surface, rasterised.
 *
 * This is the voxelisation step of a Recast-style pipeline, minus the part that
 * makes Recast large. Recast keeps a list of solid spans per column so it can
 * cope with bridges and overhangs; a single-storey world has exactly one
 * walkable surface per column, so a flat bitmap says everything there is to
 * say, and the whole span-merging stage disappears.
 */
export class WalkableField {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** 1 where an operator's centre may stand, after erosion. */
  readonly walkable: Uint8Array;
  /** Cells to the nearest blocked cell, capped. Use `clearanceAt` for metres. */
  readonly clearance: Float32Array;
  private readonly raw: Uint8Array;
  private readonly options: VoxelOptions;
  /** Ground walkability before structures, over the working box. */
  private readonly ground: Uint8Array;
  /** Ground refused on slope alone, which is what a scramble may reinstate. */
  private readonly steep: Uint8Array;
  /** Terrain height per cell, kept so a scramble can be tested for rise. */
  private readonly elevation: Float32Array;
  /** Cells the scramble pass reinstates. Written by both passes, applied once. */
  private readonly bridged: Uint8Array;

  constructor(width: number, height: number, options: VoxelOptions) {
    this.options = options;
    this.cellSize = options.cellSize;
    this.cols = Math.ceil(width / options.cellSize);
    this.rows = Math.ceil(height / options.cellSize);
    const cells = this.cols * this.rows;
    this.raw = new Uint8Array(cells);
    this.walkable = new Uint8Array(cells);
    this.clearance = new Float32Array(cells);
    this.ground = new Uint8Array(cells);
    this.steep = new Uint8Array(cells);
    this.elevation = new Float32Array(cells);
    this.bridged = new Uint8Array(cells);
  }

  centreOf(i: number, j: number): { x: number; y: number } {
    return { x: (i + 0.5) * this.cellSize, y: (j + 0.5) * this.cellSize };
  }

  at(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return false;
    return this.walkable[j * this.cols + i] === 1;
  }

  containsPoint(x: number, y: number): boolean {
    return this.at(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
  }

  /** Metres to the nearest blocked cell, saturating at the erosion radius. */
  clearanceAt(x: number, y: number): number {
    const i = Math.floor(x / this.cellSize);
    const j = Math.floor(y / this.cellSize);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return 0;
    return this.clearance[j * this.cols + i] * this.cellSize;
  }

  /** How far the distance transform ever needs to look, in cells. */
  private get clearanceCap(): number {
    return Math.ceil((this.options.agentRadius + this.options.contourTolerance) / this.cellSize) + 2;
  }

  /** Rebuild everything. Cheap enough to do at load; use `rebuildRegion` after. */
  build(terrain: Terrain, structures: Structures): void {
    this.rasterise(terrain, structures, 0, 0, this.cols - 1, this.rows - 1);
    this.computeClearance(0, 0, this.cols - 1, this.rows - 1);
    this.erode(0, 0, this.cols - 1, this.rows - 1);
  }

  /**
   * Redo a box after something came down.
   *
   * This is genuinely local. Clearance is capped at the erosion radius, so a
   * change cannot alter any distance more than that many cells away, and a
   * chamfer over the dirty box plus that margin gives exactly the same answer
   * as one over the whole grid — reading the still-valid values just outside
   * as its boundary condition.
   */
  rebuildRegion(
    terrain: Terrain,
    structures: Structures,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): boolean {
    const cap = this.clearanceCap;
    // A change can widen or close a steep band, so every band it touches has to
    // be re-decided in full, not just the part inside the dirty box.
    const reach = this.scrambleCells + 1;
    const i0 = Math.floor(minX / this.cellSize) - reach;
    const j0 = Math.floor(minY / this.cellSize) - reach;
    const i1 = Math.ceil(maxX / this.cellSize) + reach;
    const j1 = Math.ceil(maxY / this.cellSize) + reach;

    this.rasterise(terrain, structures, i0, j0, i1, j1);
    this.computeClearance(i0 - cap, j0 - cap, i1 + cap, j1 + cap);
    return this.erode(i0 - cap, j0 - cap, i1 + cap, j1 + cap);
  }

  private rasterise(
    terrain: Terrain,
    structures: Structures,
    i0: number,
    j0: number,
    i1: number,
    j1: number,
  ): void {
    const lo = { i: Math.max(0, i0), j: Math.max(0, j0) };
    const hi = { i: Math.min(this.cols - 1, i1), j: Math.min(this.rows - 1, j1) };

    // The scramble pass needs to see a whole steep band plus the walkable cell
    // at either end of it, so the ground is sampled over a margin and only the
    // requested box is written back. That keeps a regional redo exact.
    const margin = this.scrambleCells + 1;
    const el = { i: Math.max(0, lo.i - margin), j: Math.max(0, lo.j - margin) };
    const eh = {
      i: Math.min(this.cols - 1, hi.i + margin),
      j: Math.min(this.rows - 1, hi.j + margin),
    };

    // Ground first: too steep is not walkable, whatever is or is not built on it.
    for (let j = el.j; j <= eh.j; j++) {
      for (let i = el.i; i <= eh.i; i++) {
        const { x, y } = this.centreOf(i, j);
        const k = j * this.cols + i;
        const inside = x > 0 && y > 0 && x < terrain.width && y < terrain.height;
        const walks = inside && terrain.slopeAt(x, y) <= this.options.maxSlope;
        this.ground[k] = walks ? 1 : 0;
        this.steep[k] = inside && !walks ? 1 : 0;
        this.elevation[k] = inside ? terrain.heightAt(x, y) : 0;
        this.bridged[k] = 0;
      }
    }

    this.scramble(el, eh);

    for (let j = lo.j; j <= hi.j; j++) {
      for (let i = lo.i; i <= hi.i; i++) {
        const k = j * this.cols + i;
        this.raw[k] = this.ground[k] === 1 || this.bridged[k] === 1 ? 1 : 0;
      }
    }

    // Then stamp out anything solid enough to stop a body. Concealment — a
    // bush, standing crop — deliberately does not block: you can walk into it,
    // which is the entire point of it.
    const minX = lo.i * this.cellSize;
    const minY = lo.j * this.cellSize;
    const maxX = (hi.i + 1) * this.cellSize;
    const maxY = (hi.j + 1) * this.cellSize;

    // Same clamp as the occlusion field, for the same reason: centre sampling
    // drops anything thinner than a cell, and a fence you can walk through is
    // no fence. Erosion by the agent radius dwarfs the correction anyway.
    const floor = this.cellSize * Math.SQRT1_2;

    for (const id of structures.segmentsInBox(minX, minY, maxX, maxY)) {
      const segment = structures.segments[id];
      if (segment.destroyed || segment.solidity === Solidity.Concealment) continue;
      this.stampSegment(segment.a, segment.b, Math.max(segment.thickness / 2, floor), lo, hi);
    }

    for (const id of structures.propsInBox(minX, minY, maxX, maxY)) {
      const prop = structures.props[id];
      if (prop.destroyed || prop.solidity === Solidity.Concealment) continue;
      this.stampCircle(prop.pos, Math.max(prop.radius, floor), lo, hi);
    }
  }

  /** Width of the widest band an operator will cross, in cells. */
  private get scrambleCells(): number {
    return Math.max(1, Math.round(this.options.scrambleRun / this.cellSize));
  }

  /**
   * Reinstate narrow steep bands that have footing on both sides.
   *
   * Rows and columns are scanned independently and both write into the same
   * mask, which is applied afterwards — so a band only ever counts as narrow
   * because of the ground the slope test actually allowed, never because the
   * other pass just widened it. A ditch is narrow across and long along, so
   * one pass catches it and the other correctly declines to.
   */
  private scramble(lo: { i: number; j: number }, hi: { i: number; j: number }): void {
    const { cols, steep, ground, elevation, bridged } = this;
    const maxRun = this.scrambleCells;
    const maxRise = this.options.scrambleRise;

    const span = (start: number, end: number, stride: number, base: number): void => {
      // `start`..`end` is the run of steep cells; the two cells flanking it are
      // the footing the operator leaves from and arrives on.
      if (end - start > maxRun) return;
      const before = base + (start - 1) * stride;
      const after = base + (end + 1) * stride;
      if (ground[before] !== 1 || ground[after] !== 1) return;
      if (Math.abs(elevation[after] - elevation[before]) > maxRise) return;
      for (let k = start; k <= end; k++) bridged[base + k * stride] = 1;
    };

    for (let j = lo.j; j <= hi.j; j++) {
      const base = j * cols;
      let i = lo.i + 1;
      while (i < hi.i) {
        if (steep[base + i] !== 1) { i++; continue; }
        let end = i;
        while (end + 1 < hi.i && steep[base + end + 1] === 1) end++;
        span(i, end, 1, base);
        i = end + 1;
      }
    }

    for (let i = lo.i; i <= hi.i; i++) {
      let j = lo.j + 1;
      while (j < hi.j) {
        if (steep[j * cols + i] !== 1) { j++; continue; }
        let end = j;
        while (end + 1 < hi.j && steep[(end + 1) * cols + i] === 1) end++;
        span(j, end, cols, i);
        j = end + 1;
      }
    }
  }

  private stampSegment(
    a: { x: number; y: number },
    b: { x: number; y: number },
    half: number,
    lo: { i: number; j: number },
    hi: { i: number; j: number },
  ): void {
    const i0 = Math.max(lo.i, Math.floor((Math.min(a.x, b.x) - half) / this.cellSize));
    const i1 = Math.min(hi.i, Math.ceil((Math.max(a.x, b.x) + half) / this.cellSize));
    const j0 = Math.max(lo.j, Math.floor((Math.min(a.y, b.y) - half) / this.cellSize));
    const j1 = Math.min(hi.j, Math.ceil((Math.max(a.y, b.y) + half) / this.cellSize));

    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const { x, y } = this.centreOf(i, j);
        let t = lenSq < 1e-9 ? 0 : ((x - a.x) * abx + (y - a.y) * aby) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - (a.x + abx * t), y - (a.y + aby * t)) <= half) {
          this.raw[j * this.cols + i] = 0;
        }
      }
    }
  }

  private stampCircle(
    centre: { x: number; y: number },
    radius: number,
    lo: { i: number; j: number },
    hi: { i: number; j: number },
  ): void {
    const i0 = Math.max(lo.i, Math.floor((centre.x - radius) / this.cellSize));
    const i1 = Math.min(hi.i, Math.ceil((centre.x + radius) / this.cellSize));
    const j0 = Math.max(lo.j, Math.floor((centre.y - radius) / this.cellSize));
    const j1 = Math.min(hi.j, Math.ceil((centre.y + radius) / this.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const { x, y } = this.centreOf(i, j);
        if (Math.hypot(x - centre.x, y - centre.y) <= radius) this.raw[j * this.cols + i] = 0;
      }
    }
  }

  /**
   * Two-pass chamfer distance transform. Approximates Euclidean distance to
   * the nearest blocked cell closely enough to erode by an agent radius, at a
   * fraction of the cost of the exact thing.
   */
  private computeClearance(bi0: number, bj0: number, bi1: number, bj1: number): void {
    const { cols, rows, clearance, raw } = this;
    const straight = 1;
    const diagonal = Math.SQRT2;
    // Capping keeps the transform local: nothing past the cap can be affected
    // by a change inside the box, which is what makes a regional redo exact.
    const far = this.clearanceCap;

    const lo0 = Math.max(0, bi0);
    const lo1 = Math.max(0, bj0);
    const hi0 = Math.min(cols - 1, bi1);
    const hi1 = Math.min(rows - 1, bj1);

    for (let j = lo1; j <= hi1; j++) {
      for (let i = lo0; i <= hi0; i++) {
        const k = j * cols + i;
        clearance[k] = raw[k] === 1 ? far : 0;
      }
    }

    for (let j = lo1; j <= hi1; j++) {
      for (let i = lo0; i <= hi0; i++) {
        const k = j * cols + i;
        if (clearance[k] === 0) continue;
        let best = clearance[k];
        if (i > 0) best = Math.min(best, clearance[k - 1] + straight);
        if (j > 0) best = Math.min(best, clearance[k - cols] + straight);
        if (i > 0 && j > 0) best = Math.min(best, clearance[k - cols - 1] + diagonal);
        if (i < cols - 1 && j > 0) best = Math.min(best, clearance[k - cols + 1] + diagonal);
        clearance[k] = best < far ? best : far;
      }
    }

    for (let j = hi1; j >= lo1; j--) {
      for (let i = hi0; i >= lo0; i--) {
        const k = j * cols + i;
        if (clearance[k] === 0) continue;
        let best = clearance[k];
        if (i < cols - 1) best = Math.min(best, clearance[k + 1] + straight);
        if (j < rows - 1) best = Math.min(best, clearance[k + cols] + straight);
        if (i < cols - 1 && j < rows - 1) best = Math.min(best, clearance[k + cols + 1] + diagonal);
        if (i > 0 && j < rows - 1) best = Math.min(best, clearance[k + cols - 1] + diagonal);
        clearance[k] = best < far ? best : far;
      }
    }
  }

  /**
   * Pull the walkable region in far enough that a simplified contour still fits.
   * Returns whether any cell actually changed — most incoming fire scars a wall
   * without altering what can be walked on, and there is no reason to
   * re-triangulate the map for that.
   */
  private erode(bi0: number, bj0: number, bi1: number, bj1: number): boolean {
    // clearance is held in cells; convert the radius once rather than scaling
    // the whole field every rebuild.
    const radius = (this.options.agentRadius + this.options.contourTolerance) / this.cellSize;
    const lo0 = Math.max(0, bi0);
    const lo1 = Math.max(0, bj0);
    const hi0 = Math.min(this.cols - 1, bi1);
    const hi1 = Math.min(this.rows - 1, bj1);
    let changed = false;
    for (let j = lo1; j <= hi1; j++) {
      for (let i = lo0; i <= hi0; i++) {
        const k = j * this.cols + i;
        const next = this.raw[k] === 1 && this.clearance[k] >= radius ? 1 : 0;
        if (next !== this.walkable[k]) {
          this.walkable[k] = next;
          changed = true;
        }
      }
    }
    return changed;
  }
}
