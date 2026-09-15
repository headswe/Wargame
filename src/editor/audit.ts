import { type Vec2, dist, vec } from '../sim/math.ts';
import type { Problem } from '../sim/world/level-data.ts';
import { Stature } from '../sim/world/occlusion.ts';
import type { Scene as SimScene } from '../sim/world/scene.ts';
import type { LevelData } from '../sim/world/level-data.ts';

/**
 * The checks that need the level built rather than just read.
 *
 * Structural validation catches a missing objective; only running the navmesh
 * catches a village where the objective cannot be reached from the start line,
 * a house whose door a wall was laid across, or a defender standing inside a
 * wall. Those are the mistakes that actually ship, because the level looks
 * perfectly correct in the viewport right up until nobody can get anywhere.
 */
export function audit(scene: SimScene, data: LevelData): Problem[] {
  const problems: Problem[] = [];
  const say = (severity: Problem['severity'], where: string, message: string): void => {
    problems.push({ severity, where, message });
  };

  /** The nearest standable ground, since a spawn a metre off is a fixable nit. */
  const nearestWalkable = (p: Vec2): Vec2 | null => {
    if (scene.walkable(p.x, p.y)) return p;
    for (let r = 1; r <= 6; r++) {
      for (let a = 0; a < 12; a++) {
        const angle = (a / 12) * Math.PI * 2;
        const q = vec(p.x + Math.cos(angle) * r, p.y + Math.sin(angle) * r);
        if (scene.walkable(q.x, q.y)) return q;
      }
    }
    return null;
  };

  data.spawns.teams.forEach((team, t) => {
    team.forEach((p, i) => {
      if (!scene.walkable(p.x, p.y)) {
        const near = nearestWalkable(p);
        say('error', 'spawns',
          near
            ? `team ${t + 1} operator ${i + 1} starts inside something solid`
            : `team ${t + 1} operator ${i + 1} starts somewhere nobody can stand`);
      }
    });
  });

  /**
   * Nobody starts a contract already being shot at.
   *
   * A start line inside the defence's engagement envelope takes the first
   * decision away from the player: he is in contact before he has looked at
   * the ground, and the plan he was going to make is now a reaction. Kolna
   * shipped like this — all three teams in view, one at twenty-seven metres and
   * fully exposed — because the map was tuned to bring its dead-ground figure
   * down and the approach was shortened until the start line sat inside the
   * wire. A number nobody should have optimised, and a check that would have
   * said so at the time.
   */
  data.spawns.teams.forEach((team, t) => {
    let worst: { range: number; from: Vec2 } | null = null;
    for (const p of team) {
      for (const e of data.spawns.enemies) {
        const view = scene.sight(
          { x: e.pos.x, y: e.pos.y, eye: Stature.crouchedEye },
          { x: p.x, y: p.y, base: 0, top: Stature.standingTop },
        );
        if (!view.visible) continue;
        const range = dist(e.pos, p);
        if (!worst || range < worst.range) worst = { range, from: e.pos };
      }
    }
    if (worst) {
      say('error', 'spawns',
        `team ${t + 1} starts in plain view of a defender `
        + `${worst.range.toFixed(0)}m away at `
        + `${worst.from.x.toFixed(0)},${worst.from.y.toFixed(0)}`);
    }
  });

  data.spawns.enemies.forEach((e, i) => {
    if (!scene.walkable(e.pos.x, e.pos.y)) {
      say('warning', 'spawns', `defender ${i + 1} is standing inside something solid`);
    }
  });

  data.spawns.objectives.forEach((o, i) => {
    if (!scene.walkable(o.x, o.y)) {
      say('error', 'spawns', `objective ${i + 1} is somewhere nobody can stand on`);
      return;
    }
    data.spawns.teams.forEach((team, t) => {
      const from = team[0] && nearestWalkable(team[0]);
      if (!from) return;
      if (!scene.findPath(from, o)) {
        say('error', 'spawns', `team ${t + 1} cannot reach objective ${i + 1} by any route`);
      }
    });
  });

  // A building with no way in is the classic quiet failure: it looks like a
  // building, it has a door drawn in it, and the navmesh disagrees.
  for (const b of scene.structures.buildings) {
    if (b.footprint.length === 0) continue;
    const centre = vec(
      b.footprint.reduce((a, p) => a + p.x, 0) / b.footprint.length,
      b.footprint.reduce((a, p) => a + p.y, 0) / b.footprint.length,
    );
    if (!scene.walkable(centre.x, centre.y)) continue;
    let outside: Vec2 | null = null;
    for (let r = 12; r <= 30 && !outside; r += 3) {
      for (let a = 0; a < 16; a++) {
        const angle = (a / 16) * Math.PI * 2;
        const q = vec(centre.x + Math.cos(angle) * r, centre.y + Math.sin(angle) * r);
        if (q.x < 1 || q.y < 1 || q.x > scene.width - 1 || q.y > scene.height - 1) continue;
        if (scene.walkable(q.x, q.y)) {
          outside = q;
          break;
        }
      }
    }
    if (outside && !scene.findPath(outside, centre)) {
      say('warning', 'structures',
        `the building at ${centre.x.toFixed(0)},${centre.y.toFixed(0)} cannot be entered`);
    }
  }

  return problems;
}
