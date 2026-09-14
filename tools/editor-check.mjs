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

await page.goto('http://localhost:5173/editor.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.editorReady === true, { timeout: 60000 });
await page.waitForTimeout(900);

// Start from the shipped level every time, whatever is in the autosave.
await page.click('[data-act="sample"]');
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
  !!stats && stats.samples > 1000 && stats.covered > 0,
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

console.log(checks.join('\n'));
console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
