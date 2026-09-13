import {
  type Vec2, angleDelta, angleOf, clamp, dist, distSq, dot, fromAngle, lerp,
  normalize, sub, turnToward, vec,
} from './math.ts';
import type { Rng } from './rng.ts';
import type { World } from './world.ts';
import { hasLineOfSight } from './los.ts';
import { findPath } from './pathfind.ts';
import {
  Faction, MoveMode, Posture, UnitState, type Unit, isMoving, speedOf,
} from './units.ts';
import {
  type Effect, PIN_THRESHOLD, SUPPRESSION_DECAY, UNPIN_THRESHOLD, coverAgainst,
  hitChance, resolveShot,
} from './combat.ts';
import type { Squad } from './squads.ts';

export interface SimContext {
  world: World;
  rng: Rng;
  units: Map<number, Unit>;
  unitList: Unit[];
  squads: Squad[];
  effects: Effect[];
  time: number;
}

const VISION_RANGE = 27;
const VISION_HALF_ANGLE = Math.cos((58 * Math.PI) / 180);
/** You notice someone at arm's length regardless of where you are looking. */
const AWARENESS_RADIUS = 5.5;
/** Spotting progress needed before an operator will engage a contact. */
const SPOT_ACQUIRE = 1;
/** Progress saturates above the threshold, buying a grace period on lost sight. */
const SPOT_MAX = 1.6;
const SPOT_BASE_RATE = 2.2;
const SPOT_DECAY = 0.5;
const TURN_RATE = 4.6;
/** Muzzle must be within this of the target before a round goes out. */
const AIM_TOLERANCE = 0.22;
const MEMORY_LIFETIME = 20;

/**
 * How conspicuous this operator is. A man sprinting across a courtyard grabs
 * the eye; the same man crouched behind a wall does not.
 *
 * This scales how FAST you get noticed, never whether you can be noticed at
 * all. Making it a hard range cut-off instead is tempting and quietly fatal:
 * two elements both sitting in good cover stop being able to see each other,
 * and the firefight puts itself out.
 */
function signature(u: Unit): number {
  let s: number;
  if (isMoving(u)) s = u.moveMode === MoveMode.Sprint ? 1.0 : 0.8;
  else s = u.posture === Posture.Crouched ? 0.42 : 0.6;
  // Leaning out to shoot shows you; a muzzle flash shows you to everyone.
  s += u.exposure * 0.25;
  return s;
}

function inView(ctx: SimContext, observer: Unit, target: Unit, d: number): boolean {
  if (d > VISION_RANGE) return false;
  if (d > AWARENESS_RADIUS) {
    const toTarget = normalize(sub(target.pos, observer.pos));
    if (dot(toTarget, fromAngle(observer.facing)) < VISION_HALF_ANGLE) return false;
  }
  return hasLineOfSight(ctx.world, observer.pos, target.pos);
}

function spotRate(target: Unit, d: number): number {
  const rangeFactor = 1 - 0.7 * clamp(d / VISION_RANGE, 0, 1);
  let rate = SPOT_BASE_RATE * signature(target) * rangeFactor;
  // Opening fire announces you, wherever you are hiding.
  if (target.lastShotAt < 0.6) rate *= 3;
  return rate;
}

function updateSenses(ctx: SimContext, u: Unit, dt: number): void {
  u.visible.length = 0;

  for (const other of ctx.unitList) {
    if (other.faction === u.faction) continue;
    // A man who is down is not a contact. Counting him as one keeps squads
    // "in a firefight" with a casualty forever.
    if (other.state !== UnitState.Active) {
      u.spotting.delete(other.id);
      continue;
    }

    const d = dist(u.pos, other.pos);
    const seen = inView(ctx, u, other, d);
    let progress = u.spotting.get(other.id) ?? 0;
    progress = seen
      ? clamp(progress + spotRate(other, d) * dt, 0, SPOT_MAX)
      : clamp(progress - SPOT_DECAY * dt, 0, SPOT_MAX);

    if (progress <= 0) u.spotting.delete(other.id);
    else u.spotting.set(other.id, progress);

    if (progress >= SPOT_ACQUIRE) {
      u.visible.push(other.id);
      u.memory.set(other.id, { pos: { ...other.pos }, age: 0 });
    }
  }

  for (const [id, mem] of u.memory) {
    mem.age += dt;
    if (mem.age > MEMORY_LIFETIME) u.memory.delete(id);
  }
}

