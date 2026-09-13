import * as THREE from 'three';

import './ui/style.css';

import { STEPOVE } from './sim/levels.ts';
import { MissionState, Sim } from './sim/sim.ts';
import { Faction, MoveMode, Posture, UnitState } from './sim/units.ts';
import type { Vec2 } from './sim/math.ts';

import { IsoCamera } from './render/camera.ts';
import { LevelView, buildLighting } from './render/level.ts';
import { UnitViews } from './render/units.ts';
import { FogOfWar } from './render/fog.ts';
import { Effects } from './render/effects.ts';
import { Markers, inferThreat } from './render/markers.ts';

import { Controls } from './input/controls.ts';
import { Hud } from './ui/hud.ts';

/** The simulation runs on a fixed step regardless of frame rate. */
const TICK = 1 / 60;
const MAX_TICKS_PER_FRAME = 5;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const selectionBox = document.getElementById('selection-box') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f0d);

const iso = new IsoCamera();

class Mission {
  readonly sim: Sim;
  private readonly root = new THREE.Group();
  private readonly levelView: LevelView;
  private readonly unitViews: UnitViews;
  private readonly fog: FogOfWar;
  private readonly effects = new Effects();
  private readonly markers: Markers;
  private readonly hud: Hud;
  private readonly controls: Controls;

  private readonly selected = new Set<number>();
  private hover: Vec2 | null = null;
  /** Previous per-unit state, so alerts fire on transitions rather than every frame. */
  private readonly lastState = new Map<number, UnitState>();
  private readonly lastPinned = new Map<number, boolean>();
  private readonly contacted = new Set<number>();

  constructor(seed: number, onRestart: () => void) {
    this.sim = new Sim(STEPOVE, seed);

    this.fog = new FogOfWar(this.sim);
    this.root.add(buildLighting(this.sim.world));
    this.levelView = new LevelView(this.sim.world, this.fog);
    this.root.add(this.levelView.group);

    this.unitViews = new UnitViews(this.sim);
    this.markers = new Markers(this.sim);
    this.root.add(this.unitViews.group, this.effects.group, this.markers.group);
    scene.add(this.root);

    this.hud = new Hud(uiRoot, STEPOVE, this.sim, (id) => this.select([id], false), onRestart);

    this.controls = new Controls(canvas, iso, selectionBox, {
      squadAt: (ground) => {
        const unit = this.unitViews.pick(this.sim, ground.x, ground.y);
        return unit && unit.faction === Faction.Player ? unit.squadId : null;
      },
      squadsInBox: (min, max) => this.squadsInBox(min, max),
      onSelect: (squads, additive) => this.select(squads, additive),
      onOrder: (dest, sprint, facing) => this.order(dest, sprint, facing),
      onHover: (ground) => {
        this.hover = ground;
      },
      onFacingDrag: (from, angle) => this.markers.showFacingArrow(from, angle),
      onFacingDragEnd: () => this.markers.hideFacingArrow(),
      onSelectSquadIndex: (index) => {
        const squad = this.sim.playerSquads[index];
        if (squad) this.select([squad.id], false);
      },
      onCycleSquad: () => this.cycleSquad(),
      onCentreOnSelection: () => this.centreOnSelection(),
      onToggleCoverOverlay: () => {
        const on = this.markers.toggleCoverOverlay();
        this.hud.alert(on ? 'Cover overlay on' : 'Cover overlay off');
      },
    });

    // Open looking at the start line, not at the middle of the map.
    const spawn = this.sim.world.spawns.teams[1][0] ?? { x: 31, y: 32 };
    iso.jumpTo(spawn.x, spawn.y - 18);

    for (const unit of this.sim.unitList) this.lastState.set(unit.id, unit.state);
    this.hud.alert('Three fireteams on the start line. Do not walk in the front gate.');
  }

