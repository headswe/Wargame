import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STEPOVE } from '../src/sim/levels.ts';
import { MissionState, Sim } from '../src/sim/sim.ts';
import { Faction, MoveMode, UnitState } from '../src/sim/units.ts';

interface Step {
  t: number;
  squad: number;
  x: number;
  y: number;
  mode: MoveMode;
}

const NORTH = -Math.PI / 2;

/** Straight up the middle at a run, the whole way. */
const FRONTAL: Step[] = [];
for (const [t, y] of [[0, 100], [16, 86], [30, 70], [46, 50], [62, 30]] as const) {
  for (const squad of [0, 1, 2]) {
    FRONTAL.push({ t, squad, x: 80 + squad * 8, y, mode: MoveMode.Sprint });
  }
}
for (const [squad, x] of [[0, 88], [1, 94], [2, 100]] as const) {
  FRONTAL.push({ t: 80, squad, x, y: 17, mode: MoveMode.Tactical });
}

/**
 * BRAVO works the middle as a base of fire, using the ridge and then the
 * ditch. ALPHA and CHARLIE bound the flanks, crossing the open in the ditch
 * rather than over it.
 */
const BOUNDING: Step[] = [
  { t: 0, squad: 1, x: 86, y: 112, mode: MoveMode.Tactical },
  { t: 4, squad: 0, x: 40, y: 112, mode: MoveMode.Tactical },
  { t: 4, squad: 2, x: 130, y: 112, mode: MoveMode.Tactical },
  { t: 20, squad: 0, x: 34, y: 100, mode: MoveMode.Sprint },
  { t: 20, squad: 2, x: 140, y: 100, mode: MoveMode.Sprint },
  { t: 36, squad: 1, x: 86, y: 95, mode: MoveMode.Tactical },
  { t: 46, squad: 0, x: 26, y: 83, mode: MoveMode.Sprint },
  { t: 46, squad: 2, x: 146, y: 77, mode: MoveMode.Sprint },
  { t: 64, squad: 0, x: 24, y: 68, mode: MoveMode.Tactical },
  { t: 64, squad: 2, x: 150, y: 65, mode: MoveMode.Tactical },
  { t: 82, squad: 0, x: 34, y: 52, mode: MoveMode.Tactical },
  { t: 82, squad: 2, x: 146, y: 50, mode: MoveMode.Tactical },
  { t: 96, squad: 1, x: 86, y: 80, mode: MoveMode.Tactical },
  { t: 112, squad: 0, x: 46, y: 34, mode: MoveMode.Tactical },
  { t: 112, squad: 2, x: 132, y: 32, mode: MoveMode.Tactical },
  { t: 128, squad: 1, x: 88, y: 60, mode: MoveMode.Sprint },
  { t: 144, squad: 0, x: 82, y: 20, mode: MoveMode.Tactical },
  { t: 144, squad: 2, x: 108, y: 20, mode: MoveMode.Tactical },
  { t: 162, squad: 1, x: 94, y: 17, mode: MoveMode.Tactical },
];

function runPlan(plan: Step[], seed: number) {
  const sim = new Sim(STEPOVE, seed);
  const steps = [...plan].sort((a, b) => a.t - b.t);
  let next = 0;

  for (let i = 0; i < 60 * 230; i++) {
    while (next < steps.length && sim.time >= steps[next].t) {
      const s = steps[next++];
      sim.orderSquad(s.squad, { x: s.x, y: s.y }, s.mode, NORTH);
    }
    sim.update(1 / 60);
    if (sim.missionState !== MissionState.InProgress) break;
  }

  const players = sim.unitList.filter((u) => u.faction === Faction.Player);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  return {
    killed: players.filter((u) => u.state === UnitState.Dead).length,
    standing: players.filter((u) => u.state === UnitState.Active).length,
    neutralised: hostiles.filter((u) => u.state !== UnitState.Active).length,
  };
}

function score(plan: Step[], seeds: number[]) {
  let killed = 0;
  let standing = 0;
  let neutralised = 0;
  for (const seed of seeds) {
    const r = runPlan(plan, seed);
    killed += r.killed;
    standing += r.standing;
    neutralised += r.neutralised;
  }
  const n = seeds.length;
  return { killed: killed / n, standing: standing / n, neutralised: neutralised / n };
}

test('fire and maneuver beats crossing the open', { timeout: 900_000 }, () => {
  // The design rests on this. Nothing rewards flanking directly — it falls out
  // of cover being measured geometry, suppression wrecking accuracy, and
  // movement making you conspicuous. If it inverts, one of those three has
  // been tuned into irrelevance.
  const seeds = [2000, 2011, 2022, 2033];
  const frontal = score(FRONTAL, seeds);
  const bounding = score(BOUNDING, seeds);

  assert.ok(
    bounding.killed < frontal.killed,
    `bounding lost ${bounding.killed.toFixed(1)} operators on average, frontal lost ${frontal.killed.toFixed(1)}`,
  );
  assert.ok(
    bounding.standing > frontal.standing,
    `bounding finished with ${bounding.standing.toFixed(1)} standing, frontal with ${frontal.standing.toFixed(1)}`,
  );
  assert.ok(
    bounding.neutralised > frontal.neutralised,
    `bounding put down ${bounding.neutralised.toFixed(1)} defenders, frontal ${frontal.neutralised.toFixed(1)}`,
  );
});
