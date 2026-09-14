import * as THREE from 'three';
import type { Scene as SimScene } from '../sim/world/scene.ts';
import { Stature } from '../sim/world/occlusion.ts';
import type { LevelData } from '../sim/world/level-data.ts';

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

/** Metres between samples. Two is fine: cover does not change faster than a man. */
const STEP = 2;

export interface OverlayStats {
  /** Share of walkable ground at least one defender can see. */
  covered: number;
  /** Share nobody can see: the approaches a level gives away for free. */
  dead: number;
  /** Mean number of defenders bearing on a piece of open ground. */
  weight: number;
  samples: number;
  millis: number;
}

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
    const began = performance.now();
    this.cols = Math.floor(scene.width / STEP) + 1;
    this.rows = Math.floor(scene.height / STEP) + 1;
    const count = this.cols * this.rows;
    this.walkable = new Uint8Array(count);
    this.seenBy = new Uint8Array(count);
    this.exposure = new Float32Array(count);

    const defenders = data.spawns.enemies.map((e) => e.pos);
    let walkableCount = 0;
    let coveredCount = 0;
    let weightTotal = 0;

    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        const x = i * STEP;
        const y = j * STEP;
        const ok = scene.walkable(x, y);
        this.walkable[k] = ok ? 1 : 0;
        if (!ok || this.mode === 'walkable') continue;

        walkableCount++;
        let seen = 0;
        let worst = 0;
        for (const d of defenders) {
          if (Math.hypot(d.x - x, d.y - y) > 260) continue;
          const view = scene.sight(
            { x: d.x, y: d.y, eye: Stature.crouchedEye },
            { x, y, base: 0, top: Stature.standingTop },
          );
          if (!view.visible) continue;
          seen++;
          if (view.exposure > worst) worst = view.exposure;
        }
        this.seenBy[k] = Math.min(255, seen);
        this.exposure[k] = worst;
        if (seen > 0) coveredCount++;
        weightTotal += seen;
      }
    }

    this.stats = this.mode === 'walkable' ? null : {
      covered: walkableCount === 0 ? 0 : coveredCount / walkableCount,
      dead: walkableCount === 0 ? 0 : 1 - coveredCount / walkableCount,
      weight: walkableCount === 0 ? 0 : weightTotal / walkableCount,
      samples: walkableCount,
      millis: performance.now() - began,
    };
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