  dispose(): void {
    scene.remove(this.root);
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else if (material) material.dispose();
    });
    this.controls.detach();
  }

  private select(squads: number[], additive: boolean): void {
    if (!additive) this.selected.clear();
    for (const id of squads) {
      const squad = this.sim.squads[id];
      if (!squad || squad.faction !== Faction.Player) continue;
      // Selecting a team that has nobody left to give orders to is just noise.
      if (this.sim.membersOf(squad).every((u) => u.state !== UnitState.Active)) continue;
      this.selected.add(id);
    }
  }

  private cycleSquad(): void {
    const squads = this.sim.playerSquads.filter((s) =>
      this.sim.membersOf(s).some((u) => u.state === UnitState.Active),
    );
    if (squads.length === 0) return;
    const current = [...this.selected][0];
    const index = squads.findIndex((s) => s.id === current);
    this.select([squads[(index + 1) % squads.length].id], false);
  }

  private centreOnSelection(): void {
    const units = this.sim.unitList.filter(
      (u) => this.selected.has(u.squadId) && u.faction === Faction.Player && u.state === UnitState.Active,
    );
    if (units.length === 0) return;
    const x = units.reduce((a, u) => a + u.pos.x, 0) / units.length;
    const y = units.reduce((a, u) => a + u.pos.y, 0) / units.length;
    iso.jumpTo(x, y);
  }

  private order(dest: Vec2, sprint: boolean, facing: number | null): void {
    if (this.selected.size === 0) return;
    const mode = sprint ? MoveMode.Sprint : MoveMode.Tactical;
    const ids = [...this.selected];

    // Spread multiple teams around the order point instead of stacking them.
    ids.forEach((id, i) => {
      const offset = ids.length === 1 ? { x: 0, y: 0 } : spreadOffset(i, ids.length);
      this.sim.orderSquad(id, { x: dest.x + offset.x, y: dest.y + offset.y }, mode, facing);
    });

    if (sprint) {
      const names = ids.map((id) => this.sim.squads[id].name).join(', ');
      this.hud.alert(`${names} moving fast — weapons down`, 'info');
    }
  }

  private squadsInBox(min: THREE.Vector2, max: THREE.Vector2): number[] {
    const rect = canvas.getBoundingClientRect();
    const projected = new THREE.Vector3();
    const found = new Set<number>();

    for (const unit of this.sim.unitList) {
      if (unit.faction !== Faction.Player || unit.state !== UnitState.Active) continue;
      projected.set(unit.pos.x, 0.6, unit.pos.y).project(iso.camera);
      const sx = (projected.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-projected.y * 0.5 + 0.5) * rect.height + rect.top;
      if (sx >= min.x && sx <= max.x && sy >= min.y && sy <= max.y) found.add(unit.squadId);
    }
    return [...found];
  }

  private raiseAlerts(): void {
    for (const unit of this.sim.unitList) {
      const previous = this.lastState.get(unit.id);
      if (previous !== unit.state) {
        this.lastState.set(unit.id, unit.state);
        if (unit.faction === Faction.Player) {
          if (unit.state === UnitState.Down) this.hud.alert(`${unit.name} is down`, 'danger');
          else if (unit.state === UnitState.Dead) this.hud.alert(`${unit.name} — KIA`, 'danger');
        }
      }
    }

    for (const squad of this.sim.playerSquads) {
      const members = this.sim.membersOf(squad).filter((u) => u.state === UnitState.Active);
      const pinned = members.length > 0 && members.some((u) => u.posture === Posture.Pinned);
      if (pinned !== (this.lastPinned.get(squad.id) ?? false)) {
        this.lastPinned.set(squad.id, pinned);
        if (pinned) this.hud.alert(`${squad.name} pinned — they need covering fire`, 'danger');
      }
      if (!this.contacted.has(squad.id) && members.some((u) => u.visible.length > 0)) {
        this.contacted.add(squad.id);
        this.hud.alert(`${squad.name} in contact`);
      }
    }
  }

  update(dt: number): void {
    this.controls.update(dt);

    if (this.sim.missionState === MissionState.InProgress) {
      let ticks = 0;
      this.accumulator += dt;
      while (this.accumulator >= TICK && ticks < MAX_TICKS_PER_FRAME) {
        this.sim.update(TICK);
        // Effects are cleared at the top of every sim step, so they have to be
        // collected per step, not once per frame. Rounds fired inside the fog
        // stay in the fog — tracers would otherwise map the whole compound.
        this.effects.ingest(this.sim.effects, (x, y) =>
          this.sim.isVisible(Math.floor(x), Math.floor(y)),
        );
        this.accumulator -= TICK;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0;
    }

    this.raiseAlerts();

    const threat = this.hover ? inferThreat(this.sim, this.selected, this.hover) : null;
    this.markers.setHover(this.selected.size > 0 ? this.hover : null, threat);

    iso.clampFocus(this.sim.world.width, this.sim.world.height);
    iso.update(dt);

    this.levelView.update(this.sim.world);
    this.unitViews.update(this.sim, dt, this.selected, iso.camera.quaternion);
    this.fog.update(this.sim, dt);
    this.effects.update(dt);
    this.markers.update(this.sim, this.selected, dt);
    this.hud.update(this.sim, this.selected, dt);
  }

  private accumulator = 0;
}

/** Fan multiple selected teams out so one order does not stack them. */
function spreadOffset(index: number, total: number): Vec2 {
  const angle = (index / total) * Math.PI * 2;
  const radius = 2.2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

let mission: Mission;

function startMission(seed: number): void {
  mission?.dispose();
  uiRoot.innerHTML = '';
  mission = new Mission(seed, () => startMission(Math.floor(Math.random() * 1e6)));
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  iso.resize(width, height);
}

window.addEventListener('resize', resize);
resize();
startMission(1337);

/**
 * Test hook. Automated playtests need to turn a map position into a click, and
 * to read back whether an order actually took — neither is inspectable from
 * pixels alone.
 */
declare global {
  interface Window {
    wargame?: {
      worldToScreen(x: number, y: number): { x: number; y: number };
      snapshot(): unknown;
    };
  }
}

window.wargame = {
  worldToScreen(x, y) {
    const rect = canvas.getBoundingClientRect();
    const projected = new THREE.Vector3(x, 0.4, y).project(iso.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-projected.y * 0.5 + 0.5) * rect.height + rect.top,
    };
  },
  snapshot() {
    const sim = mission.sim;
    return {
      time: Number(sim.time.toFixed(2)),
      missionState: sim.missionState,
      camera: {
        yaw: Number(iso.currentYaw.toFixed(4)),
        x: Number(iso.camera.position.x.toFixed(2)),
        z: Number(iso.camera.position.z.toFixed(2)),
        focusX: Number(iso.focus.x.toFixed(2)),
        focusZ: Number(iso.focus.z.toFixed(2)),
      },
      units: sim.unitList.map((u) => ({
        id: u.id,
        name: u.name,
        faction: u.faction,
        squad: u.squadId,
        x: Number(u.pos.x.toFixed(2)),
        y: Number(u.pos.y.toFixed(2)),
        hp: Math.round(u.hp),
        state: u.state,
        mode: u.moveMode,
        pathLength: u.path.length,
        hasSlot: u.slot !== null,
        inCover: u.claimedNode !== null,
        suppression: Number(u.suppression.toFixed(2)),
        visible: u.visible.length,
      })),
    };
  },
};

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  mission.update(dt);
  renderer.render(scene, iso.camera);
});
