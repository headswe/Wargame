import * as THREE from 'three';
import { Faction, Posture, UnitState, type Unit } from '../sim/units.ts';
import type { Sim } from '../sim/sim.ts';
import { THEME } from './theme.ts';

const BODY_RADIUS = 0.2;
const BODY_LENGTH = 0.52;
const STAND_HEIGHT = BODY_RADIUS + BODY_LENGTH / 2 + 0.16;
/** Facing arc drawn under selected operators. Direction matters more than reach. */
const CONE_RANGE = 12;
/**
 * Four operators in one team means four overlapping wedges, so this has to be
 * faint enough to stack. At anything above ~0.04 a selected fireteam washes the
 * whole visible area in team colour and the ground stops reading.
 */
const CONE_OPACITY = 0.04;
const CONE_HALF = (58 * Math.PI) / 180;

interface UnitView {
  root: THREE.Group;
  body: THREE.Mesh;
  bodyMaterial: THREE.MeshLambertMaterial;
  muzzle: THREE.Mesh;
  /** Drawn through walls so you never lose track of your own people. */
  xray: THREE.Mesh | null;
  xrayMaterial: THREE.MeshBasicMaterial | null;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  cone: THREE.Mesh;
  coneMaterial: THREE.MeshBasicMaterial;
  bars: THREE.Group;
  health: THREE.Mesh;
  suppression: THREE.Mesh;
  shake: number;
}

const SQUAD_COLOURS = [0x4fd2e0, 0xe0c14f, 0x9be04f];

