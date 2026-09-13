import { type Vec2, vec } from '../math.ts';
import { Fabric, Solidity } from './geometry.ts';
import type { Scene } from './scene.ts';

export interface Opening {
  /** Fraction around the perimeter: 0..0.25 is the first side, and so on. */
  at: number;
  /** Metres of wall removed. */
  width: number;
  /** A window leaves a sill you can shoot over; a door leaves nothing. */
  kind: 'door' | 'window';
}

export interface BuildingSpec {
  centre: Vec2;
  width: number;
  depth: number;
  angle: number;
  fabric?: Fabric;
  wallTop?: number;
  thickness?: number;
  openings?: Opening[];
}

/**
 * A building at any orientation, with openings punched through its walls.
 *
 * Each side is emitted as the runs of wall left between its openings, so a
 * doorway is genuinely absent rather than a hole stamped over the top of
 * something solid — which matters once the navmesh is rasterised from these.
 */
export function building(scene: Scene, spec: BuildingSpec): number[] {
  const fabric = spec.fabric ?? Fabric.Brick;
  const top = spec.wallTop ?? 2.7;
  const thickness = spec.thickness ?? 0.8;
  const cos = Math.cos(spec.angle);
  const sin = Math.sin(spec.angle);

  const corner = (sx: number, sy: number): Vec2 => {
    const lx = (sx * spec.width) / 2;
    const ly = (sy * spec.depth) / 2;
    return vec(
      spec.centre.x + lx * cos - ly * sin,
      spec.centre.y + lx * sin + ly * cos,
    );
  };
  const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const ids: number[] = [];

  for (let side = 0; side < 4; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;

    const mine = (spec.openings ?? [])
      .filter((o) => Math.min(3, Math.floor(o.at * 4)) === side)
      .map((o) => {
        const local = o.at * 4 - side;
        // Segments are stamped as capsules, so each wall end bulges half a
        // thickness into the gap between them. A doorway therefore has to be
        // cut wider than it wants to be, or the author asks for two metres,
        // gets one, and the navmesh quietly seals the building.
        const cut = o.kind === 'door' ? o.width + thickness : o.width;
        const half = cut / 2 / length;
        return { from: Math.max(0, local - half), to: Math.min(1, local + half), kind: o.kind };
      })
      .sort((x, y) => x.from - y.from);

    const point = (t: number): Vec2 => vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    let cursor = 0;

    for (const opening of mine) {
      if (opening.from > cursor + 1e-4) {
        ids.push(run(scene, point(cursor), point(opening.from), thickness, top, fabric));
      }
      if (opening.kind === 'window') {
        // A sill: blocks a body, not a sightline, and gives whoever is behind
        // it something to fire over.
        ids.push(
          scene.structures.addSegment({
            a: point(opening.from), b: point(opening.to),
            thickness, sill: 0, top: 0.95,
            solidity: Solidity.LowCover, fabric, buildingId: null,
          }).id,
        );
      }
      cursor = Math.max(cursor, opening.to);
    }
    if (cursor < 1 - 1e-4) ids.push(run(scene, point(cursor), point(1), thickness, top, fabric));
  }

  scene.structures.addBuilding(corners, ids);
  return ids;
}

function run(
  scene: Scene, a: Vec2, b: Vec2, thickness: number, top: number, fabric: Fabric,
): number {
  return scene.structures.addSegment({
    a, b, thickness, sill: 0, top,
    solidity: Solidity.Solid, fabric, buildingId: null,
  }).id;
}

/** A run of vegetation: hides, stops nothing. */
export function hedgerow(
  scene: Scene, path: Vec2[], options: { spacing?: number; radius?: number; top?: number } = {},
): void {
  const spacing = options.spacing ?? 1.5;
  const radius = options.radius ?? 1.4;
  const top = options.top ?? 1.9;

  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const count = Math.max(1, Math.round(length / spacing));
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      // A wobble, so a hedge does not read as a row of identical bushes.
      const wobble = Math.sin(i * 3.1 + k * 1.7) * radius * 0.35;
      const nx = -(b.y - a.y) / length;
      const ny = (b.x - a.x) / length;
      scene.structures.addProp({
        pos: vec(a.x + (b.x - a.x) * t + nx * wobble, a.y + (b.y - a.y) * t + ny * wobble),
        radius: radius * (0.8 + 0.4 * Math.abs(Math.cos(k * 2.3))),
        sill: 0, top,
        solidity: Solidity.Concealment, fabric: Fabric.Hedge,
      });
    }
  }
}

/** A low run you can shoot over but not walk through. */
export function revetment(
  scene: Scene, path: Vec2[], fabric: Fabric = Fabric.Sandbag, top = 0.95, thickness = 1.1,
): number[] {
  const ids: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    ids.push(
      scene.structures.addSegment({
        a: path[i], b: path[i + 1],
        thickness, sill: 0, top,
        solidity: Solidity.LowCover, fabric, buildingId: null,
      }).id,
    );
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
