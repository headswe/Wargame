import {
  type LevelData, type Problem, type StructureOp, type TerrainOp,
  applyLevel, assignIds, serialiseLevel, validateLevel,
} from '../sim/world/level-data.ts';
import { Scene } from '../sim/world/scene.ts';

export type AnyOp = TerrainOp | StructureOp;

/** What the author currently has hold of. */
export interface Selection {
  /** Operation ids. */
  ops: string[];
  /** A spawn marker, when one rather than an operation is selected. */
  spawn: { kind: 'team' | 'enemy' | 'objective'; team: number; index: number } | null;
}

const EMPTY: Selection = { ops: [], spawn: null };

/**
 * The level being edited, everything that has happened to it, and the world it
 * currently describes.
 *
 * Undo is whole-document snapshots rather than inverse operations. A level is a
 * few tens of kilobytes of JSON, so a hundred snapshots cost less than a single
 * texture, and the alternative — an undo method per edit — is where editors
 * grow their most embarrassing bugs: the one command out of forty whose inverse
 * is subtly wrong, found by a user who has lost an hour's work.
 *
 * Rebuilding the simulated scene is the expensive part (a third of a second for
 * a full level), and most of that is terrain. Structure edits therefore reuse
 * the ground as it was, which is what makes dragging a wall about feel like an
 * editor rather than a batch job.
 */
export class EditorDoc {
  data: LevelData;
  selection: Selection = EMPTY;
  scene: Scene;
  problems: Problem[] = [];

  private past: string[] = [];
  private future: string[] = [];
  private pending: string | null = null;
  private listeners: ((doc: EditorDoc, what: ChangeKind) => void)[] = [];

  private terrainKey = '';
  private cachedHeights: Float32Array | null = null;
  private cachedSurface: Uint8Array | null = null;

  constructor(data: LevelData) {
    this.data = assignIds(structuredClone(data));
    this.scene = this.build();
    this.problems = validateLevel(this.data);
  }

  // ----------------------------------------------------------------- events

  onChange(fn: (doc: EditorDoc, what: ChangeKind) => void): void {
    this.listeners.push(fn);
  }

  private emit(what: ChangeKind): void {
    for (const fn of this.listeners) fn(this, what);
  }

  // ------------------------------------------------------------------ edits

  /**
   * Make a change, with a label the author will recognise in the undo list.
   *
   * Nesting is allowed and collapses into the outermost edit, so a tool that
   * calls two helpers still lands in the undo stack once.
   */
  edit(label: string, change: () => void): void {
    const outer = this.pending === null;
    if (outer) this.pending = JSON.stringify(this.data);
    try {
      change();
    } finally {
      if (outer) {
        const before = this.pending!;
        this.pending = null;
        if (JSON.stringify(this.data) !== before) {
          this.past.push(before);
          if (this.past.length > 120) this.past.shift();
          this.future.length = 0;
          this.labels.push(label);
          if (this.labels.length > 120) this.labels.shift();
          this.refresh();
        }
      }
    }
  }

  private labels: string[] = [];

  get undoLabel(): string | null {
    return this.past.length > 0 ? this.labels[this.labels.length - 1] ?? 'edit' : null;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    const previous = this.past.pop();
    if (previous === undefined) return;
    this.future.push(JSON.stringify(this.data));
    this.labels.pop();
    this.data = assignIds(JSON.parse(previous) as LevelData);
    this.pruneSelection();
    this.refresh();
  }

  redo(): void {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push(JSON.stringify(this.data));
    this.data = assignIds(JSON.parse(next) as LevelData);
    this.pruneSelection();
    this.refresh();
  }

  /** Replace the whole document — opening a file, or starting a new one. */
  load(data: LevelData): void {
    this.data = assignIds(structuredClone(data));
    this.past.length = 0;
    this.future.length = 0;
    this.labels.length = 0;
    this.selection = EMPTY;
    this.terrainKey = '';
    this.refresh();
  }

  // -------------------------------------------------------------- selection

  select(ops: string[], spawn: Selection['spawn'] = null): void {
    this.selection = { ops: [...ops], spawn };
    this.emit('selection');
  }

  toggle(id: string): void {
    const ops = this.selection.ops.includes(id)
      ? this.selection.ops.filter((x) => x !== id)
      : [...this.selection.ops, id];
    this.select(ops);
  }

  get selectedOps(): AnyOp[] {
    return this.allOps().filter((op) => op.id && this.selection.ops.includes(op.id));
  }

  allOps(): AnyOp[] {
    return [...this.data.terrain, ...this.data.structures];
  }

  find(id: string): AnyOp | null {
    return this.allOps().find((op) => op.id === id) ?? null;
  }

  private pruneSelection(): void {
    const live = new Set(this.allOps().map((op) => op.id));
    this.selection = {
      ops: this.selection.ops.filter((id) => live.has(id)),
      spawn: this.selection.spawn,
    };
  }

  // --------------------------------------------------------------- rebuild

  /** Rebuild the world and revalidate. Called for you by `edit`. */
  refresh(): void {
    this.scene = this.build();
    this.problems = validateLevel(this.data);
    this.emit('world');
  }

  private build(): Scene {
    const scene = new Scene(this.data.size.width, this.data.size.height);
    const key = JSON.stringify([this.data.size, this.data.terrain]);

    if (key === this.terrainKey && this.cachedHeights && this.cachedSurface) {
      // Structures moved, the ground did not. Copying it back is two memcpys
      // against a third of a second of re-running every shaping operation.
      scene.terrain.heights.set(this.cachedHeights);
      scene.terrain.surface.set(this.cachedSurface);
      applyLevel(scene, { ...this.data, terrain: [] });
    } else {
      applyLevel(scene, this.data);
      this.terrainKey = key;
      this.cachedHeights = new Float32Array(scene.terrain.heights);
      this.cachedSurface = new Uint8Array(scene.terrain.surface);
    }

    scene.bake();
    return scene;
  }

  // -------------------------------------------------------------------- io

  toJSON(): string {
    return serialiseLevel(this.data);
  }
}

export type ChangeKind = 'world' | 'selection';
