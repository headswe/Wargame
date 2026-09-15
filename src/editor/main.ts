import * as THREE from 'three';
import { LEVEL_DATA, STEPOVE_DATA } from '../sim/levels.ts';
import {
  type LevelData, type Problem, blankLevel, migrate,
} from '../sim/world/level-data.ts';
import {
  RESERVED, idTaken, saveLevel, savedLevel, savedLevels, slugify,
} from '../library.ts';
import { Fabric } from '../sim/world/geometry.ts';
import { Surface } from '../sim/world/terrain.ts';
import { EditorDoc } from './document.ts';
import { Viewport } from './viewport.ts';
import { Overlays, SightProbe, type OverlayMode } from './overlays.ts';
import { ToolHost, type Defaults, type ToolId } from './tools.ts';
import { outlineOf, handlesOf, labelOf, centreOf } from './shapes.ts';
import { renderInspector } from './inspector.ts';
import { audit } from '../sim/world/audit.ts';
import {
  type Prefab, clipboardSize, copy, deletePrefab, paste, prefabs, savePrefab, stamp,
} from './clipboard.ts';

const AUTOSAVE = 'wargame.editor.level';
const PLAYTEST = 'wargame.playtest';

// ------------------------------------------------------------------ document

const doc = new EditorDoc(restore());

/**
 * What the editor opens on.
 *
 * `?level=<id>` wins, because it means somebody asked for something specific —
 * the picker's Edit button, or a link. Otherwise the autosave, which is "what I
 * was in the middle of" and is the overwhelmingly common case. Otherwise a
 * shipped map, because a blank 140x110 field teaches nothing about what the
 * tools are for.
 */
function restore(): LevelData {
  try {
    const wanted = new URLSearchParams(location.search).get('level');
    if (wanted) {
      const found = named(wanted);
      if (found) return found;
      console.warn(`no level called "${wanted}"`);
    }
  } catch (error) {
    console.warn('could not open that level:', error);
  }
  try {
    const saved = localStorage.getItem(AUTOSAVE);
    if (saved) return migrate(JSON.parse(saved));
  } catch {
    // A corrupt autosave must not cost the author the editor itself.
  }
  return structuredClone(STEPOVE_DATA);
}

/** A level by id, shipped or shelved. Always a copy — editing must not alias. */
function named(id: string): LevelData | null {
  const shipped = LEVEL_DATA.find((l) => l.id === id);
  if (shipped) return structuredClone(shipped);
  return savedLevel(id)?.data ?? null;
}

// ------------------------------------------------------------------- canvas

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;
const viewport = new Viewport(canvas);
const overlays = new Overlays();
const probe = new SightProbe();
viewport.scene.add(overlays.mesh, probe.mesh);
viewport.setScene(doc.scene);
viewport.frame(doc.data.size.width, doc.data.size.height);

const defaults: Defaults = {
  fabric: Fabric.Brick,
  wallTop: 2.7,
  thickness: 0.35,
  surface: Surface.Grass,
  featureWidth: 7,
  featureDepth: 1.7,
  brushRadius: 12,
  brushStrength: 0.35,
  brushMode: 'raise',
  team: 0,
  heavy: false,
  doors: true,
};

let overlayMode: OverlayMode = 'none';
let armed: Prefab | null = null;
let snap = 1;
let dirty = true;

const tools = new ToolHost({
  doc,
  viewport,
  viewSize: () => ({ width: stage.clientWidth, height: stage.clientHeight }),
  defaults: () => defaults,
  snap: () => snap,
  status: (message) => { hint.textContent = message; },
  changed: () => { dirty = true; },
  stamp: (at, turn) => {
    if (!armed) return false;
    const ids = stamp(doc, armed, at, turn);
    if (ids.length > 0) doc.select(ids);
    return true;
  },
  probe: (at) => {
    if (!at) {
      probe.clear();
    } else {
      probe.cast(doc.scene, at);
      hint.textContent =
        `a man here holds ${probe.reach.toFixed(0)}m of ground on average`;
    }
    dirty = true;
  },
});

// ------------------------------------------------------------------- panels

