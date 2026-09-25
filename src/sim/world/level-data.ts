import type { Vec2 } from '../math.ts';
import { type Opening, type WallSpec, building, hedgerow, obstacle, rect, revetment, wall } from './builder.ts';

export type { Opening, WallSpec };
import type { Fabric } from './geometry.ts';
import { Scene } from './scene.ts';
import type { Surface } from './terrain.ts';

/**
 * A level as data rather than as code.
 *
 * Levels used to be a function handed a Scene, free to call anything. That is
 * the most expressive thing a level could possibly be and the least useful: it
 * cannot be saved, diffed, generated, handed to an editor, or checked before it
 * runs. Every one of those is something this game needs — contracts that
 * parameterise a map, an editor that writes one back out, a second designer who
 * is not also a TypeScript programmer.
 *
 * So a level is a list of operations, in order, each of which is a plain object
 * that survives a round trip through JSON. Nothing here is clever: the point is
 * precisely that it is boring enough to be written by something other than a
 * person.
 */

/**
 * Bumped whenever the shape of a saved level changes.
 *
 * Levels outlive the code that wrote them the moment anyone saves one, so a
 * file says which format it is and `migrate` brings old ones forward. Refusing
 * to load somebody's level because a field was renamed is how an editor loses
 * a user's afternoon.
 */
export const LEVEL_FORMAT = 2;

/**
 * What a defender is, rather than merely whether he is belt-fed.
 *
 * A garrison of two kinds reads as two kinds however many men are in it, and
 * the distinction that matters to an attacker is not "big gun / small gun" but
 * what each man punishes: the gunner punishes crossing open ground, the
 * marksman punishes standing still at range, the rifleman punishes being close.
 * Three is enough for a position to have a shape you can read and take apart in
 * an order that makes sense.
 */
export type DefenderKind = 'rifle' | 'gunner' | 'marksman';

export interface EnemySpawn {
  pos: Vec2;
  kind: DefenderKind;
}

/** Fields every operation carries, so an editor can track one across edits. */
export interface OpMeta {
  /** Stable across saves. Assigned on load when a hand-written level omits it. */
  id?: string;
  /** What the author calls it in the outline. */
  name?: string;
  /** Hidden in the editor; still built. */
  muted?: boolean;
}

export interface RectSpec {
  at: Vec2;
  width: number;
  depth: number;
  angle?: number;
}

export type TerrainOp = OpMeta & (
  /** A whole surface from a coarse control grid. What an editor writes. */
  | {
    op: 'heightmap';
    cols: number;
    rows: number;
    heights: number[];
    scale?: number;
    base?: number;
    blend?: 'set' | 'add';
  }
  /** Gentle noise, for ground that is not flat but is not making a point. */
  | { op: 'rolling'; amplitude: number; wavelength: number; seed?: number }
  | { op: 'mound'; at: Vec2; radius: number; peak: number }
  | { op: 'bank'; path: Vec2[]; width: number; rise: number; surface?: Surface; curve?: boolean }
  | { op: 'cut'; path: Vec2[]; width: number; depth: number; surface?: Surface; curve?: boolean }
  | { op: 'road'; path: Vec2[]; width: number; surface?: Surface; curve?: boolean }
  | { op: 'paint'; min: Vec2; max: Vec2; surface: Surface }
  /**
   * Painted ground, run-length encoded.
   *
   * Stored as flat [value, count, value, count, ...] because a brushed map is
   * overwhelmingly "no opinion" and a plain array of ten thousand 255s is
   * forty kilobytes of nothing in every saved file.
   */
  | { op: 'surfacemap'; cols: number; rows: number; runs: number[] }
  | { op: 'crater'; at: Vec2; radius: number; depth: number });

