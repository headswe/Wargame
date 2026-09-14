import { Fabric } from '../sim/world/geometry.ts';
import type { Opening } from '../sim/world/level-data.ts';
import { Surface } from '../sim/world/terrain.ts';
import type { AnyOp, EditorDoc } from './document.ts';
import { footprintOf, labelOf } from './shapes.ts';

/**
 * The properties of whatever is selected, described rather than hand-coded.
 *
 * Each operation says which of its fields are worth exposing and in what
 * units, and one renderer turns that into inputs. Writing a panel per operation
 * is how an editor ends up with a road whose width can be changed and a ditch
 * whose depth cannot, six months after somebody added ditches in a hurry.
 */

interface Field {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'select' | 'bool';
  step?: number;
  min?: number;
  max?: number;
  options?: { value: number | string; label: string }[];
  /** What it means, for anyone who did not write the simulation. */
  hint?: string;
}

const FABRICS = [
  { value: Fabric.Brick, label: 'brick' },
  { value: Fabric.Concrete, label: 'concrete' },
  { value: Fabric.Timber, label: 'timber' },
  { value: Fabric.Sandbag, label: 'sandbag' },
  { value: Fabric.Metal, label: 'metal' },
  { value: Fabric.Rubble, label: 'rubble' },
  { value: Fabric.Hedge, label: 'hedge' },
];

const SURFACES = [
  { value: Surface.Dirt, label: 'dirt' },
  { value: Surface.Grass, label: 'grass' },
  { value: Surface.Crop, label: 'crop' },
  { value: Surface.Road, label: 'road' },
  { value: Surface.Gravel, label: 'gravel' },
  { value: Surface.Concrete, label: 'concrete' },
  { value: Surface.Mud, label: 'mud' },
  { value: Surface.Rubble, label: 'rubble' },
  { value: Surface.Sand, label: 'sand' },
  { value: Surface.Water, label: 'water' },
];

const NAME: Field = { key: 'name', label: 'name', kind: 'text' };

function fieldsFor(op: AnyOp): Field[] {
  switch (op.op) {
    case 'wall':
      return [NAME,
        { key: 'fabric', label: 'made of', kind: 'select', options: FABRICS },
        { key: 'top', label: 'height', kind: 'number', step: 0.1, min: 0.2, hint: 'metres' },
        { key: 'thickness', label: 'thickness', kind: 'number', step: 0.05, min: 0.1 }];
    case 'building':
      return [NAME,
        { key: 'fabric', label: 'made of', kind: 'select', options: FABRICS },
        { key: 'wallTop', label: 'wall height', kind: 'number', step: 0.1, min: 0.5 },
        { key: 'thickness', label: 'thickness', kind: 'number', step: 0.05, min: 0.1 }];
    case 'revetment':
      return [NAME,
        { key: 'fabric', label: 'made of', kind: 'select', options: FABRICS },
        { key: 'top', label: 'height', kind: 'number', step: 0.05, min: 0.2,
          hint: 'under 1.2m you can shoot over it' },
        { key: 'thickness', label: 'thickness', kind: 'number', step: 0.05, min: 0.1 }];
    case 'hedgerow':
      return [NAME,
        { key: 'radius', label: 'bushiness', kind: 'number', step: 0.1, min: 0.3 },
        { key: 'spacing', label: 'spacing', kind: 'number', step: 0.1, min: 0.4 },
        { key: 'top', label: 'height', kind: 'number', step: 0.1, min: 0.3 },
        { key: 'curve', label: 'curved', kind: 'bool' }];
    case 'obstacle':
      return [NAME,
        { key: 'fabric', label: 'made of', kind: 'select', options: FABRICS },
        { key: 'radius', label: 'radius', kind: 'number', step: 0.1, min: 0.3 },
        { key: 'top', label: 'height', kind: 'number', step: 0.1, min: 0.2 }];
    case 'road':
      return [NAME,
        { key: 'width', label: 'width', kind: 'number', step: 0.5, min: 1 },
        { key: 'surface', label: 'surface', kind: 'select', options: SURFACES },
        { key: 'curve', label: 'curved', kind: 'bool' }];
    case 'cut':
      return [NAME,
        { key: 'width', label: 'width', kind: 'number', step: 0.5, min: 1 },
        { key: 'depth', label: 'depth', kind: 'number', step: 0.1, min: 0.1,
          hint: 'over 1.2m you disappear into it' },
        { key: 'surface', label: 'surface', kind: 'select', options: SURFACES },
        { key: 'curve', label: 'curved', kind: 'bool' }];
    case 'bank':
      return [NAME,
        { key: 'width', label: 'width', kind: 'number', step: 0.5, min: 1 },
        { key: 'rise', label: 'rise', kind: 'number', step: 0.1, min: 0.1 },
        { key: 'surface', label: 'surface', kind: 'select', options: SURFACES },
        { key: 'curve', label: 'curved', kind: 'bool' }];
    case 'mound':
      return [NAME,
        { key: 'radius', label: 'radius', kind: 'number', step: 1, min: 1 },
        { key: 'peak', label: 'height', kind: 'number', step: 0.2 }];
    case 'crater':
      return [NAME,
        { key: 'radius', label: 'radius', kind: 'number', step: 0.5, min: 0.5 },
        { key: 'depth', label: 'depth', kind: 'number', step: 0.1, min: 0.1 }];
    case 'paint':
      return [NAME, { key: 'surface', label: 'surface', kind: 'select', options: SURFACES }];
    case 'rolling':
      return [NAME,
        { key: 'amplitude', label: 'amplitude', kind: 'number', step: 0.1 },
        { key: 'wavelength', label: 'wavelength', kind: 'number', step: 1, min: 1 },
        { key: 'seed', label: 'seed', kind: 'number', step: 1 }];
    case 'heightmap':
      return [NAME,
        { key: 'scale', label: 'scale', kind: 'number', step: 0.1 },
        { key: 'base', label: 'base', kind: 'number', step: 0.1 }];
    default:
      return [NAME];
  }
}