const toolPanel = document.getElementById('tools') as HTMLElement;
const inspector = document.getElementById('inspector') as HTMLElement;
const levelPanel = document.getElementById('level') as HTMLElement;
const outlinePanel = document.getElementById('outline') as HTMLElement;
const report = document.getElementById('report') as HTMLElement;
const readout = document.getElementById('readout') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const coords = document.getElementById('coords') as HTMLElement;

interface ToolButton { id: ToolId; label: string; key: string; }
const TOOLBOX: { heading: string; items: ToolButton[] }[] = [
  {
    heading: 'Edit',
    items: [
      { id: 'select', label: 'Select', key: 'V' },
      { id: 'measure', label: 'Measure', key: 'X' },
      { id: 'probe', label: 'Sightline', key: 'Q' },
    ],
  },
  {
    heading: 'Built',
    items: [
      { id: 'building', label: 'Building', key: 'B' },
      { id: 'wall', label: 'Wall', key: 'W' },
      { id: 'revetment', label: 'Low wall', key: 'L' },
      { id: 'obstacle', label: 'Obstacle', key: 'O' },
      { id: 'hedgerow', label: 'Hedge', key: 'H' },
    ],
  },
  {
    heading: 'Ground',
    items: [
      { id: 'sculpt', label: 'Sculpt', key: 'G' },
      { id: 'road', label: 'Road', key: 'R' },
      { id: 'cut', label: 'Ditch', key: 'D' },
      { id: 'bank', label: 'Bank', key: 'K' },
      { id: 'mound', label: 'Mound', key: 'M' },
      { id: 'crater', label: 'Crater', key: 'C' },
      { id: 'surface', label: 'Paint', key: 'U' },
      { id: 'paint', label: 'Patch', key: 'P' },
    ],
  },
  {
    heading: 'Forces',
    items: [
      { id: 'spawn-team', label: 'Operator', key: '1' },
      { id: 'spawn-enemy', label: 'Defender', key: '2' },
      { id: 'spawn-objective', label: 'Objective', key: '3' },
    ],
  },
];

function buildToolbox(): void {
  toolPanel.innerHTML = '';
  for (const group of TOOLBOX) {
    toolPanel.insertAdjacentHTML('beforeend', `<h4>${group.heading}</h4>`);
    for (const item of group.items) {
      const button = document.createElement('button');
      button.innerHTML = `${item.label}<span class="k">${item.key}</span>`;
      button.dataset.tool = item.id;
      button.onclick = () => tools.setTool(item.id);
      toolPanel.append(button);
    }
  }
  toolPanel.insertAdjacentHTML('beforeend', '<h4>Settings</h4>');
  toolPanel.append(
    numberSetting('Height', 'wallTop', 0.1),
    numberSetting('Thick', 'thickness', 0.05),
    numberSetting('Width', 'featureWidth', 0.5),
    numberSetting('Depth', 'featureDepth', 0.1),
    numberSetting('Brush', 'brushRadius', 1),
    numberSetting('Force', 'brushStrength', 0.05),
    choiceSetting('Brush does', 'brushMode', [['raise', 'raise / lower'], ['smooth', 'smooth'], ['flatten', 'flatten']]),
    choiceSetting('Made of', 'fabric', [
      [Fabric.Brick, 'brick'], [Fabric.Concrete, 'concrete'], [Fabric.Timber, 'timber'],
      [Fabric.Sandbag, 'sandbag'], [Fabric.Metal, 'metal'],
    ]),
    choiceSetting('Ground', 'surface', [
      [Surface.Grass, 'grass'], [Surface.Crop, 'crop'], [Surface.Dirt, 'dirt'],
      [Surface.Road, 'road'], [Surface.Mud, 'mud'], [Surface.Gravel, 'gravel'],
      [Surface.Concrete, 'concrete'], [Surface.Sand, 'sand'], [Surface.Water, 'water'],
    ]),
    choiceSetting('Team', 'team', [[0, 'Alpha'], [1, 'Bravo'], [2, 'Charlie']]),
    boolSetting('Belt-fed', 'heavy'),
    boolSetting('Cut doors', 'doors'),
  );
  buildPalette();
}

/**
 * The pieces kept aside for reuse.
 *
 * A village is not twenty individually designed buildings, it is one walled
 * compound and one farmhouse placed several times and turned. Somewhere to keep
 * those is the difference between an author designing a village and an author
 * rebuilding the same courtyard from scratch.
 */
