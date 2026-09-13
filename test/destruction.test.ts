import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Tile, World, parseLevel } from '../src/sim/world.ts';
import { coverAgainst } from '../src/sim/combat.ts';
import { Faction, WEAPONS, makeUnit } from '../src/sim/units.ts';

/** A short wall with open ground either side of it. */
function wallBench(): { world: World; wall: { tx: number; ty: number } } {
  const world = parseLevel([
    '#########',
    '#.......#',
    '#.......#',
    '#..###..#',
    '#.......#',
    '#.......#',
    '#########',
  ]);
  return { world, wall: { tx: 4, ty: 3 } };
}

function pound(world: World, tx: number, ty: number, rounds: number, damage = 26): number {
  let collapses = 0;
  for (let i = 0; i < rounds; i++) {
    if (world.damageTile(tx, ty, damage)) collapses++;
  }
  return collapses;
}

/** Fire just enough to bring the tile down one stage, and no further. */
function collapseOnce(world: World, tx: number, ty: number, damage = 26): void {
  for (let i = 0; i < 4000; i++) {
    if (world.damageTile(tx, ty, damage)) return;
  }
  throw new Error(`tile (${tx},${ty}) would not collapse`);
}

test('a wall comes apart in two stages, and the middle one is the interesting one', () => {
  const { world, wall } = wallBench();
  assert.equal(world.at(wall.tx, wall.ty), Tile.Wall);
  assert.equal(world.walkable(wall.tx, wall.ty), false);

  // Stage one: full-height wall chews down to rubble. Still blocks movement,
  // but no longer blocks sight — both sides can now shoot over it.
  let rounds = 0;
  while (world.at(wall.tx, wall.ty) === Tile.Wall && rounds < 2000) {
    world.damageTile(wall.tx, wall.ty, 26);
    rounds++;
  }
  assert.ok(rounds < 2000, 'a wall should not be indestructible');
  assert.equal(world.at(wall.tx, wall.ty), Tile.Rubble, 'a wall should collapse into rubble');
  assert.equal(world.walkable(wall.tx, wall.ty), false, 'rubble still stops a body');

  // Stage two: the rubble clears and the breach opens.
  let more = 0;
  while (world.at(wall.tx, wall.ty) === Tile.Rubble && more < 2000) {
    world.damageTile(wall.tx, wall.ty, 26);
    more++;
  }
  assert.equal(world.at(wall.tx, wall.ty), Tile.Floor, 'rubble should clear to open ground');
  assert.ok(world.walkable(wall.tx, wall.ty), 'a breached wall is a way through');
  assert.ok(more < rounds, 'clearing rubble should be quicker than breaking the wall');
});

test('cover degrades as the thing providing it is shot away', () => {
  const { world, wall } = wallBench();
  // Stand just below the wall, so the wall is the cover to the north.
  const spot = { tx: wall.tx, ty: wall.ty + 1 };
  const node = world.coverNodeAt(spot.tx, spot.ty);
  if (!node) throw new Error('expected a cover node beside the wall');

  const unit = makeUnit({
    role: 'Rifleman',
    faction: Faction.Player,
    squadId: 0,
    pos: { ...node.pos },
    weapon: WEAPONS.carbine,
  });
  unit.claimedNode = node;
  unit.exposure = 0;

  const threat = { x: node.pos.x, y: node.pos.y - 8 };
  const intact = coverAgainst(world, unit, threat);
  assert.ok(intact > 0.7, `an intact wall should be strong cover, got ${intact.toFixed(2)}`);

  // Chew it most of the way down without collapsing it.
  while (world.integrityAt(wall.tx, wall.ty) > 0.1) {
    world.damageTile(wall.tx, wall.ty, 26);
  }
  const battered = coverAgainst(world, unit, threat);
  assert.ok(
    battered < intact * 0.75,
    `a battered wall should protect noticeably less: ${battered.toFixed(2)} vs ${intact.toFixed(2)}`,
  );

  // Collapse to rubble — still cover, but worse.
  collapseOnce(world, wall.tx, wall.ty);
  assert.equal(world.at(wall.tx, wall.ty), Tile.Rubble);
  const rubble = coverAgainst(world, unit, threat);
  assert.ok(rubble > 0, 'rubble is still worth hiding behind');
  assert.ok(rubble < intact, 'but not as good as the wall was');

  // Clear it entirely — the cover is gone and so is the claim on it.
  node.claimedBy = unit.id;
  collapseOnce(world, wall.tx, wall.ty);
  assert.equal(world.at(wall.tx, wall.ty), Tile.Floor);
  assert.equal(coverAgainst(world, unit, threat), 0, 'open ground protects nobody');
  assert.equal(node.claimedBy, null, 'cover that no longer exists should not stay reserved');
});

test('destroying a wall opens a route that did not exist', () => {
  const world = parseLevel([
    '#########',
    '#...#...#',
    '#...#...#',
    '#...#...#',
    '#########',
  ]);
  // The centre column splits the room in two.
  for (let ty = 1; ty <= 3; ty++) {
    assert.equal(world.walkable(4, ty), false);
  }

  pound(world, 4, 2, 4000);
  assert.equal(world.at(4, 2), Tile.Floor);
  assert.ok(world.walkable(4, 2), 'the breach should be passable');

  // And the cover graph knows about it: the tiles either side of the old wall
  // lost their arc toward it.
  const west = world.coverNodeAt(3, 2);
  if (west) {
    assert.ok(
      !west.arcs.some((a) => a.dir.x === 1 && a.dir.y === 0),
      'the tile west of the breach should no longer claim cover from it',
    );
  }
});

test('the change queue reports exactly the tiles that changed', () => {
  const { world, wall } = wallBench();
  world.changedTiles.length = 0;

  pound(world, wall.tx, wall.ty, 4000);

  const expected = wall.ty * world.width + wall.tx;
  assert.ok(world.changedTiles.length >= 2, 'two collapses should be reported');
  for (const i of world.changedTiles) {
    assert.equal(i, expected, 'only the tile actually shot at should be reported');
  }
});