export type StructureOp = OpMeta & (
  | {
    op: 'building';
    /** Either an explicit polygon, or a rectangle. Exactly one of the two. */
    footprint?: Vec2[];
    rect?: RectSpec;
    fabric?: Fabric;
    wallTop?: number;
    thickness?: number;
    openings?: (Opening & { side: number })[];
    partitions?: WallSpec[];
    /** Level ground inside, and something underfoot. Default on. */
    floor?: boolean;
    floorSurface?: Surface;
  }
  | ({ op: 'wall' } & WallSpec)
  | {
    op: 'revetment';
    path: Vec2[];
    /** Sweep through the points instead of cornering at them. Off by default. */
    curve?: boolean;
    fabric?: Fabric;
    top?: number;
    thickness?: number;
    openings?: (Opening & { side: number })[];
  }
  | {
    op: 'hedgerow';
    path: Vec2[];
    spacing?: number;
    radius?: number;
    top?: number;
    curve?: boolean;
  }
  | { op: 'obstacle'; at: Vec2; radius: number; top?: number; fabric?: Fabric });

export interface LevelData {
  /** Format version, so a file written today still opens next year. */
  version?: number;
  id: string;
  name: string;
  brief: string;
  /** Free text for whoever opens it next. Never shown in game. */
  notes?: string;
  author?: string;
  size: { width: number; height: number };
  /** Applied in order. Later operations cut and paint over earlier ones. */
  terrain: TerrainOp[];
  structures: StructureOp[];
  spawns: {
    teams: Vec2[][];
    enemies: EnemySpawn[];
    objectives: Vec2[];
  };
}

/** Metadata plus whatever paints the scene. Data levels and test fixtures both. */
export interface LevelDef {
  id: string;
  name: string;
  brief: string;
  size: { width: number; height: number };
  paint: (scene: Scene) => void;
}

export function createScene(level: LevelDef): Scene {
  const scene = new Scene(level.size.width, level.size.height);
  level.paint(scene);
  scene.bake();
  return scene;
}

/** Turn a description into something the game can load. */
export function defineLevel(data: LevelData): LevelDef {
  return {
    id: data.id,
    name: data.name,
    brief: data.brief,
    size: data.size,
    paint: (scene) => applyLevel(scene, data),
  };
}

/**
 * Run a description against a scene.
 *
 * Unknown operations throw rather than being skipped. A level that quietly
 * loses the ditch because of a typo is far worse to debug than one that refuses
 * to load, and an editor writing this format needs to be told when it is wrong.
 */
export function applyLevel(scene: Scene, data: LevelData): void {
  for (const step of data.terrain) {
    // Muted operations stay in the file and out of the world. That is what
    // makes "hide the hedges and look again" a thing an author can do, and it
    // has to be honoured here rather than only in the editor's viewport, or the
    // simulation goes on seeing what the author has switched off.
    if (step.muted) continue;
    switch (step.op) {
      case 'heightmap':
        scene.terrain.heightmap(step, step);
        break;
      case 'rolling':
        scene.terrain.rolling(step.amplitude, step.wavelength, step.seed);
        break;
      case 'mound':
        scene.terrain.mound(step.at, step.radius, step.peak);
        break;
      case 'bank':
        scene.terrain.bank(step.path, step.width, step.rise, step);
        break;
      case 'cut':
        scene.terrain.cut(step.path, step.width, step.depth, step);
        break;
      case 'road':
        scene.terrain.road(step.path, step.width, step);
        break;
      case 'paint':
        scene.terrain.paint(step.min, step.max, step.surface);
        break;
      case 'surfacemap':
        scene.terrain.surfacemap({
          cols: step.cols, rows: step.rows, cells: unpackRuns(step.runs, step.cols * step.rows),
        });
        break;
      case 'crater':
        scene.terrain.crater(step.at, step.radius, step.depth);
        break;
      default:
        throw new Error(`level ${data.id}: unknown terrain op ${(step as { op: string }).op}`);
    }
  }

  for (const step of data.structures) {
    if (step.muted) continue;
    switch (step.op) {
      case 'building': {
        const footprint = step.footprint
          ?? (step.rect
            ? rect(step.rect.at, step.rect.width, step.rect.depth, step.rect.angle ?? 0)
            : null);
        if (!footprint) {
          throw new Error(`level ${data.id}: a building needs either a footprint or a rect`);
        }
        building(scene, { ...step, footprint });
        break;
      }
      case 'wall':
        wall(scene, step);
        break;
      case 'revetment':
        revetment(scene, step.path, step.fabric, step.top, step.thickness, step.openings,
          step.curve === true);
        break;
      case 'hedgerow':
        hedgerow(scene, step.path, step);
        break;
      case 'obstacle':
        obstacle(scene, step.at, step.radius, step.top, step.fabric);
        break;
      default:
        throw new Error(`level ${data.id}: unknown structure op ${(step as { op: string }).op}`);
    }
  }

  scene.spawns.teams = data.spawns.teams.map((team) => team.map((p) => ({ ...p })));
  scene.spawns.enemies = data.spawns.enemies.map((e) => ({ pos: { ...e.pos }, kind: e.kind }));
  scene.spawns.objectives = data.spawns.objectives.map((p) => ({ ...p }));
}

