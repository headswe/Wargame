/**
 * Engagement measurement, so balance claims can be checked instead of felt.
 *
 * Runs scripted assaults on Stepove across several seeds and reports what
 * actually happened: who died, how many rounds went out, and — the number that
 * turned out to matter most — how often a defender had a shot available at
 * all. A defence that never fires may be passive, or may simply never have a
 * target in range with a line to it, and those call for opposite fixes.
 *
 * The plans are scripts, not play, so treat the absolute numbers as a fixture
 * rather than as truth. What they are good for is comparison: the same plans
 * before and after a change, and the gap between playing well and playing
 * badly, which is the thing a tactics game is actually selling.
 *
 *   npm run balance
 *   npm run balance -- bounding      # one plan only
 */
import { MissionState, Sim } from '../src/sim/sim.ts';
import { STEPOVE } from '../src/sim/levels.ts';
import { Faction, MoveMode, Nerve, Posture, UnitState } from '../src/sim/units.ts';
import { dist, vec } from '../src/sim/math.ts';
import { hitChance } from '../src/sim/combat.ts';

interface Step {
  t: number;
  squad: number;
  x: number;
  y: number;
  mode: MoveMode;
}

const step = (t: number, squad: number, x: number, y: number, mode: MoveMode): Step =>
  ({ t, squad, x, y, mode });

/** Straight up the middle at a run. The way you are not supposed to do it. */
const FRONTAL: Step[] = [];
for (const [t, y] of [[0, 100], [16, 86], [30, 70], [46, 50], [62, 30]] as const) {
  for (const squad of [0, 1, 2]) FRONTAL.push(step(t, squad, 80 + squad * 8, y, MoveMode.Sprint));
}

/** Base of fire in the middle, flanks bounding forward under it. */
const BOUNDING: Step[] = [
  step(0, 1, 86, 112, MoveMode.Tactical),
  step(4, 0, 40, 112, MoveMode.Tactical),
  step(4, 2, 130, 112, MoveMode.Tactical),
  step(20, 0, 34, 100, MoveMode.Sprint),
  step(20, 2, 140, 100, MoveMode.Sprint),
  step(36, 1, 86, 95, MoveMode.Tactical),
  step(48, 0, 36, 82, MoveMode.Tactical),
  step(48, 2, 132, 78, MoveMode.Tactical),
  step(66, 1, 86, 79, MoveMode.Tactical),
  step(84, 0, 40, 64, MoveMode.Tactical),
];

/** What the briefing actually tells you to do: cross inside the ditch. */
const DITCH: Step[] = [
  step(0, 0, 40, 82, MoveMode.Tactical),
  step(0, 1, 86, 79, MoveMode.Tactical),
  step(0, 2, 130, 76, MoveMode.Tactical),
  step(34, 0, 62, 80, MoveMode.Tactical),
  step(34, 2, 108, 77, MoveMode.Tactical),
  step(56, 1, 86, 66, MoveMode.Tactical),
  step(72, 0, 64, 62, MoveMode.Tactical),
  step(72, 2, 106, 60, MoveMode.Tactical),
];

const PLANS: Record<string, Step[]> = { frontal: FRONTAL, bounding: BOUNDING, ditch: DITCH };

const SEEDS = [1009, 2213, 4242, 7717, 9001];
const DURATION = 115;
const DT = 0.05;

interface Result {
  operatorsUp: number;
  defendersUp: number;
  playerRounds: number;
  aimedRounds: number;
  blindRounds: number;
  /** Defender-seconds in which somebody was in range with a line to them. */
  reachSeconds: number;
  /** Of those, the share where the defender had actually acquired him. */
  acquiredSeconds: number;
  /** No shot because everything in view was beyond the weapon's reach. */
  outOfRangeSeconds: number;
  /** No shot because nothing in reach had a line to it. */
  noLineSeconds: number;
  /** Operator-seconds spent under enough fire to matter. */
  underFire: number;
  pinnedSeconds: number;
  defendersWhoFired: number;
  /**
   * Men who lost their nerve at some point, counted one at a time.
   *
   * The number the per-soldier rout exists to move. Held per team it could
   * only ever read 0, 4, 8 or 12; what it should read now is everything in
   * between, because that is what a position coming apart looks like.
   */
  operatorsBroke: number;
  defendersBroke: number;
  /** Whether the plan actually took the place, which survivors do not say. */
  won: number;
}

