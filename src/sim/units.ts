import { type Vec2 } from './math.ts';
import { Stature } from './world/occlusion.ts';

export const Faction = { Player: 0, Hostile: 1 } as const;
export type Faction = (typeof Faction)[keyof typeof Faction];

export const UnitState = {
  Active: 0,
  /** Out of the fight, bleeding out. Still a person you can get back. */
  Down: 1,
  Dead: 2,
} as const;
export type UnitState = (typeof UnitState)[keyof typeof UnitState];

export const MoveMode = {
  /** Weapon up, hugs cover, reacts instantly. The default. */
  Tactical: 0,
  /** Weapon down, ignores cover, loud. Double right-click. */
  Sprint: 1,
} as const;
export type MoveMode = (typeof MoveMode)[keyof typeof MoveMode];

export const Posture = {
  Standing: 0,
  /** In cover, presenting a smaller target. */
  Crouched: 1,
  /** Suppressed into the dirt: no shooting, no moving. */
  Pinned: 2,
  /**
   * Flat, by choice, because rounds are coming near.
   *
   * The distinction from Pinned is the whole point: pinned is something done to
   * a man, prone is something he decides. Without it he has only two options
   * under fire — keep shooting and die, or be suppressed hard enough that the
   * game lies him down for him — and the move that actually saves people in
   * the games this one is aiming at is simply getting down.
   */
  Prone: 3,
} as const;
export type Posture = (typeof Posture)[keyof typeof Posture];

export const Nerve = {
  /** Fighting. */
  Steady: 0,
  /** Still fighting, worse, and unwilling to give up any more ground. */
  Wavering: 1,
  /** Out of the fight: getting out, not shooting, not taking orders. */
  Broken: 2,
} as const;
export type Nerve = (typeof Nerve)[keyof typeof Nerve];

export interface Weapon {
  name: string;
  damage: number;
  /** Rounds per minute while a burst is going out. */
  rpm: number;
  burst: number;
  /** Seconds between bursts — the rhythm you hear in a firefight. */
  burstPause: number;
  magSize: number;
  reloadTime: number;
  /** Hit chance at optimal range against an unsuppressed target in the open. */
  accuracy: number;
  optimalRange: number;
  maxRange: number;
  /** Fear per round. A SAW is a movement-denial tool, not a killing tool. */
  suppressionPower: number;
}

export const WEAPONS: Record<string, Weapon> = {
  carbine: {
    name: 'Carbine',
    damage: 26,
    rpm: 700,
    burst: 3,
    burstPause: 0.75,
    magSize: 30,
    reloadTime: 2.6,
    accuracy: 0.74,
    optimalRange: 32,
    maxRange: 78,
    suppressionPower: 0.9,
  },
  saw: {
    name: 'SAW',
    damage: 24,
    rpm: 800,
    burst: 9,
    burstPause: 1.15,
    magSize: 100,
    reloadTime: 6.0,
    accuracy: 0.4,
    optimalRange: 42,
    maxRange: 98,
    suppressionPower: 2.7,
  },
  dmr: {
    name: 'DMR',
    damage: 52,
    rpm: 240,
    burst: 1,
    burstPause: 1.5,
    magSize: 20,
    reloadTime: 3.2,
    accuracy: 0.88,
    optimalRange: 62,
    maxRange: 140,
    suppressionPower: 1.2,
  },
  smg: {
    name: 'SMG',
    damage: 20,
    rpm: 900,
    burst: 5,
    burstPause: 0.6,
    magSize: 32,
    reloadTime: 2.2,
    accuracy: 0.62,
    optimalRange: 14,
    maxRange: 38,
    suppressionPower: 0.8,
  },
  ak: {
    name: 'AK',
    damage: 28,
    rpm: 600,
    burst: 4,
    burstPause: 1.0,
    magSize: 30,
    reloadTime: 3.4,
    accuracy: 0.55,
    optimalRange: 26,
    maxRange: 66,
    suppressionPower: 1.0,
  },
  pkm: {
    name: 'PKM',
    damage: 30,
    rpm: 650,
    burst: 10,
    burstPause: 1.4,
    magSize: 100,
    reloadTime: 7.0,
    accuracy: 0.32,
    optimalRange: 46,
    maxRange: 105,
    suppressionPower: 2.9,
  },
};

