import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COLD_HARBOUR } from '../src/sim/levels.ts';
import { Tile, parseLevel } from '../src/sim/world.ts';
import { findPath } from '../src/sim/pathfind.ts';
import { hasLineOfSight } from '../src/sim/los.ts';
import { Sim, MissionState } from '../src/sim/sim.ts';
import { Faction, MoveMode, UnitState, WEAPONS, makeUnit } from '../src/sim/units.ts';
import { coverAgainst } from '../src/sim/combat.ts';

test('level rows are rectangular and the map is sealed', () => {
  const width = COLD_HARBOUR.rows[0].length;
  for (const [i, row] of COLD_HARBOUR.rows.entries()) {
    assert.equal(row.length, width, `row ${i} is ${row.length} wide, expected ${width}`);
  }

  const world = parseLevel(COLD_HARBOUR.rows);
  for (let y = 0; y < world.height; y++) {
    assert.ok(!world.walkable(0, y), `hole in west border at (0,${y})`);
    assert.ok(!world.walkable(world.width - 1, y), `hole in east border at (${world.width - 1},${y})`);
  }
  for (let x = 0; x < world.width; x++) {
    assert.ok(!world.walkable(x, 0), `hole in north border at (${x},0)`);
    assert.ok(!world.walkable(x, world.height - 1), `hole in south border at (${x},${world.height - 1})`);
  }
});

test('every walkable tile is reachable from every squad spawn', () => {
  // Regression: A* re-expanded stale heap entries until it hit its own budget,
  // so reachable cover came back unreachable and squads silently ignored orders.
  const world = parseLevel(COLD_HARBOUR.rows);
  const start = world.spawns.teams[0][0];

  let checked = 0;
  let failed = 0;
  for (let y = 1; y < world.height - 1; y += 2) {
    for (let x = 1; x < world.width - 1; x += 2) {
      if (!world.walkable(x, y)) continue;
      checked++;
      if (!findPath(world, start, { x: x + 0.5, y: y + 0.5 })) failed++;
    }
  }
  assert.ok(checked > 200, `expected a decent sample, got ${checked}`);
  assert.equal(failed, 0, `${failed} of ${checked} walkable tiles were unreachable`);
});

test('firing ports let sight through but not bodies', () => {
  const world = parseLevel(COLD_HARBOUR.rows);
  let ports = 0;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      if (world.at(x, y) !== Tile.Low) continue;
      ports++;
      assert.ok(!world.walkable(x, y), `low cover at (${x},${y}) should block movement`);
    }
  }
  assert.ok(ports > 0, 'level should contain low cover');

  // A guard at a port in the building's south wall can see into the courtyard.
  assert.ok(
    hasLineOfSight(world, { x: 27.5, y: 9.5 }, { x: 27.5, y: 20.5 }),
    'guard on the firing port should see down into the courtyard',
  );
});

test('cover is directional and leaning out costs you some of it', () => {
  const world = parseLevel(COLD_HARBOUR.rows);
  const node = world.coverNodes.find((n) => n.arcs.length === 1 && n.best > 0.7);
  assert.ok(node, 'expected a node with a single full-height arc');

  const unit = makeUnit({
    role: 'Rifleman',
    faction: Faction.Player,
    squadId: 0,
    pos: { ...node.pos },
    weapon: WEAPONS.carbine,
  });
  unit.claimedNode = node;
  unit.exposure = 0;

  const dir = node.arcs[0].dir;
  const protectedSide = { x: node.pos.x + dir.x * 8, y: node.pos.y + dir.y * 8 };
  const openSide = { x: node.pos.x - dir.x * 8, y: node.pos.y - dir.y * 8 };

  const front = coverAgainst(unit, protectedSide);
  const behind = coverAgainst(unit, openSide);
  assert.ok(front > 0.7, `cover from the protected side should be strong, got ${front}`);
  assert.equal(behind, 0, `cover from behind should be nothing, got ${behind}`);

  unit.exposure = 1;
  assert.ok(
    coverAgainst(unit, protectedSide) < front,
    'leaning out to shoot should give up some cover',
  );

  // Cover you are merely walking toward is not cover you have.
  unit.exposure = 0;
  unit.pos = { x: node.pos.x + 3, y: node.pos.y };
  assert.equal(coverAgainst(unit, protectedSide), 0);
});

