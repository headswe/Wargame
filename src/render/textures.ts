import * as THREE from 'three';

/**
 * The material textures, loaded once and shared.
 *
 * Everything here is optional by construction. If the files are missing — a
 * fresh clone before `npm run textures`, a build that dropped them, a browser
 * that fails the request — the game draws exactly what it drew before them,
 * which is flat colour that already reads. A texture is an improvement on a
 * working picture, never a requirement for one, and a renderer that shows
 * nothing because an image 404'd is worse than one that never had the image.
 *
 * Loading is asynchronous and the views are built synchronously, so materials
 * register their interest and are handed the map whenever it turns up.
 */

export type MaterialName = 'brick' | 'concrete' | 'timber' | 'metal' | 'tile' | 'shingle';

interface Loaded {
  albedo: THREE.Texture | null;
  normal: THREE.Texture | null;
  /** How many metres of wall or roof one tile of this texture covers. */
  metres: number;
}

const loaded = new Map<MaterialName, Loaded>();
const waiting = new Map<MaterialName, ((m: Loaded) => void)[]>();
let started = false;

/**
 * Hand `material` the maps for `name` once they exist.
 *
 * Returns immediately either way. The caller keeps its colour, which the
 * texture multiplies rather than replaces — so the per-fabric tints and the
 * damage colouring that were there before still do their work on top of it.
 */
export function texture(
  material: THREE.MeshLambertMaterial,
  name: MaterialName,
  repeat: number,
): void {
  begin();
  const apply = (maps: Loaded): void => {
    if (!maps.albedo) return;
    const tiles = Math.max(0.25, repeat / maps.metres);
    material.map = tiled(maps.albedo, tiles);
    // Lambert takes a normal map, and at this camera it is most of what makes
    // brick read as brick rather than as a brown rectangle.
    if (maps.normal) material.normalMap = tiled(maps.normal, tiles);
    material.needsUpdate = true;
  };
  const have = loaded.get(name);
  if (have) apply(have);
  else waiting.set(name, [...(waiting.get(name) ?? []), apply]);
}

/** A per-use clone, because two things at different scales share the image. */
function tiled(source: THREE.Texture, tiles: number): THREE.Texture {
  const copy = source.clone();
  copy.wrapS = THREE.RepeatWrapping;
  copy.wrapT = THREE.RepeatWrapping;
  copy.repeat.set(tiles, tiles);
  copy.needsUpdate = true;
  return copy;
}

function begin(): void {
  if (started) return;
  started = true;

  const loader = new THREE.TextureLoader();
  const one = (url: string): Promise<THREE.Texture | null> =>
    new Promise((resolve) => loader.load(url, resolve, undefined, () => resolve(null)));

  // Relative, so it resolves under the project subpath GitHub Pages serves
  // from as well as at the root — the same reason index.html's icon is.
  fetch('./textures/manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then(async (manifest: { materials: { name: string; metres: number }[] } | null) => {
      if (!manifest) return;
      for (const entry of manifest.materials) {
        const [albedo, normal] = await Promise.all([
          one(`./textures/${entry.name}-albedo.jpg`),
          one(`./textures/${entry.name}-normal.jpg`),
        ]);
        if (albedo) albedo.colorSpace = THREE.SRGBColorSpace;
        const maps: Loaded = { albedo, normal, metres: entry.metres };
        loaded.set(entry.name as MaterialName, maps);
        for (const fn of waiting.get(entry.name as MaterialName) ?? []) fn(maps);
        waiting.delete(entry.name as MaterialName);
      }
    })
    .catch(() => {
      // No manifest, no textures, no problem. See the note at the top.
    });
}