// ------------------------------------------------------------------- lifecycle

let nextOpId = 1;

/**
 * Every operation gets a stable handle, so an editor can follow one across edits.
 *
 * A fresh id is checked against every id already in the level, not only the
 * ones met so far. The counter is per session and a level carries ids from
 * whichever session wrote it, so a new operation appended to a loaded level
 * was routinely handed an id an existing one already had.
 */
export function assignIds(data: LevelData): LevelData {
  const taken = new Set<string>();
  for (const op of data.terrain) if (op.id) taken.add(op.id);
  for (const op of data.structures) if (op.id) taken.add(op.id);

  const seen = new Set<string>();
  const stamp = (op: OpMeta): void => {
    if (!op.id || seen.has(op.id)) {
      let id: string;
      do {
        id = `op${nextOpId++}`;
      } while (taken.has(id));
      taken.add(id);
      op.id = id;
    }
    seen.add(op.id);
  };
  for (const op of data.terrain) stamp(op);
  for (const op of data.structures) stamp(op);
  return data;
}

/** A level with nothing on it but ground and somewhere to start. */
export function blankLevel(width = 140, height = 110): LevelData {
  return assignIds({
    version: LEVEL_FORMAT,
    id: 'untitled',
    name: 'Untitled',
    brief: 'No briefing yet.',
    size: { width, height },
    terrain: [{ op: 'rolling', amplitude: 1.2, wavelength: 34, seed: 3 }],
    structures: [],
    spawns: {
      teams: [
        [vecAt(width * 0.4, height - 10), vecAt(width * 0.4 + 1.6, height - 10)],
      ],
      enemies: [{ pos: vecAt(width * 0.5, height * 0.25), kind: 'rifle' }],
      objectives: [vecAt(width * 0.5, height * 0.18)],
    },
  });
}

