import { type Vec2 } from './math.ts';
import { Tile, World, blocksMove, blocksSight } from './world.ts';

export interface TraceResult {
  /** No full-height geometry between the two points. */
  clear: boolean;
  /** Waist-high tiles crossed in between — degrades a shot without stopping it. */
  lowCrossed: number;
  /** Where the line met a wall, if it did. */
  hit: Vec2 | null;
}

/**
 * Amanatides & Woo grid traversal. Walks every tile the segment actually
 * touches, so a shot cannot slip diagonally between two wall corners — the
 * classic cheap-raycast bug that makes players feel cheated by cover.
 */
export function trace(world: World, from: Vec2, to: Vec2, sightOnly = true): TraceResult {
  let tx = Math.floor(from.x);
  let ty = Math.floor(from.y);
  const endX = Math.floor(to.x);
  const endY = Math.floor(to.y);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  const invDx = dx === 0 ? Infinity : 1 / Math.abs(dx);
  const invDy = dy === 0 ? Infinity : 1 / Math.abs(dy);

  // Distance (in units of t along the segment) to the first grid line crossing.
  let tMaxX =
    dx === 0 ? Infinity : ((dx > 0 ? tx + 1 - from.x : from.x - tx) * invDx);
  let tMaxY =
    dy === 0 ? Infinity : ((dy > 0 ? ty + 1 - from.y : from.y - ty) * invDy);
  const tDeltaX = invDx;
  const tDeltaY = invDy;

  let lowCrossed = 0;
  let guard = 0;
  const maxSteps = world.width + world.height + 4;

  while (guard++ < maxSteps) {
    if (tx === endX && ty === endY) return { clear: true, lowCrossed, hit: null };

    let t: number;
    if (tMaxX < tMaxY) {
      tx += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
    } else {
      ty += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
    }
    if (t > 1) return { clear: true, lowCrossed, hit: null };

    const tile = world.at(tx, ty);
    if (tx === endX && ty === endY) return { clear: true, lowCrossed, hit: null };

    const blocked = sightOnly ? blocksSight(tile) : blocksMove(tile);
    if (blocked) {
      return {
        clear: false,
        lowCrossed,
        hit: { x: from.x + dx * t, y: from.y + dy * t },
      };
    }
    if (tile === Tile.Low) lowCrossed++;
  }

  return { clear: true, lowCrossed, hit: null };
}

/** Can a bullet or an eye get from a to b? */
export function hasLineOfSight(world: World, from: Vec2, to: Vec2): boolean {
  return trace(world, from, to).clear;
}

/** Can a body walk the straight line from a to b? Used to smooth paths. */
export function lineWalkable(world: World, from: Vec2, to: Vec2): boolean {
  return trace(world, from, to, false).clear;
}
