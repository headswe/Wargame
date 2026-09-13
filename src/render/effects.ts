import * as THREE from 'three';
import { Faction } from '../sim/units.ts';
import type { Effect } from '../sim/combat.ts';
import { THEME } from './theme.ts';

const MAX_TRACERS = 512;
const TRACER_LIFE = 0.075;
const MAX_MARKS = 256;
const MARK_LIFE = 0.45;

interface Tracer {
  from: THREE.Vector3;
  to: THREE.Vector3;
  age: number;
  colour: THREE.Color;
}

interface Mark {
  x: number;
  z: number;
  age: number;
  lethal: boolean;
}

/**
 * Every round fired draws a tracer. It looks busy because a firefight IS busy —
 * and more usefully, it is how the player reads where fire is coming from and
 * which of their positions is being suppressed.
 */
export class Effects {
  readonly group = new THREE.Group();
  private readonly tracers: Tracer[] = [];
  private readonly marks: Mark[] = [];

  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colours: Float32Array;

  private readonly markMesh: THREE.InstancedMesh;
  private readonly markColour = new THREE.Color();

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

    const markGeometry = new THREE.CircleGeometry(0.22, 10);
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
  }

  /** Consume this tick's simulation effects that the player could witness. */
  ingest(effects: readonly Effect[], visible: (x: number, y: number) => boolean): void {
    for (const effect of effects) {
      if (effect.kind === 'shot') {
        // Seeing either end is enough: incoming fire from an unseen shooter is
        // exactly the information a player should get.
        if (!visible(effect.from.x, effect.from.y) && !visible(effect.to.x, effect.to.y)) continue;
        if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
        this.tracers.push({
          // Rounds leave the weapon at chest height, not off the floor.
          from: new THREE.Vector3(effect.from.x, 0.75, effect.from.y),
          to: new THREE.Vector3(effect.to.x, 0.7, effect.to.y),
          age: 0,
          colour: new THREE.Color(
            effect.faction === Faction.Player ? THEME.tracerPlayer : THEME.tracerHostile,
          ),
        });
      } else if (effect.kind === 'impact') {
        if (visible(effect.at.x, effect.at.y)) this.pushMark(effect.at.x, effect.at.y, false);
      } else if (effect.kind === 'hit') {
        if (visible(effect.at.x, effect.at.y)) this.pushMark(effect.at.x, effect.at.y, true);
      }
    }
  }

  private pushMark(x: number, z: number, lethal: boolean): void {
    if (this.marks.length >= MAX_MARKS) this.marks.shift();
    this.marks.push({ x, z, age: 0, lethal });
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

    const matrix = new THREE.Matrix4();
    let count = 0;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.age += dt;
      if (mark.age >= MARK_LIFE) {
        this.marks.splice(i, 1);
        continue;
      }
      const t = mark.age / MARK_LIFE;
      const scale = mark.lethal ? 0.6 + t * 1.5 : 0.35 + t * 0.9;
      matrix.makeScale(scale, 1, scale);
      matrix.setPosition(mark.x, 0.04, mark.z);
      this.markMesh.setMatrixAt(count, matrix);
      this.markColour
        .set(mark.lethal ? THEME.blood : THEME.impact)
        .multiplyScalar(1 - t * 0.8);
      this.markMesh.setColorAt(count, this.markColour);
      count++;
      if (count >= MAX_MARKS) break;
    }
    this.markMesh.count = count;
    this.markMesh.instanceMatrix.needsUpdate = true;
    if (this.markMesh.instanceColor) this.markMesh.instanceColor.needsUpdate = true;
  }
}
