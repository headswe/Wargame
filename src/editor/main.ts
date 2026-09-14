import * as THREE from 'three';
import { STEPOVE_DATA } from '../sim/levels.ts';
import {
  type LevelData, type Problem, blankLevel, migrate,
} from '../sim/world/level-data.ts';
import { Fabric } from '../sim/world/geometry.ts';
import { Surface } from '../sim/world/terrain.ts';
import { EditorDoc } from './document.ts';
import { Viewport } from './viewport.ts';
import { Overlays, type OverlayMode } from './overlays.ts';
import { ToolHost, type Defaults, type ToolId } from './tools.ts';
import { outlineOf, handlesOf, labelOf, centreOf } from './shapes.ts';
import { renderInspector } from './inspector.ts';
import { audit } from './audit.ts';

const AUTOSAVE = 'wargame.editor.level';
const PLAYTEST = 'wargame.playtest';

// ------------------------------------------------------------------ document

const doc = new EditorDoc(restore());

function restore(): LevelData {
  try {
    const saved = localStorage.getItem(AUTOSAVE);
    if (saved) return migrate(JSON.parse(saved));
  } catch {
    // A corrupt autosave must not cost the author the editor itself.
  }
  return structuredClone(STEPOVE_DATA);
}

// ------------------------------------------------------------------- canvas

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;
const viewport = new Viewport(canvas);
const overlays = new Overlays();
viewport.scene.add(overlays.mesh);
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
  team: 0,
  heavy: false,
  doors: true,
};

let overlayMode: OverlayMode = 'none';
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
    items: [{ id: 'select', label: 'Select', key: 'V' }],
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
      { id: 'paint', label: 'Surface', key: 'P' },
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
  label: string, key: keyof Defaults, options: [number, string][],
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
  select.onchange = () => { (defaults[key] as number) = Number(select.value); };
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
    case 'sample':
      doc.load(structuredClone(STEPOVE_DATA));
      viewport.frame(doc.data.size.width, doc.data.size.height);
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
    case 'playtest':
      sessionStorage.setItem(PLAYTEST, doc.toJSON());
      window.open('./index.html?playtest=1', '_blank');
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

// --------------------------------------------------------------------- go

buildToolbox();
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
    tools,
    worldToScreen: (p: { x: number; y: number }) =>
      viewport.worldToScreen(p, stage.clientWidth, stage.clientHeight),
  },
  editorReady: true,
});
