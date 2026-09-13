import type { Vec2 } from '../math.ts';

/** One cloud, from the moment the canister pops to the moment it thins out. */
export interface Puff {
  pos: Vec2;
  /** Ground height under it, so the column sits on the terrain. */
  ground: number;
  age: number;
  /** Seconds of useful screening. */
  life: number;
  /** Metres it grows to. */
  radius: number;
  /** How high the column stands once grown. */
  height: number;
}

const BLOOM = 4.0;
const FADE = 6.0;

/**
 * Smoke, as a field rather than as objects.
 *
 * It deliberately shares the occlusion grid's resolution and indexing so a
 * sightline can read it with the arithmetic it has already done. And it is
 * kept apart from the static occlusion field for a reason that is not about
 * performance: smoke conceals without protecting, it moves, and it expires, so
 * folding it into the same array as brick would either make walls temporary or
 * make smoke bulletproof. Two fields, one concealment axis.
 */
export class SmokeField {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** 0..1 obscuration per cell. */
  readonly density: Float32Array;
  /** Absolute world height the column reaches, or -Infinity. */
  readonly top: Float32Array;
  /** Hoisted out of the sightline loop: no smoke on the map, no second lookup. */
  active = false;

  private readonly puffs: Puff[] = [];
  /** The box the last stamp dirtied, so clearing costs what it should. */
  private dirty: { i0: number; j0: number; i1: number; j1: number } | null = null;

  constructor(width: number, height: number, cellSize = 0.5) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.density = new Float32Array(this.cols * this.rows);
    this.top = new Float32Array(this.cols * this.rows).fill(-Infinity);
  }

  get clouds(): readonly Puff[] {
    return this.puffs;
  }

  add(pos: Vec2, ground: number, options: { life?: number; radius?: number; height?: number } = {}): void {
    this.puffs.push({
      pos: { ...pos },
      ground,
      age: 0,
      life: options.life ?? 26,
      radius: options.radius ?? 7.5,
      height: options.height ?? 4.2,
    });
  }

  clear(): void {
    this.puffs.length = 0;
    this.restamp();
  }

  update(dt: number): void {
    if (this.puffs.length === 0) return;
    for (const p of this.puffs) p.age += dt;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      if (this.puffs[i].age > this.puffs[i].life + FADE) this.puffs.splice(i, 1);
    }
    this.restamp();
  }

  /** 0..1 of full screening, given how long this cloud has been up. */
  private opacityOf(p: Puff): number {
    if (p.age < BLOOM) return p.age / BLOOM;
    if (p.age < p.life) return 1;
    return Math.max(0, 1 - (p.age - p.life) / FADE);
  }

  private radiusOf(p: Puff): number {
    // Grows fast at first, then creeps: a canister that takes as long to reach
    // useful size as it does to burn out is no use to anyone.
    const t = Math.min(1, p.age / (BLOOM * 1.6));
    return p.radius * (0.25 + 0.75 * Math.sqrt(t));
  }

  private restamp(): void {
    if (this.dirty) {
      for (let j = this.dirty.j0; j <= this.dirty.j1; j++) {
        const base = j * this.cols;
        for (let i = this.dirty.i0; i <= this.dirty.i1; i++) {
          this.density[base + i] = 0;
          this.top[base + i] = -Infinity;
        }
      }
      this.dirty = null;
    }
    this.active = this.puffs.length > 0;
    if (!this.active) return;

    let i0 = this.cols;
    let j0 = this.rows;
    let i1 = -1;
    let j1 = -1;

    for (const p of this.puffs) {
      const radius = this.radiusOf(p);
      const opacity = this.opacityOf(p);
      if (opacity <= 0.01) continue;
      const top = p.ground + p.height;

      const pi0 = Math.max(0, Math.floor((p.pos.x - radius) / this.cellSize));
      const pi1 = Math.min(this.cols - 1, Math.ceil((p.pos.x + radius) / this.cellSize));
      const pj0 = Math.max(0, Math.floor((p.pos.y - radius) / this.cellSize));
      const pj1 = Math.min(this.rows - 1, Math.ceil((p.pos.y + radius) / this.cellSize));
      if (pi0 < i0) i0 = pi0;
      if (pj0 < j0) j0 = pj0;
      if (pi1 > i1) i1 = pi1;
      if (pj1 > j1) j1 = pj1;

      for (let j = pj0; j <= pj1; j++) {
        const y = (j + 0.5) * this.cellSize;
        const base = j * this.cols;
        for (let i = pi0; i <= pi1; i++) {
          const x = (i + 0.5) * this.cellSize;
          const d = Math.hypot(x - p.pos.x, y - p.pos.y);
          if (d > radius) continue;
          // Thickest in the middle, ragged at the edge — which is what makes a
          // canister something to hide the middle of a dash in, not a wall.
          const fill = opacity * (1 - (d / radius) ** 2);
          const k = base + i;
          if (fill > this.density[k]) this.density[k] = fill;
          if (top > this.top[k]) this.top[k] = top;
        }
      }
    }

    if (i1 >= i0) this.dirty = { i0, j0, i1, j1 };
    else this.active = false;
  }
}