function play(plan: Step[], seed: number): Result {
  const sim = new Sim(STEPOVE, seed);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const players = sim.unitList.filter((u) => u.faction === Faction.Player);
  const startingAmmo = new Map(hostiles.map((h) => [h.id, h.ammoInMag]));
  const fired = new Set<number>();

  const r: Result = {
    operatorsUp: 0, defendersUp: 0, playerRounds: 0, aimedRounds: 0, blindRounds: 0,
    reachSeconds: 0, acquiredSeconds: 0, outOfRangeSeconds: 0, noLineSeconds: 0,
    underFire: 0, pinnedSeconds: 0, defendersWhoFired: 0,
    operatorsBroke: 0, defendersBroke: 0, won: 0,
  };
  const broke = new Set<number>();

  let next = 0;
  let tick = 0;
  for (let t = 0; t < DURATION; t += DT) {
    while (next < plan.length && plan[next].t <= t) {
      const s = plan[next++];
      sim.orderSquad(s.squad, vec(s.x, s.y), s.mode, -Math.PI / 2);
    }
    sim.update(DT);

    const raking = new Set<number>();
    for (const h of hostiles) {
      if (h.state === UnitState.Active && h.suppressAt !== null) raking.add(h.id);
    }

    for (const e of sim.effects) {
      if (e.kind !== 'shot') continue;
      const shooter = sim.units.get(e.shooterId);
      if (!shooter) continue;
      if (shooter.faction !== Faction.Hostile) {
        r.playerRounds++;
      } else {
        fired.add(shooter.id);
        if (raking.has(shooter.id)) r.blindRounds++;
        else r.aimedRounds++;
      }
    }

    for (const p of players) {
      if (p.state !== UnitState.Active) continue;
      if (p.suppression > 0.3) r.underFire += DT;
      if (p.posture === Posture.Pinned) r.pinnedSeconds += DT;
    }

    for (const u of sim.unitList) {
      if (u.state === UnitState.Active && u.nerveState === Nerve.Broken) broke.add(u.id);
    }

    // Sampled at 1 Hz: a sightline per defender per player is not free, and
    // the answer does not move meaningfully inside a second.
    if (tick++ % 20 !== 0) continue;
    for (const h of hostiles) {
      if (h.state !== UnitState.Active) continue;
      let reach = false;
      let acquired = false;
      // Why not, when not: a defender who cannot shoot because the ground is
      // in the way needs repositioning, and one who cannot shoot because his
      // rifle will not carry needs a different rifle. Opposite fixes, so they
      // are counted apart.
      let blockedButInRange = false;
      let inLineButTooFar = false;
      for (const p of players) {
        if (p.state !== UnitState.Active) continue;
        const range = dist(h.pos, p.pos);
        const clear = !sim.scene.sight(
          { x: h.pos.x, y: h.pos.y, eye: 1.04 },
          { x: p.pos.x, y: p.pos.y, base: 0, top: 1.78 },
        ).visible;
        if (range <= h.weapon.maxRange) {
          if (clear) blockedButInRange = true;
          else {
            reach = true;
            if (h.visible.includes(p.id)) acquired = true;
          }
        } else if (!clear) {
          inLineButTooFar = true;
        }
      }
      if (reach) r.reachSeconds++;
      else if (inLineButTooFar) r.outOfRangeSeconds++;
      else if (blockedButInRange) r.noLineSeconds++;
      if (acquired) r.acquiredSeconds++;
    }
  }

  r.operatorsUp = players.filter((p) => p.state === UnitState.Active).length;
  r.defendersUp = hostiles.filter((h) => h.state === UnitState.Active).length;
  r.defendersWhoFired = fired.size;
  r.operatorsBroke = players.filter((p) => broke.has(p.id)).length;
  r.defendersBroke = hostiles.filter((h) => broke.has(h.id)).length;
  r.won = sim.missionState === MissionState.Won ? 1 : 0;
  void startingAmmo;
  return r;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const only = process.argv[2];
const names = only ? [only] : Object.keys(PLANS);
const totals = new Map<string, Result[]>();

for (const name of names) {
  const plan = PLANS[name];
  if (!plan) {
    console.error(`no such plan: ${name} (have ${Object.keys(PLANS).join(', ')})`);
    process.exit(1);
  }
  totals.set(name, SEEDS.map((seed) => play(plan, seed)));
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n = 5, digits = 1) => v.toFixed(digits).padStart(n);

console.log(`Stepove, ${SEEDS.length} seeds, ${DURATION}s each. 12 operators, 14 defenders.\n`);
console.log(
  `${pad('plan', 9)} ${pad('operators', 10)} ${pad('defenders', 10)} ` +
  `${pad('rounds P/H', 12)} ${pad('blind', 6)} ${pad('reach', 7)} ` +
  `${pad('acq', 6)} ${pad('underfire', 10)} ${pad('shooters', 9)} ${pad('broke P/H', 10)} won`,
);
for (const [name, runs] of totals) {
  const up = mean(runs.map((x) => x.operatorsUp));
  const def = mean(runs.map((x) => x.defendersUp));
  const pr = mean(runs.map((x) => x.playerRounds));
  const hr = mean(runs.map((x) => x.aimedRounds + x.blindRounds));
  const blind = mean(runs.map((x) => x.blindRounds));
  const reach = mean(runs.map((x) => x.reachSeconds));
  const acq = mean(runs.map((x) => x.acquiredSeconds));
  const fire = mean(runs.map((x) => x.underFire));
  const shooters = mean(runs.map((x) => x.defendersWhoFired));
  const far = mean(runs.map((x) => x.outOfRangeSeconds));
  const blind2 = mean(runs.map((x) => x.noLineSeconds));
  const brokeP = mean(runs.map((x) => x.operatorsBroke));
  const brokeH = mean(runs.map((x) => x.defendersBroke));
  const won = runs.reduce((a, x) => a + x.won, 0);
  console.log(
    `${pad(name, 9)} ${num(up, 4)}/12   ${num(def, 4)}/14   ` +
    `${num(pr, 4, 0)}/${num(hr, 4, 0)}   ${num(blind, 4, 0)}  ${num(reach, 5, 0)}s  ` +
    `${num(acq, 4, 0)}s  ${num(fire, 6)}s   ${num(shooters, 4)}/14   ` +
    `${num(brokeP, 4)}/${num(brokeH, 4)}  ${won}/${runs.length}  ` +
    `| no shot: ${num(far, 4, 0)}s too far, ${num(blind2, 4, 0)}s no line`,
  );
}

const bounding = totals.get('bounding');
const frontal = totals.get('frontal');
if (bounding && frontal) {
  const gap = mean(bounding.map((x) => x.operatorsUp)) - mean(frontal.map((x) => x.operatorsUp));
  console.log(`\nskill gradient (bounding minus frontal): ${gap.toFixed(1)} operators`);
}
console.log(
  '\nreach = defender-seconds with a target in range and in view;' +
  ' acq = of those, actually acquired;' +
  '\nbroke = men who lost their nerve at some point, counted one at a time.',
);
