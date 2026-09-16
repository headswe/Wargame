import * as THREE from 'three';
import { Fabric, type Segment } from '../sim/world/geometry.ts';
import type { Scene as SimScene } from '../sim/world/scene.ts';

/**
 * Walls, as things built out of something rather than as stretched boxes.
 *
 * One box per wall is the cheapest possible answer and it reads as exactly what
 * it is: an extruded rectangle, floating at one end wherever the ground is not
 * level, identical to every other wall on the map, and telling the eye nothing
 * about whether it is brick, sandbags or a fence. Cover is the whole subject of
 * this game, so a player has to be able to read what a piece of it is made of
 * at a glance and from across the map.
 *
 * Each fabric therefore gets its own construction — panels and a coping course
 * for masonry, staggered bags for a revetment, posts and rails for timber —
 * assembled from a handful of boxes per run rather than one. Runs are cut into
 * panels along their length, each sitting on its own piece of ground, which is
 * what stops a long wall hovering over a slope.
 *
 * It all lands in one merged buffer with a fixed vertex budget per segment, so
 * knocking a wall down rewrites its own slice in place rather than rebuilding
 * the map.
 */

/** One box, in the wall's own frame: u along the run, v up, w across it. */
interface Piece {
  u: number;
  v: number;
  w: number;
  su: number;
  sv: number;
  sw: number;
  /** Extra yaw on top of the run's heading, for anything knocked askew. */
  yaw?: number;
  /** Multiplier on the fabric's colour. */
  tint: number;
}

const VERTS_PER_BOX = 36;
/** How far a ground-sitting piece is sunk into the earth, in metres. */
const FOUNDATION = 0.25;

/** Per-face shade, standing in for light a single Lambert term will not give. */
const TOP = 1.16;
const SIDE = 0.95;
const END = 0.84;
const BOTTOM = 0.55;

const FABRIC_COLOUR: Record<number, number> = {
  [Fabric.Concrete]: 0x8d887e,
  [Fabric.Brick]: 0x8d6350,
  [Fabric.Timber]: 0x7a6247,
  [Fabric.Sandbag]: 0xa2916c,
  [Fabric.Hedge]: 0x4e6338,
  [Fabric.Metal]: 0x6e7278,
  [Fabric.Rubble]: 0x847868,
};

