import * as THREE from 'three';
import { type Vec2, dist, fromAngle, normalize, sub } from '../sim/math.ts';
import { Faction, MoveMode, UnitState } from '../sim/units.ts';
import type { Sim } from '../sim/sim.ts';
import { Stature } from '../sim/world/occlusion.ts';
import { THEME } from './theme.ts';

const MAX_SLOTS = 32;
const MAX_GHOSTS = 48;
/** Half-width of the cover overlay grid, in cells. */
const OVERLAY_HALF = 8;
const OVERLAY_SPACING = 1.5;
const MAX_PATCHES = (OVERLAY_HALF * 2 + 1) ** 2;
/** How far out the notional threat sits when scoring ground. */
const THREAT_DISTANCE = 70;

/**
 * The readability layer.
 *
 * The question the player is asking as he moves the cursor is "what happens if
 * I send them there", and the only honest answer is the plan the order would
 * actually produce. So that is what is drawn: one marker per operator, on the
 * ground he would hold, coloured by how much of him would show and carrying a
 * chevron only if he could fight from it. Sampling the neighbourhood and
 * colouring every candidate — which is what used to happen here — answered a
 * question nobody was asking, in a cloud of two hundred dots.
 *
 * The sampled view survives as a deliberate overlay, on a regular grid so it
 * reads as a map of the ground rather than as scatter.
 */
export class Markers {
  readonly group = new THREE.Group();

  private readonly posts: THREE.InstancedMesh;
  private readonly chevrons: THREE.InstancedMesh;
  private readonly patches: THREE.InstancedMesh;
  private readonly ghosts: THREE.InstancedMesh;
  private readonly destination: THREE.Mesh;
  private readonly facingArrow: THREE.Mesh;
  private readonly objective: THREE.Mesh;

  private readonly colour = new THREE.Color();
  private readonly good = new THREE.Color(0x5ad6b0);
  private readonly fair = new THREE.Color(0xd6b45a);
  private readonly bad = new THREE.Color(0xd65a5a);
  /** Drained: a place to hide rather than a place to fight from. */
  private readonly blind = new THREE.Color(0x6b7078);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private readonly position = new THREE.Vector3();
  private readonly unitScale = new THREE.Vector3(1, 1, 1);

  private hover: Vec2 | null = null;
  /** The order being aimed right now, which outranks the cursor. */
  private aiming: { at: Vec2; facing: number | null } | null = null;
  private overlay = false;
  private pulse = 0;
  private refreshIn = 0;
  private lastPlannedAt: Vec2 | null = null;
  private lastPlannedFacing: number | null = null;
  /** Mean share of the sector the planned positions could engage. */
  plannedFire = 1;
  private lastSampledAt: Vec2 | null = null;

