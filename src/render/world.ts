import * as THREE from 'three';
import { Fabric, Solidity } from '../sim/world/geometry.ts';
import type { Scene as SimScene } from '../sim/world/scene.ts';
import { Surface } from '../sim/world/terrain.ts';
import type { FogOfWar } from './fog.ts';
import { THEME } from './theme.ts';
import { WallView } from './walls.ts';
import { RoadView } from './roads.ts';

/** Metres between terrain mesh vertices. Finer than this buys nothing at this camera. */
const MESH_STEP = 1;
/** How far the drawn ground runs past the edge of the playable level, in metres. */
const APRON = 70;
const HAZE = new THREE.Color(THEME.haze);

const SURFACE_COLOUR: Record<number, number> = {
  [Surface.Dirt]: 0x8b8275,
  [Surface.Grass]: 0x6f7a4e,
  [Surface.Crop]: 0x8c8358,
  // The graded dirt a country road sits on, not the road itself — RoadView
  // draws the carriageway as a ribbon over this. Painting the metalled colour
  // into the surface grid as well gave a blurred grey band a metre wider than
  // the road on every side, with no edge anywhere on it, and a road is mostly
  // edge.
  [Surface.Road]: 0x6e6353,
  [Surface.Gravel]: 0x7d7870,
  [Surface.Concrete]: 0x84807a,
  [Surface.Mud]: 0x5f5344,
};

const FABRIC_COLOUR: Record<number, number> = {
  [Fabric.Concrete]: 0x6d685f,
  [Fabric.Brick]: 0x7d5a48,
  [Fabric.Timber]: 0x6b5640,
  [Fabric.Sandbag]: 0x9a8b6a,
  [Fabric.Hedge]: 0x4e6338,
  [Fabric.Metal]: 0x5d6166,
  [Fabric.Rubble]: 0x7a6f61,
};

/**
 * Everything you can see of the world: the ground itself, what is built on it,
 * and what is growing on it.
 *
 * Terrain is one mesh with per-vertex colour rather than a texture, because the
 * surface is authored per sample anyway and a vertex attribute costs nothing to
 * update when a shell reshapes the ground.
 */
export class WorldView {
  readonly group = new THREE.Group();

  private readonly scene: SimScene;
  private readonly terrainMesh: THREE.Mesh;
  private readonly terrainPositions: THREE.BufferAttribute;
  private readonly terrainColours: THREE.BufferAttribute;
  private readonly roads: RoadView;
  private readonly cols: number;
  private readonly rows: number;

  private readonly walls: WallView;
  private readonly props: THREE.InstancedMesh;
  private readonly foliage: THREE.InstancedMesh;
  private readonly propSlot = new Map<number, { mesh: THREE.InstancedMesh; slot: number }>();

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly colour = new THREE.Color();

  /**
   * `fog` is optional so the level editor can mount the game's own renderer.
   * An editor that draws the world a second way is an editor that lies about
   * what the level looks like, which is the one thing it must not do.
   */
  constructor(scene: SimScene, fog?: Pick<FogOfWar, 'applyTo'>) {
    this.scene = scene;
    this.group.name = 'world';

    this.cols = Math.floor((scene.width + APRON * 2) / MESH_STEP) + 1;
    this.rows = Math.floor((scene.height + APRON * 2) / MESH_STEP) + 1;

    const geometry = buildTerrainGeometry(scene, this.cols, this.rows);
    this.terrainPositions = geometry.getAttribute('position') as THREE.BufferAttribute;
    this.terrainColours = geometry.getAttribute('color') as THREE.BufferAttribute;
    this.terrainMesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.name = 'terrain';
    this.group.add(this.terrainMesh);

    this.roads = new RoadView(scene, fog);
    this.group.add(this.roads.mesh);

    this.walls = new WallView(scene);
    this.group.add(this.walls.mesh);

    const solidProps = scene.structures.props.filter((p) => p.solidity !== Solidity.Concealment);
    const softProps = scene.structures.props.filter((p) => p.solidity === Solidity.Concealment);

    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8);
    cylinder.translate(0, 0.5, 0);
    this.props = new THREE.InstancedMesh(
      cylinder,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      Math.max(1, solidProps.length),
    );
    this.props.castShadow = true;
    this.props.count = solidProps.length;
    this.group.add(this.props);

