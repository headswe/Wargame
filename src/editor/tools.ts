import type { Vec2 } from '../sim/math.ts';
import { Fabric } from '../sim/world/geometry.ts';
import {
  type DefenderKind, type Opening, type StructureOp, type TerrainOp, packRuns, unpackRuns,
} from '../sim/world/level-data.ts';
import { SURFACE_KEEP, Surface } from '../sim/world/terrain.ts';
import type { AnyOp, EditorDoc } from './document.ts';
import {
  boundsOf, centreOf, distanceTo, handlesOf, moveHandle, outlineOf, rotate, translate,
} from './shapes.ts';
import type { Viewport } from './viewport.ts';

export type ToolId =
  | 'select'
  | 'wall' | 'building' | 'revetment' | 'hedgerow' | 'obstacle'
  | 'road' | 'cut' | 'bank' | 'mound' | 'crater' | 'paint'
  | 'sculpt'
  | 'spawn-team' | 'spawn-enemy' | 'spawn-objective'
  | 'measure' | 'probe' | 'surface' | 'stamp';

/** Which tools collect a run of points before they make anything. */
const DRAFTED: Partial<Record<ToolId, { points: number; op: AnyOp['op'] }>> = {
  wall: { points: 2, op: 'wall' },
  revetment: { points: 0, op: 'revetment' },
  hedgerow: { points: 0, op: 'hedgerow' },
  road: { points: 0, op: 'road' },
  cut: { points: 0, op: 'cut' },
  bank: { points: 0, op: 'bank' },
};

export interface Defaults {
  fabric: Fabric;
  wallTop: number;
  thickness: number;
  surface: Surface;
  featureWidth: number;
  featureDepth: number;
  brushRadius: number;
  brushStrength: number;
  brushMode: 'raise' | 'smooth' | 'flatten';
  team: number;
  defender: DefenderKind;
  doors: boolean;
}

export interface ToolHostOptions {
  doc: EditorDoc;
  viewport: Viewport;
  viewSize: () => { width: number; height: number };
  defaults: () => Defaults;
  snap: () => number;
  status: (message: string) => void;
  changed: () => void;
  /** Ask for a sightline fan from here, or clear it when given null. */
  probe: (at: Vec2 | null) => void;
  /** Put the armed prefab down here. Returns false when nothing is armed. */
  stamp: (at: Vec2, turn: number) => boolean;
}

type Drag =
  | { kind: 'none' }
  | { kind: 'handle'; op: AnyOp; index: number }
  | { kind: 'translate'; from: Vec2; ops: AnyOp[]; moved: boolean }
  | { kind: 'spawn'; from: Vec2 }
  | { kind: 'box'; from: Vec2; to: Vec2 }
  | { kind: 'radius'; op: AnyOp }
  | { kind: 'rect'; from: Vec2; to: Vec2; makes: 'building' | 'paint' }
  | { kind: 'sculpt'; down: boolean }
  | { kind: 'surface'; down: boolean };

/**
 * Everything the pointer does, in one place.
 *
 * Tools share a single drag implementation because every operation has already
 * been reduced to handles and an outline. The alternative — a bespoke tool per
 * operation — is how editors end up with a road that can be moved but not
 * rotated, and a hedgerow whose last point cannot be deleted.
 */
export class ToolHost {
  tool: ToolId = 'select';
  hovered: string | null = null;
  /** Points collected so far by a drafting tool. */
  draft: Vec2[] = [];
  box: { from: Vec2; to: Vec2 } | null = null;
  /** The tape measure's two ends, once the author has put them down. */
  tape: Vec2[] = [];
  /** How far round the armed prefab is turned, in radians. */
  stampTurn = 0;

  private drag: Drag = { kind: 'none' };
  private cursor: Vec2 = { x: 0, y: 0 };

