import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dist, spline, vec } from '../src/sim/math.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { Stature } from '../src/sim/world/occlusion.ts';
import { SURFACE, Surface } from '../src/sim/world/terrain.ts';
import { building, rect, wall } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';
import { type LevelData, applyLevel } from '../src/sim/world/level-data.ts';
import { STEPOVE_DATA } from '../src/sim/levels.ts';
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
