import * as THREE from 'three';
import { Surface } from '../sim/world/terrain.ts';
import { ground, type GroundLayer } from './textures.ts';

/**
 * Where each surface sits on the ground ramp, from vegetated at 0 to metalled
 * at 1. The shader blends three photographed grounds along it — grass, bare
 * soil, broken asphalt — so a surface is a position on that ramp rather than a
 * texture of its own.
 *
 * Soil sits in the middle so every pair of surfaces that meets blends through
 * it. That is not a compromise: the strip where a paddock meets a concrete
 * apron really is worn bare, and getting it for nothing is why the ramp is
 * ordered this way rather than alphabetically or by enum value.
 *
 * `SURFACE_COLOUR` still does the work of telling one surface from another.
 * The ramp only decides what the ground is made of; a crop stays yellower than
 * grass because that table says so, not because it is further along.
 */
export const GROUND_RAMP: Record<number, number> = {
  [Surface.Grass]: 0,
  [Surface.Crop]: 0.14,
  [Surface.Mud]: 0.44,
  [Surface.Dirt]: 0.54,
  [Surface.Road]: 0.68,
  [Surface.Gravel]: 0.84,
  [Surface.Concrete]: 1,
};

/**
 * A white pixel, so the shader has something to sample before the maps land —
 * and forever, if they never do. See the bargain at the top of `textures.ts`.
 */
const BLANK = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
BLANK.needsUpdate = true;

/** How much of the photographed variation reaches the screen, at full strength. */
const GRAIN = 0.85;

/**
 * Put real ground under the vertex colours.
 *
 * The terrain is one mesh carrying every surface on the map, so this cannot be
 * a material per surface: the blend has to happen per fragment. Each vertex
 * carries where it sits on `GROUND_RAMP` and how much grain to admit, and the
 * fragment mixes three tiling grounds along that ramp.
 *
 * Each tile is divided by its own average colour before it is used, which is
 * the whole trick. What multiplies the surface is then a field of values around
 * one — the grain, the clumps, the scuffed patches — and not the colour of
 * whatever field somebody happened to photograph. The palette stays the
 * authored one and the texture only says how the ground is broken up. Multiply
 * the raw albedo in instead and every surface takes on the photograph's cast:
 * grass goes to the green of that lawn in that light, and the tint the level
 * author chose stops meaning anything.
 *
 * Installed before the fog patch, which composes onto whatever it finds. The
 * other way round loses the fog and only in the game, never in the editor.
 */
export function grainOnGround(material: THREE.MeshLambertMaterial): void {
  const uniforms = {
    groundA: { value: BLANK as THREE.Texture },
    groundB: { value: BLANK as THREE.Texture },
    groundC: { value: BLANK as THREE.Texture },
    groundMean: { value: [
      new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1),
    ] },
    groundTile: { value: new THREE.Vector3(1, 1, 1) },
    groundGrain: { value: 0 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 aGround;
         varying vec2 vGround;
         varying vec2 vGroundXz;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vGround = aGround;
         // Planar, in metres, off the world position rather than a uv set, so
         // the tiling does not move when a crater reshapes the ground under it.
         vGroundXz = position.xz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D groundA;
         uniform sampler2D groundB;
         uniform sampler2D groundC;
         uniform vec3 groundMean[3];
         uniform vec3 groundTile;
         uniform float groundGrain;
         varying vec2 vGround;
         varying vec2 vGroundXz;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec3 grainA = texture2D(groundA, vGroundXz / groundTile.x).rgb / groundMean[0];
         vec3 grainB = texture2D(groundB, vGroundXz / groundTile.y).rgb / groundMean[1];
         vec3 grainC = texture2D(groundC, vGroundXz / groundTile.z).rgb / groundMean[2];
         float ramp = clamp(vGround.x, 0.0, 1.0);
         vec3 grain = mix(
           mix(grainA, grainB, smoothstep(0.0, 0.5, ramp)),
           grainC,
           smoothstep(0.5, 1.0, ramp)
         );
         diffuseColor.rgb *= mix(vec3(1.0), grain, groundGrain * vGround.y);`,
      );
  };
  material.needsUpdate = true;

  ground(['grass', 'earth', 'stone'], (layers: GroundLayer[]) => {
    const [a, b, c] = layers;
    uniforms.groundA.value = a.map;
    uniforms.groundB.value = b.map;
    uniforms.groundC.value = c.map;
    layers.forEach((layer, at) => uniforms.groundMean.value[at].fromArray(layer.mean));
    uniforms.groundTile.value.set(a.metres, b.metres, c.metres);
    uniforms.groundGrain.value = GRAIN;
  });
}
