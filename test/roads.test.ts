import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { vec } from '../src/sim/math.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { revetment } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';
import { Surface } from '../src/sim/world/terrain.ts';
import { RoadView } from '../src/render/roads.ts';

function laid(): Scene {
  const scene = new Scene(120, 80);
  scene.terrain.rolling(1.4, 30, 5);
  scene.terrain.road([vec(6, 20), vec(40, 34), vec(80, 28), vec(114, 46)], 7);
  scene.bake();
  return scene;
}

test('the ground remembers the roads laid on it, as the curve not the corners', () => {
  const scene = laid();
  assert.equal(scene.terrain.ribbons.length, 1);
  const [road] = scene.terrain.ribbons;
  assert.equal(road.width, 7);
  assert.equal(road.surface, Surface.Road);
  // Four control points in, far more than four out: what is kept is the
  // densified spline, so the drawn road and the carved road are the same curve
  // by construction rather than by two pieces of code agreeing about
  // Catmull-Rom.
  assert.ok(road.centre.length > 20, `${road.centre.length} points along it`);

  // And it is a curve. Corner-to-corner would put every point on one of three
  // straight lines; a spline bulges off them.
  const a = road.centre[0];
  const b = road.centre[road.centre.length - 1];
  let furthest = 0;
  for (const p of road.centre) {
    const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y))
      / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    furthest = Math.max(furthest,
      Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t)));
  }
  assert.ok(furthest > 4, `the road never leaves the straight line (${furthest.toFixed(1)}m)`);
});

test('the road ribbon faces upwards', () => {
  /**
   * The bug this exists for was invisible in every way a check usually looks.
   *
   * The mesh was in the scene, `visible` was true, the vertex count and index
   * count were both exactly right, the positions were finite and the bounding
   * sphere was sane — and it drew nothing at all, because every triangle was
   * wound the other way and back-face culling threw the lot away. Nothing short
   * of looking at the screen, or asking which way the faces point, catches it.
   */
  const view = new RoadView(laid());
  const geometry = view.mesh.geometry;
  const normal = geometry.getAttribute('normal');
  assert.ok(normal && normal.count > 0, 'it has normals at all');

  let up = 0;
  for (let i = 0; i < normal.count; i++) {
    if (normal.getY(i) > 0.5) up++;
  }
  assert.equal(up, normal.count, `${normal.count - up} of ${normal.count} vertices face down`);

  // And it is actually somewhere, rather than a heap of degenerate triangles.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  assert.ok(Number.isFinite(box.min.x) && box.max.x - box.min.x > 80, 'it spans the map');
  assert.ok(box.max.y - box.min.y < 12, 'and lies on the ground rather than standing up');
});

test('a crater in the road takes the road down with it', () => {
  // The ribbon is draped over ground that can change under it. If it did not
  // follow, a shell hole would leave the road bridging the gap in mid-air.
  const scene = laid();
  const view = new RoadView(scene);
  const before = (view.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).getY(40);
  scene.terrain.crater(scene.terrain.ribbons[0].centre[10], 6, 2);
  view.refresh();
  const after = (view.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).getY(40);
  assert.notEqual(before, after, 'the road did not move with the ground');
});

test('a revetment corners unless it is asked not to', () => {
  /**
   * The opposite default to everything else that follows a path, and
   * deliberately so. A road, a ditch, a bank and a hedge are made by wheels,
   * water and growth, none of which turns a corner. A revetment is built — a
   * compound wall, a sandbag emplacement — and those are straight runs meeting
   * at angles. Kolna's yard is a rectangle; sweeping it would make a racetrack.
   */
  const square = [vec(20, 20), vec(60, 20), vec(60, 60), vec(20, 60)];

  const plain = new Scene(90, 90);
  revetment(plain, square, Fabric.Sandbag, 1.05, 1.2);
  plain.bake();

  const swept = new Scene(90, 90);
  revetment(swept, square, Fabric.Sandbag, 1.05, 1.2, [], true);
  swept.bake();

  assert.equal(plain.structures.segments.length, 3, 'three runs between four corners');
  assert.ok(
    swept.structures.segments.length > 8,
    `a swept wall is many short runs, got ${swept.structures.segments.length}`,
  );

  /**
   * What sweeping actually does here is worth stating, because it is not what
   * "rounded corners" would suggest. Catmull-Rom runs *through* its control
   * points, so a swept wall still touches every corner exactly; what changes is
   * that the runs between them bow away from the straight line. On a
   * rectangular yard that means bowed walls rather than cut corners — which is
   * a second reason the default is off.
   */
  const bulge = (s: Scene): number => Math.max(...s.structures.segments.flatMap(
    (seg) => [seg.a, seg.b]
      .filter((p) => p.x > 21 && p.x < 59)
      .map((p) => Math.abs(p.y - 20))));
  assert.ok(bulge(plain) < 0.01, 'the plain wall runs dead straight between corners');
  assert.ok(bulge(swept) > 0.5, `the swept wall bows off the line (${bulge(swept).toFixed(2)}m)`);
});
