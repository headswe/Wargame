import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dist, spline, vec } from '../src/sim/math.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { Stature } from '../src/sim/world/occlusion.ts';
import { SURFACE, SURFACE_KEEP, Surface } from '../src/sim/world/terrain.ts';
import { building, rect, wall } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';
import {
  type LevelData, LEVEL_FORMAT, applyLevel, createScene, defineLevel, migrate,
  packRuns, unpackRuns, validateLevel,
} from '../src/sim/world/level-data.ts';
import { sightFan } from '../src/sim/world/analysis.ts';
import { audit } from '../src/sim/world/audit.ts';
import { LEVEL_DATA, STEPOVE_DATA } from '../src/sim/levels.ts';
import { Faction, MoveMode, WEAPONS, makeUnit, resetUnitIds, speedOf } from '../src/sim/units.ts';

test('a curve goes through the points it was given and does not corner', () => {
  const control = [vec(0, 0), vec(40, 0), vec(40, 40)];
  const curve = spline(control, 1);

  for (const p of control) {
    const nearest = curve.reduce((best, q) => Math.min(best, dist(p, q)), Infinity);
    assert.ok(nearest < 1e-6, `the curve missed its own control point ${p.x},${p.y}`);
  }

  // The failure this guards against is the reason splines are here at all: a
  // polyline turns the whole ninety degrees between two samples, and that kink
  // gets carved into the heightfield as a crease visible from across the map.
  let sharpest = 0;
  for (let i = 1; i + 1 < curve.length; i++) {
    const a = Math.atan2(curve[i].y - curve[i - 1].y, curve[i].x - curve[i - 1].x);
    const b = Math.atan2(curve[i + 1].y - curve[i].y, curve[i + 1].x - curve[i].x);
    let turn = Math.abs(b - a);
    if (turn > Math.PI) turn = Math.PI * 2 - turn;
    if (turn > sharpest) sharpest = turn;
  }
  assert.ok(sharpest < 0.35, `it still turns ${(sharpest * 57).toFixed(0)}° in one step`);
});

/** A wall across the middle of an empty field, with whatever holes are asked for. */
function pierced(openings: Parameters<typeof wall>[1]['openings']): Scene {
  const scene = new Scene(100, 100);
  wall(scene, {
    a: vec(20, 50), b: vec(80, 50),
    fabric: Fabric.Brick, top: 3.1, thickness: 0.8,
    openings,
  });
  scene.bake();
  return scene;
}

const eye = (x: number, y: number) => ({ x, y, eye: Stature.standingEye });
const man = (x: number, y: number) => ({ x, y, base: 0, top: Stature.standingTop });

test('a window is something you shoot through and cannot walk through', () => {
  const solid = pierced([]);
  const windowed = pierced([{ at: 'centre', width: 1.6, kind: 'window' }]);

  assert.equal(solid.sight(eye(50, 42), man(50, 58)).visible, false, 'a wall is a wall');
  const through = windowed.sight(eye(50, 42), man(50, 58));
  assert.ok(through.visible, 'but you can see through a window');
  assert.ok(
    through.exposure < 0.95,
    `and the sill should still hide his legs — exposure ${through.exposure.toFixed(2)}`,
  );

  // The sill is what stops it being a hole in the wall.
  assert.equal(windowed.walkable(50, 50), false, 'nobody climbs through it');
});

test('a door is a doorway, and you walk under the wall above it', () => {
  const doored = pierced([{ at: 'centre', width: 2.0, kind: 'door' }]);
  assert.ok(doored.walkable(50, 50), 'a doorway has to be a way in');
  assert.ok(
    doored.findPath(vec(50, 40), vec(50, 60)) !== null,
    'and the navmesh has to agree, or the building is sealed',
  );
  // The lintel is genuinely there: solid wall, just above head height.
  assert.ok(
    doored.sight(eye(50, 42), man(50, 58)).visible,
    'while still being something you can see and shoot through',
  );
});

