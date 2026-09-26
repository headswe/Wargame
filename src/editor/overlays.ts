import * as THREE from 'three';
import type { Scene as SimScene } from '../sim/world/scene.ts';
import { SAMPLE_STEP, type GroundStats, sampleGround, sightFan } from '../sim/world/analysis.ts';
import type { LevelData } from '../sim/world/level-data.ts';
import type { Vec2 } from '../sim/math.ts';

export type OverlayMode = 'none' | 'walkable' | 'fire' | 'cover';

/**
 * What the simulation knows about a level, painted onto it.
 *
 * This is the reason to build an editor at all. Placing a wall accurately is
 * not hard and does not need a tool; knowing whether the wall you placed made
 * the ground in front of it a killing zone, left a flank nobody can cover, or
 * quietly sealed a courtyard — that is the job, and nothing about a
 * three-dimensional view of some boxes tells you any of it.
 *
 * Every layer here is computed with the same code the game uses, not an
 * approximation of it. An overlay that disagrees with the simulation is worse
 * than no overlay, because it is believed.
 */

const STEP = SAMPLE_STEP;

export type OverlayStats = GroundStats;

export class Overlays {
  readonly mesh: THREE.Mesh;
  stats: OverlayStats | null = null;

  private mode: OverlayMode = 'none';
  private cols = 0;
  private rows = 0;
  private walkable: Uint8Array = new Uint8Array();
  private seenBy: Uint8Array = new Uint8Array();
  private exposure: Float32Array = new Float32Array();

  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setMode(mode: OverlayMode, scene: SimScene, data: LevelData): void {
    this.mode = mode;
    this.mesh.visible = mode !== 'none';
    if (mode === 'none') {
      this.stats = null;
      return;
    }
    this.sample(scene, data);
    this.paint(scene);
  }

  /** Recompute for a level that has changed under an overlay already showing. */
  refresh(scene: SimScene, data: LevelData): void {
    if (this.mode !== 'none') this.setMode(this.mode, scene, data);
  }

  private sample(scene: SimScene, data: LevelData): void {
    // The walkable layer paints walkability and nothing else, and it keeps no
    // stats, so it has no use for the sightline sweep — which is nearly all of
    // the cost and was being paid again after every edit.
    const defenders = this.mode === 'walkable' ? [] : data.spawns.enemies.map((e) => e.pos);
    const ground = sampleGround(scene, defenders);
    this.cols = ground.cols;
    this.rows = ground.rows;
    this.walkable = ground.walkable;
    this.seenBy = ground.seenBy;
    this.exposure = ground.exposure;
    this.stats = this.mode === 'walkable' ? null : ground.stats;
  }

  private paint(scene: SimScene): void {
    const position: number[] = [];
    const colour: number[] = [];
    const c = new THREE.Color();

    for (let j = 0; j + 1 < this.rows; j++) {
      for (let i = 0; i + 1 < this.cols; i++) {
        const k = j * this.cols + i;
        const tint = this.tintFor(k, c);
        if (!tint) continue;
        const x0 = i * STEP;
        const y0 = j * STEP;
        const x1 = x0 + STEP;
        const y1 = y0 + STEP;
        const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        const [a, b, cc, d] = corners.map(([x, y]) =>
          [x, scene.heightAt(x, y) + 0.12, y] as [number, number, number]);
        for (const v of [a, b, cc, a, cc, d]) {
          position.push(v[0], v[1], v[2]);
          colour.push(c.r, c.g, c.b);
        }
      }
    }

    this.mesh.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colour, 3));
    this.mesh.geometry = geometry;
  }

  /** The colour for one cell, or null to leave the ground showing through. */
  private tintFor(k: number, out: THREE.Color): boolean {
    if (this.mode === 'walkable') {
      if (this.walkable[k]) return false;
      out.setHex(0xd45f4a);
      return true;
    }
    if (!this.walkable[k]) return false;

    if (this.mode === 'fire') {
      const n = this.seenBy[k];
      if (n === 0) {
        // Ground nobody covers. Worth seeing as plainly as the killing zones,
        // because an uncontested approach is the commonest way a level breaks.
        out.setHex(0x2f6d8a);
        return true;
      }
      // One rifle bearing on you is a problem; three is a decision made for you.
      out.setHSL(THREE.MathUtils.lerp(0.14, 0.0, Math.min(1, (n - 1) / 3)), 0.85, 0.5);
      return true;
    }

    // Cover: how much of a standing man shows to whoever can see him at all.
    const e = this.exposure[k];
    if (this.seenBy[k] === 0) return false;
    out.setHSL(THREE.MathUtils.lerp(0.33, 0.0, e), 0.75, 0.45);
    return true;
  }
}

/**
 * What one man standing on one spot can actually see.
 *
 * The question a designer asks continually and cannot answer by looking: put a
 * gun here and what does it hold? A fan drawn from the simulation's own
 * sightlines answers it in a way no amount of rotating the camera does, and it
 * is how you find out that the wall you were proud of also blinds the position
 * behind it.
 */
export class SightProbe {
  readonly mesh: THREE.Mesh;
  at: Vec2 | null = null;
  /** Metres of ground the position holds, as a fraction of the circle it could. */
  reach = 0;

  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xffe9a8, transparent: true, opacity: 0.22,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  clear(): void {
    this.at = null;
    this.mesh.visible = false;
  }

  /** Cast the fan from `at`, out to `range` metres. */
  cast(scene: SimScene, at: Vec2, range = 140): void {
    this.at = at;
    const fan = sightFan(scene, at, range);
    this.reach = fan.reach;
    const edge = fan.edge;

    const position: number[] = [];
    const lift = 0.16;
    for (let i = 0; i < edge.length; i++) {
      const a = edge[i];
      const b = edge[(i + 1) % edge.length];
      position.push(at.x, scene.heightAt(at.x, at.y) + lift, at.y);
      position.push(a.x, scene.heightAt(a.x, a.y) + lift, a.y);
      position.push(b.x, scene.heightAt(b.x, b.y) + lift, b.y);
    }

    this.mesh.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    this.mesh.geometry = geometry;
    this.mesh.visible = true;
  }
}
