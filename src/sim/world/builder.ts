import { type Vec2, dist, spline, vec } from '../math.ts';
import { Fabric, STAMP_FLOOR, Solidity } from './geometry.ts';
import type { Scene } from './scene.ts';
import { Surface } from './terrain.ts';

/**
 * A village wall: one leaf of brick and a coat of render, not a rampart.
 *
 * This was 0.8m, chosen to sit above what the sightline grid can resolve, which
 * confused a limit of the simulation with a fact about the world and drew every
 * farmhouse as a keep.
 */
const WALL_THICKNESS = 0.35;

/** Underside of a doorway's lintel: high enough to walk under, low enough to see over. */
const DOOR_HEAD = 2.1;
/** A window you can rest a rifle on. */
const WINDOW_SILL = 0.95;
/** And see out of, up to here. */
const WINDOW_HEAD = 2.0;

export interface Opening {
  /**
   * Metres along the wall from its start, to the centre of the opening.
   * 'centre' is the middle, which is what most walls want.
   *
   * This used to be a fraction of the whole building's perimeter, which meant
   * that moving a door was arithmetic rather than a decision, and that nudging
   * a wall silently moved every opening in it.
   */
  at: number | 'centre';
  /** Metres of wall removed. */
  width: number;
  /** A door is open to the floor; a window leaves a sill to shoot over. */
  kind: 'door' | 'window';
  /** Overrides, in metres above the wall's base. */
  sill?: number;
  head?: number;
}

export interface WallSpec {
  a: Vec2;
  b: Vec2;
  fabric?: Fabric;
  /** Height of the wall itself. */
  top?: number;
  thickness?: number;
  solidity?: Solidity;
  openings?: Opening[];
  /** Set when the run belongs to a building, so damage can be attributed. */
  buildingId?: number | null;
}

/**
 * One run of wall, fence or revetment, with its openings cut out of it.
 *
 * An opening is genuinely absent rather than a hole drawn over something solid,
 * which is what the navmesh and the sightline field both read. A window leaves
 * two pieces behind — the sill you shoot over and the lintel you cannot see
 * through — so the gap between them is a band of open air at head height
 * rather than a slot running to the roof.
 */
export function wall(scene: Scene, spec: WallSpec): number[] {
  const fabric = spec.fabric ?? Fabric.Brick;
  const top = spec.top ?? 2.7;
  const thickness = spec.thickness ?? WALL_THICKNESS;
  const solidity = spec.solidity ?? Solidity.Solid;
  const buildingId = spec.buildingId ?? null;
  const length = dist(spec.a, spec.b);
  const ids: number[] = [];
  if (length < 1e-6) return ids;

  const point = (t: number): Vec2 => vec(
    spec.a.x + (spec.b.x - spec.a.x) * t,
    spec.a.y + (spec.b.y - spec.a.y) * t,
  );
  const solid = (from: number, to: number): void => {
    if (to - from < 1e-4) return;
    ids.push(scene.structures.addSegment({
      a: point(from), b: point(to), thickness, sill: 0, top, solidity, fabric, buildingId,
    }).id);
  };

  const cuts = (spec.openings ?? [])
    .map((o) => {
      const centre = (o.at === 'centre' ? length / 2 : o.at) / length;
      // Each wall end bulges into the gap beside it, by half its thickness or
      // half the grid's minimum stamp, whichever is wider. Every opening
      // therefore has to be cut wider than it wants to be, or the author asks
      // for two metres and gets one.
      //
      // This used to apply to doorways only, on the grounds that a sealed
      // building is obvious and a slightly narrow window is not. It is not:
      // anything cut narrower than the stamp floor closes up completely, so a
      // firing slit in a wall simply was not there, and a defence built behind
      // loopholes was blind without anything saying so.
      const cut = (o.width + Math.max(thickness, STAMP_FLOOR)) / length;
      return {
        from: Math.max(0, centre - cut / 2),
        to: Math.min(1, centre + cut / 2),
        sill: o.sill ?? (o.kind === 'door' ? 0 : WINDOW_SILL),
        head: o.head ?? (o.kind === 'door' ? DOOR_HEAD : WINDOW_HEAD),
      };
    })
    .sort((x, y) => x.from - y.from);

  let cursor = 0;
  for (const cut of cuts) {
    solid(cursor, cut.from);
    if (cut.sill > 0) {
      // Blocks a body, not a sightline, and gives whoever is behind it
      // something to fire over.
      ids.push(scene.structures.addSegment({
        a: point(cut.from), b: point(cut.to),
        thickness, sill: 0, top: cut.sill,
        solidity: Solidity.LowCover, fabric, buildingId,
      }).id);
    }
    if (solidity === Solidity.Solid && top > cut.head + 0.05) {
      // The lintel. It stops a sightline without standing on anything and
      // without stopping a body, which is the whole difference between a window
      // and a gap in a wall.
      ids.push(scene.structures.addSegment({
        a: point(cut.from), b: point(cut.to),
        thickness, sill: cut.head, top,
        solidity: Solidity.Solid, fabric, buildingId,
      }).id);
    }
    cursor = Math.max(cursor, cut.to);
  }
  solid(cursor, 1);
  return ids;
}

