import { type Vec2, clamp, dist, distPointToSegment, invLerpClamped } from './math.ts';
import type { Rng } from './rng.ts';
import type { Scene } from './world/scene.ts';
import { MoveMode, Posture, UnitState, type Unit, eyeOf, isMoving, silhouetteOf } from './units.ts';
import { Stature } from './world/occlusion.ts';

/** Above this, an operator stops being a shooter and becomes a passenger. */
export const PIN_THRESHOLD = 0.72;
export const UNPIN_THRESHOLD = 0.45;
export const SUPPRESSION_DECAY = 0.25;
/**
 * Fear per round passing close, before the weapon's own multiplier.
 *
 * Set for the volume of fire this game actually produces, which is far lower
 * than the volume a real firefight produces: operators here engage with a few
 * aimed rounds rather than by emptying magazines, so a figure tuned for
 * hundreds of rounds a minute left suppression doing nothing at all. Measured
 * across a full assault, defenders averaged two thousandths of a point of it,
 * and spent two seconds out of a thousand under anything worth the name.
 *
 * At this value one rifleman firing bursts at you holds you around a half, and
 * a belt-fed buries you — which is the relationship the weapon table has always
 * described and never delivered.
 */
const SUPPRESSION_PER_ROUND = 0.075;

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

export interface BlastEffect {
  kind: 'blast';
  at: Vec2;
  height: number;
  radius: number;
}

export interface SmokePopEffect {
  kind: 'smokePop';
  at: Vec2;
  height: number;
}

export type Effect = ShotEffect | HitEffect | ImpactEffect | BlastEffect | SmokePopEffect;

function rangeFactor(d: number, optimal: number, max: number): number {
  if (d <= optimal) return 1;
  if (d >= max) return 0.1;
  return 1 - 0.9 * Math.pow((d - optimal) / (max - optimal), 1.35);
}

function shooterStanceFactor(u: Unit): number {
  if (isMoving(u)) return u.moveMode === MoveMode.Sprint ? 0 : 0.5;
  // Prone is the steadiest firing position there is, and it gets credit for
  // that. What it costs a man is not his aim but his eyeline, and the sightline
  // already charges him for that without help.
  if (u.posture === Posture.Prone) return 1.2;
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
  // A shaken team shoots worse than a steady one holding the same wall, which
  // is what makes fire that never kills anybody still worth sending.
  p *= 0.6 + 0.4 * shooter.nerve;
  // How much of a man is showing, in metres rather than as a fraction of
  // himself. Exposure alone says what share of his silhouette clears the cover
  // in front of him, which is the right question behind a wall and the wrong
  // one in the open: a man flat on his face out in a field is fully exposed by
  // that measure and therefore exactly as easy to hit as one standing up.
  // Scaling by the height actually presented restores the thing every soldier
  // knows — that getting small is worth something wherever you are — and it is
  // what makes going prone a decision rather than a decoration.
  p *= (silhouetteOf(target) * sighting.exposure) / Stature.standingTop;
  p *= targetMotionFactor(target);
  // Foliage and smoke do not stop a round, but they do stop you aiming at what
  // is behind them. Near-total concealment leaves firing into it and hoping,
  // which is the whole reason to spend a canister on a crossing.
  p *= 1 - sighting.concealment * 0.85;
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
      u.suppression + power * SUPPRESSION_PER_ROUND * (1 - invLerpClamped(d, 0.3, 1.8)), 0, 1,
    );
  }
}

export interface ShotOutcome {
  hit: boolean;
  impact: Vec2;
  damage: number;
  killedOrDowned: boolean;
}

/** How wide a beaten zone one man rakes when he cannot see what he is shooting at. */
export const BEATEN_ZONE = 4.5;
/** What a round is worth when nobody is aiming it. */
const BLIND_FIRE = 0.13;

/**
 * A round fired at a piece of ground rather than at a man.
 *
 * This is what stops smoke and dead ground from being an off switch. Losing
 * sight of someone does not end the exchange in real life — the muzzle stays
 * on the last place you saw him and the rounds keep going, and the value of
 * that is almost entirely the suppression, which the model already applies
 * along the path rather than to a target. What makes it honest is that cover
 * is still cover: the geometry is solved exactly as it is for aimed fire, so a
 * man flat in a ditch inside the beaten zone is as safe as the ditch makes
 * him. Only the aiming is taken away, and that is priced once, here, rather
 * than twice by also counting the smoke that hid him.
 */
