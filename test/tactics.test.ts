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
for (const [t, y] of [[0, 100], [16, 84], [30, 70], [46, 48], [62, 30]] as const) {
  for (const squad of [0, 1, 2]) {
    FRONTAL.push({ t, squad, x: 78 + squad * 8, y, mode: MoveMode.Sprint });
  }
}
for (const [squad, x] of [[0, 86], [1, 92], [2, 98]] as const) {
  FRONTAL.push({ t: 82, squad, x, y: 23, mode: MoveMode.Tactical });
}

/** BRAVO works the middle as a base of fire; the others bound the flanks. */
const BOUNDING: Step[] = [
  { t: 0, squad: 1, x: 86, y: 113, mode: MoveMode.Tactical },
  { t: 4, squad: 0, x: 40, y: 112, mode: MoveMode.Tactical },
  { t: 4, squad: 2, x: 132, y: 112, mode: MoveMode.Tactical },
  { t: 22, squad: 0, x: 34, y: 101, mode: MoveMode.Sprint },
  { t: 22, squad: 2, x: 140, y: 100, mode: MoveMode.Sprint },
  { t: 40, squad: 0, x: 26, y: 90, mode: MoveMode.Tactical },
  { t: 40, squad: 2, x: 146, y: 86, mode: MoveMode.Tactical },
  { t: 56, squad: 1, x: 86, y: 100, mode: MoveMode.Tactical },
  { t: 68, squad: 0, x: 22, y: 74, mode: MoveMode.Sprint },
  { t: 68, squad: 2, x: 152, y: 72, mode: MoveMode.Sprint },
  { t: 86, squad: 0, x: 32, y: 60, mode: MoveMode.Tactical },
  { t: 86, squad: 2, x: 146, y: 60, mode: MoveMode.Tactical },
  { t: 100, squad: 1, x: 86, y: 86, mode: MoveMode.Tactical },
  { t: 112, squad: 0, x: 44, y: 42, mode: MoveMode.Tactical },
  { t: 112, squad: 2, x: 130, y: 40, mode: MoveMode.Tactical },
  { t: 128, squad: 1, x: 88, y: 68, mode: MoveMode.Sprint },
  { t: 142, squad: 0, x: 78, y: 26, mode: MoveMode.Tactical },
  { t: 142, squad: 2, x: 108, y: 26, mode: MoveMode.Tactical },
  { t: 160, squad: 1, x: 92, y: 24, mode: MoveMode.Tactical },
];

function runPlan(plan: Step[], seed: number) {
  const sim = new Sim(STEPOVE, seed);
  const steps = [...plan].sort((a, b) => a.t - b.t);
  let next = 0;

  for (let i = 0; i < 60 * 220; i++) {
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

test('fire and maneuver beats crossing the open', { timeout: 600_000 }, () => {
  // The whole design rests on this. Nothing in the code rewards flanking
  // directly — it falls out of cover being directional, suppression wrecking
  // accuracy, and movement making you conspicuous. If this inverts, one of
  // those three has been tuned into irrelevance.
  //
  // It runs on Stepove rather than Cold Harbour because Cold Harbour is 73 m
  // corner to corner: with the engagement envelope this game now uses, there
  // is no ground on it far enough to be worth crossing carefully, so it cannot
  // tell the two plans apart.
  const seeds = [2000, 2011, 2022, 2033];
  const frontal = score(FRONTAL, seeds);
  const bounding = score(BOUNDING, seeds);

  assert.ok(
    bounding.killed < frontal.killed,
    `bounding lost ${bounding.killed.toFixed(1)} operators on average, frontal lost ${frontal.killed.toFixed(1)}`,
  );
  assert.ok(
    bounding.standing > frontal.standing + 1,
    `bounding finished with ${bounding.standing.toFixed(1)} standing, frontal with ${frontal.standing.toFixed(1)}`,
  );
  assert.ok(
    bounding.neutralised > frontal.neutralised,
    `bounding put down ${bounding.neutralised.toFixed(1)} defenders, frontal ${frontal.neutralised.toFixed(1)}`,
  );
});
