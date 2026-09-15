import { MoveMode } from './units.ts';
import { KOLNA, STEPOVE } from './levels.ts';
import type { LevelDef } from './world/level-data.ts';

/**
 * Scripted assaults, written down once and used twice.
 *
 * These began as fixtures for the balance harness: dumb, fixed sequences of
 * waypoints whose whole virtue is that they never change, so that when a number
 * moves it is the game that moved and not the plan. That virtue is why they are
 * still here rather than being replaced by an attacking AI — a measurement
 * taken against a moving instrument tells you nothing.
 *
 * But the game can run them too, and should: a whole run of balance figures
 * describing assaults nobody has ever watched is a strange way to build a game.
 * Spectating one plays exactly the script the harness scores, so "the careful
 * plan leaves 9.4 of 12 standing" stops being a number and becomes something
 * you can sit and watch go wrong.
 */

export interface Step {
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
  step(0, 0, 60, 122, MoveMode.Tactical),
  step(0, 1, 70, 122, MoveMode.Tactical),
  step(0, 2, 80, 122, MoveMode.Tactical),
  step(22, 0, 62, 100, MoveMode.Sprint),
  step(22, 1, 70, 100, MoveMode.Sprint),
  step(22, 2, 78, 100, MoveMode.Sprint),
  step(52, 0, 62, 84, MoveMode.Sprint),
  step(52, 1, 70, 84, MoveMode.Sprint),
  step(52, 2, 82, 88, MoveMode.Sprint),
  step(84, 0, 60, 62, MoveMode.Sprint),
  step(84, 1, 70, 62, MoveMode.Sprint),
  step(84, 2, 76, 58, MoveMode.Sprint),
  step(120, 0, 58, 40, MoveMode.Sprint),
  step(120, 1, 70, 40, MoveMode.Sprint),
  step(120, 2, 80, 40, MoveMode.Sprint),
  step(158, 0, 58, 24, MoveMode.Sprint),
  step(158, 1, KOLNA_OBJECTIVE.x, KOLNA_OBJECTIVE.y + 6, MoveMode.Sprint),
  step(158, 2, 76, 24, MoveMode.Sprint),
];

/** Base of fire on the rise, both flanks round the outside of the wall. */
const KOLNA_FLANKS: Step[] = [
  step(0, 1, 70, 120, MoveMode.Tactical),
  step(4, 0, 24, 120, MoveMode.Tactical),
  step(4, 2, 130, 122, MoveMode.Tactical),
  step(24, 0, 16, 96, MoveMode.Tactical),
  step(24, 2, 133, 106, MoveMode.Tactical),
  step(46, 1, 70, 108, MoveMode.Tactical),
  step(68, 0, 16, 64, MoveMode.Tactical),
  step(68, 2, 128, 82, MoveMode.Tactical),
  step(94, 0, 18, 46, MoveMode.Tactical),
  step(94, 2, 122, 52, MoveMode.Tactical),
  step(118, 0, 28, 40, MoveMode.Tactical),
  step(118, 2, 108, 46, MoveMode.Tactical),
  step(142, 1, 70, 62, MoveMode.Tactical),
  step(162, 0, 42, 30, MoveMode.Tactical),
  step(162, 2, 94, 32, MoveMode.Tactical),
  step(182, 1, KOLNA_OBJECTIVE.x, KOLNA_OBJECTIVE.y + 6, MoveMode.Tactical),
];

export interface PlannedAssault {
  level: LevelDef;
  objective: { x: number; y: number };
  plans: Record<string, Step[]>;
}

export const MAPS: Record<string, PlannedAssault> = {
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

