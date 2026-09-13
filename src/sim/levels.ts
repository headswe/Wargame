import { vec } from './math.ts';
import { LevelCanvas } from './levelgen.ts';
import { Material, Tile, World, parseLevel } from './world.ts';

/**
 * Levels are ASCII. Legend:
 *   #  wall (blocks movement, sight and bullets)
 *   o  low cover (blocks movement, shoot over it, good protection)
 *   "  firing port / window — a wall you can shoot through but not walk through
 *   +  doorway (walkable gap — a funnel, so a natural killzone)
 *   .  open ground
 *   1/2/3  spawn for fireteams ALPHA / BRAVO / CHARLIE
 *   e  hostile   E  hostile with the belt-fed
 *   X  objective
 */

export interface LevelDef {
  id: string;
  name: string;
  brief: string;
  /** ASCII floorplan — unbeatable for tight interiors you want to read in a diff. */
  rows?: string[];
  /** Painted from primitives — for anything big enough that ASCII stops scaling. */
  size?: { width: number; height: number };
  paint?: (c: LevelCanvas) => void;
}

/** Build a level's world, whichever way it was authored. */
export function createWorld(level: LevelDef): World {
  if (level.rows) return parseLevel(level.rows);
  if (level.paint && level.size) {
    const canvas = new LevelCanvas(level.size.width, level.size.height, 20260913);
    level.paint(canvas);
    return canvas.toWorld();
  }
  throw new Error(`level ${level.id} has neither rows nor a paint function`);
}

/**
 * "Cold Harbour" — a walled compound.
 *
 * The shape is the lesson. A wide courtyard is covered by a machine gun behind
 * sandbags, with the office block's firing ports looking down on all of it.
 * Walk in the main gate and you lose people. The containers down both flanks
 * and the two breaches in the perimeter are the answer: pin the gun with a SAW
 * from one side, bound a team up the other.
 */
export const COLD_HARBOUR: LevelDef = {
  id: 'cold-harbour',
  name: 'Cold Harbour',
  brief:
    'Client wants the compound office cleared and held. Ten or so guards, ' +
    'at least one belt-fed covering the courtyard. Do not walk in the front gate.',
  rows: [
    '##############################################################',
    '#............................................................#',
    '#.........##########################################.........#',
    '#.........#...........#.............#..............#.........#',
    '#........."..e........#....oo.......#.......e......#.........#',
    '#.........#...........#.....X.......#..............#.........#',
    '#.........+...oo......#.............#.....oo.......+.........#',
    '#.........#...........+.............+..............#.........#',
    '#.........#...........#.............#..............".........#',
    '#.........#........e..#....e........#.e.........e..#.........#',
    '#.........##"##+###"###"###"##+###"###"###"##+###"##.........#',
    '#............................................................#',
    '#....##....................ooooo.....................##......#',
    '#....##.......................E......................##......#',
    '#....##..............................................##......#',
    '#..........####...........................####...............#',
    '#..........####...........................####...............#',
    '#.......o..####..........o....o...........####..o............#',
    '#..........####...........................####...............#',
    '#............................................................#',
    '#.................o..................o.......................#',
    '#......####..............................####................#',
    '#......####e...o....................o....####e...............#',
    '#......####..............................####................#',
    '#............................................................#',
    '#..........e.................................................#',
    '#..........o..............oo.oo...............o..............#',
    '#.........................o...o..............................#',
    '#########..######################+###########..###############',
    '#............................................................#',
    '#.......####.....o.................o.........####............#',
    '#............................................................#',
    '#...........oo...................oo..........................#',
    '#............................................................#',
    '#......1111..............2222..............3333..............#',
    '#............................................................#',
    '#............................................................#',
    '##############################################################',
  ],
};

/**
 * "Stepove" — a village astride a road junction, 170 by 130 metres.
 *
 * The point of this map is the ground between things. Three fireteams start in
 * the south with roughly eighty metres of open field between them and the
 * village, broken only by a treeline, two hedgerows and a drainage ditch cut
 * across the fields at an angle. A machine gun in the village covers the
 * middle of it. There is no route that avoids the open — only routes that
 * cross it in shorter pieces, which is the whole game.
 *
 * Nothing here runs at a right angle unless a builder would have made it so.
 */
