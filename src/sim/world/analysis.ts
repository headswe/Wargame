import type { Vec2 } from '../math.ts';
import type { Scene } from './scene.ts';
import { Stature } from './occlusion.ts';

/**
 * What a level does to the people who have to cross it, measured.
 *
 * The same sweep backs the editor's overlay and the command-line report, which
 * is deliberate: a level that passes a check in one place and fails it in the
 * other teaches an author to trust neither. It uses the game's own sightlines
 * rather than an approximation of them, for the same reason.
 */

/** Metres between samples. Two is fine: cover does not change faster than a man. */
export const SAMPLE_STEP = 2;

export interface GroundSample {
  cols: number;
  rows: number;
  /** 1 where a man can stand. */
  walkable: Uint8Array;
  /** How many defenders can see a man standing here. */
  seenBy: Uint8Array;
  /** The most of him any of them can see, 0..1. */
  exposure: Float32Array;
}

export interface GroundStats {
  /** Share of walkable ground at least one defender covers. */
  covered: number;
  /** Share nobody covers: the approaches a level gives away for free. */
  dead: number;
  /** Mean number of defenders bearing on a piece of walkable ground. */
  weight: number;
  /** Share of covered ground where a man is more than half exposed. */
  open: number;
  walkableSamples: number;
  millis: number;
}

export function sampleGround(scene: Scene, defenders: Vec2[]): GroundSample & { stats: GroundStats } {
  const began = Date.now();
  const cols = Math.floor(scene.width / SAMPLE_STEP) + 1;
  const rows = Math.floor(scene.height / SAMPLE_STEP) + 1;
  const count = cols * rows;
  const walkable = new Uint8Array(count);
  const seenBy = new Uint8Array(count);
  const exposure = new Float32Array(count);

  let walkableSamples = 0;
  let coveredCount = 0;
  let openCount = 0;
  let weightTotal = 0;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const x = i * SAMPLE_STEP;
      const y = j * SAMPLE_STEP;
      if (!scene.walkable(x, y)) continue;
      walkable[k] = 1;
      walkableSamples++;

      let seen = 0;
      let worst = 0;
      for (const d of defenders) {
        if (Math.hypot(d.x - x, d.y - y) > 260) continue;
        const view = scene.sight(
          { x: d.x, y: d.y, eye: Stature.crouchedEye },
          { x, y, base: 0, top: Stature.standingTop },
        );
        if (!view.visible) continue;
        seen++;
        if (view.exposure > worst) worst = view.exposure;
      }
      seenBy[k] = Math.min(255, seen);
      exposure[k] = worst;
      if (seen > 0) {
        coveredCount++;
        if (worst > 0.5) openCount++;
      }
      weightTotal += seen;
    }
  }

  const share = (n: number): number => (walkableSamples === 0 ? 0 : n / walkableSamples);
  return {
    cols, rows, walkable, seenBy, exposure,
    stats: {
      covered: share(coveredCount),
      dead: 1 - share(coveredCount),
      weight: share(weightTotal),
      open: coveredCount === 0 ? 0 : openCount / coveredCount,
      walkableSamples,
      millis: Date.now() - began,
    },
  };
}

/**
 * How much ground one position holds, and where its edge is.
 *
 * The question a designer asks continually and cannot answer by looking: put a
 * gun here and what does it cover? It is also how you find out that the wall
 * you were pleased with blinds the position behind it.
 */
export function sightFan(
  scene: Scene, at: Vec2, range = 140, bearings = 240,
): { edge: Vec2[]; reach: number } {
  const step = 2;
  const eye = { x: at.x, y: at.y, eye: Stature.crouchedEye };
  const edge: Vec2[] = [];
  let total = 0;

  for (let b = 0; b < bearings; b++) {
    const angle = (b / bearings) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let reached = 0;
    for (let d = step; d <= range; d += step) {
      const x = at.x + dx * d;
      const y = at.y + dy * d;
      if (x < 0 || y < 0 || x > scene.width || y > scene.height) break;
      // A man standing there, which is what the position is actually for.
      if (!scene.sight(eye, { x, y, base: 0, top: Stature.standingTop }).visible) break;
      reached = d;
    }
    total += reached;
    edge.push({ x: at.x + dx * reached, y: at.y + dy * reached });
  }
  return { edge, reach: total / bearings };
}