test('a thin wall still has doors you can walk through', () => {
  // The trap this guards against. Both grids widen the thinnest geometry to a
  // cell's half-diagonal so a fence cannot vanish between two samples, which
  // means the ends of a wall bulge into the gap beside them by a fixed amount
  // no matter how thin the wall is. Cut a doorway by the wall's own thickness
  // and a thin wall's doors seal — the building looks perfectly normal, has a
  // door drawn in it, and cannot be entered.
  for (const thickness of [0.2, 0.35, 0.8]) {
    const scene = new Scene(100, 100);
    wall(scene, {
      a: vec(20, 50), b: vec(80, 50), top: 2.7, thickness,
      openings: [{ at: 'centre', width: 1.1, kind: 'door' }],
    });
    scene.bake();
    assert.ok(
      scene.findPath(vec(50, 40), vec(50, 60)) !== null,
      `a ${thickness}m wall sealed its own doorway`,
    );
  }
});

test('a lintel caps what you can see through the gap under it', () => {
  // Level ground makes a lintel inert: every sightline between two men on the
  // same plane passes under it. It starts mattering the moment anything is
  // above anything else — a man on an upper floor, a shooter on a roof, a
  // position on a bank — which is exactly what an opening has to get right and
  // a slot cut to the roof cannot.
  const upstairs = (x: number, y: number) =>
    ({ x, y, base: 3, top: 3 + Stature.standingTop });

  const band = pierced([{ at: 'centre', width: 1.8, kind: 'window' }]);
  // The same window with nothing above it: the old model, where an opening ran
  // from its sill straight up to the roofline.
  const slot = pierced([{ at: 'centre', width: 1.8, kind: 'window', head: 99 }]);

  const seenThroughSlot = slot.sight(eye(50, 40), upstairs(50, 60));
  const seenThroughBand = band.sight(eye(50, 40), upstairs(50, 60));

  assert.ok(seenThroughSlot.visible, 'a slot to the roof shows him standing above you');
  assert.equal(
    seenThroughBand.visible, false,
    `there is a wall above that window: exposure ${seenThroughBand.exposure.toFixed(2)}`,
  );

  // And it is only the man upstairs who is hidden by it.
  assert.ok(band.sight(eye(50, 40), man(50, 60)).visible, 'the one at ground level is not');
});

test('a building is a polygon with rooms in it', () => {
  const scene = new Scene(100, 100);
  building(scene, {
    footprint: rect(vec(50, 50), 20, 12, 0),
    wallTop: 3.0,
    openings: [{ side: 2, at: 5, width: 2.0, kind: 'door' }],
    partitions: [
      { a: vec(50, 44), b: vec(50, 56), openings: [{ at: 'centre', width: 1.4, kind: 'door' }] },
    ],
  });
  scene.bake();

  assert.equal(scene.structures.buildings.length, 1);
  const inside = scene.structures.buildings[0];
  assert.ok(
    inside.segmentIds.every((id) => scene.structures.segments[id].buildingId === inside.id),
    'the partitions belong to the building, not to the map',
  );

  // Two rooms, one doorway between them, and a way in from outside.
  assert.ok(scene.findPath(vec(55, 62), vec(56, 50)) !== null, 'in through the front door');
  assert.ok(scene.findPath(vec(56, 50), vec(44, 50)) !== null, 'and on into the far room');
  // And the partition is a wall, not a curtain.
  assert.equal(
    scene.sight(eye(44, 47), man(56, 47)).visible, false,
    'you cannot see through an interior wall',
  );
});

test('a heightmap lands on the heights it was given, without creases', () => {
  const scene = new Scene(80, 80);
  const cols = 5;
  const rows = 5;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) heights.push(((i * 7 + j * 13) % 5) * 1.2);
  }
  scene.terrain.heightmap({ cols, rows, heights });

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i / (cols - 1)) * scene.terrain.width;
      const y = (j / (rows - 1)) * scene.terrain.height;
      assert.ok(
        Math.abs(scene.heightAt(x, y) - heights[j * cols + i]) < 0.1,
        `control point ${i},${j} came out at ${scene.heightAt(x, y).toFixed(2)}`,
      );
    }
  }

  // Straight bilinear is continuous but its slope is not, so every control line
  // shows up as a visible fold. Walking across three of them should not find a
  // step change in gradient.
  let worst = 0;
  let previous = scene.terrain.slopeAt(2, 40);
  for (let x = 2; x < 78; x += 0.5) {
    const slope = scene.terrain.slopeAt(x, 40);
    worst = Math.max(worst, Math.abs(slope - previous));
    previous = slope;
  }
  assert.ok(worst < 0.05, `gradient jumped by ${worst.toFixed(3)} crossing a control line`);
});

