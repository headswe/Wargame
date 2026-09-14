import type { Vec2 } from '../math.ts';
import { type Navigation, buildNavigation, rebuildNavigation } from '../nav/build.ts';
import { Solidity, Structures } from './geometry.ts';
import { OcclusionField, type Sighting, type Target, type Viewer, sightline } from './occlusion.ts';
import { SmokeField } from './smoke.ts';
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
  readonly smoke: SmokeField;
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
    this.smoke = new SmokeField(width, height, 0.5);
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
    return sightline(this.terrain, this.occlusion, viewer, target, maxRange, this.smoke);
  }

  /**
   * The same question with the smoke taken away.
   *
   * Cover planning has to ignore smoke: a team told to hold ground behind a
   * canister would settle there, and then be standing in the open when it
   * thinned. Smoke is for crossing, not for holding.
   */
  sightThroughSmoke(viewer: Viewer, target: Target, maxRange?: number): Sighting {
    return sightline(this.terrain, this.occlusion, viewer, target, maxRange, null);
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
  ): CoverSpot[] {
    const samples = options.samples ?? 56;
    const crouchTop = options.crouchTop ?? 1.18;
    const eye = options.eye ?? 1.04;
    const results: CoverSpot[] = [];

    const arc = this.threatArc(around, threat);

    const measure = (pos: Vec2): void => {
      if (!this.walkable(pos.x, pos.y)) return;
      const stance = this.stance(pos, arc, crouchTop, eye);
      const distance = Math.hypot(pos.x - around.x, pos.y - around.y);
      results.push({
        pos,
        ...stance,
        distance,
        score: coverScore(stance.exposure, stance.canFire, distance, radius),
      });
    };

    // The point the player actually pointed at comes first. Leaving it out is
    // what made it impossible to put a team on one specific wall: every
    // candidate sat some distance off, so the order was always a suggestion.
    measure({ ...around });

    // Then rings, which give useful spacing without spending most of the
    // budget on ground the team is already standing on.
    const rings = 4;
    for (let r = 0; r < rings; r++) {
      const ringRadius = radius * ((r + 1) / rings);
      const count = Math.max(6, Math.round(samples / rings));
      for (let k = 0; k < count; k++) {
        const angle = (k / count) * Math.PI * 2 + r * 0.7;
        measure({
          x: around.x + Math.cos(angle) * ringRadius,
          y: around.y + Math.sin(angle) * ringRadius,
        });
      }
    }

    results.sort((a, b) => a.score - b.score);
    return results;
  }

  /**
   * Where the trouble might be, rather than exactly where it is.
   *
   * Judging cover against one imaginary rifleman at one imaginary point is
   * brittle in a world with buildings in it: put him inside a wall or behind a
   * crest — which happens constantly, because he is placed by bearing and
   * range with no regard for what is there — and every candidate position
   * scores identically perfect, the ranking collapses to sampling order, and
   * the team is posted somewhere arbitrary. A short fan of points along the
   * bearing cannot all be swallowed at once, so the answer degrades gracefully
   * instead of inverting.
   */
  threatArc(around: Vec2, threat: Vec2): Vec2[] {
    const dx = threat.x - around.x;
    const dy = threat.y - around.y;
    const range = Math.hypot(dx, dy);
    if (range < 1) return [threat];
    const bearing = Math.atan2(dy, dx);

    const points: Vec2[] = [];
    // Straight ahead at the stated range and at half of it — a man behind a
    // crest is in defilade from one and not the other, which is a real and
    // important difference — plus a spread either side for the flanks.
    for (const [turn, scale] of [[0, 1], [0, 0.45], [-0.36, 0.8], [0.36, 0.8]] as const) {
      const a = bearing + turn;
      points.push(this.clampInside(
        around.x + Math.cos(a) * range * scale,
        around.y + Math.sin(a) * range * scale,
      ));
    }
    return points;
  }

  /**
   * What share of a piece of ground a man here could actually engage.
   *
   * The counterpart to `findCover`, and the question a defender should be
   * asking first: cover answers "how much of me shows", this answers "what can
   * I do about anyone out there". A position chosen only by the first is a
   * hiding place, and a line of them is not a defence.
   */
  fieldOfFire(from: Vec2, ground: Vec2[], eye = 1.04): number {
    if (ground.length === 0) return 0;
    let covered = 0;
    for (const g of ground) {
      const seen = this.sightThroughSmoke(
        { x: from.x, y: from.y, eye },
        { x: g.x, y: g.y, base: 0, top: 1.78 },
      );
      // Partial counts for what it is: seeing a man's head and shoulders over
      // a crest is a worse shot than seeing all of him, not the same one.
      covered += seen.exposure;
    }
    return covered / ground.length;
  }

  /** What standing on this patch of ground costs, against a whole threat arc. */
  stance(
    pos: Vec2, arc: Vec2[], crouchTop = 1.18, eye = 1.04,
  ): { exposure: number; canFire: boolean } {
    let exposure = 0;
    let canFire = false;
    for (const from of arc) {
      exposure += this.sightThroughSmoke(
        { x: from.x, y: from.y, eye: 1.62 },
        { x: pos.x, y: pos.y, base: 0, top: crouchTop },
      ).exposure;
      // Cover you cannot shoot out of is a hiding place, not a position.
      if (!canFire) {
        canFire = this.sightThroughSmoke(
          { x: pos.x, y: pos.y, eye },
          { x: from.x, y: from.y, base: 0, top: 1.78 },
        ).visible;
      }
    }
    return { exposure: exposure / arc.length, canFire };
  }

  private clampInside(x: number, y: number): Vec2 {
    return {
      x: Math.min(this.width - 1, Math.max(1, x)),
      y: Math.min(this.height - 1, Math.max(1, y)),
    };
  }
}

export interface CoverSpot {
  pos: Vec2;
  /** 0..1 of a crouching man that shows from the threat's direction. */
  exposure: number;
  /** Whether he could shoot back from here, or is merely hidden. */
  canFire: boolean;
  /** Metres from the point the search was centred on. */
  distance: number;
  /** Lower is better. See `coverScore`. */
  score: number;
}

/** Cover that cannot shoot is worth roughly this much exposure. */
const NO_FIRE_PENALTY = 0.45;
/** What ranging the full search radius away costs, in the same currency. */
const STRAY_PENALTY = 0.55;

/**
 * How good a fighting position is, lower being better.
 *
 * Exposure alone is not enough, and using it alone is what broke ordering a
 * team onto a particular piece of cover: the best-hidden ground within reach
 * won every time, so a click on a wall scattered the team to whatever the
 * sampler liked better, and a hole with no field of fire beat a firing
 * position with a little exposure. Distance from the order and the ability to
 * shoot are therefore priced in the same units as exposure, which makes the
 * trade explicit — a team will give up the exact spot for real cover nearby,
 * and will not give it up for a marginal improvement.
 */
function coverScore(exposure: number, canFire: boolean, distance: number, radius: number): number {
  const stray = radius <= 0 ? 0 : STRAY_PENALTY * Math.min(1, distance / radius);
  return exposure + (canFire ? 0 : NO_FIRE_PENALTY) + stray;
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