function buildPalette(): void {
  const existing = document.getElementById('palette');
  existing?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'palette';
  wrap.insertAdjacentHTML('beforeend', '<h4>Pieces</h4>');

  for (const prefab of prefabs()) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span>${escape(prefab.name)}</span>` +
      `<span class="kind" title="forget it">\u00d7</span>`;
    row.onclick = (e) => {
      if ((e.target as HTMLElement).classList.contains('kind')) {
        deletePrefab(prefab.name);
        buildPalette();
        return;
      }
      armed = prefab;
      tools.stampTurn = 0;
      tools.setTool('stamp');
      hint.textContent = `${prefab.name} armed \u2014 click to place it, [ and ] to turn it`;
    };
    wrap.append(row);
  }

  const add = document.createElement('button');
  add.textContent = '+ from selection';
  add.onclick = () => {
    const name = prompt('Call this piece what?');
    if (!name) return;
    if (savePrefab(doc, name)) buildPalette();
    else hint.textContent = 'select something first';
  };
  wrap.append(add);
  toolPanel.append(wrap);
}

function numberSetting(label: string, key: keyof Defaults, step: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = `<label>${label}</label>`;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(defaults[key]);
  input.onchange = () => {
    (defaults[key] as number) = Number(input.value);
    dirty = true;
  };
  row.append(input);
  return row;
}

function choiceSetting(
  label: string, key: keyof Defaults, options: [number | string, string][],
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = `<label>${label}</label>`;
  const select = document.createElement('select');
  for (const [value, name] of options) {
    const el = document.createElement('option');
    el.value = String(value);
    el.textContent = name;
    select.append(el);
  }
  select.value = String(defaults[key]);
  const numeric = typeof options[0][0] === 'number';
  select.onchange = () => {
    (defaults[key] as unknown) = numeric ? Number(select.value) : select.value;
  };
  row.append(select);
  return row;
}

function boolSetting(label: string, key: keyof Defaults): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = `<label>${label}</label>`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(defaults[key]);
  input.onchange = () => { (defaults[key] as boolean) = input.checked; };
  row.append(input);
  return row;
}

/** The level's own settings: what it is called, how big it is, what it says. */
function renderLevel(): void {
  levelPanel.innerHTML = '<h3>Level</h3>';
  const text = (label: string, key: 'name' | 'id' | 'author' | 'brief'): HTMLElement => {
    const row = document.createElement('div');
    row.className = key === 'brief' ? 'field wide' : 'field';
    row.innerHTML = `<label>${label}</label>`;
    const input = key === 'brief'
      ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLTextAreaElement) input.rows = 3;
    input.value = String(doc.data[key] ?? '');
    input.onchange = () => {
      doc.edit(`set ${label}`, () => {
        (doc.data as unknown as Record<string, string>)[key] = input.value;
      });
    };
    row.append(input);
    return row;
  };

  const size = (label: string, key: 'width' | 'height'): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${label}</label>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '5';
    input.min = '20';
    input.value = String(doc.data.size[key]);
    input.onchange = () => {
      const v = Math.max(20, Number(input.value) || doc.data.size[key]);
      doc.edit('resize level', () => { doc.data.size[key] = v; });
      viewport.frame(doc.data.size.width, doc.data.size.height);
      dirty = true;
    };
    row.append(input);
    return row;
  };

  levelPanel.append(text('name', 'name'), text('id', 'id'), text('author', 'author'),
    size('width', 'width'), size('depth', 'height'), text('briefing', 'brief'));
}

function renderOutline(): void {
  const groups: [string, typeof doc.data.structures | typeof doc.data.terrain][] = [
    ['Structures', doc.data.structures],
    ['Ground', doc.data.terrain],
  ];
  outlinePanel.innerHTML = '<h3>Outline</h3>';
  for (const [heading, ops] of groups) {
    outlinePanel.insertAdjacentHTML('beforeend',
      `<div class="stat"><span>${heading}</span><b>${ops.length}</b></div>`);
    const list = document.createElement('div');
    list.className = 'rowlist';
    for (const op of ops) {
      const row = document.createElement('div');
      row.className = `row${doc.selection.ops.includes(op.id!) ? ' sel' : ''}`;
      row.innerHTML =
        `<span class="mute" title="show or hide">${op.muted ? '○' : '●'}</span>` +
        `<span>${labelOf(op)}</span><span class="kind">${op.op}</span>`;
      row.onclick = (e) => {
        if ((e.target as HTMLElement).classList.contains('mute')) {
          doc.edit(op.muted ? 'show' : 'hide', () => { op.muted = !op.muted; });
          return;
        }
        if (e.shiftKey) doc.toggle(op.id!);
        else doc.select([op.id!]);
      };
      row.ondblclick = () => {
        const at = centreOf(op);
        viewport.focus.set(at.x, 0, at.y);
        dirty = true;
      };
      list.append(row);
    }
    outlinePanel.append(list);
  }
}

function renderReport(): void {
  const problems: Problem[] = [...doc.problems, ...audit(doc.scene, doc.data)];
  report.innerHTML = '<h3>Checks</h3>';

  if (problems.length === 0) {
    report.insertAdjacentHTML('beforeend', '<p class="ok">Nothing wrong with it.</p>');
  } else {
    for (const p of problems.slice(0, 40)) {
      report.insertAdjacentHTML('beforeend',
        `<div class="problem ${p.severity}"><span class="sev">` +
        `${p.severity === 'error' ? 'STOP' : 'NOTE'}</span>` +
        `<span class="msg">${escape(p.message)}</span></div>`);
    }
    if (problems.length > 40) {
      report.insertAdjacentHTML('beforeend',
        `<p class="empty">and ${problems.length - 40} more</p>`);
    }
  }

  const stats = overlays.stats;
  if (stats) {
    report.insertAdjacentHTML('beforeend', '<h3 style="margin-top:9px">Ground</h3>');
    report.insertAdjacentHTML('beforeend',
      `<div class="stat"><span>covered by the defence</span><b>` +
      `${(stats.covered * 100).toFixed(0)}%</b></div>` +
      `<div class="stat"><span>nobody is watching</span><b>` +
      `${(stats.dead * 100).toFixed(0)}%</b></div>` +
      `<div class="stat"><span>rifles on you, mean</span><b>${stats.weight.toFixed(2)}</b></div>`);
  }
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
}

// ------------------------------------------------------------------ markers

const PIP = new THREE.SphereGeometry(0.55, 10, 8);
const RING = new THREE.TorusGeometry(2.4, 0.22, 8, 24);
const TEAM_COLOUR = [0x4fd2e0, 0xe0c14f, 0x9be04f];

function refreshMarkers(): void {
  viewport.setMarkers((group, heightAt) => {
    const add = (at: { x: number; y: number }, hex: number, scale: number): void => {
      const mesh = new THREE.Mesh(PIP, new THREE.MeshBasicMaterial({
        color: hex, depthTest: false, transparent: true,
      }));
      mesh.position.set(at.x, heightAt(at) + 1, at.y);
      mesh.scale.setScalar(scale);
      mesh.renderOrder = 12;
      group.add(mesh);
    };
    doc.data.spawns.teams.forEach((team, t) => {
      for (const p of team) add(p, TEAM_COLOUR[t % TEAM_COLOUR.length], 1);
    });
    for (const e of doc.data.spawns.enemies) add(e.pos, 0xff6a4d, e.heavy ? 1.6 : 1);
    for (const o of doc.data.spawns.objectives) {
      const ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({
        color: 0xf2c14e, depthTest: false, transparent: true,
      }));
      ring.position.set(o.x, heightAt(o) + 0.4, o.y);
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 12;
      group.add(ring);
    }
  });
}

// ---------------------------------------------------------------- redrawing

doc.onChange((_, what) => {
  if (what === 'world') {
    viewport.setScene(doc.scene);
    overlays.refresh(doc.scene, doc.data);
    if (probe.at) probe.cast(doc.scene, probe.at);
    save();
  }
  refreshMarkers();
  renderInspector(inspector, doc);
  renderLevel();
  renderOutline();
  renderReport();
  dirty = true;
});

function save(): void {
  try {
    localStorage.setItem(AUTOSAVE, doc.toJSON());
  } catch {
    // Out of quota, or a private window. Not worth interrupting anyone over.
  }
}

function draw(): void {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (canvas.width !== width * devicePixelRatio || canvas.height !== height * devicePixelRatio) {
    viewport.resize(width, height);
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    const selected = doc.selectedOps.flatMap(outlineOf);
    const hovered = tools.hovered && !doc.selection.ops.includes(tools.hovered)
      ? outlineOf(doc.find(tools.hovered)!) : [];
    viewport.showOutlines([...selected, ...tools.preview()], hovered);
    viewport.showHandles(doc.selectedOps.flatMap((op) => handlesOf(op).map((h) => ({ pos: h.pos }))));
    for (const button of toolPanel.querySelectorAll('button[data-tool]')) {
      button.classList.toggle('on', (button as HTMLElement).dataset.tool === tools.tool);
    }
    readout.innerHTML =
      `<b>${escape(doc.data.name)}</b>  ${doc.data.size.width}×${doc.data.size.height}m\n` +
      `${doc.data.structures.length} built  ${doc.data.terrain.length} ground  ` +
      `${doc.scene.structures.segments.length} segments`;
    viewport.render(width, height);
  }
  requestAnimationFrame(draw);
}

// ----------------------------------------------------------------- pointers

let panning = false;
let spaceHeld = false;
let orbiting = false;
let last = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  last = { x: e.clientX, y: e.clientY };
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    panning = true;
    return;
  }
  if (e.button === 2) {
    if (e.shiftKey) orbiting = true;
    else panning = true;
    return;
  }
  if (e.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  tools.pointerDown(e.clientX - rect.left, e.clientY - rect.top,
    { shift: e.shiftKey, alt: e.altKey });
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };

  if (panning) {
    viewport.pan(dx, dy, stage.clientHeight);
    dirty = true;
    return;
  }
  if (orbiting) {
    viewport.orbit(dx * 0.006, -dy * 0.005);
    dirty = true;
    return;
  }
  tools.pointerMove(e.clientX - rect.left, e.clientY - rect.top,
    { shift: e.shiftKey, alt: e.altKey });

  const at = viewport.screenToWorld(
    e.clientX - rect.left, e.clientY - rect.top, stage.clientWidth, stage.clientHeight,
  ).world;
  coords.textContent =
    `${at.x.toFixed(1)}, ${at.y.toFixed(1)} m   h ${doc.scene.heightAt(at.x, at.y).toFixed(2)}m`;
});

canvas.addEventListener('pointerup', (e) => {
  canvas.releasePointerCapture(e.pointerId);
  if (panning || orbiting) {
    panning = false;
    orbiting = false;
    return;
  }
  tools.pointerUp();
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  viewport.zoomBy(Math.sign(e.deltaY) * 0.12);
  dirty = true;
}, { passive: false });
canvas.addEventListener('dblclick', () => {
  if (tools.draft.length >= 2) tools.key(new KeyboardEvent('keydown', { key: 'Enter' }));
});

// ---------------------------------------------------------------- keyboard

const SHORTCUTS = new Map<string, ToolId>(
  TOOLBOX.flatMap((g) => g.items.map((i) => [i.key.toLowerCase(), i.id] as [string, ToolId])),
);

addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false;
});

addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (e.code === 'Space') spaceHeld = true;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doc.redo();
    else doc.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    download();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    const n = copy(doc);
    hint.textContent = n > 0 ? `copied ${n}` : 'nothing selected';
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    const ids = paste(doc, { x: viewport.focus.x, y: viewport.focus.z });
    if (ids.length > 0) doc.select(ids);
    hint.textContent = ids.length > 0
      ? `pasted ${ids.length}` : `nothing to paste (${clipboardSize()} in the clipboard)`;
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    doc.select(doc.allOps().map((op) => op.id!).filter(Boolean));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const one = doc.selection.ops[0];
    if (one) doc.reorder(one, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (tools.key(e)) {
    e.preventDefault();
    return;
  }
  const tool = SHORTCUTS.get(e.key.toLowerCase());
  if (tool) {
    tools.setTool(tool);
    return;
  }
  if (e.key.toLowerCase() === 'f') {
    viewport.frame(doc.data.size.width, doc.data.size.height);
    dirty = true;
  }
  if (e.key.toLowerCase() === 't') {
    viewport.topDown();
    dirty = true;
  }
  if (e.key === '?' || e.key === '/') toggleHelp();
});

// --------------------------------------------------------------------- menu

const fileInput = document.getElementById('file') as HTMLInputElement;

function download(): void {
  const blob = new Blob([doc.toJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${doc.data.id || 'level'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    doc.load(migrate(JSON.parse(await file.text())));
    viewport.frame(doc.data.size.width, doc.data.size.height);
  } catch (error) {
    hint.textContent = `could not open that: ${(error as Error).message}`;
  }
  fileInput.value = '';
};

/**
 * Put this level on the contract list, which is what makes it a level rather
 * than a drawing.
 *
 * It refuses on errors. The audit's errors are the ones that mean nobody can
 * play it — an unreachable objective, a man starting inside a wall, a start
 * line the defence is already shooting at — and a contract list that offers
 * those is worse than one that is short. Warnings only ask, because plenty of
 * them ("runs outside the level") are things an author does on purpose.
 */
function publish(): void {
  const problems: Problem[] = [...doc.problems, ...audit(doc.scene, doc.data)];
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length > 0) {
    alert(
      `This level will not play yet:\n\n` +
      errors.slice(0, 6).map((p) => `\u2022 ${p.message}`).join('\n') +
      (errors.length > 6 ? `\n\u2022 and ${errors.length - 6} more` : '') +
      `\n\nThe Checks panel lists them all.`,
    );
    return;
  }
  const warnings = problems.length - errors.length;
  if (warnings > 0 && !confirm(
    `${warnings} thing${warnings === 1 ? '' : 's'} worth a look in the Checks panel. Add it anyway?`,
  )) return;

  // A level needs a name a person picked. "Untitled" is not one, and the id
  // derived from it would collide with the next untitled level.
  let { name, id } = doc.data;
  if (!name.trim() || name === 'Untitled' || !id || id === 'untitled') {
    const asked = prompt('Name this contract:', name === 'Untitled' ? '' : name);
    if (asked === null) return;
    name = asked.trim();
    if (!name) return;
    id = slugify(name);
  }
  // Shipped ids are spoken for: shadowing one would make ?level=stepove mean
  // two different things depending on whose machine it is read on.
  if (RESERVED.has(id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
  if (id !== doc.data.id && idTaken(id)
    && !confirm(`There is already a level called "${id}". Replace it?`)) return;

  if (name !== doc.data.name || id !== doc.data.id) {
    doc.edit('name the level', () => { doc.data.name = name; doc.data.id = id; });
  }

  try {
    saveLevel(structuredClone(doc.data));
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
    return;
  }
  refreshLoadList();
  renderLevel();
  hint.textContent = `"${name}" is on the contract list \u2014 pick it from the game's front page.`;
}

