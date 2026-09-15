import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec } from '../src/sim/math.ts';
import { Rng } from '../src/sim/rng.ts';
import { type LevelDef } from '../src/sim/levels.ts';
import { Sim } from '../src/sim/sim.ts';
import { Faction, MoveMode, UnitState, WEAPONS, makeUnit, resetUnitIds } from '../src/sim/units.ts';
import { Scene } from '../src/sim/world/scene.ts';
import { revetment } from '../src/sim/world/builder.ts';
import { Fabric, Solidity } from '../src/sim/world/geometry.ts';
import { Stature } from '../src/sim/world/occlusion.ts';
import { Ordnance, canThrow, launch, updateOrdnance } from '../src/sim/ordnance.ts';
import { hitChance, resolveAreaShot } from '../src/sim/combat.ts';

/** A man behind a sandbag revetment, and a man twenty metres out in the open. */
function bench() {
  resetUnitIds();
  const scene = new Scene(60, 60);
  revetment(scene, [vec(10, 30), vec(50, 30)], Fabric.Sandbag, 1.05, 1.1);
  scene.bake();
  const defender = makeUnit({
    role: 'Rifleman', faction: Faction.Hostile, squadId: 1,
    pos: vec(30, 31.4), weapon: WEAPONS.carbine,
  });
  const attacker = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(30, 12), weapon: WEAPONS.carbine,
  });
  return { scene, defender, attacker, units: [defender, attacker] };
}

function fire(scene: Scene, units: ReturnType<typeof bench>['units'], at: { x: number; y: number }) {
  const world = { scene, rng: new Rng(9), unitList: units, effects: [] };
  const live = [launch(scene, units[1], Ordnance.Frag, at)];
  for (let t = 0; t < 5 && live.length > 0; t += 0.05) updateOrdnance(world, live, 0.05);
}

test('a grenade beats the cover that stops rifle fire', () => {
  const rifle = bench();
  const shot = hitChance(rifle.scene, rifle.attacker, rifle.defender);
  assert.ok(shot.exposure < 0.6, 'the revetment should be doing real work against bullets');
  assert.ok(shot.chance < 0.4, 'and shooting at him should be a slow way to win');

  const frag = bench();
  fire(frag.scene, frag.units, { ...frag.defender.pos });
  assert.equal(frag.defender.state, UnitState.Down, 'one at his feet has to settle it');
});

test('and the same wall stops the fragments when it is in the way', () => {
  // Two and a bit metres from him in a straight line — but on the far side of
  // the sandbags. Nothing about the distance changed; only the geometry did.
  const { scene, defender, units } = bench();
  fire(scene, units, vec(30, 28.6));
  assert.equal(defender.state, UnitState.Active, 'the revetment should have caught the fragments');
  assert.ok(defender.hp > 95, `took ${(100 - defender.hp).toFixed(0)} damage through a wall`);
  // But it is not quiet.
  assert.ok(defender.suppression > 0.2, 'a grenade going off next to you is still a grenade');
});

test('fragment effect falls off with distance in the open', () => {
  let last = Infinity;
  for (const range of [0, 2, 4, 6, 8]) {
    const { scene, defender, units } = bench();
    defender.pos = vec(30, 20); // clear of the revetment entirely
    fire(scene, units, vec(30, 20 + range));
    const damage = 100 - defender.hp;
    assert.ok(damage <= last + 1e-6, `damage rose from ${last.toFixed(0)} to ${damage.toFixed(0)} at ${range}m`);
    last = damage;
  }
  assert.equal(last, 0, 'at eight metres a hand grenade should be noise, not casualties');
});

test('you can lob one over the wall you are behind, but not through a hill', () => {
  const { scene, attacker } = bench();
  attacker.pos = vec(30, 28.5); // hard against the revetment
  assert.ok(canThrow(scene, attacker, vec(30, 32)), 'over a low wall at arm\'s length');
  assert.ok(!canThrow(scene, attacker, vec(30, 59)), 'and not to the far side of the map');

  const hill = new Scene(60, 60);
  hill.terrain.mound(vec(30, 30), 9, 9);
  hill.bake();
  const thrower = makeUnit({
    role: 'Rifleman', faction: Faction.Player, squadId: 0,
    pos: vec(30, 16), weapon: WEAPONS.carbine,
  });
  assert.ok(!canThrow(hill, thrower, vec(30, 44)), 'a nine metre hill is not something you throw through');
});