  constructor(sim: Sim) {
    this.group.name = 'markers';

    const post = new THREE.RingGeometry(0.56, 0.88, 22);
    post.rotateX(-Math.PI / 2);
    this.posts = this.instanced(post, 0.95, MAX_SLOTS, 23, false);

    // A chevron, pointed the way he would face. Its absence is information:
    // ground he can hide on but not shoot from gets no direction.
    const chevron = new THREE.Shape();
    chevron.moveTo(0.86, 0);
    chevron.lineTo(-0.34, 0.66);
    chevron.lineTo(-0.06, 0);
    chevron.lineTo(-0.34, -0.66);
    const chevronGeometry = new THREE.ShapeGeometry(chevron);
    chevronGeometry.rotateX(-Math.PI / 2);
    this.chevrons = this.instanced(chevronGeometry, 0.95, MAX_SLOTS, 24, false);

    const patch = new THREE.PlaneGeometry(OVERLAY_SPACING * 0.86, OVERLAY_SPACING * 0.86);
    patch.rotateX(-Math.PI / 2);
    this.patches = this.instanced(patch, 0.45, MAX_PATCHES, 20, true);

    const ghostGeometry = new THREE.RingGeometry(0.5, 0.8, 16);
    ghostGeometry.rotateX(-Math.PI / 2);
    this.ghosts = new THREE.InstancedMesh(
      ghostGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.hostileAccent, transparent: true, opacity: 0.5,
        depthWrite: false, depthTest: false,
      }),
      MAX_GHOSTS,
    );
    this.ghosts.frustumCulled = false;
    this.ghosts.count = 0;
    this.ghosts.renderOrder = 21;
    this.group.add(this.ghosts);

    const destGeometry = new THREE.RingGeometry(1.5, 1.75, 32);
    destGeometry.rotateX(-Math.PI / 2);
    this.destination = new THREE.Mesh(
      destGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.playerAccent, transparent: true, opacity: 0.5,
        depthWrite: false, depthTest: false,
      }),
    );
    this.destination.visible = false;
    this.destination.renderOrder = 22;
    this.group.add(this.destination);

    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, -0.3);
    arrowShape.lineTo(2.2, -0.3);
    arrowShape.lineTo(2.2, -0.75);
    arrowShape.lineTo(3.4, 0);
    arrowShape.lineTo(2.2, 0.75);
    arrowShape.lineTo(2.2, 0.3);
    arrowShape.lineTo(0, 0.3);
    const arrowGeometry = new THREE.ShapeGeometry(arrowShape);
    arrowGeometry.rotateX(-Math.PI / 2);
    this.facingArrow = new THREE.Mesh(
      arrowGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.playerAccent, transparent: true, opacity: 0.7,
        depthWrite: false, depthTest: false,
      }),
    );
    this.facingArrow.visible = false;
    this.facingArrow.renderOrder = 22;
    this.group.add(this.facingArrow);

    const objectiveGeometry = new THREE.RingGeometry(1.4, 1.9, 28);
    objectiveGeometry.rotateX(-Math.PI / 2);
    this.objective = new THREE.Mesh(
      objectiveGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.objective, transparent: true, opacity: 0.7, depthWrite: false,
      }),
    );
    this.objective.position.set(
      sim.objective.x,
      sim.scene.heightAt(sim.objective.x, sim.objective.y) + 0.12,
      sim.objective.y,
    );
    this.objective.renderOrder = 22;
    this.group.add(this.objective);
  }

  private instanced(
    geometry: THREE.BufferGeometry,
    opacity: number,
    count: number,
    order: number,
    depthTest: boolean,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, depthTest }),
      count,
    );
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = order;
    this.group.add(mesh);
    return mesh;
  }

  toggleCoverOverlay(): boolean {
    this.overlay = !this.overlay;
    this.lastSampledAt = null;
    if (!this.overlay) this.patches.count = 0;
    return this.overlay;
  }

  /**
   * The order the player is in the middle of giving.
   *
   * While the right button is down the destination is settled and only the
   * facing is still being chosen, so the preview has to stop following the
   * cursor: it was showing the plan for wherever the mouse had wandered to
   * while aiming, which is never the plan about to be bought. Passing the
   * facing through matters just as much — cover is measured against where the
   * trouble is, so a team aimed one way and a team aimed another want
   * different ground, and the player should see that happen as he turns.
   */
  setAiming(at: Vec2 | null, facing: number | null): void {
    this.aiming = at ? { at: { ...at }, facing } : null;
    // Whatever was planned is now for the wrong question.
    this.lastPlannedAt = null;
    this.lastPlannedFacing = null;
  }

  setHover(pos: Vec2 | null): void {
    this.hover = pos;
  }

  showFacingArrow(from: Vec2, angle: number, height: number): void {
    this.facingArrow.visible = true;
    this.facingArrow.position.set(from.x, height + 0.14, from.y);
    this.facingArrow.rotation.y = -angle;
  }

  hideFacingArrow(): void {
    this.facingArrow.visible = false;
  }

  update(sim: Sim, selectedSquads: Set<number>, dt: number): void {
    this.pulse += dt;
    const breathe = 1 + Math.sin(this.pulse * 2.4) * 0.06;
    this.objective.scale.set(breathe, 1, breathe);
    this.objective.visible = sim.isVisible(sim.objective.x, sim.objective.y)
      || sim.exploredTiles[Math.floor(sim.objective.y) * sim.fogCols + Math.floor(sim.objective.x)] === 1;

    this.destination.visible = this.hover !== null && selectedSquads.size > 0;
    if (this.hover && this.destination.visible) {
      this.destination.position.set(
        this.hover.x, sim.scene.heightAt(this.hover.x, this.hover.y) + 0.12, this.hover.y,
      );
    }

    this.refreshIn -= dt;
    this.updatePlan(sim, selectedSquads);
    this.updateOverlay(sim, selectedSquads);
    this.updateGhosts(sim);
    if (this.refreshIn <= 0) this.refreshIn = 0.1;
  }

  /**
   * The order, drawn before it is given.
   *
   * Planning costs a few hundred sightlines, so it is redone only when the
   * cursor has moved somewhere meaningfully different — the answer does not
   * change within half a metre, and nothing here is worth a millisecond a
   * frame.
   */
  private updatePlan(sim: Sim, selectedSquads: Set<number>): void {
    const at = this.aiming ? this.aiming.at : this.hover;
    const facing = this.aiming ? this.aiming.facing : null;
    if (!at || selectedSquads.size === 0) {
      this.posts.count = 0;
      this.chevrons.count = 0;
      this.lastPlannedAt = null;
      return;
    }
    const moved = !this.lastPlannedAt || dist(this.lastPlannedAt, at) > 0.5
      || facing !== this.lastPlannedFacing;
    if (!moved && this.refreshIn > 0) return;
    this.lastPlannedAt = { ...at };
    this.lastPlannedFacing = facing;

    const slots = sim.previewOrder(selectedSquads, at, MoveMode.Tactical, facing);
    this.plannedFire = slots.length === 0
      ? 1 : slots.reduce((a, s) => a + s.fire, 0) / slots.length;

    let posts = 0;
    let chevrons = 0;
    for (const slot of slots) {
      if (posts >= MAX_SLOTS) break;
      const ground = sim.scene.heightAt(slot.pos.x, slot.pos.y);
      this.tint(slot.exposure, slot.fire);

      this.matrix.makeTranslation(slot.pos.x, ground + 0.1, slot.pos.y);
      this.posts.setMatrixAt(posts, this.matrix);
      this.posts.setColorAt(posts, this.colour);
      posts++;

      if (!slot.canFire) continue;
      const dir = fromAngle(slot.facing);
      this.position.set(slot.pos.x + dir.x * 1.3, ground + 0.1, slot.pos.y + dir.y * 1.3);
      this.quaternion.setFromAxisAngle(this.axis, -slot.facing);
      this.matrix.compose(this.position, this.quaternion, this.unitScale);
      this.chevrons.setMatrixAt(chevrons, this.matrix);
      this.chevrons.setColorAt(chevrons, this.colour);
      chevrons++;
    }

    this.posts.count = posts;
    this.chevrons.count = chevrons;
    this.flush(this.posts);
    this.flush(this.chevrons);
  }

  /**
   * The deliberate view: a map of how exposed the ground around the cursor is.
   *
   * On a regular grid rather than scattered samples, because the player is
   * reading terrain here, and terrain reads as a field.
   */
  private updateOverlay(sim: Sim, selectedSquads: Set<number>): void {
    const at = this.hover;
    if (!this.overlay || !at) {
      this.patches.count = 0;
      this.lastSampledAt = null;
      return;
    }
    const moved = !this.lastSampledAt || dist(this.lastSampledAt, at) > OVERLAY_SPACING;
    if (!moved && this.refreshIn > 0) return;
    this.lastSampledAt = { ...at };

    const threatDir = inferThreat(sim, selectedSquads, at);
    // Snap to a world-space lattice so the squares hold still as the cursor
    // crosses them, instead of crawling along with it.
    const originX = Math.round(at.x / OVERLAY_SPACING) * OVERLAY_SPACING;
    const originY = Math.round(at.y / OVERLAY_SPACING) * OVERLAY_SPACING;

    let count = 0;
    for (let j = -OVERLAY_HALF; j <= OVERLAY_HALF; j++) {
      for (let i = -OVERLAY_HALF; i <= OVERLAY_HALF; i++) {
        const x = originX + i * OVERLAY_SPACING;
        const y = originY + j * OVERLAY_SPACING;
        if (!sim.scene.walkable(x, y)) continue;
        const here = { x, y };
        const threat = { x: x + threatDir.x * THREAT_DISTANCE, y: y + threatDir.y * THREAT_DISTANCE };
        // The same measurement the planner uses, so the map and the markers
        // drawn on top of it cannot disagree.
        const stance = sim.scene.stance(
          here, sim.scene.threatArc(here, threat), Stature.crouchedTop, Stature.crouchedEye,
        );
        this.tint(stance.exposure, stance.canFire ? 1 : 0);
        this.matrix.makeTranslation(x, sim.scene.heightAt(x, y) + 0.06, y);
        this.patches.setMatrixAt(count, this.matrix);
        this.patches.setColorAt(count, this.colour);
        count++;
      }
    }
    this.patches.count = count;
    this.flush(this.patches);
  }

  /** Green where little of you would show, red where all of you would. */
  /**
   * How a planned position reads at a glance.
   *
   * Hue is how much of you shows; a position you cannot fight from is drained
   * of colour instead, because those are different facts and the player is
   * making a different decision about each. A row of grey posts means the wall
   * he is pointing at is somewhere to hide, not somewhere to fight — which
   * used to be silent, and is the single thing about an order it is most
   * expensive to learn afterwards.
   */
  private tint(exposure: number, fire: number): void {
    if (exposure < 0.4) this.colour.copy(this.good).lerp(this.fair, exposure / 0.4);
    else this.colour.copy(this.fair).lerp(this.bad, (exposure - 0.4) / 0.6);
    const useful = Math.min(1, fire / 0.3);
    this.colour.lerp(this.blind, 0.75 * (1 - useful));
  }

  private flush(mesh: THREE.InstancedMesh): void {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Last known positions. Contact you had and lost is information the player
   * should keep — it is the difference between "cleared" and "quiet".
   */
  private updateGhosts(sim: Sim): void {
    const remembered = new Map<number, Vec2>();
    for (const unit of sim.unitList) {
      if (unit.faction !== Faction.Player || unit.state === UnitState.Dead) continue;
      for (const [enemyId, memory] of unit.memory) {
        const enemy = sim.units.get(enemyId);
        if (enemy && sim.canPlayerSee(enemy) && enemy.state === UnitState.Active) continue;
        if (memory.age > 12) continue;
        if (!remembered.has(enemyId)) remembered.set(enemyId, memory.pos);
      }
    }

    let count = 0;
    for (const [, pos] of remembered) {
      if (count >= MAX_GHOSTS) break;
      this.matrix.makeTranslation(pos.x, sim.scene.heightAt(pos.x, pos.y) + 0.1, pos.y);
      this.ghosts.setMatrixAt(count++, this.matrix);
    }
    this.ghosts.count = count;
    this.ghosts.instanceMatrix.needsUpdate = true;
  }
}

/** Threat direction a team would face if ordered to `dest` right now. */
export function inferThreat(sim: Sim, squadIds: Set<number>, dest: Vec2): Vec2 {
  let nearest: Vec2 | null = null;
  let nearestDistance = Infinity;

  for (const unit of sim.unitList) {
    if (unit.faction !== Faction.Player || !squadIds.has(unit.squadId)) continue;
    for (const [, memory] of unit.memory) {
      const d = dist(memory.pos, dest);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = memory.pos;
      }
    }
  }

  if (nearest && nearestDistance < 90) {
    const dir = normalize(sub(nearest, dest));
    if (dir.x !== 0 || dir.y !== 0) return dir;
  }
  return { x: 0, y: -1 };
}
