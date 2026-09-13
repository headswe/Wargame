import * as THREE from 'three';
import { Tile, World } from '../sim/world.ts';
import type { FogOfWar } from './fog.ts';
import { THEME, tileJitter } from './theme.ts';

export const WALL_HEIGHT = 2.0;
export const LOW_HEIGHT = 0.8;

/**
 * All static geometry in a handful of draw calls. Walls and low cover are
 * instanced boxes; at greybox stage that is not a compromise, it is the look.
 */
export function buildLevel(world: World, fog: FogOfWar): THREE.Group {
  const group = new THREE.Group();
  group.name = 'level';

  group.add(buildGround(world));
  group.add(buildGrid(world));

  const walls: { x: number; y: number }[] = [];
  const lows: { x: number; y: number }[] = [];
  const doors: { x: number; y: number }[] = [];

  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const tile = world.at(x, y);
      if (tile === Tile.Wall) walls.push({ x, y });
      else if (tile === Tile.Low) lows.push({ x, y });
      else if (tile === Tile.Door) doors.push({ x, y });
    }
  }

  group.add(buildBlocks(walls, WALL_HEIGHT, THEME.wall, 0.16));
  group.add(buildBlocks(lows, LOW_HEIGHT, THEME.lowCover, 0.12));
  if (doors.length > 0) group.add(buildDoorMarkers(doors));

  group.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) return;
    if (Array.isArray(material)) material.forEach((m) => fog.applyTo(m));
    else fog.applyTo(material);
  });

  return group;
}

function buildGround(world: World): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(world.width, world.height);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(world.width / 2, 0, world.height / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: THEME.ground }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

/** A faint tile grid. Players judge distance and cover spacing off this. */
function buildGrid(world: World): THREE.LineSegments {
  const points: number[] = [];
  for (let x = 0; x <= world.width; x++) {
    points.push(x, 0.012, 0, x, 0.012, world.height);
  }
  for (let y = 0; y <= world.height; y++) {
    points.push(0, 0.012, y, world.width, 0.012, y);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.06 }),
  );
}

function buildBlocks(
  tiles: { x: number; y: number }[],
  height: number,
  color: number,
  jitterAmount: number,
): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, height, 1);
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, tiles.length));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = tiles.length;

  const matrix = new THREE.Matrix4();
  const base = new THREE.Color(color);
  const tinted = new THREE.Color();

  tiles.forEach((t, i) => {
    matrix.makeTranslation(t.x + 0.5, height / 2, t.y + 0.5);
    mesh.setMatrixAt(i, matrix);
    // Break up long runs so a wall does not read as one printed shape.
    const shade = 1 + tileJitter(t.x, t.y) * jitterAmount;
    tinted.copy(base).multiplyScalar(shade);
    mesh.setColorAt(i, tinted);
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** Doorways get a floor plate: they are funnels, and funnels should be visible. */
function buildDoorMarkers(doors: { x: number; y: number }[]): THREE.InstancedMesh {
  const geometry = new THREE.PlaneGeometry(0.92, 0.92);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: THEME.door, transparent: true, opacity: 0.5 }),
    doors.length,
  );
  const matrix = new THREE.Matrix4();
  doors.forEach((d, i) => {
    matrix.makeTranslation(d.x + 0.5, 0.02, d.y + 0.5);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Light rig. One sun with a tight shadow frustum over the whole map. */
export function buildLighting(world: World): THREE.Group {
  const group = new THREE.Group();

  const hemi = new THREE.HemisphereLight(THEME.sky, THEME.groundDark, 1.45);
  group.add(hemi);

  const sun = new THREE.DirectionalLight(THEME.sun, 1.5);
  sun.position.set(world.width * 0.35, 46, -world.height * 0.15);
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
  cam.far = 140;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.03;

  group.add(sun);
  group.add(sun.target);
  return group;
}
