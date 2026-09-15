import { type Vec2, angleOf, dist, normalize, sub, vec } from './math.ts';
import { Nerve, type Unit, Faction, UnitState } from './units.ts';
import type { Squad } from './squads.ts';
import type { SimContext } from './ai.ts';

/**
 * Somebody commanding the defence, rather than fourteen men who dug a hole once.
 *
 * Measured over five assaults, a surviving defender ended the mission a mean of
 * two metres from where he started, and most of that was routing. The only
 * reaction on that side is one man shuffling seven metres when he personally
 * gets too exposed. So the defence is not a defence: it is a set of turrets
 * with morale, it plays the same way every time, and the only question the
 * attack has to answer is which turret to shoot first.
 *
 * What this adds is a commander with three things a position needs: a reading
 * of where the weight of the attack is, a reserve, and the willingness to give
 * ground before a squad is destroyed rather than after.
 *
 * It is deliberately not good at its job. A defence that reads an attack
 * instantly and correctly is unbeatable at worst and whack-a-mole at best;
 * everything interesting lives in the gap between what is happening and what
 * the defence believes. So it decides slowly, it needs to be fairly sure before
 * it moves anybody, and once it has committed it is reluctant to change its
 * mind — which is exactly what makes a feint worth the men it costs, and hands
 * the player a verb he did not have.
 */

/** How often the commander will even consider changing anything. */
export const DELIBERATION = 14;
/** Contacts older than this say nothing about where the attack is now. */
const CONTACT_MEMORY = 25;
/** Below this much agreement between sightings it does not act at all. */
const CONFIDENCE_TO_COMMIT = 0.45;
/** Having committed the reserve, this long before it will reconsider. */
export const COMMITMENT = 55;
/** A squad down to this share of its strength is losing and should give ground. */
const GIVE_GROUND_AT = 0.55;
/** How far back a failing position falls, towards whatever it is protecting. */
const FALLBACK_DISTANCE = 22;

export interface Defence {
  /** Squads held back rather than sited on the perimeter. */
  reserve: number[];
  /** Where the commander believes the weight of the attack is. */
  read: { at: Vec2; confidence: number } | null;
  /** Sim time it will next allow itself to think. */
  nextThought: number;
  /** Sim time the reserve was committed, so it is slow to be recalled. */
  committedAt: number;
  /** Squads already pulled back, so they are not pulled back repeatedly. */
  givenGround: number[];
}

export function freshDefence(
  squads: Squad[], units: Map<number, Unit>, objective: Vec2,
): Defence {
  // The reserve is whatever sits deepest, nearest the thing being defended. It
  // is the squad that would otherwise spend the whole mission holding a sector
  // the attack never came to, which is the commonest way a defender wastes his
  // men without anybody noticing.
  const hostile = squads.filter((s) => s.faction === Faction.Hostile);
  const depth = (squad: Squad): number => {
    const members = squad.memberIds
      .map((id) => units.get(id))
      .filter((u): u is Unit => !!u);
    return members.length === 0 ? Infinity : dist(centreOf(members), objective);
  };
  const byDepth = [...hostile].sort((a, b) => depth(a) - depth(b));
  const reserve = hostile.length >= 3 ? [byDepth[0].id] : [];
  return {
    reserve, read: null, nextThought: DELIBERATION,
    committedAt: -Infinity, givenGround: [],
  };
}

/**
 * One tick of the defending commander.
 *
 * Returns the orders it wants given, rather than giving them, so that the
 * simulation keeps one place where a squad is actually commanded and the
 * commander stays something you can test on its own.
 */
export interface DefenceOrder {
  squadId: number;
  dest: Vec2;
  facing: number;
  why: 'commit' | 'reinforce' | 'give ground';
}

