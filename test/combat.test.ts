import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec } from '../src/sim/math.ts';
import { Rng } from '../src/sim/rng.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { revetment } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';
import { type Effect, hitChance, resolveShot } from '../src/sim/combat.ts';
import {
  Faction, MoveMode, Posture, UnitState, WEAPONS, makeUnit, resetUnitIds, type Unit,
} from '../src/sim/units.ts';

/**
 * The mechanics tier.
 *
 * `hitChance` decides every engagement in the game and multiplies about ten
 * independent factors together. It is also a pure function of the scene and
 * two men — no random number touches it — so each of those factors can be
 * pinned *exactly* rather than sampled, by taking two readings that differ in
 * one field and dividing. Everything else cancels, and what is left is the
 * factor itself, named and checked against the constant in the source.
 *
 * That exactness is the whole argument for testing at this level rather than
 * at the level of a mission. A scripted assault can only sample an outcome
 * that ten systems and a seed contributed to; when it moves, it cannot say
 * which one moved it. These can, in microseconds.
 */

const OPEN = (() => {
  const scene = new Scene(80, 80);
  scene.bake();
  return scene;
})();

/** Two men thirty metres apart, both upright. The scene is the caller's. */
function pair(): { shooter: Unit; target: Unit } {
  resetUnitIds();
  const shooter = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(40, 20), weapon: WEAPONS.carbine,
  });
  const target = makeUnit({
    role: 'Rifleman', faction: Faction.Hostile, squadId: 1,
    pos: vec(40, 50), weapon: WEAPONS.carbine,
  });
  return { shooter, target };
}

/**
 * The factor one field is worth, isolated.
 *
 * Two readings differing in exactly one thing; the ratio is that thing's
 * contribution with every other term divided out.
 */
function factorOf(change: (shooter: Unit, target: Unit) => void): number {
  const clear = pair();
  const changed = pair();
  change(changed.shooter, changed.target);
  const before = hitChance(OPEN, clear.shooter, clear.target).chance;
  const after = hitChance(OPEN, changed.shooter, changed.target).chance;
  return after / before;
}

const CLOSE = 1e-9;

test('the bench sits off both clamps, or none of the ratios below mean anything', () => {
  // `chance` is clamped into [0, 0.95]. A reading against either end stops
  // being a product of its factors, and every ratio taken from it would be
  // measuring the clamp instead of the mechanic.
  const { shooter, target } = pair();
  const { chance } = hitChance(OPEN, shooter, target);
  assert.ok(chance > 0.05 && chance < 0.9, `bench reads ${chance.toFixed(3)}`);
});

test('suppression is what fire that never hits anybody buys', () => {
  // The single number the whole suppression system exists to produce. Fully
  // suppressed, a man shoots at 22% of what he would otherwise manage.
  assert.ok(Math.abs(factorOf((s) => { s.suppression = 1; }) - 0.22) < CLOSE);
  // And it is linear on the way there, so half-suppressed is genuinely half
  // the effect rather than a threshold dressed up as a gradient.
  assert.ok(Math.abs(factorOf((s) => { s.suppression = 0.5 }) - 0.61) < CLOSE);
});

test('a shaken man shoots worse than a steady one holding the same wall', () => {
  // Nerve is worth 40% of a man's shooting, floored at 60% so that a broken
  // man is still dangerous rather than harmless.
  assert.ok(Math.abs(factorOf((s) => { s.nerve = 0; }) - 0.6) < CLOSE);
  assert.ok(Math.abs(factorOf((s) => { s.nerve = 0.5; }) - 0.8) < CLOSE);
});

test('being pinned is categorically worse than being suppressed', () => {
  // Pinned is a state, not more of the gradient: it multiplies on top of the
  // suppression that caused it. If these two ever became the same number,
  // getting pinned would stop being a thing that happens *to* you.
  const pinned = factorOf((s) => { s.posture = Posture.Pinned; });
  assert.ok(pinned < factorOf((s) => { s.suppression = 1; }));
  assert.ok(pinned > 0, 'a pinned man can still fire, badly');
});

test('smoke stops you aiming without stopping the round', () => {
  // Total concealment leaves firing into it and hoping, which is what makes a
  // canister worth spending on a crossing. It never reaches zero: rounds still
  // go into smoke and some of them still find somebody.
  const scene = new Scene(80, 80);
  scene.bake();
  scene.smoke.add(vec(40, 35), 0);
  for (let t = 0; t < 40; t++) scene.smoke.update(0.25);
  const { shooter, target } = pair();
  const obscured = hitChance(scene, shooter, target);
  const clear = pair();
  assert.ok(obscured.concealment > 0.5, `concealment ${obscured.concealment.toFixed(2)}`);
  assert.ok(obscured.chance < hitChance(OPEN, clear.shooter, clear.target).chance * 0.5);
  assert.ok(obscured.chance > 0, 'firing into smoke is not firing into a wall');
});

