import * as THREE from 'three';
import type { Vec2 } from '../sim/math.ts';
import type { IsoCamera } from '../render/camera.ts';
import { screenToGround } from '../render/camera.ts';

export interface ControlCallbacks {
  /** Pick whatever is under the cursor; returns the squad to select, if any. */
  squadAt(ground: Vec2): number | null;
  /** Squads with at least one operator inside a screen-space rectangle. */
  squadsInBox(min: THREE.Vector2, max: THREE.Vector2): number[];
  onSelect(squads: number[], additive: boolean): void;
  onOrder(dest: Vec2, sprint: boolean, facing: number | null): void;
  onHover(ground: Vec2 | null): void;
  onFacingDrag(from: Vec2, angle: number): void;
  onFacingDragEnd(): void;
  onSelectSquadIndex(index: number): void;
  onCycleSquad(): void;
  onCentreOnSelection(): void;
  onToggleCoverOverlay(): void;
  /** Throw something at the ground under the cursor. */
  onThrow(kind: 'frag' | 'smoke'): void;
  /** Rake the ground under the cursor. */
  onSuppress(): void;
}

/** Two right-clicks inside this window mean "run", not "walk". */
const DOUBLE_CLICK_MS = 320;
const DOUBLE_CLICK_DISTANCE = 2.0;
/** Past this drag distance a right-click is setting a facing, not a destination. */
const FACING_DRAG_MIN = 0.9;
const BOX_SELECT_MIN_PX = 6;

export class Controls {
  private readonly raycaster = new THREE.Raycaster();
  private readonly scratch = new THREE.Vector3();
  private readonly keys = new Set<string>();

  private ground: Vec2 | null = null;

  private leftDownScreen: THREE.Vector2 | null = null;
  private boxing = false;

  private rightDownGround: Vec2 | null = null;
  private lastRightUpAt = 0;
  private lastRightUpGround: Vec2 | null = null;

