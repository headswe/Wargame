import {
  type Vec2, clamp, dist, distPointToSegment, dot, invLerpClamped, normalize, sub,
} from './math.ts';
import type { Rng } from './rng.ts';
import type { World } from './world.ts';
import { trace } from './los.ts';
import { MoveMode, Posture, UnitState, type Unit, isMoving } from './units.ts';

/** Above this, an operator stops being a shooter and becomes a passenger. */
export const PIN_THRESHOLD = 0.72;
export const UNPIN_THRESHOLD = 0.45;
export const SUPPRESSION_DECAY = 0.25;

export interface ShotEffect {
  kind: 'shot';
  from: Vec2;
  to: Vec2;
  hit: boolean;
  shooterId: number;
  faction: number;
}

export interface HitEffect {
  kind: 'hit';
  at: Vec2;
  targetId: number;
  lethal: boolean;
}

export interface ImpactEffect {
  kind: 'impact';
  at: Vec2;
}

export type Effect = ShotEffect | HitEffect | ImpactEffect;

/**
 * How much protection `unit` has from fire arriving out of `fromPos`.
 *
 * Cover is directional and it is not free: an operator leaning out to return
 * fire gives up a chunk of it. That trade — shoot or stay safe — is the whole
 * reason suppression works as a mechanic.
 */
export function coverAgainst(unit: Unit, fromPos: Vec2): number {
  const node = unit.claimedNode;
  if (!node) return 0;
  // You only get cover if you are actually in it, not merely heading there.
  if (dist(unit.pos, node.pos) > 0.5) return 0;

  const toThreat = normalize(sub(fromPos, unit.pos));
  let best = 0;
  for (const arc of node.arcs) {
    const alignment = dot(arc.dir, toThreat);
    if (alignment <= 0.25) continue;
    // Full value head-on, tapering to nothing as the threat works around.
    const falloff = invLerpClamped(alignment, 0.25, 0.72);
    best = Math.max(best, arc.value * falloff);
  }
  return best * (1 - unit.exposure * 0.45);
}

function rangeFactor(d: number, optimal: number, max: number): number {
  if (d <= optimal) return 1;
  if (d >= max) return 0.1;
  const t = (d - optimal) / (max - optimal);
  return 1 - 0.9 * Math.pow(t, 1.35);
}

function shooterStanceFactor(u: Unit): number {
  if (isMoving(u)) {
    return u.moveMode === MoveMode.Sprint ? 0 : 0.5;
  }
  return u.posture === Posture.Crouched ? 1.12 : 1;
}

function targetMotionFactor(t: Unit): number {
  if (!isMoving(t)) return 1;
  return t.moveMode === MoveMode.Sprint ? 0.72 : 0.88;
}

export interface HitBreakdown {
  chance: number;
  cover: number;
  range: number;
  blocked: boolean;
}

/** Full hit-chance breakdown — the UI shows these numbers, so keep them honest. */
export function hitChance(
  world: World,
  shooter: Unit,
  target: Unit,
): HitBreakdown {
  const d = dist(shooter.pos, target.pos);
  const t = trace(world, shooter.pos, target.pos);
  if (!t.clear || d > shooter.weapon.maxRange) {
    return { chance: 0, cover: 0, range: d, blocked: true };
  }

  const cover = coverAgainst(target, shooter.pos);
  const obstruction = Math.min(0.5, t.lowCrossed * 0.13);

  let p = shooter.weapon.accuracy;
  p *= rangeFactor(d, shooter.weapon.optimalRange, shooter.weapon.maxRange);
  p *= shooterStanceFactor(shooter);
  p *= 1 - shooter.suppression * 0.78;
  p *= shooter.weaponReady;
  p *= 1 - cover;
  p *= targetMotionFactor(target);
  p *= 1 - obstruction;
  if (shooter.posture === Posture.Pinned) p *= 0.2;

  return { chance: clamp(p, 0, 0.95), cover, range: d, blocked: false };
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
    const proximity = 1 - invLerpClamped(d, 0.3, 1.8);
    u.suppression = clamp(u.suppression + power * 0.022 * proximity, 0, 1);
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
  world: World,
  rng: Rng,
  units: Unit[],
  shooter: Unit,
  target: Unit,
  effects: Effect[],
): ShotOutcome {
  const breakdown = hitChance(world, shooter, target);
  const hit = !breakdown.blocked && rng.chance(breakdown.chance);

  let impact: Vec2;
  let damage = 0;
  let killedOrDowned = false;

  if (hit) {
    impact = { ...target.pos };
    const headshot = rng.chance(0.07);
    damage = shooter.weapon.damage * rng.range(0.85, 1.15) * (headshot ? 2.2 : 1);
    target.hp -= damage;
    // Being hit is its own kind of suppression.
    target.suppression = clamp(target.suppression + 0.22, 0, 1);
    if (target.hp <= 0) {
      target.hp = 0;
      target.state = UnitState.Down;
      target.bleedout = 42;
      target.path = [];
      target.pathIndex = 0;
      if (target.claimedNode) {
        target.claimedNode.claimedBy = null;
        target.claimedNode = null;
      }
      killedOrDowned = true;
    }
    effects.push({ kind: 'hit', at: impact, targetId: target.id, lethal: killedOrDowned });
  } else {
    // A miss scatters off the aim point, further out at longer range.
    const d = breakdown.range;
    const spread = 0.35 + d * 0.055 * (1 - breakdown.chance);
    const aim = {
      x: target.pos.x + rng.gaussian() * spread,
      y: target.pos.y + rng.gaussian() * spread,
    };
    const t = trace(world, shooter.pos, aim);
    impact = t.hit ?? aim;
    effects.push({ kind: 'impact', at: impact });
  }

  effects.push({
    kind: 'shot',
    from: { ...shooter.pos },
    to: impact,
    hit,
    shooterId: shooter.id,
    faction: shooter.faction,
  });

  applySuppressionAlong(
    units,
    shooter.pos,
    impact,
    shooter.faction,
    shooter.weapon.suppressionPower,
  );

  return { hit, impact, damage, killedOrDowned };
}