  constructor(private readonly o: ToolHostOptions) {}

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.draft = [];
    if (tool !== 'measure') this.tape = [];
    if (tool !== 'probe') this.o.probe(null);
    this.drag = { kind: 'none' };
    this.o.status(HINTS[tool] ?? '');
    this.o.changed();
  }

  // -------------------------------------------------------------- pointer

  pointerDown(px: number, py: number, mods: { shift: boolean; alt: boolean }): void {
    const at = this.pick(px, py);
    this.cursor = at;
    const { doc } = this.o;

    if (this.tool === 'measure') {
      if (this.tape.length >= 2) this.tape = [];
      this.tape.push(at);
      this.o.changed();
      return;
    }

    if (this.tool === 'probe') {
      this.o.probe(at);
      return;
    }

    if (this.tool === 'stamp') {
      if (!this.o.stamp(this.snapped(at), this.stampTurn)) {
        this.o.status('pick a piece from the palette first');
      }
      return;
    }

    if (this.tool === 'sculpt') {
      this.drag = { kind: 'sculpt', down: true };
      this.sculptAt(at, mods.alt);
      return;
    }

    if (this.tool === 'surface') {
      this.drag = { kind: 'surface', down: true };
      this.paintAt(at, mods.alt);
      return;
    }

    if (this.tool.startsWith('spawn-')) {
      this.placeSpawn(at);
      return;
    }

    const drafted = DRAFTED[this.tool];
    if (drafted) {
      this.draft.push(at);
      if (drafted.points > 0 && this.draft.length >= drafted.points) this.finishDraft();
      this.o.changed();
      return;
    }

    if (this.tool === 'building' || this.tool === 'paint') {
      this.drag = { kind: 'rect', from: at, to: at, makes: this.tool };
      return;
    }

    if (this.tool === 'obstacle' || this.tool === 'mound' || this.tool === 'crater') {
      const op = this.makeRadial(at);
      doc.edit(`add ${op.op}`, () => {
        if (op.op === 'obstacle') doc.data.structures.push(op as StructureOp);
        else doc.data.terrain.push(op as TerrainOp);
      });
      doc.select([op.id!]);
      this.drag = { kind: 'radius', op: doc.find(op.id!) ?? op };
      return;
    }

    // --- select
    const grab = this.grabRadius();
    const handle = this.handleNear(at, grab);
    if (handle) {
      this.drag = { kind: 'handle', op: handle.op, index: handle.index };
      return;
    }

    const spawn = this.spawnNear(at, grab);
    if (spawn) {
      doc.select([], spawn);
      this.drag = { kind: 'spawn', from: at };
      return;
    }

    const hit = this.opNear(at, grab);
    if (hit) {
      if (mods.shift) doc.toggle(hit.id!);
      else if (!doc.selection.ops.includes(hit.id!)) doc.select([hit.id!]);
      this.drag = { kind: 'translate', from: at, ops: doc.selectedOps, moved: false };
      return;
    }

    if (!mods.shift) doc.select([]);
    this.drag = { kind: 'box', from: at, to: at };
  }

  pointerMove(px: number, py: number, mods: { shift: boolean; alt: boolean }): void {
    const at = this.pick(px, py);
    this.cursor = at;

    switch (this.drag.kind) {
      case 'handle':
        moveHandle(this.drag.op, this.drag.index, this.snapped(at));
        this.o.changed();
        return;
      case 'radius':
        moveHandle(this.drag.op, 1, at);
        this.o.changed();
        return;
      case 'translate': {
        const dx = at.x - this.drag.from.x;
        const dy = at.y - this.drag.from.y;
        if (Math.hypot(dx, dy) > 1e-4) this.drag.moved = true;
        for (const op of this.drag.ops) translate(op, dx, dy);
        this.drag.from = at;
        this.o.changed();
        return;
      }
      case 'spawn':
        this.moveSpawn(this.snapped(at));
        this.o.changed();
        return;
      case 'box':
        this.drag.to = at;
        this.box = { from: this.drag.from, to: at };
        this.o.changed();
        return;
      case 'rect':
        this.drag.to = at;
        this.o.changed();
        return;
      case 'sculpt':
        if (this.drag.down) this.sculptAt(at, mods.alt);
        return;
      case 'surface':
        if (this.drag.down) this.paintAt(at, mods.alt);
        return;
      default:
        break;
    }

    const grab = this.grabRadius();
    const hit = this.opNear(at, grab);
    const id = hit?.id ?? null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.o.changed();
    }
  }

  pointerUp(): void {
    const { doc } = this.o;
    const drag = this.drag;
    this.drag = { kind: 'none' };

    switch (drag.kind) {
      case 'handle':
        doc.edit('move point', () => {});
        doc.refresh();
        break;
      case 'radius':
        doc.edit('resize', () => {});
        doc.refresh();
        break;
      case 'translate':
        if (drag.moved) {
          doc.edit('move', () => {});
          doc.refresh();
        }
        break;
      case 'spawn':
        doc.edit('move spawn', () => {});
        doc.refresh();
        break;
      case 'box': {
        this.box = null;
        const minX = Math.min(drag.from.x, drag.to.x);
        const maxX = Math.max(drag.from.x, drag.to.x);
        const minY = Math.min(drag.from.y, drag.to.y);
        const maxY = Math.max(drag.from.y, drag.to.y);
        if (maxX - minX < 0.5 && maxY - minY < 0.5) break;
        const inside = doc.allOps().filter((op) => {
          const b = boundsOf(op);
          return b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY;
        });
        doc.select(inside.map((op) => op.id!).filter(Boolean));
        break;
      }
      case 'rect':
        this.finishRect(drag.from, drag.to, drag.makes);
        break;
      case 'sculpt':
        doc.edit('sculpt', () => {});
        doc.refresh();
        break;
      case 'surface':
        doc.edit('paint ground', () => {});
        doc.refresh();
        break;
      default:
        break;
    }
    this.o.changed();
  }

  // ------------------------------------------------------------- keyboard

  key(event: KeyboardEvent): boolean {
    const { doc } = this.o;
    if (event.key === 'Escape') {
      if (this.draft.length > 0) this.draft = [];
      else doc.select([]);
      this.o.changed();
      return true;
    }
    if (event.key === 'Enter' && this.draft.length > 0) {
      this.finishDraft();
      return true;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    if ((event.key === '[' || event.key === ']') && this.tool === 'stamp') {
      this.stampTurn += (event.key === ']' ? 1 : -1) * Math.PI / 12;
      this.o.status(`piece turned ${Math.round(this.stampTurn * 57)}\u00b0`);
      return true;
    }
    if (event.key === '[' || event.key === ']') {
      const ops = doc.selectedOps;
      if (ops.length === 0) return false;
      const step = (event.key === ']' ? 1 : -1) * (event.shiftKey ? Math.PI / 36 : Math.PI / 12);
      const about = middleOf(ops);
      doc.edit('rotate', () => {
        for (const op of ops) rotate(op, about, step);
      });
      return true;
    }
    if (event.key.startsWith('Arrow')) {
      const ops = doc.selectedOps;
      if (ops.length === 0) return false;
      const step = event.shiftKey ? 5 : 1;
      const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      doc.edit('nudge', () => {
        for (const op of ops) translate(op, dx, dy);
      });
      return true;
    }
    if ((event.key === 'd' || event.key === 'D') && (event.ctrlKey || event.metaKey)) {
      this.duplicate();
      return true;
    }
    return false;
  }

  deleteSelection(): void {
    const { doc } = this.o;
    const ids = new Set(doc.selection.ops);
    const spawn = doc.selection.spawn;
    if (ids.size === 0 && !spawn) return;
    doc.edit('delete', () => {
      doc.data.terrain = doc.data.terrain.filter((op) => !ids.has(op.id!));
      doc.data.structures = doc.data.structures.filter((op) => !ids.has(op.id!));
      if (spawn) {
        const s = doc.data.spawns;
        if (spawn.kind === 'team') s.teams[spawn.team]?.splice(spawn.index, 1);
        if (spawn.kind === 'enemy') s.enemies.splice(spawn.index, 1);
        if (spawn.kind === 'objective') s.objectives.splice(spawn.index, 1);
      }
    });
    doc.select([]);
  }

  duplicate(): void {
    const { doc } = this.o;
    const ops = doc.selectedOps;
    if (ops.length === 0) return;
    const copies: AnyOp[] = [];
    doc.edit('duplicate', () => {
      for (const op of ops) {
        const copy = structuredClone(op) as AnyOp;
        copy.id = undefined;
        translate(copy, 3, 3);
        copies.push(copy);
        if (doc.data.terrain.includes(op as TerrainOp)) doc.data.terrain.push(copy as TerrainOp);
        else doc.data.structures.push(copy as StructureOp);
      }
    });
    doc.select(copies.map((op) => op.id!).filter(Boolean));
  }

  // -------------------------------------------------------------- creation

  private finishDraft(): void {
    const drafted = DRAFTED[this.tool];
    const points = this.draft;
    this.draft = [];
    if (!drafted || points.length < 2) {
      this.o.changed();
      return;
    }
    const d = this.o.defaults();
    const { doc } = this.o;
    let op: AnyOp;

    switch (drafted.op) {
      case 'wall':
        op = {
          op: 'wall', a: points[0], b: points[1],
          fabric: d.fabric, top: d.wallTop, thickness: d.thickness,
          openings: d.doors ? [{ at: 'centre', width: 1.1, kind: 'door' }] : [],
        };
        break;
      case 'revetment':
        op = { op: 'revetment', path: points, fabric: d.fabric, top: 0.95, thickness: 1.1 };
        break;
      case 'hedgerow':
        op = { op: 'hedgerow', path: points, radius: 1.5 };
        break;
      case 'road':
        op = { op: 'road', path: points, width: d.featureWidth, surface: Surface.Road };
        break;
      case 'cut':
        op = { op: 'cut', path: points, width: d.featureWidth, depth: d.featureDepth, surface: Surface.Mud };
        break;
      default:
        op = { op: 'bank', path: points, width: d.featureWidth, rise: d.featureDepth };
        break;
    }

    doc.edit(`add ${op.op}`, () => {
      if (op.op === 'road' || op.op === 'cut' || op.op === 'bank') {
        doc.data.terrain.push(op as TerrainOp);
      } else {
        doc.data.structures.push(op as StructureOp);
      }
    });
    doc.select([op.id!].filter(Boolean));
  }

  private finishRect(from: Vec2, to: Vec2, makes: 'building' | 'paint'): void {
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    if (maxX - minX < 1.5 || maxY - minY < 1.5) return;
    const d = this.o.defaults();
    const { doc } = this.o;

    if (makes === 'paint') {
      const op: TerrainOp = {
        op: 'paint', min: { x: minX, y: minY }, max: { x: maxX, y: maxY }, surface: d.surface,
      };
      doc.edit('paint ground', () => doc.data.terrain.push(op));
      doc.select([op.id!].filter(Boolean));
      return;
    }

    const width = maxX - minX;
    const depth = maxY - minY;
    const op: StructureOp = {
      op: 'building',
      rect: { at: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, width, depth, angle: 0 },
      fabric: d.fabric, wallTop: d.wallTop, thickness: d.thickness,
      openings: d.doors ? defaultOpenings(width, depth) : [],
    };
    doc.edit('add building', () => doc.data.structures.push(op));
    doc.select([op.id!].filter(Boolean));
  }

  private makeRadial(at: Vec2): AnyOp {
    const d = this.o.defaults();
    if (this.tool === 'obstacle') {
      return { op: 'obstacle', at, radius: 2.2, fabric: Fabric.Metal };
    }
    if (this.tool === 'crater') return { op: 'crater', at, radius: 5, depth: 1.2 };
    return { op: 'mound', at, radius: 14, peak: d.featureDepth };
  }

  // ---------------------------------------------------------------- spawns

  private placeSpawn(at: Vec2): void {
    const { doc } = this.o;
    const d = this.o.defaults();
    const p = this.snapped(at);
    doc.edit('place spawn', () => {
      const s = doc.data.spawns;
      if (this.tool === 'spawn-team') {
        while (s.teams.length <= d.team) s.teams.push([]);
        s.teams[d.team].push(p);
      } else if (this.tool === 'spawn-enemy') {
        s.enemies.push({ pos: p, kind: d.defender });
      } else {
        s.objectives.push(p);
      }
    });
  }

  private moveSpawn(to: Vec2): void {
    const { doc } = this.o;
    const at = doc.selection.spawn;
    if (!at) return;
    const s = doc.data.spawns;
    if (at.kind === 'team') s.teams[at.team][at.index] = to;
    else if (at.kind === 'enemy') s.enemies[at.index].pos = to;
    else s.objectives[at.index] = to;
  }

  private spawnNear(at: Vec2, radius: number): NonNullable<EditorDoc['selection']['spawn']> | null {
    const s = this.o.doc.data.spawns;
    let best: NonNullable<EditorDoc['selection']['spawn']> | null = null;
    let bestD = radius;
    const consider = (p: Vec2, found: NonNullable<EditorDoc['selection']['spawn']>): void => {
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d < bestD) {
        bestD = d;
        best = found;
      }
    };
    s.teams.forEach((team, t) => team.forEach((p, i) =>
      consider(p, { kind: 'team', team: t, index: i })));
    s.enemies.forEach((e, i) => consider(e.pos, { kind: 'enemy', team: 0, index: i }));
    s.objectives.forEach((p, i) => consider(p, { kind: 'objective', team: 0, index: i }));
    return best;
  }

  // --------------------------------------------------------------- sculpt

  /**
   * Raise and lower the ground freehand.
   *
   * The strokes land in a coarse control grid kept as the first terrain
   * operation, so sculpting stays part of the same ordered list as everything
   * else — a ditch cut later still cuts through whatever was sculpted, and the
   * whole level is still one serialisable document rather than a document plus
   * an opaque blob of heights.
   */
  private sculptAt(at: Vec2, lower: boolean): void {
    const { doc } = this.o;
    const d = this.o.defaults();
    const grid = ensureSculptGrid(doc);
    const scene = doc.scene;

    const stepX = doc.data.size.width / (grid.cols - 1);
    const stepY = doc.data.size.height / (grid.rows - 1);
    const radius = d.brushRadius;
    const amount = d.brushStrength * (lower ? -1 : 1);

    const i0 = Math.max(0, Math.floor((at.x - radius) / stepX));
    const i1 = Math.min(grid.cols - 1, Math.ceil((at.x + radius) / stepX));
    const j0 = Math.max(0, Math.floor((at.y - radius) / stepY));
    const j1 = Math.min(grid.rows - 1, Math.ceil((at.y + radius) / stepY));

    // Smoothing and flattening both pull towards a target rather than adding to
    // what is there: a brush that only ever adds can raise ground but can never
    // tidy it, and tidying is most of sculpting.
    const mode = d.brushMode;
    const target = mode === 'flatten'
      ? sampleGrid(grid, at.x / stepX, at.y / stepY) : 0;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dist = Math.hypot(i * stepX - at.x, j * stepY - at.y);
        if (dist > radius) continue;
        const falloff = 0.5 + 0.5 * Math.cos((dist / radius) * Math.PI);
        const k = j * grid.cols + i;
        if (mode === 'raise') {
          grid.heights[k] += amount * falloff;
        } else {
          const towards = mode === 'flatten' ? target : neighbourMean(grid, i, j);
          grid.heights[k] += (towards - grid.heights[k]) * Math.min(1, falloff * 0.35);
        }
      }
    }

    // Show it immediately by writing straight into the live heightfield. The
    // document is the truth; this is only so the brush feels like a brush.
    const t = scene.terrain;
    const pad = radius + 2;
    const ci0 = Math.max(0, Math.floor((at.x - pad) / t.spacing));
    const ci1 = Math.min(t.cols - 1, Math.ceil((at.x + pad) / t.spacing));
    const cj0 = Math.max(0, Math.floor((at.y - pad) / t.spacing));
    const cj1 = Math.min(t.rows - 1, Math.ceil((at.y + pad) / t.spacing));
    if (mode === 'raise') {
      for (let j = cj0; j <= cj1; j++) {
        for (let i = ci0; i <= ci1; i++) {
          const dist = Math.hypot(i * t.spacing - at.x, j * t.spacing - at.y);
          if (dist > radius) continue;
          const falloff = 0.5 + 0.5 * Math.cos((dist / radius) * Math.PI);
          t.heights[j * t.cols + i] += amount * falloff;
        }
      }
      scene.dirtyTerrain.push({
        minX: at.x - pad, minY: at.y - pad, maxX: at.x + pad, maxY: at.y + pad,
      });
    } else {
      // Smoothing reads from the control grid rather than from the live field,
      // so the preview cannot drift away from what will be rebuilt.
      for (let j = cj0; j <= cj1; j++) {
        for (let i = ci0; i <= ci1; i++) {
          const x = i * t.spacing;
          const y = j * t.spacing;
          if (Math.hypot(x - at.x, y - at.y) > radius) continue;
          t.heights[j * t.cols + i] = sampleGrid(grid, x / stepX, y / stepY)
            + (t.heights[j * t.cols + i] - sampleGrid(grid, x / stepX, y / stepY));
        }
      }
      scene.dirtyTerrain.push({
        minX: at.x - pad, minY: at.y - pad, maxX: at.x + pad, maxY: at.y + pad,
      });
    }
    this.o.changed();
  }

  /**
   * Brush the ground a different material.
   *
   * Strokes land in a sparse overlay grid that sits after the broad rectangles
   * in the operation list, so a painted track can wander across a ploughed
   * field without either of them having to know about the other.
   */
  private paintAt(at: Vec2, erase: boolean): void {
    const { doc } = this.o;
    const d = this.o.defaults();
    const grid = ensureSurfaceGrid(doc);
    const scene = doc.scene;

    const stepX = doc.data.size.width / (grid.cols - 1);
    const stepY = doc.data.size.height / (grid.rows - 1);
    const radius = d.brushRadius;
    const value = erase ? SURFACE_KEEP : d.surface;

    const i0 = Math.max(0, Math.floor((at.x - radius) / stepX));
    const i1 = Math.min(grid.cols - 1, Math.ceil((at.x + radius) / stepX));
    const j0 = Math.max(0, Math.floor((at.y - radius) / stepY));
    const j1 = Math.min(grid.rows - 1, Math.ceil((at.y + radius) / stepY));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (Math.hypot(i * stepX - at.x, j * stepY - at.y) > radius) continue;
        grid.cells[j * grid.cols + i] = value;
      }
    }
    grid.op.runs = packRuns(grid.cells);

    // And straight onto the live field, so the brush feels like a brush.
    if (!erase) {
      const t = scene.terrain;
      const ci0 = Math.max(0, Math.floor((at.x - radius) / t.spacing));
      const ci1 = Math.min(t.cols - 1, Math.ceil((at.x + radius) / t.spacing));
      const cj0 = Math.max(0, Math.floor((at.y - radius) / t.spacing));
      const cj1 = Math.min(t.rows - 1, Math.ceil((at.y + radius) / t.spacing));
      for (let j = cj0; j <= cj1; j++) {
        for (let i = ci0; i <= ci1; i++) {
          if (Math.hypot(i * t.spacing - at.x, j * t.spacing - at.y) > radius) continue;
          t.surface[j * t.cols + i] = value;
        }
      }
      scene.dirtyTerrain.push({
        minX: at.x - radius, minY: at.y - radius, maxX: at.x + radius, maxY: at.y + radius,
      });
    }
    this.o.changed();
  }

  // --------------------------------------------------------------- helpers

  private pick(px: number, py: number): Vec2 {
    const { width, height } = this.o.viewSize();
    return this.o.viewport.screenToWorld(px, py, width, height).world;
  }

  private snapped(p: Vec2): Vec2 {
    const step = this.o.snap();
    if (step <= 0) return p;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
  }

  private grabRadius(): number {
    return this.o.viewport.metresPerPixel(this.o.viewSize().height) * 9;
  }

  private handleNear(at: Vec2, radius: number): { op: AnyOp; index: number } | null {
    let best: { op: AnyOp; index: number } | null = null;
    let bestD = radius;
    for (const op of this.o.doc.selectedOps) {
      for (const handle of handlesOf(op)) {
        const d = Math.hypot(handle.pos.x - at.x, handle.pos.y - at.y);
        if (d < bestD) {
          bestD = d;
          best = { op, index: handle.index };
        }
      }
    }
    return best;
  }

  private opNear(at: Vec2, radius: number): AnyOp | null {
    let best: AnyOp | null = null;
    let bestD = Math.max(radius, 1.2);
    // Structures first: they are what an author is usually reaching for, and a
    // road running under a building should not win the click.
    for (const op of [...this.o.doc.data.structures, ...this.o.doc.data.terrain]) {
      if (op.muted) continue;
      const d = distanceTo(op, at);
      if (d < bestD) {
        bestD = d;
        best = op;
      }
    }
    return best;
  }

  /** What the drafting tools would make, for drawing a preview. */
  preview(): { points: Vec2[]; closed: boolean }[] {
    const runs: { points: Vec2[]; closed: boolean }[] = [];
    if (this.draft.length > 0) {
      runs.push({ points: [...this.draft, this.cursor], closed: false });
    }
    if (this.drag.kind === 'rect') {
      const { from, to } = this.drag;
      runs.push({
        points: [from, { x: to.x, y: from.y }, to, { x: from.x, y: to.y }],
        closed: true,
      });
    }
    if (this.box) {
      const { from, to } = this.box;
      runs.push({
        points: [from, { x: to.x, y: from.y }, to, { x: from.x, y: to.y }],
        closed: true,
      });
    }
    if (this.tape.length > 0) {
      runs.push({
        points: this.tape.length >= 2 ? this.tape : [this.tape[0], this.cursor],
        closed: false,
      });
    }
    if (this.tool === 'sculpt' || this.tool === 'surface') {
      const r = this.o.defaults().brushRadius;
      runs.push({
        points: Array.from({ length: 32 }, (_, i) => {
          const a = (i / 32) * Math.PI * 2;
          return { x: this.cursor.x + Math.cos(a) * r, y: this.cursor.y + Math.sin(a) * r };
        }),
        closed: true,
      });
    }
    return runs;
  }
}

