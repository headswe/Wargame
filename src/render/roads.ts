import * as THREE from 'three';

import type { Scene as SimScene } from '../sim/world/scene.ts';
import { Surface } from '../sim/world/terrain.ts';
import { GROUND_RAMP, grainOnGround } from './ground.ts';

/**
 * Roads, drawn as the curve they were always described by.
 *
 * A road is a spline in the level file and a spline in the heightfield, and it
 * was neither on screen: painting it into the surface grid means the ground
 * mesh interpolates between a road sample and a grass sample a metre apart, so
 * what the player saw was a blurred grey smear with no edge anywhere on it. A
 * road is mostly edge. It is the one thing in a village that is deliberately
 * made, and the contrast between a made edge and the ragged ones around it is
 * what tells you a place is inhabited.
 *
 * So: a ribbon laid over the ground, following the same densified centreline
 * the carve used, with a verge either side. It sits a few centimetres proud of
 * the terrain because the terrain it is lying on is the terrain it flattened,
 * and two surfaces at exactly the same height fight for the depth buffer.
 */

const LIFT = 0.045;
/** How far the shoulder runs out past the carriageway, in metres. */
const VERGE = 1.1;

const COLOUR: Record<number, { road: number; verge: number }> = {
  [Surface.Road]: { road: 0x45403a, verge: 0x6b6254 },
  [Surface.Gravel]: { road: 0x6f6a61, verge: 0x7a7265 },
  [Surface.Concrete]: { road: 0x79756e, verge: 0x6e6659 },
  [Surface.Dirt]: { road: 0x6d6456, verge: 0x776f60 },
};

export class RoadView {
  readonly mesh: THREE.Mesh;
  private readonly scene: SimScene;
  private readonly positions: THREE.BufferAttribute;
  /** Where along the centreline each vertex sits, so heights can be resampled. */
  private readonly samples: { x: number; y: number }[] = [];

  constructor(scene: SimScene) {
    this.scene = scene;

    const position: number[] = [];
    const colour: number[] = [];
    // Where each vertex sits on the ground ramp, and how much grain to admit.
    // A road is ground: it wants the same photographed surface the terrain has,
    // or it is the one dead-flat thing left in the frame — which is what it was.
    const made: number[] = [];
    const index: number[] = [];
    const tint = new THREE.Color();

    for (const ribbon of scene.terrain.ribbons) {
      const { centre, width } = ribbon;
      if (centre.length < 2) continue;
      const half = width / 2;
      const palette = COLOUR[ribbon.surface] ?? COLOUR[Surface.Road];
      const metalled = GROUND_RAMP[ribbon.surface] ?? GROUND_RAMP[Surface.Road];
      const base = index.length === 0 ? 0 : position.length / 3;
      let row = base;

      for (let i = 0; i < centre.length; i++) {
        // The direction of travel here: the average of the segments either
        // side, so the ribbon does not kink at every sample.
        const before = centre[Math.max(0, i - 1)];
        const after = centre[Math.min(centre.length - 1, i + 1)];
        let nx = -(after.y - before.y);
        let ny = after.x - before.x;
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;

        // Four vertices across: outer verge, carriageway, carriageway, outer
        // verge. The verge is what gives the edge somewhere to end.
        const across = [-(half + VERGE), -half, half, half + VERGE];
        for (let k = 0; k < across.length; k++) {
          const d = across[k];
          const x = centre[i].x + nx * d;
          const y = centre[i].y + ny * d;
          this.samples.push({ x, y });
          position.push(x, this.scene.heightAt(x, y) + LIFT, y);
          const edge = k === 0 || k === 3;
          tint.set(edge ? palette.verge : palette.road);
          // A little wear along the wheel tracks and a little dirt at the kerb,
          // so a long straight does not read as a printed strip.
          const wear = edge ? 0.94 : 1 + Math.sin(i * 0.7) * 0.035;
          tint.multiplyScalar(wear);
          colour.push(tint.r, tint.g, tint.b);
          // The verge is half made ground and half the field it runs through,
          // which is the whole point of having one.
          made.push(edge ? (metalled + GROUND_RAMP[Surface.Dirt]) / 2 : metalled, 1);
        }

        if (i > 0) {
          const prev = row - 4;
          // Wound so the faces look up. The first version had them the other
          // way: the ribbon was in the scene, marked visible, with the right
          // vertex count and valid bounds, and drew nothing at all, because
          // every triangle was back-facing and culled.
          for (let k = 0; k < 3; k++) {
            index.push(prev + k, prev + k + 1, row + k);
            index.push(prev + k + 1, row + k + 1, row + k);
          }
        }
        row += 4;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colour, 3));
    geometry.setAttribute('aGround', new THREE.Float32BufferAttribute(made, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    this.positions = geometry.getAttribute('position') as THREE.BufferAttribute;

    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    // Before `WorldView` hands the group to the fog, which composes onto
    // whatever it finds and would be lost if this were installed after it.
    grainOnGround(material);
    // Polygon offset as well as the lift: at a shallow enough camera angle a
    // few centimetres is not enough, and z-fighting on a road reads as the
    // ground flickering.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -4;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'roads';
  }

  /** Re-drape over ground that has changed under it — a crater in the road. */
  refresh(): void {
    const array = this.positions.array as Float32Array;
    for (let v = 0; v < this.samples.length; v++) {
      const s = this.samples[v];
      array[v * 3 + 1] = this.scene.heightAt(s.x, s.y) + LIFT;
    }
    this.positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}
