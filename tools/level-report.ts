/**
 * What a level does, measured, without opening a browser.
 *
 * Every check the editor runs, plus the ground sweep behind its overlays, on
 * the command line so a level can be inspected in review or in CI. A map is
 * code now; this is its test output.
 *
 *   npm run level-report               # every level the game ships
 *   npm run level-report -- a.json     # a level file written by the editor
 */
import { readFileSync } from 'node:fs';

import { LEVEL_DATA } from '../src/sim/levels.ts';
import { audit } from '../src/editor/audit.ts';
import { sampleGround, sightFan } from '../src/sim/world/analysis.ts';
import {
  type LevelDef, createScene, defineLevel, migrate, validateLevel,
} from '../src/sim/world/level-data.ts';

const files = process.argv.slice(2);
const levels: { def: LevelDef; data: ReturnType<typeof migrate> }[] = files.length > 0
  ? files.map((path) => {
    const data = migrate(JSON.parse(readFileSync(path, 'utf8')));
    return { def: defineLevel(data), data };
  })
  : LEVEL_DATA.map((raw) => {
    const data = migrate(structuredClone(raw));
    return { def: defineLevel(data), data };
  });

let failed = false;

for (const { def, data } of levels) {
  const began = Date.now();
  const scene = createScene(def);
  const built = Date.now() - began;

  const problems = [...validateLevel(data), ...audit(scene, data)];
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length > 0) failed = true;

  const ground = sampleGround(scene, data.spawns.enemies.map((e) => e.pos));
  const { stats } = ground;

  console.log(`\n${def.name}  (${def.id})`);
  console.log(`  ${data.size.width}×${data.size.height}m  ` +
    `${data.structures.length} structures  ${data.terrain.length} ground ops  ` +
    `${scene.structures.segments.length} segments  built in ${built}ms`);
  console.log(`  ${data.spawns.teams.flat().length} operators  ` +
    `${data.spawns.enemies.length} defenders  ` +
    `${data.spawns.objectives.length} objective(s)`);

  console.log(`  ground   ${(stats.covered * 100).toFixed(0)}% covered by the defence, ` +
    `${(stats.dead * 100).toFixed(0)}% seen by nobody`);
  console.log(`           ${stats.weight.toFixed(2)} rifles on you on average, ` +
    `${(stats.open * 100).toFixed(0)}% of covered ground leaves you over half exposed`);

  // What each defender's position is actually worth, worst and best.
  const holds = data.spawns.enemies
    .map((e) => ({ at: e.pos, reach: sightFan(scene, e.pos, 120, 120).reach }))
    .sort((a, b) => b.reach - a.reach);
  if (holds.length > 0) {
    const best = holds[0];
    const worst = holds[holds.length - 1];
    console.log(`  positions best ${best.reach.toFixed(0)}m ` +
      `at ${best.at.x.toFixed(0)},${best.at.y.toFixed(0)}  ` +
      `worst ${worst.reach.toFixed(0)}m at ${worst.at.x.toFixed(0)},${worst.at.y.toFixed(0)}  ` +
      `mean ${(holds.reduce((a, h) => a + h.reach, 0) / holds.length).toFixed(0)}m`);
  }

  if (problems.length === 0) {
    console.log('  checks   nothing wrong with it');
  } else {
    for (const p of problems) {
      console.log(`  ${p.severity === 'error' ? 'STOP' : 'note'}     ${p.message}`);
    }
  }
}

process.exit(failed ? 1 : 0);