export function updateDefence(
  ctx: SimContext, defence: Defence, objective: Vec2, dt: number,
): DefenceOrder[] {
  void dt;
  if (ctx.time < defence.nextThought) return [];
  defence.nextThought = ctx.time + DELIBERATION;

  const orders: DefenceOrder[] = [];
  const hostileSquads = ctx.squads.filter((s) => s.faction === Faction.Hostile);
  defence.read = readTheAttack(ctx);

  // --- give ground before a position is destroyed rather than after.
  //
  // A defence that holds every position to the last man is not brave, it is
  // being fed to the attack a squad at a time. Falling back while a squad can
  // still walk turns a wipe into a fighting withdrawal, and buys the ground
  // behind it a defence that has already seen where the attack is coming from.
  for (const squad of hostileSquads) {
    if (defence.givenGround.includes(squad.id)) continue;
    if (defence.reserve.includes(squad.id)) continue;
    const members = ctx.squads[squad.id].memberIds
      .map((id) => ctx.units.get(id))
      .filter((u): u is Unit => !!u);
    if (members.length === 0) continue;
    const standing = members.filter((u) => u.state === UnitState.Active).length;
    if (standing === 0 || standing / members.length > GIVE_GROUND_AT) continue;
    // Still able to take an order: a squad that has already broken is running
    // anyway, and telling it where to run is not the commander's to do.
    if (squad.morale.state === Nerve.Broken) continue;

    const centre = centreOf(members);
    const back = normalize(sub(objective, centre));
    if (back.x === 0 && back.y === 0) continue;
    orders.push({
      squadId: squad.id,
      dest: vec(centre.x + back.x * FALLBACK_DISTANCE, centre.y + back.y * FALLBACK_DISTANCE),
      facing: angleOf({ x: -back.x, y: -back.y }),
      why: 'give ground',
    });
    defence.givenGround.push(squad.id);
  }

  // --- commit the reserve towards wherever the weight is.
  const read = defence.read;
  if (
    read && read.confidence >= CONFIDENCE_TO_COMMIT
    && ctx.time - defence.committedAt > COMMITMENT
    && defence.reserve.length > 0
  ) {
    for (const id of defence.reserve) {
      const squad = ctx.squads[id];
      if (!squad || squad.morale.state === Nerve.Broken) continue;
      const members = squad.memberIds
        .map((m) => ctx.units.get(m))
        .filter((u): u is Unit => !!u && u.state === UnitState.Active);
      if (members.length === 0) continue;

      // Between the attack and the thing being defended, not on top of either.
      const centre = centreOf(members);
      const towards = normalize(sub(read.at, objective));
      const block = vec(
        objective.x + towards.x * BLOCK_DISTANCE,
        objective.y + towards.y * BLOCK_DISTANCE,
      );
      // Already about where it would be sent: leave it alone rather than
      // shuffling men about for the sake of having decided something.
      if (dist(centre, block) < 12) continue;
      orders.push({
        squadId: id, dest: block, facing: angleOf(towards), why: 'commit',
      });
      defence.committedAt = ctx.time;
    }
  }

  return orders;
}

/** How far forward of the objective the reserve blocks. */
const BLOCK_DISTANCE = 26;

/**
 * Where the commander thinks the attack is, and how sure it is.
 *
 * Pooled from what the defenders have actually seen, so it can be wrong and
 * can be fed. Confidence is agreement: several sightings close together are a
 * main effort, the same number spread across the map are a mystery — and a
 * commander who acts on a mystery is one the player cannot mislead.
 */
function readTheAttack(ctx: SimContext): Defence['read'] {
  const seen: Vec2[] = [];
  for (const u of ctx.unitList) {
    if (u.faction !== Faction.Hostile || u.state !== UnitState.Active) continue;
    for (const [, mem] of u.memory) {
      if (mem.age > CONTACT_MEMORY) continue;
      seen.push(mem.pos);
    }
  }
  if (seen.length < 2) return null;

  const at = centre(seen);
  // Mean distance from the centroid, as a share of how far apart they could be.
  const spread = seen.reduce((a, p) => a + dist(p, at), 0) / seen.length;
  const confidence = Math.max(0, Math.min(1, 1 - spread / 55))
    * Math.min(1, seen.length / 5);
  return { at, confidence };
}

function centre(points: Vec2[]): Vec2 {
  return {
    x: points.reduce((a, p) => a + p.x, 0) / points.length,
    y: points.reduce((a, p) => a + p.y, 0) / points.length,
  };
}

function centreOf(members: Unit[]): Vec2 {
  const alive = members.filter((u) => u.state === UnitState.Active);
  return centre((alive.length > 0 ? alive : members).map((u) => u.pos));
}
