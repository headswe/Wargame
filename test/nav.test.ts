import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Vec2 } from '../src/sim/math.ts';
import { Terrain } from '../src/sim/world/terrain.ts';
import { Fabric, Solidity, Structures } from '../src/sim/world/geometry.ts';
import type { WalkableField } from '../src/sim/nav/voxel.ts';
import { groupIntoPolygons, simplifyLoop, traceContours } from '../src/sim/nav/contour.ts';
import type { NavMesh } from '../src/sim/nav/navmesh.ts';
import { buildNavigation } from '../src/sim/nav/build.ts';

const WIDTH = 60;
const HEIGHT = 40;

interface Built {
  terrain: Terrain;
  structures: Structures;
  field: WalkableField;
  mesh: NavMesh;
}

function build(place: (s: Structures, t: Terrain) => void, cellSize = 0.25): Built {
  const terrain = new Terrain(WIDTH, HEIGHT, 0.5);
  const structures = new Structures(WIDTH, HEIGHT);
  place(structures, terrain);

  const { field, mesh } = buildNavigation(terrain, structures, { cellSize });
  return { terrain, structures, field, mesh };
}

function wall(s: Structures, a: Vec2, b: Vec2, fabric = Fabric.Concrete): number {
  return s.addSegment({
    a, b, thickness: 1, sill: 0, top: 2.4,
    solidity: Solidity.Solid, fabric, buildingId: null,
  }).id;
}

/** Sample along a path and confirm every step is on walkable ground. */
function pathStaysWalkable(path: Vec2[], field: WalkableField): { ok: boolean; at: Vec2 | null } {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (field.cellSize * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (!field.containsPoint(p.x, p.y)) return { ok: false, at: p };
    }
  }
  return { ok: true, at: null };
}

