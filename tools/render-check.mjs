/**
 * Does every part of the world actually reach the screen?
 *
 * The one thing this renderer keeps getting wrong is not how something looks —
 * it is whether it is drawn at all. A road ribbon wound inside out, drawing
 * nothing while the scene graph, the vertex count and the bounding box all read
 * perfectly healthy. A fog patch applied to one material twice, so the shader
 * failed to compile and the mesh vanished — in the game only, never in the
 * editor, and still casting its shadow. Roof triangles facing down because
 * earcut's idea of anticlockwise in two dimensions is the opposite of facing up
 * in three. Every one of those was found by a person happening to look.
 *
 * So: hide each named view, draw again, and count the pixels that changed. That
 * number is how much of the screen the view is responsible for, and the only
 * assertion made about it is that it is not nothing.
 *
 *   npm run dev
 *   node tools/render-check.mjs
 *
 * Deliberately not a reference image. A picture to compare against has to be
 * re-blessed every time anything is restyled on purpose — which in this
 * repository is most weeks — and when it does fail it reports that pixels
 * changed and names no subsystem, which is the failure mode that got
 * `test/tactics.test.ts` deleted. A floor of two hundredths of one percent
 * survives any amount of restyling and still goes red the moment a view stops
 * drawing. Checked against the real bug: winding the road inside out again
 * takes it from 4.45% of the screen to 0, with no console error of any kind.
 *
 * It runs a spectate rather than a mission, because fog of war legitimately
 * hides most of the map at the start of one and there is no reading to take.
 */
import { chromium } from 'playwright';

/** What each shipped map is made of. A fixture: levels differ, and a level
 *  with no roads in it must not be reported as a renderer that lost the road
 *  view. `markers` is not here — nothing is selected in a spectate. */
const EXPECTED = {
  stepove: {
    plan: 'bounding',
    parts: ['terrain', 'roads', 'walls', 'roofs', 'props', 'foliage', 'units'],
  },
  kolna: {
    plan: 'flanks',
    parts: ['terrain', 'roads', 'walls', 'roofs', 'props', 'foliage', 'units'],
  },
};

/** Two hundredths of one percent of the canvas. Anything that draws at all
 *  clears this; anything that has stopped drawing cannot. */
const FLOOR = 0.0002;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--headless=new'],
});

let bad = 0;
for (const [level, { plan, parts }] of Object.entries(EXPECTED)) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: plan, exact: true }).first().click();
  await page.waitForFunction(() => !!window.wargame, { timeout: 60000 });
  // Long enough for the textures to have landed and the fireteams to have left
  // the start line, so `units` is somewhere the camera can see them.
  await page.waitForTimeout(3500);

  const covered = await page.evaluate(() => window.wargame.coverage());
  console.log(`\n${level} — "${plan}"`);
  for (const part of parts) {
    const share = covered[part];
    const ok = share !== undefined && share >= FLOOR;
    if (!ok) bad++;
    console.log(
      `  ${ok ? 'ok  ' : 'DREW NOTHING'} ${part.padEnd(8)} ` +
      `${share === undefined ? 'missing from the scene' : `${(share * 100).toFixed(2)}% of the screen`}`,
    );
  }
  const extra = Object.keys(covered).filter((k) => !parts.includes(k) && covered[k] >= FLOOR);
  if (extra.length > 0) console.log(`  also drawing: ${extra.join(', ')}`);
  if (errors.length > 0) {
    bad++;
    console.log(`  CONSOLE ERRORS: ${errors.slice(0, 3).join(' | ')}`);
  }
  await page.close();
}

await browser.close();
console.log(bad === 0 ? '\neverything reaches the screen' : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
