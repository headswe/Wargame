import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec } from '../src/sim/math.ts';
import { STEPOVE } from '../src/sim/levels.ts';
import { Sim } from '../src/sim/sim.ts';
import { COMMITMENT, DELIBERATION, updateDefence } from '../src/sim/command.ts';
import { Faction, UnitState } from '../src/sim/units.ts';

function defending(seed = 5) {
  const sim = new Sim(STEPOVE, seed);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  /** Put the same sighting in every defender's head, as if they had all seen it. */
  const report = (...at: { x: number; y: number }[]): void => {
    for (const u of hostiles) {
      u.memory.clear();
      at.forEach((p, i) => u.memory.set(900 + i, { pos: { ...p }, age: 1 }));
    }
  };
  /** Let the commander have a think, at a time of our choosing. */
  const think = (at: number) => {
    sim.time = at;
    return updateDefence(sim, sim.defence, sim.objective, 0.05);
  };
  return { sim, hostiles, report, think };
}

test('the defence does not decide anything in the first few seconds', () => {
  // Everything interesting about a defence lives in the gap between what is
  // happening and what it believes. A commander that reacts on the tick the
  // first man is spotted closes that gap, and with it every reason to feint.
  const { report, think } = defending();
  report(vec(30, 100), vec(34, 98), vec(28, 102));
  assert.equal(think(DELIBERATION - 1).length, 0, 'it should still be watching');
});

test('a feint pulls the reserve, and it is slow to come back', () => {
  const { sim, report, think } = defending();
  assert.ok(sim.defence.reserve.length > 0, 'somebody has to be held back');

  // Show him a main effort in the west.
  report(vec(26, 98), vec(30, 100), vec(24, 96), vec(28, 94), vec(32, 99));
  const west = think(DELIBERATION + 1).filter((o) => o.why === 'commit');
  assert.equal(west.length, 1, 'the reserve should have been committed');
  assert.ok(west[0].dest.x < STEPOVE.size.width / 2, `it went to ${west[0].dest.x.toFixed(0)}`);

  // Now the real attack arrives in the east. He has committed, and committing
  // is the expensive part — which is the whole reason a feint is worth the men
  // it costs to show.
  report(vec(140, 98), vec(136, 100), vec(144, 96), vec(138, 94), vec(142, 99));
  const soon = think(DELIBERATION * 2 + 2).filter((o) => o.why === 'commit');
  assert.equal(soon.length, 0, 'he should not be able to undo it that cheaply');

  // Eventually he can be talked round.
  const later = think(COMMITMENT + DELIBERATION + 4).filter((o) => o.why === 'commit');
  assert.equal(later.length, 1, 'but not for ever');
  assert.ok(later[0].dest.x > STEPOVE.size.width / 2, `it went to ${later[0].dest.x.toFixed(0)}`);
});

test('the defence does not act on a mystery', () => {
  // Sightings scattered all over the map are not a main effort, they are a
  // shrug. A commander who commits to one is a commander nobody can mislead,
  // because he has already misled himself.
  const { report, think } = defending();
  report(vec(10, 100), vec(160, 96), vec(80, 120), vec(20, 60), vec(150, 40));
  const orders = think(DELIBERATION + 1).filter((o) => o.why === 'commit');
  assert.equal(orders.length, 0, 'no commitment on that evidence');
});

test('a position that is losing gives ground before it is destroyed', () => {
  // Holding every position to the last man is not bravery, it is being fed to
  // the attack a squad at a time.
  const { sim, hostiles, report, think } = defending();
  const squad = sim.squads.find(
    (s) => s.faction === Faction.Hostile && !sim.defence.reserve.includes(s.id),
  )!;
  const members = sim.membersOf(squad);
  // Most of them down. Not broken: a squad that has already broken is running
  // anyway, and telling it where to run is not the commander's to do.
  for (let i = 0; i < Math.ceil(members.length * 0.6); i++) {
    members[i].state = UnitState.Down;
  }
  report(vec(80, 100), vec(84, 98), vec(76, 102));

  const orders = think(DELIBERATION + 1).filter((o) => o.why === 'give ground');
  const mine = orders.find((o) => o.squadId === squad.id);
  assert.ok(mine, 'it should have been pulled back');

  const before = members.find((u) => u.state === UnitState.Active)!;
  const wasFrom = Math.hypot(before.pos.x - sim.objective.x, before.pos.y - sim.objective.y);
  const nowFrom = Math.hypot(mine!.dest.x - sim.objective.x, mine!.dest.y - sim.objective.y);
  assert.ok(nowFrom < wasFrom, 'and pulled back towards what it is defending, not away');

  // And only once: a squad shuffling backwards every fourteen seconds is a rout
  // with extra steps.
  const again = think(DELIBERATION * 2 + 4).filter(
    (o) => o.why === 'give ground' && o.squadId === squad.id,
  );
  assert.equal(again.length, 0, 'it should not keep pulling the same squad back');
  void hostiles;
});

test('the defence actually moves during an assault', () => {
  // The measurement this exists to change: over five runs of the bounding
  // assault a surviving defender ended a mean of two metres from where he
  // started, and most of that was routing rather than repositioning.
  const sim = new Sim(STEPOVE, 4242);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const start = hostiles.map((u) => ({ ...u.pos }));

  // Somebody is coming, seen from the start line, and keeps being seen.
  for (let t = 0; t < 90; t += 0.05) {
    if (Math.abs(t % 5) < 0.03) {
      for (const u of hostiles) u.memory.set(901, { pos: vec(40, 96), age: 0.5 });
    }
    sim.update(0.05);
  }

  const moved = hostiles
    .filter((u) => u.state === UnitState.Active)
    .map((u, i) => Math.hypot(u.pos.x - start[i].x, u.pos.y - start[i].y));
  const mean = moved.reduce((a, b) => a + b, 0) / Math.max(1, moved.length);
  assert.ok(mean > 4, `the defence still only shifted ${mean.toFixed(1)}m on average`);
});
