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
import { KOLNA, STEPOVE } from '../src/sim/levels.ts';
import { createScene } from '../src/sim/world/level-data.ts';
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

/**
 * Every plan has to try to take the same place.
 *
 * This is the correction that matters most in here. The three scripts used to
 * stop at different distances — the charge ran the whole way in while the two
 * careful plans halted halfway — so the only comparable number was who was left
 * standing, and that one is won by refusing to go. A plan that keeps twelve men
 * alive eighty metres short has not beaten one that loses six taking the
 * ground, and until all three are pointed at the objective the harness cannot
 * tell the difference.
 */
const OBJECTIVE = { x: 94, y: 14 };

/** Straight up the middle at a run. The way you are not supposed to do it. */
const FRONTAL: Step[] = [];
for (const [t, y] of [[0, 100], [16, 86], [30, 70], [46, 50], [62, 42]] as const) {
  for (const squad of [0, 1, 2]) FRONTAL.push(step(t, squad, 80 + squad * 8, y, MoveMode.Sprint));
}
for (const squad of [0, 1, 2]) {
  FRONTAL.push(step(80, squad, OBJECTIVE.x + (squad - 1) * 7, OBJECTIVE.y + 5, MoveMode.Sprint));
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
  step(84, 2, 132, 62, MoveMode.Tactical),
  step(102, 1, 86, 66, MoveMode.Tactical),
  step(116, 0, 44, 46, MoveMode.Tactical),
  step(116, 2, 128, 46, MoveMode.Tactical),
  step(136, 1, 90, 52, MoveMode.Tactical),
  step(152, 0, 78, 26, MoveMode.Tactical),
  step(152, 2, 112, 26, MoveMode.Tactical),
  step(170, 1, OBJECTIVE.x, OBJECTIVE.y + 5, MoveMode.Tactical),
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
  step(72, 2, 106, 56, MoveMode.Tactical),
  step(90, 1, 86, 52, MoveMode.Tactical),
  step(106, 0, 60, 44, MoveMode.Tactical),
  step(106, 2, 110, 44, MoveMode.Tactical),
  step(126, 1, 88, 42, MoveMode.Tactical),
  step(144, 0, 78, 24, MoveMode.Tactical),
  step(144, 2, 112, 24, MoveMode.Tactical),
  step(162, 1, OBJECTIVE.x, OBJECTIVE.y + 5, MoveMode.Tactical),
];

/**
 * Kolna: the same question asked of a level with no open ground in it.
 *
 * Stepove's plans are about how to cross eighty metres. These are about which
 * way round a wall to go, which is the point of having a second map — the
 * systems were all tuned against a long approach, and a harness that can only
 * measure long approaches cannot say whether they generalise.
 */
const KOLNA_OBJECTIVE = { x: 66, y: 20 };

/** Straight up the haul road at the gate everyone is watching. */
const KOLNA_FRONTAL: Step[] = [
  step(0, 0, 60, 88, MoveMode.Tactical),
  step(0, 1, 70, 88, MoveMode.Tactical),
  step(0, 2, 80, 88, MoveMode.Tactical),
  step(24, 0, 62, 78, MoveMode.Sprint),
  step(24, 1, 70, 78, MoveMode.Sprint),
  step(24, 2, 78, 78, MoveMode.Sprint),
  step(56, 0, 60, 62, MoveMode.Sprint),
  step(56, 1, 70, 62, MoveMode.Sprint),
  step(56, 2, 76, 58, MoveMode.Sprint),
  step(96, 0, 58, 40, MoveMode.Sprint),
  step(96, 1, 70, 40, MoveMode.Sprint),
  step(96, 2, 80, 40, MoveMode.Sprint),
  step(140, 0, 58, 24, MoveMode.Sprint),
  step(140, 1, KOLNA_OBJECTIVE.x, KOLNA_OBJECTIVE.y + 6, MoveMode.Sprint),
  step(140, 2, 76, 24, MoveMode.Sprint),
];

