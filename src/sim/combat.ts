import { type Vec2, clamp, dist, distPointToSegment, invLerpClamped } from './math.ts';
import type { Rng } from './rng.ts';
import type { Scene } from './world/scene.ts';
import { MoveMode, Posture, UnitState, type Unit, eyeOf, isMoving, silhouetteOf } from './units.ts';

/** Above this, an operator stops being a shooter and becomes a passenger. */
export const PIN_THRESHOLD = 0.72;
export const UNPIN_THRESHOLD = 0.45;
export const SUPPRESSION_DECAY = 0.25;

export interface ShotEffect {
  kind: 'shot';
  from: Vec2;
  fromHeight: number;
  to: Vec2;
  toHeight: number;
  hit: boolean;
  shooterId: number;
  faction: number;
}

export interface HitEffect {
  kind: 'hit';
  at: Vec2;
  height: number;
  targetId: number;
  lethal: boolean;
}

export interface ImpactEffect {
  kind: 'impact';
  at: Vec2;
  height: number;
}

export type Effect = ShotEffect | HitEffect | ImpactEffect;

function rangeFactor(d: number, optimal: number, max: number): number {
  if (d <= optimal) return 1;
  if (d >= max) return 0.1;
  return 1 - 0.9 * Math.pow((d - optimal) / (max - optimal), 1.35);
}

function shooterStanceFactor(u: Unit): number {
  if (isMoving(u)) return u.moveMode === MoveMode.Sprint ? 0 : 0.5;
  return u.posture === Posture.Crouched ? 1.12 : 1;
}

function targetMotionFactor(t: Unit): number {
  if (!isMoving(t)) return 1;
  return t.moveMode === MoveMode.Sprint ? 0.72 : 0.88;
}

export interface HitBreakdown {
  chance: number;
  /** 0..1 of the target's silhouette that is in the open. */
  exposure: number;
  /** 0..1 vegetation on the line. Hides, does not protect. */
  concealment: number;
  range: number;
  blocked: boolean;
}

/**
 * Hit chance, with cover expressed as the fraction of the target actually
 * showing.
 *
 * There is no cover term to look up any more. A wall, a crest, the lip of a
 * ditch and the fact that he is crouching all arrive through the same number,
 * because they are all just geometry between two points.
 */
export function hitChance(scene: Scene, shooter: Unit, target: Unit): HitBreakdown {
  const sighting = scene.sight(
    { x: shooter.pos.x, y: shooter.pos.y, eye: eyeOf(shooter) },
    { x: target.pos.x, y: target.pos.y, base: 0, top: silhouetteOf(target) },
    shooter.weapon.maxRange,
  );

  if (!sighting.visible) {
    return {
      chance: 0, exposure: 0, concealment: sighting.concealment,
      range: sighting.distance, blocked: true,
    };
  }

  let p = shooter.weapon.accuracy;
  p *= rangeFactor(sighting.distance, shooter.weapon.optimalRange, shooter.weapon.maxRange);
  p *= shooterStanceFactor(shooter);
  p *= 1 - shooter.suppression * 0.78;
  p *= shooter.weaponReady;
  p *= sighting.exposure;
  p *= targetMotionFactor(target);
  // Foliage does not stop a round, but it does stop you aiming at what is
  // behind it.
  p *= 1 - sighting.concealment * 0.55;
  if (shooter.posture === Posture.Pinned) p *= 0.2;

  return {
    chance: clamp(p, 0, 0.95),
    exposure: sighting.exposure,
    concealment: sighting.concealment,
    range: sighting.distance,
    blocked: false,
  };
}

/**
 * Spray suppression along the path of a round. Doing it per-bullet rather than
 * per-target is what lets a player suppress a *position* — fire at a doorway
 * and everyone behind it feels it, whether or not anyone was aimed at.
 */
export function applySuppressionAlong(
  units: Unit[],
  from: Vec2,
  to: Vec2,
  shooterFaction: number,
  power: number,
): void {
  for (const u of units) {
    if (u.state !== UnitState.Active) continue;
    if (u.faction === shooterFaction) continue;
    const d = distPointToSegment(u.pos, from, to);
    if (d > 1.8) continue;
    u.suppression = clamp(
      u.suppression + power * 0.022 * (1 - invLerpClamped(d, 0.3, 1.8)), 0, 1,
    );
  }
}

export interface ShotOutcome {
  hit: boolean;
  impact: Vec2;
  damage: number;
  killedOrDowned: boolean;
}

/** Resolve one round. Misses still land somewhere, and that somewhere matters. */
export function resolveShot(
  scene: Scene,
  rng: Rng,
  units: Unit[],
  shooter: Unit,
  target: Unit,
  effects: Effect[],
): ShotOutcome {
  const breakdown = hitChance(scene, shooter, target);
  const hit = !breakdown.blocked && rng.chance(breakdown.chance);

  const fromHeight = scene.heightAt(shooter.pos.x, shooter.pos.y) + eyeOf(shooter);
  let impact: Vec2;
  let impactHeight: number;
  let damage = 0;
  let killedOrDowned = false;

  if (hit) {
    impact = { ...target.pos };
    impactHeight = scene.heightAt(target.pos.x, target.pos.y) + silhouetteOf(target) * 0.6;
    const headshot = rng.chance(0.07);
    damage = shooter.weapon.damage * rng.range(0.85, 1.15) * (headshot ? 2.2 : 1);
    target.hp -= damage;
    target.suppression = clamp(target.suppression + 0.22, 0, 1);
    if (target.hp <= 0) {
      target.hp = 0;
      target.state = UnitState.Down;
      target.bleedout = 42;
      target.path = [];
      target.pathIndex = 0;
      target.coverSpot = null;
      killedOrDowned = true;
    }
    effects.push({ kind: 'hit', at: impact, height: impactHeight, targetId: target.id, lethal: killedOrDowned });
  } else {
    // A miss scatters off the aim point, further out at longer range.
    const spread = 0.35 + breakdown.range * 0.055 * (1 - breakdown.chance);
    impact = {
      x: target.pos.x + rng.gaussian() * spread,
      y: target.pos.y + rng.gaussian() * spread,
    };
    impactHeight = scene.heightAt(impact.x, impact.y) + 0.5;
    effects.push({ kind: 'impact', at: impact, height: impactHeight });

    // Rounds that go wide put their energy into the scenery. Cover wears out.
    scene.hit(impact.x, impact.y, shooter.weapon.damage);
  }

  effects.push({
    kind: 'shot',
    from: { ...shooter.pos },
    fromHeight,
    to: impact,
    toHeight: impactHeight,
    hit,
    shooterId: shooter.id,
    faction: shooter.faction,
  });

  applySuppressionAlong(units, shooter.pos, impact, shooter.faction, shooter.weapon.suppressionPower);
  void dist;
  return { hit, impact, damage, killedOrDowned };
}
