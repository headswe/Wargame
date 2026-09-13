import * as THREE from 'three';
import type { Sim } from '../sim/sim.ts';
import { FRAG_RADIUS, Ordnance, positionOf } from '../sim/ordnance.ts';

const MAX_IN_FLIGHT = 24;
const MAX_BLASTS = 12;
/** Blobs per cloud. Enough that it reads as smoke, few enough to be free. */
const BLOBS = 9;
const MAX_CLOUDS = 24;
const BLAST_LIFE = 0.55;

interface Blast {
  x: number;
  y: number;
  height: number;
  radius: number;
  age: number;
}

/**
 * Thrown ordnance, made legible.
 *
 * A grenade the player cannot see coming is a random death, and a grenade the
 * defender cannot see landing is not the mechanic it is supposed to be — the
 * whole value of the second it spends fizzing on the ground is that both sides
 * get to react to it. So the arc is drawn in full, the thing on the ground
 * blinks, and the blast is unmistakable.
 */
export class OrdnanceView {
  readonly group = new THREE.Group();

  private readonly grenades: THREE.InstancedMesh;
  private readonly blasts: THREE.InstancedMesh;
  private readonly clouds: THREE.InstancedMesh;
  private readonly danger: THREE.InstancedMesh;
  private readonly live: Blast[] = [];

  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();
  private readonly hot = new THREE.Color(0xffd08a);
  private readonly cool = new THREE.Color(0x6e6a63);

