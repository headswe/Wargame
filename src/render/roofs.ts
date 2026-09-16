import * as THREE from 'three';
import earcut from 'earcut';

import type { Vec2 } from '../sim/math.ts';
import { Fabric } from '../sim/world/geometry.ts';
import type { Scene as SimScene } from '../sim/world/scene.ts';

/**
 * Roofs, and the rule for when you are allowed to see past one.
 *
 * A building without a roof is a floor plan. Every structure in this game was
 * an open box seen from above, which is why the village read as a diagram of a
 * village rather than as one — a roof is most of what a building's silhouette
 * is, and silhouette is how you recognise anything at this distance.
 *
 * The obvious cost is that half the fight happens indoors. So a roof lifts when
 * the player is *at* that building — a man of his own inside it, or close
 * enough outside to be going in — and stays on everywhere else.
 *
 * Keying it to his own men rather than to whoever is under there is what keeps
 * the fog honest. A roof that lifted for any occupant would announce an ambush
 * through the fog of war, which is the one thing fog exists to prevent; a roof
 * that lifted for any occupant the player can see does the same thing in
 * spectate, where he can see everybody, and strips the village bare before a
 * shot is fired. Asking only where his own men are cannot leak anything,
 * because he already knows.
 */

/** How far the eaves oversail the wall. Shadow, and a visible edge. */
const EAVES = 0.55;
const FADE = 4.5;
/**
 * How near a man has to be outside a building for its roof to come off.
 *
 * Far enough that stacking on a wall to go in already opens it, near enough
 * that a firefight across the street does not strip the roofs off the whole
 * street. Beyond this you are fighting a building, not fighting inside one, and
 * the markers tell you where people are.
 */
const ASSAULT_REACH = 11;
/** What is left of a roof you are looking through. Not nothing: it still reads. */
const LIFTED = 0.12;

interface Style {
  /** 0 for a flat roof with a parapet, otherwise how high the ridge stands. */
  rise: number;
  colour: number;
  /** How far the ridge is drawn in from the eaves, as a fraction of the plan. */
  inset: number;
}

/**
 * What a building of each fabric is roofed with.
 *
 * The colours are deliberately further apart than the walls are. A village
 * where every roof is the same grey is a village you read as one mass; giving
 * tile, corrugate and concrete their own colour is what lets you pick out the
 * school from across the map and say "that one" — which is the whole reason
 * this style of game puts its buildings in strong local colour.
 */
const STYLE: Partial<Record<Fabric, Style>> = {
  [Fabric.Brick]: { rise: 2.1, colour: 0x8c4a33, inset: 0.32 },
  [Fabric.Timber]: { rise: 1.9, colour: 0x7a6038, inset: 0.34 },
  [Fabric.Concrete]: { rise: 0, colour: 0x8a8a84, inset: 0 },
  [Fabric.Metal]: { rise: 1.2, colour: 0x5d6b73, inset: 0.28 },
  [Fabric.Sandbag]: { rise: 0, colour: 0x9a8b6a, inset: 0 },
};

interface Roof {
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  footprint: Vec2[];
  opacity: number;
}

export class RoofView {
  readonly group = new THREE.Group();
  private readonly roofs: Roof[] = [];

  constructor(scene: SimScene) {
    this.group.name = 'roofs';

    for (const building of scene.structures.buildings) {
      const footprint = building.footprint;
      if (footprint.length < 3) continue;

      const segments = building.segmentIds
        .map((id) => scene.structures.segments[id])
        .filter((s) => s && s.sill === 0);
      if (segments.length === 0) continue;
      const fabric = segments[0].fabric;
      const style = STYLE[fabric] ?? STYLE[Fabric.Concrete]!;
      // Sit on the tallest wall, so a building with an uneven top is still
      // covered rather than sprouting a roof through its own gable.
      const top = Math.max(...segments.map((s) => s.top));
      const ground = scene.heightAt(footprint[0].x, footprint[0].y);

      const geometry = build(footprint, ground + top, style);
      const material = new THREE.MeshLambertMaterial({
        color: style.colour,
        transparent: true,
        opacity: 1,
        // Depth writing off once it is fading, or the half-there roof punches a
        // hole in everything drawn behind it.
        depthWrite: true,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.roofs.push({ mesh, material, footprint, opacity: 1 });
    }
  }

  /**
   * Lift the roofs the player's own men have reached.
   *
   * Taking positions rather than reaching for the simulation keeps this usable
   * from the level editor, where there is no fight and every roof simply stays
   * on, which is what an author wants to look at.
   */
  update(ours: Vec2[], dt: number): void {
    for (const roof of this.roofs) {
      let wanted = 1;
      for (const at of ours) {
        if (!inside(roof.footprint, at) && awayFrom(roof.footprint, at) > ASSAULT_REACH) continue;
        wanted = LIFTED;
        break;
      }
      // Eased, because a roof that blinks off the instant a man steps through a
      // door is a flicker rather than a reveal.
      const k = Math.min(1, dt * FADE);
      roof.opacity += (wanted - roof.opacity) * k;
      roof.material.opacity = roof.opacity;
      roof.material.depthWrite = roof.opacity > 0.9;
      roof.mesh.castShadow = roof.opacity > 0.5;
    }
  }
}

/**
 * earcut triangulates in 2D, where "anticlockwise" means one thing; these
 * points are x and z of a surface whose normal should be +y, where it means the
 * other. Reversing each triangle is the whole of the conversion, and leaving it
 * out gives a roof lit from underneath that vanishes when you look down at it.
 */
function faceUp(indices: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    out.push(indices[i + 2], indices[i + 1], indices[i]);
  }
  return out;
}

/** Twice the signed area. Positive one way round, negative the other. */
function signedArea(polygon: Vec2[]): number {
  let sum = 0;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    sum += (polygon[b].x - polygon[a].x) * (polygon[b].y + polygon[a].y);
  }
  return sum;
}

