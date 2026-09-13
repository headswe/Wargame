import { type Vec2, dist, vec } from './math.ts';
import { Rng } from './rng.ts';
import { type LevelDef, createScene } from './levels.ts';
import type { Scene } from './world/scene.ts';
import { Stature } from './world/occlusion.ts';
import {
  Faction, MoveMode, UnitState, WEAPONS, type Role, type Unit, makeUnit, resetUnitIds,
} from './units.ts';
import { type Squad, type SquadOrder, assignSlots } from './squads.ts';
import type { Effect } from './combat.ts';
import { type SimContext, updateSquad, updateUnit } from './ai.ts';

export const MissionState = { InProgress: 0, Won: 1, Lost: 2 } as const;
export type MissionState = (typeof MissionState)[keyof typeof MissionState];

/** Vision is recomputed on its own clock; nothing needs it at 60 Hz. */
const VISIBILITY_HZ = 7;
const VISION_RANGE = 85;
const CONE_HALF = (58 * Math.PI) / 180;
const AWARENESS_RADIUS = 7;
/** Fog is tracked coarser than the simulation — it only has to look right. */
const FOG_CELL = 1;

const TEAM_NAMES = ['ALPHA', 'BRAVO', 'CHARLIE'];
const FIRETEAM: { role: Role; weapon: keyof typeof WEAPONS }[] = [
  { role: 'Team Leader', weapon: 'carbine' },
  { role: 'Automatic Rifleman', weapon: 'saw' },
  { role: 'Rifleman', weapon: 'carbine' },
  { role: 'Marksman', weapon: 'dmr' },
];

const OPERATOR_NAMES = [
  'Voss', 'Kessler', 'Marek', 'Dunn',
  'Aleksy', 'Ruiz', 'Halvorsen', 'Baptiste',
  'Crane', 'Okafor', 'Sandoval', 'Thorne',
];

export class Sim implements SimContext {
  readonly scene: Scene;
  readonly rng: Rng;
  readonly units = new Map<number, Unit>();
  readonly unitList: Unit[] = [];
  readonly squads: Squad[] = [];
  effects: Effect[] = [];
  time = 0;

  readonly objective: Vec2;
  missionState: MissionState = MissionState.InProgress;

  readonly fogCols: number;
  readonly fogRows: number;
  readonly visibleTiles: Uint8Array;
  readonly exploredTiles: Uint8Array;
  private visibilityTimer = 0;

  constructor(level: LevelDef, seed = 1337) {
    this.scene = createScene(level);
    this.rng = new Rng(seed);

    this.fogCols = Math.ceil(this.scene.width / FOG_CELL);
    this.fogRows = Math.ceil(this.scene.height / FOG_CELL);
    this.visibleTiles = new Uint8Array(this.fogCols * this.fogRows);
    this.exploredTiles = new Uint8Array(this.fogCols * this.fogRows);
    this.objective = this.scene.spawns.objectives[0] ?? vec(this.scene.width / 2, 20);

    this.spawnPlayerSquads();
    this.spawnHostiles();
    this.recomputeVisibility();
  }

  private place(u: Unit): void {
    // Nudge onto navigable ground if a level dropped someone in a wall.
    if (!this.scene.walkable(u.pos.x, u.pos.y)) {
      for (let r = 1; r <= 8 && !this.scene.walkable(u.pos.x, u.pos.y); r++) {
        for (let a = 0; a < 12; a++) {
          const angle = (a / 12) * Math.PI * 2;
          const p = { x: u.pos.x + Math.cos(angle) * r, y: u.pos.y + Math.sin(angle) * r };
          if (this.scene.walkable(p.x, p.y)) {
            u.pos = p;
            break;
          }
        }
      }
    }
    u.groundHeight = this.scene.heightAt(u.pos.x, u.pos.y);
    this.units.set(u.id, u);
    this.unitList.push(u);
  }

  private spawnPlayerSquads(): void {
    resetUnitIds();
    let nameIndex = 0;
    this.scene.spawns.teams.forEach((positions, squadIndex) => {
      if (positions.length === 0) return;
      const squad: Squad = {
        id: this.squads.length,
        name: TEAM_NAMES[squadIndex] ?? `TEAM ${squadIndex + 1}`,
        faction: Faction.Player,
        memberIds: [],
        order: null,
        threatDir: vec(0, -1),
      };
      positions.slice(0, FIRETEAM.length).forEach((pos, i) => {
        const spec = FIRETEAM[i];
        const unit = makeUnit({
          name: OPERATOR_NAMES[nameIndex++ % OPERATOR_NAMES.length],
          role: spec.role,
          faction: Faction.Player,
          squadId: squad.id,
          pos,
          weapon: WEAPONS[spec.weapon],
          facing: -Math.PI / 2,
        });
        this.place(unit);
        squad.memberIds.push(unit.id);
      });
      this.squads.push(squad);
    });
  }

  private spawnHostiles(): void {
    const squad: Squad = {
      id: this.squads.length,
      name: 'HOSTILE',
      faction: Faction.Hostile,
      memberIds: [],
      order: null,
      threatDir: vec(0, 1),
    };

    this.scene.spawns.enemies.forEach((spawn, i) => {
      const unit = makeUnit({
        name: spawn.heavy ? 'Gunner' : `Guard ${i + 1}`,
        role: spawn.heavy ? 'Automatic Rifleman' : 'Rifleman',
        faction: Faction.Hostile,
        squadId: squad.id,
        pos: spawn.pos,
        weapon: spawn.heavy ? WEAPONS.pkm : WEAPONS.ak,
        facing: Math.PI / 2,
        maxHp: 85,
      });
      this.place(unit);
      this.digIn(unit);
      squad.memberIds.push(unit.id);
    });

    this.squads.push(squad);
  }