test('smoke conceals without protecting, then thins out', () => {
  const scene = new Scene(120, 60);
  scene.bake();
  const eye = { x: 20, y: 30, eye: Stature.standingEye };
  const man = { x: 70, y: 30, base: 0, top: Stature.standingTop };

  assert.equal(scene.sight(eye, man).concealment, 0);
  scene.smoke.add(vec(45, 30), 0);

  for (let t = 0; t < 6; t += 0.5) scene.smoke.update(0.5);
  const thick = scene.sight(eye, man);
  assert.ok(thick.concealment > 0.9, `only got ${thick.concealment.toFixed(2)} concealment`);
  // The critical half of the model: it hides, it does not stop anything.
  assert.equal(thick.exposure, 1, 'smoke must not make anybody harder to hit once seen');

  for (let t = 0; t < 40; t += 0.5) scene.smoke.update(0.5);
  assert.equal(scene.sight(eye, man).concealment, 0, 'it has to run out');
  assert.equal(scene.smoke.active, false);
});

test('cover planning ignores smoke, because smoke is for crossing', () => {
  const scene = new Scene(120, 60);
  scene.bake();
  const eye = { x: 20, y: 30, eye: Stature.standingEye };
  const man = { x: 70, y: 30, base: 0, top: Stature.standingTop };
  scene.smoke.add(vec(45, 30), 0);
  for (let t = 0; t < 6; t += 0.5) scene.smoke.update(0.5);

  assert.ok(scene.sight(eye, man).concealment > 0.9);
  assert.equal(
    scene.sightThroughSmoke(eye, man).concealment, 0,
    'a team settling into a position must not count a canister as cover',
  );
});

/** Flat ground, a ridge to form up behind, and a machine gun covering the rest. */
const KILLING_GROUND: LevelDef = {
  id: 'killing-ground',
  name: 'Killing Ground',
  brief: 'Forty metres of nothing, covered by a belt-fed.',
  size: { width: 60, height: 110 },
  paint: (scene) => {
    scene.terrain.bank([vec(0, 76), vec(60, 76)], 22, 2.8);
    revetment(scene, [vec(18, 22), vec(42, 22)], Fabric.Sandbag, 1.05, 1.2);
    scene.spawns.teams[0] = [vec(26, 100), vec(28, 100), vec(30, 100), vec(32, 100)];
    scene.spawns.teams[1] = [vec(20, 100), vec(22, 100), vec(24, 100), vec(26, 100)];
    scene.spawns.teams[2] = [vec(34, 100), vec(36, 100), vec(38, 100), vec(40, 100)];
    // A tall wall short of the position: something to be driven behind, and
    // then grenaded out of.
    scene.structures.addSegment({
      a: vec(22, 14), b: vec(40, 14), thickness: 0.8, sill: 0, top: 2.7,
      solidity: Solidity.Solid, fabric: Fabric.Brick, buildingId: null,
    });
    scene.spawns.enemies = [{ pos: vec(27, 24), kind: 'gunner' }, { pos: vec(34, 24), kind: 'rifle' }];
    scene.spawns.objectives = [vec(30, 18)];
  },
};

function cross(seed: number, useSmoke: boolean) {
  const sim = new Sim(KILLING_GROUND, seed);
  const alpha = sim.playerSquads[0];
  for (const other of [sim.playerSquads[1], sim.playerSquads[2]]) {
    for (const u of sim.membersOf(other)) u.state = UnitState.Dead;
  }

  sim.orderSquad(alpha.id, vec(30, 82), MoveMode.Tactical, -Math.PI / 2);
  for (let t = 0; t < 14; t += 0.05) sim.update(0.05);

  if (useSmoke) {
    for (const y of [64, 54, 44]) {
      sim.scene.smoke.add(vec(30, y), sim.scene.heightAt(30, y), { radius: 10 });
    }
    for (let t = 0; t < 4; t += 0.05) sim.update(0.05);
  }

  sim.orderSquad(alpha.id, vec(30, 42), MoveMode.Sprint, null);
  for (let t = 0; t < 24; t += 0.05) sim.update(0.05);

  const members = sim.membersOf(alpha);
  return {
    up: members.filter((u) => u.state === UnitState.Active).length,
    across: members.filter((u) => u.pos.y < 50).length,
  };
}

test('smoke is what makes open ground crossable', () => {
  // Aggregated rather than asserted seed by seed. Since teams can now break
  // and withdraw, a single run turns on whether one squad's nerve went — which
  // is the game working, not a property of smoke, and a per-seed assertion
  // measures the wrong thing.
  const seeds = [1, 2, 3, 4];
  let openAcross = 0;
  let screenedAcross = 0;
  let screenedUp = 0;
  for (const seed of seeds) {
    openAcross += cross(seed, false).across;
    const screened = cross(seed, true);
    screenedAcross += screened.across;
    screenedUp += screened.up;
  }
  const total = seeds.length * 4;
  assert.equal(
    openAcross, 0,
    `${openAcross} of ${total} walked into a machine gun across open ground and lived`,
  );
  assert.ok(
    screenedAcross >= total * 0.6 && screenedUp >= total * 0.6,
    `behind smoke only ${screenedAcross}/${total} crossed with ${screenedUp}/${total} still up`,
  );
});

