/**
 * Deterministic PRNG (mulberry32). The whole sim draws from one of these so a
 * mission can be replayed exactly from its seed — which is what makes combat
 * bugs reproducible and, later, makes replays and lockstep multiplayer possible.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Integer in [lo, hi). */
  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Approximately normal, mean 0, stddev 1 (sum of uniforms). */
  gaussian(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.73;
  }
}
