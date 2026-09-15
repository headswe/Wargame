import { type Vec2, dist, vec } from './math.ts';
import { Rng } from './rng.ts';
import { type LevelDef, createScene } from './levels.ts';
import type { Scene } from './world/scene.ts';
import { Stature } from './world/occlusion.ts';
import {
  Faction, MoveMode, UnitState, WEAPONS, type Role, type Unit, makeUnit, resetUnitIds,
} from './units.ts';
import {
  type PlannedSlot, type Squad, type SquadOrder, assignSlots, freshMorale, planSlots, spreadOffset,
} from './squads.ts';
import { Nerve } from './morale.ts';
import { type Defence, freshDefence, updateDefence } from './command.ts';
import { type Effect, canReach } from './combat.ts';
import {
  type InFlight, Ordnance, launch, pickThrower, resetOrdnanceIds, spend, stockOf,
  updateOrdnance,
} from './ordnance.ts';
import { type SimContext, updateCasualties, updateSquad, updateUnit } from './ai.ts';

export const MissionState = { InProgress: 0, Won: 1, Lost: 2 } as const;
export type MissionState = (typeof MissionState)[keyof typeof MissionState];

/** Vision is recomputed on its own clock; nothing needs it at 60 Hz. */
const VISIBILITY_HZ = 7;
const VISION_RANGE = 85;
const CONE_HALF = (58 * Math.PI) / 180;
const AWARENESS_RADIUS = 7;
/** Fog is tracked coarser than the simulation — it only has to look right. */
const FOG_CELL = 1;

