import { vec } from '../math.ts';
import { Fabric } from '../world/geometry.ts';
import type { LevelData, StructureOp } from '../world/level-data.ts';
import { Surface } from '../world/terrain.ts';

/**
 * "Kolna" — a grain depot behind a wall, 140 by 120 metres.
 *
 * Stepove is eighty metres of ploughed field and one decision about how to
 * cross it. This is the opposite problem, and that is the reason for it:
 * everything happens inside a walled yard at twenty metres, among sheds with
 * doors at both ends, and the question is not how to cross open ground but
 * which way round a building to go and what is waiting there.
 *
 * It exists to find out whether the systems generalise. Suppression, cover,
 * nerve and the navmesh were all tuned against a long approach; a level whose
 * longest interior sightline is thirty metres asks them different questions,
 * and what `npm run level-report` prints is how we find out whether they have
 * good answers.
 */

/** The yard is the level. Everything else is arranged around getting into it. */
const YARD = { west: 24, east: 116, south: 10, north: 72 };

/**
 * A slit cut through a perimeter wall at firing height.
 *
 * Without these the wall blinds its own defence: it stops them being seen and
 * stops them seeing, and the whole approach becomes a free walk up to the gate.
 * A loophole is a window with the band lowered to where a crouching man's eye
 * is — the sill below it still stops a body, so it is a place to shoot from and
 * not a way in.
 */
function loophole(at: number) {
  return { at, width: 0.9, kind: 'window' as const, sill: 0.72, head: 1.5 };
}

/** A shed: doors at both ends, because a building with one door is a trap. */
function shed(
  x: number, y: number, width: number, depth: number, angle: number,
  partitions: { at: number; door: number }[] = [],
): StructureOp {
  const half = depth / 2;
  return {
    op: 'building',
    name: 'shed',
    rect: { at: vec(x, y), width, depth, angle },
    fabric: Fabric.Metal,
    wallTop: 4.2,
    thickness: 0.3,
    openings: [
      { side: 2, at: width * 0.3, width: 2.6, kind: 'door' },
      { side: 2, at: width * 0.78, width: 1.6, kind: 'window' },
      { side: 0, at: width * 0.66, width: 2.6, kind: 'door' },
      { side: 0, at: width * 0.22, width: 1.6, kind: 'window' },
      { side: 1, at: 'centre', width: 1.6, kind: 'window' },
      { side: 3, at: 'centre', width: 1.6, kind: 'window' },
    ],
    // Bays down the length, each with its own way through, so clearing one is a
    // sequence of thresholds rather than a single doorway.
    partitions: partitions.map(({ at, door }) => ({
      a: vec(x - width / 2 + at, y - half),
      b: vec(x - width / 2 + at, y + half),
      openings: [{ at: door, width: 1.6, kind: 'door' as const }],
    })),
  };
}

