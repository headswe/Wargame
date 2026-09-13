import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STEPOVE, createScene } from '../src/sim/levels.ts';
import { Sim } from '../src/sim/sim.ts';
import { Faction, MoveMode, UnitState } from '../src/sim/units.ts';
import { Stature } from '../src/sim/world/occlusion.ts';

test('every spawn and the objective sit on ground a body can stand on', () => {
  const scene = createScene(STEPOVE);
  for (const [i, team] of scene.spawns.teams.entries()) {
    for (const pos of team) {
      assert.ok(scene.walkable(pos.x, pos.y), `team ${i + 1} spawn at (${pos.x},${pos.y}) is not navigable`);
    }
  }
  for (const objective of scene.spawns.objectives) {
    assert.ok(scene.walkable(objective.x, objective.y), 'the objective must be reachable ground');
  }
});

test('every team can reach the objective, and so can the defenders', () => {
  const scene = createScene(STEPOVE);
  const objective = scene.spawns.objectives[0];

  scene.spawns.teams.forEach((team, i) => {
    assert.ok(scene.findPath(team[0], objective), `team ${i + 1} cannot reach the objective`);
  });

  let stranded = 0;
  for (const enemy of scene.spawns.enemies) {
    if (!scene.findPath(enemy.pos, objective)) stranded++;
  }
  assert.equal(stranded, 0, `${stranded} defenders are walled off from the objective`);
});

test('there is real open ground to cross', () => {
  const scene = createScene(STEPOVE);
  const eye = Stature.standingEye;
  const reaches: number[] = [];

  for (let x = 12; x < scene.width - 12; x += 6) {
    let reach = 0;
    for (let y = 118; y > 10; y -= 2) {
      const s = scene.sight(
        { x, y: 122, eye },
        { x, y, base: 0, top: Stature.standingTop },
      );
      if (!s.visible) break;
      reach = 122 - y;
    }
    reaches.push(reach);
  }
  reaches.sort((a, b) => a - b);
  const median = reaches[Math.floor(reaches.length / 2)];
  assert.ok(median > 25, `the approach should be open, median clear line was only ${median} m`);
});

test('nobody is under fire on the start line', () => {
  for (const seed of [1, 2, 3]) {
    const sim = new Sim(STEPOVE, seed);
    for (let i = 0; i < 60 * 6; i++) sim.update(1 / 60);
    for (const u of sim.unitList) {
      if (u.faction !== Faction.Player) continue;
      assert.equal(u.hp, u.maxHp, `${u.name} took fire before receiving an order (seed ${seed})`);
    }
  }
});

test('a squad order puts operators somewhere better than the open', () => {
  const sim = new Sim(STEPOVE, 11);
  const alpha = sim.squads[0];
  sim.orderSquad(alpha.id, { x: 40, y: 86 }, MoveMode.Tactical, -Math.PI / 2);

  const members = sim.membersOf(alpha);
  assert.ok(members.every((u) => u.slot !== null), 'everyone should have been given a position');

  // Each chosen position should show less of a man than the order point itself.
  const threat = { x: 40, y: 16, eye: Stature.standingEye };
  const atOrderPoint = sim.scene.sight(threat, { x: 40, y: 86, base: 0, top: Stature.crouchedTop });
  const chosen = members.map((u) =>
    sim.scene.sight(threat, { x: u.slot!.x, y: u.slot!.y, base: 0, top: Stature.crouchedTop }).exposure,
  );
  const mean = chosen.reduce((a, b) => a + b, 0) / chosen.length;
  assert.ok(
    mean <= atOrderPoint.exposure + 0.05,
    `positions should be no worse than the bare order point: ${mean.toFixed(2)} against ${atOrderPoint.exposure.toFixed(2)}`,
  );
});

test('the simulation stays finite and nobody ends up off the navmesh', () => {
  const sim = new Sim(STEPOVE, 99);
  sim.orderSquad(0, { x: 30, y: 84 }, MoveMode.Tactical, -Math.PI / 2);
  sim.orderSquad(1, { x: 86, y: 92 }, MoveMode.Sprint, null);
  sim.orderSquad(2, { x: 142, y: 80 }, MoveMode.Tactical, -Math.PI / 2);
  for (let i = 0; i < 60 * 90; i++) sim.update(1 / 60);

  for (const u of sim.unitList) {
    assert.ok(Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y), `${u.name} has a non-finite position`);
    assert.ok(Number.isFinite(u.facing), `${u.name} has a non-finite facing`);
    assert.ok(Number.isFinite(u.groundHeight), `${u.name} has a non-finite ground height`);
    assert.ok(u.suppression >= 0 && u.suppression <= 1, `${u.name} suppression out of range`);
    if (u.state !== UnitState.Dead) {
      assert.ok(
        sim.scene.walkable(u.pos.x, u.pos.y),
        `${u.name} ended up off the navmesh at (${u.pos.x.toFixed(1)},${u.pos.y.toFixed(1)})`,
      );
    }
  }
});

test('the same seed produces the same mission', () => {
  const play = (seed: number): string => {
    const sim = new Sim(STEPOVE, seed);
    sim.orderSquad(0, { x: 40, y: 96 }, MoveMode.Tactical, -Math.PI / 2);
    sim.orderSquad(1, { x: 86, y: 96 }, MoveMode.Tactical, -Math.PI / 2);
    for (let i = 0; i < 60 * 40; i++) sim.update(1 / 60);
    return sim.unitList
      .map((u) => `${u.id}:${u.pos.x.toFixed(4)},${u.pos.y.toFixed(4)},${u.hp.toFixed(2)}`)
      .join('|');
  };
  assert.equal(play(2024), play(2024));
  assert.notEqual(play(2024), play(2025));
});

test('the ditch is worth using', () => {
  // The whole reason for a heightfield: ground that is lower is cover.
  const scene = createScene(STEPOVE);
  const eye = { x: 78, y: 122, eye: Stature.standingEye };

  const inDitch = scene.sight(eye, { x: 78, y: 78, base: 0, top: Stature.crouchedTop });
  const beside = scene.sight(eye, { x: 78, y: 88, base: 0, top: Stature.crouchedTop });
  assert.ok(
    inDitch.exposure < beside.exposure,
    `crouching in the ditch should show less than crouching beside it: ` +
      `${inDitch.exposure.toFixed(2)} against ${beside.exposure.toFixed(2)}`,
  );
});