test('what is underfoot changes how fast you cross it', () => {
  resetUnitIds();
  const u = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(0, 0), weapon: WEAPONS.carbine,
  });
  u.moveMode = MoveMode.Sprint;

  const road = speedOf(u, SURFACE[Surface.Road].footing);
  const crop = speedOf(u, SURFACE[Surface.Crop].footing);
  const mud = speedOf(u, SURFACE[Surface.Mud].footing);

  assert.ok(road > crop, 'the road is the quick way and the exposed one');
  assert.ok(mud < crop * 0.9, `the bottom of a ditch should cost you: ${mud.toFixed(2)} m/s`);
});

test('a level is data, and survives being written down and read back', () => {
  // The whole point of the format. If a level only works as the object literal
  // it was typed as, nothing can generate one, save one, or edit one.
  const copy = JSON.parse(JSON.stringify(STEPOVE_DATA)) as LevelData;

  const direct = new Scene(STEPOVE_DATA.size.width, STEPOVE_DATA.size.height);
  applyLevel(direct, STEPOVE_DATA);
  direct.bake();

  const roundTripped = new Scene(copy.size.width, copy.size.height);
  applyLevel(roundTripped, copy);
  roundTripped.bake();

  assert.equal(
    roundTripped.structures.segments.length, direct.structures.segments.length,
    'same walls',
  );
  assert.equal(roundTripped.structures.props.length, direct.structures.props.length, 'same bushes');

  let sampled = 0;
  for (let y = 5; y < 130; y += 7) {
    for (let x = 5; x < 170; x += 7) {
      assert.ok(Math.abs(roundTripped.heightAt(x, y) - direct.heightAt(x, y)) < 1e-6);
      assert.equal(roundTripped.walkable(x, y), direct.walkable(x, y), `walkable at ${x},${y}`);
      sampled++;
    }
  }
  assert.ok(sampled > 300, 'and enough of it to mean something');
});

test('a level that asks for something that does not exist says so', () => {
  const scene = new Scene(40, 40);
  const broken = {
    ...STEPOVE_DATA,
    id: 'broken',
    terrain: [{ op: 'erode', strength: 3 }],
    structures: [],
  } as unknown as LevelData;

  // Skipping it quietly is the worst option: the level loads, the ditch is
  // missing, and the mission is subtly unwinnable for reasons nothing reports.
  assert.throws(() => applyLevel(scene, broken), /unknown terrain op erode/);
});

test('painted ground survives being run-length encoded', () => {
  const cols = 40;
  const rows = 30;
  const cells = new Uint8Array(cols * rows).fill(SURFACE_KEEP);
  for (let j = 8; j < 20; j++) {
    for (let i = 5; i < 30; i++) cells[j * cols + i] = Surface.Mud;
  }
  const runs = packRuns(cells);
  const back = unpackRuns(runs, cols * rows);

  assert.deepEqual([...back], [...cells], 'it came back different');
  // The point of the encoding: a mostly-untouched map must not cost a file.
  assert.ok(
    runs.length < cells.length / 20,
    `${runs.length} numbers to describe ${cells.length} cells`,
  );
});

test('a brushed surface only changes what it was brushed onto', () => {
  const scene = new Scene(60, 60);
  scene.terrain.paint(vec(0, 0), vec(60, 60), Surface.Grass);

  const cols = 21;
  const rows = 21;
  const cells = new Uint8Array(cols * rows).fill(SURFACE_KEEP);
  // A patch over the middle, in grid coordinates.
  for (let j = 8; j <= 12; j++) {
    for (let i = 8; i <= 12; i++) cells[j * cols + i] = Surface.Mud;
  }
  scene.terrain.surfacemap({ cols, rows, cells });

  assert.equal(scene.terrain.surfaceAt(30, 30), Surface.Mud, 'the middle should be mud');
  assert.equal(scene.terrain.surfaceAt(3, 3), Surface.Grass, 'the corner should be untouched');
});