export type Role = 'Team Leader' | 'Rifleman' | 'Automatic Rifleman' | 'Marksman' | 'Breacher';

export interface Unit {
  id: number;
  name: string;
  role: Role;
  faction: Faction;
  /** Index into Sim.squads. Hostiles use their own squad grouping. */
  squadId: number;

  pos: Vec2;
  facing: number;
  velocity: Vec2;

  // Movement
  path: Vec2[];
  pathIndex: number;
  moveMode: MoveMode;
  /** Where this individual is headed — a fighting position, not the order point. */
  slot: Vec2 | null;
  /** The position they are holding, once they have arrived at it. */
  coverSpot: Vec2 | null;
  /** Ground height underfoot, cached each tick for the renderer. */
  groundHeight: number;
  /** Where to look once settled, if the player dragged a facing. */
  postFacing: number | null;

  // Condition
  hp: number;
  maxHp: number;
  state: UnitState;
  bleedout: number;
  stabilized: boolean;
  /** 0..1. Drives accuracy loss, then pinning. */
  suppression: number;
  stamina: number;
  /**
   * Seconds spent trying to move and getting nowhere.
   *
   * A man wedged against geometry looks exactly like a man standing still, so
   * nothing upstream can tell the difference. This is what lets the mover
   * notice and dig itself out.
   */
  wedgedFor: number;
  posture: Posture;
  /** 0..1 — how far out of cover they are leaning to shoot. */
  exposure: number;

  // Weapon handling
  weapon: Weapon;
  ammoInMag: number;
  reloadTimer: number;
  /** 0..1 — sprinting drops the muzzle; it takes a beat to get back on target. */
  weaponReady: number;
  fireCooldown: number;
  burstRemaining: number;
  burstPauseTimer: number;

  // Senses
  targetId: number | null;
  /** Enemy ids currently acquired — seen well enough to shoot at. */
  visible: number[];
  /** Per-enemy spotting progress. Reaching 1 means acquired. */
  spotting: Map<number, number>;
  /** Last place we saw each enemy, by id. */
  memory: Map<number, { pos: Vec2; age: number }>;

  // Ordnance
  /** Fragmentation grenades left. The answer to a position rifles cannot shift. */
  frags: number;
  /** Smoke canisters left. The answer to ground rifles cover too well. */
  smokes: number;
  /** Seconds before this man will throw another. */
  throwCooldown: number;
  /** Breaking cover to get away from a live one, rather than following orders. */
  diving: boolean;
  /** How he personally is holding up, 1 steady down to 0 finished. */
  nerve: number;
  /** What that adds up to. His own, not his team's. */
  nerveState: Nerve;
  /** Earliest sim time a broken man will listen to anyone again. */
  rallyAt: number;
  /** Where he is running to, once he has stopped fighting. */
  refuge: Vec2 | null;
  /** He has stopped fighting and is getting out. Overrides being pinned. */
  routing: boolean;
  /**
   * Whether the fight has ever had him on his feet.
   *
   * A body that was already lying there when the shooting started is scenery.
   * Only a man his mates had seen standing is news when he goes down.
   */
  wasStanding: boolean;

  // Area fire
  /** Ground being raked when there is nothing in sight worth shooting at. */
  suppressAt: Vec2 | null;
  /** Sim time this stops. Losing a contact buys a burst, not a career. */
  suppressUntil: number;
  /** The player asked for this, so it outlasts the squad's own initiative. */
  suppressOrdered: boolean;

  /** Cosmetic: seconds since last shot, for muzzle flash timing in the renderer. */
  lastShotAt: number;
  /** Throttles A* retries when a slot is briefly unreachable. */
  repathTimer: number;
}

const FIRST = [
  'Voss', 'Kessler', 'Marek', 'Dunn', 'Aleksy', 'Ruiz', 'Halvorsen', 'Baptiste',
  'Crane', 'Okafor', 'Sandoval', 'Thorne', 'Novak', 'Reyes', 'Brandt', 'Iversen',
];

let nextUnitId = 1;
export function resetUnitIds(): void {
  nextUnitId = 1;
}