test('a man who is moving is harder to hit, and a sprinting one hardest', () => {
  // Movement is not a flag on the man, it is whether he still has path left to
  // walk — so a test that sets a boolean measures nothing. Sprinting is the
  // harder target and still the worse idea, because everything else about
  // sprinting (standing up, in the open, seen further off) is charged
  // elsewhere. This factor alone must not be read as "running is safer".
  const walking = factorOf((_s, t) => {
    t.path = [vec(40, 46)];
    t.pathIndex = 0;
    t.moveMode = MoveMode.Tactical;
  });
  const sprinting = factorOf((_s, t) => {
    t.path = [vec(40, 46)];
    t.pathIndex = 0;
    t.moveMode = MoveMode.Sprint;
  });
  assert.ok(Math.abs(walking - 0.88) < CLOSE, `walking reads ${walking}`);
  assert.ok(Math.abs(sprinting - 0.72) < CLOSE, `sprinting reads ${sprinting}`);
});

test('range costs accuracy, and past the weapon it costs everything', () => {
  const near = pair();
  near.target.pos = vec(40, 32);
  const far = pair();
  far.target.pos = vec(40, 70);
  const a = hitChance(OPEN, near.shooter, near.target).chance;
  const b = hitChance(OPEN, far.shooter, far.target).chance;
  assert.ok(a > b, `12m reads ${a.toFixed(3)}, 50m reads ${b.toFixed(3)}`);

  const beyond = pair();
  beyond.target.pos = vec(40, 20 + WEAPONS.carbine.maxRange + 10);
  const shot = hitChance(OPEN, beyond.shooter, beyond.target);
  assert.ok(shot.blocked || shot.chance === 0, 'past maximum range there is no shot at all');
});

test('a blocked line is no shot rather than a bad one', () => {
  const scene = new Scene(80, 80);
  revetment(scene, [vec(20, 35), vec(60, 35)], Fabric.Brick, 3.2, 0.5);
  scene.bake();
  const { shooter, target } = pair();
  const shot = hitChance(scene, shooter, target);
  assert.ok(shot.blocked, 'a three-metre wall between them');
  assert.equal(shot.chance, 0);
});

// --------------------------------------------------------------- the duel

/**
 * Two teams shooting at each other and nothing else.
 *
 * No AI, no movement, no orders, no level — only the combat resolution, so
 * that when the result moves there is exactly one place it could have come
 * from. Both sides fire at the same cadence at the nearest man still up.
 */
function duel(seed: number, setup: (a: Unit[], b: Unit[], scene: Scene) => void): {
  aStanding: number; bStanding: number;
} {
  const scene = new Scene(80, 80);
  resetUnitIds();
  const a: Unit[] = [];
  const b: Unit[] = [];
  for (let i = 0; i < 4; i++) {
    a.push(makeUnit({
      role: 'Rifleman', faction: Faction.Player, squadId: 0,
      pos: vec(34 + i * 2.5, 22), weapon: WEAPONS.carbine,
    }));
    b.push(makeUnit({
      role: 'Rifleman', faction: Faction.Hostile, squadId: 1,
      pos: vec(34 + i * 2.5, 48), weapon: WEAPONS.carbine,
    }));
  }
  setup(a, b, scene);
  scene.bake();
  // Exposure is normally maintained by the simulation's cover pass; here it is
  // read once from the geometry so the duel measures the geometry and not a
  // stale field.
  for (const [us, them] of [[a, b], [b, a]] as const) {
    for (const u of us) {
      u.exposure = Math.max(...them.map((e) => hitChance(scene, e, u).exposure));
    }
  }

  const rng = new Rng(seed);
  const effects: Effect[] = [];
  const all = [...a, ...b];
  const alive = (side: Unit[]) => side.filter((u) => u.state === UnitState.Active);

  /**
   * Both sides fire simultaneously: everyone still up at the start of a round
   * gets his shot off, even if he is hit during it.
   *
   * Taking the sides in turn instead gives whoever goes first a compounding
   * advantage — his casualties cannot shoot back that round — and it does not
   * average out. Alternating the order by round looked like it fixed it and
   * did not: the control read level at 64 seeds and came apart again at 96,
   * which is what a structural bias looks like when you only ever sample it.
   * A bench has to be symmetric by construction, because an experiment cannot
   * be more trustworthy than the ground it is run on.
   *
   * Suppression is then held at whatever the setup asked for, rather than
   * being allowed to accumulate. A hit adds suppression to the man it lands
   * on, so within one round the side resolved first degrades the other's
   * shooting and is not degraded back until it has already fired — a first
   * mover advantage arriving through a second door after the obvious one was
   * closed. Pinning it also makes the suppression experiment below mean what
   * it says: a squad held under fire, not one that briefly was.
   */
  const held = new Map(all.map((u) => [u.id, u.suppression]));
  for (let round = 0; round < 30; round++) {
    if (alive(a).length === 0 || alive(b).length === 0) break;
    const firing = [
      ...alive(a).map((u) => [u, alive(b)] as const),
      ...alive(b).map((u) => [u, alive(a)] as const),
    ];
    for (const [u, targets] of firing) {
      if (targets.length === 0) continue;
      // Immediately before the shot, not once a round: a hit adds suppression
      // to the man it lands on, so between one side's volley and the other's
      // the second side has already been degraded by the first. Pinning at the
      // top of the round left that whole gap open, and it was worth 0.07 on
      // the hit rate — the side firing first landed 63% against 57%.
      u.suppression = held.get(u.id)!;
      resolveShot(scene, rng, all, u, targets[round % targets.length], effects);
    }
  }
  return { aStanding: alive(a).length, bStanding: alive(b).length };
}

