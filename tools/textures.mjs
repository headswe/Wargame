/**
 * Fetch the material textures the game ships, and cut them down to size.
 *
 * The originals are full PBR sets meant for close work — Dirt is 54MB, Dirty
 * Concrete 40MB — and this game is played with a hundred and seventy metres of
 * ground on screen at once, where a fifteen-metre wall is about a hundred
 * pixels wide. Nothing above 512 could ever be seen. Shipping the originals
 * would put fifty times the bytes into a repository for detail that mipmaps
 * away before it reaches the screen.
 *
 * So this is the recipe rather than the result: it writes what the game loads,
 * and the numbers it writes are here to be argued with. Run it again after
 * changing them.
 *
 *   npm run textures
 *
 * Source: https://textures.pixel-furnace.com — free for use in games, including
 * commercially, in modified or unmodified form; see public/textures/CREDITS.md.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const SOURCE = 'https://textures.pixel-furnace.com/uploads/textures';
const OUT = 'public/textures';
/** Big enough to read when you lean in, small enough that nobody waits for it. */
const SIZE = 512;

/**
 * What each fabric is made of, and how big a piece of it a metre is.
 *
 * `metres` is the thing to get right: a brick is about 215mm long, so a texture
 * showing a dozen courses wants to be a couple of metres across. Guess it too
 * large and the wall reads as a photograph of a wall; too small and it is
 * visual noise.
 */
const MATERIALS = [
  { name: 'brick', pack: 'Old_Red_Brick', metres: 2.4 },
  { name: 'concrete', pack: 'Dirty_Concrete', metres: 3.2 },
  { name: 'timber', pack: 'Old_Wood', metres: 2.0 },
  { name: 'metal', pack: 'Diamond_Plate', metres: 2.0 },
  { name: 'tile', pack: 'Red_Tiles', metres: 1.6 },
  { name: 'shingle', pack: 'Wooden_Shingles', metres: 2.2 },

  /**
   * The three the ground is made of, blended along a ramp from vegetated to
   * metalled — see `GROUND_RAMP` in `src/render/world.ts`. They want to be
   * larger than the wall materials: a wall is a hundred pixels across and a
   * field is the whole screen, so a tile small enough to read on brick repeats
   * fifty times across a paddock and the eye finds the grid instantly.
   *
   * Soil is the middle deliberately. Every pair of surfaces that meet blends
   * through it, and a worn margin of bare earth between grass and concrete is
   * what is actually there.
   *
   * The grass pack ships no normal map, only a displacement, which is why the
   * ground went in flat to begin with — relief on two thirds of the ramp and
   * nothing on the rest is worse than none. A normal map is the gradient of a
   * height map, so it is derived below rather than gone without.
   */
  { name: 'grass', pack: 'Dirty_Grass', metres: 3.6 },
  { name: 'earth', pack: 'Soil_Shoeprints', metres: 4.5 },
  { name: 'stone', pack: 'Cracked_Asphalt', metres: 6.0 },
];

/**
 * Which maps are worth their bytes, and how to recognise them.
 *
 * Found by looking in the zip rather than by assuming a filename, because the
 * packs do not agree with each other: `Old_Red_Brick_NRM.png` next to
 * `oldwood_NRML.png` next to `Red_Tiles_NRM.jpg`, and one with an `ALBEDO` and
 * no normal at all. Guessing the name silently produced a material with no
 * maps, which the game then drew untextured — a failure that looks exactly like
 * deciding not to texture it.
 *
 * ALBEDO is preferred over DIFF where a pack offers both: albedo is the colour
 * with the lighting already taken out of it, which is the one that will not
 * fight our own sun.
 */
const MAPS = [
  { role: 'albedo', match: [/_ALBEDO\.(png|jpe?g)$/i, /_DIFF\.(png|jpe?g)$/i] },
  { role: 'normal', match: [/_NRML?\.(png|jpe?g)$/i, /_NORMAL\.(png|jpe?g)$/i] },
];

/** Displacement, occlusion, specular, roughness and metalness are not. */

/**
 * The average colour of a tile, in the linear space the shader works in.
 *
 * The ground shader divides by this so a texture contributes its grain without
 * moving the palette: dividing by the mean leaves a field of values centred on
 * one, so grass photographed dark and soil photographed pale both come out as
 * variation around whatever colour the surface is authored as. Take the mean
 * of the sRGB bytes instead and every ground goes several percent dark, because
 * the shader decodes before it multiplies and the decode is not linear.
 */
const TO_LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

async function linearMean(jpeg) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const n = info.channels;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += n) {
    sum[0] += TO_LINEAR[data[i]];
    sum[1] += TO_LINEAR[data[i + 1]];
    sum[2] += TO_LINEAR[data[i + 2]];
  }
  const pixels = data.length / n;
  return sum.map((v) => Number((v / pixels).toFixed(4)));
}

