/**
 * A look-book for wall construction.
 *
 * Every fabric, at full health, battered and down, plus a corner of a building
 * with a door and a window in it — all at the game's own camera angle, lighting
 * and materials, so what you judge here is what you will see in play.
 *
 *   npm run dev   →   http://localhost:5173/walls.html
 */
import * as THREE from 'three';
import { vec } from '../sim/math.ts';
import { Scene } from '../sim/world/scene.ts';
import { Fabric, Solidity } from '../sim/world/geometry.ts';
import { building, rect, wall } from '../sim/world/builder.ts';
import { Surface } from '../sim/world/terrain.ts';
import { WallView } from '../render/walls.ts';
import { buildLighting } from '../render/world.ts';
import { THEME } from '../render/theme.ts';

const W = 86;
const H = 96;
const sim = new Scene(W, H);
sim.terrain.paint(vec(0, 0), vec(W, H), Surface.Dirt);

interface Sample { label: string; x: number; z: number; }
const samples: Sample[] = [];

/** One 9-metre run of something, laid out on a grid. */
function run(
  label: string, column: number, row: number,
  fabric: Fabric, top: number, thickness: number,
  wear = 1, solidity: Solidity = Solidity.Solid,
): void {
  const x = 18 + column * 25;
  const z = 12 + row * 17;
  const ids = wall(sim, {
    a: vec(x - 4.5, z), b: vec(x + 4.5, z),
    fabric, top, thickness, solidity,
  });
  for (const id of ids) {
    const s = sim.structures.segments[id];
    s.hp = s.maxHp * wear;
  }
  samples.push({ label, x, z });
}

// --- what each fabric is made of, at full height
run('brick', 0, 0, Fabric.Brick, 2.7, 0.8);
run('concrete', 1, 0, Fabric.Concrete, 3.1, 1.0);
run('metal', 2, 0, Fabric.Metal, 2.2, 0.5);
run('sandbag', 0, 1, Fabric.Sandbag, 0.95, 1.1, 1, Solidity.LowCover);
run('timber', 1, 1, Fabric.Timber, 1.6, 0.25);
run('rubble', 2, 1, Fabric.Rubble, 0.7, 1.0, 1, Solidity.LowCover);

// --- and what they look like as they come apart
run('brick — battered', 0, 2, Fabric.Brick, 2.7, 0.8, 0.45);
run('brick — spent', 1, 2, Fabric.Brick, 2.7, 0.8, 0.08);
run('sandbag — shot up', 2, 2, Fabric.Sandbag, 0.95, 1.1, 0.35, Solidity.LowCover);

// --- a wall with a door and a window in it, which is the whole reason for this
wall(sim, {
  a: vec(9, 63), b: vec(27, 63),
  fabric: Fabric.Brick, top: 2.7, thickness: 0.8,
  openings: [
    { at: 4.5, width: 1.1, kind: 'door' },
    { at: 11, width: 1.5, kind: 'window' },
    { at: 15, width: 1.5, kind: 'window' },
  ],
});
samples.push({ label: 'door + windows', x: 18, z: 63 });

// --- and a building, so corners and a roofline read too
building(sim, {
  footprint: rect(vec(52, 78), 20, 13, 0.15),
  fabric: Fabric.Brick, wallTop: 2.7,
  openings: [
    { side: 2, at: 'centre', width: 1.1, kind: 'door' },
    { side: 2, at: 4, width: 1.4, kind: 'window' },
    { side: 2, at: 16, width: 1.4, kind: 'window' },
    { side: 1, at: 'centre', width: 1.4, kind: 'window' },
    { side: 0, at: 'centre', width: 1.4, kind: 'window' },
  ],
});
samples.push({ label: 'house', x: 52, z: 78 });

sim.bake();

// ------------------------------------------------------------------ render
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10120f);
scene.add(buildLighting(sim));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(W, H),
  new THREE.MeshLambertMaterial({ color: THEME.ground }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(W / 2, 0, H / 2);
ground.receiveShadow = true;
scene.add(ground);

const walls = new WallView(sim);
scene.add(walls.mesh);

let zoom = 37;
let spin = Math.PI * 0.25;
const focus = new THREE.Vector3(W / 2 + 1, 0, H / 2 - 1);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);

function place(): void {
  const aspect = innerWidth / innerHeight;
  camera.left = -zoom * aspect;
  camera.right = zoom * aspect;
  camera.top = zoom;
  camera.bottom = -zoom;
  const pitch = 0.86;
  camera.position.set(
    focus.x + Math.cos(spin) * 120 * Math.cos(pitch),
    120 * Math.sin(pitch),
    focus.z + Math.sin(spin) * 120 * Math.cos(pitch),
  );
  camera.lookAt(focus);
  camera.updateProjectionMatrix();
}

const labels = document.getElementById('labels')!;
const tags = samples.map((s) => {
  const el = document.createElement('span');
  el.textContent = s.label;
  labels.appendChild(el);
  return { el, sample: s };
});

function draw(): void {
  place();
  renderer.render(scene, camera);
  const v = new THREE.Vector3();
  for (const { el, sample } of tags) {
    v.set(sample.x, 0, sample.z + 5.5).project(camera);
    el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  }
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  draw();
});
addEventListener('wheel', (e) => {
  zoom = Math.min(60, Math.max(6, zoom * (1 + Math.sign(e.deltaY) * 0.1)));
  draw();
});
let dragging = false;
addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  spin += e.movementX * 0.006;
  draw();
});

draw();
(window as unknown as { ready: boolean }).ready = true;