export const STEPOVE: LevelDef = {
  id: 'stepove',
  name: 'Stepove',
  brief:
    'Client needs the village school cleared and held before dark. Fourteen or so ' +
    'irregulars, a belt-fed covering the open ground, and eighty metres of ploughed ' +
    'field between you and the first building. Bound it in pieces.',
  size: { width: 170, height: 130 },
  paint: (c) => {
    c.of(Material.Concrete).border(2);

    // Ploughed fields and a track running through the middle of them.
    c.of(Material.Crop).rect(2, 78, 166, 44, Tile.Floor);
    c.of(Material.Dirt).rect(2, 2, 166, 76, Tile.Floor);

    // --- the start line: a broken treeline the teams form up behind
    c.of(Material.Hedge).polyline([vec(12, 117), vec(58, 115), vec(96, 118), vec(158, 114)], 2.2, Tile.Low);
    c.of(Material.Crop).disc(vec(62, 116), 4, Tile.Floor);
    c.disc(vec(120, 116), 4, Tile.Floor);

    c.team(0, vec(42, 123));
    c.team(1, vec(86, 123));
    c.team(2, vec(130, 123));

    // --- first field: two hedgerows, neither of them straight or square
    c.of(Material.Hedge).polyline([vec(8, 104), vec(62, 98), vec(94, 103)], 1.8, Tile.Low);
    c.polyline([vec(108, 96), vec(140, 101), vec(162, 97)], 1.8, Tile.Low);
    c.of(Material.Crop).scatter(10, 100, 150, 14, 16, Tile.Low, 1.6);

    // --- the drainage ditch: the one good bound position in the middle
    c.of(Material.Dirt).polyline([vec(16, 93), vec(78, 86), vec(150, 83)], 2.6, Tile.Low);

    // --- the road, running slightly off true, with its verge fence and wrecks
    c.of(Material.Road).line(vec(4, 76), vec(166, 68), 6, Tile.Floor);
    c.of(Material.Timber).polyline([vec(10, 71), vec(52, 69), vec(78, 67)], 1.2, Tile.Low);
    c.of(Material.Rubble).disc(vec(46, 74), 2.6, Tile.Wall);
    c.disc(vec(113, 71), 3.0, Tile.Wall);

    // --- the village itself, houses set at whatever angle the plot allowed
    const houses: [number, number, number, number, number][] = [
      [32, 58, 15, 11, -0.22],
      [59, 52, 13, 10, 0.15],
      [88, 60, 17, 12, -0.08],
      [121, 55, 14, 11, 0.28],
      [148, 62, 12, 10, -0.31],
      [44, 37, 13, 11, 0.19],
      [129, 36, 15, 11, -0.17],
    ];
    c.of(Material.Brick);
    for (const [x, y, w, h, angle] of houses) {
      c.building(vec(x, y), w, h, angle, {
        doors: [0.62],
        windows: [0.55, 0.71, 0.12, 0.88],
      });
    }

    // --- a walled yard with one way in
    c.of(Material.Brick).polyline(
      [vec(66, 33), vec(84, 31), vec(87, 46), vec(68, 48), vec(66, 33)],
      1.4,
      Tile.Wall,
    );
    c.of(Material.Dirt).disc(vec(77, 47), 2.2, Tile.Floor);
    c.of(Material.Sandbag).scatter(68, 34, 17, 12, 6, Tile.Low, 1.5);

    // --- the school: the objective, and a real interior to fight through
    c.of(Material.Concrete).building(vec(92, 22), 34, 17, 0.06, {
      doors: [0.6, 0.1],
      windows: [0.52, 0.58, 0.66, 0.72, 0.04, 0.16],
      wallThickness: 1.6,
    });
    // Two internal partitions, each with a gap, making three rooms.
    c.line(vec(82, 14), vec(81, 30), 1.2, Tile.Wall);
    c.disc(vec(81.5, 25), 1.6, Tile.Floor);
    c.line(vec(103, 15), vec(102, 31), 1.2, Tile.Wall);
    c.disc(vec(102.5, 26), 1.6, Tile.Floor);
    c.objective(vec(92, 22));

    // --- who is holding it
    c.enemy(vec(88, 64), true); // the belt-fed, covering the open ground
    c.enemy(vec(33, 61));
    c.enemy(vec(60, 55));
    c.enemy(vec(122, 58));
    c.enemy(vec(148, 65));
    c.enemy(vec(45, 40));
    c.enemy(vec(129, 39));
    c.enemy(vec(74, 40));
    c.enemy(vec(79, 43));
    c.enemy(vec(86, 26));
    c.enemy(vec(96, 26));
    c.enemy(vec(110, 24));
    c.enemy(vec(70, 19));
    c.enemy(vec(118, 78));
  },
};

export const LEVELS: LevelDef[] = [STEPOVE, COLD_HARBOUR];