/** Shortest distance from a point to a polygon's edges. */
function awayFrom(polygon: Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const u = polygon[b];
    const v = polygon[a];
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-9
      ? Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / len2))
      : 0;
    best = Math.min(best, Math.hypot(p.x - (u.x + dx * t), p.y - (u.y + dy * t)));
  }
  return best;
}

/** Even-odd point-in-polygon, the same test everything else here uses. */
function inside(polygon: Vec2[], p: Vec2): boolean {
  let hit = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const u = polygon[a];
    const v = polygon[b];
    if ((u.y > p.y) !== (v.y > p.y)
      && p.x < ((v.x - u.x) * (p.y - u.y)) / (v.y - u.y) + u.x) hit = !hit;
  }
  return hit;
}

/**
 * A roof over any closed footprint.
 *
 * The ridge is the plan drawn in toward its own centre rather than offset by a
 * constant distance along the edge bisectors. Bisector offsetting is the right
 * way to do it and it self-intersects on any awkward polygon, which for a tool
 * that lets an author drag a corner anywhere means it would fail on exactly the
 * buildings somebody took trouble over. Scaling toward the centroid cannot fold
 * in on itself at all, and on a rectangle — which is nearly every building —
 * the two agree closely enough that nobody would tell them apart.
 */
function build(plan: Vec2[], top: number, style: Style): THREE.BufferGeometry {
  /**
   * Winding first, because nothing downstream can recover from getting it
   * wrong. A footprint is whatever order the author happened to draw it in —
   * dragging a rectangle one way gives the opposite sense to dragging it the
   * other — and every triangle below is wound relative to that. Left alone, a
   * building drawn anticlockwise gets a roof with its faces pointing into the
   * ground: invisible from above, and lit as though the sun were underneath.
   * The shoelace sign is the only thing that tells the two apart.
   */
  const footprint = signedArea(plan) > 0 ? [...plan].reverse() : plan;
  const centre = footprint.reduce(
    (a, p) => ({ x: a.x + p.x / footprint.length, y: a.y + p.y / footprint.length }),
    { x: 0, y: 0 },
  );
  const eaves = footprint.map((p) => {
    const dx = p.x - centre.x;
    const dy = p.y - centre.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * EAVES, y: p.y + (dy / len) * EAVES };
  });

  const position: number[] = [];
  const index: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    position.push(x, y, z);
    return position.length / 3 - 1;
  };

  if (style.rise <= 0) {
    // Flat: a slab at eaves height with a lip round it, which is what gives a
    // flat roof an edge instead of reading as a hole in the top of the box.
    const cap = eaves.map((p) => push(p.x, top + 0.22, p.y));
    const lip = eaves.map((p) => push(p.x, top - 0.12, p.y));
    faceUp(earcut(eaves.flatMap((p) => [p.x, p.y]))).forEach((t) => index.push(cap[t]));
    for (let i = 0; i < eaves.length; i++) {
      const j = (i + 1) % eaves.length;
      index.push(cap[i], cap[j], lip[i], lip[i], cap[j], lip[j]);
    }
  } else {
    const ridge = footprint.map((p) => ({
      x: p.x + (centre.x - p.x) * style.inset * 2,
      y: p.y + (centre.y - p.y) * style.inset * 2,
    }));
    const low = eaves.map((p) => push(p.x, top, p.y));
    const high = ridge.map((p) => push(p.x, top + style.rise, p.y));
    for (let i = 0; i < eaves.length; i++) {
      const j = (i + 1) % eaves.length;
      index.push(low[i], low[j], high[i], high[i], low[j], high[j]);
    }
    faceUp(earcut(ridge.flatMap((p) => [p.x, p.y]))).forEach((t) => index.push(high[t]));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
