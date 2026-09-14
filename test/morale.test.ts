import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec } from '../src/sim/math.ts';
import { type LevelDef } from '../src/sim/levels.ts';
import { MissionState, Sim } from '../src/sim/sim.ts';
import {
  Faction, MoveMode, Nerve, Posture, UnitState, WEAPONS, makeUnit, resetUnitIds, type Unit,
} from '../src/sim/units.ts';
import { applyCasualtyShock, summarise, updateNerve, willFollow } from '../src/sim/morale.ts';
import { updatePosture } from '../src/sim/ai.ts';
import { hitChance } from '../src/sim/combat.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { revetment } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';

/** A line of men, six metres apart, so distance between them means something. */
function line(size: number, spacing = 6): Unit[] {
  resetUnitIds();
  return Array.from({ length: size }, (_, i) =>
    makeUnit({
      role: i === 0 ? 'Team Leader' : 'Rifleman',
      faction: Faction.Player,
      squadId: 0,
      pos: vec(10 + i * spacing, 10),
      weapon: WEAPONS.carbine,
    }));
}

/** Run the nerve clock forward without a whole simulation attached. */
function tick(men: Unit[], seconds: number, time = 0, under = 0): void {
  for (let t = 0; t < seconds; t += 0.05) {
    // Suppression is held up by hand where a test wants it, so the only thing
    // that varies between runs is whatever that run is actually about.
    if (under > 0) for (const u of men) u.suppression = under;
    for (const u of men) updateNerve(u, men, time + t, 0.05);
  }
}

test('a man takes his mate going down beside him harder than one across the field', () => {
  // The rule this replaces scaled a loss by what share of the team it was,
  // which made a casualty an administrative fact about a squad. It is not: it
  // is something particular men watched happen, and the ones who have to keep
  // holding that corner of the position are the ones who watched it closest.
  const men = line(3, 1);
  men[1].pos = vec(13, 10);
  men[2].pos = vec(30, 10);
  const casualty = men[0];
  casualty.state = UnitState.Down;

  applyCasualtyShock(men.slice(1), casualty);

  const beside = 1 - men[1].nerve;
  const acrossTheField = 1 - men[2].nerve;
  assert.ok(beside > 0.25, `the man three metres away lost only ${beside.toFixed(2)}`);
  assert.ok(
    acrossTheField < beside * 0.4,
    `beside cost ${beside.toFixed(2)}, across the field ${acrossTheField.toFixed(2)}`,
  );
});

test('a position comes apart a man at a time', () => {
  // The whole point of holding nerve per soldier. Held per team it was one
  // switch: four men fought, then four men ran, and nothing in between ever
  // happened on screen.
  const men = line(5);
  resetUnitIds();
  const casualty = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: { ...men[0].pos }, weapon: WEAPONS.carbine,
  });
  casualty.state = UnitState.Down;
  applyCasualtyShock(men, casualty);

  let brokeFirst: Unit | null = null;
  let thinning = false;
  for (let t = 0; t < 12; t += 0.05) {
    tick(men, 0.05, t, 0.5);
    const broken = men.filter((u) => u.nerveState === Nerve.Broken);
    if (!brokeFirst && broken.length > 0) brokeFirst = broken[0];
    if (broken.length > 0 && broken.length < men.length) thinning = true;
  }

  assert.ok(thinning, 'at no point were some of them still fighting and others not');
  assert.equal(brokeFirst, men[0], 'the man who watched it happen should go first');
  assert.equal(
    men[4].nerveState, Nerve.Broken,
    'and the man at the far end should follow, eventually',
  );
});

test('a man on his own breaks sooner than the same man in a team', () => {
  // Being alone is a property of a man, not of a squad, which is the other
  // half of why this moved off the team — and it is what makes cutting a
  // position into pieces worth the trouble.
  const alone = line(1);
  tick(alone, 6, 0, 0.6);

  const team = line(4, 3);
  tick(team, 6, 0, 0.6);

  assert.ok(
    alone[0].nerve < team[0].nerve - 0.15,
    `alone ended on ${alone[0].nerve.toFixed(2)}, in a team on ${team[0].nerve.toFixed(2)}`,
  );
});

test('nerve comes back only with real quiet, and slowly', () => {
  const men = line(1);
  const u = men[0];
  u.nerve = 0.05;
  tick(men, 0.1);
  assert.equal(u.nerveState, Nerve.Broken);

  // Still in contact: he can see somebody, so he does not settle.
  u.visible = [99];
  tick(men, 20, 0);
  assert.equal(u.nerveState, Nerve.Broken, 'a man who can still see them does not rally');

  // Contact broken. Now it comes back, but not instantly.
  u.visible = [];
  u.memory.clear();
  tick(men, 6, 20);
  assert.equal(u.nerveState, Nerve.Broken, 'and not within a few seconds either');
  tick(men, 30, 26);
  assert.equal(u.nerveState, Nerve.Steady, 'but it does come back');
});

