import { type Vec2, angleOf, clamp, dist, normalize, sub, vec } from './math.ts';
import { Nerve, UnitState, type Unit } from './units.ts';

// Nerve lives on the soldier now, so the state he can be in is declared beside
// him rather than here. Re-exported because this is still where the rules that
// move him between those states are written.
export { Nerve };

/** What a team looks like from outside, derived from the men in it. */
export interface SquadMorale {
  nerve: number;
  state: Nerve;
}

export function freshMorale(): SquadMorale {
  return { nerve: 1, state: Nerve.Steady };
}

/** Below this a man is visibly shaken. */
const WAVER_AT = 0.38;
/** Below this he stops being any use. */
const BREAK_AT = 0.14;
/** And he needs this much back before he is. */
const RALLY_AT = 0.42;
/** Seconds a man stays broken no matter what. */
const RALLY_DELAY = 9;

/** Nerve lost per second at full suppression. */
const FIRE_DRAIN = 0.16;
/** Nerve lost by a man watching a mate go down beside him. */
const CASUALTY_SHOCK = 0.3;
/** Past this it is something he hears about rather than something he sees. */
const SHOCK_RADIUS = 26;
/** Extra for losing the man who was giving the orders. */
const LEADER_SHOCK = 0.14;
/** Nerve recovered per second, once genuinely out of contact. */
const RECOVERY = 0.028;
/** Nerve lost per second by a man in contact with nobody left alongside him. */
const ALONE_DRAIN = 0.05;
/** How much worse it is to be shot at from two directions instead of one. */
const ENVELOPED = 1.7;
/** How far away a mate still counts as being with you. */
const MATE_RADIUS = 18;
/** Closing this much on what he knows about counts as advancing. */
const ADVANCE = 4;

/**
 * How one man is holding up.
 *
 * Nerve sits on the soldier rather than on his team, and that is the whole
 * point of this pass. Morale held per squad made a fireteam a single switch:
 * four men fought, then four men ran, and nothing in between ever happened.
 * Per man, a position comes apart the way positions actually come apart — the
 * one nearest the casualty goes first, his mate holds a while longer, and what
 * the player watches is a team thinning out rather than a unit toggling off.
 *
 * It is also the reason isolation can be modelled honestly. Being alone is a
 * property of a man, not of a squad, and a man whose mates are dead or fifty
 * metres away breaks far sooner than the same man in a full team — which is
 * what makes cutting a position up worth doing at all.
 */
export function updateNerve(u: Unit, mates: Unit[], time: number, dt: number): void {
  if (u.state !== UnitState.Active) {
    u.nerve = 0;
    u.nerveState = Nerve.Broken;
    return;
  }

  const near = mates.filter(
    (m) => m !== u && m.state === UnitState.Active && dist(m.pos, u.pos) < MATE_RADIUS,
  );
  const inContact = u.visible.length > 0
    || [...u.memory.values()].some((m) => m.age < 5);

  if (u.suppression > 0.02) {
    // A man on his own under the same fire as a man in a team is having a much
    // worse time of it, and should come apart correspondingly faster.
    const alone = near.length === 0 ? 1.9 : 1 + 0.6 / (1 + near.length);
    u.nerve -= FIRE_DRAIN * u.suppression * alone * spreadOfThreats(u) * dt;
  } else if (!inContact) {
    // Steadier with someone alongside you, which is most of what a team is for.
    u.nerve += RECOVERY * (near.length > 0 ? 1.35 : 1) * dt;
  }

  // Being on your own is not merely worse when they are shooting at you: it is
  // the thing itself. A man who has watched his mates go down and finds himself
  // holding a position alone is already leaving, whether or not the next round
  // comes near him — which is why cutting a position into pieces beats
  // grinding it down evenly, and why the last man of a fireteam runs rather
  // than standing there being killed.
  if (inContact && near.length === 0) u.nerve -= ALONE_DRAIN * dt;
  u.nerve = clamp(u.nerve, 0, 1);

  if (u.nerveState === Nerve.Broken) {
    if (time >= u.rallyAt && u.nerve >= RALLY_AT) {
      u.nerveState = Nerve.Steady;
      u.refuge = null;
      u.routing = false;
    }
    return;
  }

  if (u.nerve <= BREAK_AT) {
    u.nerveState = Nerve.Broken;
    u.rallyAt = time + RALLY_DELAY;
    u.refuge = null;
  } else if (u.nerve <= WAVER_AT) {
    u.nerveState = Nerve.Wavering;
  } else {
    u.nerveState = Nerve.Steady;
  }
}

