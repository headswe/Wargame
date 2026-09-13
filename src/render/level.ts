import * as THREE from 'three';
import { Material, Tile, World } from '../sim/world.ts';
import type { FogOfWar } from './fog.ts';
import { THEME, tileJitter } from './theme.ts';

export const WALL_HEIGHT = 2.0;
export const LOW_HEIGHT = 0.8;
const RUBBLE_HEIGHT = 0.5;

interface Block {
  height: number;
  jitter: number;
}

const BLOCKS: Record<number, Block> = {
  [Tile.Wall]: { height: WALL_HEIGHT, jitter: 0.16 },
  [Tile.Low]: { height: LOW_HEIGHT, jitter: 0.12 },
  [Tile.Rubble]: { height: RUBBLE_HEIGHT, jitter: 0.22 },
};

/**
 * What things are made of. This is the difference between a compound and a
 * beige mass: a player should know a hedgerow from a brick wall from a sandbag
 * line at a glance, without reading any of them.
 */
const MATERIAL_COLOUR: Record<number, number> = {
  [Material.Dirt]: 0x8b8275,
  [Material.Concrete]: 0x6d685f,
  [Material.Brick]: 0x7d5a48,
  [Material.Hedge]: 0x53663f,
  [Material.Sandbag]: 0x9a8b6a,
  [Material.Timber]: 0x6b5640,
  [Material.Road]: 0x565049,
  [Material.Rubble]: 0x7a6f61,
  [Material.Crop]: 0x8c8358,
};

/**
 * Static geometry, in a handful of draw calls — and able to change, which is
 * the whole point of a destructible battlefield.
 *
 * Every solid tile owns one instance for the life of the level. Collapsing a
 * wall rewrites that instance's transform and colour rather than rebuilding the
 * mesh, so destruction costs a matrix write and nothing else.
 */
export class LevelView {
  readonly group = new THREE.Group();

  private readonly mesh: THREE.InstancedMesh;
  /** tile index -> instance slot, or -1 where the tile was never solid. */
  private readonly slotOf: Int32Array;
  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();
  private readonly base = new THREE.Color();

