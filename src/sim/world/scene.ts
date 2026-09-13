import type { Vec2 } from '../math.ts';
import { type Navigation, buildNavigation, rebuildNavigation } from '../nav/build.ts';
import { Solidity, Structures } from './geometry.ts';
import { OcclusionField, type Sighting, type Target, type Viewer, sightline } from './occlusion.ts';
import { Terrain } from './terrain.ts';

export interface Spawns {
  teams: Vec2[][];
  enemies: { pos: Vec2; heavy: boolean }[];
  objectives: Vec2[];
}

/**
 * Everything the simulation asks about the world, behind one object.
 *
 * The four layers underneath — ground, structures, what blocks a sightline,
 * and where a body can walk — have to be kept in step when something is
 * destroyed, and getting that wrong is silent: paths route through a wall that
 * is still standing, or fire passes through one that already fell. Funnelling
 * every change through here is what keeps them honest.
 */
export class Scene {
  readonly terrain: Terrain;
  readonly structures: Structures;
  readonly occlusion: OcclusionField;
  navigation: Navigation;
  readonly spawns: Spawns = { teams: [[], [], []], enemies: [], objectives: [] };

  /** Regions changed since the renderer last looked. */
  readonly dirtyTerrain: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  /** Segments and props that changed state, for the renderer to redraw. */
  readonly dirtySegments = new Set<number>();
  readonly dirtyProps = new Set<number>();

  constructor(width: number, height: number) {
    this.terrain = new Terrain(width, height, 0.5);
    this.structures = new Structures(width, height);
    this.occlusion = new OcclusionField(width, height, 0.5);
    this.navigation = { field: null as never, mesh: null as never };
  }

  get width(): number {
    return this.terrain.width;
  }

  get height(): number {
    return this.terrain.height;
  }

  /** Call once the level has finished painting terrain and structures. */
  bake(): void {
    this.occlusion.build(this.terrain, this.structures);
    this.navigation = buildNavigation(this.terrain, this.structures);
  }

  heightAt(x: number, y: number): number {
    return this.terrain.heightAt(x, y);
  }

  walkable(x: number, y: number): boolean {
    return this.navigation.field.containsPoint(x, y);
  }

  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    return this.navigation.mesh.findPath(from, to);
  }

  sight(viewer: Viewer, target: Target, maxRange?: number): Sighting {
    return sightline(this.terrain, this.occlusion, viewer, target, maxRange);
  }

  /**
   * Put a round into whatever is standing at this point. Returns true if
   * something came down, which is the signal that navigation has to be redone.
   */
  hit(x: number, y: number, amount: number): boolean {
    const { segment, prop } = this.occlusion.occupantAt(x, y);
    let collapsed = false;

    if (segment >= 0) {
      collapsed = this.structures.damageSegment(segment, amount);
      this.dirtySegments.add(segment);
    } else if (prop >= 0) {
      collapsed = this.structures.damageProp(prop, amount);
      this.dirtyProps.add(prop);
    }
    if (!collapsed) return false;

    const bounds = segment >= 0
      ? boundsOfSegment(this.structures.segments[segment])
      : boundsOfProp(this.structures.props[prop]);
    this.rebuild(bounds);
    return true;
  }

  /** Deform the ground and redo everything that depends on its shape. */
  crater(centre: Vec2, radius: number, depth: number): void {
    this.terrain.crater(centre, radius, depth);
    const pad = radius * 1.5;
    this.rebuild({
      minX: centre.x - pad, minY: centre.y - pad,
      maxX: centre.x + pad, maxY: centre.y + pad,
    });
    this.dirtyTerrain.push({
      minX: centre.x - pad, minY: centre.y - pad,
      maxX: centre.x + pad, maxY: centre.y + pad,
    });
  }

  private rebuild(bounds: { minX: number; minY: number; maxX: number; maxY: number }): void {
    this.occlusion.rebuild(
      this.terrain, this.structures, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY,
    );
    this.navigation = rebuildNavigation(
      this.navigation, this.terrain, this.structures, bounds,
    );
  }

  /**
   * Positions worth standing in near a point, best first.
   *
   * This replaces the old table of cover nodes. Rather than asking a lookup
   * where the cover is, it asks the only question that matters — how much of me
   * would show from over there — by sampling candidate stances and measuring
   * each one. Terrain, walls, ditches and crests are therefore all considered
   * without any of them being handled specially.
   */
  findCover(
    around: Vec2,
    radius: number,
    threat: Vec2,
    options: { samples?: number; crouchTop?: number; eye?: number } = {},
  ): { pos: Vec2; exposure: number; canFire: boolean }[] {
    const samples = options.samples ?? 56;
    const crouchTop = options.crouchTop ?? 1.18;
    const eye = options.eye ?? 1.04;
    const results: { pos: Vec2; exposure: number; canFire: boolean }[] = [];

    // A ring layout rather than a grid: it puts candidates at useful spacing
    // without wasting most of them on ground the team is already standing on.
    const rings = 4;
    for (let r = 0; r < rings; r++) {
      const ringRadius = radius * ((r + 1) / rings);
      const count = Math.max(6, Math.round(samples / rings));
      for (let k = 0; k < count; k++) {
        const angle = (k / count) * Math.PI * 2 + r * 0.7;
        const pos = {
          x: around.x + Math.cos(angle) * ringRadius,
          y: around.y + Math.sin(angle) * ringRadius,
        };
        if (!this.walkable(pos.x, pos.y)) continue;

        const hiding = this.sight(
          { x: threat.x, y: threat.y, eye: 1.62 },
          { x: pos.x, y: pos.y, base: 0, top: crouchTop },
        );
        // Cover you cannot shoot out of is a hiding place, not a position.
        const shooting = this.sight(
          { x: pos.x, y: pos.y, eye },
          { x: threat.x, y: threat.y, base: 0, top: 1.78 },
        );
        results.push({ pos, exposure: hiding.exposure, canFire: shooting.visible });
      }
    }

    results.sort((a, b) => {
      const scoreA = a.exposure - (a.canFire ? 0.35 : 0);
      const scoreB = b.exposure - (b.canFire ? 0.35 : 0);
      return scoreA - scoreB;
    });
    return results;
  }
}

function boundsOfSegment(s: Structures['segments'][number]) {
  const pad = s.thickness + 1;
  return {
    minX: Math.min(s.a.x, s.b.x) - pad,
    minY: Math.min(s.a.y, s.b.y) - pad,
    maxX: Math.max(s.a.x, s.b.x) + pad,
    maxY: Math.max(s.a.y, s.b.y) + pad,
  };
}

function boundsOfProp(p: Structures['props'][number]) {
  const pad = p.radius + 1;
  return {
    minX: p.pos.x - pad, minY: p.pos.y - pad,
    maxX: p.pos.x + pad, maxY: p.pos.y + pad,
  };
}

export { Solidity };