/**
 * What seeing a man go down does to everyone who saw it.
 *
 * Scaled by how close he was, because that is the difference between a death
 * and a casualty report, and it is what makes concentrating fire on one corner
 * of a position worth more than spreading it evenly: the men beside him feel
 * it, and they are the ones who have to keep holding the corner.
 */
export function applyCasualtyShock(survivors: Unit[], casualty: Unit): void {
  const leader = casualty.role === 'Team Leader';
  for (const u of survivors) {
    if (u.state !== UnitState.Active) continue;
    const d = dist(u.pos, casualty.pos);
    if (d > SHOCK_RADIUS) continue;
    const closeness = 1 - (d / SHOCK_RADIUS) ** 0.7;
    u.nerve = clamp(u.nerve - (CASUALTY_SHOCK + (leader ? LEADER_SHOCK : 0)) * closeness, 0, 1);
  }
}

/**
 * Whether one man will take an order to go somewhere.
 *
 * A broken man is not listening at all. A shaken one still is — he will
 * sidestep, shuffle along the line, and pull back gladly — but he will not be
 * walked any closer to what is shooting at him. That is the whole difference
 * between wavering and steady, and it is what makes suppression buy ground
 * without taking the team off the board: the attack stops advancing before it
 * stops fighting, and the player has to get his nerve back to start it again.
 *
 * It lives here rather than in the order plumbing because the cursor preview
 * runs the same planner, so the player sees which men would actually move
 * before he spends the order.
 */
export function willFollow(u: Unit, dest: Vec2): boolean {
  if (u.state !== UnitState.Active) return false;
  if (u.nerveState === Nerve.Broken) return false;
  if (u.nerveState !== Nerve.Wavering) return true;

  let nearest: Vec2 | null = null;
  let nearestD = Infinity;
  for (const [, mem] of u.memory) {
    if (mem.age > 12) continue;
    const d = dist(mem.pos, u.pos);
    if (d < nearestD) {
      nearestD = d;
      nearest = mem.pos;
    }
  }
  if (!nearest) return true;
  return dist(nearest, dest) > nearestD - ADVANCE;
}

/** The team as the player sees it on his card: the state of the men in it. */
export function summarise(members: Unit[]): SquadMorale {
  const active = members.filter((u) => u.state === UnitState.Active);
  if (active.length === 0) return { nerve: 0, state: Nerve.Broken };

  const nerve = active.reduce((a, u) => a + u.nerve, 0) / active.length;
  const broken = active.filter((u) => u.nerveState === Nerve.Broken).length;
  const shaken = active.some((u) => u.nerveState !== Nerve.Steady);

  if (broken === active.length) return { nerve, state: Nerve.Broken };
  if (shaken) return { nerve, state: Nerve.Wavering };
  return { nerve, state: Nerve.Steady };
}

/**
 * Fire from one bearing is a problem; fire from two is a reason to leave.
 *
 * Taken from what the man knows about where the enemy is, so it costs nothing
 * extra — and it is the mechanical reason flanking works on people rather than
 * only on geometry.
 */
function spreadOfThreats(u: Unit): number {
  const bearings: number[] = [];
  for (const [, mem] of u.memory) {
    if (mem.age > 6) continue;
    const to = sub(mem.pos, u.pos);
    if (Math.hypot(to.x, to.y) < 1) continue;
    bearings.push(angleOf(normalize(to)));
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
 * Where one frightened man runs to.
 *
 * Away from what he knows about, and far enough to be out of it — but onto
 * ground he can actually reach, or he stands in the open shaking instead,
 * which reads as a bug rather than as a rout.
 */
export function findRefuge(
  from: Vec2,
  threatDir: Vec2,
  walkable: (x: number, y: number) => boolean,
  reachable: (a: Vec2, b: Vec2) => boolean,
): Vec2 | null {
  const away = Math.atan2(-threatDir.y, -threatDir.x);
  for (const range of [30, 22, 15, 10]) {
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1]) {
      const a = away + turn;
      const p = vec(from.x + Math.cos(a) * range, from.y + Math.sin(a) * range);
      if (!walkable(p.x, p.y)) continue;
      if (!reachable(from, p)) continue;
      return p;
    }
  }
  return null;
}
