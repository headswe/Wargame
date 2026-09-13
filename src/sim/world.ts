import { type Vec2, vec } from './math.ts';

export const Tile = {
  /** Open, walkable, offers nothing. */
  Floor: 0,
  /** Full-height: blocks movement, sight and bullets. */
  Wall: 1,
  /** Waist-high: blocks movement, not sight. Good cover, shootable over. */
  Low: 2,
  /** Walkable gap in a wall. Funnels movement, so it is a natural killzone. */
  Door: 3,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export const TILE_SIZE = 1;

export function blocksMove(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.Low;
}

export function blocksSight(t: Tile): boolean {
  return t === Tile.Wall;
}

/** Cover value a tile grants to someone hugging it. */
export function coverValueOf(t: Tile): number {
  if (t === Tile.Wall) return 0.8;
  if (t === Tile.Low) return 0.55;
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

  constructor(width: number, height: number, tiles: Uint8Array, spawns: SpawnMarkers) {
    this.width = width;
    this.height = height;
    this.tiles = tiles;
    this.spawns = spawns;
    this.coverIndex = new Int32Array(width * height).fill(-1);
    this.buildCoverNodes();
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

  /** Every cover node whose centre falls within `radius` of `p`. */
  coverNear(p: Vec2, radius: number): CoverNode[] {
    const out: CoverNode[] = [];
    const r = Math.ceil(radius);
    const { tx, ty } = World.toTile(p);
    for (let y = ty - r; y <= ty + r; y++) {
      for (let x = tx - r; x <= tx + r; x++) {
        const node = this.coverNodeAt(x, y);
        if (!node) continue;
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
    const dirs = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    for (let ty = 0; ty < this.height; ty++) {
      for (let tx = 0; tx < this.width; tx++) {
        if (!this.walkable(tx, ty)) continue;
        const arcs: { dir: Vec2; value: number }[] = [];
        for (const d of dirs) {
          const value = coverValueOf(this.at(tx + d.dx, ty + d.dy));
          if (value > 0) arcs.push({ dir: vec(d.dx, d.dy), value });
        }
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
