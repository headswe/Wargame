import type { StructureOp, TerrainOp } from '../sim/world/level-data.ts';
import type { AnyOp, EditorDoc } from './document.ts';
import { centreOf, rotate, translate } from './shapes.ts';

const KEY = 'wargame.editor.clipboard';

interface Clip {
  ops: AnyOp[];
  /** Where the copied things were, so a paste can be placed relative to it. */
  origin: { x: number; y: number };
}

/**
 * Copy and paste, through storage rather than a variable.
 *
 * Going via localStorage means a piece cut from one level pastes into another
 * in a second tab, which is how anybody actually assembles a village: build the
 * compound once, and reuse it.
 */
export function copy(doc: EditorDoc): number {
  const ops = doc.selectedOps;
  if (ops.length === 0) return 0;
  const centres = ops.map(centreOf);
  const clip: Clip = {
    ops: structuredClone(ops),
    origin: {
      x: centres.reduce((a, p) => a + p.x, 0) / centres.length,
      y: centres.reduce((a, p) => a + p.y, 0) / centres.length,
    },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(clip));
  } catch {
    return 0;
  }
  return ops.length;
}

/** Paste whatever was copied, centred on `at`. Returns the new selection. */
export function paste(doc: EditorDoc, at: { x: number; y: number }): string[] {
  let clip: Clip;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    clip = JSON.parse(raw) as Clip;
  } catch {
    return [];
  }
  if (!clip.ops?.length) return [];

  const made: AnyOp[] = [];
  doc.edit('paste', () => {
    for (const source of clip.ops) {
      const op = structuredClone(source) as AnyOp;
      op.id = undefined;
      translate(op, at.x - clip.origin.x, at.y - clip.origin.y);
      made.push(op);
      if (TERRAIN.has(op.op)) doc.data.terrain.push(op as TerrainOp);
      else doc.data.structures.push(op as StructureOp);
    }
  });
  return made.map((op) => op.id!).filter(Boolean);
}

export function clipboardSize(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Clip).ops.length : 0;
  } catch {
    return 0;
  }
}

const TERRAIN = new Set([
  'heightmap', 'rolling', 'mound', 'bank', 'cut', 'road', 'paint', 'crater',
]);

// ------------------------------------------------------------------ prefabs

const PREFABS = 'wargame.editor.prefabs';

export interface Prefab {
  name: string;
  ops: AnyOp[];
  origin: { x: number; y: number };
}

/**
 * A named piece kept aside for reuse.
 *
 * A village is not twenty individually designed buildings; it is one walled
 * compound, one gun position and one farmhouse, each placed several times and
 * turned. Without somewhere to keep those, an author rebuilds the same
 * courtyard from scratch every time, and the map looks it.
 */
export function prefabs(): Prefab[] {
  try {
    return JSON.parse(localStorage.getItem(PREFABS) ?? '[]') as Prefab[];
  } catch {
    return [];
  }
}

export function savePrefab(doc: EditorDoc, name: string): boolean {
  const ops = doc.selectedOps;
  if (ops.length === 0 || !name.trim()) return false;
  const centres = ops.map(centreOf);
  const prefab: Prefab = {
    name: name.trim(),
    ops: structuredClone(ops),
    origin: {
      x: centres.reduce((a, p) => a + p.x, 0) / centres.length,
      y: centres.reduce((a, p) => a + p.y, 0) / centres.length,
    },
  };
  const all = prefabs().filter((p) => p.name !== prefab.name);
  all.push(prefab);
  try {
    localStorage.setItem(PREFABS, JSON.stringify(all));
  } catch {
    return false;
  }
  return true;
}

export function deletePrefab(name: string): void {
  try {
    localStorage.setItem(PREFABS, JSON.stringify(prefabs().filter((p) => p.name !== name)));
  } catch {
    // Nothing to be done, and nothing worth interrupting anyone over.
  }
}

/** Stamp a prefab down, optionally turned. Returns the new selection. */
export function stamp(
  doc: EditorDoc, prefab: Prefab, at: { x: number; y: number }, turn = 0,
): string[] {
  const made: AnyOp[] = [];
  doc.edit(`place ${prefab.name}`, () => {
    for (const source of prefab.ops) {
      const op = structuredClone(source) as AnyOp;
      op.id = undefined;
      if (turn !== 0) rotate(op, prefab.origin, turn);
      translate(op, at.x - prefab.origin.x, at.y - prefab.origin.y);
      made.push(op);
      if (TERRAIN.has(op.op)) doc.data.terrain.push(op as TerrainOp);
      else doc.data.structures.push(op as StructureOp);
    }
  });
  return made.map((op) => op.id!).filter(Boolean);
}
