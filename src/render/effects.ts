import * as THREE from 'three';
import { Faction } from '../sim/units.ts';
import type { Effect } from '../sim/combat.ts';
import { Rng } from '../sim/rng.ts';
import { THEME } from './theme.ts';

const MAX_TRACERS = 512;
const TRACER_LIFE = 0.075;
const MAX_MARKS = 256;
const MAX_SPARKS = 1024;

interface Tracer {
  from: THREE.Vector3;
  to: THREE.Vector3;
  age: number;
  colour: THREE.Color;
}

/** Something left on the ground: a strike, blood, the scorch off a grenade. */
interface Mark {
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  /** Radius at birth and at death. A strike snaps out; a scorch barely moves. */
  from: number;
  to: number;
  colour: number;
  /** How far it dims across its life. A scorch stays dark and simply ends. */
  fade: number;
}

/**
 * A thrown speck of something — a spark off a wall, dust out of the ground, a
 * piece of a grenade's fireball.
 *
 * All of them are drawn additively, which is why there is no opacity here: a
 * spark dies by having its colour taken down to nothing, and that fade costs a
 * multiply rather than a second material.
 */
interface Spark {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  from: number;
  to: number;
  /** Metres per second per second, downward. Smoke gets a negative one. */
  gravity: number;
  /** Fraction of speed kept each second. Dust stops in the air; debris does not. */
  drag: number;
  colour: THREE.Color;
}

/**
 * Every round fired draws a tracer. It looks busy because a firefight IS busy —
 * and more usefully, it is how the player reads where fire is coming from and
 * which of their positions is being suppressed.
 *
 * Around the tracers, everything a round does when it arrives: the flash at the
 * muzzle that says which man in a fireteam is actually firing, dust off the
 * ground where it lands, a spark where it skips off something hard, and for a
 * grenade a fireball, debris and a scorch that outlasts all of it.
 *
 * None of this touches the simulation. Every one of these is drawn off an
 * effect the simulation already emitted, so the picture can be made as loud as
 * it likes without moving a single number in the fight.
 */
export class Effects {
  readonly group = new THREE.Group();
  private readonly tracers: Tracer[] = [];
  private readonly marks: Mark[] = [];
  private readonly sparks: Spark[] = [];

  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colours: Float32Array;

  private readonly markMesh: THREE.InstancedMesh;
  private readonly markColour = new THREE.Color();

  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly sparkColour = new THREE.Color();
  private readonly matrix = new THREE.Matrix4();

  constructor() {
    this.group.name = 'effects';

    this.positions = new Float32Array(MAX_TRACERS * 6);
    this.colours = new Float32Array(MAX_TRACERS * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colours, 3));
    geometry.setDrawRange(0, 0);

    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 800;
    this.group.add(this.lines);

