import { type Vec2, clamp, dist } from './math.ts';
import type { Effect } from './combat.ts';
import type { Rng } from './rng.ts';
import { Faction, UnitState, type Unit, silhouetteOf } from './units.ts';
import type { Scene } from './world/scene.ts';
import { Stature } from './world/occlusion.ts';

export const Ordnance = {
  /** Defeats cover by going over it. The answer to a held position. */
  Frag: 0,
  /** Defeats open ground by taking away the sightline. The answer to a field. */
  Smoke: 1,
} as const;
export type Ordnance = (typeof Ordnance)[keyof typeof Ordnance];

/** How far a man can throw one, in metres. */
export const THROW_RANGE = 30;
/** Height the lob has to clear over the aim point for the throw to be on. */
const LOB_CLEARANCE = 3.0;
/** Seconds in the air, per metre thrown. */
const FLIGHT_PER_METRE = 0.045;
/** Seconds on the ground before a frag goes off. Long enough to run from. */
const COOK = 1.15;

/** Damage at the seat of the explosion, before cover and distance. */
const FRAG_DAMAGE = 115;
/** Beyond this, a frag is noise. */
export const FRAG_RADIUS = 7.5;
/** Fear carries further than fragments, and through more. */
const FRAG_SUPPRESSION_RADIUS = 14;

export interface InFlight {
  id: number;
  kind: Ordnance;
  faction: Faction;
  thrownBy: number;
  from: Vec2;
  to: Vec2;
  /** Height at either end, so the renderer can draw a real arc. */
  fromHeight: number;
  toHeight: number;
  /** Metres the arc rises above the straight line at its peak. */
  apex: number;
  elapsed: number;
  flight: number;
  /** Counts down once it lands. Smoke pops immediately; a frag cooks. */
  fuse: number;
  landed: boolean;
}

let nextOrdnanceId = 1;
export function resetOrdnanceIds(): void {
  nextOrdnanceId = 1;
}

/**
 * Whether this man can put one where you are pointing.
 *
 * The test is not flat line of sight — the whole point of a thrown weapon is
 * that it goes over things. It is whether he can see the air above the aim
 * point, which is what his arm actually has to reach. That single rule gives
 * the right answers everywhere without a special case: he can lob one over the
 * garden wall he is standing behind, through the window he can see, and into
 * the yard beyond; he cannot lob one through a hillside or into a room on the
 * far side of a building he has never seen inside.
 */
export function canThrow(scene: Scene, u: Unit, at: Vec2): boolean {
  if (u.state !== UnitState.Active) return false;
  if (dist(u.pos, at) > THROW_RANGE) return false;
  return scene.sightThroughSmoke(
    { x: u.pos.x, y: u.pos.y, eye: Stature.standingEye },
    { x: at.x, y: at.y, base: LOB_CLEARANCE, top: LOB_CLEARANCE + 0.3 },
  ).visible;
}

export function launch(scene: Scene, u: Unit, kind: Ordnance, at: Vec2): InFlight {
  const range = dist(u.pos, at);
  const fromHeight = scene.heightAt(u.pos.x, u.pos.y) + 1.4;
  const toHeight = scene.heightAt(at.x, at.y);
  return {
    id: nextOrdnanceId++,
    kind,
    faction: u.faction,
    thrownBy: u.id,
    from: { ...u.pos },
    to: { ...at },
    fromHeight,
    toHeight,
    // A longer throw is a flatter throw; a short one is lobbed high over the
    // thing you are hiding behind.
    apex: clamp(2.2 + range * 0.12, 2.5, 7),
    elapsed: 0,
    flight: Math.max(0.45, range * FLIGHT_PER_METRE),
    fuse: kind === Ordnance.Frag ? COOK : 0,
    landed: false,
  };
}

/** Where it is right now, for the renderer. */
export function positionOf(o: InFlight): { x: number; y: number; height: number } {
  const t = Math.min(1, o.elapsed / o.flight);
  return {
    x: o.from.x + (o.to.x - o.from.x) * t,
    y: o.from.y + (o.to.y - o.from.y) * t,
    // A parabola through both ends, peaking `apex` above the chord.
    height: o.fromHeight + (o.toHeight - o.fromHeight) * t + o.apex * 4 * t * (1 - t),
  };
}

export interface OrdnanceWorld {
  scene: Scene;
  rng: Rng;
  unitList: Unit[];
  effects: Effect[];
}

/**
 * Advance everything in the air. Returns the ones that went off this tick.
 *
 * Kept as a free function over a plain array so the whole thing stays testable
 * without a Sim: a grenade is just a position, a clock and a consequence.
 */
export function updateOrdnance(world: OrdnanceWorld, live: InFlight[], dt: number): void {
  for (let i = live.length - 1; i >= 0; i--) {
    const o = live[i];
    o.elapsed += dt;
    if (!o.landed && o.elapsed >= o.flight) {
      o.landed = true;
      if (o.kind === Ordnance.Smoke) {
        pop(world, o);
        live.splice(i, 1);
        continue;
      }
    }
    if (!o.landed) continue;
    o.fuse -= dt;
    if (o.fuse <= 0) {
      detonate(world, o);
      live.splice(i, 1);
    }
  }
}

