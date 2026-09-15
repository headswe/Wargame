import { vec } from './math.ts';
import { Fabric } from './world/geometry.ts';
import {
  type LevelData, type LevelDef, type StructureOp, createScene, defineLevel,
} from './world/level-data.ts';
import { Surface } from './world/terrain.ts';
import { KOLNA_DATA } from './maps/kolna.ts';

export type { LevelData, LevelDef };
export { createScene, defineLevel };

/**
 * A village house: four walls, a door and windows on the face you approach.
 *
 * Openings are placed in metres along a named wall, so "the door is two thirds
 * of the way along the north face" is what gets written down. Addressing them
 * by a fraction of the whole perimeter, as this used to, meant that widening a
 * house moved every window in it and that placing one was arithmetic.
 */
function house(x: number, y: number, w: number, d: number, angle: number): StructureOp {
  return {
    op: 'building',
    rect: { at: vec(x, y), width: w, depth: d, angle },
    openings: [
      // The face they will come at, which is the one worth fighting from.
      { side: 2, at: w * 0.48, width: 1.6, kind: 'door' },
      { side: 2, at: w * 0.12, width: 1.4, kind: 'window' },
      { side: 2, at: w * 0.88, width: 1.4, kind: 'window' },
      // And one at the back, so a house is not a one-way firing position.
      { side: 0, at: w * 0.48, width: 1.4, kind: 'window' },
    ],
  };
}

/**
 * "Stepove" — a village astride a road junction, 170 by 130 metres.
 *
 * The ground does the teaching. Three fireteams start in the south with eighty
 * metres of open field in front of them, rising gently to a low ridge that
 * hides everything beyond it until you are on top of it. A drainage ditch cuts
 * across at an angle, deep enough to crouch in and disappear. A machine gun in
 * the village covers the middle of it all.
 *
 * There is no route that avoids the open — only routes that cross it in
 * shorter pieces, using ground that is genuinely lower than the ground beside
 * it. That distinction is the entire reason for a heightfield.
 */