/** Base of fire on the forward post, both flanks round the outside of the wall. */
const KOLNA_FLANKS: Step[] = [
  step(0, 1, 70, 90, MoveMode.Tactical),
  step(4, 0, 20, 90, MoveMode.Tactical),
  step(4, 2, 128, 92, MoveMode.Tactical),
  step(22, 0, 16, 62, MoveMode.Tactical),
  step(22, 2, 126, 76, MoveMode.Tactical),
  step(46, 1, 70, 80, MoveMode.Tactical),
  step(64, 0, 18, 46, MoveMode.Tactical),
  step(64, 2, 122, 52, MoveMode.Tactical),
  step(90, 0, 28, 40, MoveMode.Tactical),
  step(90, 2, 108, 46, MoveMode.Tactical),
  step(116, 1, 70, 62, MoveMode.Tactical),
  step(138, 0, 42, 30, MoveMode.Tactical),
  step(138, 2, 94, 32, MoveMode.Tactical),
  step(164, 1, 70, 30, MoveMode.Tactical),
  step(184, 1, KOLNA_OBJECTIVE.x, KOLNA_OBJECTIVE.y + 6, MoveMode.Tactical),
];

interface Map {
  level: typeof STEPOVE;
  objective: { x: number; y: number };
  plans: Record<string, Step[]>;
}

const MAPS: Record<string, Map> = {
  stepove: {
    level: STEPOVE,
    objective: OBJECTIVE,
    plans: { frontal: FRONTAL, bounding: BOUNDING, ditch: DITCH },
  },
  kolna: {
    level: KOLNA,
    objective: KOLNA_OBJECTIVE,
    plans: { frontal: KOLNA_FRONTAL, flanks: KOLNA_FLANKS },
  },
};

const SEEDS = [1009, 2213, 4242, 7717, 9001];
const DURATION = 200;
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
  /**
   * How close the attack actually got to the objective, in metres.
   *
   * Survivors on their own stopped being a usable score once men started
   * refusing to finish a plan: a charge that breaks at eighty metres brings
   * more men home than one that presses on, and reads as the better plan.
   * Ground gained cannot be won by not going.
   */
  closest: number;
  /** Operators still on their feet within twenty-five metres of it at the end. */
  onTheObjective: number;
}