  constructor() {
    this.group.name = 'ordnance';

    this.grenades = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.17, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xf2e6c8 }),
      MAX_IN_FLIGHT,
    );
    this.grenades.frustumCulled = false;
    this.grenades.count = 0;
    this.grenades.renderOrder = 30;
    this.group.add(this.grenades);

    this.blasts = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false }),
      MAX_BLASTS,
    );
    this.blasts.frustumCulled = false;
    this.blasts.count = 0;
    this.blasts.renderOrder = 31;
    this.group.add(this.blasts);

    // Smoke writes no depth and is drawn late, so it layers with itself
    // instead of punching holes in the cloud next to it.
    this.clouds = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xb9b6ae, transparent: true, opacity: 0.26, depthWrite: false,
      }),
      MAX_CLOUDS * BLOBS,
    );
    this.clouds.frustumCulled = false;
    this.clouds.count = 0;
    this.clouds.renderOrder = 35;
    this.group.add(this.clouds);

    // The ground a live frag is about to take away. The defending AI already
    // runs out of exactly this circle, so drawing it is not a hint — it is the
    // same information both sides are acting on, which is the only fair way to
    // run a weapon that gives the target a second to decide.
    const ring = new THREE.RingGeometry(0.9, 1, 40);
    ring.rotateX(-Math.PI / 2);
    this.danger = new THREE.InstancedMesh(
      ring,
      new THREE.MeshBasicMaterial({
        color: 0xff5c5c, transparent: true, opacity: 0.85,
        depthWrite: false, depthTest: false,
      }),
      MAX_IN_FLIGHT,
    );
    this.danger.frustumCulled = false;
    this.danger.count = 0;
    this.danger.renderOrder = 36;
    this.group.add(this.danger);
  }

  /** A frag going off, taken from the simulation's effect list. */
  addBlast(x: number, y: number, height: number, radius: number): void {
    if (this.live.length >= MAX_BLASTS) this.live.shift();
    this.live.push({ x, y, height, radius, age: 0 });
  }

  update(sim: Sim, dt: number, time: number): void {
    this.drawInFlight(sim, time);
    this.drawBlasts(dt);
    this.drawClouds(sim, time);
  }

  private drawInFlight(sim: Sim, time: number): void {
    let count = 0;
    let rings = 0;
    for (const o of sim.live) {
      if (count >= MAX_IN_FLIGHT) break;
      const p = positionOf(o);
      if (!sim.isVisible(p.x, p.y)) continue;

      if (o.landed && o.kind === Ordnance.Frag) {
        // Tightens as the fuse runs down, so the urgency is readable without
        // reading a number.
        const closing = 1 - Math.max(0, Math.min(1, o.fuse / 1.15));
        const r = FRAG_RADIUS * (1.25 - 0.25 * closing) * (1 + 0.03 * Math.sin(time * 18));
        this.matrix.makeScale(r, 1, r);
        this.matrix.setPosition(o.to.x, sim.scene.heightAt(o.to.x, o.to.y) + 0.12, o.to.y);
        this.danger.setMatrixAt(rings++, this.matrix);
      }
      // On the ground and cooking: a hard blink, because the only thing that
      // matters now is that everybody nearby notices it.
      const blink = o.landed ? 0.6 + 0.4 * Math.sign(Math.sin(time * 26)) : 1;
      const scale = o.landed ? 2.2 * blink : 1.1;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(p.x, p.height, p.y);
      this.grenades.setMatrixAt(count, this.matrix);
      this.colour
        .copy(o.kind === Ordnance.Frag ? this.hot : this.cool)
        .multiplyScalar(o.landed ? blink : 0.85);
      this.grenades.setColorAt(count, this.colour);
      count++;
    }
    this.grenades.count = count;
    this.grenades.instanceMatrix.needsUpdate = true;
    if (this.grenades.instanceColor) this.grenades.instanceColor.needsUpdate = true;
    this.danger.count = rings;
    this.danger.instanceMatrix.needsUpdate = true;
  }

  private drawBlasts(dt: number): void {
    let count = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.age += dt;
      if (b.age >= BLAST_LIFE) {
        this.live.splice(i, 1);
        continue;
      }
      const t = b.age / BLAST_LIFE;
      // Fast out, then hangs: the shape of the thing you actually see.
      const r = b.radius * (0.25 + 0.75 * Math.sqrt(t));
      this.matrix.makeScale(r, r * 0.7, r);
      this.matrix.setPosition(b.x, b.height + r * 0.35, b.y);
      this.blasts.setMatrixAt(count, this.matrix);
      this.colour.copy(this.hot).lerp(this.cool, t).multiplyScalar(1 - t * 0.7);
      this.blasts.setColorAt(count, this.colour);
      count++;
    }
    this.blasts.count = count;
    this.blasts.instanceMatrix.needsUpdate = true;
    if (this.blasts.instanceColor) this.blasts.instanceColor.needsUpdate = true;
  }

  private drawClouds(sim: Sim, time: number): void {
    let count = 0;
    let cloud = 0;
    for (const puff of sim.scene.smoke.clouds) {
      if (cloud++ >= MAX_CLOUDS) break;
      // Same curves the field uses, so what the player sees is the extent of
      // what actually conceals. A cloud drawn larger than it screens is a lie
      // the player will only discover by losing someone to it.
      const grown = Math.min(1, puff.age / 6.4);
      const radius = puff.radius * (0.25 + 0.75 * Math.sqrt(grown));
      const opacity = puff.age < 4
        ? puff.age / 4
        : puff.age < puff.life ? 1 : Math.max(0, 1 - (puff.age - puff.life) / 6);
      if (opacity <= 0.02) continue;
      // Per-instance alpha would need a custom shader; brightness against a
      // dark field does the same job for what this has to communicate.
      this.colour.setScalar(0.45 + 0.55 * opacity);

      for (let b = 0; b < BLOBS; b++) {
        if (count >= MAX_CLOUDS * BLOBS) break;
        const a = (b / BLOBS) * Math.PI * 2 + puff.pos.x * 0.7;
        const ring = b === 0 ? 0 : radius * (b % 2 === 0 ? 0.62 : 0.36);
        const roll = time * 0.12 + b;
        const blob = radius * (b === 0 ? 0.62 : 0.44) * (0.85 + 0.15 * Math.sin(roll));
        this.matrix.makeScale(blob, blob * 0.78, blob);
        this.matrix.setPosition(
          puff.pos.x + Math.cos(a + roll * 0.3) * ring,
          puff.ground + puff.height * (b === 0 ? 0.42 : 0.3 + 0.18 * Math.sin(roll * 1.7 + b)),
          puff.pos.y + Math.sin(a + roll * 0.3) * ring,
        );
        this.clouds.setMatrixAt(count, this.matrix);
        this.clouds.setColorAt(count, this.colour);
        count++;
      }
    }
    this.clouds.count = count;
    this.clouds.instanceMatrix.needsUpdate = true;
    if (this.clouds.instanceColor) this.clouds.instanceColor.needsUpdate = true;
  }
}
