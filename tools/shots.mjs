/**
 * Close-up reads of the order preview and the ditch, for eyeballing changes
 * that the headless tests cannot judge: whether the cursor actually tells the
 * player anything, and whether a team ordered into the ditch ends up in it.
 *
 *   npm run dev
 *   node tools/shots.mjs [output-dir]
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
  await page.mouse.move(p.x - 40, p.y - 40);
  await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.waitForTimeout(450);
}

async function orderTo(key, wx, wy, { sprint = false } = {}) {
  await page.keyboard.press(key);
  // Keep the destination on screen: a click that lands outside the canvas is
  // not a test of anything.
  await look(wx, wy);
  await page.waitForTimeout(250);
  await hover(wx, wy);
  const p = await at(wx, wy);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  if (sprint) await page.mouse.click(p.x, p.y, { button: 'right', delay: 40 });
}

// Close in on ALPHA on the start line and hover the ground ahead of them.
await page.keyboard.press('1');
await look(40, 104);
for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(500);
await hover(40, 98);
await page.screenshot({ path: `${OUT}/s1-preview-open.png` });

// The same hover against the hedgerow, where the answer should differ.
await hover(46, 96);
await page.screenshot({ path: `${OUT}/s2-preview-cover.png` });

// The overlay, on the same ground.
await page.keyboard.press('f');
await hover(44, 97);
await page.screenshot({ path: `${OUT}/s3-overlay.png` });
await page.keyboard.press('f');

// Into the ditch, and give them time to actually walk it.
await orderTo('1', 40, 82);
await orderTo('2', 86, 82);
await orderTo('3', 130, 76, { sprint: true });
let s = await snap();
console.log('sprint registered  :', s.units.filter(u => u.squad === 2).some(u => u.mode === 1));

await page.waitForTimeout(22000);
s = await snap();
const near = (id, y) => s.units.filter(u => u.faction === 0 && u.squad === id && Math.abs(u.y - y) < 4.5).length;
console.log(`sim time ${s.time}s`);
console.log('ALPHA now:', s.units.filter(u => u.squad === 0 && u.faction === 0)
  .map(u => `${u.name} (${u.x},${u.y}) path=${u.pathLength} slot=${u.hasSlot}`).join(' | '));
console.log(`in the ditch: ALPHA ${near(0, 82)}/4  BRAVO ${near(1, 82)}/4  CHARLIE ${near(2, 76)}/4`);
console.log('posted in cover    :', s.units.filter(u => u.faction === 0 && u.inCover).length + '/12');
await look(40, 82);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/s4-in-ditch.png` });

console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