test('fire from two directions costs more nerve than the same fire from one', () => {
  const measure = (bearings: number[]): number => {
    const men = line(1);
    men[0].memory = new Map(
      bearings.map((b, i) => [
        100 + i,
        { pos: vec(men[0].pos.x + Math.cos(b) * 30, men[0].pos.y + Math.sin(b) * 30), age: 1 },
      ]),
    );
    tick(men, 4, 0, 0.6);
    return men[0].nerve;
  };

  const frontal = measure([0, 0.2]);
  const enveloped = measure([0, Math.PI * 0.75]);
  assert.ok(
    enveloped < frontal - 0.02,
    `enveloped ended on ${enveloped.toFixed(3)}, frontal on ${frontal.toFixed(3)}`,
  );
});

test('the team card is derived from the men and never leads them', () => {
  const men = line(3, 3);
  assert.equal(summarise(men).state, Nerve.Steady);

  men[1].nerve = 0.3;
  men[1].nerveState = Nerve.Wavering;
  assert.equal(summarise(men).state, Nerve.Wavering, 'one man shaken shakes the card');

  for (const u of men) u.nerveState = Nerve.Broken;
  assert.equal(summarise(men).state, Nerve.Broken, 'and it only reads broken when all of them are');

  men[0].state = UnitState.Down;
  men[1].nerveState = Nerve.Steady;
  assert.equal(
    summarise(men).state, Nerve.Wavering,
    'the dead do not get a vote on whether the position is holding',
  );
});

test('a shaken man will pull back but will not be walked forward', () => {
  const men = line(1);
  const u = men[0];
  u.memory.set(99, { pos: vec(u.pos.x, u.pos.y - 40), age: 1 });

  u.nerveState = Nerve.Steady;
  assert.ok(willFollow(u, vec(u.pos.x, u.pos.y - 25)), 'a steady man goes where he is told');

  u.nerveState = Nerve.Wavering;
  assert.ok(!willFollow(u, vec(u.pos.x, u.pos.y - 25)), 'a shaken one will not close on them');
  assert.ok(willFollow(u, vec(u.pos.x, u.pos.y + 15)), 'but he will happily come back');
  assert.ok(willFollow(u, vec(u.pos.x + 12, u.pos.y)), 'and will still sidestep');

  u.nerveState = Nerve.Broken;
  assert.ok(!willFollow(u, vec(u.pos.x, u.pos.y + 15)), 'a broken man is not listening at all');
});

/** A lone position with somewhere behind it to run to. */
const OUTPOST: LevelDef = {
  id: 'outpost',
  name: 'Outpost',
  brief: 'One position, open ground in front, somewhere to run behind.',
  size: { width: 60, height: 110 },
  paint: (scene) => {
    revetment(scene, [vec(20, 30), vec(40, 30)], Fabric.Sandbag, 1.05, 1.2);
    scene.spawns.teams[0] = [vec(26, 62), vec(28, 62), vec(30, 62), vec(32, 62)];
    scene.spawns.teams[1] = [vec(20, 66), vec(22, 66), vec(24, 66), vec(26, 66)];
    scene.spawns.teams[2] = [vec(36, 66), vec(38, 66), vec(40, 66), vec(42, 66)];
    scene.spawns.enemies = [
      { pos: vec(26, 26), heavy: false },
      { pos: vec(30, 26), heavy: false },
      { pos: vec(34, 26), heavy: false },
    ];
    scene.spawns.objectives = [vec(30, 20)];
  },
};

/** The position, minus the players' ability to shoot at it. */
function outpostUnderPressure(seed: number) {
  const sim = new Sim(OUTPOST, seed);
  // The players are scenery here: what is under test is what the defence does,
  // not whether it gets shot in the back while doing it.
  for (const squad of sim.playerSquads) {
    for (const u of sim.membersOf(squad)) u.weapon = { ...u.weapon, maxRange: 1 };
  }
  return sim;
}

test('a broken defender withdraws off the position', () => {
  const sim = outpostUnderPressure(31);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);

  // A tick first, so the casualty pass has a live man to notice the drop from.
  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);

  // Two of the three go down. The last man should not hold it alone.
  hostiles[0].state = UnitState.Down;
  hostiles[1].state = UnitState.Down;
  const held = { ...hostiles[2].pos };

  for (let t = 0; t < 12; t += 0.05) sim.update(0.05);
  assert.equal(hostiles[2].nerveState, Nerve.Broken, 'the last man should have broken');

  for (let t = 0; t < 14; t += 0.05) sim.update(0.05);
  const moved = Math.hypot(hostiles[2].pos.x - held.x, hostiles[2].pos.y - held.y);
  assert.ok(moved > 8, `he only moved ${moved.toFixed(1)}m off the position`);
});

