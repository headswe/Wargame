import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dist, vec } from '../src/sim/math.ts';
import { Rng } from '../src/sim/rng.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { wall } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';
import { type SimContext, updateUnit } from '../src/sim/ai.ts';
import {
  Faction, MoveMode, WEAPONS, makeUnit, resetUnitIds, type Unit,
} from '../src/sim/units.ts';

/** Just enough of a simulation for one man to walk about in. */
function harness(scene: Scene, units: Unit[]): SimContext {
  return {
    scene,
    rng: new Rng(7),
    units: new Map(units.map((u) => [u.id, u])),
    unitList: units,
    squads: [],
    effects: [],
    live: [],
    time: 0,
  };
}

test('a man pressed square into a wall digs himself out instead of standing there', () => {
  /**
   * The bug this comes from cost a won assault its objective.
   *
   * `stepMovement` moves each axis independently so a shoulder clipping a wall
   * slides along it instead of stopping the man dead. That rescues a man
   * approaching at an angle and does nothing at all for one approaching square
   * on: the funnel emits axis-aligned legs constantly, and on those the
   * perpendicular velocity is exactly zero, so when the axis he wants is
   * blocked there is no second axis left to slide with. Four of BRAVO spent the
   * last hundred and ten seconds of a won fight pushing into geometry with the
   * defence dead and the objective twenty metres away — positions identical to
   * four decimal places, tick after tick, velocity a healthy 2.1 m/s the whole
   * time.
   *
   * Planning better cannot fix it. The path is planned on the navmesh and every
   * step is tested against the walkable field, which rounds thin geometry up by
   * STAMP_FLOOR; the two disagree at the margins by design. So the mover has to
   * survive being somewhere the planner would never have put him.
   */
  const scene = new Scene(60, 60);
  wall(scene, {
    a: vec(6, 30), b: vec(54, 30), fabric: Fabric.Brick, top: 2.6, thickness: 0.4,
  });
  scene.bake();

  resetUnitIds();
  const u = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(20, 31.6), weapon: WEAPONS.carbine,
  });
  u.moveMode = MoveMode.Tactical;
  // Straight through the wall, which is the situation: the leg is axis-aligned
  // and the axis it wants is the one that is blocked.
  u.path = [vec(20, 24)];
  u.pathIndex = 0;

  const ctx = harness(scene, [u]);
  const start = { ...u.pos };
  for (let t = 0; t < 20; t += 0.05) {
    updateUnit(ctx, u, 0.05);
    ctx.time += 0.05;
    if (u.path.length === 0) break;
  }

  assert.ok(
    dist(u.pos, start) > 2 || u.path.length === 0,
    `wedged at (${u.pos.x.toFixed(2)},${u.pos.y.toFixed(2)}), started at ` +
    `(${start.x.toFixed(2)},${start.y.toFixed(2)})`,
  );
  assert.ok(scene.walkable(u.pos.x, u.pos.y), 'and he has not pushed his way into the wall');
});

test('an ordinary walk through a doorway still just works', () => {
  // The other half of the fix: giving up on a route must stay rare. A rule
  // that drops the path whenever a man is briefly slow would turn every
  // doorway, every corner and every bit of crowding into a re-plan, and the
  // symptom of that is men who mill about instead of going where they are
  // sent. He should pass through without the fallback ever firing.
  const scene = new Scene(60, 60);
  wall(scene, {
    a: vec(6, 30), b: vec(54, 30), fabric: Fabric.Brick, top: 2.6, thickness: 0.4,
    openings: [{ at: 20, width: 3.5, kind: 'door' }],
  });
  scene.bake();

  resetUnitIds();
  const u = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(26, 34), weapon: WEAPONS.carbine,
  });
  u.moveMode = MoveMode.Tactical;
  const route = scene.findPath(u.pos, vec(26, 22));
  assert.ok(route, 'the doorway is a way through');
  u.path = route;
  u.pathIndex = 0;

  const ctx = harness(scene, [u]);
  let arrived = false;
  for (let t = 0; t < 40; t += 0.05) {
    updateUnit(ctx, u, 0.05);
    ctx.time += 0.05;
    if (u.pathIndex >= u.path.length || u.path.length === 0) {
      arrived = u.pos.y < 29;
      break;
    }
  }
  assert.ok(arrived, `he did not get through — ended at (${u.pos.x.toFixed(1)},${u.pos.y.toFixed(1)})`);
  assert.equal(u.wedgedFor, 0, 'and never had to be dug out of anything');
});