/**
 * Squads share contacts. One operator seeing a muzzle flash means the whole
 * team knows, which is both realistic and the only way a 4-man element behaves
 * coherently without the player narrating it.
 */
function shareContacts(ctx: SimContext, squad: Squad): void {
  const pooled = new Map<number, { pos: Vec2; age: number }>();
  for (const id of squad.memberIds) {
    const u = ctx.units.get(id);
    if (!u) continue;
    for (const [eid, mem] of u.memory) {
      const existing = pooled.get(eid);
      if (!existing || mem.age < existing.age) pooled.set(eid, mem);
    }
  }
  for (const id of squad.memberIds) {
    const u = ctx.units.get(id);
    if (!u) continue;
    for (const [eid, mem] of pooled) {
      const own = u.memory.get(eid);
      if (!own || own.age > mem.age) u.memory.set(eid, { pos: { ...mem.pos }, age: mem.age });
    }
  }
}

/** Pick a target: prefer what we can actually hit, then what is closest. */
function selectTarget(ctx: SimContext, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestScore = -Infinity;

  for (const id of u.visible) {
    const t = ctx.units.get(id);
    if (!t || t.state !== UnitState.Active) continue;
    const bd = hitChance(ctx.world, u, t);
    if (bd.blocked) continue;
    const d = bd.range;
    let score = bd.chance * 3 - d * 0.05;
    // Stay on the current target rather than flicking between two equals.
    if (u.targetId === id) score += 0.35;
    // A machine gunner shooting at you is the most urgent thing on the field.
    if (t.weapon.suppressionPower > 2) score += 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function updatePosture(u: Unit): void {
  if (u.suppression >= PIN_THRESHOLD) {
    u.posture = Posture.Pinned;
    return;
  }
  if (u.posture === Posture.Pinned && u.suppression > UNPIN_THRESHOLD) return;
  const inCover =
    u.claimedNode !== null && dist(u.pos, u.claimedNode.pos) < 0.5 && !isMoving(u);
  u.posture = inCover ? Posture.Crouched : Posture.Standing;
}

/**
 * Exposure oscillates: out to shoot, back down between bursts. It is why a
 * suppressed position still gets hit, and why hunkering actually saves you.
 */
function updateExposure(u: Unit, dt: number): void {
  let want: number;
  if (u.posture === Posture.Pinned) want = 0.12;
  else if (isMoving(u)) want = u.moveMode === MoveMode.Sprint ? 1 : 0.8;
  else if (u.burstRemaining > 0) want = 0.9;
  else if (u.posture === Posture.Crouched) want = u.targetId !== null ? 0.45 : 0.25;
  else want = 0.75;
  u.exposure = lerp(u.exposure, want, clamp(dt * 4.5, 0, 1));
}

function separation(ctx: SimContext, u: Unit): Vec2 {
  let fx = 0;
  let fy = 0;
  for (const other of ctx.unitList) {
    if (other === u || other.state === UnitState.Dead) continue;
    const d2 = distSq(u.pos, other.pos);
    if (d2 > 0.81 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const push = (0.9 - d) / 0.9;
    fx += ((u.pos.x - other.pos.x) / d) * push;
    fy += ((u.pos.y - other.pos.y) / d) * push;
  }
  return vec(fx * 2.2, fy * 2.2);
}

function stepMovement(ctx: SimContext, u: Unit, dt: number): void {
  if (u.posture === Posture.Pinned) {
    u.velocity = vec(0, 0);
    return;
  }
  if (u.pathIndex >= u.path.length) {
    u.velocity = vec(0, 0);
    if (u.path.length > 0) u.path.length = 0;
    return;
  }

  const waypoint = u.path[u.pathIndex];
  if (dist(u.pos, waypoint) < 0.2) {
    u.pathIndex++;
    if (u.pathIndex >= u.path.length) {
      u.path.length = 0;
      u.pathIndex = 0;
      u.velocity = vec(0, 0);
    }
    return;
  }

  const dir = normalize(sub(waypoint, u.pos));
  const speed = speedOf(u);
  const sep = separation(ctx, u);
  const vx = dir.x * speed + sep.x;
  const vy = dir.y * speed + sep.y;

  // Move each axis independently so a clipped shoulder slides along the wall
  // instead of stopping the operator dead.
  const nx = u.pos.x + vx * dt;
  const ny = u.pos.y + vy * dt;
  if (ctx.world.walkable(Math.floor(nx), Math.floor(u.pos.y))) u.pos.x = nx;
  if (ctx.world.walkable(Math.floor(u.pos.x), Math.floor(ny))) u.pos.y = ny;
  u.velocity = vec(vx, vy);
}

function updateWeaponHandling(u: Unit, dt: number): void {
  if (isMoving(u) && u.moveMode === MoveMode.Sprint) {
    // Muzzle drops while running. Getting it back up is the price of speed.
    u.weaponReady = clamp(u.weaponReady - dt * 1.5, 0.15, 1);
  } else {
    u.weaponReady = clamp(u.weaponReady + dt * 1.1, 0, 1);
  }

  if (u.reloadTimer > 0) {
    u.reloadTimer -= dt;
    if (u.reloadTimer <= 0) {
      u.reloadTimer = 0;
      u.ammoInMag = u.weapon.magSize;
    }
  }
  if (u.fireCooldown > 0) u.fireCooldown -= dt;
  if (u.burstPauseTimer > 0) u.burstPauseTimer -= dt;
  u.lastShotAt += dt;
}

function tryFire(ctx: SimContext, u: Unit, target: Unit, dt: number): void {
  if (u.reloadTimer > 0) return;
  if (isMoving(u) && u.moveMode === MoveMode.Sprint) return;
  if (u.weaponReady < 0.4) return;

  if (u.ammoInMag <= 0) {
    u.reloadTimer = u.weapon.reloadTime;
    u.burstRemaining = 0;
    return;
  }

  // Must be looking at them. This is what makes an unexpected flank hurt:
  // the half-second of turning is a half-second of not shooting back.
  const desired = angleOf(sub(target.pos, u.pos));
  if (Math.abs(angleDelta(u.facing, desired)) > AIM_TOLERANCE) return;

  if (u.posture === Posture.Pinned) {
    // Blind fire over the top: keeps a pinned element from being entirely free
    // to walk up on, without letting it fight properly.
    if (!ctx.rng.chance(dt * 0.4)) return;
  }

  if (u.burstRemaining <= 0) {
    if (u.burstPauseTimer > 0) return;
    u.burstRemaining = u.weapon.burst;
  }

  if (u.fireCooldown > 0) return;

  resolveShot(ctx.world, ctx.rng, ctx.unitList, u, target, ctx.effects);
  u.ammoInMag--;
  u.lastShotAt = 0;
  u.fireCooldown = 60 / u.weapon.rpm;
  u.burstRemaining--;

  if (u.burstRemaining <= 0) {
    u.burstPauseTimer = u.weapon.burstPause * ctx.rng.range(0.8, 1.3);
  }
  if (u.ammoInMag <= 0) {
    u.reloadTimer = u.weapon.reloadTime;
    u.burstRemaining = 0;
  }
}

function updateFacing(u: Unit, target: Unit | null, dt: number): void {
  let desired: number | null = null;

  if (target) {
    desired = angleOf(sub(target.pos, u.pos));
  } else if (isMoving(u) && u.moveMode === MoveMode.Sprint) {
    desired = angleOf(u.velocity);
  } else {
    // Nothing in sight: watch the last known contact, else the ordered arc.
    let freshest: { pos: Vec2; age: number } | null = null;
    for (const [, mem] of u.memory) {
      if (!freshest || mem.age < freshest.age) freshest = mem;
    }
    if (freshest && freshest.age < 8) desired = angleOf(sub(freshest.pos, u.pos));
    else if (u.postFacing !== null && !isMoving(u)) desired = u.postFacing;
    else if (isMoving(u)) desired = angleOf(u.velocity);
  }

  if (desired === null) return;
  const rate = TURN_RATE * (u.posture === Posture.Pinned ? 0.4 : 1);
  u.facing = turnToward(u.facing, desired, rate * dt);
}

function updateCondition(u: Unit, dt: number): void {
  u.suppression = clamp(u.suppression - SUPPRESSION_DECAY * dt, 0, 1);

  if (isMoving(u) && u.moveMode === MoveMode.Sprint) {
    u.stamina = clamp(u.stamina - dt * 0.14, 0, 1);
  } else {
    u.stamina = clamp(u.stamina + dt * 0.07, 0, 1);
  }
}

/** Re-path when the assigned slot no longer matches where we are headed. */
function ensurePath(ctx: SimContext, u: Unit, dt: number): void {
  if (u.repathTimer > 0) u.repathTimer -= dt;
  if (!u.slot) return;

  if (dist(u.pos, u.slot) < 0.25) {
    u.slot = null;
    u.path.length = 0;
    u.pathIndex = 0;
    return;
  }

  const heading = u.path.length > 0 ? u.path[u.path.length - 1] : null;
  if (heading && dist(heading, u.slot) < 0.3) return;
  if (u.repathTimer > 0) return;

  const path = findPath(ctx.world, u.pos, u.slot);
  if (path) {
    u.path = path;
    u.pathIndex = 0;
    return;
  }

  // Unreachable right now — often just a teammate standing in the doorway.
  // Fall back to the squad's own order point, and if even that fails, wait and
  // try again rather than silently dropping the order on the floor.
  const order = ctx.squads[u.squadId]?.order;
  if (order) {
    const fallback = findPath(ctx.world, u.pos, order.dest);
    if (fallback) {
      if (u.claimedNode) {
        u.claimedNode.claimedBy = null;
        u.claimedNode = null;
      }
      u.slot = { ...order.dest };
      u.path = fallback;
      u.pathIndex = 0;
      return;
    }
  }
  u.repathTimer = 0.5;
}

/**
 * Nobody gets left. If the team has no contacts, the nearest operator peels off
 * to stabilise a downed man — the cheapest way to make losses feel like losses
 * rather than a unit count going down.
 */
function considerCasualties(ctx: SimContext, squad: Squad): void {
  const members = squad.memberIds
    .map((id) => ctx.units.get(id))
    .filter((u): u is Unit => !!u);
  const anyContact = members.some((m) => m.state === UnitState.Active && m.visible.length > 0);
  if (anyContact) return;

  const casualties = members.filter((m) => m.state === UnitState.Down && !m.stabilized);
  if (casualties.length === 0) return;

  for (const casualty of casualties) {
    const helper = members
      .filter((m) => m.state === UnitState.Active && !isMoving(m) && !m.slot)
      .sort((a, b) => dist(a.pos, casualty.pos) - dist(b.pos, casualty.pos))[0];
    if (!helper) continue;
    const d = dist(helper.pos, casualty.pos);
    if (d < 1.2) {
      casualty.stabilized = true;
      casualty.bleedout = Math.max(casualty.bleedout, 9999);
    } else if (d < 14) {
      helper.slot = { ...casualty.pos };
    }
  }
}

function updateDowned(u: Unit, dt: number): void {
  if (u.stabilized) return;
  u.bleedout -= dt;
  if (u.bleedout <= 0) u.state = UnitState.Dead;
}

/**
 * Hostiles hold what they were given, but they are not furniture: take their
 * cover away by flanking it and they will move to something that still works.
 */
function updateHostileInitiative(ctx: SimContext, u: Unit): void {
  if (u.faction !== Faction.Hostile) return;
  if (isMoving(u) || u.slot) return;
  if (u.posture === Posture.Pinned) return;

  const target = u.targetId ? ctx.units.get(u.targetId) : null;
  if (!target) return;

  const protection = coverAgainst(u, target.pos);
  if (protection > 0.25) return;

  // We are in the open relative to this threat. Find something better nearby.
  const threatDir = normalize(sub(target.pos, u.pos));
  const options = ctx.world.coverNear(u.pos, 6).filter((n) => n.claimedBy === null);
  let best = null;
  let bestScore = 0.3;
  for (const node of options) {
    let value = 0;
    for (const arc of node.arcs) {
      if (dot(arc.dir, threatDir) > 0.4) value = Math.max(value, arc.value);
    }
    if (value <= 0) continue;
    const score = value - dist(node.pos, u.pos) * 0.06;
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  if (best) {
    if (u.claimedNode) u.claimedNode.claimedBy = null;
    best.claimedBy = u.id;
    u.claimedNode = best;
    u.slot = { ...best.pos };
    u.moveMode = MoveMode.Tactical;
  }
}

export function updateUnit(ctx: SimContext, u: Unit, dt: number): void {
  if (u.state === UnitState.Dead) return;
  if (u.state === UnitState.Down) {
    updateDowned(u, dt);
    return;
  }

  updateSenses(ctx, u, dt);
  updateCondition(u, dt);
  updatePosture(u);
  updateWeaponHandling(u, dt);

  const target = selectTarget(ctx, u);
  u.targetId = target?.id ?? null;

  updateHostileInitiative(ctx, u);
  ensurePath(ctx, u, dt);
  stepMovement(ctx, u, dt);
  updateExposure(u, dt);
  updateFacing(u, target, dt);

  if (target) tryFire(ctx, u, target, dt);
}

export function updateSquad(ctx: SimContext, squad: Squad): void {
  shareContacts(ctx, squad);
  if (squad.faction === Faction.Player) considerCasualties(ctx, squad);
}
