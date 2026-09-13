# Wargame

A real-time tactical game about a private military contractor. You command
fireteams of operators through a compound: they use cover, suppress each other,
get pinned, go down, and get dragged out.

Currently a playable single-mission prototype — greybox geometry, no meta layer
yet. The tactical layer is the part worth getting right first; everything else
is decoration on top of it.

**Play it: https://headswe.github.io/Wargame/**

Every push to the default branch runs the simulation tests and, if they pass,
deploys. The build uses a relative `base`, so it works from the project subpath
GitHub Pages serves from without hardcoding the repository name.

**One-time setup:** Pages must be switched on under *Settings → Pages → Source:
GitHub Actions* before the first deploy can succeed. The workflow cannot do this
for you — the default `GITHUB_TOKEN` is allowed to deploy to Pages but not to
create the site.

## Running it

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # headless simulation tests
npm run playtest  # drives the real game in a browser (needs `npm run dev` up)
```

## The one design decision everything else follows from

**The fireteam is the unit of command. The operator is the unit of simulation.**

Nobody can micromanage twelve men's position, facing and cover at 1x speed with
no pause. So you don't. You give three orders, not twelve. A squad order
resolves into one cover slot per operator — scored on protection against the
expected threat, spacing, and whether the position can actually be fired from —
and the operators fight from there on their own initiative.

That makes operator autonomy the single most important system in the game. If
the AI is stupid, no interface saves it.

## Why flanking works without anything telling it to

Three systems, none of which mentions flanking:

- **Cover is directional, and it costs something.** You only get protection
  from the side the wall is on, and leaning out to return fire gives part of it
  up. Shoot or stay safe — pick one.
- **Suppression is applied along each round's path**, not to whoever was aimed
  at. Fire at a doorway and everyone near it feels it. Enough of it pins a man
  where he is.
- **Spotting is an accumulator.** Sprinting across open ground gets you seen
  almost at once. Crouched in cover takes seconds. Opening fire gives you away
  to everyone.

Put those together and fire-and-maneuver falls out: pin them with the belt-fed,
bound a team up the flank, take the position. `test/tactics.test.ts` asserts the
gap — a scripted frontal assault through the main gate wins 0/8 seeds, the same
teams bounding the flanks win 8/8 for a fraction of the casualties.

## Controls

| Input | Effect |
|---|---|
| Right-click | Move tactically — weapon up, hugs cover, reacts instantly |
| Double right-click | Run — fast, weapon down, ignores cover, loud, gets you seen |
| Right-click + drag | Set the arc the team faces on arrival |
| Left-click / drag | Select a team / box-select |
| 1–3, Tab | Pick a team |
| Q / E | Rotate the camera in 45° steps |
| WASD, middle-drag, wheel | Pan and zoom |
| Space | Centre on the selected team |
| F | Cover overlay — every protected face you have seen |

## Reading the board

The hardest problem in an isometric 3D tactics game is that you genuinely
cannot tell which side of a wall is safe. The answers:

- **Cover pips** — a bar drawn on the face that protects you. Green for
  full-height, amber for waist-high, dimmed when it faces the wrong way.
  Hover with a team selected to see what an order would buy before you give it.
- **X-ray silhouettes** — your own operators show through geometry.
- **Ghost rings** — last known position of a contact you have lost.
- **Fog shades the geometry itself**, not just the floor, so you cannot read
  the compound layout through unexplored blackness.

## Layout

```
src/sim/      the whole game, deterministic, zero rendering imports
src/render/   three.js: level, units, fog, tracers, cover markers
src/input/    mouse and keyboard
src/ui/       DOM HUD
test/         headless simulation tests
tools/        scripted browser playtest
```

The split is load-bearing, not tidiness. The simulation runs headless at
thousands of ticks a second, which is what makes it possible to ask questions
like "does flanking actually beat a frontal assault across 24 seeds" and get an
answer in a few seconds. It also means the same seed replays exactly.

## Levels are ASCII

A map is a readable diff. `src/sim/levels.ts`:

```
#  wall — blocks movement, sight and bullets
o  low cover — blocks movement, shoot over it, good protection
"  firing port — shoot through it, cannot walk through it
+  doorway — a funnel, so a natural killzone
1/2/3  fireteam spawns      e  hostile    E  hostile with the belt-fed
X  objective
```

## Two scales, one ruleset

`Cold Harbour` is a 73 m walled compound — the close-quarters mission, where the
median clear line of sight from the start is **6 m**. `Stepove` is a 170 m
village where that same measurement is **68 m**, and first contact happens at a
median of 47 m.

That gap is the point. Weapon ranges, spotting and movement are tuned once, for
both, because a contract should be able to be an office block or a field in
Ukraine without changing the rules underneath.

## Destruction

Walls have hit points and a material. Rounds that go wide put their energy into
the scenery, and cover wears out in two stages:

```
wall  ──fire──▶  rubble  ──fire──▶  open ground
      blocks           blocks           passable
      sight            movement         breach