    const markGeometry = new THREE.CircleGeometry(1, 10);
    markGeometry.rotateX(-Math.PI / 2);
    this.markMesh = new THREE.InstancedMesh(
      markGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false }),
      MAX_MARKS,
    );
    this.markMesh.frustumCulled = false;
    this.markMesh.count = 0;
    this.markMesh.renderOrder = 10;
    this.group.add(this.markMesh);

    // A blob rather than a camera-facing quad. The camera can be spun, and a
    // solid reads the same from every angle without anything having to be told
    // where the camera is this frame.
    //
    // One subdivision, not none. A bare icosahedron is twenty faces, which at
    // the size a grenade's fireball reaches is unmistakably a hexagon on
    // screen. Eighty faces is still nothing next to the terrain and it is the
    // difference between a fireball and a dice.
    this.sparkMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Depth *testing* stays on, so a flash inside a building does not glow
        // through its wall. Only the write is off, so sparks do not occlude
        // each other into hard edges.
        depthWrite: false,
      }),
      MAX_SPARKS,
    );
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.count = 0;
    this.sparkMesh.renderOrder = 820;
    this.group.add(this.sparkMesh);
  }

  /** Consume this tick's simulation effects that the player could witness. */
  ingest(effects: readonly Effect[], visible: (x: number, y: number) => boolean): void {
    for (const effect of effects) {
      if (effect.kind === 'shot') {
        // Seeing either end is enough: incoming fire from an unseen shooter is
        // exactly the information a player should get.
        const sawShooter = visible(effect.from.x, effect.from.y);
        if (!sawShooter && !visible(effect.to.x, effect.to.y)) continue;
        if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
        this.tracers.push({
          // The simulation knows the real heights now — muzzle to impact.
          from: new THREE.Vector3(effect.from.x, effect.fromHeight, effect.from.y),
          to: new THREE.Vector3(effect.to.x, effect.toHeight, effect.to.y),
          age: 0,
          colour: new THREE.Color(
            effect.faction === Faction.Player ? THEME.tracerPlayer : THEME.tracerHostile,
          ),
        });
        // Only where you can see the man. A flash is what tells you which one
        // of four is firing, and inventing one for a shooter you have not
        // found would give away the position the tracer is meant to hint at.
        if (sawShooter) this.muzzleFlash(effect);
      } else if (effect.kind === 'impact') {
        if (visible(effect.at.x, effect.at.y)) {
          this.pushMark(effect.at.x, effect.at.y, effect.height, {
            life: 0.4, from: 0.1, to: 0.42, colour: THEME.impact, fade: 0.88,
          });
          this.strike(effect.at.x, effect.at.y, effect.height);
        }
      } else if (effect.kind === 'hit') {
        if (visible(effect.at.x, effect.at.y)) {
          this.pushMark(effect.at.x, effect.at.y, effect.height, {
            life: 0.45, from: 0.2, to: 0.75, colour: THEME.blood, fade: 0.8,
          });
          this.spray(effect.at.x, effect.at.y, effect.height);
        }
      } else if (effect.kind === 'blast') {
        // Scorch the ground whether or not anyone saw it go off — a crater you
        // walk up to later is information too. The fire and the debris are only
        // for someone watching; there is nothing to witness afterwards.
        this.pushMark(effect.at.x, effect.at.y, effect.height - 0.3, {
          life: 22,
          from: effect.radius * 0.16,
          to: effect.radius * 0.22,
          colour: THEME.smoke,
          fade: 0.25,
        });
        if (visible(effect.at.x, effect.at.y)) {
          this.detonate(effect.at.x, effect.at.y, effect.height, effect.radius);
        }
      }
    }
  }

  /**
   * Deterministic, and seeded off where the thing happened.
   *
   * A mission replays exactly from its seed, and a spray of sparks that came
   * out differently every time you watched the same fight would be the one part
   * of the picture that did not. The simulation's own `Rng` rather than a second
   * one, for the same reason `Math.random` is banned inside `src/sim`.
   */
  private scatter(x: number, z: number): Rng {
    return new Rng(Math.imul(Math.round(x * 64), 0x9e3779b1) ^ Math.round(z * 64));
  }

  private push(spark: Spark): void {
    if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
    this.sparks.push(spark);
  }

  /** The flash at the barrel: brief, and placed at the end of the weapon. */
  private muzzleFlash(effect: Extract<Effect, { kind: 'shot' }>): void {
    let dx = effect.to.x - effect.from.x;
    let dz = effect.to.y - effect.from.y;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    this.push({
      x: effect.from.x + dx * 0.55,
      y: effect.fromHeight,
      z: effect.from.y + dz * 0.55,
      vx: dx * 1.5, vy: 0, vz: dz * 1.5,
      age: 0,
      // Shorter than the tracer. It should read as a stab of light, not a lamp.
      life: 0.05,
      from: 0.17, to: 0.035,
      gravity: 0, drag: 0.02,
      colour: new THREE.Color(THEME.muzzleFlash),
    });
  }

  /** A round arriving on ground or wall: dust, and sometimes a ricochet. */
  private strike(x: number, z: number, y: number): void {
    const rng = this.scatter(x, z);
    // More of them and smaller. Four big ones came out as pale pebbles sitting
    // on the grass: an additive blob has a hard edge, and the only way to get
    // a soft one without a texture is to make each piece too small to have an
    // edge worth seeing and let the spray do the work.
    for (let i = 0; i < 7; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(0.6, 2.4);
      this.push({
        x, y, z,
        vx: Math.cos(angle) * out,
        vy: rng.range(1.4, 3.4),
        vz: Math.sin(angle) * out,
        age: 0,
        life: rng.range(0.24, 0.44),
        from: 0.04, to: 0.17,
        gravity: 8, drag: 2.6,
        colour: new THREE.Color(THEME.dust),
      });
    }
    // Not every round skips, and the ones that do are the reason a firefight
    // around a wall looks different from one in a field.
    if (!rng.chance(0.35)) return;
    for (let i = 0; i < 2; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(2.5, 6);
      this.push({
        x, y, z,
        vx: Math.cos(angle) * out,
        vy: rng.range(3.5, 8),
        vz: Math.sin(angle) * out,
        age: 0,
        life: rng.range(0.18, 0.34),
        from: 0.1, to: 0.02,
        gravity: 15, drag: 0.1,
        colour: new THREE.Color(THEME.ricochet),
      });
    }
  }

  /** A round arriving on a man. */
  private spray(x: number, z: number, y: number): void {
    const rng = this.scatter(x + 0.5, z);
    for (let i = 0; i < 5; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(0.8, 2.6);
      this.push({
        x, y, z,
        vx: Math.cos(angle) * out,
        vy: rng.range(0.6, 2.4),
        vz: Math.sin(angle) * out,
        age: 0,
        life: rng.range(0.22, 0.4),
        from: 0.05, to: 0.14,
        gravity: 11, drag: 1.2,
        colour: new THREE.Color(THEME.blood),
      });
    }
  }

  /**
   * A grenade going off: fire, then what it throws, then what hangs about.
   *
   * Everything is sized off the simulation's own blast radius rather than a
   * number picked to look right, so a weapon with more reach visibly has more
   * reach. That is the only part of this the player can act on.
   *
   * The fractions are small because that radius is how far the thing hurts you
   * — 7.5 metres on a frag — and not how big the bang is. Taken at face value
   * the fireball came out five metres across and the scorch ten.
   */
  private detonate(x: number, z: number, y: number, radius: number): void {
    const rng = this.scatter(x, z + 0.5);

    for (let i = 0; i < 4; i++) {
      this.push({
        x: x + rng.range(-0.4, 0.4),
        y: y + rng.range(0, 0.6),
        z: z + rng.range(-0.4, 0.4),
        vx: 0, vy: 1.2, vz: 0,
        age: 0,
        life: rng.range(0.16, 0.26),
        from: radius * 0.09, to: radius * 0.22,
        gravity: 0, drag: 3,
        colour: new THREE.Color(THEME.fireball),
      });
    }

    for (let i = 0; i < 16; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(0.3, 1) * radius * 1.2;
      this.push({
        x, y, z,
        vx: Math.cos(angle) * out,
        vy: rng.range(2, 9),
        vz: Math.sin(angle) * out,
        age: 0,
        life: rng.range(0.35, 0.8),
        from: 0.2, to: 0.03,
        gravity: 17, drag: 0.4,
        colour: new THREE.Color(THEME.ember),
      });
    }

    // The part that lingers, and the only part that is still there by the time
    // anyone has reacted to the bang.
    for (let i = 0; i < 9; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(0.1, 0.45) * radius;
      this.push({
        x, y, z,
        vx: Math.cos(angle) * out,
        vy: rng.range(0.6, 1.8),
        vz: Math.sin(angle) * out,
        age: 0,
        life: rng.range(1.1, 2.1),
        from: radius * 0.08, to: radius * 0.3,
        gravity: -0.35, drag: 1.4,
        colour: new THREE.Color(THEME.smoke),
      });
    }
  }

  private pushMark(
    x: number, z: number, y: number,
    shape: { life: number; from: number; to: number; colour: number; fade: number },
  ): void {
    if (this.marks.length >= MAX_MARKS) this.marks.shift();
    this.marks.push({ x, y, z, age: 0, ...shape });
  }

  update(dt: number): void {
    let vertex = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i];
      tracer.age += dt;
      if (tracer.age >= TRACER_LIFE) {
        this.tracers.splice(i, 1);
        continue;
      }
      const fade = 1 - tracer.age / TRACER_LIFE;
      const o = vertex * 3;
      this.positions[o] = tracer.from.x;
      this.positions[o + 1] = tracer.from.y;
      this.positions[o + 2] = tracer.from.z;
      this.positions[o + 3] = tracer.to.x;
      this.positions[o + 4] = tracer.to.y;
      this.positions[o + 5] = tracer.to.z;
      for (let v = 0; v < 2; v++) {
        this.colours[o + v * 3] = tracer.colour.r * fade;
        this.colours[o + v * 3 + 1] = tracer.colour.g * fade;
        this.colours[o + v * 3 + 2] = tracer.colour.b * fade;
      }
      vertex += 2;
      if (vertex >= MAX_TRACERS * 2) break;
    }
    this.lines.geometry.setDrawRange(0, vertex);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;

    let count = 0;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.age += dt;
      if (mark.age >= mark.life) {
        this.marks.splice(i, 1);
        continue;
      }
      const t = mark.age / mark.life;
      const scale = mark.from + (mark.to - mark.from) * t;
      this.matrix.makeScale(scale, 1, scale);
      this.matrix.setPosition(mark.x, mark.y + 0.04, mark.z);
      this.markMesh.setMatrixAt(count, this.matrix);
      this.markColour.set(mark.colour).multiplyScalar(1 - t * mark.fade);
      this.markMesh.setColorAt(count, this.markColour);
      count++;
      if (count >= MAX_MARKS) break;
    }
    this.markMesh.count = count;
    this.markMesh.instanceMatrix.needsUpdate = true;
    if (this.markMesh.instanceColor) this.markMesh.instanceColor.needsUpdate = true;

    let sparks = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      spark.age += dt;
      if (spark.age >= spark.life) {
        this.sparks.splice(i, 1);
        continue;
      }
      // Exponential drag rather than subtracting a constant, so nothing ever
      // turns round and flies back the way it came at low speeds.
      const kept = Math.exp(-spark.drag * dt);
      spark.vx *= kept;
      spark.vz *= kept;
      spark.vy = (spark.vy - spark.gravity * dt) * kept;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.z += spark.vz * dt;

      const t = spark.age / spark.life;
      const scale = spark.from + (spark.to - spark.from) * t;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(spark.x, spark.y, spark.z);
      this.sparkMesh.setMatrixAt(sparks, this.matrix);
      // Squared, so a spark spends most of its life dim and only the first
      // instant of it bright. Linear reads as a fading bulb.
      this.sparkColour.copy(spark.colour).multiplyScalar((1 - t) * (1 - t));
      this.sparkMesh.setColorAt(sparks, this.sparkColour);
      sparks++;
      if (sparks >= MAX_SPARKS) break;
    }
    this.sparkMesh.count = sparks;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;
  }
}