/**
 * The shipped maps and your own, in one list.
 *
 * A dropdown rather than a button per level, because the shelf grows and the
 * menubar does not.
 */
const loadSelect = document.getElementById('load') as HTMLSelectElement;

function refreshLoadList(): void {
  const shipped = LEVEL_DATA.map((l) => `<option value="${l.id}">${escape(l.name)}</option>`);
  const mine = savedLevels().map((l) => `<option value="${l.id}">${escape(l.name)}</option>`);
  loadSelect.innerHTML =
    '<option value="">\u2014</option>' +
    `<optgroup label="Shipped">${shipped.join('')}</optgroup>` +
    (mine.length > 0 ? `<optgroup label="Yours">${mine.join('')}</optgroup>` : '');
  loadSelect.value = '';
}

loadSelect.onchange = () => {
  const id = loadSelect.value;
  loadSelect.value = '';
  if (!id) return;
  const data = named(id);
  if (!data) return;
  if (!confirm(`Open "${data.name}"? The level you have open is autosaved but will be replaced.`)) {
    return;
  }
  doc.load(data);
  viewport.frame(doc.data.size.width, doc.data.size.height);
  dirty = true;
};

document.getElementById('menubar')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (!act) return;
  switch (act) {
    case 'new':
      if (confirm('Start a new level? The current one is autosaved but will be replaced.')) {
        doc.load(blankLevel());
        viewport.frame(doc.data.size.width, doc.data.size.height);
      }
      break;
    case 'open':
      fileInput.click();
      break;
    case 'save':
      download();
      break;
    case 'undo':
      doc.undo();
      break;
    case 'redo':
      doc.redo();
      break;
    case 'top':
      viewport.topDown();
      dirty = true;
      break;
    case 'frame':
      viewport.frame(doc.data.size.width, doc.data.size.height);
      dirty = true;
      break;
    case 'help':
      toggleHelp();
      break;
    case 'playtest':
      sessionStorage.setItem(PLAYTEST, doc.toJSON());
      window.open('./index.html?playtest=1', '_blank');
      break;
    case 'publish':
      publish();
      break;
    case 'game':
      location.href = './index.html';
      break;
    default:
      break;
  }
});

