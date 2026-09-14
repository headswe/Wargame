import { type Vec2, angleOf, clamp, dist, normalize, sub, vec } from './math.ts';
import { Faction, UnitState, type Unit } from './units.ts';

export const Nerve = {
  /** Fighting. */
  Steady: 0,
  /** Still fighting, worse, and unwilling to give up any more ground. */
  Wavering: 1,
  /** Out of the fight: withdrawing, not shooting, not taking orders. */
  Broken: 2,
} as const;
export type Nerve = (typeof Nerve)[keyof typeof Nerve];

export interface Morale {
  /** 0..1. One is a fresh team; zero is a team that has had enough. */
  nerve: number;
  state: Nerve;
  /** Active members last tick, so a casualty can be felt as an event. */
  lastActive: number;
  /** Sim time before which a broken team will not begin to rally. */
  rallyAt: number;
  /** Ground it is heading for while broken. */
  refuge: Vec2 | null;
}

export function freshMorale(): Morale {
  return { nerve: 1, state: Nerve.Steady, lastActive: -1, rallyAt: 0, refuge: null };
}

/** Below this a team is visibly shaken. */
const WAVER_AT = 0.38;
/** Below this it stops being a team. */
const BREAK_AT = 0.14;
/** And it needs this much back before it is one again. */
const RALLY_AT = 0.42;
/** Seconds a broken team stays broken no matter what. */
const RALLY_DELAY = 9;

/** Nerve lost per second at full suppression. */
const FIRE_DRAIN = 0.15;
/**
 * Nerve lost for losing the whole team, apportioned by how much of it went.
 *
 * Proportional rather than flat, because one man down out of three is most of
 * a position and one out of a dozen is not, and a flat figure cannot say both.
 *
 * It is deliberately the dominant term. Suppression ought to be what breaks a
 * team, and in a game with the volume of fire to sustain it that is how this
 * would be weighted — but measured across a full assault, defenders here spend
 * eight seconds out of eight hundred under fire worth the name, because four
 * hits kill a man and four hits are also what it takes to pin him. Until that
 * changes, losses are what a team has to read the fight by, and weighting the
 * other way would mean nothing ever broke at all.
 */
const CASUALTY_SHOCK = 1.3;
/** And the extra for losing the man giving the orders. */
const LEADER_SHOCK = 0.16;
/**
 * Nerve recovered per second, once genuinely out of contact.
 *
 * Deliberately slow, and deliberately gated on there being nothing in front of
 * them rather than merely on the shooting having paused. An earlier pass had
 * recovery at roughly the rate fire drained it, so nerve sat at full through
 * entire firefights and nothing ever broke: the two have to be far enough
 * apart that a bad ten seconds leaves a mark that lasts a minute.
 */
const RECOVERY = 0.025;
/** How much worse it is to be shot at from two directions instead of one. */
const ENVELOPED = 1.7;

/**
 * How a team is holding up, as distinct from how hard it is being shot at.
 *
 * Suppression is a property of this second — rounds are cracking past, so you
 * cannot aim. Nerve is a property of the last minute: men are down, it has been
 * going badly, and there is fire coming from two directions. Keeping them apart
 * matters because they want opposite treatment. Suppression has to recover in
 * seconds or a firefight locks up; nerve has to recover slowly or breaking a
 * position means nothing, since it would re-form before you could take it.
 *
 * The payoff is that suppression finally buys something. Until now, fire that
 * did not kill only degraded accuracy for as long as it kept coming, so the
 * only way to take ground was to kill everyone standing on it. A team that
 * breaks is ground you have won without paying for it in bodies, which is the
 * whole argument for a base of fire.
 */