    // Vegetation reads better as a soft blob than a hard cylinder, and being
    // slightly translucent says "you can walk into this" without a legend.
    const bush = new THREE.IcosahedronGeometry(1, 1);
    bush.scale(1, 0.75, 1);
    bush.translate(0, 0.6, 0);
    this.foliage = new THREE.InstancedMesh(
      bush,
      new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
      Math.max(1, softProps.length),
    );
    this.foliage.castShadow = true;
    this.foliage.count = softProps.length;
    this.group.add(this.foliage);

    solidProps.forEach((p, slot) => {
      this.propSlot.set(p.id, { mesh: this.props, slot });
      this.writeProp(p.id);
    });
    softProps.forEach((p, slot) => {
      this.propSlot.set(p.id, { mesh: this.foliage, slot });
      this.writeProp(p.id);
    });
    this.flush();

    if (fog) {
      this.group.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        if (!material) return;
        if (Array.isArray(material)) material.forEach((m) => fog.applyTo(m));
        else fog.applyTo(material);
      });
    }
  }

  /** Redraw whatever the simulation broke since last frame. */
  update(): void {
    let dirty = this.walls.update(this.scene.dirtySegments);
    this.scene.dirtySegments.clear();
    for (const id of this.scene.dirtyProps) {
      this.writeProp(id);
      dirty = true;
    }
    this.scene.dirtyProps.clear();

    if (this.scene.dirtyTerrain.length > 0) {
      this.scene.dirtyTerrain.length = 0;
      this.refreshTerrain();
      dirty = true;
    }
    if (dirty) this.flush();
  }

  private flush(): void {
    this.props.instanceMatrix.needsUpdate = true;
    this.foliage.instanceMatrix.needsUpdate = true;
    if (this.props.instanceColor) this.props.instanceColor.needsUpdate = true;
    if (this.foliage.instanceColor) this.foliage.instanceColor.needsUpdate = true;
  }

  private writeProp(id: number): void {
    const entry = this.propSlot.get(id);
    const p = this.scene.structures.props[id];
    if (!entry || !p) return;

    if (p.destroyed) {
      this.matrix.makeScale(0, 0, 0);
      entry.mesh.setMatrixAt(entry.slot, this.matrix);
      return;
    }

    const base = this.scene.heightAt(p.pos.x, p.pos.y);
    const integrity = p.maxHp <= 0 ? 1 : Math.max(0, p.hp) / p.maxHp;
    this.position.set(p.pos.x, base, p.pos.y);
    this.quaternion.identity();
    this.scale.set(p.radius, Math.max(0.15, p.top * (0.6 + 0.4 * integrity)), p.radius);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    entry.mesh.setMatrixAt(entry.slot, this.matrix);

    this.colour.set(FABRIC_COLOUR[p.fabric] ?? THEME.lowCover).multiplyScalar(0.7 + 0.3 * integrity);
    entry.mesh.setColorAt(entry.slot, this.colour);
  }

  private refreshTerrain(): void {
    // Through the same function that built it. These were two separate loops
    // computing the same vertex, which is how a crater came to move the whole
    // map seventy metres sideways and strip its shading the moment the apron
    // was added: one loop knew about it and the other did not.
    const positions = this.terrainPositions.array as Float32Array;
    const colours = this.terrainColours.array as Float32Array;
    let v = 0;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) writeTerrainVertex(this.scene, i, j, positions, colours, v++);
    }
    this.terrainPositions.needsUpdate = true;
    this.terrainColours.needsUpdate = true;
    this.terrainMesh.geometry.computeVertexNormals();
    // The road is draped over this ground, so it moves with it.
    this.roads.refresh();
  }
}

/**
 * Deterministic value noise. Not `Math.random`, because a field that looks
 * different every time the level is opened is a field the author cannot judge.
 */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function noiseAt(x: number, y: number, scale: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const fx = gx - i;
  const fy = gy - j;
  // Smoothstep between the four corners, so it reads as patchiness rather than
  // as a grid of squares.
  const u = fx * fx * (3 - 2 * fx);
  const w = fy * fy * (3 - 2 * fy);
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  return (a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + d * u) * w;
}

