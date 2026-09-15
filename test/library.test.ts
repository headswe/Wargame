import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A stand-in for the browser's store.
 *
 * The library is the only thing between an author's finished level and losing
 * it, so it is worth testing without a browser in the loop — a check that needs
 * Chromium and a dev server is a check that gets skipped.
 */
class FakeStorage {
  private map = new Map<string, string>();
  /** Bytes allowed, so the out-of-space path is reachable. */
  quota = Infinity;
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (value.length > this.quota) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void { this.map.delete(key); }
}

const store = new FakeStorage();
(globalThis as unknown as { localStorage: FakeStorage }).localStorage = store;

// After the stub, because the module reads `localStorage` when called rather
// than when loaded — but the import still has to come second to be honest
// about the dependency.
const {
  RESERVED, forgetLevel, idTaken, saveLevel, savedLevel, savedLevels, slugify,
} = await import('../src/library.ts');
const { LEVEL_FORMAT, blankLevel } = await import('../src/sim/world/level-data.ts');

function level(id: string, name: string) {
  return { ...blankLevel(120, 100), id, name };
}

test('a saved level comes back out', () => {
  store.removeItem('wargame.levels');
  saveLevel(level('range', 'Range Day'));
  const found = savedLevel('range');
  assert.ok(found, 'the level is on the shelf');
  assert.equal(found.name, 'Range Day');
  assert.equal(found.data.size.width, 120);
  assert.equal(found.data.version, LEVEL_FORMAT);
});

test('saving the same id twice is a revision, not a second contract', () => {
  store.removeItem('wargame.levels');
  saveLevel(level('range', 'Range Day'));
  saveLevel({ ...level('range', 'Range Day'), brief: 'Now with a ditch.' });
  assert.equal(savedLevels().length, 1);
  assert.equal(savedLevel('range')?.data.brief, 'Now with a ditch.');
});

test('the shelf reads newest first', async () => {
  store.removeItem('wargame.levels');
  saveLevel(level('one', 'One'));
  // Date.now() has millisecond resolution and these two saves are faster than
  // that, so the ordering has to be forced rather than assumed.
  await new Promise((r) => setTimeout(r, 2));
  saveLevel(level('two', 'Two'));
  assert.deepEqual(savedLevels().map((l) => l.id), ['two', 'one']);
});

test('forgetting one leaves the others', () => {
  store.removeItem('wargame.levels');
  saveLevel(level('one', 'One'));
  saveLevel(level('two', 'Two'));
  forgetLevel('one');
  assert.deepEqual(savedLevels().map((l) => l.id), ['two']);
});

test('a corrupt shelf reads as empty rather than throwing', () => {
  // The menu is the only way back to the editor, so a shelf that throws on read
  // would lock an author out of the very tool that could fix it.
  store.setItem('wargame.levels', '{ not json at all');
  assert.deepEqual(savedLevels(), []);
  store.setItem('wargame.levels', '{"not":"an array"}');
  assert.deepEqual(savedLevels(), []);
});

test('entries missing the basics are dropped, not returned half-built', () => {
  store.setItem('wargame.levels', JSON.stringify([{ id: 'ok', name: 'Ok', data: blankLevel() }, 7, {}]));
  assert.deepEqual(savedLevels().map((l) => l.id), ['ok']);
});

test('running out of room says so instead of silently losing the level', () => {
  store.removeItem('wargame.levels');
  store.quota = 10;
  assert.throws(() => saveLevel(level('big', 'Big')), /could not save the level/);
  store.quota = Infinity;
});

test('shipped ids are spoken for', () => {
  store.removeItem('wargame.levels');
  for (const id of RESERVED) assert.ok(idTaken(id), `${id} is taken`);
  assert.equal(idTaken('range'), false);
  saveLevel(level('range', 'Range Day'));
  assert.ok(idTaken('range'));
});

test('a name becomes an id a URL can carry', () => {
  assert.equal(slugify('Range Day'), 'range-day');
  assert.equal(slugify('  The Quarry (north) '), 'the-quarry-north');
  assert.equal(slugify('!!!'), 'level');
  assert.equal(slugify(''), 'level');
});