/** Deterministic hash in -1..1, so a wall looks the same every time it loads. */
function jitter(a: number, b: number): number {
  const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

// ---------------------------------------------------------------- fabrics

/**
 * Masonry: panels along the run, each slightly its own height, under a coping
 * course that oversails a little.
 *
 * The coping is doing most of the work. A capped wall reads as built and has a
 * top edge the light catches; an uncapped extrusion reads as a placeholder, and
 * no amount of colour fixes it.
 */
function masonry(segment: Segment, length: number, integrity: number, out: Piece[]): void {
  const height = segment.top - segment.sill;
  const t = segment.thickness;
  const capHeight = Math.min(0.16, height * 0.16);
  const panels = Math.max(1, Math.round(length / 2.2));
  const panelLength = length / panels;

  // A battered wall loses its cap first, then its top courses, unevenly.
  const capped = integrity > 0.55;
  const body = height - (capped ? capHeight : 0);

  for (let i = 0; i < panels; i++) {
    const wobble = jitter(segment.id, i);
    const loss = capped ? 0 : (1 - integrity) * height * (0.25 + 0.5 * Math.abs(wobble));
    const h = Math.max(0.1, body * (1 + wobble * 0.02) - loss);
    out.push({
      u: (i + 0.5) * panelLength,
      v: segment.sill + h / 2,
      w: 0,
      su: panelLength + t * 0.05,
      sv: h,
      sw: t * (1 + wobble * 0.04),
      tint: 1 + wobble * 0.07,
    });
  }

  if (capped) {
    // The oversail is an absolute lip rather than a fraction of the wall. A
    // thin wall with a proportional cap has no cap: the whole job of the course
    // is to throw a shadow line the eye can find from across the map.
    out.push({
      u: length / 2,
      v: segment.top - capHeight / 2,
      w: 0,
      su: length + 0.14,
      sv: capHeight,
      sw: t + 0.11,
      tint: 1.1,
    });
  }
}

/**
 * A lintel: the wall above a door or a window.
 *
 * It hangs rather than stands, so it gets a soffit — a lip along its underside.
 * Without one the opening reads as a hole punched in a slab; with one it reads
 * as a window, which is what the simulation has believed it was since the
 * sightline field learned about ceilings.
 */
function lintel(segment: Segment, length: number, out: Piece[]): void {
  const height = segment.top - segment.sill;
  const t = segment.thickness;
  out.push({
    u: length / 2,
    v: segment.sill + height / 2 + 0.04,
    w: 0,
    su: length,
    sv: Math.max(0.08, height - 0.08),
    sw: t,
    tint: 1.02,
  });
  out.push({
    u: length / 2,
    v: segment.sill + 0.04,
    w: 0,
    su: length + 0.05,
    sv: 0.08,
    sw: t + 0.07,
    tint: 0.82,
  });
}

/** Sandbags: staggered courses, each bag a squashed box laid across the run. */
function sandbags(segment: Segment, length: number, integrity: number, out: Piece[]): void {
  const bagHigh = 0.19;
  const bagLong = 0.52;
  const height = (segment.top - segment.sill) * (0.45 + 0.55 * integrity);
  const courses = Math.max(1, Math.round(height / bagHigh));
  const perCourse = Math.max(1, Math.round(length / bagLong));

  for (let c = 0; c < courses; c++) {
    // Each course steps in slightly, so a revetment leans back like a real one.
    const inset = c * 0.012;
    for (let i = 0; i < perCourse; i++) {
      const wobble = jitter(segment.id * 7 + c, i);
      // Alternate courses are offset half a bag, which is the whole look.
      const u = (i + 0.5 + (c % 2) * 0.5) * (length / perCourse);
      if (u > length) continue;
      out.push({
        u,
        v: segment.sill + (c + 0.5) * (height / courses),
        w: wobble * 0.03,
        su: (length / perCourse) * 0.94,
        sv: (height / courses) * 0.92,
        sw: segment.thickness * (0.96 - inset) + wobble * 0.04,
        yaw: wobble * 0.05,
        tint: 1 + wobble * 0.12,
      });
    }
  }
}

/** Post and rail: a fence you see straight through, because you can. */
function timber(segment: Segment, length: number, integrity: number, out: Piece[]): void {
  const height = (segment.top - segment.sill) * integrity;
  const t = segment.thickness;
  const posts = Math.max(2, Math.round(length / 1.8) + 1);

  for (let i = 0; i < posts; i++) {
    const wobble = jitter(segment.id * 3, i);
    out.push({
      u: (i / (posts - 1)) * length,
      v: segment.sill + height / 2,
      w: 0,
      su: t * 0.55,
      sv: height * (1 + wobble * 0.05),
      sw: t * 0.55,
      yaw: wobble * 0.06,
      tint: 1 + wobble * 0.1,
    });
  }
  for (const at of [0.34, 0.72]) {
    if (height * at < 0.1) continue;
    out.push({
      u: length / 2,
      v: segment.sill + height * at,
      w: 0,
      su: length,
      sv: Math.min(0.13, height * 0.16),
      sw: t * 0.32,
      tint: 0.95,
    });
  }
}

/** Corrugated sheet on posts: panels stepping in and out along the run. */
function metal(segment: Segment, length: number, integrity: number, out: Piece[]): void {
  const height = (segment.top - segment.sill) * (0.6 + 0.4 * integrity);
  const t = segment.thickness;
  const panels = Math.max(2, Math.round(length / 0.55));

  for (let i = 0; i < panels; i++) {
    const wobble = jitter(segment.id * 11, i);
    out.push({
      u: (i + 0.5) * (length / panels),
      v: segment.sill + height / 2,
      w: (i % 2 === 0 ? 1 : -1) * t * 0.16,
      su: (length / panels) * 1.02,
      sv: height * (1 - Math.abs(wobble) * 0.04),
      sw: t * 0.42,
      tint: 0.94 + (i % 2) * 0.14 + wobble * 0.05,
    });
  }
  const posts = Math.max(2, Math.round(length / 2.4) + 1);
  for (let i = 0; i < posts; i++) {
    out.push({
      u: (i / (posts - 1)) * length,
      v: segment.sill + height * 0.52,
      w: 0,
      su: t * 0.3,
      sv: height * 1.04,
      sw: t * 0.8,
      tint: 0.78,
    });
  }
}

/** What a wall leaves behind: a low spill of chunks, not a shrunken wall. */
function rubble(segment: Segment, length: number, out: Piece[]): void {
  const height = segment.top - segment.sill;
  const t = segment.thickness;
  const chunks = Math.max(2, Math.round(length / 0.7));

  for (let i = 0; i < chunks; i++) {
    const a = jitter(segment.id * 17, i);
    const b = jitter(segment.id * 29, i);
    const h = height * (0.45 + 0.55 * Math.abs(a));
    out.push({
      u: (i + 0.5 + a * 0.3) * (length / chunks),
      v: segment.sill + h / 2,
      w: b * t * 0.6,
      su: (length / chunks) * (0.8 + Math.abs(b) * 0.7),
      sv: h,
      sw: t * (0.5 + Math.abs(a) * 0.6),
      yaw: a * 0.8,
      tint: 0.88 + b * 0.18,
    });
  }
}

/** How a given run is put together. */
function plan(segment: Segment, length: number): Piece[] {
  const out: Piece[] = [];
  if (segment.destroyed) return out;
  const integrity = segment.maxHp <= 0 ? 0 : Math.max(0, segment.hp) / segment.maxHp;

  if (segment.sill > 0) {
    lintel(segment, length, out);
    return out;
  }

  switch (segment.fabric) {
    case Fabric.Sandbag:
      sandbags(segment, length, integrity, out);
      break;
    case Fabric.Timber:
      timber(segment, length, integrity, out);
      break;
    case Fabric.Metal:
      metal(segment, length, integrity, out);
      break;
    case Fabric.Rubble:
      rubble(segment, length, out);
      break;
    default:
      masonry(segment, length, integrity, out);
      break;
  }
  return out;
}

/**
 * The most boxes a run will ever need.
 *
 * Reserved rather than measured, because a wall that comes down turns into a
 * rubble run in place and a spill of chunks needs more pieces than the wall it
 * came from. Getting this wrong means a collapsing wall silently loses its far
 * end, so it is worth the arithmetic.
 */
function budgetFor(segment: Segment, length: number): number {
  if (segment.sill > 0) return 2;
  const asBuilt = plan({ ...segment, hp: segment.maxHp }, length).length;
  const asRubble = Math.max(2, Math.round(length / 0.7));
  return Math.max(asBuilt, asRubble);
}

// ----------------------------------------------------------------- the mesh

const UNIT = buildUnitBox();

export class WallView {
  readonly mesh: THREE.Mesh;

  private readonly scene: SimScene;
  private readonly positions: THREE.BufferAttribute;
  private readonly normals: THREE.BufferAttribute;
  private readonly colours: THREE.BufferAttribute;
  /** Where each segment's slice of the buffer starts, in boxes. */
  private readonly slice: { at: number; boxes: number }[] = [];

  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();

  constructor(scene: SimScene) {
    this.scene = scene;
    const segments = scene.structures.segments;

    let boxes = 0;
    for (const segment of segments) {
      const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
      const budget = budgetFor(segment, length);
      this.slice.push({ at: boxes, boxes: budget });
      boxes += budget;
    }

    const verts = Math.max(VERTS_PER_BOX, boxes * VERTS_PER_BOX);
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.normals = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.colours = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.normals.setUsage(THREE.DynamicDrawUsage);
    this.colours.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('normal', this.normals);
    geometry.setAttribute('color', this.colours);

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.mesh.name = 'walls';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;

    segments.forEach((_, id) => this.write(id));
    this.flush();
  }

  /** Rebuild the runs the simulation has changed. */
  update(ids: Iterable<number>): boolean {
    let any = false;
    for (const id of ids) {
      this.write(id);
      any = true;
    }
    if (any) this.flush();
    return any;
  }

  private flush(): void {
    this.positions.needsUpdate = true;
    this.normals.needsUpdate = true;
    this.colours.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
  }

  private write(id: number): void {
    const segment = this.scene.structures.segments[id];
    const slot = this.slice[id];
    if (!segment || !slot) return;

    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;
    const length = Math.hypot(dx, dy);
    const heading = Math.atan2(dy, dx);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);

    const pieces = plan(segment, length);
    const base = FABRIC_COLOUR[segment.fabric] ?? FABRIC_COLOUR[Fabric.Concrete];
    // A battered wall darkens as well as slumping: it is filthy, not just short.
    const integrity = segment.maxHp <= 0 ? 0 : Math.max(0, segment.hp) / segment.maxHp;
    const grime = 0.68 + 0.32 * integrity;

    for (let i = 0; i < slot.boxes; i++) {
      const offset = (slot.at + i) * VERTS_PER_BOX;
      const piece = pieces[i];
      if (!piece) {
        this.blank(offset);
        continue;
      }

      const x = segment.a.x + cos * piece.u - sin * piece.w;
      const z = segment.a.y + sin * piece.u + cos * piece.w;
      // Each piece stands on the ground beneath itself, so a run climbs a slope
      // in steps rather than floating off one end of it.
      const y = this.scene.heightAt(x, z) + piece.v;

      /**
       * Anything resting on the ground is buried a little into it.
       *
       * The ground is sampled at the piece's own centre, so on any slope its
       * corners are above ground at one end by however much the ground fell
       * across its length — measured at up to 18cm on Stepove, which at this
       * scale is a visible line of daylight under a wall, and the shadow
       * starting away from the wall is what gives it away. Sinking the base
       * course by more than that costs nothing: the buried part is underground
       * and the top of the piece does not move.
       *
       * Only pieces that start at ground level. A coping, a lintel or an upper
       * course would simply become taller.
       */
      let sv = piece.sv;
      let lift = 0;
      if (piece.v - piece.sv / 2 < 0.05) {
        sv += FOUNDATION;
        lift = -FOUNDATION / 2;
      }

      this.matrix.makeRotationY(-(heading + (piece.yaw ?? 0)));
      this.matrix.scale(new THREE.Vector3(piece.su, sv, piece.sw));
      this.matrix.setPosition(x, y + lift, z);
      this.colour.setHex(base).multiplyScalar(piece.tint * grime);
      this.emit(offset, this.matrix, this.colour);
    }
  }

  /** Collapse an unused box to a point, so it draws nothing. */
  private blank(offset: number): void {
    const p = this.positions.array as Float32Array;
    p.fill(0, offset * 3, (offset + VERTS_PER_BOX) * 3);
  }

  private emit(offset: number, matrix: THREE.Matrix4, colour: THREE.Color): void {
    const p = this.positions.array as Float32Array;
    const n = this.normals.array as Float32Array;
    const c = this.colours.array as Float32Array;
    const e = matrix.elements;

    for (let v = 0; v < VERTS_PER_BOX; v++) {
      const i = v * 3;
      const o = (offset + v) * 3;
      const px = UNIT.position[i];
      const py = UNIT.position[i + 1];
      const pz = UNIT.position[i + 2];
      p[o] = e[0] * px + e[4] * py + e[8] * pz + e[12];
      p[o + 1] = e[1] * px + e[5] * py + e[9] * pz + e[13];
      p[o + 2] = e[2] * px + e[6] * py + e[10] * pz + e[14];

      // Rotation only: the scales are positive, so normalising after is enough.
      const nx = UNIT.normal[i];
      const ny = UNIT.normal[i + 1];
      const nz = UNIT.normal[i + 2];
      const wx = e[0] * nx + e[4] * ny + e[8] * nz;
      const wy = e[1] * nx + e[5] * ny + e[9] * nz;
      const wz = e[2] * nx + e[6] * ny + e[10] * nz;
      const inv = 1 / (Math.hypot(wx, wy, wz) || 1);
      n[o] = wx * inv;
      n[o + 1] = wy * inv;
      n[o + 2] = wz * inv;

      const shade = UNIT.shade[v];
      c[o] = colour.r * shade;
      c[o + 1] = colour.g * shade;
      c[o + 2] = colour.b * shade;
    }
  }
}

/** A unit cube as loose triangles, with a baked shade per face. */
function buildUnitBox(): { position: number[]; normal: number[]; shade: number[] } {
  const position: number[] = [];
  const normal: number[] = [];
  const shade: number[] = [];

  const face = (
    corners: [number, number, number][],
    n: [number, number, number],
    s: number,
  ): void => {
    const [a, b, c, d] = corners;
    for (const v of [a, b, c, a, c, d]) {
      position.push(v[0], v[1], v[2]);
      normal.push(n[0], n[1], n[2]);
      shade.push(s);
    }
  };

  const h = 0.5;
  // +x and -x are the ends of a run; +z / -z its long faces; +y its top.
  face([[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]], [1, 0, 0], END);
  face([[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]], [-1, 0, 0], END);
  face([[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]], [0, 1, 0], TOP);
  face([[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]], [0, -1, 0], BOTTOM);
  face([[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]], [0, 0, 1], SIDE);
  face([[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]], [0, 0, -1], SIDE * 0.92);

  return { position, normal, shade };
}