  /**
   * Defenders start in a position rather than merely standing about. The threat
   * is taken to be the approach from the south, which is where the contract
   * says the client's problem is coming from.
   */
  private digIn(u: Unit): void {
    const threat = vec(u.pos.x, Math.min(this.scene.height - 2, u.pos.y + 60));
    const spots = this.scene.findCover(u.pos, 5, threat, {
      crouchTop: Stature.crouchedTop,
      eye: Stature.crouchedEye,
      samples: 24,
    });
    const pick = spots.find((s) => s.canFire) ?? spots[0];
    if (!pick) return;
    u.pos = { ...pick.pos };
    u.coverSpot = { ...pick.pos };
    u.groundHeight = this.scene.heightAt(u.pos.x, u.pos.y);
  }

  get playerSquads(): Squad[] {
    return this.squads.filter((s) => s.faction === Faction.Player);
  }

  membersOf(squad: Squad): Unit[] {
    return squad.memberIds.map((id) => this.units.get(id)).filter((u): u is Unit => !!u);
  }

  /** The player's only verb: send a team somewhere, at a tempo, facing a way. */
  orderSquad(squadId: number, dest: Vec2, mode: MoveMode, facing: number | null): void {
    const squad = this.squads[squadId];
    if (!squad || squad.faction !== Faction.Player) return;

    const order: SquadOrder = { dest: { ...dest }, mode, facing, issuedAt: this.time };
    squad.order = order;
    for (const u of this.membersOf(squad)) {
      u.moveMode = mode;
      u.path.length = 0;
      u.pathIndex = 0;
    }
    assignSlots(this.scene, squad, this.units, order);
  }

  update(dt: number): void {
    if (this.missionState !== MissionState.InProgress) return;

    this.time += dt;
    this.effects.length = 0;

    for (const squad of this.squads) updateSquad(this, squad);
    for (const u of this.unitList) updateUnit(this, u, dt);

    this.visibilityTimer -= dt;
    if (this.visibilityTimer <= 0) {
      this.visibilityTimer = 1 / VISIBILITY_HZ;
      this.recomputeVisibility();
    }

    this.evaluateMission();
  }

  private evaluateMission(): void {
    const playerAlive = this.unitList.some(
      (u) => u.faction === Faction.Player && u.state === UnitState.Active,
    );
    if (!playerAlive) {
      this.missionState = MissionState.Lost;
      return;
    }
    const hostilesLeft = this.unitList.some(
      (u) => u.faction === Faction.Hostile && u.state === UnitState.Active,
    );
    const onObjective = this.unitList.some(
      (u) =>
        u.faction === Faction.Player &&
        u.state === UnitState.Active &&
        dist(u.pos, this.objective) < 4,
    );
    if (!hostilesLeft && onObjective) this.missionState = MissionState.Won;
  }

  isVisible(x: number, y: number): boolean {
    const i = Math.floor(x / FOG_CELL);
    const j = Math.floor(y / FOG_CELL);
    if (i < 0 || j < 0 || i >= this.fogCols || j >= this.fogRows) return false;
    return this.visibleTiles[j * this.fogCols + i] === 1;
  }

  /** Whether the player currently has eyes on this unit. */
  canPlayerSee(u: Unit): boolean {
    if (u.faction === Faction.Player) return true;
    return this.isVisible(u.pos.x, u.pos.y);
  }

  /**
   * Viewshed, the classic way: walk each ray outward keeping the steepest
   * upward angle seen so far. Ground is visible when its own angle beats that
   * horizon, and anything standing on it raises the horizon for everything
   * behind. This is what puts real dead ground behind a ridge rather than
   * merely stopping the ray at walls.
   */
  private recomputeVisibility(): void {
    this.visibleTiles.fill(0);
    const { occlusion } = this.scene;

    for (const u of this.unitList) {
      if (u.faction !== Faction.Player || u.state === UnitState.Dead) continue;
      const eyeH = this.scene.heightAt(u.pos.x, u.pos.y) + Stature.standingEye;

      this.markDisc(u.pos, AWARENESS_RADIUS);

      const step = (2.4 * Math.PI) / 180;
      for (let a = u.facing - CONE_HALF; a <= u.facing + CONE_HALF; a += step) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let horizon = -Infinity;

        for (let r = 1; r <= VISION_RANGE; r += 1.1) {
          const x = u.pos.x + dx * r;
          const y = u.pos.y + dy * r;
          const i = Math.floor(x / FOG_CELL);
          const j = Math.floor(y / FOG_CELL);
          if (i < 0 || j < 0 || i >= this.fogCols || j >= this.fogRows) break;

          const blocked = occlusion.solidAt(x, y);
          const ground = this.scene.heightAt(x, y);
          const top = blocked > ground ? blocked : ground;

          // A man standing here would show above the horizon, so this ground
          // is worth marking seen.
          if ((ground + Stature.standingTop - eyeH) / r >= horizon) {
            const k = j * this.fogCols + i;
            this.visibleTiles[k] = 1;
            this.exploredTiles[k] = 1;
          }
          const angle = (top - eyeH) / r;
          if (angle > horizon) horizon = angle;
        }
      }
    }
  }

  private markDisc(centre: Vec2, radius: number): void {
    const r = Math.ceil(radius / FOG_CELL);
    const cx = Math.floor(centre.x / FOG_CELL);
    const cy = Math.floor(centre.y / FOG_CELL);
    for (let j = cy - r; j <= cy + r; j++) {
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || j < 0 || i >= this.fogCols || j >= this.fogRows) continue;
        if (Math.hypot(i - cx, j - cy) > r) continue;
        const k = j * this.fogCols + i;
        this.visibleTiles[k] = 1;
        this.exploredTiles[k] = 1;
      }
    }
  }
}
