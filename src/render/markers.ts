import * as THREE from 'three';
import { type Vec2, dot, normalize, sub } from '../sim/math.ts';
import type { World } from '../sim/world.ts';
import { Faction, UnitState } from '../sim/units.ts';
import type { Sim } from '../sim/sim.ts';
import { THEME } from './theme.ts';

const MAX_PIPS = 1800;
const MAX_GHOSTS = 48;
const COVER_PREVIEW_RADIUS = 5;

/**
 * The readability layer, and the reason an isometric 3D tactics game is
 * playable at all.
 *
 * A player looking at a 3D scene genuinely cannot tell which side of a wall is
 * safe. Cover pips answer that directly: a bar drawn on the face that protects
 * you, green where it is solid, amber where it is only waist-high.
 */
export class Markers {
  readonly group = new THREE.Group();

  private readonly pips: THREE.InstancedMesh;
  private readonly ghosts: THREE.InstancedMesh;
  private readonly destination: THREE.Mesh;
  private readonly facingArrow: THREE.Mesh;
  private readonly objective: THREE.Mesh;

  private readonly colour = new THREE.Color();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly position = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private hover: Vec2 | null = null;
  private hoverThreat: Vec2 = { x: 0, y: -1 };
  private pulse = 0;
  private coverOverlay = false;

  constructor(sim: Sim) {
    this.group.name = 'markers';

    const pipGeometry = new THREE.BoxGeometry(0.1, 0.06, 0.52);
    pipGeometry.translate(0.42, 0, 0);
    this.pips = new THREE.InstancedMesh(
      pipGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }),
      MAX_PIPS,
    );
    this.pips.frustumCulled = false;
    this.pips.count = 0;
    this.pips.renderOrder = 20;
    this.group.add(this.pips);

    const ghostGeometry = new THREE.RingGeometry(0.3, 0.45, 16);
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

    const destGeometry = new THREE.RingGeometry(0.55, 0.75, 24);
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
    arrowShape.moveTo(0, -0.22);
    arrowShape.lineTo(1.5, -0.22);
    arrowShape.lineTo(1.5, -0.5);
    arrowShape.lineTo(2.3, 0);
    arrowShape.lineTo(1.5, 0.5);
    arrowShape.lineTo(1.5, 0.22);
    arrowShape.lineTo(0, 0.22);
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

    const objectiveGeometry = new THREE.RingGeometry(0.8, 1.05, 28);
    objectiveGeometry.rotateX(-Math.PI / 2);
    this.objective = new THREE.Mesh(
      objectiveGeometry,
      new THREE.MeshBasicMaterial({
        color: THEME.objective, transparent: true, opacity: 0.7, depthWrite: false,
      }),
    );
    this.objective.position.set(sim.objective.x, 0.05, sim.objective.y);
    this.objective.renderOrder = 22;
    this.group.add(this.objective);
  }

  toggleCoverOverlay(): boolean {
    this.coverOverlay = !this.coverOverlay;
    return this.coverOverlay;
  }

  setHover(pos: Vec2 | null, threat: Vec2 | null): void {
    this.hover = pos;
    if (threat) this.hoverThreat = threat;
  }

  showFacingArrow(from: Vec2, angle: number): void {
    this.facingArrow.visible = true;
    this.facingArrow.position.set(from.x, 0.07, from.y);
    this.facingArrow.rotation.y = -angle;
  }

  hideFacingArrow(): void {
    this.facingArrow.visible = false;
  }

  update(sim: Sim, selectedSquads: Set<number>, dt: number): void {
    this.pulse += dt;
    const breathe = 1 + Math.sin(this.pulse * 2.4) * 0.06;
    this.objective.scale.set(breathe, 1, breathe);
    this.objective.visible = sim.isVisible(
      Math.floor(sim.objective.x), Math.floor(sim.objective.y),
    ) || sim.exploredTiles[Math.floor(sim.objective.y) * sim.world.width + Math.floor(sim.objective.x)] === 1;

    this.destination.visible = this.hover !== null;
    if (this.hover) this.destination.position.set(this.hover.x, 0.05, this.hover.y);

    this.updatePips(sim, selectedSquads);
    this.updateGhosts(sim);
  }

  /**
   * Two sources of pips: cover the selected team is currently holding (so you
   * can see what they are protected from right now), and cover around the
   * cursor (so you can see what an order would buy you before you give it).
   */
  private updatePips(sim: Sim, selectedSquads: Set<number>): void {
    let count = 0;

    const draw = (pos: Vec2, dir: Vec2, value: number, aligned: boolean): void => {
      if (count >= MAX_PIPS) return;
      this.position.set(pos.x, 0.05, pos.y);
      this.quaternion.setFromAxisAngle(this.up, -Math.atan2(dir.y, dir.x));
      this.scale.set(1, 1, value > 0.7 ? 1 : 0.8);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.pips.setMatrixAt(count, this.matrix);
      this.colour
        .set(value > 0.7 ? THEME.coverPip : THEME.coverPipWeak)
        .multiplyScalar(aligned ? 1 : 0.45);
      this.pips.setColorAt(count, this.colour);
      count++;
    };

    for (const unit of sim.unitList) {
      if (unit.faction !== Faction.Player || unit.state !== UnitState.Active) continue;
      if (!selectedSquads.has(unit.squadId) || !unit.claimedNode) continue;
      if (Math.hypot(unit.pos.x - unit.claimedNode.pos.x, unit.pos.y - unit.claimedNode.pos.y) > 0.5) continue;
      for (const arc of unit.claimedNode.arcs) {
        draw(unit.claimedNode.pos, arc.dir, arc.value, true);
      }
    }

    const world: World = sim.world;
    if (this.coverOverlay) {
      // Every piece of cover the player has actually laid eyes on.
      for (const node of world.coverNodes) {
        if (sim.exploredTiles[node.ty * world.width + node.tx] !== 1) continue;
        for (const arc of node.arcs) {
          draw(node.pos, arc.dir, arc.value, dot(arc.dir, this.hoverThreat) > 0.2);
        }
      }
    } else if (this.hover && selectedSquads.size > 0) {
      for (const node of world.coverNear(this.hover, COVER_PREVIEW_RADIUS)) {
        for (const arc of node.arcs) {
          // Dim the arcs that face the wrong way — they are cover from
          // something, but not from what the team is about to face.
          const aligned = dot(arc.dir, this.hoverThreat) > 0.2;
          draw(node.pos, arc.dir, arc.value, aligned);
        }
      }
    }

    this.pips.count = count;
    this.pips.instanceMatrix.needsUpdate = true;
    if (this.pips.instanceColor) this.pips.instanceColor.needsUpdate = true;
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
      this.matrix.makeTranslation(pos.x, 0.05, pos.y);
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
      const d = Math.hypot(memory.pos.x - dest.x, memory.pos.y - dest.y);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = memory.pos;
      }
    }
  }

  if (nearest && nearestDistance < 40) {
    const dir = normalize(sub(nearest, dest));
    if (dir.x !== 0 || dir.y !== 0) return dir;
  }
  return { x: 0, y: -1 };
}
