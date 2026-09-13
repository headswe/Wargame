import * as THREE from 'three';
import { type Vec2, dist, normalize, sub } from '../sim/math.ts';
import { Faction, UnitState } from '../sim/units.ts';
import type { Sim } from '../sim/sim.ts';
import { THEME } from './theme.ts';

const MAX_PATCHES = 300;
const MAX_GHOSTS = 48;
const COVER_PREVIEW_RADIUS = 10;
/** How far out the notional threat sits when scoring ground. */
const THREAT_DISTANCE = 70;

/**
 * The readability layer.
 *
 * With cover measured rather than tabulated, there are no cover nodes left to
 * draw pips on — and what replaces them is better. Hovering an order samples
 * the ground the team would occupy and colours each candidate by how much of a
 * man would show from the direction the trouble is in. The player reads the
 * actual answer to the actual question, including for ground whose cover comes
 * from a fold in the earth rather than from anything you could point at.
 */
export class Markers {
  readonly group = new THREE.Group();

  private readonly patches: THREE.InstancedMesh;
  private readonly ghosts: THREE.InstancedMesh;
  private readonly destination: THREE.Mesh;
  private readonly facingArrow: THREE.Mesh;
  private readonly objective: THREE.Mesh;

  private readonly colour = new THREE.Color();
  private readonly good = new THREE.Color(0x5ad6b0);
  private readonly fair = new THREE.Color(0xd6b45a);
  private readonly bad = new THREE.Color(0xd65a5a);
  private readonly matrix = new THREE.Matrix4();

  private hover: Vec2 | null = null;
  private overlay = false;
  private pulse = 0;
  private refreshIn = 0;
  private lastSampledAt: Vec2 | null = null;

  constructor(sim: Sim) {
    this.group.name = 'markers';

    const patch = new THREE.CircleGeometry(0.55, 10);
    patch.rotateX(-Math.PI / 2);
    this.patches = new THREE.InstancedMesh(
      patch,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
      MAX_PATCHES,
    );
    this.patches.frustumCulled = false;
    this.patches.count = 0;
    this.patches.renderOrder = 20;
    this.group.add(this.patches);

    const ghostGeometry = new THREE.RingGeometry(0.5, 0.8, 16);
    ghostGeometry.rotateX(-Math.PI / 2);
    this.ghosts = new THREE.InstancedMesh(
      ghostGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.hostileAccent, transparent: true, opacity: 0.45, depthWrite: false,
      }),
      MAX_GHOSTS,
    );
    this.ghosts.frustumCulled = false;
    this.ghosts.count = 0;
    this.ghosts.renderOrder = 21;
    this.group.add(this.ghosts);

    const destGeometry = new THREE.RingGeometry(0.9, 1.2, 24);
    destGeometry.rotateX(-Math.PI / 2);
    this.destination = new THREE.Mesh(
      destGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.playerAccent, transparent: true, opacity: 0.8, depthWrite: false,
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
        color: THEME.playerAccent, transparent: true, opacity: 0.65, depthWrite: false,
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

  toggleCoverOverlay(): boolean {
    this.overlay = !this.overlay;
    this.lastSampledAt = null;
    return this.overlay;
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
    this.updateCover(sim, selectedSquads);
    this.updateGhosts(sim);
  }

  /**
   * Sampling cover costs a couple of hundred sightlines, so it is recomputed
   * only when the cursor has actually moved somewhere new — at a few hundred
   * microseconds a go that is free, but not free enough to redo every frame.
   */
  private updateCover(sim: Sim, selectedSquads: Set<number>): void {
    const active = this.overlay || (this.hover !== null && selectedSquads.size > 0);
    if (!active) {
      this.patches.count = 0;
      this.lastSampledAt = null;
      return;
    }
    const at = this.hover;
    if (!at) return;

    const moved = !this.lastSampledAt || dist(this.lastSampledAt, at) > 1.5;
    if (!moved && this.refreshIn > 0) return;
    this.refreshIn = 0.12;
    this.lastSampledAt = { ...at };

    const threatDir = inferThreat(sim, selectedSquads, at);
    const threat = {
      x: at.x + threatDir.x * THREAT_DISTANCE,
      y: at.y + threatDir.y * THREAT_DISTANCE,
    };
    const spots = sim.scene.findCover(at, COVER_PREVIEW_RADIUS, threat, { samples: 72 });

    let count = 0;
    for (const spot of spots) {
      if (count >= MAX_PATCHES) break;
      this.matrix.makeScale(1, 1, 1);
      this.matrix.setPosition(
        spot.pos.x, sim.scene.heightAt(spot.pos.x, spot.pos.y) + 0.08, spot.pos.y,
      );
      this.patches.setMatrixAt(count, this.matrix);

      // Green where little of you would show, red where all of you would.
      if (spot.exposure < 0.4) this.colour.copy(this.good).lerp(this.fair, spot.exposure / 0.4);
      else this.colour.copy(this.fair).lerp(this.bad, (spot.exposure - 0.4) / 0.6);
      // Ground you cannot shoot from is a hiding place, not a position.
      if (!spot.canFire) this.colour.multiplyScalar(0.4);
      this.patches.setColorAt(count, this.colour);
      count++;
    }

    this.patches.count = count;
    this.patches.instanceMatrix.needsUpdate = true;
    if (this.patches.instanceColor) this.patches.instanceColor.needsUpdate = true;
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