/**
 * How much darker or lighter this patch of ground is than its surface's colour.
 *
 * Three things, none of which the lighting can supply. Coarse patchiness,
 * because a ploughed field is not one colour and a flat fill reads as painted
 * card. Slope, because ground that pitches has thinner cover on it and catches
 * the light differently from ground that lies flat. And a darkening in the
 * angle where something solid meets the earth — the cheapest possible ambient
 * occlusion, computed once at build time, and the thing that stops a building
 * looking like it was pasted on top of the map rather than standing on it.
 */
function groundShade(scene: SimScene, x: number, y: number): number {
  const patch = 0.92 + noiseAt(x, y, 17) * 0.16;
  const grain = 0.97 + noiseAt(x, y, 3.5) * 0.06;
  const slope = 1 - Math.min(scene.terrain.slopeAt(x, y), 1) * 0.18;

  let contact = 1;
  const reach = 2.2;
  for (const id of scene.structures.segmentsInBox(x - reach, y - reach, x + reach, y + reach)) {
    const seg = scene.structures.segments[id];
    if (!seg || seg.destroyed || seg.sill > 0) continue;
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-9
      ? Math.max(0, Math.min(1, ((x - seg.a.x) * dx + (y - seg.a.y) * dy) / len2))
      : 0;
    const d = Math.hypot(x - (seg.a.x + dx * t), y - (seg.a.y + dy * t)) - seg.thickness / 2;
    if (d >= reach) continue;
    // Deepest right against the wall, gone by the time you are two metres off.
    contact = Math.min(contact, 0.62 + 0.38 * Math.max(0, d / reach));
  }

  return patch * grain * slope * contact;
}

const scratch = new THREE.Color();

/**
 * One vertex of the drawn ground: where it is and what colour.
 *
 * The single place that knows the mesh is offset by an apron, so building the
 * geometry and refreshing it after a crater cannot disagree about where the map
 * starts.
 */
function writeTerrainVertex(
  scene: SimScene, i: number, j: number,
  positions: Float32Array, colours: Float32Array, v: number,
): void {
  const x = i * MESH_STEP - APRON;
  const y = j * MESH_STEP - APRON;
  // Outside the level, the ground is the nearest real ground carried outward
  // and sagging gently away. It is not playable and nothing in the simulation
  // knows it exists; it is there so the map stops being a slab of earth
  // floating over a void, which is what it looked like.
  const sx = Math.max(0, Math.min(scene.width, x));
  const sy = Math.max(0, Math.min(scene.height, y));
  const out = Math.hypot(x - sx, y - sy);

  positions[v * 3] = x;
  positions[v * 3 + 1] = scene.heightAt(sx, sy) - (out / APRON) ** 2 * 7;
  positions[v * 3 + 2] = y;

  scratch.set(SURFACE_COLOUR[scene.terrain.surfaceAt(sx, sy)] ?? 0x8b8275);
  scratch.multiplyScalar(groundShade(scene, sx, sy));
  // And it fades into the air, so there is no line where the level ends.
  if (out > 0) scratch.lerp(HAZE, Math.min(1, (out / APRON) ** 0.8));
  colours[v * 3] = scratch.r;
  colours[v * 3 + 1] = scratch.g;
  colours[v * 3 + 2] = scratch.b;
}

function buildTerrainGeometry(scene: SimScene, cols: number, rows: number): THREE.BufferGeometry {
  const positions = new Float32Array(cols * rows * 3);
  const colours = new Float32Array(cols * rows * 3);

  let v = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) writeTerrainVertex(scene, i, j, positions, colours, v++);
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let t = 0;
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < cols; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** Light rig. One sun with a shadow frustum over the whole map. */
export function buildLighting(scene: SimScene): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.HemisphereLight(THEME.sky, THEME.groundDark, 1.35));

  const sun = new THREE.DirectionalLight(THEME.sun, 1.6);
  sun.position.set(scene.width * 0.35, 110, -scene.height * 0.2);
  sun.target.position.set(scene.width / 2, 0, scene.height / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);

  const span = Math.max(scene.width, scene.height) * 0.62;
  const cam = sun.shadow.camera;
  cam.left = -span;
  cam.right = span;
  cam.top = span;
  cam.bottom = -span;
  cam.near = 1;
  cam.far = 320;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0015;
  sun.shadow.normalBias = 0.04;

  group.add(sun, sun.target);
  return group;
}
