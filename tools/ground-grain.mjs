/**
 * How broken up the drawn ground is, per surface.
 *
 * Tier three: an instrument, not a test. It has no pass and no fail. What it is
 * for is the same reading before and after a change to how the ground is drawn
 * — the number on its own means nothing.
 *
 *   npm run dev
 *   node tools/ground-grain.mjs [output-dir]
 *
 * The statistic is the spread of each pixel about its own neighbourhood: how
 * much detail there is, ignoring where it is. A flat fill scores under one.
 *
 * Two things about this bench were paid for the hard way.
 *
 * It runs in the editor rather than in a mission. Sampled against a spectate,
 * grass and crop came back stable to a tenth while dirt swung 68..112 and road
 * 41..55 between runs of the same code, because units walk, smoke blooms and
 * shadows move. The editor draws the game's own world with nothing running in
 * it, and repeats bit for bit.
 *
 * And it writes out the patch it measured. The first four sample points were
 * chosen by reading coordinates out of the level file and every one of them was
 * wrong — one sat on a hedgerow, one in the ditch, one across a kerb, one on
 * the hazed apron outside the map — and each reported a number with a perfectly
 * straight face. Widening to the whole canvas does not fix it either: buildings
 * and their shadows swamp the ground, and a change that took grass from nothing
 * to fully textured moved the whole-frame figure by 0.2. Look at the pictures.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUT = process.argv[2] || '.';
const W = 1500;
const H = 950;
/** Half the sample window, in device pixels — about a metre at this zoom. */
const R = 26;
/** What counts as large scale, and is subtracted off before measuring. */
const BLUR = 12;
/** Middle of the canvas, clear of the tool rail and the properties panel. */
const CX = 800;
const CY = 480;

/** Open, flat ground, verified by looking at what came out. See above. */
const SPOTS = {
  grass: [8, 35],
  crop: [154, 85],
  dirt: [60, 72],
  road: [30, 62],
};

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--headless=new'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
page.on('dialog', (d) => d.accept(''));

const where = (x, y) => page.evaluate(([x, y]) => window.editor.worldToScreen({ x, y }), [x, y]);

/** Right-drag pans. The wheel zooms about the focus rather than the cursor, so
 *  the point of interest wanders off as you zoom and has to be walked back. */
async function drag(dx, dy) {
  await page.mouse.move(CX, CY);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(CX + dx, CY + dy, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(120);
}

for (const [name, [wx, wy]] of Object.entries(SPOTS)) {
  // From scratch each time: eight levels of zoom and three pans in, the view is
  // in no state to be steered somewhere else accurately.
  await page.goto('http://localhost:5173/editor.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.editorReady === true, { timeout: 60000 });
  await page.selectOption('#load', 'stepove');
  // The ten-metre grid is drawn over the ground and lands inside the window,
  // where it reads as detail that is there before and after alike.
  await page.uncheck('#grid');
  await page.waitForTimeout(1300);

  for (let i = 0; i < 8; i++) {
    await page.mouse.move(CX, CY);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);

  const start = await where(wx, wy);
  await drag(60, 60);
  const moved = await where(wx, wy);
  const gain = { x: (moved.x - start.x) / 60, y: (moved.y - start.y) / 60 };
  for (let i = 0; i < 3; i++) {
    const p = await where(wx, wy);
    if (Math.abs(p.x - CX) < 4 && Math.abs(p.y - CY) < 4) break;
    await drag((CX - p.x) / gain.x, (CY - p.y) / gain.y);
  }
  await page.waitForTimeout(600);

  const at = await where(wx, wy);
  if (Math.abs(at.x - CX) > 30 || Math.abs(at.y - CY) > 30) {
    console.log(`${name.padEnd(6)} SKIPPED — would not centre`);
    continue;
  }

  const shot = await page.screenshot();
  const cx = Math.round(at.x * 2);
  const cy = Math.round(at.y * 2);
  await sharp(shot)
    .extract({ left: cx - 90, top: cy - 90, width: 180, height: 180 })
    .resize(360, 360, { kernel: 'nearest' })
    .toFile(path.join(OUT, `grain-${name}.png`));

  const sharpPixels = await sharp(shot).greyscale().raw().toBuffer({ resolveWithObject: true });
  const softPixels = await sharp(shot).greyscale().blur(BLUR).raw().toBuffer();
  const width = sharpPixels.info.width;
  let light = 0;
  let sum = 0;
  let squares = 0;
  let n = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const i = (cy + dy) * width + cx + dx;
      const detail = sharpPixels.data[i] - softPixels[i];
      light += sharpPixels.data[i];
      sum += detail;
      squares += detail * detail;
      n++;
    }
  }
  const grain = Math.sqrt(squares / n - (sum / n) ** 2);
  console.log(
    `${name.padEnd(6)} ${String(wx).padStart(3)},${String(wy).padEnd(3)} ` +
    ` brightness ${(light / n).toFixed(1)}   grain ${grain.toFixed(2)}`,
  );
}

await browser.close();