export function makeUnit(opts: {
  name?: string;
  role: Role;
  faction: Faction;
  squadId: number;
  pos: Vec2;
  weapon: Weapon;
  facing?: number;
  maxHp?: number;
}): Unit {
  const id = nextUnitId++;
  return {
    id,
    name: opts.name ?? FIRST[id % FIRST.length],
    role: opts.role,
    faction: opts.faction,
    squadId: opts.squadId,
    pos: { ...opts.pos },
    facing: opts.facing ?? 0,
    velocity: { x: 0, y: 0 },
    path: [],
    pathIndex: 0,
    moveMode: MoveMode.Tactical,
    slot: null,
    coverSpot: null,
    groundHeight: 0,
    postFacing: null,
    hp: opts.maxHp ?? 100,
    maxHp: opts.maxHp ?? 100,
    state: UnitState.Active,
    bleedout: 0,
    stabilized: false,
    suppression: 0,
    stamina: 1,
    wedgedFor: 0,
    posture: Posture.Standing,
    exposure: 1,
    weapon: opts.weapon,
    ammoInMag: opts.weapon.magSize,
    reloadTimer: 0,
    weaponReady: 1,
    fireCooldown: 0,
    burstRemaining: 0,
    burstPauseTimer: 0,
    targetId: null,
    visible: [],
    spotting: new Map(),
    memory: new Map(),
    frags: opts.role === 'Team Leader' ? 2 : 1,
    smokes: opts.role === 'Team Leader' ? 2 : 1,
    throwCooldown: 0,
    diving: false,
    nerve: 1,
    nerveState: Nerve.Steady,
    rallyAt: 0,
    refuge: null,
    routing: false,
    wasStanding: false,
    suppressAt: null,
    suppressUntil: 0,
    suppressOrdered: false,
    lastShotAt: 99,
    repathTimer: 0,
  };
}

/**
 * Eye height above the ground underfoot.
 *
 * This is the whole exposure trade in one number: hunkering drops your eye
 * behind your cover and you cannot shoot, leaning out raises it and you can be
 * shot. Nothing else has to model "leaning" — the geometry does it.
 */
export function eyeOf(u: Unit): number {
  const low = u.posture === Posture.Pinned || u.posture === Posture.Prone
    ? Stature.proneEye
    : u.posture === Posture.Crouched
      ? Stature.crouchedEye
      : Stature.standingEye;
  return low + (Stature.standingEye - low) * Math.max(0, Math.min(1, u.exposure));
}

/** How much of a man there is to hit, given what he is doing. */
export function silhouetteOf(u: Unit): number {
  if (u.posture === Posture.Pinned) return Stature.proneTop;
  // A man flat on the ground still lifts his head and shoulders to look, but
  // the difference between this and crouching is most of why getting down
  // works at all.
  if (u.posture === Posture.Prone) {
    return Stature.proneTop + (Stature.crouchedTop - Stature.proneTop) * u.exposure * 0.5;
  }
  if (u.posture === Posture.Crouched) {
    return Stature.crouchedTop + (Stature.standingTop - Stature.crouchedTop) * u.exposure * 0.6;
  }
  return Stature.standingTop;
}

export const isFighting = (u: Unit): boolean => u.state === UnitState.Active;
export const isMoving = (u: Unit): boolean =>
  u.path.length > 0 && u.pathIndex < u.path.length;

/** Movement speed in tiles/second, after stamina and suppression. */
export function speedOf(u: Unit, footing = 1): number {
  // Loaded infantry, not sprinters. The gap between these two numbers is the
  // whole tempo decision, and the sprint has to stay slow enough that crossing
  // open ground is genuinely exposed rather than a teleport.
  const base = u.moveMode === MoveMode.Sprint ? 5.0 : 2.2;
  const staminaFactor = u.moveMode === MoveMode.Sprint ? 0.55 + u.stamina * 0.45 : 1;
  const supFactor = 1 - u.suppression * 0.45;
  // What is underfoot. A road is the quickest way across a map and the most
  // exposed one; a ploughed field or the mud in the bottom of a ditch is slow
  // enough that taking it is a decision. Without this a surface is a colour.
  return base * staminaFactor * supFactor * footing;
}
