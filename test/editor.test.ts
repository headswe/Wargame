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
import { type StructureOp, blankLevel } from '../src/sim/world/level-data.ts';
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