(document.getElementById('overlay') as HTMLSelectElement).onchange = (e) => {
  overlayMode = (e.target as HTMLSelectElement).value as OverlayMode;
  overlays.setMode(overlayMode, doc.scene, doc.data);
  renderReport();
  dirty = true;
};
(document.getElementById('snap') as HTMLSelectElement).onchange = (e) => {
  snap = Number((e.target as HTMLSelectElement).value);
};
(document.getElementById('grid') as HTMLInputElement).onchange = (e) => {
  viewport.setGridVisible((e.target as HTMLInputElement).checked);
  dirty = true;
};

/** The shortcuts, written down where somebody might find them. */
const HELP: [string, string][] = [
  ['V  X  Q', 'select, measure, sightline probe'],
  ['B  W  L  O  H', 'building, wall, low wall, obstacle, hedge'],
  ['G  R  D  K', 'sculpt, road, ditch, bank'],
  ['M  C  U  P', 'mound, crater, paint, patch'],
  ['1  2  3', 'operator, defender, objective'],
  ['[  ]', 'turn the selection, or the armed piece'],
  ['arrows / shift', 'nudge by a metre, or five'],
  ['Delete', 'remove the selection'],
  ['Ctrl+Z  Ctrl+Shift+Z', 'undo, redo'],
  ['Ctrl+C  Ctrl+V', 'copy, paste — through storage, so it crosses levels'],
  ['Ctrl+D', 'duplicate in place'],
  ['Ctrl+A', 'select everything'],
  ['Ctrl+\u2191  Ctrl+\u2193', 'reorder — operations apply top to bottom'],
  ['F  T', 'frame the level, look straight down'],
  ['right-drag', 'pan  \u00b7  shift-right-drag orbits  \u00b7  wheel zooms'],
  ['Escape', 'drop the selection, or abandon a run being drawn'],
];

