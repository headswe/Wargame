import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { STEPOVE } from '../src/sim/levels.ts';
import { Sim } from '../src/sim/sim.ts';
import { FogOfWar } from '../src/render/fog.ts';
import { RoofView } from '../src/render/roofs.ts';

test('the fog patch goes on a material once, however many times it is asked', () => {
  /**
   * This one cost an afternoon, so it is worth stating exactly.
   *
   * The patch declares `varying vec3 vFogWorld`. Applied twice it declares it
   * twice, the shader fails to compile, and three draws nothing — while still
   * drawing the object into the shadow map, because that pass uses a different
   * shader entirely. The symptom is a mesh that is present, visible, correctly
   * positioned, at full opacity, with sane bounds, casting a shadow onto ground
   * where the mesh itself cannot be seen. Nothing throws. It only happens in
   * the game, because the level editor has no fog of war, so it survives every
   * check run against the editor.
   *
   * It happened because two places took responsibility: each view patched its
   * own materials, and WorldView then traversed the whole group and patched
   * everything it found. Only one of them does it now, and this makes the other
   * arrangement harmless if anybody reintroduces it.
   */
  const sim = new Sim(STEPOVE, 1);
  const fog = new FogOfWar(sim);
  const material = new THREE.MeshLambertMaterial();

  fog.applyTo(material);
  fog.applyTo(material);
  fog.applyTo(material);

  // Run whatever the patch installed against a stand-in for three's shader,
  // which is all `onBeforeCompile` ever sees.
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <dithering_fragment>\n}',
  };
  material.onBeforeCompile(shader as never, null as never);

  const declarations = shader.vertexShader.split('varying vec3 vFogWorld;').length - 1;
  assert.equal(declarations, 1, `vFogWorld declared ${declarations} times`);
  assert.ok(shader.fragmentShader.includes('fogMap'), 'and the fragment half went on');
});

test('every building gets a roof, and it faces the sky', () => {
  // The same failure mode as the road ribbon: geometry that is present and
  // correct in every respect a probe usually checks, and wound the wrong way.
  const sim = new Sim(STEPOVE, 1);
  const view = new RoofView(sim.scene);
  assert.equal(
    view.group.children.length,
    sim.scene.structures.buildings.length,
    'one roof per building',
  );

  /**
   * On average, not everywhere. A parapet round a flat roof is a vertical band
   * and its normals point sideways by design, so demanding every vertex face
   * the sky fails on a correct roof. Averaging still catches the thing worth
   * catching: a roof wound the wrong way reads about -0.95 here, and a right
   * one about +0.95.
   */
  for (const mesh of view.group.children as THREE.Mesh[]) {
    const normal = mesh.geometry.getAttribute('normal');
    let sum = 0;
    for (let i = 0; i < normal.count; i++) sum += normal.getY(i);
    const mean = sum / normal.count;
    assert.ok(mean > 0.3, `a roof facing into the ground (mean normal.y ${mean.toFixed(2)})`);
  }
});

test('a roof lifts for your own men and for nothing else', () => {
  const sim = new Sim(STEPOVE, 1);
  const view = new RoofView(sim.scene);
  const roof = view.group.children[0] as THREE.Mesh;
  const material = roof.material as THREE.MeshLambertMaterial;
  const inside = sim.scene.structures.buildings[0].footprint.reduce(
    (a, p, _i, all) => ({ x: a.x + p.x / all.length, y: a.y + p.y / all.length }),
    { x: 0, y: 0 },
  );

  // Nobody near it: it stays on, however long you wait.
  for (let t = 0; t < 40; t++) view.update([], 1 / 30);
  assert.equal(material.opacity, 1, 'an empty building keeps its roof');

  // Somebody of yours inside: it comes off.
  for (let t = 0; t < 60; t++) view.update([inside], 1 / 30);
  assert.ok(material.opacity < 0.3, `still ${material.opacity.toFixed(2)} opaque`);

  // And back on once he leaves.
  for (let t = 0; t < 120; t++) view.update([{ x: -200, y: -200 }], 1 / 30);
  assert.ok(material.opacity > 0.9, `stuck at ${material.opacity.toFixed(2)}`);
});