function play(map: Map, plan: Step[], seed: number): Result {
  const sim = new Sim(map.level, seed);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const players = sim.unitList.filter((u) => u.faction === Faction.Player);
  const startingAmmo = new Map(hostiles.map((h) => [h.id, h.ammoInMag]));
  const fired = new Set<number>();

  const r: Result = {
    operatorsUp: 0, defendersUp: 0, playerRounds: 0, aimedRounds: 0, blindRounds: 0,
    reachSeconds: 0, acquiredSeconds: 0, outOfRangeSeconds: 0, noLineSeconds: 0,
    underFire: 0, pinnedSeconds: 0, defendersWhoFired: 0,
    operatorsBroke: 0, defendersBroke: 0, won: 0, closest: Infinity, onTheObjective: 0,
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
    for (const p of players) {
      if (p.state !== UnitState.Active) continue;
      const d = dist(p.pos, sim.objective);
      if (d < r.closest) r.closest = d;
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
  r.onTheObjective = players.filter(
    (p) => p.state === UnitState.Active && dist(p.pos, sim.objective) < 25,
  ).length;
  if (!Number.isFinite(r.closest)) r.closest = Infinity;
  void startingAmmo;
  return r;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * A plan that orders a squad onto a wall is not a plan being measured, it is a
 * typo being measured. The order plumbing spirals out to the nearest ground a
 * body fits on, so the run still happens and the result is quietly wrong.
 */
function checkPlans(map: Map): void {
  const scene = createScene(map.level);
  for (const [name, plan] of Object.entries(map.plans)) {
    for (const s of plan) {
      if (!scene.walkable(s.x, s.y)) {
        console.warn(
          `  warning: ${name} sends squad ${s.squad} to ${s.x},${s.y} at ${s.t}s, ` +
          'which is inside something solid',
        );
      }
    }
  }
}

const mapName = process.argv[2] && MAPS[process.argv[2]] ? process.argv[2] : 'stepove';
const map = MAPS[mapName];
if (process.argv[2] && !MAPS[process.argv[2]]) {
  console.error(`no such map: ${process.argv[2]} (have ${Object.keys(MAPS).join(', ')})`);
  process.exit(1);
}
checkPlans(map);
const only = process.argv[3];
const names = only ? [only] : Object.keys(map.plans);
const totals = new Map<string, Result[]>();

for (const name of names) {
  const plan = map.plans[name];
  if (!plan) {
    console.error(`no such plan: ${name} (have ${Object.keys(map.plans).join(', ')})`);
    process.exit(1);
  }
  totals.set(name, SEEDS.map((seed) => play(map, plan, seed)));
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number, n = 5, digits = 1) => v.toFixed(digits).padStart(n);

const ROSTER = (() => {
  const sim = new Sim(map.level, SEEDS[0]);
  return {
    operators: sim.unitList.filter((u) => u.faction === Faction.Player).length,
    defenders: sim.unitList.filter((u) => u.faction === Faction.Hostile).length,
  };
})();

console.log(
  `${map.level.name}, ${SEEDS.length} seeds, ${DURATION}s each, every plan aiming at ` +
  `the objective. ${ROSTER.operators} operators, ${ROSTER.defenders} defenders.\n`,
);
console.log(
  `${pad('plan', 9)} ${pad('operators', 10)} ${pad('defenders', 10)} ` +
  `${pad('rounds P/H', 12)} ${pad('blind', 6)} ${pad('reach', 7)} ` +
  `${pad('acq', 6)} ${pad('underfire', 10)} ${pad('shooters', 9)} ${pad('broke P/H', 10)} ` +
  `${pad('closest', 8)} ${pad('on obj', 7)} won`,
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
  const closest = mean(runs.map((x) => x.closest));
  const onObj = mean(runs.map((x) => x.onTheObjective));
  console.log(
    `${pad(name, 9)} ${num(up, 4)}/${ROSTER.operators}   ` +
    `${num(def, 4)}/${ROSTER.defenders}   ` +
    `${num(pr, 4, 0)}/${num(hr, 4, 0)}   ${num(blind, 4, 0)}  ${num(reach, 5, 0)}s  ` +
    `${num(acq, 4, 0)}s  ${num(fire, 6)}s   ${num(shooters, 4)}/${ROSTER.defenders}   ` +
    `${num(brokeP, 4)}/${num(brokeH, 4)}  ${num(closest, 5)}m  ` +
    `${num(onObj, 4)}/${ROSTER.operators}  ` +
    `${won}/${runs.length}  ` +
    `| no shot: ${num(far, 4, 0)}s too far, ${num(blind2, 4, 0)}s no line`,
  );
}

const clever = totals.get('bounding') ?? totals.get('flanks');
const frontal = totals.get('frontal');
if (clever && frontal) {
  const gap = mean(clever.map((x) => x.operatorsUp)) - mean(frontal.map((x) => x.operatorsUp));
  const ground = mean(frontal.map((x) => x.closest)) - mean(clever.map((x) => x.closest));
  console.log(
    `\nskill gradient (the careful plan minus the charge): ${gap.toFixed(1)} operators, ` +
    `${ground.toFixed(0)}m of ground`,
  );
}
console.log(
  '\nreach = defender-seconds with a target in range and in view;' +
  ' acq = of those, actually acquired;' +
  '\nbroke = men who lost their nerve at some point, counted one at a time;' +
  '\nclosest = how near the objective anybody still standing actually got.',
);
