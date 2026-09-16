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
    written.push(`${map.role} ${(out.length / 1024).toFixed(0)}kB`);
  }
  if (written.length === 0) {
    console.log('SKIPPED — no usable maps in the pack');
    continue;
  }
  manifest.push({ name: material.name, metres: material.metres, pack: material.pack });
  console.log(written.join('  '));
}

await writeFile(
  path.join(OUT, 'manifest.json'),
  `${JSON.stringify({ size: SIZE, materials: manifest }, null, 2)}\n`,
);
await rm(work, { recursive: true, force: true });
console.log(`\n${manifest.length} materials in ${OUT}`);