test('a defence that has run is a defence you have beaten', () => {
  // Otherwise the endgame is hunting the last frightened man around a village,
  // which is the dullest part of the fight and most of its running time.
  const sim = outpostUnderPressure(31);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);

  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);
  hostiles[0].state = UnitState.Down;
  hostiles[1].state = UnitState.Down;
  for (let t = 0; t < 12; t += 0.05) sim.update(0.05);
  assert.equal(hostiles[2].nerveState, Nerve.Broken);
  assert.equal(hostiles[2].state, UnitState.Active, 'and he is still alive');

  for (const u of sim.membersOf(sim.playerSquads[0])) u.pos = vec(30, 20);
  for (let t = 0; t < 0.5; t += 0.05) sim.update(0.05);
  assert.equal(sim.missionState, MissionState.Won);
});

test('an order reaches the men who are still listening, and only those', () => {
  const sim = new Sim(OUTPOST, 17);
  const alpha = sim.playerSquads[0];
  const men = sim.membersOf(alpha);
  assert.ok(sim.orderSquad(alpha.id, vec(30, 55), MoveMode.Tactical, null), 'steady teams obey');

  // Break one man by hand: the plumbing under test is the refusal, not the cause.
  men[0].nerve = 0;
  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);
  assert.equal(men[0].nerveState, Nerve.Broken);

  const dest = vec(30, 46);
  assert.ok(
    sim.orderSquad(alpha.id, dest, MoveMode.Tactical, null),
    'the other three are still a fireteam and still take orders',
  );
  assert.ok(
    men.slice(1).every((u) => u.slot !== null && Math.hypot(u.slot.x - dest.x, u.slot.y - dest.y) < 14),
    'the men who are listening went where they were sent',
  );
  assert.ok(
    men[0].slot === null || Math.hypot(men[0].slot.x - dest.x, men[0].slot.y - dest.y) > 14,
    'and the one who has broken did not',
  );
  assert.equal(men[0].suppressAt, null, 'he is certainly not raking anything');

  // With nobody left listening there is no order at all.
  for (const u of men) u.nerve = 0;
  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);
  assert.equal(sim.orderSquad(alpha.id, vec(30, 40), MoveMode.Tactical, null), false);
});

test('a man under fire gets flat, and getting flat is worth something', () => {
  const men = line(1);
  const u = men[0];
  u.coverSpot = { ...u.pos };

  u.suppression = 0;
  updatePosture(u);
  assert.equal(u.posture, Posture.Crouched, 'settled and unbothered, he takes a knee');

  // Rounds start coming near. He does not wait to be pinned.
  u.suppression = 0.35;
  updatePosture(u);
  assert.equal(u.posture, Posture.Prone, 'he should get down of his own accord');
  assert.ok(u.suppression < 0.72, 'and well before anything forced him to');

  // It stays until it is genuinely quiet, rather than flickering per round.
  u.suppression = 0.2;
  updatePosture(u);
  assert.equal(u.posture, Posture.Prone);
  u.suppression = 0.05;
  updatePosture(u);
  assert.equal(u.posture, Posture.Crouched, 'and he comes back up when it stops');
});

test('getting small is worth something even with nothing to hide behind', () => {
  // The failure this guards against: exposure is a fraction of a silhouette,
  // so a man flat on his face in an open field is "fully exposed" exactly like
  // a man standing up, and going prone bought him nothing at all.
  const scene = new Scene(80, 80);
  scene.bake();
  resetUnitIds();
  const shooter = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(40, 14), weapon: WEAPONS.carbine,
  });
  const target = makeUnit({
    role: 'Rifleman', faction: Faction.Hostile, squadId: 1,
    pos: vec(40, 40), weapon: WEAPONS.carbine,
  });
  target.exposure = 0.2;

  target.posture = Posture.Standing;
  const standing = hitChance(scene, shooter, target);
  target.posture = Posture.Crouched;
  const crouched = hitChance(scene, shooter, target);
  target.posture = Posture.Prone;
  const prone = hitChance(scene, shooter, target);

  assert.equal(standing.exposure, 1, 'there is nothing out there to hide behind');
  assert.equal(prone.exposure, 1, 'and that is true whatever he does with his body');
  assert.ok(crouched.chance < standing.chance * 0.8, 'yet crouching still helps');
  assert.ok(
    prone.chance < standing.chance * 0.45,
    `prone ${prone.chance.toFixed(2)} against standing ${standing.chance.toFixed(2)} in the open`,
  );
});
