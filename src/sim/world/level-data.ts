import type { Vec2 } from '../math.ts';
import { type Opening, type WallSpec, building, hedgerow, obstacle, rect, revetment, wall } from './builder.ts';
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

export interface RectSpec {
  at: Vec2;
  width: number;
  depth: number;
  angle?: number;
}

export type TerrainOp =
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
  | { op: 'crater'; at: Vec2; radius: number; depth: number };

export type StructureOp =
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
  }
  | ({ op: 'wall' } & WallSpec)
  | {
    op: 'revetment';
    path: Vec2[];
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
  | { op: 'obstacle'; at: Vec2; radius: number; top?: number; fabric?: Fabric };

export interface LevelData {
  id: string;
  name: string;
  brief: string;
  size: { width: number; height: number };
  /** Applied in order. Later operations cut and paint over earlier ones. */
  terrain: TerrainOp[];
  structures: StructureOp[];
  spawns: {
    teams: Vec2[][];
    enemies: { pos: Vec2; heavy: boolean }[];
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
      case 'crater':
        scene.terrain.crater(step.at, step.radius, step.depth);
        break;
      default:
        throw new Error(`level ${data.id}: unknown terrain op ${(step as { op: string }).op}`);
    }
  }

  for (const step of data.structures) {
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
        revetment(scene, step.path, step.fabric, step.top, step.thickness, step.openings);
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
  scene.spawns.enemies = data.spawns.enemies.map((e) => ({ pos: { ...e.pos }, heavy: e.heavy }));
  scene.spawns.objectives = data.spawns.objectives.map((p) => ({ ...p }));
}
