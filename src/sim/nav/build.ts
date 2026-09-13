import type { Structures } from '../world/geometry.ts';
import type { Terrain } from '../world/terrain.ts';
import { groupIntoPolygons, simplifyLoop, traceContours } from './contour.ts';
import { NavMesh, buildNavMesh } from './navmesh.ts';
import { DEFAULT_VOXEL_OPTIONS, WalkableField, type VoxelOptions } from './voxel.ts';

export interface Navigation {
  field: WalkableField;
  mesh: NavMesh;
}

/**
 * The whole pipeline in one place: voxelise, trace, simplify, triangulate.
 *
 * It lives behind a single call because the stages are coupled in a way that
 * is easy to get wrong from outside — the erosion radius has to cover the
 * contour tolerance, or paths cut corners through walls. Wiring the stages up
 * by hand at each call site means rediscovering that every time.
 */
export function buildNavigation(
  terrain: Terrain,
  structures: Structures,
  options: Partial<VoxelOptions> = {},
): Navigation {
  const settings: VoxelOptions = { ...DEFAULT_VOXEL_OPTIONS, ...options };
  const field = new WalkableField(terrain.width, terrain.height, settings);
  field.build(terrain, structures);
  return { field, mesh: retriangulate(field, terrain, settings) };
}

/** Rebuild after destruction. The dirty box comes from whatever came down. */
export function rebuildNavigation(
  navigation: Navigation,
  terrain: Terrain,
  structures: Structures,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  options: Partial<VoxelOptions> = {},
): Navigation {
  const settings: VoxelOptions = { ...DEFAULT_VOXEL_OPTIONS, ...options };
  const changed = navigation.field.rebuildRegion(
    terrain, structures, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY,
  );
  // Nothing about where a body can stand moved, so the mesh still describes the
  // world correctly and there is no work to do.
  if (!changed) return navigation;
  return { field: navigation.field, mesh: retriangulate(navigation.field, terrain, settings) };
}

function retriangulate(field: WalkableField, terrain: Terrain, settings: VoxelOptions): NavMesh {
  const loops = traceContours(field.walkable, field.cols, field.rows, field.cellSize);
  const simplified = loops.map((loop) => ({
    ...loop,
    points: simplifyLoop(loop.points, settings.contourTolerance),
  }));
  return buildNavMesh(groupIntoPolygons(simplified), terrain.width, terrain.height);
}