/** Displacement under whichever of its several names this pack chose. */
const HEIGHT = [/_DISP\.(png|jpe?g)$/i, /_HEIGHT\.(png|jpe?g)$/i];

/**
 * A normal map is the gradient of a height map, so a pack that ships only a
 * displacement is not a pack without relief in it.
 *
 * Sobel, wrapped at the edges so the result tiles as seamlessly as the height
 * map it came from — sampling clamped instead puts a visible seam every few
 * metres across a whole field, which is exactly the distance at which the eye
 * finds a grid.
 *
 * `STEEPNESS` is how many normal-map units one unit of height is worth. It is a
 * look, not a measurement: the displacement is in no particular units and the
 * packs do not agree with each other about its range.
 */
const STEEPNESS = 4;

async function normalFromHeight(file) {
  const { data, info } = await sharp(file)
    .greyscale().resize(SIZE, SIZE, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const at = (x, y) => data[((y + height) % height) * width + ((x + width) % width)] / 255;

  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const nx = -dx * STEEPNESS;
      // Green is the gradient along +v, and +v is *up* the image, because
      // three uploads textures flipped. Take the raw row order for it and the
      // relief comes out inside out — every bump lit as a dent, which from
      // overhead mostly reads as the ground going strangely flat rather than
      // as anything obviously wrong. Not argued: derived from
      // `Soil_Shoeprints`, which ships a height map and an authored normal
      // map both, the green channel correlates with the authored one at
      // r = +0.843 this way round and r = -0.843 the other.
      const ny = dy * STEEPNESS;
      const length = Math.hypot(nx, ny, 1);
      const i = (y * width + x) * 3;
      out[i] = Math.round((nx / length * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 85, mozjpeg: true }).toBuffer();
}

async function fetchPack(pack, into) {
  const zip = path.join(into, `${pack}.zip`);
  const response = await fetch(`${SOURCE}/${pack}.zip`);
  if (!response.ok) throw new Error(`${pack}: HTTP ${response.status}`);
  await new Promise((resolve, reject) => {
    const file = createWriteStream(zip);
    file.on('error', reject);
    file.on('finish', resolve);
    response.body.pipe?.(file) ?? (async () => {
      file.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  await run('unzip', ['-o', '-q', zip, '-d', into]);
  return zip;
}

const work = path.join(tmpdir(), 'wargame-textures');
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(OUT, { recursive: true });

const manifest = [];
for (const material of MATERIALS) {
  process.stdout.write(`${material.name.padEnd(9)} `);
  try {
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await fetchPack(material.pack, work);
  } catch (error) {
    console.log(`SKIPPED — ${error.message}`);
    continue;
  }
  const present = (await readdir(work)).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const written = [];
  for (const map of MAPS) {
    // First pattern that matches anything wins, so a pack carrying both an
    // albedo and a diffuse gives up the albedo.
    const found = map.match.map((re) => present.find((f) => re.test(f))).find(Boolean);
    if (!found) continue;
    const to = path.join(OUT, `${material.name}-${map.role}.jpg`);
    const source = await readFile(path.join(work, found));
    // JPEG rather than PNG: these are photographs of surfaces, there is no
    // alpha to keep, and the artefacts are invisible under a wall seen from
    // eighty metres. It is a third of the bytes.
    const out = await sharp(source)
      .resize(SIZE, SIZE, { fit: 'fill' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    await writeFile(to, out);
    if (map.role === 'albedo') material.mean = await linearMean(out);
    written.push(`${map.role} ${(out.length / 1024).toFixed(0)}kB`);
  }
  // Last resort for the normal, and only then: a real one carries detail a
  // height map cannot, so a derived one is never preferred over a shipped one.
  if (!written.some((w) => w.startsWith('normal'))) {
    const found = HEIGHT.map((re) => present.find((f) => re.test(f))).find(Boolean);
    if (found) {
      const out = await normalFromHeight(path.join(work, found));
      await writeFile(path.join(OUT, `${material.name}-normal.jpg`), out);
      written.push(`normal ${(out.length / 1024).toFixed(0)}kB (from ${found.replace(/.*_/, '')})`);
    }
  }

  if (written.length === 0) {
    console.log('SKIPPED — no usable maps in the pack');
    continue;
  }
  manifest.push({
    name: material.name, metres: material.metres, pack: material.pack, mean: material.mean,
  });
  console.log(written.join('  '));
}

await writeFile(
  path.join(OUT, 'manifest.json'),
  `${JSON.stringify({ size: SIZE, materials: manifest }, null, 2)}\n`,
);
await rm(work, { recursive: true, force: true });
console.log(`\n${manifest.length} materials in ${OUT}`);