/** Doors and windows a new building gets, so it is enterable from the off. */
function defaultOpenings(width: number, depth: number): (Opening & { side: number })[] {
  return [
    { side: 2, at: 'centre', width: 1.1, kind: 'door' },
    { side: 0, at: Math.max(1.2, width * 0.25), width: 1.4, kind: 'window' },
    { side: 0, at: Math.max(1.2, width * 0.75), width: 1.4, kind: 'window' },
    { side: 1, at: 'centre', width: 1.4, kind: 'window' },
    { side: 3, at: 'centre', width: 1.4, kind: 'window' },
  ].filter((o) => o.side !== 1 || depth > 4) as (Opening & { side: number })[];
}

/** The sculpting layer, created the first time somebody picks up the brush. */
function ensureSculptGrid(doc: EditorDoc): {
  cols: number; rows: number; heights: number[];
} {
  const existing = doc.data.terrain.find(
    (op): op is TerrainOp & { op: 'heightmap' } => op.op === 'heightmap' && op.name === 'sculpt',
  );
  if (existing) return existing;

  const spacing = 3;
  const cols = Math.max(2, Math.round(doc.data.size.width / spacing) + 1);
  const rows = Math.max(2, Math.round(doc.data.size.height / spacing) + 1);
  const grid: TerrainOp = {
    op: 'heightmap', name: 'sculpt', cols, rows,
    heights: new Array(cols * rows).fill(0), blend: 'add',
  };
  // First in the list: sculpting is the shape of the ground, and everything
  // else — a road riding over it, a ditch cut through it — happens on top.
  doc.data.terrain.unshift(grid);
  return grid as { cols: number; rows: number; heights: number[] };
}