export class UnitViews {
  readonly group = new THREE.Group();
  private readonly views = new Map<number, UnitView>();
  private readonly bodyGeometry = new THREE.CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 4, 10);
  private readonly muzzleGeometry = new THREE.BoxGeometry(0.5, 0.07, 0.07);
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly barGeometry: THREE.PlaneGeometry;
  private readonly coneGeometry: THREE.CircleGeometry;

  constructor(sim: Sim) {
    this.group.name = 'units';

    this.ringGeometry = new THREE.RingGeometry(0.3, 0.38, 20);
    this.ringGeometry.rotateX(-Math.PI / 2);

    this.barGeometry = new THREE.PlaneGeometry(1, 1);
    this.barGeometry.translate(0.5, 0, 0);

    this.coneGeometry = new THREE.CircleGeometry(CONE_RANGE, 28, -CONE_HALF, CONE_HALF * 2);
    this.coneGeometry.rotateX(-Math.PI / 2);

    for (const unit of sim.unitList) this.views.set(unit.id, this.createView(unit));
  }

  private createView(unit: Unit): UnitView {
    const isPlayer = unit.faction === Faction.Player;
    const root = new THREE.Group();

    const bodyMaterial = new THREE.MeshLambertMaterial({
      color: isPlayer ? THEME.player : THEME.hostile,
    });
    const body = new THREE.Mesh(this.bodyGeometry, bodyMaterial);
    body.castShadow = true;
    body.position.y = STAND_HEIGHT;
    root.add(body);

    const muzzle = new THREE.Mesh(
      this.muzzleGeometry,
      new THREE.MeshLambertMaterial({ color: 0x3a3632 }),
    );
    muzzle.position.set(0.3, STAND_HEIGHT + 0.06, 0);
    root.add(muzzle);

    let xray: THREE.Mesh | null = null;
    let xrayMaterial: THREE.MeshBasicMaterial | null = null;
    if (isPlayer) {
      xrayMaterial = new THREE.MeshBasicMaterial({
        color: SQUAD_COLOURS[unit.squadId % SQUAD_COLOURS.length],
        transparent: true,
        opacity: 0.3,
        depthTest: false,
        depthWrite: false,
      });
      xray = new THREE.Mesh(this.bodyGeometry, xrayMaterial);
      xray.position.y = STAND_HEIGHT;
      xray.renderOrder = 900;
      root.add(xray);
    }

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: isPlayer ? SQUAD_COLOURS[unit.squadId % SQUAD_COLOURS.length] : THEME.hostileAccent,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
    ring.position.y = 0.03;
    root.add(ring);

    const coneMaterial = new THREE.MeshBasicMaterial({
      color: SQUAD_COLOURS[unit.squadId % SQUAD_COLOURS.length],
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(this.coneGeometry, coneMaterial);
    cone.position.y = 0.025;
    cone.visible = false;
    root.add(cone);

    const bars = new THREE.Group();
    bars.position.y = STAND_HEIGHT + 0.62;
    const health = new THREE.Mesh(
      this.barGeometry,
      new THREE.MeshBasicMaterial({ color: 0x6fd08a, depthTest: false, transparent: true }),
    );
    health.renderOrder = 950;
    health.scale.set(0.7, 0.07, 1);
    health.position.x = -0.35;
    const suppression = new THREE.Mesh(
      this.barGeometry,
      new THREE.MeshBasicMaterial({ color: THEME.suppressed, depthTest: false, transparent: true }),
    );
    suppression.renderOrder = 950;
    suppression.scale.set(0, 0.05, 1);
    suppression.position.set(-0.35, -0.1, 0);
    bars.add(health, suppression);
    root.add(bars);

    this.group.add(root);
    return {
      root, body, bodyMaterial, muzzle, xray, xrayMaterial,
      ring, ringMaterial, cone, coneMaterial, bars, health, suppression, shake: 0,
    };
  }

  update(sim: Sim, dt: number, selectedSquads: Set<number>, cameraQuat: THREE.Quaternion): void {
    for (const unit of sim.unitList) {
      const view = this.views.get(unit.id);
      if (!view) continue;

      const seen = sim.canPlayerSee(unit);
      view.root.visible = seen || unit.faction === Faction.Player;
      if (!view.root.visible) continue;

      // Suppressed men do not stand still. Small, but it reads instantly.
      view.shake = unit.state === UnitState.Active ? unit.suppression : 0;
      const jitter = view.shake * 0.045;
      view.root.position.set(
        unit.pos.x + (Math.random() - 0.5) * jitter,
        0,
        unit.pos.y + (Math.random() - 0.5) * jitter,
      );
      view.root.rotation.y = -unit.facing;

      this.applyPosture(view, unit);
      this.applyColour(view, unit);

      const isSelected = unit.faction === Faction.Player && selectedSquads.has(unit.squadId);
      // Every operator keeps a ground ring, so you can find your people at a
      // glance without selecting each team in turn to make them appear.
      view.ring.visible = unit.state !== UnitState.Dead;
      view.ringMaterial.opacity = isSelected ? 0.95 : unit.faction === Faction.Player ? 0.4 : 0.55;
      view.cone.visible = isSelected && unit.state === UnitState.Active;
      view.coneMaterial.opacity = isSelected ? CONE_OPACITY : 0;

      const showBars =
        unit.state === UnitState.Active && (unit.hp < unit.maxHp || unit.suppression > 0.05);
      view.bars.visible = showBars;
      if (showBars) {
        view.bars.quaternion.copy(cameraQuat);
        view.health.scale.x = 0.7 * (unit.hp / unit.maxHp);
        view.suppression.scale.x = 0.7 * unit.suppression;
      }
      void dt;
    }
  }

  private applyPosture(view: UnitView, unit: Unit): void {
    if (unit.state !== UnitState.Active) {
      // Down and dead lie flat. A silhouette on the ground is unmistakable.
      view.body.rotation.z = Math.PI / 2;
      view.body.position.y = BODY_RADIUS;
      view.muzzle.visible = false;
      if (view.xray) {
        view.xray.rotation.z = Math.PI / 2;
        view.xray.position.y = BODY_RADIUS;
      }
      return;
    }

    let crouch = 1;
    if (unit.posture === Posture.Pinned) crouch = 0.58;
    else if (unit.posture === Posture.Crouched) crouch = 0.76;

    view.body.rotation.z = 0;
    view.body.scale.y = crouch;
    view.body.position.y = STAND_HEIGHT * crouch;
    view.muzzle.visible = true;
    view.muzzle.position.y = STAND_HEIGHT * crouch + 0.06;
    // Weapon comes down when sprinting; that delay is a real cost in the sim,
    // so it should be visible before it bites.
    view.muzzle.rotation.z = (1 - unit.weaponReady) * 0.9;
    if (view.xray) {
      view.xray.rotation.z = 0;
      view.xray.scale.y = crouch;
      view.xray.position.y = STAND_HEIGHT * crouch;
    }
  }

  private applyColour(view: UnitView, unit: Unit): void {
    const base = new THREE.Color(
      unit.faction === Faction.Player ? THEME.player : THEME.hostile,
    );
    if (unit.state === UnitState.Down) base.set(THEME.downed);
    else if (unit.state === UnitState.Dead) base.set(THEME.dead);
    else if (unit.suppression > 0.05) {
      base.lerp(new THREE.Color(THEME.suppressed), unit.suppression * 0.55);
    }
    view.bodyMaterial.color.copy(base);

    if (view.xrayMaterial) {
      view.xrayMaterial.opacity = unit.state === UnitState.Active ? 0.28 : 0.15;
    }
  }

  /** Screen-space pick: nearest operator to a ground point, within a tile. */
  pick(sim: Sim, x: number, z: number): Unit | null {
    let best: Unit | null = null;
    let bestDistance = 1.1;
    for (const unit of sim.unitList) {
      if (unit.state === UnitState.Dead) continue;
      if (!sim.canPlayerSee(unit) && unit.faction !== Faction.Player) continue;
      const d = Math.hypot(unit.pos.x - x, unit.pos.y - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = unit;
      }
    }
    return best;
  }
}

export { SQUAD_COLOURS };
