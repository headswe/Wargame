import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COLD_HARBOUR } from '../src/sim/levels.ts';
import { MissionState, Sim } from '../src/sim/sim.ts';
import { Faction, MoveMode, UnitState } from '../src/sim/units.ts';

interface Step {
  t: number;
  squad: number;
  x: number;
  y: number;
  mode: MoveMode;
  face?: number;
}

const N = -Math.PI / 2;

/** Kick the front door: everyone sprints straight up the middle. */
const FRONTAL: Step[] = [
  { t: 0, squad: 0, x: 33, y: 29, mode: MoveMode.Sprint },
  { t: 0, squad: 1, x: 33, y: 30, mode: MoveMode.Sprint },
  { t: 0, squad: 2, x: 34, y: 30, mode: MoveMode.Sprint },
  { t: 8, squad: 0, x: 28, y: 20, mode: MoveMode.Sprint, face: N },
  { t: 8, squad: 1, x: 32, y: 20, mode: MoveMode.Sprint, face: N },
  { t: 8, squad: 2, x: 36, y: 20, mode: MoveMode.Sprint, face: N },
  { t: 20, squad: 0, x: 26, y: 12, mode: MoveMode.Sprint, face: N },
  { t: 20, squad: 1, x: 30, y: 12, mode: MoveMode.Sprint, face: N },
  { t: 20, squad: 2, x: 34, y: 12, mode: MoveMode.Sprint, face: N },
  { t: 32, squad: 0, x: 26, y: 7, mode: MoveMode.Sprint, face: N },
  { t: 32, squad: 1, x: 29, y: 7, mode: MoveMode.Sprint, face: N },
  { t: 32, squad: 2, x: 33, y: 7, mode: MoveMode.Sprint, face: N },
  { t: 50, squad: 0, x: 28, y: 5, mode: MoveMode.Tactical, face: N },
  { t: 50, squad: 1, x: 30, y: 5, mode: MoveMode.Tactical, face: N },
  { t: 50, squad: 2, x: 26, y: 5, mode: MoveMode.Tactical, face: N },
];

/** BRAVO holds the wall as the base of fire; ALPHA and CHARLIE bound the flanks. */
const BOUNDING: Step[] = [
  { t: 0, squad: 1, x: 30, y: 29, mode: MoveMode.Tactical, face: N },
  { t: 2, squad: 0, x: 10, y: 30, mode: MoveMode.Tactical, face: N },
  { t: 2, squad: 2, x: 46, y: 30, mode: MoveMode.Tactical, face: N },
  { t: 16, squad: 0, x: 10, y: 24, mode: MoveMode.Sprint, face: N },
  { t: 16, squad: 2, x: 46, y: 24, mode: MoveMode.Sprint, face: N },
  { t: 28, squad: 0, x: 11, y: 19, mode: MoveMode.Tactical, face: N },
  { t: 28, squad: 2, x: 45, y: 19, mode: MoveMode.Tactical, face: N },
  { t: 42, squad: 0, x: 13, y: 13, mode: MoveMode.Tactical, face: N },
  { t: 42, squad: 2, x: 44, y: 13, mode: MoveMode.Tactical, face: N },
  { t: 56, squad: 0, x: 15, y: 11, mode: MoveMode.Sprint, face: N },
  { t: 56, squad: 2, x: 45, y: 11, mode: MoveMode.Sprint, face: N },
  { t: 64, squad: 1, x: 30, y: 20, mode: MoveMode.Sprint, face: N },
  { t: 70, squad: 0, x: 17, y: 7, mode: MoveMode.Tactical, face: N },
  { t: 70, squad: 2, x: 44, y: 7, mode: MoveMode.Tactical, face: N },
  { t: 80, squad: 1, x: 30, y: 12, mode: MoveMode.Sprint, face: N },
  { t: 92, squad: 1, x: 29, y: 6, mode: MoveMode.Tactical, face: N },
  { t: 104, squad: 0, x: 26, y: 5, mode: MoveMode.Tactical, face: N },
  { t: 104, squad: 2, x: 31, y: 5, mode: MoveMode.Tactical, face: N },
];

function runPlan(plan: Step[], seed: number) {
  const sim = new Sim(COLD_HARBOUR, seed);
  const dt = 1 / 60;
  const steps = [...plan].sort((a, b) => a.t - b.t);
  let next = 0;

  for (let i = 0; i < 60 * 180; i++) {
    while (next < steps.length && sim.time >= steps[next].t) {
      const s = steps[next++];
      sim.orderSquad(s.squad, { x: s.x, y: s.y }, s.mode, s.face ?? null);
    }
    sim.update(dt);
    if (sim.missionState !== MissionState.InProgress) break;
  }

  const players = sim.unitList.filter((u) => u.faction === Faction.Player);
  return {
    won: sim.missionState === MissionState.Won,
    killed: players.filter((u) => u.state === UnitState.Dead).length,
  };
}

function score(plan: Step[], seeds: number[]) {
  let wins = 0;
  let killed = 0;
  for (const seed of seeds) {
    const r = runPlan(plan, seed);
    if (r.won) wins++;
    killed += r.killed;
  }
  return { wins, killed: killed / seeds.length };
}

test('fire and maneuver beats a frontal assault', { timeout: 300_000 }, () => {
  // The whole design rests on this. Nothing in the code rewards flanking
  // directly — it falls out of cover being directional, suppression wrecking
  // accuracy, and movement making you conspicuous. If this inverts, one of
  // those three has been tuned into irrelevance.
  const seeds = [1000, 1007, 1014, 1021, 1028, 1035, 1042, 1049];
  const frontal = score(FRONTAL, seeds);
  const bounding = score(BOUNDING, seeds);

  assert.ok(
    bounding.wins > frontal.wins,
    `bounding won ${bounding.wins}/${seeds.length}, frontal won ${frontal.wins}/${seeds.length}`,
  );
  assert.ok(
    bounding.killed < frontal.killed,
    `bounding lost ${bounding.killed.toFixed(1)} operators on average, frontal lost ${frontal.killed.toFixed(1)}`,
  );
  // A frontal assault into a machine gun should not be a viable plan.
  assert.ok(
    frontal.wins <= seeds.length / 4,
    `frontal assault won ${frontal.wins}/${seeds.length} — the killzone is not doing its job`,
  );
});