const length = (path: Vec2[], from: Vec2): number => {
  let total = 0;
  let prev = from;
  for (const p of path) {
    total += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return total;
};

test('terrain interpolates, and shaping actually moves the ground', () => {
  const terrain = new Terrain(40, 40, 0.5);
  assert.equal(terrain.heightAt(20, 20), 0, 'flat ground starts at zero');

  terrain.mound({ x: 20, y: 20 }, 10, 4);
  assert.ok(terrain.heightAt(20, 20) > 3.9, 'the peak of a mound should be its full height');
  assert.ok(terrain.heightAt(30.5, 20) < 0.01, 'and it should taper to nothing at its edge');
  assert.ok(terrain.slopeAt(25, 20) > 0.1, 'the flank of a mound should be sloped');

  // A ditch has to go DOWN — the whole point of a heightfield over props.
  terrain.cut([{ x: 0, y: 30 }, { x: 40, y: 30 }], 4, 1.5);
  assert.ok(terrain.heightAt(20, 30) < -1.4, 'a ditch floor should be below grade');
  assert.ok(terrain.heightAt(20, 34) > -0.1, 'and the ground beside it should not be');
});

test('a road follows the hill it crosses instead of levelling it', () => {
  const terrain = new Terrain(60, 40, 0.5);
  terrain.mound({ x: 30, y: 20 }, 20, 6);
  const crest = terrain.heightAt(30, 20);

  terrain.road([{ x: 0, y: 20 }, { x: 60, y: 20 }], 6);

  assert.ok(
    Math.abs(terrain.heightAt(30, 20) - crest) < 0.5,
    'the road should still ride over the crest',
  );
  // Flat across its width is the part that makes it a road.
  const across = [terrain.heightAt(30, 18), terrain.heightAt(30, 20), terrain.heightAt(30, 22)];
  assert.ok(
    Math.max(...across) - Math.min(...across) < 0.2,
    `the road surface should be level across its width, got ${across.map((h) => h.toFixed(2)).join(', ')}`,
  );
});

test('craters deform the ground and throw up a lip', () => {
  const terrain = new Terrain(40, 40, 0.5);
  terrain.crater({ x: 20, y: 20 }, 4, 1.6);
  assert.ok(terrain.heightAt(20, 20) < -1.5, 'the hole should be a hole');
  assert.ok(terrain.heightAt(24.5, 20) > 0.05, 'spoil should pile up around the rim');
});

test('voxelisation blocks what should block and lets bushes through', () => {
  const solid = build((s) => wall(s, { x: 30, y: 0 }, { x: 30, y: 40 }));
  assert.equal(solid.field.containsPoint(30, 20), false, 'a wall is not walkable');
  assert.equal(solid.field.containsPoint(10, 20), true, 'open ground is');

  // Erosion keeps an operator's centre clear of the wall by its own radius.
  assert.equal(
    solid.field.containsPoint(30.6, 20),
    false,
    'the walkable area should be pulled back from the wall by the agent radius',
  );

  const bushes = build((s) => {
    s.addProp({
      pos: { x: 30, y: 20 }, radius: 3, sill: 0, top: 1.6,
      solidity: Solidity.Concealment, fabric: Fabric.Hedge,
    });
  });
  assert.equal(
    bushes.field.containsPoint(30, 20),
    true,
    'concealment hides you; it does not stop you walking into it',
  );
});

test('contours come out with outer rings positive and holes negative', () => {
  const { field } = build((s) => {
    const corners: Vec2[] = [
      { x: 20, y: 14 }, { x: 34, y: 14 }, { x: 34, y: 26 }, { x: 20, y: 26 },
    ];
    for (let i = 0; i < 4; i++) wall(s, corners[i], corners[(i + 1) % 4]);
  });

  const loops = traceContours(field.walkable, field.cols, field.rows, field.cellSize);
  const outer = loops.filter((l) => l.signedArea > 0.5);
  const holes = loops.filter((l) => l.signedArea < -0.5);

  assert.ok(outer.length >= 1, 'expected an outer ring for the open ground');
  assert.ok(holes.length >= 1, 'the sealed compound should read as a hole');

  const polygons = groupIntoPolygons(loops.map((l) => ({ ...l, points: simplifyLoop(l.points, 0.2) })));
  assert.ok(polygons.length >= 1);
  assert.ok(polygons[0].holes.length >= 1, 'the hole should be attached to the ring containing it');
});

test('paths route round obstacles and never leave the walkable surface', () => {
  // A wall across the middle with one gap in it.
  const { mesh, field } = build((s) => {
    wall(s, { x: 30, y: 0 }, { x: 30, y: 16 });
    wall(s, { x: 30, y: 24 }, { x: 30, y: 40 });
  });

  // Both ends north of the gap, so the straight line runs into solid wall and
  // the route genuinely has to divert. Picking (8,8) to (52,32) instead would
  // send the direct line through the gap at y=20 and prove nothing.
  const from = { x: 8, y: 8 };
  const to = { x: 52, y: 8 };
  const path = mesh.findPath(from, to);
  assert.ok(path, 'a route through the gap should exist');

  const check = pathStaysWalkable([from, ...path!], field);
  assert.ok(check.ok, `path left the walkable surface at ${JSON.stringify(check.at)}`);

  // It has to detour through the gap, so it is longer than the straight line —
  // but a funnelled path should not be wildly longer.
  const direct = Math.hypot(to.x - from.x, to.y - from.y);
  const walked = length(path!, from);
  assert.ok(walked > direct, 'the detour should cost something');
  assert.ok(
    walked < direct * 1.5,
    `the funnel should pull the path taut, got ${walked.toFixed(1)} m against ${direct.toFixed(1)} m direct`,
  );
});

test('open ground gives a straight line, not a staircase', () => {
  const { mesh } = build(() => {});
  const from = { x: 6, y: 6 };
  const to = { x: 54, y: 34 };
  const path = mesh.findPath(from, to);
  assert.ok(path, 'empty ground should always be traversable');

  const direct = Math.hypot(to.x - from.x, to.y - from.y);
  const walked = length(path!, from);
  assert.ok(
    walked < direct * 1.02,
    `across open ground the path should be essentially straight, got ${walked.toFixed(1)} m against ${direct.toFixed(1)} m`,
  );
});

test('a sealed enclosure is genuinely unreachable', () => {
  const { mesh } = build((s) => {
    const corners: Vec2[] = [
      { x: 24, y: 16 }, { x: 36, y: 16 }, { x: 36, y: 26 }, { x: 24, y: 26 },
    ];
    for (let i = 0; i < 4; i++) wall(s, corners[i], corners[(i + 1) % 4]);
  });
  assert.equal(mesh.findPath({ x: 6, y: 6 }, { x: 30, y: 21 }), null);
});
