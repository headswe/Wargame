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

  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  /**
   * The document as the undo stack last recorded it.
   *
   * Edits are compared against this rather than against a copy taken when
   * `edit` is called, because most of the editor changes the level in place
   * before it says anything: a drag moves the wall under the pointer as it
   * goes and only calls `edit('move')` on release, and the inspector writes
   * the new height straight onto the operation. A copy taken at that point
   * already contains the change, finds nothing to record, and for as long as
   * it worked that way no move, resize, sculpt, paint or property change could
   * be undone — the next undo took out whatever came before it instead.
   */
  private committed: string;
  private depth = 0;
  private listeners: ((doc: EditorDoc, what: ChangeKind) => void)[] = [];

  private terrainKey = '';
  private cachedHeights: Float32Array | null = null;
  private cachedSurface: Uint8Array | null = null;
  private cachedRibbons: Scene['terrain']['ribbons'] = [];

  constructor(data: LevelData) {
    this.data = assignIds(structuredClone(data));
    this.committed = JSON.stringify(this.data);
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
   * Whatever has changed since the last recorded edit lands under this label,
   * including changes already made in place — which is how a drag or a typed
   * value is committed: change the level, then call this with nothing to do.
   *
   * Nesting is allowed and collapses into the outermost edit, so a tool that
   * calls two helpers still lands in the undo stack once.
   */
  edit(label: string, change: () => void): void {
    this.depth++;
    try {
      change();
    } finally {
      this.depth--;
      if (this.depth === 0) {
        // Whatever was just added gets its handle now, before the tool that
        // added it goes looking for it. Without this a new operation had no id
        // until the next undo or reload: nothing could select what was just
        // drawn, and finding it by its missing id found the first other op
        // with no id — so dragging out a second obstacle resized the first.
        assignIds(this.data);
        const now = JSON.stringify(this.data);
        if (now !== this.committed) {
          this.past.push({ state: this.committed, label });
          if (this.past.length > 120) this.past.shift();
          this.future.length = 0;
          this.committed = now;
          this.refresh();
        }
      }
    }
  }

  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    const previous = this.past.pop();
    if (previous === undefined) return;
    // The label travels with the step, so redoing it puts back the name as
    // well as the change. Keeping labels in a list of their own let the two
    // drift apart, and the undo button named an edit it was not about to undo.
    this.future.push({ state: JSON.stringify(this.data), label: previous.label });
    this.restore(previous.state);
  }

  redo(): void {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push({ state: JSON.stringify(this.data), label: next.label });
    this.restore(next.state);
  }

  private restore(state: string): void {
    this.data = assignIds(JSON.parse(state) as LevelData);
    this.committed = JSON.stringify(this.data);
    this.pruneSelection();
    this.refresh();
  }

  /** Replace the whole document — opening a file, or starting a new one. */
  load(data: LevelData): void {
    // Built before it is kept. Swapping the level in first meant a file that
    // cannot be built left the editor holding it: the open failed, and every
    // edit after that failed the same way until the page was reloaded.
    const kept = {
      data: this.data, committed: this.committed,
      selection: this.selection, terrainKey: this.terrainKey,
    };
    this.data = assignIds(structuredClone(data));
    this.committed = JSON.stringify(this.data);
    this.selection = EMPTY;
    this.terrainKey = '';
    try {
      this.refresh();
    } catch (error) {
      Object.assign(this, kept);
      throw error;
    }
    this.past.length = 0;
    this.future.length = 0;
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
    // A spawn marker is addressed by position in a list, so undoing the one
    // that placed it leaves the selection pointing past the end — and the
    // inspector, reading the defender it names, fell over on nothing.
    const spawn = this.selection.spawn;
    const s = this.data.spawns;
    const exists = spawn !== null && (
      spawn.kind === 'team' ? spawn.index < (s.teams[spawn.team]?.length ?? 0)
        : spawn.kind === 'enemy' ? spawn.index < s.enemies.length
          : spawn.index < s.objectives.length);
    this.selection = {
      ops: this.selection.ops.filter((id) => live.has(id)),
      spawn: exists ? spawn : null,
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
      // The roads laid on that ground come back with it. Skipping the terrain
      // ops skips the ones that record them, so without this a road simply
      // stopped being drawn the moment anybody nudged a building — the ground
      // was right and the thing standing on it had gone.
      scene.terrain.ribbons.push(...this.cachedRibbons);
      applyLevel(scene, { ...this.data, terrain: [] });
    } else {
      applyLevel(scene, this.data);
      this.terrainKey = key;
      this.cachedHeights = new Float32Array(scene.terrain.heights);
      this.cachedSurface = new Uint8Array(scene.terrain.surface);
      this.cachedRibbons = scene.terrain.ribbons.map((r) => ({ ...r }));
    }

    scene.bake();
    return scene;
  }

  // --------------------------------------------------------------- ordering

  /**
   * Move an operation within its own list.
   *
   * Order is not presentation here: operations apply in sequence, so a road
   * laid before a ditch is cut through by it and one laid after rides over it.
   * An author who cannot reorder them cannot express the second case at all,
   * and will assume the tool is broken rather than that the list is a program.
   */
  reorder(id: string, delta: number): void {
    const list: AnyOp[] = this.data.terrain.some((op) => op.id === id)
      ? this.data.terrain : this.data.structures;
    const from = list.findIndex((op) => op.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, from + delta));
    if (to === from) return;
    this.edit('reorder', () => {
      const [op] = list.splice(from, 1);
      list.splice(to, 0, op);
    });
  }

  /** Drop an operation at an exact place in its list, for drag-and-drop. */
  moveTo(id: string, index: number): void {
    const list: AnyOp[] = this.data.terrain.some((op) => op.id === id)
      ? this.data.terrain : this.data.structures;
    const from = list.findIndex((op) => op.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, index));
    if (to === from) return;
    this.edit('reorder', () => {
      const [op] = list.splice(from, 1);
      list.splice(to, 0, op);
    });
  }

  // -------------------------------------------------------------------- io

  toJSON(): string {
    return serialiseLevel(this.data);
  }
}

export type ChangeKind = 'world' | 'selection';

interface Snapshot {
  /** The whole level, serialised. */
  state: string;
  /** What the author did to get from here to the next one. */
  label: string;
}
