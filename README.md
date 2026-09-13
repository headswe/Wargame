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

## The world

Terrain is a **heightfield**, and that is what lets ground do tactical work:
dead ground you can cross unseen, a reverse slope a defender sits behind, and a
ditch you are genuinely *below* rather than beside. Roads and ditches are
operations on the surface rather than objects placed on it — a road flattens
across its width while still riding over the hill it crosses, a ditch cuts down,
a shell deforms the ground and throws up a lip.

Structures are **vector segments** at any angle, with a fabric, hit points, and
a sill/top pair so one type covers a full wall, a waist-high revetment and a
window band. Props carry the category a grid cannot express: bushes are
**concealment, not cover** — they hide you without stopping anything.

Navigation is a **Recast-style navmesh**: voxelise walkability from slope and
obstacles, distance-transform and erode by the agent radius, trace contours off
the cell boundaries, simplify, triangulate with holes, then A* across cells and
pull the corridor taut with the funnel algorithm. Single-storey means one
walkable surface per column, which removes Recast's span-merging entirely.

## Cover is a calculation, not a table

A sightline solves for the lowest point on the target that clears every
obstruction on the way. An obstruction of height `H` at fraction `t` of the way
hides everything below `eye + (H - eye) / t`, so the highest such value is the
target's waterline: below it hidden, above it exposed. One pass answers "can I
see him" and "how much of him" together.

What falls out, with no special case for any of it:

```
a man at 100 m                          standing   crouched
  behind a waist-high wall at his elbow      44%        16%
  the same wall halfway between you          78%        67%
  in a 1.6 m ditch                           13%         0%
  in that ditch, seen from its lip          100%         -
  behind a low ridge                          0%         -
  ...from on top of that ridge               100%         -
```

Hugging cover matters; cover you are merely near does not. A ditch is defilade.
Height sees over. And a hedgerow reads 100% exposure with 100% concealment.

Hovering an order samples the ground a team would occupy and colours each
candidate by how much of a man would show from where the trouble is — including
ground whose cover comes from a fold in the earth rather than anything you could
point at.

## Numbers

```
scene build            ~215 ms at mission start
simulation             0.36 ms/tick        (2% of a 60 Hz budget)
navmesh                ~1170 triangles
path query             0.13 ms             (mean 1.38x straight-line)
sightline              2.12 us over 100 m  (~17 ms/s at full load)
rebuild after a breach ~12 ms steady state
```

## What is deliberately not here yet

- **The PMC layer** — contracts, payroll, gear, a persistent roster. This is
  what makes losing Voss hurt rather than decrementing a counter, and it goes
  on top of a tactical layer that already works.
- **Grenades, breaching, and stances** beyond walk/run.
- **Sound**, which does more for a firefight than most of the visuals.
- **Interior clearing behaviour** — room entry is currently just movement.