export function updateMorale(
  morale: Morale,
  members: Unit[],
  time: number,
  dt: number,
): void {
  const active = members.filter((u) => u.state === UnitState.Active);

  // Casualties are felt as events rather than as a slow slide, because that is
  // how they land: the team was fine, and then Marek went down.
  if (morale.lastActive >= 0 && active.length < morale.lastActive) {
    const lost = morale.lastActive - active.length;
    morale.nerve -= CASUALTY_SHOCK * (lost / Math.max(1, members.length));
    // Only where there was a leader to lose. Checking the survivors alone
    // charged every irregular squad on the map for the absence of a rank they
    // never had.
    const hadLeader = members.some((u) => u.role === 'Team Leader');
    if (hadLeader && !active.some((u) => u.role === 'Team Leader')) morale.nerve -= LEADER_SHOCK;
  }
  morale.lastActive = active.length;

  if (active.length === 0) {
    morale.nerve = 0;
    morale.state = Nerve.Broken;
    return;
  }

  const pressure = active.reduce((a, u) => a + u.suppression, 0) / active.length;
  const inContact = active.some(
    (u) => u.visible.length > 0 || [...u.memory.values()].some((m) => m.age < 5),
  );

  if (pressure > 0.02) {
    // A team down to its last man or two frays faster than a whole one under
    // the same fire, which is most of why squads are the unit of morale.
    const strength = active.length / Math.max(1, members.length);
    const thin = 1 + (1 - strength) * 1.2;
    morale.nerve -= FIRE_DRAIN * pressure * thin * spreadOfThreats(active) * dt;
  } else if (!inContact) {
    morale.nerve += RECOVERY * dt;
  }
  morale.nerve = clamp(morale.nerve, 0, 1);

  if (morale.state === Nerve.Broken) {
    if (time >= morale.rallyAt && morale.nerve >= RALLY_AT) {
      morale.state = Nerve.Steady;
      morale.refuge = null;
    }
    return;
  }

  if (morale.nerve <= BREAK_AT) {
    morale.state = Nerve.Broken;
    morale.rallyAt = time + RALLY_DELAY;
    morale.refuge = null;
  } else if (morale.nerve <= WAVER_AT) {
    morale.state = Nerve.Wavering;
  } else {
    morale.state = Nerve.Steady;
  }
}

/**
 * Fire from one bearing is a problem; fire from two is a reason to leave.
 *
 * Taken from what the team knows about where the enemy is, so it costs nothing
 * extra — and it is the mechanical reason flanking works on people rather than
 * only on geometry.
 */
function spreadOfThreats(active: Unit[]): number {
  const bearings: number[] = [];
  const centre = active.reduce(
    (a, u) => vec(a.x + u.pos.x / active.length, a.y + u.pos.y / active.length),
    vec(0, 0),
  );
  for (const u of active) {
    for (const [, mem] of u.memory) {
      if (mem.age > 6) continue;
      const to = sub(mem.pos, centre);
      if (Math.hypot(to.x, to.y) < 1) continue;
      bearings.push(angleOf(normalize(to)));
    }
  }
  if (bearings.length < 2) return 1;

  let widest = 0;
  for (let i = 0; i < bearings.length; i++) {
    for (let j = i + 1; j < bearings.length; j++) {
      let d = Math.abs(bearings[i] - bearings[j]);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d > widest) widest = d;
    }
  }
  // Nothing extra below a quarter turn; full weight by a half.
  const t = clamp((widest - Math.PI / 4) / (Math.PI / 2 - Math.PI / 4), 0, 1);
  return 1 + (ENVELOPED - 1) * t;
}

/**
 * Where a broken team runs to.
 *
 * Away from what it knows about, and far enough that it is out of the fight —
 * but onto ground it can actually reach, or it would stand in the open shaking
 * instead, which reads as a bug rather than as a rout.
 */
export function findRefuge(
  active: Unit[],
  threatDir: Vec2,
  walkable: (x: number, y: number) => boolean,
  reachable: (from: Vec2, to: Vec2) => boolean,
): Vec2 | null {
  if (active.length === 0) return null;
  const centre = active.reduce(
    (a, u) => vec(a.x + u.pos.x / active.length, a.y + u.pos.y / active.length),
    vec(0, 0),
  );
  const away = Math.atan2(-threatDir.y, -threatDir.x);

  for (const range of [34, 26, 18, 12]) {
    for (const turn of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
      const a = away + turn;
      const p = vec(centre.x + Math.cos(a) * range, centre.y + Math.sin(a) * range);
      if (!walkable(p.x, p.y)) continue;
      if (!reachable(centre, p)) continue;
      return p;
    }
  }
  return null;
}

/** Whether this faction still has anyone on the field willing to fight. */
export function stillFighting(units: Unit[], faction: Faction, broken: Set<number>): boolean {
  return units.some(
    (u) => u.faction === faction && u.state === UnitState.Active && !broken.has(u.squadId),
  );
}

export { dist };
