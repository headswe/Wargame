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
import { Sim } from '../src/sim/sim.ts';
import { createScene } from '../src/sim/world/level-data.ts';
import { type PlannedAssault, type Step, MAPS } from '../src/sim/plans.ts';
import { Faction, MoveMode, Nerve, Posture, UnitState } from '../src/sim/units.ts';
import { dist, vec } from '../src/sim/math.ts';
import { hitChance } from '../src/sim/combat.ts';

/**
 * Five is enough to see a big effect and nowhere near enough to see a small
 * one. `BALANCE_SEEDS=20` when a change looks like it moved something by a man
 * or two, which is inside the noise at this count.
 */
const SEEDS = (() => {
  const want = Number(process.env.BALANCE_SEEDS ?? 5);
  const pool = [1009, 2213, 4242, 7717, 9001, 131, 577, 1223, 3299, 6151,
    77, 401, 929, 1847, 2711, 5003, 8191, 104729, 15485, 32452];
  return pool.slice(0, Math.max(1, Math.min(pool.length, want)));
})();

/**
 * How long each run is watched for.
 *
 * A control, not a rule. The game has no clock and nothing in it cares about
 * this number; its whole job is to be identical across plans and seeds so that
 * survivors, ground gained and rounds fired can be compared at all.
 *
 * There used to be a "won" column beside the others, counting runs that
 * finished inside it. That was a mistake worth leaving a note about: it turned
 * an arbitrary stopping point into a pass mark, read 0/5 for every plan on both
 * maps — so it separated nothing, which is the one job a column here has — and
 * invited exactly the conclusion it got, that the missions lacked shape.
 * Where a plan has got to by a fixed moment is a real comparison. Whether it
 * had finished by one is not.
 */
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

function play(map: PlannedAssault, plan: Step[], seed: number): Result {
  const sim = new Sim(map.level, seed);
  const hostiles = sim.unitList.filter((u) => u.faction === Faction.Hostile);
  const players = sim.unitList.filter((u) => u.faction === Faction.Player);
  const startingAmmo = new Map(hostiles.map((h) => [h.id, h.ammoInMag]));
  const fired = new Set<number>();

  const r: Result = {
    operatorsUp: 0, defendersUp: 0, playerRounds: 0, aimedRounds: 0, blindRounds: 0,
    reachSeconds: 0, acquiredSeconds: 0, outOfRangeSeconds: 0, noLineSeconds: 0,
    underFire: 0, pinnedSeconds: 0, defendersWhoFired: 0,
    operatorsBroke: 0, defendersBroke: 0, closest: Infinity, onTheObjective: 0,
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
function checkPlans(map: PlannedAssault): void {
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
  `${pad('closest', 8)} ${pad('on obj', 7)}`,
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
  const closest = mean(runs.map((x) => x.closest));
  const onObj = mean(runs.map((x) => x.onTheObjective));
  console.log(
    `${pad(name, 9)} ${num(up, 4)}/${ROSTER.operators}   ` +
    `${num(def, 4)}/${ROSTER.defenders}   ` +
    `${num(pr, 4, 0)}/${num(hr, 4, 0)}   ${num(blind, 4, 0)}  ${num(reach, 5, 0)}s  ` +
    `${num(acq, 4, 0)}s  ${num(fire, 6)}s   ${num(shooters, 4)}/${ROSTER.defenders}   ` +
    `${num(brokeP, 4)}/${num(brokeH, 4)}  ${num(closest, 5)}m  ` +
    `${num(onObj, 4)}/${ROSTER.operators}  ` +
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
