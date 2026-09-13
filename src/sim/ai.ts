import {
  type Vec2, angleDelta, angleOf, clamp, dist, distSq, dot, fromAngle, lerp,
  normalize, sub, turnToward, vec,
} from './math.ts';
import type { Rng } from './rng.ts';
import type { Scene } from './world/scene.ts';
import { Stature } from './world/occlusion.ts';
import {
  Faction, MoveMode, Posture, UnitState, type Unit, eyeOf, isMoving, silhouetteOf, speedOf,
} from './units.ts';
import {
  type Effect, PIN_THRESHOLD, SUPPRESSION_DECAY, UNPIN_THRESHOLD, hitChance, resolveShot,
} from './combat.ts';
import {
  type InFlight, FRAG_RADIUS, Ordnance, canThrow, dangerFrom, launch, spend, stockOf,
} from './ordnance.ts';
import type { Squad } from './squads.ts';

export interface SimContext {
  scene: Scene;
  rng: Rng;
  units: Map<number, Unit>;
  unitList: Unit[];
  squads: Squad[];
  effects: Effect[];
  live: InFlight[];
  time: number;
}

const VISION_RANGE = 85;
const VISION_HALF_ANGLE = Math.cos((58 * Math.PI) / 180);
/** You notice someone at arm's length regardless of where you are looking. */
const AWARENESS_RADIUS = 7;
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

interface Look {
  seen: boolean;
  exposure: number;
  concealment: number;
  distance: number;
}

function look(ctx: SimContext, observer: Unit, target: Unit): Look {
  const d = dist(observer.pos, target.pos);
  if (d > VISION_RANGE) return { seen: false, exposure: 0, concealment: 0, distance: d };
  if (d > AWARENESS_RADIUS) {
    const toTarget = normalize(sub(target.pos, observer.pos));
    if (dot(toTarget, fromAngle(observer.facing)) < VISION_HALF_ANGLE) {
      return { seen: false, exposure: 0, concealment: 0, distance: d };
    }
  }
  const sighting = ctx.scene.sight(
    { x: observer.pos.x, y: observer.pos.y, eye: eyeOf(observer) },
    { x: target.pos.x, y: target.pos.y, base: 0, top: silhouetteOf(target) },
    VISION_RANGE,
  );
  return {
    // Thick enough and it stops being a matter of how fast you notice him: he
    // is not there to be noticed. This is what a canister actually buys —
    // being lost, not merely being harder to see — and it is why smoke is
    // worth carrying when a hedgerow is only worth walking behind.
    seen: sighting.visible && sighting.concealment < 0.88,
    exposure: sighting.exposure,
    concealment: sighting.concealment,
    distance: sighting.distance,
  };
}

