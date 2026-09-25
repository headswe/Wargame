import * as THREE from 'three';

import './ui/style.css';

import { LEVELS } from './sim/levels.ts';
import { type LevelDef, defineLevel, migrate } from './sim/world/level-data.ts';
import { MissionState, Sim } from './sim/sim.ts';
import { Faction, MoveMode, Posture, UnitState } from './sim/units.ts';
import type { Vec2 } from './sim/math.ts';
import { spreadOffset } from './sim/squads.ts';
import { Ordnance } from './sim/ordnance.ts';
import { OrdnanceView } from './render/ordnance.ts';

import { IsoCamera } from './render/camera.ts';
import { THEME } from './render/theme.ts';
import { WorldView, buildLighting } from './render/world.ts';
import { UnitViews } from './render/units.ts';
import { FogOfWar } from './render/fog.ts';
import { Effects } from './render/effects.ts';
import { Markers } from './render/markers.ts';

import { Controls } from './input/controls.ts';
import { Hud } from './ui/hud.ts';
import { Menu, type Pick } from './ui/menu.ts';
import { savedLevel } from './library.ts';
import { MAPS, type Step } from './sim/plans.ts';

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
// Filmic rather than linear. Nothing was tone mapped at all, which is why a
// village of brick, grass and ploughed earth came out as three shades of the
// same mud: linear output crushes everything bright toward white and everything
// else into the middle, and the middle is where all of these colours live.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(THEME.haze);
// Far enough out that it never touches the fight, near enough that the map does
// not simply stop. The near distance is most of a map away.
scene.fog = new THREE.Fog(THEME.haze, 120, 460);

const iso = new IsoCamera();

/**
 * A level named in the address bar, which skips the picker entirely.
 *
 * The editor's playtest button leaves the level it is working on in session
 * storage first, so what runs is exactly what is on the author's screen rather
 * than the last thing he saved — which is the difference between a playtest
 * button and an export step. `?level=kolna` is the same door for a shipped map.
 */
function levelFromAddress(): LevelDef | null {
  try {
    const query = new URLSearchParams(location.search);
    if (query.has('playtest')) {
      const raw = sessionStorage.getItem('wargame.playtest');
      if (raw) return defineLevel(migrate(JSON.parse(raw)));
    }
    // ?level=kolna, for a shipped map — and for one of your own, since a level
    // that can only be reached by clicking through the picker cannot be linked
    // to, and the editor wants to hand you a link back to what you just made.
    const wanted = query.get('level');
    if (wanted) {
      const found = LEVELS.find((l) => l.id === wanted);
      if (found) return found;
      const own = savedLevel(wanted);
      if (own) return defineLevel(own.data);
      console.warn(`no level called "${wanted}" — have ${LEVELS.map((l) => l.id).join(', ')}`);
    }
  } catch (error) {
    console.warn('could not load that level, falling back to the picker:', error);
  }
  return null;
}

class Mission {
  readonly sim: Sim;
  private readonly root = new THREE.Group();
  private readonly worldView: WorldView;
  private readonly unitViews: UnitViews;
  private readonly fog: FogOfWar;
  private readonly effects = new Effects();
  private readonly markers: Markers;
  private readonly ordnanceView: OrdnanceView;
  private readonly hud: Hud;
  private readonly controls: Controls;

  private readonly selected = new Set<number>();
  private hover: Vec2 | null = null;
  /** Previous per-unit state, so alerts fire on transitions rather than every frame. */
  private readonly lastState = new Map<number, UnitState>();
  private readonly lastPinned = new Map<number, boolean>();
  private readonly contacted = new Set<number>();

  /** The scripted assault being watched, if this is a spectate. */
  private readonly script: Step[] | null;
  private scriptIndex = 0;