/** Bilinear read from the sculpt grid, in grid coordinates. */
function sampleGrid(
  grid: { cols: number; rows: number; heights: number[] }, gx: number, gy: number,
): number {
  const i = Math.max(0, Math.min(grid.cols - 1, Math.round(gx)));
  const j = Math.max(0, Math.min(grid.rows - 1, Math.round(gy)));
  return grid.heights[j * grid.cols + i];
}

function neighbourMean(
  grid: { cols: number; rows: number; heights: number[] }, i: number, j: number,
): number {
  let total = 0;
  let n = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const x = i + di;
      const y = j + dj;
      if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
      total += grid.heights[y * grid.cols + x];
      n++;
    }
  }
  return n === 0 ? 0 : total / n;
}

/** The painted overlay, created the first time somebody picks up the brush. */
function ensureSurfaceGrid(doc: EditorDoc): {
  op: TerrainOp & { op: 'surfacemap' }; cols: number; rows: number; cells: Uint8Array;
} {
  const spacing = 1.5;
  const cols = Math.max(2, Math.round(doc.data.size.width / spacing) + 1);
  const rows = Math.max(2, Math.round(doc.data.size.height / spacing) + 1);
  let op = doc.data.terrain.find(
    (o): o is TerrainOp & { op: 'surfacemap' } => o.op === 'surfacemap' && o.name === 'painted',
  );
  if (!op || op.cols !== cols || op.rows !== rows) {
    op = {
      op: 'surfacemap', name: 'painted', cols, rows,
      runs: packRuns(new Uint8Array(cols * rows).fill(SURFACE_KEEP)),
    };
    // Last, so a brush stroke wins over the broad rectangles beneath it — which
    // is the order anybody painting expects, and the only one worth having.
    doc.data.terrain.push(op);
  }
  return { op, cols, rows, cells: unpackRuns(op.runs, cols * rows) };
}