export interface BuildingSpec {
  /** Any closed polygon. `rect()` makes the usual one. */
  footprint: Vec2[];
  fabric?: Fabric;
  wallTop?: number;
  thickness?: number;
  /** Openings, each addressed by which wall of the footprint it is cut into. */
  openings?: (Opening & { side: number })[];
  /** Interior walls. They belong to the building, and can carry doorways. */
  partitions?: WallSpec[];
  /** Level ground inside, and something underfoot. Off for a ruin or a pen. */
  floor?: boolean;
  /** What the floor is made of. Boards and slab read differently underfoot. */
  floorSurface?: Surface;
}

/**
 * A building: a closed footprint of walls, plus whatever divides the inside.
 *
 * The footprint is a polygon rather than a width and a depth, so an L-plan
 * farmhouse, a courtyard block and a plain hut are the same call. Partitions
 * belong to the building rather than being separate walls that happen to be
 * inside it, which is what makes an interior worth fighting through instead of
 * being one room you either hold or do not.
 */
/**
 * What is underfoot in a building of each fabric.
 *
 * It is a guess at construction rather than a decoration: a brick or concrete
 * building gets a slab, a timber one gets boards over dirt, and a sandbag or
 * rubble position never had a floor to begin with. It matters beyond the colour
 * because surface decides footing, so crossing a room is quicker than crossing
 * the field outside it.
 */
/**
 * How wide the bank against a building is allowed to get, in metres.
 *
 * Chosen off a measurement rather than by eye, because this is terrain and
 * terrain is where the defence looks for cover. Widening the skirt smooths the
 * step at the wall, and past about three and a half metres it starts reaching
 * the ground `digIn` searches — at which point the defenders find good enough
 * positions where they stand and the commander stops having anywhere better to
 * send them.
 *
 *   skirt   step at the wall   defence moves
 *   1.5m    0.486m             4.46m
 *   2.5m    0.226m             4.46m
 *   3.5m    0.123m             4.46m
 *   5.0m    0.079m             3.13m
 *   7.0m    0.079m             3.13m
 *
 * Three and a half takes three quarters of the step out and costs nothing.
 * Beyond it the picture barely improves and the defence gives up a third of its
 * movement, which is the thing this game is about.
 */
const SKIRT_LIMIT = 3.5;

const FLOOR_OF: Partial<Record<Fabric, Surface>> = {
  [Fabric.Brick]: Surface.Concrete,
  [Fabric.Concrete]: Surface.Concrete,
  [Fabric.Metal]: Surface.Concrete,
  [Fabric.Timber]: Surface.Dirt,
  [Fabric.Sandbag]: Surface.Dirt,
  [Fabric.Rubble]: Surface.Rubble,
};

