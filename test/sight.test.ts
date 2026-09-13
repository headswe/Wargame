import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Terrain } from '../src/sim/world/terrain.ts';
import { Fabric, Solidity, Structures } from '../src/sim/world/geometry.ts';
import {
  OcclusionField, Stature, sightline, silhouetteTop,
} from '../src/sim/world/occlusion.ts';

const W = 120;
const H = 40;

function bench(shape: (t: Terrain, s: Structures) => void) {
  const terrain = new Terrain(W, H, 0.5);
  const structures = new Structures(W, H);
  shape(terrain, structures);
  const field = new OcclusionField(W, H, 0.5);
  field.build(terrain, structures);
  return { terrain, structures, field };
}

const standing = (x: number, y: number) => ({ x, y, base: 0, top: Stature.standingTop });
const crouching = (x: number, y: number) => ({ x, y, base: 0, top: Stature.crouchedTop });
const eyes = (x: number, y: number, eye = Stature.standingEye) => ({ x, y, eye });

function wallAcross(s: Structures, x: number, top: number, thickness = 0.8): void {
  s.addSegment({
    a: { x, y: 0 }, b: { x, y: H },
    thickness, sill: 0, top,
    solidity: top > 1.2 ? Solidity.Solid : Solidity.LowCover,
    fabric: Fabric.Brick, buildingId: null,
  });
}

test('open ground hides nobody', () => {
  const { terrain, field } = bench(() => {});
  const s = sightline(terrain, field, eyes(10, 20), standing(90, 20));
  assert.ok(s.visible);
  assert.equal(s.exposure, 1, 'nothing between two people on a flat field');
  assert.equal(s.concealment, 0);
});

test('a full-height wall blocks entirely', () => {
  const { terrain, field } = bench((_, s) => wallAcross(s, 50, 3.2));
  const s = sightline(terrain, field, eyes(10, 20), standing(90, 20));
  assert.equal(s.visible, false);
  assert.equal(s.exposure, 0);
});

test('cover works better the closer you hug it, and crouching pays', () => {
  const { terrain, field } = bench((_, s) => wallAcross(s, 88, 1.0));

  const stood = sightline(terrain, field, eyes(10, 20), standing(90, 20));
  const crouched = sightline(terrain, field, eyes(10, 20), crouching(90, 20));

  assert.ok(stood.exposure > 0.2 && stood.exposure < 0.7,
    `standing behind a low wall should be partly exposed, got ${stood.exposure.toFixed(2)}`);
  assert.ok(crouched.exposure < stood.exposure * 0.6,
    `crouching should cut exposure sharply: ${crouched.exposure.toFixed(2)} vs ${stood.exposure.toFixed(2)}`);

  // The same wall far from the target protects much less — cover you are not
  // actually behind is barely cover at all.
  const far = bench((_, s) => wallAcross(s, 50, 1.0));
  const distant = sightline(far.terrain, far.field, eyes(10, 20), standing(90, 20));
  assert.ok(distant.exposure > stood.exposure,
    `a wall halfway there should protect less than one at your elbow: ${distant.exposure.toFixed(2)} vs ${stood.exposure.toFixed(2)}`);
});

test('a crest makes dead ground behind it, and height sees over', () => {
  // A ridge across the middle, with the far side dropping away.
  const { terrain, field } = bench((t) => {
    t.bank([{ x: 60, y: 0 }, { x: 60, y: H }], 14, 3.4);
  });

  const fromFlat = sightline(terrain, field, eyes(20, 20), standing(90, 20));
  assert.equal(fromFlat.visible, false, 'the far side of a ridge is dead ground');

  // Stand on the ridge itself and the same man is in plain view.
  const fromCrest = sightline(terrain, field, eyes(60, 20), standing(90, 20));
  assert.ok(fromCrest.visible, 'from the crest there is nothing in the way');
  assert.ok(fromCrest.exposure > 0.9, `and he should be fully in the open, got ${fromCrest.exposure.toFixed(2)}`);
});

test('a ditch is defilade: standing you show a little, crouching you vanish', () => {
  const { terrain, field } = bench((t) => {
    t.cut([{ x: 88, y: 0 }, { x: 88, y: H }], 6, 1.6);
  });

  assert.ok(terrain.heightAt(88, 20) < -1.5, 'the ditch should actually be a hole');

  const stood = sightline(terrain, field, eyes(10, 20), standing(88, 20));
  const crouched = sightline(terrain, field, eyes(10, 20), crouching(88, 20));

  assert.ok(stood.visible, 'a standing man in a ditch still shows his head');
  assert.ok(stood.exposure < 0.45,
    `but not much of him: ${stood.exposure.toFixed(2)}`);
  assert.equal(crouched.visible, false, 'crouched below the lip he is gone');

  // From the lip itself he has nowhere to hide.
  const atTheLip = sightline(terrain, field, eyes(83, 20), standing(88, 20));
  assert.ok(atTheLip.exposure > 0.8,
    `from the edge of the ditch he is in the open, got ${atTheLip.exposure.toFixed(2)}`);
});

test('bushes conceal without protecting', () => {
  const { terrain, field } = bench((_, s) => {
    for (let k = 0; k < 8; k++) {
      s.addProp({
        pos: { x: 46 + k * 1.6, y: 20 }, radius: 1.6, sill: 0, top: 1.9,
        solidity: Solidity.Concealment, fabric: Fabric.Hedge,
      });
    }
  });

  const s = sightline(terrain, field, eyes(10, 20), standing(90, 20));
  assert.equal(s.exposure, 1, 'vegetation stops nothing — exposure is untouched');
  assert.ok(s.concealment > 0.15,
    `but it should register as concealment, got ${s.concealment.toFixed(2)}`);
});

test('shooting from high ground sees over cover that would stop you on the level', () => {
  const { terrain, field } = bench((t, s) => {
    wallAcross(s, 60, 2.2);
    t.mound({ x: 16, y: 20 }, 14, 6);
  });

  const fromLevel = sightline(terrain, field, eyes(34, 20), standing(90, 20));
  assert.equal(fromLevel.visible, false, 'on the flat the wall stops you');

  const fromHill = sightline(terrain, field, eyes(16, 20), standing(90, 20));
  assert.ok(fromHill.visible, 'from the knoll you can see past it');
});

test('knocking a wall down opens the line through it', () => {
  const terrain = new Terrain(W, H, 0.5);
  const structures = new Structures(W, H);
  const segment = structures.addSegment({
    a: { x: 50, y: 0 }, b: { x: 50, y: H },
    thickness: 0.8, sill: 0, top: 3.0,
    solidity: Solidity.Solid, fabric: Fabric.Timber, buildingId: null,
  });
  const field = new OcclusionField(W, H, 0.5);
  field.build(terrain, structures);

  assert.equal(sightline(terrain, field, eyes(10, 20), standing(90, 20)).visible, false);

  // Timber. It does not last.
  for (let i = 0; i < 200; i++) structures.damageSegment(segment.id, 40);
  field.rebuild(terrain, structures, 44, 0, 56, H);

  const after = sightline(terrain, field, eyes(10, 20), standing(90, 20));
  assert.ok(after.visible, 'once it is down you can see through where it was');
  assert.ok(silhouetteTop(false, false) > silhouetteTop(true, false));
});