const helpPanel = document.getElementById('help') as HTMLElement;
helpPanel.innerHTML =
  '<div class="card"><h2>Level editor</h2><dl>' +
  HELP.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') +
  '</dl><p>Everything autosaves. Save writes a level file; Open reads one back; ' +
  'Load opens a shipped map or one of yours. Playtest hands the game exactly ' +
  'what is on screen, in a new tab. <b>Add to contracts</b> puts it on the ' +
  'game\u2019s front page for good \u2014 it refuses while the Checks panel ' +
  'still shows a STOP, because a contract nobody can finish is not one.</p></div>';
helpPanel.onclick = () => toggleHelp(false);

function toggleHelp(force?: boolean): void {
  helpPanel.hidden = force === undefined ? !helpPanel.hidden : !force;
}

// --------------------------------------------------------------------- go

buildToolbox();
refreshLoadList();
refreshMarkers();
renderInspector(inspector, doc);
renderLevel();
renderOutline();
renderReport();
tools.setTool('select');
draw();
// Exposed so the browser check can read the editor's own state back out
// rather than guessing from pixels.
Object.assign(window as unknown as Record<string, unknown>, {
  editor: {
    doc,
    overlays,
    probe,
    tools,
    savePrefab,
    prefabs,
    stamp,
    worldToScreen: (p: { x: number; y: number }) =>
      viewport.worldToScreen(p, stage.clientWidth, stage.clientHeight),
  },
  editorReady: true,
});