function middleOf(ops: AnyOp[]): Vec2 {
  const centres = ops.map(centreOf);
  return {
    x: centres.reduce((a, p) => a + p.x, 0) / centres.length,
    y: centres.reduce((a, p) => a + p.y, 0) / centres.length,
  };
}

export { outlineOf };

const HINTS: Partial<Record<ToolId, string>> = {
  select: 'click to select · drag to move · handles resize · [ ] rotate · Del removes',
  wall: 'click both ends of the wall',
  building: 'drag out the footprint',
  revetment: 'click along the run · Enter to finish',
  hedgerow: 'click along the hedge · Enter to finish',
  road: 'click the centreline · Enter to finish',
  cut: 'click the ditch centreline · Enter to finish',
  bank: 'click the bank centreline · Enter to finish',
  obstacle: 'click to drop it, drag out its size',
  mound: 'click the centre, drag out its size',
  crater: 'click the centre, drag out its size',
  paint: 'drag a patch of ground',
  sculpt: 'drag to raise · hold Alt to lower',
  'spawn-team': 'click to place an operator',
  'spawn-enemy': 'click to place a defender',
  'spawn-objective': 'click to place the objective',
  surface: 'drag to paint the ground · hold Alt to lift the paint off',
  stamp: 'click to put the piece down \u00b7 [ and ] turn it',
  measure: 'click two points to measure between them',
  probe: 'click anywhere to see what a man standing there can see',
};