/** How far a defender will range from his posted spot to find a field of fire. */
const DIG_IN_RADIUS = 8;
/** Share of his sector a defender insists on being able to cover. */
const MIN_FIELD_OF_FIRE = 0.25;

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
  /** Everything in the air or fizzing on the ground right now. */
  readonly live: InFlight[] = [];
  time = 0;

  readonly objective: Vec2;
  /** Whoever is commanding the defence, and what it currently believes. */
  defence: Defence;
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
    this.defence = freshDefence(this.squads, this.units, this.objective);
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
    resetOrdnanceIds();
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
      morale: freshMorale(),
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

  /**
   * The defence, as a handful of positions rather than one fourteen-man block.
   *
   * Grouping by proximity is not cosmetic. A single squad shares contacts, so
   * one sentry seeing you told the entire village at once. Nerve is a man's
   * own, so a position no longer breaks as a block either, but a squad is
   * still what pools sightings and what the player reads off a card. Broken
   * into groups, each position sees for itself, and taking a village becomes
   * taking one position at a time.
   */
  private spawnHostiles(): void {
    let index = 0;
    for (const group of clusterSpawns(this.scene.spawns.enemies)) {
      const squad: Squad = {
        id: this.squads.length,
        name: `HOSTILE ${this.squads.length - TEAM_NAMES.length + 1}`,
        faction: Faction.Hostile,
        memberIds: [],
        order: null,
        threatDir: vec(0, 1),
        morale: freshMorale(),
      };
      for (const spawn of group) {
        index++;
        const unit = makeUnit({
          name: spawn.heavy ? `Gunner ${index}` : `Guard ${index}`,
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
      }
      this.squads.push(squad);
    }
  }

  /**
   * Defenders start in a position rather than merely standing about. The threat
   * is taken to be the approach from the south, which is where the contract
   * says the client's problem is coming from.
   */
  private digIn(u: Unit): void {
    const threat = vec(u.pos.x, Math.min(this.scene.height - 2, u.pos.y + 60));
    // The same fan the player's orders are now judged against. It used to be a
    // private copy in here, which is how the defence came to be better at
    // picking a firing position than the player commanding the attack was.
    const approach = this.scene.sectorFan(u.pos, Math.PI / 2, [22, 40, 60]);
    const spots = this.scene.findCover(u.pos, DIG_IN_RADIUS, threat, {
      crouchTop: Stature.crouchedTop,
      eye: Stature.crouchedEye,
      samples: 40,
      // Rings only, which is the candidate set this defence was balanced
      // against. Letting it walk the walls too — as the player's orders now do
      // — sites the same men in half the exposure for the same field of fire,
      // and measured over twenty seeds that turns the village into a stalemate:
      // the skill gradient falls from 4.8 operators to 3.0 and fire and
      // manoeuvre stops beating a frontal charge, which is the one thing this
      // game is selling.
      //
      // That is a better defence worth having and a balance pass in its own
      // right, with its own seeds and somebody actually playing it. It is not
      // something to change in passing while fixing how orders are given.
      alongCover: false,
    });
    if (spots.length === 0) return;

    // A field of fire is a requirement, not a preference. Choosing by
    // concealment alone gave fourteen men who were very hard to see and could
    // not see anything either — a shot available for twenty-six seconds out of
    // a two-minute assault. But maximising the view instead is worse: it takes
    // them out of cover, and a defender you can see coming is one a reckless
    // attacker can simply shoot, which removes the punishment for recklessness
    // that is most of what a defence is for. So: the best cover available,
    // among positions that can actually cover the sector.
    //
    // `spots` arrives sorted by cover, so the first one that clears the bar is
    // the answer. Failing that, take the widest view going — better a man who
    // can shoot than one who is merely well hidden.
    let pick: (typeof spots)[number] | null = null;
    let widest = spots[0];
    let best = -Infinity;
    for (const spot of spots) {
      const covers = this.scene.fieldOfFire(spot.pos, approach, Stature.crouchedEye);
      if (covers > best) {
        best = covers;
        widest = spot;
      }
      if (pick === null && covers >= MIN_FIELD_OF_FIRE) pick = spot;
    }
    pick = pick ?? widest;

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

  /**
   * Order any squad, either side's. The single place a squad is commanded.
   *
   * The player's verb and the defending commander's are the same verb, which is
   * the point: anything the defence can do to a squad the player can watch
   * happen to his own, and neither side gets a private mechanism the other
   * lacks.
   */
  private commandSquad(
    squad: Squad, dest: Vec2, mode: MoveMode, facing: number | null,
  ): boolean {
    const order: SquadOrder = { dest: { ...dest }, mode, facing, issuedAt: this.time };
    const moved = assignSlots(this.scene, squad, this.units, order);
    if (moved.length === 0) return false;

    squad.order = order;
    for (const u of moved) {
      // Being told to go somewhere ends being told to hold and shoot.
      u.suppressAt = null;
      u.suppressOrdered = false;
      u.coverSpot = null;
      u.moveMode = mode;
      u.path.length = 0;
      u.pathIndex = 0;
    }
    return true;
  }

  /**
   * The player's only verb: send a team somewhere, at a tempo, facing a way.
   *
   * The order goes to whoever is still taking orders. Men who have broken are
   * not listening — getting them back is a matter of giving them somewhere
   * quiet to be, not of telling them again — and shaken men will not be walked
   * any closer to what is shooting at them. Returns false only when nobody at
   * all moved, so a half-obeyed order still counts as given and the player
   * watches three men go and the fourth stay put.
   */
  orderSquad(squadId: number, dest: Vec2, mode: MoveMode, facing: number | null): boolean {
    const squad = this.squads[squadId];
    if (!squad || squad.faction !== Faction.Player) return false;
    return this.commandSquad(squad, dest, mode, facing);
  }

  /**
   * What that order would actually do, without doing it.
   *
   * The cursor needs to show the ground the teams would end up holding, and
   * the only way for that to stay honest is for it to be the same computation
   * the order runs — spread offsets included.
   */
  previewOrder(
    squadIds: Iterable<number>,
    dest: Vec2,
    mode: MoveMode,
    facing: number | null,
  ): PlannedSlot[] {
    const ids = [...squadIds];
    const slots: PlannedSlot[] = [];
    ids.forEach((id, i) => {
      const squad = this.squads[id];
      if (!squad || squad.faction !== Faction.Player) return;
      const offset = spreadOffset(i, ids.length);
      const order: SquadOrder = {
        dest: { x: dest.x + offset.x, y: dest.y + offset.y },
        mode, facing, issuedAt: this.time,
      };
      slots.push(...planSlots(this.scene, squad, this.units, order).slots);
    });
    return slots;
  }

  /**
   * Put one where the player pointed, using whoever on the team can make the
   * throw. Returns false when nobody can — out of range, no angle, or empty
   * pouches — so the caller can say which.
   */
  throwOrdnance(squadId: number, kind: Ordnance, at: Vec2): boolean {
    const squad = this.squads[squadId];
    if (!squad) return false;
    const thrower = pickThrower(this.scene, this.membersOf(squad), kind, at);
    if (!thrower) return false;
    spend(thrower, kind);
    this.live.push(launch(this.scene, thrower, kind, at));
    return true;
  }

  /**
   * Rake a piece of ground until told otherwise.
   *
   * The same verb the AI uses when it loses a contact, handed to the player,
   * because a defender who can pin your crossing while you have no way to pin
   * his is not a tactical problem, it is a broken one. Returns false when
   * nobody on the team has a round that would get there.
   */
  suppressArea(squadId: number, at: Vec2, seconds = 14): boolean {
    const squad = this.squads[squadId];
    if (!squad) return false;
    let any = false;
    for (const u of this.membersOf(squad)) {
      if (u.state !== UnitState.Active) continue;
      if (!canReach(this.scene, u, at)) continue;
      // Raking ground is a thing you stop to do. Holding the order and
      // walking at the same time would be neither.
      u.slot = null;
      u.path.length = 0;
      u.pathIndex = 0;
      u.suppressAt = { ...at };
      u.suppressUntil = this.time + seconds;
      u.suppressOrdered = true;
      u.postFacing = Math.atan2(at.y - u.pos.y, at.x - u.pos.x);
      any = true;
    }
    return any;
  }

  /** What the team has left, for the HUD and for deciding whether to offer it. */
  stock(squadId: number, kind: Ordnance): number {
    const squad = this.squads[squadId];
    if (!squad) return 0;
    return this.membersOf(squad)
      .filter((u) => u.state === UnitState.Active)
      .reduce((n, u) => n + stockOf(u, kind), 0);
  }

  update(dt: number): void {
    if (this.missionState !== MissionState.InProgress) return;

    this.time += dt;
    this.effects.length = 0;

    // Ordnance resolves before anyone acts, so a man caught by a blast is
    // already suppressed when he decides what to do about it this tick.
    updateOrdnance(this, this.live, dt);
    this.scene.smoke.update(dt);
    for (const u of this.unitList) {
      if (u.throwCooldown > 0) u.throwCooldown -= dt;
    }

    // Who went down is settled before anyone's nerve is, so the men beside a
    // casualty feel it on the same tick they have to decide what to do about it.
    updateCasualties(this);
    this.commandDefence(dt);
    for (const squad of this.squads) updateSquad(this, squad, dt);
    for (const u of this.unitList) updateUnit(this, u, dt);

    this.visibilityTimer -= dt;
    if (this.visibilityTimer <= 0) {
      this.visibilityTimer = 1 / VISIBILITY_HZ;
      this.recomputeVisibility();
    }

    this.evaluateMission();
  }

  /**
   * The defending side's commander, and the orders it wants given.
   *
   * Kept as a separate step that returns orders rather than issuing them, so
   * the commander can be tested on its own and so every squad in the game is
   * still commanded through one function.
   */
  private commandDefence(dt: number): void {
    for (const order of updateDefence(this, this.defence, this.objective, dt)) {
      const squad = this.squads[order.squadId];
      if (!squad) continue;
      this.commandSquad(squad, order.dest, MoveMode.Tactical, order.facing);
    }
  }

  private evaluateMission(): void {
    const playerAlive = this.unitList.some(
      (u) => u.faction === Faction.Player && u.state === UnitState.Active,
    );
    if (!playerAlive) {
      this.missionState = MissionState.Lost;
      return;
    }
    // A defence that has broken is a defence you have beaten. Requiring it to
    // be exterminated instead made the endgame a hunt for the last frightened
    // man in a village, which is both the dullest part of the fight and most of
    // its running time.
    const holding = this.unitList.some(
      (u) => u.faction === Faction.Hostile
        && u.state === UnitState.Active
        && u.nerveState !== Nerve.Broken,
    );
    const onObjective = this.unitList.some(
      (u) =>
        u.faction === Faction.Player &&
        u.state === UnitState.Active &&
        dist(u.pos, this.objective) < 4,
    );
    if (!holding && onObjective) this.missionState = MissionState.Won;
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

/**
 * Break a line of spawn points into positions that can plausibly see and hear
 * each other. Greedy nearest-neighbour: good enough for hand-placed defenders,
 * and it keeps a machine gun with the riflemen protecting it.
 */
function clusterSpawns(
  spawns: { pos: Vec2; heavy: boolean }[],
  size = 3,
): { pos: Vec2; heavy: boolean }[][] {
  const left = [...spawns];
  const groups: { pos: Vec2; heavy: boolean }[][] = [];
  while (left.length > 0) {
    const seed = left.shift()!;
    const group = [seed];
    left.sort((a, b) => dist(a.pos, seed.pos) - dist(b.pos, seed.pos));
    while (group.length < size && left.length > 0 && dist(left[0].pos, seed.pos) < 42) {
      group.push(left.shift()!);
    }
    groups.push(group);
  }

  // Nobody is left on his own. A man alone is not a position: he sees for
  // himself, shares his sightings with nobody, and breaks almost at once.
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].length > 1 || groups.length === 1) continue;
    const orphan = groups[i][0];
    let nearest = -1;
    let best = Infinity;
    for (let j = 0; j < groups.length; j++) {
      if (j === i) continue;
      const d = dist(groups[j][0].pos, orphan.pos);
      if (d < best) {
        best = d;
        nearest = j;
      }
    }
    if (nearest < 0) continue;
    groups[nearest].push(orphan);
    groups.splice(i, 1);
  }
  return groups;
}