export const STEPOVE_DATA: LevelData = {
  id: 'stepove',
  name: 'Stepove',
  brief:
    'Client needs the village school cleared and held before dark. Two dozen ' +
    'irregulars with belt-feds covering the open ground, and eighty metres of ploughed ' +
    'field between you and the first building. Use the ditch.',
  size: { width: 170, height: 130 },

  terrain: [
    // Gently rolling, with a rise the village sits on and a low ridge across
    // the approach that makes dead ground behind it.
    { op: 'rolling', amplitude: 1.5, wavelength: 38, seed: 11 },
    { op: 'mound', at: vec(92, 40), radius: 70, peak: 4.5 },
    { op: 'bank', path: [vec(6, 96), vec(70, 92), vec(164, 97)], width: 24, rise: 3.3 },
    { op: 'paint', min: vec(0, 82), max: vec(170, 130), surface: Surface.Crop },
    { op: 'paint', min: vec(0, 20), max: vec(170, 70), surface: Surface.Grass },

    // The ditch: the one piece of ground you can cross the open inside.
    {
      op: 'cut', path: [vec(14, 84), vec(78, 78), vec(152, 74)],
      width: 6.5, depth: 1.7, surface: Surface.Mud,
    },

    // The road, riding over the rise rather than cutting through it.
    { op: 'road', path: [vec(2, 64), vec(58, 60), vec(120, 58), vec(168, 55)], width: 7 },
  ],

  structures: [
    // Vegetation: the treeline they form up behind, and field hedges.
    { op: 'hedgerow', path: [vec(10, 118), vec(56, 116), vec(92, 119)], radius: 1.7 },
    { op: 'hedgerow', path: [vec(104, 117), vec(158, 115)], radius: 1.7 },
    { op: 'hedgerow', path: [vec(8, 103), vec(60, 99), vec(88, 103)] },
    { op: 'hedgerow', path: [vec(110, 97), vec(150, 101)] },
    { op: 'hedgerow', path: [vec(24, 70), vec(58, 68)], radius: 1.2 },

    // The village.
    house(34, 48, 15, 11, -0.22),
    house(61, 43, 13, 10, 0.15),
    house(90, 50, 17, 12, -0.08),
    house(122, 45, 14, 11, 0.28),
    house(148, 52, 12, 10, -0.31),
    house(46, 29, 13, 11, 0.19),
    house(130, 28, 15, 11, -0.17),

    // A walled yard with one way in.
    {
      op: 'revetment',
      path: [vec(68, 26), vec(86, 24), vec(88, 38), vec(70, 40), vec(68, 26)],
      fabric: Fabric.Brick, top: 2.2, thickness: 0.35,
      openings: [{ side: 3, at: 'centre', width: 2.4, kind: 'door' }],
    },
    { op: 'revetment', path: [vec(72, 30), vec(82, 29)] },

    // The school: the objective, and the one building with a real interior.
    // Three rooms, each with its own doorway, so taking it is a sequence of
    // decisions rather than one threshold.
    {
      op: 'building',
      rect: { at: vec(94, 14), width: 34, depth: 16, angle: 0.06 },
      fabric: Fabric.Concrete, wallTop: 3.1, thickness: 0.45,
      openings: [
        { side: 2, at: 13.6, width: 2.0, kind: 'door' },
        { side: 0, at: 12.2, width: 2.0, kind: 'door' },
        { side: 2, at: 2.7, width: 1.5, kind: 'window' },
        { side: 2, at: 24.5, width: 1.5, kind: 'window' },
        { side: 0, at: 20.4, width: 1.5, kind: 'window' },
      ],
      partitions: [
        { a: vec(84, 6), b: vec(83, 22), openings: [{ at: 'centre', width: 1.6, kind: 'door' }] },
        { a: vec(105, 7), b: vec(104, 23), openings: [{ at: 4, width: 1.6, kind: 'door' }] },
      ],
    },

    // Sandbagged gun position covering the field, set clear of the house
    // behind it: a revetment laid across a doorway seals the building.
    { op: 'revetment', path: [vec(98, 61), vec(108, 60)] },

    // Wrecks on the road.
    { op: 'obstacle', at: vec(48, 62), radius: 2.4 },
    { op: 'obstacle', at: vec(116, 58), radius: 2.8 },
  ],

  spawns: {
    teams: [
      [vec(40, 122), vec(41.6, 122), vec(43.2, 122), vec(44.8, 122)],
      [vec(84, 122), vec(85.6, 122), vec(87.2, 122), vec(88.8, 122)],
      [vec(128, 122), vec(129.6, 122), vec(131.2, 122), vec(132.8, 122)],
    ],
    objectives: [vec(94, 14)],
    // Twenty-four, in three layers, because a garrison you can finish off is a
    // garrison the mission is over without. Fourteen men over 22,000 square
    // metres was one per forty metres square: a crust you shot through once and
    // then walked about in an empty village. The win condition already asks you
    // to break the whole defence before you can stand on the objective, so the
    // count is what decides whether that is a fight or a formality.
    enemies: [
      // The screen: what makes the open ground open. Two guns and the men
      // keeping them company, far enough forward to be fought for separately.
      { pos: vec(103, 63), kind: 'gunner' },
      { pos: vec(120, 68), kind: 'gunner' },
      { pos: vec(88, 66), kind: 'rifle' },
      { pos: vec(140, 62), kind: 'rifle' },
      { pos: vec(35, 51), kind: 'rifle' },
      { pos: vec(148, 55), kind: 'rifle' },

      // The village edge, where the approach stops being a walk. The third gun
      // covers the middle, which is the one piece of ground every plan must
      // eventually cross.
      { pos: vec(95, 45), kind: 'gunner' },
      { pos: vec(62, 46), kind: 'rifle' },
      { pos: vec(123, 48), kind: 'rifle' },
      { pos: vec(110, 42), kind: 'rifle' },
      { pos: vec(57, 42), kind: 'rifle' },
      { pos: vec(80, 35), kind: 'rifle' },
      { pos: vec(76, 32), kind: 'rifle' },
      { pos: vec(47, 32), kind: 'rifle' },
      { pos: vec(131, 31), kind: 'rifle' },
      { pos: vec(63, 30), kind: 'rifle' },

      // Set back among the houses with the length of the street to work with.
      // A marksman forward is a marksman inside his own minimum useful range.
      { pos: vec(100, 30), kind: 'marksman' },
      { pos: vec(60, 20), kind: 'marksman' },

      // The school and what is around it. These are the men you have to break
      // last, after the approach has already cost you.
      { pos: vec(88, 18), kind: 'rifle' },
      { pos: vec(98, 18), kind: 'rifle' },
      { pos: vec(112, 16), kind: 'rifle' },
      { pos: vec(72, 11), kind: 'rifle' },
      { pos: vec(92, 23), kind: 'rifle' },
      { pos: vec(120, 22), kind: 'rifle' },
    ],
  },
};

/**
 * Everything the game ships, as data.
 *
 * The catalogue is the data rather than the built levels, because everything
 * that wants to do something with a level other than play it — the editor, the
 * report tool, whatever generates contracts later — wants the description, not
 * a closure that paints one.
 */
export const LEVEL_DATA: LevelData[] = [STEPOVE_DATA, KOLNA_DATA];

export const LEVELS: LevelDef[] = LEVEL_DATA.map(defineLevel);

export const STEPOVE: LevelDef = LEVELS[0];
export const KOLNA: LevelDef = LEVELS[1];
export { KOLNA_DATA };
