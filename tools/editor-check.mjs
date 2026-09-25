/**
 * Drives the level editor in a real browser and checks the editing actually
 * works, rather than that the page merely loads.
 *
 * Screenshots alone cannot tell you whether a drag created a building, whether
 * undo put it back, or whether the analysis overlay agrees with the level under
 * it — so this reads the editor's own state back out after each action.
 *
 *   npm run dev
 *   node tools/editor-check.mjs [output-dir]
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] || '.';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

// The editor asks before replacing what you have open, and asks for a name when
// it does not have one. Playwright dismisses dialogs by default, which would
// silently turn every one of those actions into a no-op and make the checks
// below pass by not happening.
let answer = '';
page.on('dialog', (d) => d.accept(answer));

await page.goto('http://localhost:5173/editor.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.editorReady === true, { timeout: 60000 });
await page.waitForTimeout(900);

// Start from the shipped level every time, whatever is in the autosave.
await page.selectOption('#load', 'stepove');
await page.waitForTimeout(1200);

const state = () => page.evaluate(() => {
  const doc = window.editor.doc;
  return {
    structures: doc.data.structures.length,
    terrain: doc.data.terrain.length,
    selected: doc.selection.ops.length,
    segments: doc.scene.structures.segments.length,
    problems: doc.problems.length,
    name: doc.data.name,
  };
});

const at = (x, y) => page.evaluate(([wx, wy]) => {
  const p = window.editor.worldToScreen({ x: wx, y: wy });
  const rect = document.getElementById('view').getBoundingClientRect();
  return { x: p.x + rect.left, y: p.y + rect.top };
}, [x, y]);

async function dragWorld(ax, ay, bx, by) {
  const a = await at(ax, ay);
  const b = await at(bx, by);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(450);
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const opened = await state();
check('the shipped level loads', opened.structures > 10 && opened.segments > 100,
  `${opened.structures} structures, ${opened.segments} segments`);
check('and passes its own checks', opened.problems === 0, `${opened.problems} problems`);

// --- draw a building on the open ground south of the village
await page.keyboard.press('b');
await dragWorld(30, 95, 48, 84);
const built = await state();
check('dragging out a building makes one', built.structures === opened.structures + 1,
  `${opened.structures} → ${built.structures}`);
check('and it is made of walls', built.segments > opened.segments,
  `${opened.segments} → ${built.segments} segments`);

// --- undo it
await page.keyboard.down('Control');
await page.keyboard.press('z');
await page.keyboard.up('Control');
await page.waitForTimeout(500);
const undone = await state();
check('undo takes it away again', undone.structures === opened.structures,
  `${built.structures} → ${undone.structures}`);

// --- redo, then select and move it
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await page.waitForTimeout(500);
const redone = await state();
check('redo puts it back', redone.structures === built.structures);

await page.keyboard.press('v');
const before = await page.evaluate(() => window.editor.doc.data.structures.at(-1).rect.at.x);
// Grab it by the middle, which is what anybody actually does.
await dragWorld(39, 89, 55, 89);
const after = await page.evaluate(() => window.editor.doc.data.structures.at(-1).rect.at.x);
check('dragging a selected building moves it', Math.abs(after - before) > 8,
  `x ${before.toFixed(1)} → ${after.toFixed(1)}`);

// --- and the move is its own step. For a long time it was not: a drag changed
// the level before telling the undo stack, which then found nothing to record,
// and ctrl+z took out the building instead of putting it back where it was.
await page.keyboard.down('Control');
await page.keyboard.press('z');
await page.keyboard.up('Control');
await page.waitForTimeout(500);
const unmoved = await page.evaluate(() => ({
  x: window.editor.doc.data.structures.at(-1).rect?.at.x,
  structures: window.editor.doc.data.structures.length,
}));
check('undo takes back the move, and only the move',
  unmoved.structures === redone.structures && Math.abs(unmoved.x - before) < 1e-6,
  `${unmoved.structures} structures, x ${unmoved.x?.toFixed(1)}`);
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await page.waitForTimeout(500);

// --- draw a wall, which needs two clicks rather than a drag
await page.keyboard.press('w');
const w1 = await at(70, 95);
const w2 = await at(96, 95);
await page.mouse.click(w1.x, w1.y);
await page.waitForTimeout(150);
await page.mouse.click(w2.x, w2.y);
await page.waitForTimeout(500);
const walled = await state();
check('a wall takes two clicks', walled.structures === redone.structures + 1);

// --- the analysis overlay
await page.selectOption('#overlay', 'fire');
await page.waitForTimeout(2500);
const stats = await page.evaluate(() => window.editor.overlays.stats);
check('the fire overlay measures the ground',
  !!stats && stats.walkableSamples > 1000 && stats.covered > 0,
  stats ? `${(stats.covered * 100).toFixed(0)}% covered, ${(stats.dead * 100).toFixed(0)}% dead ground, ${stats.millis.toFixed(0)}ms` : 'no stats');
await page.screenshot({ path: `${OUT}/editor-fire.png` });

await page.selectOption('#overlay', 'walkable');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/editor-walkable.png` });
await page.selectOption('#overlay', 'none');

// --- terrain sculpting
await page.keyboard.press('g');
const heightBefore = await page.evaluate(() => window.editor.doc.scene.heightAt(40, 100));
await dragWorld(36, 100, 46, 100);
const heightAfter = await page.evaluate(() => window.editor.doc.scene.heightAt(40, 100));
check('the sculpt brush moves the ground', heightAfter > heightBefore + 0.1,
  `${heightBefore.toFixed(2)}m → ${heightAfter.toFixed(2)}m`);

// --- and the document still round-trips
const roundTrip = await page.evaluate(() => {
  const json = window.editor.doc.toJSON();
  const back = JSON.parse(json);
  return { bytes: json.length, structures: back.structures.length, version: back.version };
});
check('it still writes a level file', roundTrip.version >= 1 && roundTrip.structures > 10,
  `${(roundTrip.bytes / 1024).toFixed(1)}kB, format ${roundTrip.version}`);

// --- painting the ground
await page.keyboard.press('u');
const surfaceBefore = await page.evaluate(() => window.editor.doc.scene.terrain.surfaceAt(60, 100));
await dragWorld(52, 100, 70, 100);
const surfaceAfter = await page.evaluate(() => window.editor.doc.scene.terrain.surfaceAt(60, 100));
const painted = await page.evaluate(() =>
  window.editor.doc.data.terrain.filter((op) => op.op === 'surfacemap').length);
check('the surface brush paints', surfaceAfter !== surfaceBefore && painted === 1,
  `${surfaceBefore} → ${surfaceAfter}, ${painted} overlay`);

// --- and the painted overlay stays small in the file
const encoded = await page.evaluate(() => {
  const op = window.editor.doc.data.terrain.find((o) => o.op === 'surfacemap');
  return { runs: op.runs.length, cells: op.cols * op.rows };
});
check('painted ground is encoded, not spelled out',
  encoded.runs < encoded.cells / 10,
  `${encoded.runs} numbers for ${encoded.cells} cells`);

// --- the sightline probe
await page.keyboard.press('q');
const probeAt = await at(103, 63);
await page.mouse.click(probeAt.x, probeAt.y);
await page.waitForTimeout(1200);
const reach = await page.evaluate(() => window.editor.probe.reach);
check('the sightline probe measures what a position holds', reach > 5 && reach < 140,
  `${reach.toFixed(0)}m of ground from the gun position`);
await page.screenshot({ path: `${OUT}/editor-probe.png` });

// --- measuring
await page.keyboard.press('x');
const m1 = await at(20, 100);
const m2 = await at(60, 100);
await page.mouse.click(m1.x, m1.y);
await page.waitForTimeout(150);
await page.mouse.click(m2.x, m2.y);
await page.waitForTimeout(400);
const tape = await page.evaluate(() => window.editor.tools.tape.length);
check('the tape measure takes two ends', tape === 2);

// --- copy and paste
await page.keyboard.press('v');
const target = await at(34, 48);
await page.mouse.click(target.x, target.y);
await page.waitForTimeout(300);
await page.keyboard.down('Control');
await page.keyboard.press('c');
await page.keyboard.up('Control');
await page.waitForTimeout(200);
const beforePaste = (await state()).structures;
await page.keyboard.down('Control');
await page.keyboard.press('v');
await page.keyboard.up('Control');
await page.waitForTimeout(700);
const afterPaste = (await state()).structures;
check('copy and paste adds a copy', afterPaste === beforePaste + 1,
  `${beforePaste} → ${afterPaste}`);

// --- reordering, which matters because operations apply in sequence
const order = await page.evaluate(() => {
  const doc = window.editor.doc;
  const first = doc.data.terrain[0].id;
  doc.reorder(first, 1);
  return { first, nowAt: doc.data.terrain.findIndex((op) => op.id === first) };
});
check('operations can be reordered', order.nowAt === 1, `moved to index ${order.nowAt}`);

// --- hiding an operation must actually hide it from the simulation
const muting = await page.evaluate(() => {
  const doc = window.editor.doc;
  const hedges = doc.data.structures.filter((op) => op.op === 'hedgerow');
  const before = doc.scene.structures.props.length;
  doc.edit('hide', () => { for (const h of hedges) h.muted = true; });
  const after = doc.scene.structures.props.length;
  doc.edit('show', () => { for (const h of hedges) h.muted = false; });
  return { before, after, back: doc.scene.structures.props.length };
});
check('hiding something takes it out of the world',
  muting.after < muting.before && muting.back === muting.before,
  `${muting.before} props → ${muting.after} → ${muting.back}`);

// --- prefabs
const prefab = await page.evaluate(() => {
  const doc = window.editor.doc;
  const building = doc.data.structures.find((op) => op.op === 'building');
  doc.select([building.id]);
  return window.editor.savePrefab(doc, 'test compound');
});
check('a selection can be kept as a piece', prefab === true);
const stamped = await page.evaluate(() => {
  const doc = window.editor.doc;
  const piece = window.editor.prefabs().find((p) => p.name === 'test compound');
  const before = doc.data.structures.length;
  window.editor.stamp(doc, piece, { x: 20, y: 110 }, Math.PI / 6);
  return { before, after: doc.data.structures.length };
});
check('and stamped down again, turned', stamped.after === stamped.before + 1,
  `${stamped.before} → ${stamped.after}`);

await page.keyboard.press('v');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/editor.png` });

// --- roads survive an edit that is not about them
// The editor reuses cached ground whenever only structures moved, which means
// the terrain operations do not re-run — and those are what record the road
// centrelines the ribbon is drawn from. A road that simply stopped being drawn
// the moment anybody nudged a building is the sort of thing only a check that
// nudges a building ever finds.
const ribbonsBefore = await page.evaluate(() => window.editor.doc.scene.terrain.ribbons.length);
await page.evaluate(() => {
  const doc = window.editor.doc;
  const b = doc.data.structures.find((o) => o.op === 'building');
  doc.edit('nudge', () => { if (b.rect) b.rect.at.x += 1; else b.footprint[0].x += 1; });
});
await page.waitForTimeout(700);
const ribbonsAfter = await page.evaluate(() => window.editor.doc.scene.terrain.ribbons.length);
check('a road is still there after a building is moved',
  ribbonsBefore > 0 && ribbonsAfter === ribbonsBefore,
  `${ribbonsBefore} \u2192 ${ribbonsAfter}`);

// --- the curve is a choice, made before drawing and changeable after
const curveOf = async (key) => {
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(key);
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const row = [...document.querySelectorAll('#tools .field')]
      .filter((r) => r.getClientRects().length > 0)
      .find((r) => r.querySelector('label')?.textContent === 'Curved');
    return row ? row.querySelector('input[type=checkbox]').checked : null;
  });
};
const road = await curveOf('r');
const lowWall = await curveOf('l');
check('every linear tool offers the curve before you draw it',
  road !== null && lowWall !== null, `road ${road}, low wall ${lowWall}`);
// A road is made by wheels and a compound wall is built, so they start
// opposite ways round. One shared default would be wrong half the time.
check('and starts the way that kind of thing is usually made',
  road === true && lowWall === false, `road ${road}, low wall ${lowWall}`);

await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press('v');
await page.waitForTimeout(300);
const straightened = await page.evaluate(async () => {
  const doc = window.editor.doc;
  const op = doc.data.terrain.find((o) => o.op === 'road');
  const before = doc.scene.terrain.ribbons[0]?.centre.length ?? 0;
  doc.select([op.id]);
  const labels = [...document.querySelectorAll('#inspector .field label')].map((l) => l.textContent);
  doc.edit('straighten', () => { op.curve = false; });
  return { before, after: doc.scene.terrain.ribbons[0]?.centre.length ?? 0, labels };
});
check('and can be turned off on a road already laid',
  straightened.labels.includes('curved') && straightened.after < straightened.before,
  `${straightened.before} \u2192 ${straightened.after} points along it`);
await page.evaluate(() => {
  const doc = window.editor.doc;
  const op = doc.data.terrain.find((o) => o.op === 'road');
  doc.edit('restore', () => { delete op.curve; });
  doc.select([]);
});
await page.waitForTimeout(600);

// --- doors, windows and partitions by pointing rather than by arithmetic
const wallMid = await page.evaluate(() => {
  const fp = window.editor.doc.scene.structures.buildings[0].footprint;
  const op = window.editor.doc.data.structures.find((o) => o.op === 'building');
  window.editor.doc.select([op.id]);
  return { x: (fp[0].x + fp[1].x) / 2, y: (fp[0].y + fp[1].y) / 2,
    before: (op.openings ?? []).length };
});
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press('n');
await page.waitForTimeout(250);
const wallPoint = await at(wallMid.x, wallMid.y);
await page.mouse.click(wallPoint.x, wallPoint.y);
await page.waitForTimeout(500);
const cut = await page.evaluate(() => {
  const op = window.editor.doc.data.structures.find((o) => o.op === 'building');
  return { count: (op.openings ?? []).length, last: (op.openings ?? []).slice(-1)[0] };
});
check('clicking a wall cuts an opening into it',
  cut.count === wallMid.before + 1 && cut.last && typeof cut.last.side === 'number',
  `${wallMid.before} \u2192 ${cut.count}, side ${cut.last?.side} at ${cut.last?.at?.toFixed?.(2)}m`);

// It has to be draggable, or it is still an arithmetic problem with a click in
// front of it.
const slid = await page.evaluate(() => {
  const op = window.editor.doc.data.structures.find((o) => o.op === 'building');
  const fp = window.editor.doc.scene.structures.buildings[0].footprint;
  const o = op.openings[0];
  const a = fp[o.side ?? 0];
  const bb = fp[((o.side ?? 0) + 1) % fp.length];
  const len = Math.hypot(bb.x - a.x, bb.y - a.y);
  const t = (o.at === 'centre' ? len / 2 : o.at) / len;
  return { from: o.at, hx: a.x + (bb.x - a.x) * t, hy: a.y + (bb.y - a.y) * t,
    tx: a.x + (bb.x - a.x) * 0.8, ty: a.y + (bb.y - a.y) * 0.8 };
});
await page.keyboard.press('v');
await page.waitForTimeout(200);
await dragWorld(slid.hx, slid.hy, slid.tx, slid.ty);
const now = await page.evaluate(() =>
  window.editor.doc.data.structures.find((o) => o.op === 'building').openings[0].at);
check('and its handle slides it along the wall',
  Math.abs(now - slid.from) > 1 && Math.round(now * 100) === now * 100,
  `${slid.from} \u2192 ${now}`);

const partBefore = await page.evaluate(() => {
  const op = window.editor.doc.data.structures.find((o) => o.op === 'building');
  const fp = window.editor.doc.scene.structures.buildings[0].footprint;
  const c = fp.reduce((a, p) => ({ x: a.x + p.x / fp.length, y: a.y + p.y / fp.length }),
    { x: 0, y: 0 });
  return { parts: (op.partitions ?? []).length, cx: c.x, cy: c.y, fp };
});
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press('j');
await page.waitForTimeout(250);
for (const corner of [0, 2]) {
  const e = partBefore.fp[corner];
  const n = partBefore.fp[(corner + 1) % partBefore.fp.length];
  const mid = { x: (e.x + n.x) / 2, y: (e.y + n.y) / 2 };
  const q = await at(mid.x * 0.8 + partBefore.cx * 0.2, mid.y * 0.8 + partBefore.cy * 0.2);
  await page.mouse.click(q.x, q.y);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(500);
const partAfter = await page.evaluate(() => {
  const op = window.editor.doc.data.structures.find((o) => o.op === 'building');
  return { parts: (op.partitions ?? []).length, doorway: (op.partitions ?? []).slice(-1)[0]?.openings?.length };
});
check('a building can be divided from inside it',
  partAfter.parts === partBefore.parts + 1 && partAfter.doorway > 0,
  `${partBefore.parts} \u2192 ${partAfter.parts}, with ${partAfter.doorway} doorway`);
await page.keyboard.press('v');
await page.waitForTimeout(200);

// --- the settings panel follows the tool
// Measured from what is painted, never from the `hidden` property: `.field`
// sets a display, an author display beats the browser's rule for [hidden], and
// the first version of this shipped with every setting still on screen while a
// probe that asked `el.hidden` cheerfully reported them gone.
const settingsFor = async (key) => {
  // Out of whatever inspector field the previous check left focused. The editor
  // deliberately ignores tool shortcuts while an input has focus — you are
  // typing — so without this the tool never changes and every reading below is
  // of the previous tool's panel.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press(key);
  // Generous, because a scene rebuild from the edits above can be most of a
  // frame budget and the panel follows the tool from inside the draw loop.
  await page.waitForTimeout(600);
  return page.evaluate(() => [...document.querySelectorAll('#tools .field')]
    .filter((r) => r.getClientRects().length > 0)
    .map((r) => r.querySelector('label')?.textContent));
};

const onSelect = await settingsFor('v');
check('the select tool offers no settings, because it has none',
  onSelect.length === 0, `showed [${onSelect.join(', ')}]`);

const onBuilding = await settingsFor('b');
check('a building offers exactly what a building has',
  onBuilding.length === 4 && onBuilding.includes('Made of') && onBuilding.includes('Cut doors'),
  `[${onBuilding.join(', ')}]`);

// The same stored field, named for the job. A bank that says "Depth" reads as
// a mistake, and the author has to guess which way the number goes.
const onDitch = await settingsFor('d');
const onBank = await settingsFor('k');
check('one field, named for whatever it is doing',
  onDitch.includes('Depth') && onBank.includes('Rise'),
  `ditch [${onDitch.join(', ')}], bank [${onBank.join(', ')}]`);

await page.keyboard.press('v');
await page.waitForTimeout(200);

// --- the side panels fold, and stay folded
await page.click('#report h3');
await page.waitForTimeout(200);
const foldedNow = await page.evaluate(() => {
  const body = document.querySelector('#report .ok, #report .problem, #report .stat');
  return { marked: document.querySelectorAll('#side section.folded').length,
    bodyPainted: body ? body.getClientRects().length > 0 : false };
});
check('a side panel folds away when you click its heading',
  foldedNow.marked === 1 && !foldedNow.bodyPainted,
  `${foldedNow.marked} folded, contents painted: ${foldedNow.bodyPainted}`);
await page.click('#report h3');
await page.waitForTimeout(200);

// --- the loop that makes the editor part of the game: publish, then play it
// from the front page. This is the whole point of the feature, so it is checked
// end to end rather than by trusting that the library round-trips.
answer = 'Range Day';
await page.evaluate(() => {
  // Give it a name of its own first: publishing Stepove under Stepove's id is a
  // different case (the reserved-id guard), and it is tested in test/library.
  window.editor.doc.edit('rename', () => {
    window.editor.doc.data.name = 'Range Day';
    window.editor.doc.data.id = 'range-day';
  });
});
await page.click('[data-act="publish"]');
await page.waitForTimeout(500);
const shelved = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('wargame.levels') ?? '[]').map((l) => l.id));
check('Add to contracts puts it on the shelf', shelved.includes('range-day'),
  `shelf holds [${shelved.join(', ')}]`);

// It must refuse a level nobody can play. Breaking the objective is the
// cheapest error to manufacture and one of the ones that actually ships.
await page.evaluate(() => {
  window.editor.doc.edit('break it', () => {
    window.editor.doc.data.id = 'broken-one';
    window.editor.doc.data.spawns.objectives = [];
  });
});
await page.click('[data-act="publish"]');
await page.waitForTimeout(400);
const afterBroken = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('wargame.levels') ?? '[]').map((l) => l.id));
check('and refuses one that will not play', !afterBroken.includes('broken-one'),
  `shelf holds [${afterBroken.join(', ')}]`);

// --- and finally: does the playtest button hand the game what is on screen?
// Navigating in the same tab keeps session storage, which is how the level
// travels. Last, because it leaves the editor behind.
const marker = await page.evaluate(() => {
  const doc = window.editor.doc;
  doc.edit('rename', () => { doc.data.name = 'Playtest Marker'; doc.data.size.width += 20; });
  sessionStorage.setItem('wargame.playtest', doc.toJSON());
  return { width: doc.data.size.width, structures: doc.data.structures.length };
});
await page.goto('http://localhost:5173/index.html?playtest=1', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.wargame, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const played = await page.evaluate(() => {
  const snap = window.wargame.snapshot();
  return { units: snap.units.length, mission: document.querySelector('#mission h1')?.textContent };
});
check('playtest runs the level that is on screen',
  played.mission === 'Playtest Marker',
  `the game says "${played.mission}", ${played.units} units`);
await page.screenshot({ path: `${OUT}/editor-playtest.png` });

// --- the front page, with no query string: a published level must be pickable
// there, because a level you can only reach by URL is the thing this replaced.
await page.goto('http://localhost:5173/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('#menu.show', { timeout: 30000 });
const listed = await page.evaluate(() =>
  [...document.querySelectorAll('#menu .mine .contract .name')].map((n) => n.textContent));
check('the picker lists levels you made', listed.includes('Range Day'),
  `"Your levels" shows [${listed.join(', ')}]`);
check('and still lists the shipped ones', await page.evaluate(() =>
  document.querySelectorAll('#menu .contracts .contract').length) === 2);
check('and offers a way into the editor',
  await page.evaluate(() => !!document.querySelector('#menu [data-act="new-level"]')));
await page.screenshot({ path: `${OUT}/picker.png` });

// Edit takes you back to the editor holding that level, not whatever the
// autosave happens to be — which is the other half of the loop, and the half
// that quietly fails if ?level= is only wired into the game.
await page.click('#menu .mine .contract button[title="Open this level in the editor"]');
await page.waitForFunction(() => window.editorReady === true, { timeout: 60000 });
await page.waitForTimeout(600);
const reopened = await page.evaluate(() => ({
  id: window.editor.doc.data.id, name: window.editor.doc.data.name,
}));
check('Edit reopens that level in the editor', reopened.id === 'range-day',
  `the editor holds "${reopened.name}" (${reopened.id})`);

// Take it. A card that lists but will not start is the bug worth catching.
await page.goto('http://localhost:5173/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('#menu.show', { timeout: 30000 });
const cards = await page.$$('#menu .mine .contract');
let started = null;
for (const card of cards) {
  if ((await card.$eval('.name', (n) => n.textContent)) !== 'Range Day') continue;
  await card.$eval('button.go', (b) => b.click());
  await page.waitForTimeout(2000);
  started = await page.evaluate(() => ({
    units: window.wargame?.snapshot().units.length ?? 0,
    mission: document.querySelector('#mission h1')?.textContent,
  }));
}
check('and taking one of your own starts a contract',
  started?.mission === 'Range Day' && started.units > 0,
  started ? `"${started.mission}", ${started.units} units` : 'no card found');
await page.screenshot({ path: `${OUT}/own-level.png` });

console.log(checks.join('\n'));
console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