  constructor(world: World, fog: FogOfWar) {
    this.group.name = 'level';
    this.group.add(buildGround(world), buildGrid(world));

    const solids: number[] = [];
    this.slotOf = new Int32Array(world.width * world.height).fill(-1);
    for (let ty = 0; ty < world.height; ty++) {
      for (let tx = 0; tx < world.width; tx++) {
        const tile = world.at(tx, ty);
        if (!BLOCKS[tile]) continue;
        this.slotOf[ty * world.width + tx] = solids.length;
        solids.push(ty * world.width + tx);
      }
    }

    // One unit cube, scaled per instance — so a wall can shrink into rubble.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    this.mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      Math.max(1, solids.length),
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = solids.length;
    this.group.add(this.mesh);

    for (let slot = 0; slot < solids.length; slot++) {
      this.writeInstance(world, solids[slot], slot);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    const doors = buildDoorMarkers(world);
    if (doors) this.group.add(doors);

    this.group.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      if (Array.isArray(material)) material.forEach((m) => fog.applyTo(m));
      else fog.applyTo(material);
    });
  }

  /** Drain what the simulation broke this frame and redraw just those tiles. */
  update(world: World): void {
    let dirty = false;

    for (const index of world.changedTiles) {
      const slot = this.slotOf[index];
      if (slot < 0) continue;
      this.writeInstance(world, index, slot);
      dirty = true;
    }
    world.changedTiles.length = 0;

    for (const index of world.damagedTiles) {
      const slot = this.slotOf[index];
      if (slot < 0) continue;
      this.writeInstance(world, index, slot);
      dirty = true;
    }
    world.damagedTiles.clear();

    if (!dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private writeInstance(world: World, index: number, slot: number): void {
    const tx = index % world.width;
    const ty = (index / world.width) | 0;
    const tile = world.at(tx, ty);
    const block = BLOCKS[tile];

    if (!block) {
      // Cleared away entirely — collapse the instance to nothing.
      this.matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(slot, this.matrix);
      return;
    }

    // Damage shows before collapse: a battered wall visibly slumps and dirties,
    // which is the cue that the cover behind it is no longer worth much.
    const integrity = world.integrityAt(tx, ty);
    const wear = 0.72 + 0.28 * integrity;

    this.matrix.makeScale(0.98, block.height * wear, 0.98);
    this.matrix.setPosition(tx + 0.5, 0, ty + 0.5);
    this.mesh.setMatrixAt(slot, this.matrix);

    this.base.set(MATERIAL_COLOUR[world.materials[index]] ?? THEME.wall);
    const shade = 1 + tileJitter(tx, ty) * block.jitter;
    this.colour.copy(this.base).multiplyScalar(shade * (0.62 + 0.38 * integrity));
    this.mesh.setColorAt(slot, this.colour);
  }
}

/**
 * The ground carries its own materials — track, ploughed field, bare dirt —
 * from a texture sampled by world position. Same trick as the fog, and for the
 * same reason: it sidesteps every plane-UV orientation trap.
 */
function buildGround(world: World): THREE.Mesh {
  const data = new Uint8Array(world.width * world.height * 4);
  const colour = new THREE.Color();
  for (let i = 0; i < world.width * world.height; i++) {
    colour.set(MATERIAL_COLOUR[world.materials[i]] ?? THEME.ground);
    data[i * 4] = Math.round(colour.r * 255);
    data[i * 4 + 1] = Math.round(colour.g * 255);
    data[i * 4 + 2] = Math.round(colour.b * 255);
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, world.width, world.height, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(world.width, world.height);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(world.width / 2, 0, world.height / 2);

  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.groundMap = { value: texture };
    shader.uniforms.groundSize = { value: new THREE.Vector2(world.width, world.height) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n vGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vGroundWorld;\nuniform sampler2D groundMap;\nuniform vec2 groundSize;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec2 gUv = vec2(vGroundWorld.x / groundSize.x, vGroundWorld.z / groundSize.y);
         diffuseColor.rgb *= texture2D(groundMap, gUv).rgb;`,
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

/** A faint tile grid. Players judge distance and cover spacing off this. */
function buildGrid(world: World): THREE.LineSegments {
  const points: number[] = [];
  const step = world.width > 100 ? 5 : 1;
  for (let x = 0; x <= world.width; x += step) points.push(x, 0.012, 0, x, 0.012, world.height);
  for (let y = 0; y <= world.height; y += step) points.push(0, 0.012, y, world.width, 0.012, y);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.06 }),
  );
}

/** Doorways get a floor plate: they are funnels, and funnels should be visible. */
function buildDoorMarkers(world: World): THREE.InstancedMesh | null {
  const doors: number[] = [];
  for (let ty = 0; ty < world.height; ty++) {
    for (let tx = 0; tx < world.width; tx++) {
      if (world.at(tx, ty) === Tile.Door) doors.push(ty * world.width + tx);
    }
  }
  if (doors.length === 0) return null;

  const geometry = new THREE.PlaneGeometry(0.92, 0.92);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: THEME.door, transparent: true, opacity: 0.5 }),
    doors.length,
  );
  const matrix = new THREE.Matrix4();
  doors.forEach((index, i) => {
    matrix.makeTranslation((index % world.width) + 0.5, 0.02, ((index / world.width) | 0) + 0.5);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Light rig. One sun with a tight shadow frustum over the whole map. */
export function buildLighting(world: World): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.HemisphereLight(THEME.sky, THEME.groundDark, 1.45));

  const sun = new THREE.DirectionalLight(THEME.sun, 1.5);
  sun.position.set(world.width * 0.35, 90, -world.height * 0.15);
  sun.target.position.set(world.width / 2, 0, world.height / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);

  const span = Math.max(world.width, world.height) * 0.62;
  const cam = sun.shadow.camera;
  cam.left = -span;
  cam.right = span;
  cam.top = span;
  cam.bottom = -span;
  cam.near = 1;
  cam.far = 260;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.03;

  group.add(sun, sun.target);
  return group;
}