export const KOLNA_DATA: LevelData = {
  version: 1,
  id: 'kolna',
  name: 'Kolna Depot',
  brief:
    'The client wants the depot office and the ledgers in it. A walled yard, two ' +
    'grain sheds, and a dozen men who know the ground better than you do. There is ' +
    'no open field to cross here — every fight is at twenty metres, around a corner.',
  size: { width: 140, height: 104 },

  terrain: [
    { op: 'rolling', amplitude: 0.9, wavelength: 44, seed: 5 },
    { op: 'paint', min: vec(0, 0), max: vec(140, 104), surface: Surface.Grass },
    {
      op: 'paint', name: 'hardstanding',
      min: vec(YARD.west, YARD.south), max: vec(YARD.east, YARD.north), surface: Surface.Gravel,
    },
    { op: 'paint', name: 'the fields', min: vec(0, 78), max: vec(140, 104), surface: Surface.Crop },
    { op: 'mound', at: vec(70, 40), radius: 62, peak: 1.6 },

    // The approach: a drainage channel down the east side, which is the one way
    // to come at the wall without being watched doing it.
    {
      op: 'cut', name: 'drainage channel',
      path: [vec(132, 100), vec(126, 88), vec(124, 74), vec(126, 56)],
      width: 5.5, depth: 1.8, surface: Surface.Mud,
    },
    // And the haul road, which is the fast way and the obvious one.
    { op: 'road', name: 'haul road', path: [vec(70, 103), vec(70, 92), vec(68, 80), vec(70, 72)], width: 8 },
    { op: 'road', name: 'yard road', path: [vec(70, 72), vec(70, 56), vec(70, 30)], width: 7 },
  ],

  structures: [
    // --- the perimeter. Solid walls rather than revetments: a low wall you can
    //     see over is not a perimeter, it is a hurdle.
    {
      op: 'wall', name: 'north wall',
      a: vec(YARD.west, YARD.north), b: vec(YARD.east, YARD.north),
      fabric: Fabric.Concrete, top: 2.6, thickness: 0.4,
      openings: [
        { at: 46, width: 4.5, kind: 'door' },
        loophole(13), loophole(24), loophole(34),
        loophole(58), loophole(69), loophole(80),
      ],
    },
    {
      op: 'wall', name: 'east wall',
      a: vec(YARD.east, YARD.north), b: vec(YARD.east, YARD.south),
      fabric: Fabric.Concrete, top: 2.6, thickness: 0.4,
      openings: [{ at: 26, width: 3.5, kind: 'door' }, loophole(9), loophole(44)],
    },
    {
      op: 'wall', name: 'south wall',
      a: vec(YARD.east, YARD.south), b: vec(YARD.west, YARD.south),
      fabric: Fabric.Concrete, top: 2.6, thickness: 0.4,
      openings: [{ at: 60, width: 3, kind: 'door' }, loophole(20), loophole(76)],
    },
    {
      op: 'wall', name: 'west wall (breached)',
      a: vec(YARD.west, YARD.south), b: vec(YARD.west, YARD.north),
      fabric: Fabric.Concrete, top: 2.6, thickness: 0.4,
      // A section has come down. Somewhere the defence has to cover and would
      // rather not, which is what makes the west flank worth taking.
      openings: [{ at: 34, width: 7, kind: 'door' }, loophole(11), loophole(52)],
    },

    // --- the sheds
    shed(48, 52, 34, 16, 0, [{ at: 12, door: 4 }, { at: 23, door: 12 }]),
    shed(94, 48, 26, 14, 0.04, [{ at: 13, door: 10 }]),

    // --- the office: the objective, three rooms deep
    {
      op: 'building', name: 'depot office',
      rect: { at: vec(66, 20), width: 30, depth: 15, angle: -0.03 },
      fabric: Fabric.Brick, wallTop: 3.0, thickness: 0.35,
      openings: [
        { side: 2, at: 9, width: 1.2, kind: 'door' },
        { side: 2, at: 19, width: 1.4, kind: 'window' },
        { side: 2, at: 25, width: 1.4, kind: 'window' },
        { side: 0, at: 15, width: 1.2, kind: 'door' },
        { side: 0, at: 5, width: 1.4, kind: 'window' },
        { side: 1, at: 'centre', width: 1.4, kind: 'window' },
        { side: 3, at: 'centre', width: 1.4, kind: 'window' },
      ],
      partitions: [
        { a: vec(60, 12), b: vec(60, 28), openings: [{ at: 11, width: 1.1, kind: 'door' }] },
        { a: vec(72, 12), b: vec(72, 28), openings: [{ at: 4, width: 1.1, kind: 'door' }] },
      ],
    },

    // --- the yard furniture that makes twenty metres worth fighting over
    { op: 'obstacle', name: 'silo', at: vec(80, 62), radius: 4.2, top: 8, fabric: Fabric.Metal },
    { op: 'obstacle', name: 'silo', at: vec(89, 62), radius: 4.2, top: 8, fabric: Fabric.Metal },
    { op: 'obstacle', name: 'tank', at: vec(34, 30), radius: 3.4, top: 3.6, fabric: Fabric.Metal },
    { op: 'obstacle', name: 'wreck', at: vec(102, 30), radius: 2.6, top: 1.9, fabric: Fabric.Metal },
    { op: 'obstacle', name: 'wreck', at: vec(52, 68), radius: 2.4, top: 1.9, fabric: Fabric.Metal },

    // Loading bays: low cover in the open middle, so crossing the yard is a
    // bound between pieces of it rather than a sprint or nothing.
    {
      op: 'revetment', name: 'loading bay', path: [vec(30, 62), vec(44, 62)],
      fabric: Fabric.Concrete, top: 1.05, thickness: 0.9,
    },
    {
      op: 'revetment', name: 'loading bay', path: [vec(58, 34), vec(74, 34)],
      fabric: Fabric.Concrete, top: 1.05, thickness: 0.9,
    },
    { op: 'revetment', name: 'sandbags', path: [vec(62, 66), vec(76, 67)] },
    { op: 'revetment', name: 'sandbags', path: [vec(98, 22), vec(108, 24)] },
    {
      op: 'revetment', name: 'timber stack', path: [vec(20, 46), vec(20, 58)],
      fabric: Fabric.Timber, top: 1.3, thickness: 1.2,
    },

    // --- forward of the wall.
    //
    // A loophole covers about twenty-five degrees, so lining the wall with them
    // would take a dozen men to contest the approach and would turn a perimeter
    // into a firing line. One post out in front does it with two, and turns the
    // approach into something you have to deal with rather than walk across —
    // which is also a better first problem than the gate.
    {
      op: 'revetment', name: 'forward post',
      path: [vec(62, 83), vec(72, 82), vec(78, 85)],
      fabric: Fabric.Sandbag, top: 1.05, thickness: 1.1,
    },
    {
      op: 'revetment', name: 'channel post',
      path: [vec(113, 80), vec(120, 78)],
      fabric: Fabric.Sandbag, top: 1.05, thickness: 1.1,
    },

    // --- outside: what the assault forms up behind
    { op: 'hedgerow', path: [vec(6, 88), vec(48, 86), vec(60, 89)], radius: 1.7 },
    { op: 'hedgerow', path: [vec(82, 89), vec(120, 86), vec(136, 90)], radius: 1.7 },
    { op: 'hedgerow', path: [vec(10, 77), vec(22, 75)], radius: 1.4 },
    { op: 'hedgerow', path: [vec(4, 60), vec(6, 40), vec(4, 22)], radius: 1.5 },
  ],

  spawns: {
    teams: [
      [vec(30, 97), vec(31.6, 97), vec(33.2, 97), vec(34.8, 97)],
      [vec(68, 97), vec(69.6, 97), vec(71.2, 97), vec(72.8, 97)],
      [vec(106, 97), vec(107.6, 97), vec(109.2, 97), vec(110.8, 97)],
    ],
    objectives: [vec(66, 20)],
    // Eleven, not fourteen. Kolna's positions are sited to see something —
    // mean reach is better than Stepove's — so a man here is worth more than a
    // man there, and matching Stepove's headcount made the depot four times
    // the problem the village is.
    enemies: [
      // The forward post: the first thing in the way, and the reason the
      // approach is not a free walk.
      { pos: vec(69, 80), heavy: true },
      { pos: vec(76, 79), heavy: false },
      { pos: vec(117, 76), heavy: false },
      // The gate, which is where anybody sensible expects you.
      // Set to one side of the gateway rather than behind the wall beside it,
      // so the belt-fed actually looks through the gap it is there to hold.
      { pos: vec(73, 63), heavy: true },
      { pos: vec(65, 63), heavy: false },
      // Behind loopholes, which is the only reason the wall does not blind them.
      // Two of them, not six: a loophole covers about twenty-five degrees, so
      // lining the wall would take the whole garrison to contest one approach.
      { pos: vec(37, 70), heavy: false },
      { pos: vec(93, 70), heavy: true },
      { pos: vec(114, 63), heavy: false },
      // In the sheds, at the doors rather than in the corners.
      { pos: vec(40, 58), heavy: false },
      { pos: vec(60, 46), heavy: false },
      // The yard itself.
      // And the office, which is the last room and should feel like it.
      { pos: vec(66, 22), heavy: false },
    ],
  },
};