export function renderInspector(host: HTMLElement, doc: EditorDoc): void {
  const ops = doc.selectedOps;
  host.innerHTML = '<h3>Properties</h3>';

  if (doc.selection.spawn) {
    const s = doc.selection.spawn;
    const what = s.kind === 'team' ? `team ${s.team + 1}, operator ${s.index + 1}`
      : s.kind === 'enemy' ? `defender ${s.index + 1}` : `objective ${s.index + 1}`;
    host.insertAdjacentHTML('beforeend', `<div class="stat"><span>${what}</span></div>`);
    if (s.kind === 'enemy') {
      const enemy = doc.data.spawns.enemies[s.index];
      const row = field({ key: 'heavy', label: 'belt-fed', kind: 'bool' }, enemy, () => {
        doc.edit('change defender', () => {});
        doc.refresh();
      });
      host.append(row);
    }
    host.insertAdjacentHTML('beforeend',
      '<div class="stat"><span>Del removes it</span></div>');
    return;
  }

  if (ops.length === 0) {
    host.insertAdjacentHTML('beforeend', '<p class="empty">Nothing selected.</p>');
    return;
  }
  if (ops.length > 1) {
    host.insertAdjacentHTML('beforeend',
      `<p class="empty">${ops.length} things selected. Drag to move, [ and ] to turn.</p>`);
    return;
  }

  const op = ops[0];
  host.insertAdjacentHTML('beforeend',
    `<div class="stat"><span>${labelOf(op)}</span><b>${op.op}</b></div>`);

  for (const f of fieldsFor(op)) {
    host.append(field(f, op as unknown as Record<string, unknown>, () => {
      doc.edit(`change ${f.label}`, () => {});
      doc.refresh();
    }));
  }

  if (op.op === 'wall' || op.op === 'building') {
    host.append(openingsPanel(doc, op));
  }
  if (op.op === 'building') {
    const corners = footprintOf(op).length;
    host.insertAdjacentHTML('beforeend',
      `<div class="stat"><span>corners</span><b>${corners}</b></div>`);
  }
}

