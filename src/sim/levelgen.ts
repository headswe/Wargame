import { type Vec2, vec } from './math.ts';
import { Rng } from './rng.ts';
import { Material, Tile, World, type EnemySpawn, type SpawnMarkers } from './world.ts';

/**
 * A paint surface for building levels out of primitives rather than ASCII.
 *
 * ASCII is unbeatable for a floorplan you want to read in a diff, but it caps
 * you at one metre of resolution and, worse, at right angles: every wall in an
 * ASCII map runs north-south or east-west, and that single fact is most of why
 * a compound reads as a puzzle grid rather than a place.
 *
 * Painting from segments lets a hedgerow run at 23 degrees. It is also the
 * shape the world wants to be eventually — vector geometry rasterised for the
 * simulation — so authoring this way now means the levels survive that change.
 */
export class LevelCanvas {
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  readonly materials: Uint8Array;
  readonly spawns: SpawnMarkers = { teams: [[], [], []], enemies: [], objectives: [] };
  readonly rng: Rng;

  constructor(width: number, height: number, seed = 1) {
    this.width = width;
    this.height = height;
    this.tiles = new Uint8Array(width * height).fill(Tile.Floor);
    this.materials = new Uint8Array(width * height).fill(Material.Dirt);
    this.rng = new Rng(seed);
  }

  /** What subsequent paint calls are made of, until changed again. */
  private material: Material = Material.Concrete;

  /** Set the material for everything painted after this call. */
  of(material: Material): this {
    this.material = material;
    return this;
  }

  private set(tx: number, ty: number, tile: Tile): void {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return;
    const i = ty * this.width + tx;
    this.tiles[i] = tile;
    this.materials[i] = tile === Tile.Floor ? this.material : this.material;
  }

  at(tx: number, ty: number): Tile {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return Tile.Wall;
    return this.tiles[ty * this.width + tx] as Tile;
  }

  /** Seal the outside so nobody wanders off the map. */
  border(thickness = 1): this {
    for (let t = 0; t < thickness; t++) {
      for (let x = 0; x < this.width; x++) {
        this.set(x, t, Tile.Wall);
        this.set(x, this.height - 1 - t, Tile.Wall);
      }
      for (let y = 0; y < this.height; y++) {
        this.set(t, y, Tile.Wall);
        this.set(this.width - 1 - t, y, Tile.Wall);
      }
    }
    return this;
  }

  rect(x: number, y: number, w: number, h: number, tile: Tile): this {
    for (let ty = Math.floor(y); ty < Math.ceil(y + h); ty++) {
      for (let tx = Math.floor(x); tx < Math.ceil(x + w); tx++) this.set(tx, ty, tile);
    }
    return this;
  }

  /**
   * A thick line between any two points. This is the primitive that breaks the
   * grid look: a fence at 23 degrees rasterises to a stepped run of tiles, and
   * at one metre the steps sit below the threshold where you read them as
   * steps rather than as a diagonal.
   */
  line(a: Vec2, b: Vec2, thickness: number, tile: Tile): this {
    const half = thickness / 2;
    const minX = Math.floor(Math.min(a.x, b.x) - half - 1);
    const maxX = Math.ceil(Math.max(a.x, b.x) + half + 1);
    const minY = Math.floor(Math.min(a.y, b.y) - half - 1);
    const maxY = Math.ceil(Math.max(a.y, b.y) + half + 1);

    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;

    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const px = tx + 0.5;
        const py = ty + 0.5;
        let t = lenSq < 1e-9 ? 0 : ((px - a.x) * abx + (py - a.y) * aby) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
        if (d <= half) this.set(tx, ty, tile);
      }
    }
    return this;
  }

  /** Chain of thick segments — a hedgerow that bends, a winding ditch. */
  polyline(points: Vec2[], thickness: number, tile: Tile): this {
    for (let i = 0; i + 1 < points.length; i++) {
      this.line(points[i], points[i + 1], thickness, tile);
    }
    return this;
  }

  disc(centre: Vec2, radius: number, tile: Tile): this {
    for (let ty = Math.floor(centre.y - radius); ty <= Math.ceil(centre.y + radius); ty++) {
      for (let tx = Math.floor(centre.x - radius); tx <= Math.ceil(centre.x + radius); tx++) {
        if (Math.hypot(tx + 0.5 - centre.x, ty + 0.5 - centre.y) <= radius) this.set(tx, ty, tile);
      }
    }
    return this;
  }

  /**
   * A building at any orientation: four walls drawn as segments, then doors and
   * windows punched through them. Interiors are left open, so rooms come from
   * adding internal walls rather than from filling and carving.
   */
  building(
    centre: Vec2,
    w: number,
    h: number,
    angle: number,
    opts: { doors?: number[]; windows?: number[]; wallThickness?: number } = {},
  ): this {
    const thickness = opts.wallThickness ?? 1.4;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corner = (sx: number, sy: number): Vec2 => {
      const lx = (sx * w) / 2;
      const ly = (sy * h) / 2;
      return vec(centre.x + lx * cos - ly * sin, centre.y + lx * sin + ly * cos);
    };

    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let i = 0; i < 4; i++) {
      this.line(corners[i], corners[(i + 1) % 4], thickness, Tile.Wall);
    }

    // Openings are placed as a fraction along the building's perimeter, so they
    // land correctly however the building is turned.
    const punch = (fractions: number[] | undefined, radius: number, tile: Tile): void => {
      for (const f of fractions ?? []) {
        const side = Math.min(3, Math.floor(f * 4));
        const local = f * 4 - side;
        const from = corners[side];
        const to = corners[(side + 1) % 4];
        this.disc(
          vec(from.x + (to.x - from.x) * local, from.y + (to.y - from.y) * local),
          radius,
          tile,
        );
      }
    };
    punch(opts.doors, thickness, Tile.Floor);
    punch(opts.windows, thickness * 0.7, Tile.Low);
    return this;
  }

  /** Drop loose cover about — crates, haystacks, wrecks. */
  scatter(x: number, y: number, w: number, h: number, count: number, tile: Tile, size = 1.4): this {
    for (let i = 0; i < count; i++) {
      const cx = this.rng.range(x, x + w);
      const cy = this.rng.range(y, y + h);
      if (this.at(Math.floor(cx), Math.floor(cy)) !== Tile.Floor) continue;
      this.disc(vec(cx, cy), this.rng.range(size * 0.6, size), tile);
    }
    return this;
  }

  team(index: number, centre: Vec2, spacing = 1.6): this {
    for (let i = 0; i < 4; i++) {
      this.spawns.teams[index].push(vec(centre.x + (i - 1.5) * spacing, centre.y));
    }
    return this;
  }

  enemy(at: Vec2, heavy = false): this {
    this.spawns.enemies.push({ pos: vec(at.x, at.y), heavy } as EnemySpawn);
    return this;
  }

  objective(at: Vec2): this {
    this.spawns.objectives.push(vec(at.x, at.y));
    return this;
  }

  toWorld(): World {
    return new World(this.width, this.height, this.tiles, this.spawns, this.materials);
  }
}