  constructor(level: LevelDef, seed: number, plan: string | null, onRestart: () => void) {
    this.script = plan ? MAPS[level.id]?.plans[plan] ?? null : null;
    this.sim = new Sim(level, seed);
    // Watching, not commanding: no decision is being taken on incomplete
    // information, so hiding half the fight only hides the fight.
    this.sim.revealAll = this.script !== null;

    this.fog = new FogOfWar(this.sim);
    this.root.add(buildLighting(this.sim.scene));
    this.worldView = new WorldView(this.sim.scene, this.fog);
    this.root.add(this.worldView.group);

    this.unitViews = new UnitViews(this.sim);
    this.markers = new Markers(this.sim);
    this.ordnanceView = new OrdnanceView();
    this.root.add(
      this.unitViews.group, this.effects.group, this.ordnanceView.group, this.markers.group,
    );
    scene.add(this.root);

    this.hud = new Hud(uiRoot, level, this.sim, (id) => this.select([id], false), onRestart);

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
      onFacingDrag: (from, angle) => {
        // The destination is settled the moment the button goes down; only the
        // aim is still being chosen. Freezing the preview there is what lets a
        // player point at a wall and then turn his men along it while watching
        // the positions move rather than guessing.
        this.markers.setAiming(from, angle);
        if (angle === null) this.markers.hideFacingArrow();
        else this.markers.showFacingArrow(from, angle, this.sim.scene.heightAt(from.x, from.y));
      },
      onFacingDragEnd: () => {
        this.markers.setAiming(null, null);
        this.markers.hideFacingArrow();
      },
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
      onThrow: (kind) => this.throwOrdnance(kind),
      onSuppress: () => this.suppress(),
    });

    // Open looking at the start line, not at the middle of the map: the middle
    // team if there is one, else whichever team has anybody in it. Reading the
    // second team outright threw on any level with only one — the editor's
    // blank level among them — and a playtest opened on an error.
    const { teams } = this.sim.scene.spawns;
    const spawn = teams[1]?.[0] ?? teams.find((team) => team.length > 0)?.[0]
      ?? { x: this.sim.scene.width / 2, y: this.sim.scene.height - 10 };
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

  /**
   * Put a grenade or a canister where the cursor is.
   *
   * Deliberately aimed at the ground rather than at a unit: the interesting
   * decision is which piece of ground stops being usable, and aiming at a man
   * would quietly turn a positional weapon into a targeted one.
   */
  private throwOrdnance(kind: 'frag' | 'smoke'): void {
    if (this.spectating || !this.hover || this.selected.size === 0) return;
    const ordnance = kind === 'frag' ? Ordnance.Frag : Ordnance.Smoke;
    const label = kind === 'frag' ? 'Frag' : 'Smoke';

    let thrown = 0;
    let outOfStock = 0;
    for (const id of this.selected) {
      if (this.sim.stock(id, ordnance) <= 0) {
        outOfStock++;
        continue;
      }
      if (this.sim.throwOrdnance(id, ordnance, this.hover)) thrown++;
    }

    if (thrown > 0) this.hud.alert(`${label} out`, 'info');
    else if (outOfStock === this.selected.size) this.hud.alert(`No ${label.toLowerCase()} left`, 'danger');
    else this.hud.alert(`${label}: too far, or no angle from there`, 'danger');
  }

  /** Hold and rake the ground under the cursor until ordered elsewhere. */
  private suppress(): void {
    if (this.spectating || !this.hover || this.selected.size === 0) return;
    let any = false;
    for (const id of this.selected) {
      if (this.sim.suppressArea(id, this.hover)) any = true;
    }
    this.hud.alert(
      any ? 'Suppressing' : 'No line to that ground from where they are',
      any ? 'info' : 'danger',
    );
  }

  private order(dest: Vec2, sprint: boolean, facing: number | null): void {
    if (this.spectating || this.selected.size === 0) return;
    const mode = sprint ? MoveMode.Sprint : MoveMode.Tactical;
    const ids = [...this.selected];

    // Spread multiple teams around the order point instead of stacking them.
    ids.forEach((id, i) => {
      const offset = spreadOffset(i, ids.length);
      this.sim.orderSquad(id, { x: dest.x + offset.x, y: dest.y + offset.y }, mode, facing);
    });

    if (sprint) {
      const names = ids.map((id) => this.sim.squads[id].name).join(', ');
      this.hud.alert(`${names} moving fast — weapons down`, 'info');
      return;
    }

    // Say it out loud when the ground he has picked cannot be fought from.
    // The posts go grey in the preview, but a player mid-assault is looking at
    // the firefight, and finding out afterwards that a team spent ninety
    // seconds hiding behind a wall it could not shoot over is the most
    // expensive way to learn it.
    const slots = this.sim.previewOrder(ids, dest, mode, facing);
    if (slots.length > 0 && slots.every((s) => s.fire < 0.08)) {
      const names = ids.map((id) => this.sim.squads[id].name).join(', ');
      this.hud.alert(`${names} can take cover there but cannot fire from it`, 'danger');
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

  /**
   * Issue whatever the scripted assault calls for by now.
   *
   * Stepped inside the fixed-timestep loop rather than once a frame, so the
   * plan fires at the sim times it was written for and what you watch is the
   * same run the harness scores rather than a near-miss of it.
   */
  private runScript(): void {
    if (!this.script) return;
    while (this.scriptIndex < this.script.length && this.script[this.scriptIndex].t <= this.sim.time) {
      const s = this.script[this.scriptIndex++];
      this.sim.orderSquad(s.squad, { x: s.x, y: s.y }, s.mode, -Math.PI / 2);
    }
  }

  /** Watching rather than commanding: the order verbs are not yours. */
  get spectating(): boolean {
    return this.script !== null;
  }

  update(dt: number): void {
    this.controls.update(dt);

    if (this.sim.missionState === MissionState.InProgress) {
      let ticks = 0;
      this.accumulator += dt;
      while (this.accumulator >= TICK && ticks < MAX_TICKS_PER_FRAME) {
        this.runScript();
        this.sim.update(TICK);
        // Effects are cleared at the top of every sim step, so they have to be
        // collected per step, not once per frame. Rounds fired inside the fog
        // stay in the fog — tracers would otherwise map the whole compound.
        this.effects.ingest(this.sim.effects, (x, y) => this.sim.isVisible(x, y));
        this.accumulator -= TICK;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0;
    }

    this.raiseAlerts();

    this.markers.setHover(this.hover);

    iso.clampFocus(this.sim.scene.width, this.sim.scene.height);
    iso.update(dt);

    this.worldView.update();
    // Roofs come off the buildings the player's own men have reached, and stay
    // on everywhere else. Only his own positions, so it can never become a way
    // of finding out who is inside somewhere he has not been.
    this.worldView.roofs.update(
      this.sim.unitList
        .filter((u) => u.faction === Faction.Player && u.state !== UnitState.Dead)
        .map((u) => u.pos),
      dt,
    );
    this.unitViews.update(this.sim, dt, this.selected, iso.camera.quaternion);
    this.fog.update(this.sim, dt);
    this.effects.update(dt);
    this.ordnanceView.update(this.sim, dt, this.sim.time);
    this.markers.update(this.sim, this.selected, dt);
    this.hud.update(this.sim, this.selected, dt);
  }

  private accumulator = 0;
}

let mission: Mission | null = null;

const spectating = document.createElement('div');
spectating.id = 'spectating';
document.body.append(spectating);

const menu = new Menu((pick) => startMission(pick));

function startMission(pick: Pick): void {
  mission?.dispose();
  uiRoot.innerHTML = '';
  // Ending a mission goes back to the picker rather than straight into another
  // run of the same one. Choosing again is the interesting moment.
  try {
    mission = new Mission(pick.level, pick.seed, pick.plan, () => menu.show());
  } catch (error) {
    // Now that levels can come from the editor rather than only from this
    // repository, one that cannot be built is a thing a player can actually
    // reach — an old save from before a rule tightened, say. A picker that
    // says which level failed and why is recoverable; a white screen is not.
    console.error(error);
    menu.complain(
      `"${pick.level.name}" would not start: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  spectating.classList.toggle('show', pick.plan !== null);
  spectating.textContent = pick.plan
    ? `spectating \u2014 ${pick.level.name}, the "${pick.plan}" plan` : '';
  // The controls card lists verbs that are not yours while watching, and a
  // panel telling you to right-click when right-clicking does nothing is worse
  // than no panel.
  document.body.classList.toggle('spectating', pick.plan !== null);
  if (pick.plan) {
    // Frame the whole contract rather than the start line, and look at it from
    // the attacker's side so the ground reads the way the plan is about to use
    // it.
    const { width, height } = pick.level.size;
    iso.frame(width / 2, height * 0.52, Math.max(width, height));
  }
}

addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  menu.show();
});

/**
 * The mission the debug hooks act on.
 *
 * Nothing is running until a contract is picked, and a browser check that
 * silently reads an empty world is worse than one that stops and says why.
 */
function running(): Mission {
  if (!mission) {
    throw new Error('no mission is running — pick a contract, or open ?level=<id>');
  }
  return mission;
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  iso.resize(width, height);
}

window.addEventListener('resize', resize);
resize();

// A level named in the address bar means somebody knows what they want —
// usually the editor, mid-playtest — so it skips the picker.
const named = levelFromAddress();
if (named) startMission({ level: named, plan: null, seed: 1337 });
else menu.show();

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
      lookAt(x: number, y: number): void;
      tryThrow(squadId: number, kind: number, x: number, y: number): boolean;
      ordnance(): { kind: number; landed: boolean; fuse: number }[];
      coverage(): Record<string, number>;
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
  lookAt(x, y) {
    iso.jumpTo(x, y);
  },
  tryThrow(squadId, kind, x, y) {
    return running().sim.throwOrdnance(squadId, kind as Ordnance, { x, y });
  },
  ordnance() {
    return running().sim.live.map((o) => ({
      kind: o.kind, landed: o.landed, fuse: Number(o.fuse.toFixed(2)),
    }));
  },
  /**
   * What fraction of the screen each named part of the world actually draws.
   *
   * Hide one, draw again, count the pixels that changed. It is deliberately not
   * a picture to compare against: a reference image has to be re-blessed every
   * time anything is restyled on purpose, and when it does fail it says
   * "pixels changed" and names no subsystem. This asks the one question this
   * renderer keeps getting wrong — is the thing on screen at all — and its
   * answer names exactly which view is missing.
   *
   * Shadows are off for the measurement, and that is the point rather than an
   * optimisation. The road ribbon once spent an entire session invisible in the
   * game while still casting a shadow, because the fog patch had been applied
   * to its material twice and the shader did not compile. Counted with shadows
   * on, that road covers a healthy slice of the screen and the bug sails
   * through.
   */
  coverage() {
    const canvasWidth = renderer.domElement.width;
    const canvasHeight = renderer.domElement.height;
    const gl = renderer.getContext();
    const shadows = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;

    const draw = (): Uint8Array => {
      renderer.render(scene, iso.camera);
      const pixels = new Uint8Array(canvasWidth * canvasHeight * 4);
      gl.readPixels(0, 0, canvasWidth, canvasHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };

    const parts: THREE.Object3D[] = [];
    const wanted = new Set([
      'terrain', 'roads', 'walls', 'roofs', 'props', 'foliage', 'units', 'markers',
    ]);
    scene.traverse((object) => {
      if (wanted.has(object.name)) parts.push(object);
    });

    const whole = draw();
    const covered: Record<string, number> = {};
    for (const part of parts) {
      part.visible = false;
      const without = draw();
      part.visible = true;
      let changed = 0;
      for (let i = 0; i < whole.length; i += 4) {
        if (whole[i] !== without[i] || whole[i + 1] !== without[i + 1]
          || whole[i + 2] !== without[i + 2]) changed++;
      }
      covered[part.name] = Number((changed / (canvasWidth * canvasHeight)).toFixed(4));
    }

    renderer.shadowMap.enabled = shadows;
    return covered;
  },
  snapshot() {
    const sim = running().sim;
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
        ammo: u.ammoInMag,
        raking: u.suppressAt !== null,
        nerve: Number(u.nerve.toFixed(2)),
        nerveState: u.nerveState,
        routing: u.routing,
        hasSlot: u.slot !== null,
        inCover: u.coverSpot !== null,
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
  mission?.update(dt);
  renderer.render(scene, iso.camera);
});