/**
 * Enough seeds to see the noise floor, having been fooled by it once.
 *
 * Eight seeds put one side 0.9 men ahead on identical ground — a phantom the
 * size of the effects being measured. More sampling looked like it fixed that
 * (0.00 at 64) and then the gap came back at 96, which is the tell: sampling
 * cannot average away a bias that is in the bench. It was in the bench, and
 * hunting it found a real one worth keeping written down (see `duel`). With
 * the bench fixed, shots and hit rates between the two sides now agree to
 * under a percent and this lands inside 0.05.
 *
 * Thirty rounds because the fight is decided well before then; sixty gave
 * identical numbers for twice the work.
 */
const SEEDS = Array.from({ length: 64 }, (_, i) => 1000 + i * 37);

/** Mean survivors per side over the seeds, so one lucky exchange cannot carry it. */
function mean(setup: (a: Unit[], b: Unit[], scene: Scene) => void) {
  let ours = 0;
  let theirs = 0;
  for (const seed of SEEDS) {
    const r = duel(seed, setup);
    ours += r.aStanding;
    theirs += r.bStanding;
  }
  return { ours: ours / SEEDS.length, theirs: theirs / SEEDS.length };
}

test('an even fight in the open is even', (t) => {
  // The control. Without it, "cover wins" could just as easily be "whichever
  // side the loop happens to fire first wins", and the test below would be
  // measuring turn order.
  const { ours, theirs } = mean(() => {});
  t.diagnostic(`open vs open: ${ours.toFixed(2)} against ${theirs.toFixed(2)} standing`);
  assert.ok(
    Math.abs(ours - theirs) < 0.3,
    `open ground gave ${ours.toFixed(2)} against ${theirs.toFixed(2)}`,
  );
});

test('a squad behind cover beats the same squad without it', (t) => {
  // The mechanic the game is about, stated as plainly as it can be: one
  // variable, a wall, everything else identical.
  const { ours, theirs } = mean((_a, b, scene) => {
    revetment(scene, [vec(28, 45), vec(48, 45)], Fabric.Sandbag, 1.05, 1.2);
    for (const u of b) u.posture = Posture.Crouched;
  });
  t.diagnostic(`cover: ${theirs.toFixed(1)} standing against ${ours.toFixed(1)} in the open`);
  assert.ok(
    theirs > ours + 1.5,
    `behind the revetment ${theirs.toFixed(1)} stood, in the open ${ours.toFixed(1)}`,
  );
});

test('a suppressed squad loses a fight it would otherwise have drawn', (t) => {
  // Same open ground as the control above, one side held under fire. This is
  // what suppression is worth in men rather than in multipliers.
  const { ours, theirs } = mean((a) => {
    for (const u of a) u.suppression = 0.85;
  });
  t.diagnostic(`suppression: ${theirs.toFixed(1)} standing against ${ours.toFixed(1)} suppressed`);
  assert.ok(
    theirs > ours + 1,
    `suppressed ${ours.toFixed(1)} stood, steady ${theirs.toFixed(1)}`,
  );
});