function spotRate(target: Unit, view: Look): number {
  const rangeFactor = 1 - 0.7 * clamp(view.distance / VISION_RANGE, 0, 1);
  // Showing less of yourself is exactly as good as being further away, which
  // is why a man in a ditch is so hard to find.
  let rate = SPOT_BASE_RATE * signature(target) * rangeFactor * view.exposure;
  rate *= 1 - view.concealment * 0.85;
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

    const view = look(ctx, u, other);
    let progress = u.spotting.get(other.id) ?? 0;
    progress = view.seen
      ? clamp(progress + spotRate(other, view) * dt, 0, SPOT_MAX)
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
    const bd = hitChance(ctx.scene, u, t);
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
  const settled = u.coverSpot !== null && dist(u.pos, u.coverSpot) < 0.8 && !isMoving(u);
  u.posture = settled ? Posture.Crouched : Posture.Standing;
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
  // Climbing costs you. Gentle ground is free; a steep bank halves your pace.
  const slope = ctx.scene.terrain.slopeAt(u.pos.x, u.pos.y);
  const speed = speedOf(u) * (1 - clamp(slope * 0.45, 0, 0.5));
  const sep = separation(ctx, u);
  const vx = dir.x * speed + sep.x;
  const vy = dir.y * speed + sep.y;

  // Move each axis independently so a clipped shoulder slides along the wall
  // instead of stopping the operator dead.
  const nx = u.pos.x + vx * dt;
  const ny = u.pos.y + vy * dt;
  if (ctx.scene.walkable(nx, u.pos.y)) u.pos.x = nx;
  if (ctx.scene.walkable(u.pos.x, ny)) u.pos.y = ny;
  u.velocity = vec(vx, vy);
  u.groundHeight = ctx.scene.heightAt(u.pos.x, u.pos.y);
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

  resolveShot(ctx.scene, ctx.rng, ctx.unitList, u, target, ctx.effects);
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

  if (dist(u.pos, u.slot) < 0.6) {
    // Arrived. This is the position being held now, which is what makes the
    // operator settle and crouch into it.
    u.coverSpot = { ...u.slot };
    u.slot = null;
    u.path.length = 0;
    u.pathIndex = 0;
    return;
  }

  const heading = u.path.length > 0 ? u.path[u.path.length - 1] : null;
  if (heading && dist(heading, u.slot) < 0.3) return;
  if (u.repathTimer > 0) return;

  const path = ctx.scene.findPath(u.pos, u.slot);
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
    const fallback = ctx.scene.findPath(u.pos, order.dest);
    if (fallback) {
      u.coverSpot = null;
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
 * Hostiles hold what they were given, but they are not furniture. If most of a
 * man is showing to whoever is shooting at him, he is not in a position — he
 * is merely standing somewhere — and he will go and find one.
 */
function updateHostileInitiative(ctx: SimContext, u: Unit): void {
  if (u.faction !== Faction.Hostile) return;
  if (isMoving(u) || u.slot) return;
  if (u.posture === Posture.Pinned) return;

  const target = u.targetId ? ctx.units.get(u.targetId) : null;
  if (!target) return;

  const showing = ctx.scene.sight(
    { x: target.pos.x, y: target.pos.y, eye: eyeOf(target) },
    { x: u.pos.x, y: u.pos.y, base: 0, top: silhouetteOf(u) },
  ).exposure;
  if (showing < 0.55) return;

  const better = ctx.scene.findCover(u.pos, 7, target.pos, {
    crouchTop: Stature.crouchedTop,
    eye: Stature.crouchedEye,
    samples: 24,
  });
  const pick = better.find((c) => c.exposure < showing - 0.25 && c.canFire);
  if (pick) {
    u.slot = { ...pick.pos };
    u.moveMode = MoveMode.Tactical;
  }
}

/**
 * Get away from the thing fizzing on the ground.
 *
 * This is the other half of what makes a grenade a tactic rather than a
 * damage roll. Cooking for a second means the defender gets to decide, so the
 * grenade's real effect is that it moves him — out of the position he was
 * holding, into the open, at the moment your base of fire is looking at him.
 * A man who breaks cover and is missed has still been beaten.
 */
function avoidBlast(ctx: SimContext, u: Unit): boolean {
  const danger = dangerFrom(ctx.live, u.faction);
  if (!danger) {
    // Nothing live any more: drop back to the tempo the order asked for, or a
    // man blown out of his position would spend the rest of the fight running
    // with his weapon down.
    if (u.moveMode === MoveMode.Sprint && u.diving && !u.slot) {
      u.diving = false;
      u.moveMode = ctx.squads[u.squadId]?.order?.mode ?? MoveMode.Tactical;
    }
    return false;
  }
  const d = dist(u.pos, danger);
  if (d > FRAG_RADIUS + 1.5) return false;
  // Already running from this one. Re-solving it twenty times a second buys
  // nothing and costs an A* each time.
  if (u.diving && u.slot && dist(u.slot, danger) > FRAG_RADIUS) return true;

  // Straight away from it, as far as the ground allows.
  const away = normalize(sub(u.pos, danger));
  for (const reach of [FRAG_RADIUS + 3, FRAG_RADIUS + 1, FRAG_RADIUS - 1]) {
    for (const turn of [0, 0.5, -0.5, 1.0, -1.0]) {
      const a = Math.atan2(away.y, away.x) + turn;
      const p = vec(danger.x + Math.cos(a) * reach, danger.y + Math.sin(a) * reach);
      if (!ctx.scene.walkable(p.x, p.y)) continue;
      if (!ctx.scene.findPath(u.pos, p)) continue;
      u.coverSpot = null;
      u.slot = p;
      u.moveMode = MoveMode.Sprint;
      u.diving = true;
      return true;
    }
  }
  return false;
}

/**
 * Hostiles grenade you out of cover, for the same reason you grenade them.
 *
 * The trigger is precisely the situation rifle fire cannot solve: someone is
 * there, he is close, and shooting at him is not working. Leaving this out
 * would have made every defended position a one-way problem.
 */
function considerGrenade(ctx: SimContext, u: Unit): void {
  if (u.faction !== Faction.Hostile) return;
  if (u.throwCooldown > 0 || stockOf(u, Ordnance.Frag) <= 0) return;
  if (u.posture === Posture.Pinned || isMoving(u)) return;

  const throwAt = (at: Vec2): boolean => {
    const d = dist(u.pos, at);
    // Not across the field, and not at his own feet.
    if (d > 24 || d < 6) return false;
    if (!canThrow(ctx.scene, u, at)) return false;
    spend(u, Ordnance.Frag);
    ctx.live.push(launch(ctx.scene, u, Ordnance.Frag, { ...at }));
    return true;
  };

  for (const id of u.visible) {
    const t = ctx.units.get(id);
    if (!t || t.state !== UnitState.Active) continue;
    const shot = hitChance(ctx.scene, u, t);
    // Only when shooting at him is not the answer.
    if (!shot.blocked && shot.exposure > 0.3) continue;
    if (throwAt(t.pos)) return;
  }

  // And at where he went, which is the case that matters most: a man who has
  // just put a wall between himself and you is not a contact any more, and if
  // losing sight of him ended the exchange, cover would be an off switch.
  for (const [id, seen] of u.memory) {
    if (seen.age > 5) continue;
    if (u.visible.includes(id)) continue;
    const t = ctx.units.get(id);
    if (!t || t.state !== UnitState.Active) continue;
    if (throwAt(seen.pos)) return;
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

  const fleeing = avoidBlast(ctx, u);
  if (!fleeing) considerGrenade(ctx, u);
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