test('a live grenade moves the man it lands next to', () => {
  const sim = new Sim(KILLING_GROUND, 5);
  const defender = sim.unitList.find((u) => u.faction === Faction.Hostile)!;
  for (let t = 0; t < 4; t += 0.05) sim.update(0.05);
  const held = { ...defender.pos };

  const alpha = sim.playerSquads[0];
  for (const u of sim.membersOf(alpha)) u.pos = vec(defender.pos.x, defender.pos.y + 18);
  assert.ok(sim.throwOrdnance(alpha.id, Ordnance.Frag, { ...held }), 'the throw should be on');

  // Watch only the window between it landing and it going off.
  let moved = 0;
  for (let t = 0; t < 2.2; t += 0.05) {
    sim.update(0.05);
    moved = Math.max(moved, Math.hypot(defender.pos.x - held.x, defender.pos.y - held.y));
  }
  assert.ok(
    moved > 1.5 || defender.state !== UnitState.Active,
    'a man who watches a grenade land at his feet should do something about it',
  );
});

test('hostiles grenade a position they cannot shoot into', () => {
  const sim = new Sim(KILLING_GROUND, 3);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const alpha = sim.playerSquads[0];

  // The team is behind the tall wall: nine metres away, and unshootable.
  for (const u of sim.membersOf(alpha)) {
    u.pos = vec(28 + (u.id % 3), 12.6);
    u.slot = null;
    u.coverSpot = null;
    // They are not the subject of this test, and a firefight would decide it
    // before the defenders got a chance to reach for anything.
    u.weapon = { ...u.weapon, maxRange: 1 };
  }
  // He knows they are there — he watched them go behind it a moment ago.
  const mark = sim.membersOf(alpha)[0];
  for (const h of hostiles) {
    h.memory.set(mark.id, { pos: { ...mark.pos }, age: 0 });
    h.facing = -Math.PI / 2;
  }

  let thrown = false;
  for (let t = 0; t < 6 && !thrown; t += 0.05) {
    sim.update(0.05);
    thrown = sim.live.some((o) => o.faction === Faction.Hostile);
  }
  assert.ok(
    thrown,
    'a defender who knows where you are and cannot shoot you should reach for a grenade',
  );
});

test('losing a contact does not end the exchange', () => {
  const sim = new Sim(KILLING_GROUND, 9);
  const defender = sim.unitList.find((u) => u.faction === Faction.Hostile)!;
  const alpha = sim.playerSquads[0];
  const mark = sim.membersOf(alpha)[0];

  // Out in front of him, in the open, close enough to be seen.
  for (const u of sim.membersOf(alpha)) {
    u.pos = vec(28 + (u.id % 3), 45);
    u.slot = null;
    u.coverSpot = null;
  }
  defender.facing = -Math.PI / 2;
  for (let t = 0; t < 4; t += 0.05) sim.update(0.05);
  assert.ok(defender.visible.length > 0, 'he should have them in sight to begin with');

  // Gone — behind smoke, and nothing new to see.
  for (const u of sim.membersOf(alpha)) u.pos = vec(u.pos.x, 300);
  sim.scene.smoke.add({ ...mark.pos }, 0, { radius: 12 });

  let raked = 0;
  for (let t = 0; t < 6; t += 0.05) {
    sim.update(0.05);
    if (defender.suppressAt) raked++;
  }
  assert.ok(raked > 20, 'he should keep the muzzle on where they were');

  // But not forever: a lost contact buys a burst, not a career.
  for (let t = 0; t < 14; t += 0.05) sim.update(0.05);
  assert.equal(defender.suppressAt, null, 'area fire has to run out');
});

