import * as THREE from 'three';
import type { Vec2 } from '../sim/math.ts';
import type { Scene as SimScene } from '../sim/world/scene.ts';
import { WorldView, buildLighting } from '../render/world.ts';

/**
 * The window onto the level, drawn by the game's own renderer.
 *
 * Mounting `WorldView` rather than a second, editor-flavoured drawing of the
 * world is the one thing that matters here. An editor that renders its own
 * approximation is an editor that lies: the author lays out cover against a
 * picture nobody will ever play, and every disagreement between the two is a
 * bug he finds later and blames on the game.
 */

const HANDLE = 0x4fd2e0;
const SELECTED = 0xffe9a8;
const HOVER = 0x9be04f;

export interface Ray {
  world: Vec2;
  /** Whether the cursor found ground at all. */
  hit: boolean;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 800);

  focus = new THREE.Vector3(0, 0, 0);
  zoom = 46;
  yaw = Math.PI * 0.25;
  pitch = 0.86;

  private world: WorldView | null = null;
  private lighting: THREE.Group | null = null;
  private sim: SimScene | null = null;

  private readonly overlay = new THREE.Group();
  private readonly outlines: THREE.LineSegments;
  private readonly handles: THREE.InstancedMesh;
  private readonly markers: THREE.Group;
  private readonly grid: THREE.LineSegments;

  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x14171a);

    // Overlays sit on top of the world rather than inside it: an author needs
    // to see the handle on the far side of a building he is editing.
    this.outlines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
    );
    this.outlines.renderOrder = 10;
    this.outlines.frustumCulled = false;

    const pip = new THREE.OctahedronGeometry(0.5, 0);
    this.handles = new THREE.InstancedMesh(
      pip,
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
      512,
    );
    this.handles.renderOrder = 11;
    this.handles.frustumCulled = false;
    this.handles.count = 0;

    this.markers = new THREE.Group();
    this.markers.renderOrder = 9;

    this.grid = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x3a423f, transparent: true, opacity: 0.55 }),
    );
    this.grid.frustumCulled = false;

    this.overlay.add(this.grid, this.outlines, this.handles, this.markers);
    this.scene.add(this.overlay);
  }

  // -------------------------------------------------------------- the world

  /** Swap in a freshly built level. */
  setScene(sim: SimScene): void {
    if (this.world) {
      this.scene.remove(this.world.group);
      disposeTree(this.world.group);
    }
    if (this.lighting) this.scene.remove(this.lighting);

    this.sim = sim;
    this.world = new WorldView(sim);
    this.lighting = buildLighting(sim);
    this.scene.add(this.world.group, this.lighting);
    this.buildGrid(sim);
  }

  private buildGrid(sim: SimScene): void {
    const points: number[] = [];
    const step = 10;
    const y = 0.02;
    for (let x = 0; x <= sim.width + 0.01; x += step) {
      points.push(x, y, 0, x, y, sim.height);
    }
    for (let z = 0; z <= sim.height + 0.01; z += step) {
      points.push(0, y, z, sim.width, y, z);
    }
    // The boundary, drawn twice so it reads heavier than the ten-metre grid.
    for (const [ax, az, bx, bz] of [
      [0, 0, sim.width, 0], [sim.width, 0, sim.width, sim.height],
      [sim.width, sim.height, 0, sim.height], [0, sim.height, 0, 0],
    ]) {
      points.push(ax, y + 0.1, az, bx, y + 0.1, bz);
    }
    this.grid.geometry.dispose();
    this.grid.geometry = new THREE.BufferGeometry().setAttribute(
      'position', new THREE.Float32BufferAttribute(points, 3),
    );
  }

  setGridVisible(on: boolean): void {
    this.grid.visible = on;
  }

  // ------------------------------------------------------------- highlights

  /** Draw the runs belonging to whatever is selected and whatever is hovered. */
  showOutlines(
    selected: { points: Vec2[]; closed: boolean }[],
    hovered: { points: Vec2[]; closed: boolean }[],
  ): void {
    const position: number[] = [];
    const colour: number[] = [];
    const add = (runs: { points: Vec2[]; closed: boolean }[], hex: number, lift: number): void => {
      this.colour.setHex(hex);
      for (const run of runs) {
        const last = run.closed ? run.points.length : run.points.length - 1;
        for (let i = 0; i < last; i++) {
          const a = run.points[i];
          const b = run.points[(i + 1) % run.points.length];
          position.push(a.x, this.heightAt(a) + lift, a.y, b.x, this.heightAt(b) + lift, b.y);
          colour.push(this.colour.r, this.colour.g, this.colour.b);
          colour.push(this.colour.r, this.colour.g, this.colour.b);
        }
      }
    };
    add(hovered, HOVER, 0.22);
    add(selected, SELECTED, 0.3);

    this.outlines.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colour, 3));
    this.outlines.geometry = geometry;
  }

  /** Draggable points, scaled so they stay grabbable however far out you zoom. */
  showHandles(points: { pos: Vec2; active?: boolean }[]): void {
    const size = Math.max(0.35, this.zoom * 0.022);
    this.handles.count = Math.min(points.length, 512);
    points.slice(0, 512).forEach((handle, i) => {
      this.matrix.makeScale(size, size, size);
      this.matrix.setPosition(handle.pos.x, this.heightAt(handle.pos) + 0.5, handle.pos.y);
      this.handles.setMatrixAt(i, this.matrix);
      this.handles.setColorAt(i, this.colour.setHex(handle.active ? SELECTED : HANDLE));
    });
    this.handles.instanceMatrix.needsUpdate = true;
    if (this.handles.instanceColor) this.handles.instanceColor.needsUpdate = true;
  }

  /** Anything drawn as a free-standing marker: spawns, objectives, defenders. */
  setMarkers(build: (group: THREE.Group, heightAt: (p: Vec2) => number) => void): void {
    disposeTree(this.markers);
    this.markers.clear();
    build(this.markers, (p) => this.heightAt(p));
  }

  heightAt(p: Vec2): number {
    return this.sim ? this.sim.heightAt(p.x, p.y) : 0;
  }

  // ----------------------------------------------------------------- camera

  frame(width: number, height: number): void {
    this.focus.set(width / 2, 0, height / 2);
    this.zoom = Math.max(width, height) * 0.58;
  }

  pan(dxPixels: number, dyPixels: number, viewHeight: number): void {
    const perPixel = (this.zoom * 2) / viewHeight;
    const right = new THREE.Vector3(Math.cos(this.yaw + Math.PI / 2), 0, Math.sin(this.yaw + Math.PI / 2));
    const forward = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    this.focus.addScaledVector(right, -dxPixels * perPixel);
    this.focus.addScaledVector(forward, -dyPixels * perPixel / Math.max(0.2, Math.sin(this.pitch)));
  }

  zoomBy(delta: number): void {
    this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + delta), 4, 220);
  }

  orbit(dx: number, dy: number): void {
    this.yaw += dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy, 0.18, Math.PI / 2 - 0.02);
  }

  /** Straight down, which is how anyone actually lays a village out. */
  topDown(): void {
    this.pitch = Math.PI / 2 - 0.02;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  render(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    this.camera.left = -this.zoom * aspect;
    this.camera.right = this.zoom * aspect;
    this.camera.top = this.zoom;
    this.camera.bottom = -this.zoom;
    const dist = 400;
    this.camera.position.set(
      this.focus.x + Math.cos(this.yaw) * dist * Math.cos(this.pitch),
      dist * Math.sin(this.pitch),
      this.focus.z + Math.sin(this.yaw) * dist * Math.cos(this.pitch),
    );
    this.camera.lookAt(this.focus);
    this.camera.updateProjectionMatrix();
    if (this.world) this.world.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- picking

  /**
   * Where on the ground a pixel points.
   *
   * Marched rather than raycast against the terrain mesh: the ground is forty
   * thousand triangles and this runs on every mouse move, while walking the ray
   * and sampling the heightfield is a handful of bilinear lookups and gets the
   * answer on the surface the simulation actually uses rather than on the one
   * the renderer happens to have tessellated.
   */
  screenToWorld(px: number, py: number, width: number, height: number): Ray {
    const ndc = new THREE.Vector3((px / width) * 2 - 1, -(py / height) * 2 + 1, -1);
    ndc.unproject(this.camera);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    const sample = (t: number): number => {
      const x = ndc.x + dir.x * t;
      const z = ndc.z + dir.z * t;
      const y = ndc.y + dir.y * t;
      return y - (this.sim ? this.sim.heightAt(x, z) : 0);
    };

    let previous = sample(0);
    for (let t = 2; t <= 900; t += 2) {
      const value = sample(t);
      if (previous > 0 && value <= 0) {
        // Crossed the surface somewhere in the last two metres; close in on it.
        let lo = t - 2;
        let hi = t;
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) / 2;
          if (sample(mid) > 0) lo = mid;
          else hi = mid;
        }
        const at = (lo + hi) / 2;
        return { world: { x: ndc.x + dir.x * at, y: ndc.z + dir.z * at }, hit: true };
      }
      previous = value;
    }
    // Nothing under the cursor: fall back to the y=0 plane so a drag off the
    // edge of the map still tracks instead of freezing.
    const t = dir.y === 0 ? 0 : -ndc.y / dir.y;
    return { world: { x: ndc.x + dir.x * t, y: ndc.z + dir.z * t }, hit: false };
  }

  worldToScreen(p: Vec2, width: number, height: number): { x: number; y: number } {
    const v = new THREE.Vector3(p.x, this.heightAt(p), p.y).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
  }

  /** Metres per pixel, for turning a grab radius in pixels into one in metres. */
  metresPerPixel(viewHeight: number): number {
    return (this.zoom * 2) / Math.max(1, viewHeight);
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
}
