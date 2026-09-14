import * as THREE from 'three';
import { Fabric, Solidity } from '../sim/world/geometry.ts';
import type { Scene as SimScene } from '../sim/world/scene.ts';
import { Surface } from '../sim/world/terrain.ts';
import type { FogOfWar } from './fog.ts';
import { THEME } from './theme.ts';
import { WallView } from './walls.ts';

/** Metres between terrain mesh vertices. Finer than this buys nothing at this camera. */
const MESH_STEP = 1;

const SURFACE_COLOUR: Record<number, number> = {
  [Surface.Dirt]: 0x8b8275,
  [Surface.Grass]: 0x6f7a4e,
  [Surface.Crop]: 0x8c8358,
  [Surface.Road]: 0x565049,
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

  constructor(scene: SimScene, fog: FogOfWar) {
    this.scene = scene;
    this.group.name = 'world';

    this.cols = Math.floor(scene.width / MESH_STEP) + 1;
    this.rows = Math.floor(scene.height / MESH_STEP) + 1;

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

    this.group.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      if (Array.isArray(material)) material.forEach((m) => fog.applyTo(m));
      else fog.applyTo(material);
    });
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
    const positions = this.terrainPositions.array as Float32Array;
    const colours = this.terrainColours.array as Float32Array;
    let v = 0;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const x = i * MESH_STEP;
        const y = j * MESH_STEP;
        positions[v * 3 + 1] = this.scene.heightAt(x, y);
        this.colour.set(SURFACE_COLOUR[this.scene.terrain.surfaceAt(x, y)] ?? 0x8b8275);
        colours[v * 3] = this.colour.r;
        colours[v * 3 + 1] = this.colour.g;
        colours[v * 3 + 2] = this.colour.b;
        v++;
      }
    }
    this.terrainPositions.needsUpdate = true;
    this.terrainColours.needsUpdate = true;
    this.terrainMesh.geometry.computeVertexNormals();
  }
}

function buildTerrainGeometry(scene: SimScene, cols: number, rows: number): THREE.BufferGeometry {
  const positions = new Float32Array(cols * rows * 3);
  const colours = new Float32Array(cols * rows * 3);
  const colour = new THREE.Color();

  let v = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * MESH_STEP;
      const y = j * MESH_STEP;
      positions[v * 3] = x;
      positions[v * 3 + 1] = scene.heightAt(x, y);
      positions[v * 3 + 2] = y;
      colour.set(SURFACE_COLOUR[scene.terrain.surfaceAt(x, y)] ?? 0x8b8275);
      colours[v * 3] = colour.r;
      colours[v * 3 + 1] = colour.g;
      colours[v * 3 + 2] = colour.b;
      v++;
    }
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