test('a level file from an older build still opens', () => {
  // No version, no ids: exactly what the first data levels were written as.
  const old = {
    id: 'old', name: 'Old', brief: '',
    size: { width: 60, height: 60 },
    terrain: [{ op: 'rolling', amplitude: 1, wavelength: 20 }],
    structures: [{ op: 'obstacle', at: { x: 30, y: 30 }, radius: 2 }],
    spawns: { teams: [[{ x: 10, y: 50 }]], enemies: [], objectives: [{ x: 30, y: 10 }] },
  };
  const level = migrate(JSON.parse(JSON.stringify(old)));

  assert.equal(level.version, LEVEL_FORMAT);
  assert.ok(level.terrain[0].id, 'every operation should come out with a handle on it');
  assert.ok(level.structures[0].id);
  assert.notEqual(level.terrain[0].id, level.structures[0].id, 'and they must differ');

  // And a file from the future is refused rather than half-read.
  assert.throws(
    () => migrate({ ...old, version: LEVEL_FORMAT + 5 }),
    /newer build/,
  );
});

test('a level is checked over rather than thrown out', () => {
  const broken: LevelData = {
    version: LEVEL_FORMAT,
    id: 'broken', name: 'Broken', brief: '',
    size: { width: 60, height: 60 },
    terrain: [{ op: 'cut', path: [vec(10, 10)], width: 4, depth: 1 }],
    structures: [
      { op: 'building', rect: { at: vec(30, 30), width: 10, depth: 8 },
        openings: [{ side: 9, at: 'centre', width: 1.2, kind: 'door' }] },
    ],
    spawns: { teams: [], enemies: [], objectives: [] },
  };
  const problems = validateLevel(broken);

  // Every one of them, not whichever was found first: an author fixing a level
  // needs the list, and an editor has to be able to show work in progress.
  const messages = problems.map((p) => p.message).join(' | ');
  assert.ok(problems.length >= 4, `only found ${problems.length}: ${messages}`);
  assert.ok(/at least 2 points/.test(messages), 'the one-point ditch');
  assert.ok(/does not exist/.test(messages), 'the door on a wall that is not there');
  assert.ok(/at least one team/.test(messages), 'nobody starts here');
  assert.ok(/no objective/.test(messages), 'nothing to take');
  assert.ok(problems.every((p) => p.where && p.severity), 'every problem says where and how bad');
});

test('every level the game ships is one you can actually play', () => {
  // The gate that matters. A level is code now, and a broken one looks
  // completely normal in the viewport right up until nobody can reach the
  // objective, a defender is standing inside a wall, or a house has a door
  // drawn on it that the navmesh disagrees with.
  for (const raw of LEVEL_DATA) {
    const data = migrate(structuredClone(raw));
    const def = defineLevel(data);
    const scene = createScene(def);
    const problems = [...validateLevel(data), ...audit(scene, data)];
    const errors = problems.filter((p) => p.severity === 'error');

    // Shipped content is held to no problems at all rather than no errors.
    // "A defender is standing inside something solid" is a warning because an
    // editor must not block on work in progress; it is not something to ship.
    assert.equal(
      problems.length, 0,
      `${def.name}: ${problems.map((p) => `${p.severity}: ${p.message}`).join('; ')}`,
    );
    assert.equal(errors.length, 0);
    assert.ok(data.spawns.teams.flat().length >= 4, `${def.name} has nobody to play as`);
    assert.ok(data.spawns.enemies.length >= 3, `${def.name} has nobody defending it`);

    // And every defender can see something, or he is scenery with a rifle.
    const blind = data.spawns.enemies.filter((e) => sightFan(scene, e.pos, 90, 48).reach < 3);
    assert.ok(
      blind.length === 0,
      `${def.name}: ${blind.length} defenders are sited where they can see nothing`,
    );
  }
});