  private middleDragging = false;
  private lastPointer = new THREE.Vector2();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly iso: IsoCamera,
    private readonly selectionBox: HTMLElement,
    private readonly callbacks: ControlCallbacks,
  ) {
    canvas.addEventListener('contextmenu', this.preventDefault);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearKeys);
  }

  /** Release every listener. Restarting without this double-fires every input. */
  detach(): void {
    this.canvas.removeEventListener('contextmenu', this.preventDefault);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.clearKeys);
    this.selectionBox.style.display = 'none';
  }

  private preventDefault = (event: Event): void => event.preventDefault();
  private clearKeys = (): void => this.keys.clear();

  private toGround(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    if (!screenToGround(this.iso.camera, ndcX, ndcY, this.raycaster, this.scratch)) return null;
    return { x: this.scratch.x, y: this.scratch.z };
  }

  private onPointerDown = (event: PointerEvent): void => {
    const ground = this.toGround(event.clientX, event.clientY);
    this.lastPointer.set(event.clientX, event.clientY);

    if (event.button === 0) {
      this.leftDownScreen = new THREE.Vector2(event.clientX, event.clientY);
      this.boxing = false;
    } else if (event.button === 1) {
      this.middleDragging = true;
      event.preventDefault();
    } else if (event.button === 2) {
      this.rightDownGround = ground;
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const ground = this.toGround(event.clientX, event.clientY);
    this.ground = ground;
    this.callbacks.onHover(ground);

    if (this.middleDragging) {
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      this.iso.panScreen(-dx * 0.035, dy * 0.035);
    }
    this.lastPointer.set(event.clientX, event.clientY);

    if (this.leftDownScreen) {
      const dx = event.clientX - this.leftDownScreen.x;
      const dy = event.clientY - this.leftDownScreen.y;
      if (this.boxing || Math.hypot(dx, dy) > BOX_SELECT_MIN_PX) {
        this.boxing = true;
        this.drawSelectionBox(this.leftDownScreen, new THREE.Vector2(event.clientX, event.clientY));
      }
    }

    // Dragging out of a right-click aims the team rather than moving it further.
    if (this.rightDownGround && ground) {
      const dx = ground.x - this.rightDownGround.x;
      const dy = ground.y - this.rightDownGround.y;
      if (Math.hypot(dx, dy) > FACING_DRAG_MIN) {
        this.callbacks.onFacingDrag(this.rightDownGround, Math.atan2(dy, dx));
      } else {
        this.callbacks.onFacingDragEnd();
      }
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.button === 1) this.middleDragging = false;

    if (event.button === 0 && this.leftDownScreen) {
      const up = new THREE.Vector2(event.clientX, event.clientY);
      const additive = event.shiftKey;
      if (this.boxing) {
        const min = new THREE.Vector2(
          Math.min(this.leftDownScreen.x, up.x), Math.min(this.leftDownScreen.y, up.y),
        );
        const max = new THREE.Vector2(
          Math.max(this.leftDownScreen.x, up.x), Math.max(this.leftDownScreen.y, up.y),
        );
        this.callbacks.onSelect(this.callbacks.squadsInBox(min, max), additive);
      } else {
        const ground = this.toGround(event.clientX, event.clientY);
        const squad = ground ? this.callbacks.squadAt(ground) : null;
        this.callbacks.onSelect(squad === null ? [] : [squad], additive);
      }
      this.selectionBox.style.display = 'none';
      this.leftDownScreen = null;
      this.boxing = false;
    }

    if (event.button === 2 && this.rightDownGround) {
      const origin = this.rightDownGround;
      const release = this.toGround(event.clientX, event.clientY) ?? origin;
      const dragged = Math.hypot(release.x - origin.x, release.y - origin.y);

      let facing: number | null = null;
      if (dragged > FACING_DRAG_MIN) {
        facing = Math.atan2(release.y - origin.y, release.x - origin.x);
      }

      const now = performance.now();
      const quick = now - this.lastRightUpAt < DOUBLE_CLICK_MS;
      const nearby =
        this.lastRightUpGround !== null &&
        Math.hypot(origin.x - this.lastRightUpGround.x, origin.y - this.lastRightUpGround.y) <
          DOUBLE_CLICK_DISTANCE;
      // A second click on the same spot escalates the order to a sprint.
      const sprint = quick && nearby && facing === null;

      this.callbacks.onOrder(origin, sprint, facing);
      this.callbacks.onFacingDragEnd();

      this.lastRightUpAt = now;
      this.lastRightUpGround = origin;
      this.rightDownGround = null;
    }
  };

  private drawSelectionBox(from: THREE.Vector2, to: THREE.Vector2): void {
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    this.selectionBox.style.display = 'block';
    this.selectionBox.style.left = `${left}px`;
    this.selectionBox.style.top = `${top}px`;
    this.selectionBox.style.width = `${Math.abs(to.x - from.x)}px`;
    this.selectionBox.style.height = `${Math.abs(to.y - from.y)}px`;
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.iso.zoomBy(Math.sign(event.deltaY) * 0.12);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    this.keys.add(key);

    if (key === 'q') this.iso.rotate(-1);
    else if (key === 'e') this.iso.rotate(1);
    else if (key === 'tab') {
      event.preventDefault();
      this.callbacks.onCycleSquad();
    } else if (key === ' ') {
      event.preventDefault();
      this.callbacks.onCentreOnSelection();
    } else if (key === 'f') this.callbacks.onToggleCoverOverlay();
    else if (key === 'g') this.callbacks.onThrow('frag');
    else if (key === 't') this.callbacks.onThrow('smoke');
    else if (key === 'r') this.callbacks.onSuppress();
    else if (key >= '1' && key <= '3') this.callbacks.onSelectSquadIndex(Number(key) - 1);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  /** Keyboard panning, applied per frame so it scales with the frame rate. */
  update(dt: number): void {
    const speed = 26 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= speed;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += speed;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy += speed;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy -= speed;
    if (dx !== 0 || dy !== 0) this.iso.panScreen(dx, dy);
  }

  get hoverGround(): Vec2 | null {
    return this.ground;
  }
}