test('two operators in cover still spot each other at range', () => {
  // Regression: signature used to cap detection RANGE, so both sides digging in
  // made each other invisible and the firefight quietly extinguished itself.
  const sim = new Sim(COLD_HARBOUR, 7);
  const player = sim.unitList.find((u) => u.faction === Faction.Player)!;
  const hostile = sim.unitList.find((u) => u.faction === Faction.Hostile)!;

  // Face each other down an open lane of the courtyard, 18 tiles apart.
  player.pos = { x: 10.5, y: 19.5 };
  player.facing = 0;
  hostile.pos = { x: 28.5, y: 19.5 };
  hostile.facing = Math.PI;
  assert.ok(hasLineOfSight(sim.world, player.pos, hostile.pos), 'test lane should be clear');

  const dt = 1 / 60;
  let acquiredAt = -1;
  for (let i = 0; i < 60 * 8 && acquiredAt < 0; i++) {
    sim.update(dt);
    if (player.visible.includes(hostile.id)) acquiredAt = sim.time;
  }

  assert.ok(acquiredAt >= 0, 'a clear 18-tile line should eventually produce a contact');
  assert.ok(
    acquiredAt < 4,
    `spotting a stationary enemy at 18 tiles took ${acquiredAt.toFixed(1)}s, which is too slow`,
  );
});

test('a squad order puts operators in cover facing the threat', () => {
  const sim = new Sim(COLD_HARBOUR, 11);
  const alpha = sim.squads[0];
  sim.orderSquad(alpha.id, { x: 12, y: 30 }, MoveMode.Tactical, -Math.PI / 2);

  const withCover = sim.membersOf(alpha).filter((u) => u.claimedNode !== null);
  assert.ok(withCover.length >= 2, `expected most of the team to claim cover, got ${withCover.length}`);

  // Nobody shares a position.
  const claimed = withCover.map((u) => u.claimedNode!.id);
  assert.equal(new Set(claimed).size, claimed.length, 'two operators claimed the same cover');
});

test('sprinting drops the weapon and costs stamina', () => {
  const sim = new Sim(COLD_HARBOUR, 3);
  const bravo = sim.squads[1];
  // Far enough that they are still running when we look.
  sim.orderSquad(bravo.id, { x: 30, y: 20 }, MoveMode.Sprint, null);

  const dt = 1 / 60;
  for (let i = 0; i < 60 * 1.5; i++) sim.update(dt);

  const movers = sim.membersOf(bravo).filter((u) => u.path.length > 0);
  assert.ok(movers.length > 0, 'expected the team to still be running');
  for (const u of movers) {
    assert.ok(u.weaponReady < 1, `${u.name} should have the muzzle down while sprinting`);
    assert.ok(u.stamina < 1, `${u.name} should be burning stamina`);
  }
});

test('the simulation stays finite and nobody ends up inside a wall', () => {
  const sim = new Sim(COLD_HARBOUR, 99);
  const dt = 1 / 60;
  sim.orderSquad(0, { x: 10, y: 20 }, MoveMode.Tactical, -Math.PI / 2);
  sim.orderSquad(1, { x: 30, y: 22 }, MoveMode.Sprint, null);
  sim.orderSquad(2, { x: 50, y: 20 }, MoveMode.Tactical, -Math.PI / 2);
  for (let i = 0; i < 60 * 90; i++) sim.update(dt);

  for (const u of sim.unitList) {
    assert.ok(Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y), `${u.name} has a non-finite position`);
    assert.ok(Number.isFinite(u.facing), `${u.name} has a non-finite facing`);
    assert.ok(u.suppression >= 0 && u.suppression <= 1, `${u.name} suppression out of range`);
    if (u.state !== UnitState.Dead) {
      assert.ok(
        sim.world.walkable(Math.floor(u.pos.x), Math.floor(u.pos.y)),
        `${u.name} ended up inside geometry at (${u.pos.x.toFixed(1)},${u.pos.y.toFixed(1)})`,
      );
    }
  }
});

test('the same seed produces the same mission', () => {
  const play = (seed: number) => {
    const sim = new Sim(COLD_HARBOUR, seed);
    sim.orderSquad(0, { x: 12, y: 29 }, MoveMode.Tactical, -Math.PI / 2);
    sim.orderSquad(1, { x: 30, y: 29 }, MoveMode.Tactical, -Math.PI / 2);
    for (let i = 0; i < 60 * 40; i++) sim.update(1 / 60);
    return sim.unitList.map((u) => `${u.id}:${u.pos.x.toFixed(4)},${u.pos.y.toFixed(4)},${u.hp.toFixed(2)}`).join('|');
  };
  assert.equal(play(2024), play(2024));
  assert.notEqual(play(2024), play(2025));
});
