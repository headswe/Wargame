import { type Vec2, dist, spline, vec } from '../math.ts';
import { Fabric, Solidity } from './geometry.ts';
import type { Scene } from './scene.ts';

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
  const thickness = spec.thickness ?? 0.8;
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
      // Segments are stamped as capsules, so each wall end bulges half a
      // thickness into the gap between them. A doorway therefore has to be cut
      // wider than it wants to be, or the author asks for two metres, gets one,
      // and the navmesh quietly seals the building.
      const cut = (o.kind === 'door' ? o.width + thickness : o.width) / length;
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
export function building(scene: Scene, spec: BuildingSpec): number[] {
  const fabric = spec.fabric ?? Fabric.Brick;
  const top = spec.wallTop ?? 2.7;
  const thickness = spec.thickness ?? 0.8;
  const footprint = spec.footprint;
  const ids: number[] = [];

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
): number[] {
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