export function resolveAreaShot(
  scene: Scene,
  rng: Rng,
  units: Unit[],
  shooter: Unit,
  aim: Vec2,
  effects: Effect[],
): void {
  const range = dist(shooter.pos, aim);
  // Each round goes somewhere slightly different. That spread is the beaten
  // zone, and it is the reason area fire covers ground instead of a point.
  const spread = 0.8 + range * 0.03;
  const impact = {
    x: aim.x + rng.gaussian() * spread,
    y: aim.y + rng.gaussian() * spread,
  };
  const fromHeight = scene.heightAt(shooter.pos.x, shooter.pos.y) + eyeOf(shooter);
  const impactHeight = scene.heightAt(impact.x, impact.y) + 0.5;

  for (const u of units) {
    if (u.state !== UnitState.Active || u.faction === shooter.faction) continue;
    const off = dist(u.pos, impact);
    if (off > BEATEN_ZONE) continue;

    // Geometry only: the smoke that stopped him seeing is already paid for by
    // BLIND_FIRE, and charging it again would make a canister bulletproof.
    const sighting = scene.sightThroughSmoke(
      { x: shooter.pos.x, y: shooter.pos.y, eye: eyeOf(shooter) },
      { x: u.pos.x, y: u.pos.y, base: 0, top: silhouetteOf(u) },
      shooter.weapon.maxRange,
    );
    if (!sighting.visible) continue;

    let p = shooter.weapon.accuracy * BLIND_FIRE;
    p *= rangeFactor(sighting.distance, shooter.weapon.optimalRange, shooter.weapon.maxRange);
    p *= sighting.exposure;
    p *= 1 - shooter.suppression * 0.78;
    p *= (1 - off / BEATEN_ZONE) ** 2;
    p *= targetMotionFactor(u);

    if (!rng.chance(clamp(p, 0, 0.6))) continue;

    const damage = shooter.weapon.damage * rng.range(0.85, 1.15);
    u.hp -= damage;
    u.suppression = clamp(u.suppression + 0.22, 0, 1);
    let lethal = false;
    if (u.hp <= 0) {
      u.hp = 0;
      u.state = UnitState.Down;
      u.bleedout = 42;
      u.path = [];
      u.pathIndex = 0;
      u.coverSpot = null;
      u.slot = null;
      lethal = true;
    }
    effects.push({
      kind: 'hit', at: { ...u.pos },
      height: scene.heightAt(u.pos.x, u.pos.y) + silhouetteOf(u) * 0.6,
      targetId: u.id, lethal,
    });
    break;
  }

  effects.push({ kind: 'impact', at: impact, height: impactHeight });
  effects.push({
    kind: 'shot',
    from: { ...shooter.pos },
    fromHeight,
    to: impact,
    toHeight: impactHeight,
    hit: false,
    shooterId: shooter.id,
    faction: shooter.faction,
  });

  scene.hit(impact.x, impact.y, shooter.weapon.damage);
  applySuppressionAlong(units, shooter.pos, impact, shooter.faction, shooter.weapon.suppressionPower);
}

/**
 * Whether a round fired at this patch of ground would get there at all.
 *
 * The test is against a man-sized column, not against the dirt. Asking whether
 * the ground itself is visible is the wrong question and gives the wrong
 * answer everywhere it matters: a gunner crouched behind his own sandbags can
 * see the chest of a man at thirty metres and cannot see the earth under his
 * boots, and it is the chest he is shooting at.
 *
 * Deliberately blind to smoke: raking a spot you know about through a cloud is
 * the entire point. A wall in the way is a different matter, and stops it.
 */
export function canReach(scene: Scene, shooter: Unit, aim: Vec2): boolean {
  if (dist(shooter.pos, aim) > shooter.weapon.maxRange) return false;
  return scene.sightThroughSmoke(
    { x: shooter.pos.x, y: shooter.pos.y, eye: eyeOf(shooter) },
    { x: aim.x, y: aim.y, base: 0, top: Stature.standingTop },
  ).visible;
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
      // As the other two places a man goes down do. Left set, the snapshot
      // and anything reading it had a casualty still on his way somewhere.
      target.slot = null;
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
  return { hit, impact, damage, killedOrDowned };
}
