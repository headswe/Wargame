/**
 * The editor's document, which is the part of the editor that can lose work.
 *
 * Headless on purpose: undo is bookkeeping over a level, and a check that needs
 * Chromium to find out whether a drag can be taken back is one that does not
 * get run. `npm run editor-check` covers the same ground through the real UI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditorDoc } from '../src/editor/document.ts';
import { type StructureOp, blankLevel, migrate, packRuns } from '../src/sim/world/level-data.ts';
import { Fabric } from '../src/sim/world/geometry.ts';

function withWall(): { doc: EditorDoc; wall: StructureOp & { op: 'wall' } } {
  const doc = new EditorDoc(blankLevel());
  doc.edit('add wall', () => {
    doc.data.structures.push({
      op: 'wall', a: { x: 20, y: 40 }, b: { x: 40, y: 40 },
      fabric: Fabric.Brick, top: 2, thickness: 0.3,
    });
  });
  return { doc, wall: doc.data.structures[0] as StructureOp & { op: 'wall' } };
}

test('a change made in place and then committed can be undone on its own', () => {
  // How a drag and the inspector both work: the level changes under the
  // pointer, and `edit` is called afterwards with nothing left to do.
  const { doc, wall } = withWall();
  wall.a.x = 25;
  wall.b.x = 45;
  doc.edit('move', () => {});
  assert.equal(doc.undoLabel, 'move');

  doc.undo();
  const back = doc.data.structures[0] as typeof wall;
  assert.equal(doc.data.structures.length, 1, 'undoing the move took the wall with it');
  assert.equal(back.a.x, 20);
  assert.equal(doc.undoLabel, 'add wall');
});

test('redo puts back the name of what it redid', () => {
  const doc = new EditorDoc(blankLevel());
  for (const name of ['A', 'B', 'C']) doc.edit(`rename to ${name}`, () => { doc.data.name = name; });
  doc.undo();
  doc.redo();
  assert.equal(doc.data.name, 'C');
  assert.equal(doc.undoLabel, 'rename to C');
});

test('a committed edit that changed nothing records nothing', () => {
  const { doc } = withWall();
  doc.edit('move', () => {});
  assert.equal(doc.undoLabel, 'add wall');
});

test('undoing a spawn forgets it was selected', () => {
  const doc = new EditorDoc(blankLevel());
  const before = doc.data.spawns.enemies.length;
  doc.edit('place spawn', () => doc.data.spawns.enemies.push({ pos: { x: 50, y: 50 }, kind: 'rifle' }));
  doc.select([], { kind: 'enemy', team: 0, index: before });
  doc.undo();
  assert.equal(doc.selection.spawn, null);
});

test('something just added can be found by its id straight away', () => {
  // A level that carries ids from whichever session wrote it, as every saved
  // level does, so a fresh counter would start by repeating them.
  const level = blankLevel();
  level.terrain.forEach((op, i) => { op.id = `op${i + 1}`; });
  const doc = new EditorDoc(level);
  const made: StructureOp[] = [];
  for (const x of [20, 40]) {
    const op: StructureOp = { op: 'obstacle', at: { x, y: 50 }, radius: 1, top: 1, fabric: Fabric.Concrete };
    doc.edit('add obstacle', () => doc.data.structures.push(op));
    made.push(op);
  }
  assert.ok(made.every((op) => op.id), 'a new operation came out of the edit without an id');
  assert.equal(doc.find(made[1].id!), made[1], 'looking up the second found something else');
  const ids = doc.allOps().map((op) => op.id);
  assert.equal(new Set(ids).size, ids.length, `ids repeat: ${ids.join(', ')}`);
});

test('pasting painted ground files it as ground', async () => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const { copy, paste } = await import('../src/editor/clipboard.ts');
  const doc = new EditorDoc(blankLevel());
  doc.edit('paint ground', () => doc.data.terrain.push({
    op: 'surfacemap', name: 'painted', cols: 2, rows: 2, runs: packRuns(new Uint8Array(4).fill(255)),
  }));
  doc.select(doc.data.terrain.filter((op) => op.op === 'surfacemap').map((op) => op.id!));
  assert.equal(copy(doc), 1);
  paste(doc, { x: 60, y: 60 });
  assert.equal(doc.data.structures.length, 0, 'painted ground was pasted among the structures');
  assert.equal(doc.data.terrain.filter((op) => op.op === 'surfacemap').length, 2);
});

test('a file that will not build leaves the open level alone', () => {
  const doc = new EditorDoc({ ...blankLevel(), name: 'Mine' });
  // No size: validation calls that an error, and the scene cannot be made.
  const broken = migrate({ version: 2, name: 'Broken', terrain: [], structures: [] });
  assert.throws(() => doc.load(broken));
  assert.equal(doc.data.name, 'Mine');
  doc.edit('rename', () => { doc.data.name = 'Still mine'; });
  assert.equal(doc.undoLabel, 'rename', 'the editor could not make an edit after a failed open');
});

test('a hand-written file without a name or brief still reads as text', () => {
  const data = migrate({ version: 2, size: { width: 50, height: 50 } });
  assert.equal(typeof data.name, 'string');
  assert.equal(typeof data.brief, 'string');
  assert.equal(typeof data.id, 'string');
});