function pop(world: OrdnanceWorld, o: InFlight): void {
  const ground = world.scene.heightAt(o.to.x, o.to.y);
  world.scene.smoke.add(o.to, ground);
  world.effects.push({ kind: 'smokePop', at: { ...o.to }, height: ground + 0.3 });
}

/**
 * A frag going off, with cover doing exactly what cover does.
 *
 * Fragments travel in straight lines from a point just off the ground, so the
 * same silhouette solve that decides whether a rifleman can be shot decides
 * how much of a man the fragments can reach. That is the whole mechanic: a
 * wall between you and the seat of the blast is as good as it looks, and one
 * that lands on your side of it is as bad as it looks — which is why a grenade
 * beats a position that rifle fire cannot.
 *
 * Blast and noise are treated separately and deliberately do not respect cover
 * nearly as much. Being behind a wall when one goes off is survivable; it is
 * not quiet.
 */
function detonate(world: OrdnanceWorld, o: InFlight): void {
  const { scene, rng, unitList, effects } = world;
  const seat = scene.heightAt(o.to.x, o.to.y) + 0.35;
  effects.push({ kind: 'blast', at: { ...o.to }, height: seat, radius: FRAG_RADIUS });

  for (const u of unitList) {
    if (u.state === UnitState.Dead) continue;
    const d = dist(u.pos, o.to);
    if (d > FRAG_SUPPRESSION_RADIUS) continue;

    // Noise and overpressure first: these find you behind the wall.
    const shock = 1 - clamp(d / FRAG_SUPPRESSION_RADIUS, 0, 1);
    let exposure = 0;
    if (d <= FRAG_RADIUS) {
      exposure = scene.sightThroughSmoke(
        { x: o.to.x, y: o.to.y, eye: 0.35 },
        { x: u.pos.x, y: u.pos.y, base: 0, top: silhouetteOf(u) },
      ).exposure;
    }
    u.suppression = clamp(u.suppression + shock * (0.35 + 0.65 * exposure) * 1.35, 0, 1);

    if (u.state !== UnitState.Active || exposure <= 0) continue;

    // Fragment density falls off fast — a grenade is a room-clearing weapon,
    // not an area weapon.
    const falloff = (1 - clamp(d / FRAG_RADIUS, 0, 1)) ** 1.5;
    const damage = FRAG_DAMAGE * falloff * exposure * rng.range(0.8, 1.2);
    if (damage < 1) continue;

    u.hp -= damage;
    if (u.hp <= 0) {
      u.hp = 0;
      u.state = UnitState.Down;
      u.bleedout = 42;
      u.path = [];
      u.pathIndex = 0;
      u.coverSpot = null;
      u.slot = null;
    }
  }

  // And it takes a bite out of whatever it went off against.
  for (let a = 0; a < 10; a++) {
    const angle = (a / 10) * Math.PI * 2;
    for (const r of [0.5, 1.4, 2.4]) {
      scene.hit(o.to.x + Math.cos(angle) * r, o.to.y + Math.sin(angle) * r, 26 / r);
    }
  }
}

/**
 * The nearest man on the team who can actually make the throw.
 *
 * Nearest rather than best-armed: whoever is closest has the shortest, flattest
 * throw and is most likely to have the angle, and taking the support weapon out
 * of the fight to throw a grenade is how you lose the base of fire.
 */
export function pickThrower(scene: Scene, members: Unit[], kind: Ordnance, at: Vec2): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const u of members) {
    if (u.state !== UnitState.Active) continue;
    if (stockOf(u, kind) <= 0) continue;
    if (u.throwCooldown > 0) continue;
    const d = dist(u.pos, at);
    if (d >= bestD) continue;
    if (!canThrow(scene, u, at)) continue;
    best = u;
    bestD = d;
  }
  return best;
}

export function stockOf(u: Unit, kind: Ordnance): number {
  return kind === Ordnance.Frag ? u.frags : u.smokes;
}

export function spend(u: Unit, kind: Ordnance): void {
  if (kind === Ordnance.Frag) u.frags--;
  else u.smokes--;
  // Long enough that a team cannot empty its pouches in one breath.
  u.throwCooldown = 4.5;
}

/**
 * Where a live frag is about to go off, for anyone who ought to be elsewhere.
 *
 * Only ones that have landed count. A grenade still in the air has not told
 * you anything yet, and the two seconds it spends on the ground fizzing is
 * exactly the window the defender gets to make the decision.
 */
export function dangerFrom(live: InFlight[], faction: Faction): Vec2 | null {
  for (const o of live) {
    if (o.kind !== Ordnance.Frag || !o.landed) continue;
    if (o.faction === faction) continue;
    return o.to;
  }
  return null;
}
