import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Fabric, Solidity } from '../src/sim/world/geometry.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { Stature } from '../src/sim/world/occlusion.ts';

function wallScene(fabric: Fabric = Fabric.Brick, top = 2.8): { scene: Scene; id: number } {
  const scene = new Scene(60, 40);
  const id = scene.structures.addSegment({
    a: { x: 30, y: 6 }, b: { x: 30, y: 34 },
    thickness: 1, sill: 0, top,
    solidity: Solidity.Solid, fabric, buildingId: null,
  }).id;
  scene.bake();
  return { scene, id };
}

test('a wall comes apart in two stages, and the middle one is the interesting one', () => {
  const { scene, id } = wallScene();
  const segment = scene.structures.segments[id];

  assert.equal(segment.solidity, Solidity.Solid);
  assert.ok(segment.top > 2, 'it starts full height');

  // Stage one: it collapses into a low run you can see and shoot over, but
  // still cannot walk through.
  let rounds = 0;
  while (segment.solidity === Solidity.Solid && rounds < 4000) {
    scene.structures.damageSegment(id, 30);
    rounds++;
  }
  assert.ok(rounds < 4000, 'a wall should not be indestructible');
  assert.equal(segment.solidity, Solidity.LowCover, 'a wall collapses into rubble');
  assert.equal(segment.fabric, Fabric.Rubble);
  assert.ok(segment.top < 1, 'and rubble is low');
  assert.equal(segment.destroyed, false, 'rubble still stops a body');

  // Stage two: the rubble clears entirely.
  let more = 0;
  while (!segment.destroyed && more < 4000) {
    scene.structures.damageSegment(id, 30);
    more++;
  }
  assert.ok(segment.destroyed, 'rubble should clear away');
  assert.ok(more < rounds, 'and clearing it should be quicker than breaking the wall');
});

test('what a thing is made of decides how long it lasts', () => {
  const rounds = (fabric: Fabric): number => {
    const { scene, id } = wallScene(fabric);
    let n = 0;
    while (!scene.structures.segments[id].destroyed && n < 6000) {
      scene.structures.damageSegment(id, 30);
      n++;
    }
    return n;
  };

  const timber = rounds(Fabric.Timber);
  const brick = rounds(Fabric.Brick);
  const concrete = rounds(Fabric.Concrete);
  assert.ok(timber < brick, `timber (${timber}) should go before brick (${brick})`);
  assert.ok(brick < concrete, `brick (${brick}) should go before concrete (${concrete})`);
});

test('a round finds whatever is standing where it lands', () => {
  const { scene, id } = wallScene();
  const before = scene.structures.segments[id].hp;
  scene.hit(30, 20, 200);
  assert.ok(scene.structures.segments[id].hp < before, 'the wall took the hit');
  assert.ok(scene.dirtySegments.has(id), 'and the renderer was told');

  // Open ground absorbs nothing and reports nothing.
  scene.dirtySegments.clear();
  scene.hit(8, 20, 200);
  assert.equal(scene.dirtySegments.size, 0);
});

test('breaching a wall opens both the sightline and the route through it', () => {
  const scene = new Scene(60, 40);
  // A barrier across the middle with no way round: the map edges seal it.
  const id = scene.structures.addSegment({
    a: { x: 30, y: -2 }, b: { x: 30, y: 42 },
    thickness: 1.2, sill: 0, top: 3.0,
    solidity: Solidity.Solid, fabric: Fabric.Timber, buildingId: null,
  }).id;
  scene.bake();

  const eye = { x: 8, y: 20, eye: Stature.standingEye };
  const man = { x: 52, y: 20, base: 0, top: Stature.standingTop };
  assert.equal(scene.sight(eye, man).visible, false, 'the wall blocks the line');
  assert.equal(scene.findPath({ x: 8, y: 20 }, { x: 52, y: 20 }), null, 'and the route');

  // Take it down through the scene, which is the only path that keeps the
  // occlusion field and the navmesh in step. Damaging `structures` directly
  // changes the wall and tells nothing else about it.
  const segment = scene.structures.segments[id];
  let guard = 0;
  while (!segment.destroyed && guard++ < 4000) scene.hit(30, 20, 60);
  assert.ok(segment.destroyed, 'the wall should have come down');

  assert.ok(scene.sight(eye, man).visible, 'once it is down you can see through');
  assert.ok(scene.findPath({ x: 8, y: 20 }, { x: 52, y: 20 }), 'and walk through');
});

test('a crater reshapes the ground and the navigation over it', () => {
  const scene = new Scene(60, 40);
  scene.bake();
  const before = scene.heightAt(30, 20);
  const triangles = scene.navigation.mesh.triangleCount;

  scene.crater({ x: 30, y: 20 }, 5, 2.0);

  assert.ok(scene.heightAt(30, 20) < before - 1.8, 'the ground should be a hole now');
  assert.ok(scene.dirtyTerrain.length > 0, 'and the renderer should be told to redraw it');
  assert.ok(scene.navigation.mesh.triangleCount > 0, 'navigation should survive the reshaping');
  void triangles;

  // The hollow is worth standing in: less of you shows from across the field.
  const eye = { x: 8, y: 20, eye: Stature.standingEye };
  const inHole = scene.sight(eye, { x: 30, y: 20, base: 0, top: Stature.crouchedTop });
  const beside = scene.sight(eye, { x: 30, y: 28, base: 0, top: Stature.crouchedTop });
  assert.ok(
    inHole.exposure < beside.exposure,
    `a shell hole should be cover: ${inHole.exposure.toFixed(2)} in it, ${beside.exposure.toFixed(2)} beside it`,
  );
});