```

The middle stage is the interesting one: a wall you were safe behind becomes
something you can both shoot over, and a position turns from cover into a
firefight without anybody moving. Cover value falls continuously with integrity
as well, so a battered wall is worth measurably less before it collapses.

Small arms **degrade** cover; they rarely breach it. Putting a hole through
masonry is what explosives are for, and indirect fire is not in yet.

## Levels are authored two ways

Tight interiors stay ASCII — a floorplan you can read in a diff. Anything at
village scale is painted from primitives (`src/sim/levelgen.ts`): thick line
segments at any angle, buildings at any rotation, scattered cover. That is what
lets a hedgerow run at 23 degrees instead of snapping to the compass, and it is
deliberately the shape the world wants to become — vector geometry rasterised
for the simulation.

## The new world model (built, not yet wired in)

`src/sim/world/` and `src/sim/nav/` are the foundation the game is moving onto.
They are tested and benchmarked but not yet driving the playable build, so the
grid game above still runs while this is finished.

**Terrain is a heightfield.** Elevation is what lets ground do tactical work:
dead ground you can cross unseen, a reverse slope a defender sits behind, and a
ditch you are genuinely *below* rather than beside. Roads and ditches are
operations on the surface rather than objects placed on it — a road flattens
across its width while still riding over the hill it crosses, a ditch cuts down,
a crater deforms and throws up a lip.

**Structures are vectors.** Wall runs at any angle, with a fabric, hit points,
and a `sill`/`top` pair so one type expresses a full wall, a waist-high
revetment and a window band. Props add the category the grid could not: bushes
are *concealment*, not cover — they hide you without stopping anything.

**Navigation is a Recast-style navmesh.** Voxelise walkability from slope and
obstacles, distance-transform and erode by the agent radius, trace contours off
the cell boundaries, simplify, triangulate with holes, then A* across cells and
pull the corridor taut with the funnel algorithm. Because the world is
single-storey there is exactly one walkable surface per column, which removes
Recast's span-merging stage entirely.

On a 170 x 130 m village with seven angled buildings:

```
navmesh                943 triangles from 680 x 520 cells
path query             0.127 ms          (mean 1.38x straight-line)
rebuild after a breach ~12 ms steady state
sightline              2.12 us over 100 m (~17 ms per second at full load)
```

**Cover is one calculation, not a table.** A sightline solves for the lowest
point on the target that clears every obstruction along the way. An obstruction
of height `H` at fraction `t` of the way there hides everything below
`eye + (H - eye) / t`, so the highest such value over the walk is the target's
waterline: below it hidden, above it exposed. One pass answers "can I see him"
and "how much of him" together, and a wall, a crest, a ditch lip and a
crouching man all become the same arithmetic.

What falls out of it, with no special case for any of them:

```
a man at 100 m                          standing   crouched
  behind a waist-high wall at his elbow      44%        16%
  the same wall halfway between you          78%        67%
  in a 1.6 m ditch                           13%         0%
  in that ditch, seen from its lip          100%         -
  behind a low ridge                          0%         -
  ...from on top of that ridge               100%         -
```

Hugging your cover matters; cover you are merely near does not. A ditch is
defilade rather than a bump. Height sees over. And a hedgerow reports 100%
exposure with 100% concealment — vegetation hides you without stopping a
single round, which is a distinction the tile world had no way to make.

Two things in there are load-bearing and easy to get wrong:

- The erosion radius includes the contour simplification tolerance. Douglas-
  Peucker moves vertices outward as readily as inward, so without that margin a
  simplified contour bulges into cleared space and a funnelled path cuts the
  corner through a wall.
- Clearance is capped at the erosion radius, which is what makes a regional
  rebuild exact rather than approximate: a change cannot alter any distance
  further away than the cap.

## What is deliberately not here yet

- **The PMC layer** — contracts, payroll, gear, a persistent roster. This is
  what makes losing Voss hurt rather than decrementing a counter, and it goes
  on top of a tactical layer that already works.
- **Grenades, breaching, and stances** beyond walk/run.
- **Sound**, which does more for a firefight than most of the visuals.
- **Interior clearing behaviour** — room entry is currently just movement.
