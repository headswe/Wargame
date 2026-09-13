/**
 * Scripted playtest. Drives the real game in a real browser: selects teams,
 * issues move / sprint / facing orders, and reads the simulation back through
 * window.wargame to confirm the order actually landed.
 *
 * Screenshots alone cannot tell you whether a double right-click registered as
 * a sprint, so this checks the sim state rather than the pixels.
 *
 *   npm run dev
 *   node tools/playtest.mjs [output-dir]
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] || '.';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.wargame);
await page.waitForTimeout(600);

const at = (x, y) => page.evaluate(([wx, wy]) => window.wargame.worldToScreen(wx, wy), [x, y]);
const snap = () => page.evaluate(() => window.wargame.snapshot());
const squad = (s, id) => s.units.filter(u => u.faction === 0 && u.squad === id);

async function order(squadKey, wx, wy, { sprint = false, face = null } = {}) {
  await page.keyboard.press(squadKey);
  const p = await at(wx, wy);
  if (face) {
    const f = await at(wx + Math.cos(face) * 4, wy + Math.sin(face) * 4);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(f.x, f.y, { steps: 6 });
    await page.mouse.up({ button: 'right' });
  } else {
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    if (sprint) await page.mouse.click(p.x, p.y, { button: 'right', delay: 20 });
  }
}

// 1. Select ALPHA and send it west along the start line with a facing drag.
await order('1', 40, 112, { face: -Math.PI / 2 });
await page.waitForTimeout(500);
let s = await snap();
console.log('after ALPHA order  :', squad(s, 0).map(u => `${u.name} path=${u.pathLength} slot=${u.hasSlot} cover=${u.inCover}`).join(' | '));

// 2. BRAVO takes the middle as the base of fire.
await order('2', 86, 112, { face: -Math.PI / 2 });
await page.waitForTimeout(400);

// 3. CHARLIE sprints for the eastern flank — double right-click.
await order('3', 130, 112, { sprint: true });
await page.waitForTimeout(600);
s = await snap();
const charlie = squad(s, 2);
console.log('after CHARLIE sprint:', charlie.map(u => `${u.name} mode=${u.mode} path=${u.pathLength}`).join(' | '));
console.log('sprint registered  :', charlie.some(u => u.mode === 1));

// The cursor preview: hover a team over the ditch and photograph what the
// player is being told before he commits.
await page.keyboard.press('1');
const overDitch = await at(40, 82);
await page.mouse.move(overDitch.x, overDitch.y, { steps: 8 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-preview.png` });

// 4. Into the ditch, which the navmesh has to actually let them enter.
await order('1', 40, 82);
await order('2', 86, 95);
await order('3', 130, 82);
await page.waitForTimeout(4000);
s = await snap();
const inDitch = squad(s, 0).filter(u => Math.abs(u.y - 82) < 4).length;
console.log(`ALPHA in the ditch : ${inDitch}/4`);
await page.screenshot({ path: `${OUT}/03-ditch.png` });

// Let the assault run.
await order('1', 34, 60, { face: -Math.PI / 2 });
await order('2', 86, 72, { face: -Math.PI / 2 });
await order('3', 138, 60, { face: -Math.PI / 2 });
await page.waitForTimeout(12000);
s = await snap();
const players = s.units.filter(u => u.faction === 0);
const hostiles = s.units.filter(u => u.faction === 1);
console.log(`t=${s.time}s  standing ${players.filter(u=>u.state===0).length}/12  hostiles ${hostiles.filter(u=>u.state===0).length}/10  contacts ${players.reduce((a,u)=>a+u.visible,0)}`);
console.log('suppressed operators:', players.filter(u => u.suppression > 0.3).map(u => `${u.name} ${u.suppression}`).join(', ') || 'none');
console.log('posted in cover    :', players.filter(u => u.inCover).length + '/12');
await page.screenshot({ path: `${OUT}/04-firefight.png` });

// Zoom in for a close read of posture and the post markers.
await page.keyboard.press('1');
await page.keyboard.press(' ');
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
const hover = await at(36, 56);
await page.mouse.move(hover.x, hover.y, { steps: 6 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/05-close.png` });

console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
