import { type Vec2, vec } from './math.ts';

const CARDINALS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
] as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const Tile = {
  /** Open, walkable, offers nothing. */
  Floor: 0,
  /** Full-height: blocks movement, sight and bullets. */
  Wall: 1,
  /** Waist-high: blocks movement, not sight. Good cover, shootable over. */
  Low: 2,
  /** Walkable gap in a wall. Funnels movement, so it is a natural killzone. */
  Door: 3,
  /**
   * What is left of a wall that has been shot to pieces. Mechanically low
   * cover, but it is the interesting half of destruction: a wall you could
   * hide behind becomes a wall you can both shoot over, and the position turns
   * from safe into a firefight without anybody moving.
   */
  Rubble: 4,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

/**
 * How much punishment each tile type takes, and how much of a bullet's damage
 * actually tells against it. Concrete shrugs off rifle rounds and needs
 * sustained automatic fire; a timber fence comes apart almost immediately.
 */
export const Material = {
  Dirt: 0,
  Concrete: 1,
  Brick: 2,
  Hedge: 3,
  Sandbag: 4,
  Timber: 5,
  Road: 6,
  Rubble: 7,
  Crop: 8,
} as const;
export type Material = (typeof Material)[keyof typeof Material];

/** What a tile is made of when the level does not say. Cosmetic only. */
export function defaultMaterial(t: Tile): Material {
  if (t === Tile.Wall) return Material.Concrete;
  if (t === Tile.Low) return Material.Sandbag;
  if (t === Tile.Rubble) return Material.Rubble;
  return Material.Dirt;
}

export const TILE_TOUGHNESS: Record<number, { hp: number; vulnerability: number }> = {
  [Tile.Floor]: { hp: Infinity, vulnerability: 0 },
  // Masonry does not fall over because you shot it. Small arms wear it down —
  // and a worn wall protects measurably less, which is the mechanic that
  // matters — but putting a hole through one takes either an obscene weight of
  // sustained fire or, properly, explosives.
  [Tile.Wall]: { hp: 300, vulnerability: 0.2 },
  // Sandbags, fences and crates are a different story. These shred.
  [Tile.Low]: { hp: 160, vulnerability: 0.6 },
  [Tile.Door]: { hp: Infinity, vulnerability: 0 },
  [Tile.Rubble]: { hp: 120, vulnerability: 0.6 },
};

/** What a tile collapses into once its hit points are gone. */
const COLLAPSES_TO: Record<number, number> = {
  [Tile.Wall]: Tile.Rubble,
  [Tile.Rubble]: Tile.Floor,
  [Tile.Low]: Tile.Floor,
};

export const TILE_SIZE = 1;

export function blocksMove(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.Low || t === Tile.Rubble;
}

export function blocksSight(t: Tile): boolean {
  return t === Tile.Wall;
}

/** Cover value a tile grants to someone hugging it, at full integrity. */
export function coverValueOf(t: Tile): number {
  if (t === Tile.Wall) return 0.8;
  if (t === Tile.Low) return 0.55;
  if (t === Tile.Rubble) return 0.45;
  return 0;
}

/**
 * A spot worth standing in: a walkable tile touching something solid, with the
 * arcs it protects you from precomputed. Node-based cover (rather than raycast
 * everywhere) is what lets the renderer draw honest "you are safe from THIS
 * direction" pips — the single biggest readability problem in isometric 3D.
 */
export interface CoverNode {
  id: number;
  pos: Vec2;
  tx: number;
  ty: number;
  /** Unit vectors pointing at the solid thing, paired with its protection. */
  arcs: { dir: Vec2; value: number }[];
  /** Best arc value, for cheap sorting. */
  best: number;
  /** Set while an operator owns or is walking to this node. */
  claimedBy: number | null;
}

export interface EnemySpawn {
  pos: Vec2;
  /** Carries the belt-fed. Placed deliberately, never left to spawn order. */
  heavy: boolean;
}

export interface SpawnMarkers {
  teams: Vec2[][];
  enemies: EnemySpawn[];
  objectives: Vec2[];
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  readonly coverNodes: CoverNode[] = [];
  /** coverNodeAt[ty * width + tx] — index into coverNodes, or -1. */
  private readonly coverIndex: Int32Array;
  readonly spawns: SpawnMarkers;

  /** Remaining integrity per tile. Falls as the tile is shot at. */
  readonly tileHp: Float32Array;
  /** What each tile is made of. Read by the renderer, never by the simulation. */
  readonly materials: Uint8Array;
  /** Tiles that changed type this tick, for the renderer to pick up. */
  readonly changedTiles: number[] = [];
  /** Tiles that have taken damage without collapsing, so wear can be drawn. */
  readonly damagedTiles = new Set<number>();

  constructor(
    width: number,
    height: number,
    tiles: Uint8Array,
    spawns: SpawnMarkers,
    materials?: Uint8Array,
  ) {
    this.width = width;
    this.height = height;
    this.tiles = tiles;
    this.spawns = spawns;
    this.coverIndex = new Int32Array(width * height).fill(-1);
    this.tileHp = new Float32Array(width * height);
    this.materials = materials ?? new Uint8Array(width * height);
    for (let i = 0; i < tiles.length; i++) {
      this.tileHp[i] = TILE_TOUGHNESS[tiles[i]]?.hp ?? Infinity;
      if (!materials) this.materials[i] = defaultMaterial(tiles[i] as Tile);
    }
    this.buildCoverNodes();
  }

  /** 0..1 — how much of this tile is still standing. */
  integrityAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 1;
    const i = ty * this.width + tx;
    const max = TILE_TOUGHNESS[this.tiles[i]]?.hp ?? Infinity;
    if (!Number.isFinite(max)) return 1;
    return clamp01(this.tileHp[i] / max);
  }

  /**
   * Put rounds into a tile. Returns true if it collapsed into whatever it
   * leaves behind — a wall into rubble, rubble into open ground. Sustained
   * fire therefore opens a breach in two stages, and the intermediate stage is
   * the interesting one: cover both sides can shoot over.
   */
  damageTile(tx: number, ty: number, amount: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.width + tx;
    const tile = this.tiles[i] as Tile;
    const toughness = TILE_TOUGHNESS[tile];
    if (!toughness || !Number.isFinite(toughness.hp) || toughness.vulnerability <= 0) return false;

    this.tileHp[i] -= amount * toughness.vulnerability;
    this.damagedTiles.add(i);
    if (this.tileHp[i] > 0) return false;

    const next = COLLAPSES_TO[tile];
    if (next === undefined) {
      this.tileHp[i] = 0;
      return false;
    }
    this.setTile(tx, ty, next as Tile);
    return true;
  }

  /**
   * Change a tile and repair the cover graph around it. Only the tile and its
   * four cardinal neighbours can be affected, so this stays O(1) however big
   * the map gets.
   */
  setTile(tx: number, ty: number, tile: Tile): void {
    if (!this.inBounds(tx, ty)) return;
    const i = ty * this.width + tx;
    if (this.tiles[i] === tile) return;

    this.tiles[i] = tile;
    this.tileHp[i] = TILE_TOUGHNESS[tile]?.hp ?? Infinity;
    if (tile === Tile.Rubble) this.materials[i] = Material.Rubble;
    this.changedTiles.push(i);
    // Nothing is draining this when the simulation runs headless, so keep it
    // from growing without bound over a long soak.
    if (this.changedTiles.length > 4096) this.changedTiles.splice(0, 2048);

    this.rebuildCoverAt(tx, ty);
    for (const d of CARDINALS) this.rebuildCoverAt(tx + d.dx, ty + d.dy);
  }

  /**
   * Recompute one tile's cover node in place. Existing nodes are kept and
   * emptied rather than removed, because operators hold references to them —
   * deleting one out from under a man in cover is how you get a crash mid
   * firefight.
   */
  private rebuildCoverAt(tx: number, ty: number): void {
    if (!this.inBounds(tx, ty)) return;
    const index = this.coverIndex[ty * this.width + tx];
    const arcs = this.walkable(tx, ty) ? this.arcsAt(tx, ty) : [];

    if (index < 0) {
      if (arcs.length === 0) return;
      const node: CoverNode = {
        id: this.coverNodes.length,
        pos: World.centre(tx, ty),
        tx,
        ty,
        arcs,
        best: Math.max(...arcs.map((a) => a.value)),
        claimedBy: null,
      };
      this.coverIndex[ty * this.width + tx] = this.coverNodes.length;
      this.coverNodes.push(node);
      return;
    }

    const node = this.coverNodes[index];
    node.arcs = arcs;
    node.best = arcs.length === 0 ? 0 : Math.max(...arcs.map((a) => a.value));
    // Cover that no longer exists should not stay reserved.
    if (arcs.length === 0) node.claimedBy = null;
  }

  private arcsAt(tx: number, ty: number): { dir: Vec2; value: number }[] {
    const arcs: { dir: Vec2; value: number }[] = [];
    for (const d of CARDINALS) {
      const value = coverValueOf(this.at(tx + d.dx, ty + d.dy));
      if (value > 0) arcs.push({ dir: vec(d.dx, d.dy), value });
    }
    return arcs;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  at(tx: number, ty: number): Tile {
    if (!this.inBounds(tx, ty)) return Tile.Wall;
    return this.tiles[ty * this.width + tx] as Tile;
  }

  walkable(tx: number, ty: number): boolean {
    return this.inBounds(tx, ty) && !blocksMove(this.at(tx, ty));
  }

  /** World position of a tile's centre. */
  static centre(tx: number, ty: number): Vec2 {
    return vec(tx + 0.5, ty + 0.5);
  }

  static toTile(p: Vec2): { tx: number; ty: number } {
    return { tx: Math.floor(p.x), ty: Math.floor(p.y) };
  }

  coverNodeAt(tx: number, ty: number): CoverNode | null {
    if (!this.inBounds(tx, ty)) return null;
    const i = this.coverIndex[ty * this.width + tx];
    return i < 0 ? null : this.coverNodes[i];
  }

  /** Every usable cover node whose centre falls within `radius` of `p`. */
  coverNear(p: Vec2, radius: number): CoverNode[] {
    const out: CoverNode[] = [];
    const r = Math.ceil(radius);
    const { tx, ty } = World.toTile(p);
    for (let y = ty - r; y <= ty + r; y++) {
      for (let x = tx - r; x <= tx + r; x++) {
        const node = this.coverNodeAt(x, y);
        if (!node || node.arcs.length === 0) continue;
        const dx = node.pos.x - p.x;
        const dy = node.pos.y - p.y;
        if (dx * dx + dy * dy <= radius * radius) out.push(node);
      }
    }
    return out;
  }

  /**
   * A walkable tile adjacent to solid geometry becomes a cover node. Only the
   * four cardinal neighbours count: hugging a corner diagonally does not put
   * anything between you and a bullet.
   */
  private buildCoverNodes(): void {
    for (let ty = 0; ty < this.height; ty++) {
      for (let tx = 0; tx < this.width; tx++) {
        if (!this.walkable(tx, ty)) continue;
        const arcs = this.arcsAt(tx, ty);
        if (arcs.length === 0) continue;
        const node: CoverNode = {
          id: this.coverNodes.length,
          pos: World.centre(tx, ty),
          tx,
          ty,
          arcs,
          best: Math.max(...arcs.map((a) => a.value)),
          claimedBy: null,
        };
        this.coverIndex[ty * this.width + tx] = this.coverNodes.length;
        this.coverNodes.push(node);
      }
    }
  }

  releaseClaims(unitId: number): void {
    for (const n of this.coverNodes) {
      if (n.claimedBy === unitId) n.claimedBy = null;
    }
  }
}

const GLYPHS: Record<string, Tile> = {
  '.': Tile.Floor,
  ' ': Tile.Floor,
  '#': Tile.Wall,
  o: Tile.Low,
  '+': Tile.Door,
  // A firing port is just low cover set into a wall: you cannot walk through
  // it, you can see and shoot through it, and it protects whoever is behind.
  '"': Tile.Low,
  ':': Tile.Rubble,
};

/**
 * Levels are ASCII art. Keeping them as text means a map is a diff you can read
 * in a pull request, and editing one needs nothing but a keyboard.
 */
export function parseLevel(rows: string[]): World {
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const tiles = new Uint8Array(width * height);
  const spawns: SpawnMarkers = { teams: [[], [], []], enemies: [], objectives: [] };

  for (let ty = 0; ty < height; ty++) {
    const row = rows[ty];
    for (let tx = 0; tx < width; tx++) {
      const ch = tx < row.length ? row[tx] : '#';
      let tile = GLYPHS[ch];
      if (tile === undefined) {
        // Markers sit on open floor.
        tile = Tile.Floor;
        const centre = World.centre(tx, ty);
        if (ch === '1' || ch === '2' || ch === '3') {
          spawns.teams[Number(ch) - 1].push(centre);
        } else if (ch === 'e' || ch === 'E') {
          spawns.enemies.push({ pos: centre, heavy: ch === 'E' });
        } else if (ch === 'X') {
          spawns.objectives.push(centre);
        }
      }
      tiles[ty * width + tx] = tile;
    }
  }

  return new World(width, height, tiles, spawns);
}
