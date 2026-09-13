/**
 * Drives the grenade and smoke verbs in a real browser and photographs each
 * stage, because arcs, blasts and clouds are things you have to look at.
 *
 *   npm run dev
 *   node tools/ordnance-shots.mjs [output-dir]
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] || '.';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.wargame);
await page.waitForTimeout(600);

const at = (x, y) => page.evaluate(([wx, wy]) => window.wargame.worldToScreen(wx, wy), [x, y]);
const snap = () => page.evaluate(() => window.wargame.snapshot());
const look = (x, y) => page.evaluate(([wx, wy]) => window.wargame.lookAt(wx, wy), [x, y]);

async function hover(wx, wy) {
  const p = await at(wx, wy);
  await page.mouse.move(p.x - 30, p.y - 30);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.waitForTimeout(300);
}

// Close in on ALPHA on the start line.
await page.keyboard.press('1');
await look(40, 112);
for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/o1-start.png` });

// Smoke, 20 m ahead of them.
await hover(40, 96);
await page.keyboard.press('t');
await page.waitForTimeout(420);
await page.screenshot({ path: `${OUT}/o2-smoke-in-flight.png` });
await page.waitForTimeout(2600);
await page.screenshot({ path: `${OUT}/o3-smoke-blooming.png` });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/o4-smoke-grown.png` });

let s = await snap();
console.log('smoke stock after one canister:', await page.evaluate(() => {
  const sim = window.wargame.snapshot();
  return sim.units.filter((u) => u.faction === 0 && u.squad === 0).map((u) => u.name).join(',');
}));

// Frag, close in.
await hover(44, 104);
await page.keyboard.press('g');
// Headless renders at a few frames a second, so wall-clock waits do not line
// up with sim time. Wait on the state instead.
await page.waitForFunction(() => window.wargame.ordnance().some((o) => !o.landed), null, { timeout: 4000 })
  .catch(() => console.log('never saw it in flight'));
await page.screenshot({ path: `${OUT}/o5-frag-in-flight.png` });
await page.waitForFunction(() => window.wargame.ordnance().some((o) => o.landed), null, { timeout: 6000 })
  .catch(() => console.log('never saw it land'));
await page.screenshot({ path: `${OUT}/o6-frag-cooking.png` });
await page.waitForFunction(() => window.wargame.ordnance().length === 0, null, { timeout: 8000 })
  .catch(() => console.log('never saw it go off'));
await page.screenshot({ path: `${OUT}/o7-frag-blast.png` });

// Out of range: should refuse and say so. Checked through the API rather than
// the cursor, because a hover that lands off-canvas leaves the old aim point
// in place and quietly tests nothing.
const refused = await page.evaluate(() => window.wargame.tryThrow(0, 0, 40, 20));
console.log('throw at 90 metres refused:', refused === false);
await page.screenshot({ path: `${OUT}/o8-refused.png` });

// And a wide shot, to judge how the map reads now.
await look(85, 90);
for (let i = 0; i < 9; i++) await page.mouse.wheel(0, 120);
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/o9-wide.png` });

s = await snap();
console.log('time', s.time, 'operators up', s.units.filter((u) => u.faction === 0 && u.state === 0).length);
console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
