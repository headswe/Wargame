import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { IsoCamera } from '../src/render/camera.ts';

/** The camera eases toward its target; run it out until it has arrived. */
function settle(iso: IsoCamera): void {
  for (let i = 0; i < 240; i++) iso.update(1 / 60);
}

/**
 * The camera's own axes, flattened onto the ground — what "right" and "up the
 * screen" actually mean for the player at this rotation. Asserting against
 * these rather than against hardcoded vectors is what makes the check hold at
 * every yaw instead of only the one the bug was noticed at.
 */
function screenBasis(iso: IsoCamera): { right: THREE.Vector3; forward: THREE.Vector3 } {
  iso.camera.updateMatrixWorld(true);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  iso.camera.matrixWorld.extractBasis(right, up, back);
  return {
    right: right.setY(0).normalize(),
    // A camera looks down its local -Z.
    forward: back.negate().setY(0).normalize(),
  };
}

test('panning moves the view the way the input says, at every rotation', () => {
  // Regression: screen-right was computed as (forward.z, 0, -forward.x), which
  // is the negation of cross(forward, up) — so it was screen-LEFT, and A and D
  // were swapped. Not just at the default yaw: the basis was wrong at all of
  // them, and it also left middle-drag grabbing vertically but pushing
  // horizontally.
  for (let steps = 0; steps < 8; steps++) {
    const iso = new IsoCamera();
    iso.resize(1600, 900);
    iso.rotate(steps);
    settle(iso);

    const { right, forward } = screenBasis(iso);

    const beforeRight = iso.focus.clone();
    iso.panScreen(1, 0);
    settle(iso);
    const movedRight = iso.focus.clone().sub(beforeRight);
    assert.ok(
      movedRight.dot(right) > 0.9,
      `panScreen(+x) should carry the view to screen-right at yaw step ${steps}, ` +
        `got dot ${movedRight.dot(right).toFixed(3)}`,
    );

    const beforeForward = iso.focus.clone();
    iso.panScreen(0, 1);
    settle(iso);
    const movedForward = iso.focus.clone().sub(beforeForward);
    assert.ok(
      movedForward.dot(forward) > 0.9,
      `panScreen(+y) should carry the view up the screen at yaw step ${steps}, ` +
        `got dot ${movedForward.dot(forward).toFixed(3)}`,
    );
  }
});
