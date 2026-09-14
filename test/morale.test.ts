import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec } from '../src/sim/math.ts';
import { type LevelDef } from '../src/sim/levels.ts';
import { MissionState, Sim } from '../src/sim/sim.ts';
import { Faction, MoveMode, UnitState, WEAPONS, makeUnit, resetUnitIds } from '../src/sim/units.ts';
import { Nerve, freshMorale, updateMorale } from '../src/sim/morale.ts';
import { revetment } from '../src/sim/world/builder.ts';
import { Fabric } from '../src/sim/world/geometry.ts';

function team(size: number, hp = 100) {
  resetUnitIds();
  return Array.from({ length: size }, (_, i) =>
    makeUnit({
      role: i === 0 ? 'Team Leader' : 'Rifleman',
      faction: Faction.Player,
      squadId: 0,
      pos: vec(10 + i, 10),
      weapon: WEAPONS.carbine,
      maxHp: hp,
    }));
}

/** Run the morale clock forward without a whole simulation attached. */
function tick(morale: ReturnType<typeof freshMorale>, members: ReturnType<typeof team>, seconds: number, time = 0) {
  for (let t = 0; t < seconds; t += 0.05) updateMorale(morale, members, time + t, 0.05);
  return morale;
}

test('losses are felt in proportion to how much of the team they are', () => {
  // The same single casualty out of three men and out of twelve cannot cost
  // the same, or a fireteam and a company would break at the same point.
  const small = team(3);
  const smallMorale = freshMorale();
  tick(smallMorale, small, 0.1);
  small[2].state = UnitState.Down;
  tick(smallMorale, small, 0.1);

  const large = team(12);
  const largeMorale = freshMorale();
  tick(largeMorale, large, 0.1);
  large[11].state = UnitState.Down;
  tick(largeMorale, large, 0.1);

  assert.ok(
    smallMorale.nerve < largeMorale.nerve - 0.2,
    `one man down cost the three-man team ${(1 - smallMorale.nerve).toFixed(2)}` +
    ` and the twelve-man team ${(1 - largeMorale.nerve).toFixed(2)}`,
  );
});

test('a position that loses most of its men stops being one', () => {
  const men = team(3);
  const morale = freshMorale();
  tick(morale, men, 0.1);
  assert.equal(morale.state, Nerve.Steady);

  men[2].state = UnitState.Down;
  tick(morale, men, 0.2);
  assert.notEqual(morale.state, Nerve.Broken, 'one man down is a bad day, not a rout');

  men[1].state = UnitState.Down;
  tick(morale, men, 0.2);
  assert.equal(morale.state, Nerve.Broken, 'two of three down should finish them');
});

test('nerve comes back only with real quiet, and slowly', () => {
  const men = team(3);
  const morale = freshMorale();
  tick(morale, men, 0.1);
  men[2].state = UnitState.Down;
  men[1].state = UnitState.Down;
  tick(morale, men, 0.2);
  assert.equal(morale.state, Nerve.Broken);

  // Still in contact: he can see somebody, so he does not settle.
  men[0].visible = [99];
  tick(morale, men, 20, 0);
  assert.equal(morale.state, Nerve.Broken, 'a man who can still see them does not rally');

  // Contact broken. Now it comes back, but not instantly.
  men[0].visible = [];
  men[0].memory.clear();
  tick(morale, men, 6, 20);
  assert.equal(morale.state, Nerve.Broken, 'and not within a few seconds either');
  tick(morale, men, 30, 26);
  assert.equal(morale.state, Nerve.Steady, 'but it does come back');
});

test('fire from two directions costs more nerve than the same fire from one', () => {
  const measure = (bearings: number[]): number => {
    const men = team(3);
    for (const u of men) u.suppression = 0.6;
    men[0].memory = new Map(
      bearings.map((b, i) => [
        100 + i,
        { pos: vec(men[0].pos.x + Math.cos(b) * 30, men[0].pos.y + Math.sin(b) * 30), age: 1 },
      ]),
    );
    const morale = freshMorale();
    // Suppression is held up by hand, so only the spread differs.
    for (let t = 0; t < 4; t += 0.05) {
      for (const u of men) u.suppression = 0.6;
      updateMorale(morale, men, t, 0.05);
    }
    return morale.nerve;
  };

  const frontal = measure([0, 0.2]);
  const enveloped = measure([0, Math.PI * 0.75]);
  assert.ok(
    enveloped < frontal - 0.02,
    `enveloped ended on ${enveloped.toFixed(3)}, frontal on ${frontal.toFixed(3)}`,
  );
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

test('a broken defence withdraws off the position', () => {
  const sim = outpostUnderPressure(31);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const defence = sim.squads.find((s) => s.faction === Faction.Hostile)!;

  // A tick first, so the morale clock has a count to notice the drop from.
  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);

  // Two of the three go down. The last man should not hold it alone.
  hostiles[0].state = UnitState.Down;
  hostiles[1].state = UnitState.Down;
  const held = { ...hostiles[2].pos };

  for (let t = 0; t < 8; t += 0.05) sim.update(0.05);
  assert.equal(defence.morale.state, Nerve.Broken, 'the last man should have broken');

  for (let t = 0; t < 14; t += 0.05) sim.update(0.05);
  const moved = Math.hypot(hostiles[2].pos.x - held.x, hostiles[2].pos.y - held.y);
  assert.ok(moved > 8, `he only moved ${moved.toFixed(1)}m off the position`);
});

test('a defence that has run is a defence you have beaten', () => {
  // Otherwise the endgame is hunting the last frightened man around a village,
  // which is the dullest part of the fight and most of its running time.
  const sim = outpostUnderPressure(31);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const defence = sim.squads.find((s) => s.faction === Faction.Hostile)!;

  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);
  hostiles[0].state = UnitState.Down;
  hostiles[1].state = UnitState.Down;
  for (let t = 0; t < 8; t += 0.05) sim.update(0.05);
  assert.equal(defence.morale.state, Nerve.Broken);
  assert.equal(hostiles[2].state, UnitState.Active, 'and he is still alive');

  for (const u of sim.membersOf(sim.playerSquads[0])) u.pos = vec(30, 20);
  for (let t = 0; t < 0.5; t += 0.05) sim.update(0.05);
  assert.equal(sim.missionState, MissionState.Won);
});

test('a broken team stops taking orders until it has rallied', () => {
  const sim = new Sim(OUTPOST, 17);
  const alpha = sim.playerSquads[0];
  assert.ok(sim.orderSquad(alpha.id, vec(30, 55), MoveMode.Tactical, null), 'steady teams obey');

  // Break them by hand: the plumbing under test is the refusal, not the cause.
  alpha.morale.nerve = 0;
  for (let t = 0; t < 0.2; t += 0.05) sim.update(0.05);
  assert.equal(alpha.morale.state, Nerve.Broken);
  assert.equal(
    sim.orderSquad(alpha.id, vec(30, 40), MoveMode.Tactical, null), false,
    'men who have broken are not listening',
  );

  // They also stop shooting.
  assert.ok(
    sim.membersOf(alpha).every((u) => u.suppressAt === null),
    'and they are certainly not raking anything',
  );
});