function vecAt(x: number, y: number): Vec2 {
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/**
 * Bring a file written by an older build forward.
 *
 * Levels outlive the code that wrote them the moment somebody saves one, so
 * this is a one-way ratchet with a step per format change rather than a version
 * check that refuses to open anything unfamiliar.
 */
export function migrate(raw: unknown): LevelData {
  if (!raw || typeof raw !== 'object') throw new Error('not a level: expected an object');
  const data = raw as LevelData & { version?: number };
  const from = data.version ?? 0;

  if (from > LEVEL_FORMAT) {
    throw new Error(
      `this level was written by a newer build (format ${from}, this one reads ${LEVEL_FORMAT})`,
    );
  }
  // Format 0 is anything written before levels carried a version at all: the
  // shape is already right, it simply never said so.
  data.version = LEVEL_FORMAT;
  data.terrain ??= [];
  data.structures ??= [];
  data.spawns ??= { teams: [], enemies: [], objectives: [] };
  data.spawns.teams ??= [];
  data.spawns.enemies ??= [];
  data.spawns.objectives ??= [];

  // Format 1 said only whether a defender was belt-fed. A level written then —
  // including one sitting in somebody's browser from last week — still means
  // exactly what it said, so it is read rather than rejected.
  for (const e of data.spawns.enemies as (EnemySpawn & { heavy?: boolean })[]) {
    if (e.kind) continue;
    e.kind = e.heavy ? 'gunner' : 'rifle';
    delete e.heavy;
  }

  return assignIds(data);
}

export function serialiseLevel(data: LevelData): string {
  return `${JSON.stringify({ ...data, version: LEVEL_FORMAT }, null, 2)}\n`;
}

// ------------------------------------------------------------------ validation

export interface Problem {
  severity: 'error' | 'warning';
  /** The operation's id, or a section name like 'spawns'. */
  where: string;
  message: string;
}

/** Which list an operation belongs in. The editor's clipboard sorts by this too. */
export const TERRAIN_OPS: ReadonlySet<string> = new Set([
  'heightmap', 'rolling', 'mound', 'bank', 'cut', 'road', 'paint', 'crater', 'surfacemap',
]);
const STRUCTURE_OPS = new Set(['building', 'wall', 'revetment', 'hedgerow', 'obstacle']);

/**
 * Everything wrong with a level that can be seen without running it.
 *
 * Reported rather than thrown. An editor has to be able to show a level that is
 * half-finished — that is what being half-finished looks like — while still
 * saying plainly which parts will not work, and an author needs the whole list
 * rather than whichever problem happened to be found first.
 */
export function validateLevel(data: LevelData): Problem[] {
  const problems: Problem[] = [];
  const say = (severity: Problem['severity'], where: string, message: string): void => {
    problems.push({ severity, where, message });
  };

  const { width, height } = data.size ?? { width: 0, height: 0 };
  if (!(width > 8) || !(height > 8)) say('error', 'size', 'a level needs to be at least 8m each way');

  const inside = (p: Vec2 | undefined): boolean =>
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;

  const checkPath = (where: string, path: Vec2[] | undefined, least: number): void => {
    if (!path || path.length < least) {
      say('error', where, `needs at least ${least} points`);
      return;
    }
    if (!path.every(inside)) say('warning', where, 'runs outside the level');
  };

  for (const op of data.terrain) {
    const where = op.id ?? op.op;
    if (!TERRAIN_OPS.has(op.op)) {
      say('error', where, `unknown terrain operation "${op.op}"`);
      continue;
    }
    switch (op.op) {
      case 'bank':
      case 'cut':
      case 'road':
        checkPath(where, op.path, 2);
        if (!(op.width > 0)) say('error', where, 'width must be positive');
        break;
      case 'mound':
      case 'crater':
        if (!inside(op.at)) say('warning', where, 'sits outside the level');
        if (!(op.radius > 0)) say('error', where, 'radius must be positive');
        break;
      case 'heightmap':
        if (!(op.cols >= 2) || !(op.rows >= 2)) say('error', where, 'needs a grid of at least 2x2');
        else if (op.heights.length !== op.cols * op.rows) {
          say('error', where, `grid is ${op.cols}x${op.rows} but carries ${op.heights.length} heights`);
        }
        break;
      case 'surfacemap': {
        if (!(op.cols >= 2) || !(op.rows >= 2)) {
          say('error', where, 'needs a grid of at least 2x2');
          break;
        }
        let covered = 0;
        for (let i = 1; i < op.runs.length; i += 2) covered += op.runs[i];
        if (covered !== op.cols * op.rows) {
          say('error', where,
            `grid is ${op.cols}x${op.rows} but its runs cover ${covered} cells`);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const op of data.structures) {
    const where = op.id ?? op.op;
    if (!STRUCTURE_OPS.has(op.op)) {
      say('error', where, `unknown structure operation "${op.op}"`);
      continue;
    }
    switch (op.op) {
      case 'building': {
        const footprint = op.footprint
          ?? (op.rect ? rect(op.rect.at, op.rect.width, op.rect.depth, op.rect.angle ?? 0) : null);
        if (!footprint) {
          say('error', where, 'a building needs either a footprint or a rect');
          break;
        }
        if (footprint.length < 3) say('error', where, 'a footprint needs at least three corners');
        else if (!footprint.every(inside)) say('warning', where, 'sticks out of the level');
        for (const opening of op.openings ?? []) {
          if (opening.side < 0 || opening.side >= footprint.length) {
            say('error', where, `an opening is on wall ${opening.side}, which does not exist`);
            continue;
          }
          const a = footprint[opening.side];
          const b = footprint[(opening.side + 1) % footprint.length];
          checkOpening(say, where, opening, Math.hypot(b.x - a.x, b.y - a.y));
        }
        break;
      }
      case 'wall':
        if (!inside(op.a) || !inside(op.b)) say('warning', where, 'runs outside the level');
        for (const opening of op.openings ?? []) {
          checkOpening(say, where, opening, Math.hypot(op.b.x - op.a.x, op.b.y - op.a.y));
        }
        break;
      case 'revetment':
      case 'hedgerow':
        checkPath(where, op.path, 2);
        break;
      case 'obstacle':
        if (!inside(op.at)) say('warning', where, 'sits outside the level');
        if (!(op.radius > 0)) say('error', where, 'radius must be positive');
        break;
      default:
        break;
    }
  }

  const teams = data.spawns.teams.filter((t) => t.length > 0);
  if (teams.length === 0) say('error', 'spawns', 'nobody starts here: place at least one team');
  if (data.spawns.objectives.length === 0) say('error', 'spawns', 'no objective to take');
  if (data.spawns.enemies.length === 0) say('warning', 'spawns', 'nobody is defending it');
  for (const team of data.spawns.teams) {
    if (team.some((p) => !inside(p))) say('error', 'spawns', 'a start position is off the map');
  }
  for (const e of data.spawns.enemies) {
    if (!inside(e.pos)) say('error', 'spawns', 'a defender is off the map');
  }
  for (const o of data.spawns.objectives) {
    if (!inside(o)) say('error', 'spawns', 'an objective is off the map');
  }
  return problems;
}

function checkOpening(
  say: (s: Problem['severity'], w: string, m: string) => void,
  where: string,
  opening: Opening,
  length: number,
): void {
  if (!(opening.width > 0)) {
    say('error', where, 'an opening has no width');
    return;
  }
  if (opening.at === 'centre') return;
  if (opening.at < 0 || opening.at > length) {
    say('error', where, `an opening sits ${opening.at.toFixed(1)}m along a ${length.toFixed(1)}m wall`);
  } else if (opening.at - opening.width / 2 < 0 || opening.at + opening.width / 2 > length) {
    say('warning', where, 'an opening runs off the end of its wall');
  }
}


// ------------------------------------------------------------- run lengths

/** Flatten a grid to [value, count, ...] pairs. */
export function packRuns(cells: ArrayLike<number>): number[] {
  const runs: number[] = [];
  let value = cells[0];
  let count = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === value) {
      count++;
      continue;
    }
    runs.push(value, count);
    value = cells[i];
    count = 1;
  }
  if (count > 0) runs.push(value, count);
  return runs;
}

/** And back again. A short or long run list is padded or truncated, not trusted. */
export function unpackRuns(runs: number[], length: number): Uint8Array {
  const cells = new Uint8Array(length).fill(255);
  let at = 0;
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const value = runs[i];
    const count = runs[i + 1];
    for (let k = 0; k < count && at < length; k++) cells[at++] = value;
  }
  return cells;
}
