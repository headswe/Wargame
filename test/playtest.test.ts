import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec } from '../src/sim/math.ts';
import { STEPOVE, createScene } from '../src/sim/levels.ts';
import { Sim } from '../src/sim/sim.ts';
import { MoveMode } from '../src/sim/units.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { Terrain } from '../src/sim/world/terrain.ts';
import { Fabric, Solidity, Structures } from '../src/sim/world/geometry.ts';
import { building, rect } from '../src/sim/world/builder.ts';
import { Stature } from '../src/sim/world/occlusion.ts';
import { buildNavigation } from '../src/sim/nav/build.ts';

/**
 * Three faults found in play, each of which had a structural cause rather than
 * a local one. The tests are written against the cause, not the symptom.
 */

test('a team can get into the ditch, not just look at it', () => {
  const scene = createScene(STEPOVE);

  // The drainage ditch runs west to east across the middle of the map. Every
  // part of it has to be reachable from the ground beside it, or it is not a
  // trench, it is a fence.
  for (const [x, y] of [[40, 82], [78, 79], [120, 76]] as const) {
    assert.ok(scene.walkable(x, y), `ditch floor at (${x},${y}) should be standable`);
    const approach = { x, y: y + 9 };
    assert.ok(scene.walkable(approach.x, approach.y), `ground beside the ditch at (${x},${y})`);
    const path = scene.findPath(approach, { x, y });
    assert.ok(path, `no way down into the ditch at (${x},${y}) — the banks are sealing it`);
  }

  // And along it, which is the whole reason to be in one.
  assert.ok(scene.findPath(vec(30, 83), vec(130, 75.5)), 'the ditch should run as a covered lane');
});

test('a steep bank is crossed but a steep hill is not', () => {
  const terrain = new Terrain(80, 40, 0.5);
  const structures = new Structures(80, 40);

  // A ditch across the middle, and a long climb up the eastern half.
  terrain.cut([vec(0, 20), vec(80, 20)], 6, 1.6);
  terrain.mound(vec(70, 20), 26, 14);

  const { field } = buildNavigation(terrain, structures);
  const cellsAcross = (x: number) => {
    let n = 0;
    for (let y = 12; y <= 28; y += 0.25) if (field.containsPoint(x, y)) n++;
    return n;
  };

  assert.ok(cellsAcross(20) > 60, 'the ditch should be crossable where the ground is otherwise flat');
  // The mound is a long steep climb, not a narrow band, so the scramble rule
  // must decline to pave it.
  let blocked = 0;
  for (let y = 4; y <= 36; y += 0.25) if (!field.containsPoint(70, y)) blocked++;
  assert.ok(blocked > 20, 'a steep hillside should still stop a man');
});

test('a sealed building is sealed from every direction and range', () => {
  const scene = new Scene(120, 120);
  building(scene, { footprint: rect(vec(60, 60), 14, 10, 0.37), openings: [] });
  scene.bake();

  // Deliberately awkward: an odd angle, so lines cross the walls at every
  // obliquity, including the near-tangential ones that a fixed sampling stride
  // steps straight over.
  let leaks = 0;
  for (let a = 0; a < 2880; a++) {
    const angle = (a / 2880) * Math.PI * 2;
    for (const d of [12, 20, 35, 55]) {
      const x = 60 + Math.cos(angle) * d;
      const y = 60 + Math.sin(angle) * d;
      if (x < 1 || y < 1 || x > 119 || y > 119) continue;
      const s = scene.sight(
        { x, y, eye: Stature.standingEye },
        { x: 60, y: 60, base: 0, top: Stature.standingTop },
      );
      if (s.visible) leaks++;
    }
  }
  assert.equal(leaks, 0, 'a shot into a closed building got through');
});

test('a thin wall is opaque even when the line barely clips it', () => {
  // The wall runs past both ends of every line tested, so anything that gets
  // through went through it rather than round it.
  const scene = new Scene(60, 90);
  scene.structures.addSegment({
    a: vec(30, 0), b: vec(30, 90), thickness: 0.4, sill: 0, top: 3,
    solidity: Solidity.Solid, fabric: Fabric.Brick, buildingId: null,
  });
  scene.bake();
  assert.ok(
    scene.occlusion.solidAt(30, 40) > 2,
    'a wall thinner than a cell vanished from the occlusion field entirely',
  );

  let leaks = 0;
  let tested = 0;
  for (let y = 5; y < 55; y += 0.13) {
    // Shallow crossings: the line spends only centimetres inside the wall.
    for (const dy of [18, 24, 30]) {
      tested++;
      const s = scene.sight(
        { x: 10, y, eye: Stature.standingEye },
        { x: 50, y: y + dy, base: 0, top: Stature.standingTop },
      );
      if (s.visible) leaks++;
    }
  }
  assert.ok(tested > 900);
  assert.equal(leaks, 0, 'oblique lines are getting through a wall thinner than a cell');
});

test('an order posts the team on the ground the player pointed at', () => {
  const sim = new Sim(STEPOVE, 4242);
  const squad = sim.playerSquads[0];
  const dest = vec(85, 108);

  const slots = sim.previewOrder([squad.id], dest, MoveMode.Tactical, null);
  assert.ok(slots.length >= 4, 'every active operator needs a slot');

  const ranges = slots.map((s) => Math.hypot(s.pos.x - dest.x, s.pos.y - dest.y));
  assert.ok(Math.min(...ranges) < 1.0, 'somebody should end up where the player clicked');
  assert.ok(Math.max(...ranges) < 9.5, 'nobody should wander outside the search radius');
});

test('cover scoring discriminates instead of tying everything at zero', () => {
  const sim = new Sim(STEPOVE, 4242);
  const threat = sim.scene.spawns.enemies[0].pos;

  // The failure this guards against is subtle: measuring against one imaginary
  // rifleman put him inside a building often enough that every candidate came
  // back perfectly hidden and unable to shoot, which made the ranking
  // meaningless and the order arbitrary.
  let degenerate = 0;
  let sampled = 0;
  for (let x = 20; x <= 150; x += 10) {
    for (let y = 70; y <= 115; y += 15) {
      if (!sim.scene.walkable(x, y)) continue;
      sampled++;
      const spots = sim.scene.findCover(vec(x, y), 9, threat, { samples: 40 });
      if (spots.length < 8) continue;
      const allHidden = spots.every((s) => s.exposure === 0);
      const noneCanFire = spots.every((s) => !s.canFire);
      if (allHidden && noneCanFire) degenerate++;
    }
  }
  assert.ok(sampled > 20, 'the sweep should actually cover ground');
  assert.ok(
    degenerate <= sampled * 0.1,
    `${degenerate} of ${sampled} order points scored every candidate identically`,
  );
});

test('a firing position beats a hole with no field of fire', () => {
  const sim = new Sim(STEPOVE, 4242);
  const threat = sim.scene.spawns.enemies[0].pos;

  for (let x = 30; x <= 140; x += 10) {
    const around = vec(x, 95);
    if (!sim.scene.walkable(around.x, around.y)) continue;
    const spots = sim.scene.findCover(around, 9, threat, { samples: 40 });
    const best = spots[0];
    if (!best) continue;
    const firing = spots.find((s) => s.canFire);
    if (!firing || best.canFire) continue;
    // The only way a blind spot may win is by being that much better cover.
    assert.ok(
      firing.exposure - best.exposure > 0.3,
      `at (${x},95) a blind position won on ${best.exposure.toFixed(2)} against a firing one on ${firing.exposure.toFixed(2)}`,
    );
  }
});