test('area fire still respects the cover it is fired into', () => {
  // Two men the same distance from the same impact point, taking the same
  // number of rounds: one in the open, one behind a revetment. Blind fire must
  // not flatten the difference. Given enough hit points to absorb it, so what
  // is measured is damage rather than who happened to die first.
  const punish = (covered: boolean): number => {
    resetUnitIds();
    const scene = new Scene(80, 80);
    // Ten metres short of the target, so three thousand rounds land beyond it
    // rather than knocking it down — which they will happily do, and which
    // would quietly turn this into a test of nothing.
    if (covered) revetment(scene, [vec(20, 30), vec(60, 30)], Fabric.Sandbag, 1.6, 1.2);
    scene.bake();

    const shooter = makeUnit({
      role: 'Automatic Rifleman', faction: Faction.Player, squadId: 0,
      pos: vec(40, 12), weapon: WEAPONS.saw,
    });
    const target = makeUnit({
      role: 'Rifleman', faction: Faction.Hostile, squadId: 1,
      pos: vec(40, 40), weapon: WEAPONS.carbine, maxHp: 100000,
    });
    const units = [shooter, target];
    const rng = new Rng(21);
    for (let i = 0; i < 3000; i++) {
      resolveAreaShot(scene, rng, units, shooter, { ...target.pos }, []);
    }
    return target.maxHp - target.hp;
  };

  const exposed = punish(false);
  const behind = punish(true);
  assert.ok(exposed > 200, `blind fire in the open only did ${exposed.toFixed(0)}`);
  assert.ok(
    behind < exposed * 0.5,
    `cover barely helped: ${behind.toFixed(0)} behind a wall vs ${exposed.toFixed(0)} in the open`,
  );
});

test('the player can rake ground, and a move order calls it off', () => {
  const sim = new Sim(KILLING_GROUND, 4);
  const alpha = sim.playerSquads[0];
  for (const u of sim.membersOf(alpha)) {
    u.pos = vec(28 + (u.id % 3), 50);
    u.slot = null;
    u.coverSpot = null;
  }
  for (let t = 0; t < 2; t += 0.05) sim.update(0.05);

  // Nobody shooting back, so what is measured is the order rather than who
  // got pinned first.
  for (const u of sim.unitList) {
    if (u.faction === Faction.Hostile) u.state = UnitState.Dead;
  }
  assert.ok(sim.suppressArea(alpha.id, vec(30, 26)), 'they have a line to it');
  assert.ok(
    sim.membersOf(alpha).filter((u) => u.suppressAt !== null).length >= 3,
    'the team takes it up',
  );

  for (let t = 0; t < 3; t += 0.05) sim.update(0.05);
  assert.ok(sim.membersOf(alpha).some((u) => u.suppressAt !== null), 'and holds it');

  sim.orderSquad(alpha.id, vec(30, 60), MoveMode.Tactical, null);
  assert.ok(
    sim.membersOf(alpha).every((u) => u.suppressAt === null),
    'being told to go somewhere ends being told to hold and shoot',
  );

  // And ground with a hill in the way is refused rather than silently ignored.
  const blind = new Sim(KILLING_GROUND, 4);
  const team = blind.playerSquads[0];
  for (const u of blind.membersOf(team)) u.pos = vec(30, 100);
  assert.equal(blind.suppressArea(team.id, vec(30, 24)), false, 'no line over the ridge');
});

test('smoke after contact costs more than smoke before it', () => {
  const advance = (seed: number, mode: 'screened' | 'broken') => {
    const sim = new Sim(KILLING_GROUND, seed);
    const alpha = sim.playerSquads[0];
    for (const other of [sim.playerSquads[1], sim.playerSquads[2]]) {
      for (const u of sim.membersOf(other)) u.state = UnitState.Dead;
    }
    const pop = () => {
      for (const y of [64, 54, 44]) {
        sim.scene.smoke.add(vec(30, y), sim.scene.heightAt(30, y), { radius: 10 });
      }
    };

    sim.orderSquad(alpha.id, vec(30, 82), MoveMode.Tactical, -Math.PI / 2);
    for (let t = 0; t < 14; t += 0.05) sim.update(0.05);
    if (mode === 'screened') {
      pop();
      for (let t = 0; t < 4; t += 0.05) sim.update(0.05);
    }

    sim.orderSquad(alpha.id, vec(30, 42), MoveMode.Sprint, null);
    for (let t = 0; t < 26; t += 0.05) {
      sim.update(0.05);
      if (mode === 'broken' && Math.abs(t - 4.5) < 0.03) pop();
    }
    return sim.membersOf(alpha).filter((u) => u.state === UnitState.Active).length;
  };

  let screened = 0;
  let broken = 0;
  for (const seed of [1, 2, 3]) {
    screened += advance(seed, 'screened');
    broken += advance(seed, 'broken');
  }
  assert.ok(screened >= 9, `screening before contact should work: only ${screened}/12 survived`);
  assert.ok(
    broken < screened,
    `popping smoke once already seen must cost something: ${broken}/12 vs ${screened}/12`,
  );
});
