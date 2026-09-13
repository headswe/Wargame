import { type Vec2, distPointToSegment } from '../math.ts';

/** What a thing does to movement, bullets and eyes. */
export const Solidity = {
  /** Stops everything. Masonry, a shipping container. */
  Solid: 0,
  /** Stops a body, not a sightline. Sandbags, a low wall, a windowsill. */
  LowCover: 1,
  /**
   * Stops nothing at all — but makes you much harder to pick out. Bushes,
   * standing crop, smoke. Concealment is not cover, and the game gets a lot
   * more interesting once it can tell the difference.
   */
  Concealment: 2,
} as const;
export type Solidity = (typeof Solidity)[keyof typeof Solidity];

export const Fabric = {
  Concrete: 0,
  Brick: 1,
  Timber: 2,
  Sandbag: 3,
  Hedge: 4,
  Metal: 5,
  Rubble: 6,
} as const;
export type Fabric = (typeof Fabric)[keyof typeof Fabric];

/** How much punishment each fabric takes, and how much of a hit tells. */
export const TOUGHNESS: Record<number, { hp: number; vulnerability: number }> = {
  [Fabric.Concrete]: { hp: 460, vulnerability: 0.18 },
  [Fabric.Brick]: { hp: 300, vulnerability: 0.26 },
  [Fabric.Timber]: { hp: 110, vulnerability: 0.9 },
  [Fabric.Sandbag]: { hp: 180, vulnerability: 0.55 },
  [Fabric.Hedge]: { hp: 90, vulnerability: 0.7 },
  [Fabric.Metal]: { hp: 220, vulnerability: 0.45 },
  [Fabric.Rubble]: { hp: 130, vulnerability: 0.6 },
};

/**
 * A run of wall, fence, hedge or sandbag line, at any angle.
 *
 * `sill` and `top` are heights above the wall's own base, which is what lets
 * one type express a full wall, a waist-high revetment and a window band: a
 * window is simply a short segment whose solid part stops at the sill.
 */
export interface Segment {
  id: number;
  a: Vec2;
  b: Vec2;
  thickness: number;
  sill: number;
  top: number;
  solidity: Solidity;
  fabric: Fabric;
  hp: number;
  maxHp: number;
  buildingId: number | null;
  destroyed: boolean;
}

export interface Building {
  id: number;
  footprint: Vec2[];
  segmentIds: number[];
  /** Reserved. Everything is storey 0 today; the field exists so adding a */
  /** second floor later does not mean touching every call site. */
  storey: number;
}

export interface Prop {
  id: number;
  pos: Vec2;
  radius: number;
  sill: number;
  top: number;
  solidity: Solidity;
  fabric: Fabric;
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

/**
 * Everything standing on the terrain, with a uniform grid over it so queries
 * do not degrade into scanning the whole map. The cell size is deliberately
 * larger than most segments: each one then touches only a handful of cells.
 */
export class Structures {
  readonly segments: Segment[] = [];
  readonly buildings: Building[] = [];
  readonly props: Prop[] = [];

  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly segmentCells: number[][];
  private readonly propCells: number[][];

