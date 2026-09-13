import { type Vec2, dist, vec } from './math.ts';
import { Rng } from './rng.ts';
import { Tile, World } from './world.ts';
import { createWorld, type LevelDef } from './levels.ts';
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
  readonly world: World;
  readonly rng: Rng;
  readonly units = new Map<number, Unit>();
  readonly unitList: Unit[] = [];
  readonly squads: Squad[] = [];
  effects: Effect[] = [];
  time = 0;

  readonly objective: Vec2;
  missionState: MissionState = MissionState.InProgress;

  /** 1 where the player can see right now. */
  readonly visibleTiles: Uint8Array;
  /** 1 where the player has ever seen. */
  readonly exploredTiles: Uint8Array;
  private visibilityTimer = 0;

  constructor(level: LevelDef, seed = 1337) {
    this.world = createWorld(level);
    this.rng = new Rng(seed);
    this.visibleTiles = new Uint8Array(this.world.width * this.world.height);
    this.exploredTiles = new Uint8Array(this.world.width * this.world.height);
    this.objective = this.world.spawns.objectives[0] ?? vec(30, 6);

    this.spawnPlayerSquads();
    this.spawnHostiles();
    this.recomputeVisibility();
  }

  private spawnPlayerSquads(): void {
    resetUnitIds();
    let nameIndex = 0;
    this.world.spawns.teams.forEach((positions, squadIndex) => {
      if (positions.length === 0) return;
      const squad: Squad = {
        id: this.squads.length,
        name: TEAM_NAMES[squadIndex] ?? `TEAM ${squadIndex + 1}`,
        faction: Faction.Player,
        memberIds: [],
        order: null,
        // Everyone starts looking north, toward the compound.
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
        this.addUnit(unit);
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

    this.world.spawns.enemies.forEach((spawn, i) => {
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
      this.digIn(unit);
      this.addUnit(unit);
      squad.memberIds.push(unit.id);
    });

    this.squads.push(squad);
  }

  /**
   * Defenders start already in cover facing the likely approach. A guard
   * standing in the open at mission start is free kills, which makes the level
   * read as broken rather than defended.
   */
  private digIn(u: Unit): void {
    const here = this.world.coverNodeAt(Math.floor(u.pos.x), Math.floor(u.pos.y));
    const pick = (node: typeof here): boolean => {
      if (!node || node.claimedBy !== null) return false;
      node.claimedBy = u.id;
      u.claimedNode = node;
      u.pos = { ...node.pos };
      return true;
    };
    if (pick(here)) return;
    const nearby = this.world
      .coverNear(u.pos, 4)
      .filter((n) => n.claimedBy === null)
      .sort((a, b) => b.best - a.best);
    for (const node of nearby) if (pick(node)) return;
  }

  private addUnit(u: Unit): void {
    this.units.set(u.id, u);
    this.unitList.push(u);
  }

  get playerSquads(): Squad[] {
    return this.squads.filter((s) => s.faction === Faction.Player);
  }

  membersOf(squad: Squad): Unit[] {
    return squad.memberIds
      .map((id) => this.units.get(id))
      .filter((u): u is Unit => !!u);
  }

  /** The player's only verb: send a team somewhere, at a tempo, facing a way. */
  orderSquad(squadId: number, dest: Vec2, mode: MoveMode, facing: number | null): void {
    const squad = this.squads[squadId];
    if (!squad || squad.faction !== Faction.Player) return;

    const order: SquadOrder = { dest: { ...dest }, mode, facing, issuedAt: this.time };
    squad.order = order;
    for (const u of this.membersOf(squad)) {
      u.moveMode = mode;
      // Force a re-path: the slot is about to change under them.
      u.path.length = 0;
      u.pathIndex = 0;
    }
    assignSlots(this.world, squad, this.units, order);
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
        dist(u.pos, this.objective) < 2.5,
    );
    if (!hostilesLeft && onObjective) this.missionState = MissionState.Won;
  }

  isVisible(tx: number, ty: number): boolean {
    if (!this.world.inBounds(tx, ty)) return false;
    return this.visibleTiles[ty * this.world.width + tx] === 1;
  }

  /** Whether the player currently has eyes on this unit. */
  canPlayerSee(u: Unit): boolean {
    if (u.faction === Faction.Player) return true;
    return this.isVisible(Math.floor(u.pos.x), Math.floor(u.pos.y));
  }

  /**
   * Ray-fan visibility. Not as exact as recursive shadowcasting, but it runs
   * at 10 Hz over a dozen operators without showing up in a frame budget, and
   * the edges are hidden by the fog's own softening anyway.
   */
  private recomputeVisibility(): void {
    this.visibleTiles.fill(0);
    const w = this.world.width;

    for (const u of this.unitList) {
      if (u.faction !== Faction.Player || u.state === UnitState.Dead) continue;

      this.markDisc(u.pos, AWARENESS_RADIUS);

      const step = (2.4 * Math.PI) / 180;
      for (let a = u.facing - CONE_HALF; a <= u.facing + CONE_HALF; a += step) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        for (let r = 0; r <= VISION_RANGE; r += 1.1) {
          const tx = Math.floor(u.pos.x + dx * r);
          const ty = Math.floor(u.pos.y + dy * r);
          if (!this.world.inBounds(tx, ty)) break;
          const i = ty * w + tx;
          this.visibleTiles[i] = 1;
          this.exploredTiles[i] = 1;
          // Walls are seen, then stop the ray.
          if (this.world.at(tx, ty) === Tile.Wall) break;
        }
      }
    }
  }

  private markDisc(centre: Vec2, radius: number): void {
    const w = this.world.width;
    const r = Math.ceil(radius);
    const cx = Math.floor(centre.x);
    const cy = Math.floor(centre.y);
    for (let ty = cy - r; ty <= cy + r; ty++) {
      for (let tx = cx - r; tx <= cx + r; tx++) {
        if (!this.world.inBounds(tx, ty)) continue;
        if (dist(centre, World.centre(tx, ty)) > radius) continue;
        const i = ty * w + tx;
        this.visibleTiles[i] = 1;
        this.exploredTiles[i] = 1;
      }
    }
  }
}