function field(f: Field, target: Record<string, unknown>, changed: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  const label = document.createElement('label');
  label.textContent = f.label;
  if (f.hint) label.title = f.hint;
  row.append(label);

  if (f.kind === 'select') {
    const select = document.createElement('select');
    for (const option of f.options ?? []) {
      const el = document.createElement('option');
      el.value = String(option.value);
      el.textContent = option.label;
      select.append(el);
    }
    select.value = String(target[f.key] ?? f.options?.[0].value ?? '');
    select.onchange = () => {
      target[f.key] = Number(select.value);
      changed();
    };
    row.append(select);
    return row;
  }

  if (f.kind === 'bool') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = target[f.key] !== false;
    input.onchange = () => {
      target[f.key] = input.checked;
      changed();
    };
    row.append(input);
    return row;
  }

  const input = document.createElement('input');
  input.type = f.kind === 'number' ? 'number' : 'text';
  if (f.step !== undefined) input.step = String(f.step);
  if (f.min !== undefined) input.min = String(f.min);
  if (f.max !== undefined) input.max = String(f.max);
  input.value = target[f.key] === undefined ? '' : String(target[f.key]);
  input.onchange = () => {
    if (f.kind === 'number') {
      const v = Number(input.value);
      if (Number.isFinite(v)) target[f.key] = v;
    } else {
      const v = input.value.trim();
      if (v) target[f.key] = v;
      else delete target[f.key];
    }
    changed();
  };
  row.append(input);
  return row;
}

/**
 * Doors and windows, listed and editable.
 *
 * An opening belongs to a wall of a building, addressed by which wall and how
 * many metres along it — the same way an author would say it out loud, and the
 * reason the format stopped describing them as a fraction of a perimeter.
 */
function openingsPanel(
  doc: EditorDoc,
  op: AnyOp & { openings?: (Opening & { side?: number })[] },
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'openings';
  wrap.insertAdjacentHTML('beforeend', '<h3 style="margin-top:8px">Doors &amp; windows</h3>');

  const sides = op.op === 'building' ? footprintOf(op).length : 1;
  const list = op.openings ?? [];
  const commit = (label: string): void => {
    doc.edit(label, () => {});
    doc.refresh();
    renderInspector(document.getElementById('inspector')!, doc);
  };

  list.forEach((opening, i) => {
    const row = document.createElement('div');
    row.className = 'opening';

    if (op.op === 'building') {
      const side = document.createElement('select');
      for (let s = 0; s < sides; s++) {
        const el = document.createElement('option');
        el.value = String(s);
        el.textContent = `w${s}`;
        side.append(el);
      }
      side.value = String(opening.side ?? 0);
      side.onchange = () => {
        opening.side = Number(side.value);
        commit('move opening');
      };
      row.append(side);
    } else {
      row.insertAdjacentHTML('beforeend', '<span></span>');
    }

    const at = document.createElement('input');
    at.type = 'text';
    at.value = String(opening.at);
    at.title = 'metres along the wall, or "centre"';
    at.onchange = () => {
      const v = at.value.trim();
      opening.at = v === 'centre' ? 'centre' : Number(v) || 0;
      commit('move opening');
    };

    const width = document.createElement('input');
    width.type = 'number';
    width.step = '0.1';
    width.value = String(opening.width);
    width.onchange = () => {
      opening.width = Number(width.value) || 1;
      commit('resize opening');
    };

    const kind = document.createElement('select');
    for (const k of ['door', 'window'] as const) {
      const el = document.createElement('option');
      el.value = k;
      el.textContent = k;
      kind.append(el);
    }
    kind.value = opening.kind;
    kind.onchange = () => {
      opening.kind = kind.value as 'door' | 'window';
      commit('change opening');
    };

    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'remove';
    remove.onclick = () => {
      list.splice(i, 1);
      commit('remove opening');
    };

    row.append(at, width, kind, remove);
    wrap.append(row);
  });

  const add = document.createElement('button');
  add.textContent = '+ opening';
  add.onclick = () => {
    op.openings ??= [];
    op.openings.push({ side: 0, at: 'centre', width: 1.4, kind: 'window' });
    commit('add opening');
  };
  wrap.append(add);
  return wrap;
}