  constructor(width: number, height: number, cellSize = 8) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize) + 1;
    this.rows = Math.ceil(height / cellSize) + 1;
    const count = this.cols * this.rows;
    this.segmentCells = Array.from({ length: count }, () => []);
    this.propCells = Array.from({ length: count }, () => []);
  }

  addSegment(spec: Omit<Segment, 'id' | 'hp' | 'maxHp' | 'destroyed'> & { hp?: number }): Segment {
    const toughness = TOUGHNESS[spec.fabric] ?? TOUGHNESS[Fabric.Concrete];
    // Longer and thicker runs take more killing, which keeps a garden fence
    // from soaking as much fire as a length of the same wall twice its size.
    const bulk = Math.max(0.5, spec.thickness) * Math.max(0.5, spec.top - spec.sill);
    const hp = spec.hp ?? toughness.hp * bulk;
    const segment: Segment = {
      ...spec,
      id: this.segments.length,
      hp,
      maxHp: hp,
      destroyed: false,
    };
    this.segments.push(segment);
    for (const cell of this.cellsForSegment(segment)) this.segmentCells[cell].push(segment.id);
    return segment;
  }

  addProp(spec: Omit<Prop, 'id' | 'hp' | 'maxHp' | 'destroyed'> & { hp?: number }): Prop {
    const toughness = TOUGHNESS[spec.fabric] ?? TOUGHNESS[Fabric.Timber];
    const hp = spec.hp ?? toughness.hp * Math.max(0.5, spec.radius);
    const prop: Prop = { ...spec, id: this.props.length, hp, maxHp: hp, destroyed: false };
    this.props.push(prop);
    for (const cell of this.cellsForCircle(prop.pos, prop.radius)) this.propCells[cell].push(prop.id);
    return prop;
  }

  addBuilding(footprint: Vec2[], segmentIds: number[], storey = 0): Building {
    const building: Building = { id: this.buildings.length, footprint, segmentIds, storey };
    this.buildings.push(building);
    for (const id of segmentIds) this.segments[id].buildingId = building.id;
    return building;
  }

  /** 0..1 — how much of this segment is still standing. */
  integrity(segment: Segment): number {
    return segment.maxHp <= 0 ? 0 : Math.max(0, segment.hp) / segment.maxHp;
  }

  /**
   * Put rounds into a segment. Returns true if it came down, in which case it
   * leaves a low run of rubble behind rather than simply vanishing — the
   * battlefield should manufacture its own cover as it is taken apart.
   */
  damageSegment(id: number, amount: number): boolean {
    const segment = this.segments[id];
    if (!segment || segment.destroyed) return false;
    const toughness = TOUGHNESS[segment.fabric] ?? TOUGHNESS[Fabric.Concrete];
    segment.hp -= amount * toughness.vulnerability;
    if (segment.hp > 0) return false;

    if (segment.solidity === Solidity.Solid && segment.top > 1.0) {
      // A wall becomes a breach you can see over but not yet walk through.
      segment.solidity = Solidity.LowCover;
      segment.fabric = Fabric.Rubble;
      segment.top = 0.7;
      const rubble = TOUGHNESS[Fabric.Rubble];
      segment.maxHp = rubble.hp * Math.max(0.5, segment.thickness);
      segment.hp = segment.maxHp;
    } else {
      segment.destroyed = true;
    }
    return true;
  }

  damageProp(id: number, amount: number): boolean {
    const prop = this.props[id];
    if (!prop || prop.destroyed) return false;
    const toughness = TOUGHNESS[prop.fabric] ?? TOUGHNESS[Fabric.Timber];
    prop.hp -= amount * toughness.vulnerability;
    if (prop.hp > 0) return false;
    prop.destroyed = true;
    return true;
  }

  // --------------------------------------------------------------- queries

  /** Segment ids whose cells overlap the given box. May contain duplicates. */
  segmentsInBox(minX: number, minY: number, maxX: number, maxY: number): Set<number> {
    const found = new Set<number>();
    const i0 = this.clampCol(Math.floor(minX / this.cellSize));
    const i1 = this.clampCol(Math.floor(maxX / this.cellSize));
    const j0 = this.clampRow(Math.floor(minY / this.cellSize));
    const j1 = this.clampRow(Math.floor(maxY / this.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.segmentCells[j * this.cols + i]) found.add(id);
      }
    }
    return found;
  }

  propsInBox(minX: number, minY: number, maxX: number, maxY: number): Set<number> {
    const found = new Set<number>();
    const i0 = this.clampCol(Math.floor(minX / this.cellSize));
    const i1 = this.clampCol(Math.floor(maxX / this.cellSize));
    const j0 = this.clampRow(Math.floor(minY / this.cellSize));
    const j1 = this.clampRow(Math.floor(maxY / this.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.propCells[j * this.cols + i]) found.add(id);
      }
    }
    return found;
  }

  /** Distance from a point to a segment's centreline, ignoring thickness. */
  static distanceTo(segment: Segment, x: number, y: number): number {
    return distPointToSegment({ x, y }, segment.a, segment.b);
  }

  private clampCol(i: number): number {
    return i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
  }

  private clampRow(j: number): number {
    return j < 0 ? 0 : j >= this.rows ? this.rows - 1 : j;
  }

  private *cellsForSegment(segment: Segment): Generator<number> {
    const pad = segment.thickness / 2 + 0.5;
    const i0 = this.clampCol(Math.floor((Math.min(segment.a.x, segment.b.x) - pad) / this.cellSize));
    const i1 = this.clampCol(Math.floor((Math.max(segment.a.x, segment.b.x) + pad) / this.cellSize));
    const j0 = this.clampRow(Math.floor((Math.min(segment.a.y, segment.b.y) - pad) / this.cellSize));
    const j1 = this.clampRow(Math.floor((Math.max(segment.a.y, segment.b.y) + pad) / this.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) yield j * this.cols + i;
    }
  }

  private *cellsForCircle(pos: Vec2, radius: number): Generator<number> {
    const i0 = this.clampCol(Math.floor((pos.x - radius) / this.cellSize));
    const i1 = this.clampCol(Math.floor((pos.x + radius) / this.cellSize));
    const j0 = this.clampRow(Math.floor((pos.y - radius) / this.cellSize));
    const j1 = this.clampRow(Math.floor((pos.y + radius) / this.cellSize));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) yield j * this.cols + i;
    }
  }
}
