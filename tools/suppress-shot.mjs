/**
 * Photograph a team raking ground: the order, the tracers going into it, and
 * what the HUD says while it is happening.
 *
 *   npm run dev
 *   node tools/suppress-shot.mjs [output-dir]
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
const look = (x, y) => page.evaluate(([wx, wy]) => window.wargame.lookAt(wx, wy), [x, y]);

async function hover(wx, wy) {
  const p = await at(wx, wy);
  await page.mouse.move(p.x - 30, p.y - 30);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.waitForTimeout(300);
}

await page.keyboard.press('1');
await look(40, 108);
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(400);

// Rake the ground ahead of the start line.
await hover(40, 92);
await page.keyboard.press('r');
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/r1-raking.png` });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/r2-raking-later.png` });

const state = await page.evaluate(() => {
  const s = window.wargame.snapshot();
  const alpha = s.units.filter((u) => u.faction === 0 && u.squad === 0);
  return alpha.map((u) => `${u.name} ammo=${u.ammo} raking=${u.raking}`).join(' | ');
});
console.log('alpha while raking:', state);

// A move order should call it off.
await hover(40, 100);
const p = await at(40, 100);
await page.mouse.click(p.x, p.y, { button: 'right' });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/r3-called-off.png` });

console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
