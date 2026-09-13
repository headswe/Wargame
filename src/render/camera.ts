import * as THREE from 'three';

/**
 * Orthographic camera locked to a fixed elevation — a true isometric read, but
 * in 3D, so geometry still occludes, casts shadows and has thickness.
 *
 * Yaw snaps in 45-degree steps rather than free-spinning. A tactical player is
 * constantly relating what they see to a mental map of the compound, and a
 * camera that can rest at any angle quietly destroys that mental map.
 */
export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;

  /** Point on the ground the camera orbits. */
  readonly focus = new THREE.Vector3(31, 0, 30);
  private focusTarget = this.focus.clone();

  private yaw = Math.PI * 0.25;
  private yawTarget = this.yaw;

  /** Half-height of the view frustum in world units. Smaller is closer in. */
  private zoom = 12;
  private zoomTarget = this.zoom;

  private readonly elevation = (39 * Math.PI) / 180;
  private readonly distance = 80;

  private viewportWidth = 1;
  private viewportHeight = 1;

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.apply();
  }

  resize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.apply();
  }

  /** Pan in screen space, so dragging right always moves the map right. */
  panScreen(dx: number, dy: number): void {
    const forward = new THREE.Vector3(-Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
    // cross(forward, up) with up = +Y. Getting this the wrong way round yields
    // screen-LEFT, which reads as A and D being swapped at every rotation.
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    this.focusTarget.addScaledVector(right, dx);
    this.focusTarget.addScaledVector(forward, dy);
  }

  rotate(steps: number): void {
    this.yawTarget += (steps * Math.PI) / 4;
  }

  zoomBy(delta: number): void {
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget * (1 + delta), 6, 30);
  }

  clampFocus(width: number, height: number): void {
    this.focusTarget.x = THREE.MathUtils.clamp(this.focusTarget.x, -4, width + 4);
    this.focusTarget.z = THREE.MathUtils.clamp(this.focusTarget.z, -4, height + 4);
  }

  jumpTo(x: number, z: number): void {
    this.focusTarget.set(x, 0, z);
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 11);
    this.focus.lerp(this.focusTarget, k);
    this.yaw += (this.yawTarget - this.yaw) * k;
    this.zoom += (this.zoomTarget - this.zoom) * k;
    this.apply();
  }

  /** Current yaw, so ground markers can be laid out in screen-space terms. */
  get currentYaw(): number {
    return this.yaw;
  }

  private apply(): void {
    const aspect = this.viewportWidth / Math.max(1, this.viewportHeight);
    this.camera.left = -this.zoom * aspect;
    this.camera.right = this.zoom * aspect;
    this.camera.top = this.zoom;
    this.camera.bottom = -this.zoom;
    this.camera.updateProjectionMatrix();

    const horizontal = Math.cos(this.elevation) * this.distance;
    this.camera.position.set(
      this.focus.x + Math.cos(this.yaw) * horizontal,
      this.focus.y + Math.sin(this.elevation) * this.distance,
      this.focus.z + Math.sin(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.focus);
  }
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/** Where a screen position lands on the ground plane, in sim coordinates. */
export function screenToGround(
  camera: THREE.Camera,
  ndcX: number,
  ndcY: number,
  raycaster: THREE.Raycaster,
  out: THREE.Vector3,
): boolean {
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  return raycaster.ray.intersectPlane(GROUND, out) !== null;
}