export function building(scene: Scene, spec: BuildingSpec): number[] {
  const fabric = spec.fabric ?? Fabric.Brick;
  const top = spec.wallTop ?? 2.7;
  const thickness = spec.thickness ?? WALL_THICKNESS;
  const footprint = spec.footprint;
  const ids: number[] = [];

  /**
   * The floor goes down before the walls, so the walls stand on it.
   *
   * Its height is the mean of the ground under the corners rather than the
   * lowest or the highest of them: a house on a slope is dug into the hill on
   * one side and stands proud on the other, which is what a house on a slope
   * actually does. Taking the maximum would perch every building on a plinth
   * and taking the minimum would bury the uphill wall to its windows.
   */
  if (spec.floor !== false) {
    const corners = footprint.map((p) => scene.terrain.heightAt(p.x, p.y));
    const level = corners.reduce((a, h) => a + h, 0) / corners.length;
    /**
     * The earth banked against the building, widened to suit how far it has to
     * travel.
     *
     * A fixed skirt was the bug. Levelling to the mean cuts into the hill on
     * one side and stands proud on the other — which is what a building on a
     * slope does — but a metre and a half of blend for a drop of two thirds of
     * a metre is a twenty-seven degree bank starting at the wall, and from
     * above that reads as the wall hanging over a step rather than standing on
     * anything. Measured at a Stepove house: floor 3.64, ground two metres out
     * 4.31.
     *
     * Widening it in proportion to the drop turns the step into a bank, which
     * is also what actually happens to the dirt round a building that has been
     * there any length of time.
     */
    const drop = Math.max(...corners.map((h) => Math.abs(h - level)));
    scene.terrain.pad(footprint, level, {
      surface: spec.floorSurface ?? FLOOR_OF[fabric] ?? Surface.Dirt,
      skirt: Math.max(1.5, Math.min(SKIRT_LIMIT, 1.5 + drop * 4.5)),
    });
  }

  for (let side = 0; side < footprint.length; side++) {
    ids.push(...wall(scene, {
      a: footprint[side],
      b: footprint[(side + 1) % footprint.length],
      fabric, top, thickness,
      openings: (spec.openings ?? []).filter((o) => o.side === side),
    }));
  }

  for (const partition of spec.partitions ?? []) {
    ids.push(...wall(scene, {
      fabric, top, thickness: thickness * 0.75, ...partition,
    }));
  }

  scene.structures.addBuilding(footprint.map((p) => ({ ...p })), ids);
  return ids;
}

/** The usual footprint: a rectangle at any orientation. Sides run 0..3. */
export function rect(centre: Vec2, width: number, depth: number, angle = 0): Vec2[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corner = (sx: number, sy: number): Vec2 => {
    const lx = (sx * width) / 2;
    const ly = (sy * depth) / 2;
    return vec(centre.x + lx * cos - ly * sin, centre.y + lx * sin + ly * cos);
  };
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

export interface VegetationOptions {
  spacing?: number;
  radius?: number;
  top?: number;
  /** Follow the control points as a curve rather than as a set of corners. */
  curve?: boolean;
}

/** A run of vegetation: hides, stops nothing. */
export function hedgerow(scene: Scene, path: Vec2[], options: VegetationOptions = {}): void {
  const spacing = options.spacing ?? 1.5;
  const radius = options.radius ?? 1.4;
  const top = options.top ?? 1.9;
  const line = options.curve === false ? path : spline(path, spacing * 2);

  let k = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const count = Math.max(1, Math.round(length / spacing));
    for (let n = 0; n <= count; n++) {
      const t = n / count;
      // A wobble, so a hedge does not read as a row of identical bushes.
      const wobble = Math.sin(k * 1.7 + i * 3.1) * radius * 0.35;
      const nx = -(b.y - a.y) / length;
      const ny = (b.x - a.x) / length;
      scene.structures.addProp({
        pos: vec(a.x + (b.x - a.x) * t + nx * wobble, a.y + (b.y - a.y) * t + ny * wobble),
        radius: radius * (0.8 + 0.4 * Math.abs(Math.cos(k * 2.3))),
        sill: 0, top,
        solidity: Solidity.Concealment, fabric: Fabric.Hedge,
      });
      k++;
    }
  }
}

/** A low run you can shoot over but not walk through. */
export function revetment(
  scene: Scene,
  path: Vec2[],
  fabric: Fabric = Fabric.Sandbag,
  top = 0.95,
  thickness = 1.1,
  openings: (Opening & { side: number })[] = [],
  curve = false,
): number[] {
  /**
   * Corners by default, unlike a road or a hedge.
   *
   * The other linear features curve because they are made by water, wheels or
   * growth, none of which turns a corner. A revetment is built: a compound
   * wall, a sandbag emplacement, a berm round a fuel dump. Every one of those
   * is straight runs meeting at angles, and rounding them off would have
   * quietly turned Kolna's rectangular yard into a racetrack. The author can
   * still ask for a curve, for the cases where he wants a sweep.
   */
  if (curve) path = spline(path, Math.max(1.5, thickness * 2));
  const ids: number[] = [];
  for (let side = 0; side + 1 < path.length; side++) {
    ids.push(...wall(scene, {
      a: path[side], b: path[side + 1],
      fabric, top, thickness,
      solidity: Solidity.LowCover,
      openings: openings.filter((o) => o.side === side),
    }));
  }
  return ids;
}

/** Something solid and roughly round — a wreck, a water tank, a spoil heap. */
export function obstacle(
  scene: Scene, pos: Vec2, radius: number, top = 1.9, fabric: Fabric = Fabric.Metal,
): number {
  return scene.structures.addProp({
    pos, radius, sill: 0, top, solidity: Solidity.Solid, fabric,
  }).id;
}
