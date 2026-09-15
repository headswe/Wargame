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
npm run dev           # http://localhost:5173
npm test              # headless simulation tests
npm run balance       # measured comparison of three scripted plans
npm run playtest      # drives the real game in a browser (needs `npm run dev` up)
npm run editor-check  # drives the level editor in a browser (ditto)
```

Three pages, all served by the same dev server:

| | |
|---|---|
| `/` | the game — opens on a contract picker; `?level=<id>` skips it |
| `/editor.html` | the level editor |
| `/walls.html` | a look-book of every wall fabric, intact and shot to pieces |

## The one design decision everything else follows from

**The fireteam is the unit of command. The operator is the unit of simulation.**

Nobody can micromanage twelve men's position, facing and cover at 1x speed with
no pause. So you don't. You give three orders, not twelve. A squad order
resolves into one cover slot per operator — scored on protection against the
expected threat, spacing, and whether the position can actually be fired from —
and the operators fight from there on their own initiative.

That makes operator autonomy the single most important system in the game. If
the AI is stupid, no interface saves it.

An order resolves into positions by two questions, not one: how much of a man
shows from where the trouble is, and how much of the ground he is meant to cover
he could actually engage. Asking only the first is what made it impossible to
line a wall — candidates were sampled on rings around the click, so four men
landed inside four metres of a forty-metre wall, and behind anything solid every
one of them scored a perfect nothing-shows and the team was posted somewhere it
could not shoot from. The search walks the cover itself now, and the pull back
towards the cursor is charged four times more for depth than for frontage,
because a firing line is wide and shallow.

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

## You can watch instead of playing

The game opens on a contract picker: two maps, and for each one the choice of
taking it yourself or watching a scripted assault play out.

The watching is not a demo mode. A whole run of balance figures has accumulated
in this README describing assaults nobody has ever seen — "the careful plan
leaves 9.4 of 12 standing" is a number until you sit and watch the plan go
wrong, at which point it is a design note. Spectating runs **exactly** the
script `npm run balance` scores, out of the same file, so the two can never
drift into describing different games. Watch `bounding` on Stepove and you are
watching the run that produced the number.

The order verbs go dead while watching, and the controls card that lists them
goes away with them.

Fog of war goes with them too. It is there to make a player commit to a decision
without knowing what is behind the wall, and a spectator has no decision to
commit to — so all it does is hide the fight he opened the page to watch, and
particularly the half of it that is the point, since everything the defence does
about the attack happens out of the attacker's sight. It is one flag on the
simulation rather than a special case threaded through five renderers, because
units, tracers, ordnance, the objective marker and the fog shader all already ask
the same two questions. The camera needed the same treatment for the same reason:
opening on the start line meant watching an empty field with the fight eighty
metres away, so it frames the whole contract instead.

## The defence is commanded, and can be fooled

Measured over five assaults, a surviving defender used to end the mission a mean
of **two metres** from where he started, and most of that was routing. The only
reaction on that side was one man shuffling seven metres when he personally got
too exposed. So the defence was not a defence — it was a set of turrets with
morale, it played the same way every time, and the only question an attack had
to answer was which turret to shoot first.

There is a commander now, with the three things a position needs: a reading of
where the weight of the attack is, a reserve, and the willingness to give ground
before a squad is destroyed rather than after. The same defenders now end a mean
of **fifteen metres** from where they started, and 72% of them move at all
against 28%.

It is deliberately bad at its job. It only thinks every fourteen seconds, it
needs several sightings that agree before it believes anything, and once it has
committed the reserve it will not reconsider for the best part of a minute.
Everything interesting about a defence lives in the gap between what is
happening and what it believes — so a commander who reads an attack instantly
and correctly is unbeatable at worst and whack-a-mole at best, and closes the
one gap that makes a feint worth the men it costs to show.

`test/command.test.ts` asserts the deceivability directly: a feint in the west
pulls the reserve west, the real attack in the east cannot buy it back cheaply,
and scattered sightings that agree about nothing move nobody.

**It costs them, and that is the honest state of it.** Before the commander,
59% of the defence's casualties were taken on their feet — men routing. With it,
79%: repositioning under observation is expensive, and this side cannot yet
bound or throw its own smoke, so a move is four men standing up at once. Over
twenty seeds the careful plan went from leaving 2.4 defenders standing to
leaving 0.5, which widened the skill gradient from 4.5 operators to 7.3 for a
reason nobody should be pleased about: the attack is not outfighting them, it
is watching them stand up. Giving the defence bounds and smoke is the next
piece, and it is the fix — not making the commander move less.

## Controls

| Input | Effect |
|---|---|
| Right-click | Move tactically — weapon up, hugs cover, reacts instantly |
| Double right-click | Run — fast, weapon down, ignores cover, loud, gets you seen |
| Right-click + drag | Aim. Hold and turn: the destination is fixed where you pressed, and the preview re-plans as you swing, because cover is measured against where the trouble is |
| Left-click / drag | Select a team / box-select |
| 1–3, Tab | Pick a team |
| Q / E | Rotate the camera in 45° steps |
| WASD, middle-drag, wheel | Pan and zoom |
| Space | Centre on the selected team |
| Esc | Back to the contract picker |
| F | Cover overlay — every protected face you have seen |

## Reading the board

The hardest problem in an isometric 3D tactics game is that you genuinely
cannot tell which side of a wall is safe. The answers:

- **Cover pips** — a bar drawn on the face that protects you. Green for
  full-height, amber for waist-high, dimmed when it faces the wrong way.
  Hover with a team selected to see what an order would buy before you give it.
- **Planned positions**, hued by how much of a man shows and *drained of colour*
  when he could not fight from there. A row of grey posts means the wall you are
  pointing at is somewhere to hide, not somewhere to fight — which is the single
  most expensive thing about an order to find out afterwards.
- **X-ray silhouettes** — your own operators show through geometry.
- **Ghost rings** — last known position of a contact you have lost.
- **Fog shades the geometry itself**, not just the floor, so you cannot read
  the compound layout through unexplored blackness.

## Layout

```
src/sim/      the whole game, deterministic, zero rendering imports
src/render/   three.js: level, units, fog, tracers, cover markers
src/editor/   the level editor
src/input/    mouse and keyboard
src/ui/       DOM HUD
test/         headless simulation tests
tools/        scripted browser checks and the balance harness
```

The split is load-bearing, not tidiness. The simulation runs headless at
thousands of ticks a second, which is what makes it possible to ask questions
like "does flanking actually beat a frontal assault across 24 seeds" and get an
answer in a few seconds. It also means the same seed replays exactly.

## A level is data

A level is a list of operations applied in order, and nothing else. Every one is
a plain object that survives a round trip through JSON, which is what makes a
level something that can be saved, diffed, generated, validated and edited
rather than a function that happens to draw one.

```ts
{
  version: 1,
  id: 'stepove', name: 'Stepove', brief: '...',
  size: { width: 170, height: 130 },
  terrain: [
    { op: 'rolling', amplitude: 1.5, wavelength: 38, seed: 11 },
    { op: 'cut', path: [...], width: 6.5, depth: 1.7, surface: Surface.Mud },
    { op: 'road', path: [...], width: 7 },
  ],
  structures: [
    { op: 'building', rect: { at: {...}, width: 15, depth: 11, angle: -0.22 },
      openings: [{ side: 2, at: 7.2, width: 1.6, kind: 'door' }] },
  ],
  spawns: { teams: [...], enemies: [...], objectives: [...] },
}
```

**Order is a program, not presentation.** A road laid before a ditch is cut
through by it; one laid after rides over it. The editor can reorder them because
that distinction is the only way to say which you meant.

Terrain operations: `heightmap`, `surfacemap`, `rolling`, `mound`, `bank`,
`cut`, `road`, `paint`, `crater`. Structures: `building`, `wall`, `revetment`,
`hedgerow`, `obstacle`. Linear features follow a curve through their control
points rather than cornering between them, because a polyline kink gets carved
into the heightfield as a crease visible from across the map.

`validateLevel` reports everything wrong with a level rather than throwing on
the first problem, because an editor has to be able to show work in progress and
an author needs the whole list. `migrate` brings a file written by an older
build forward; a file from a newer one is refused rather than half-read.

## Buildings have doors and windows

A building is a closed polygon of walls plus whatever divides the inside.
Openings are addressed as *two metres along the north wall* — the way anybody
would say it out loud — rather than as a fraction of the whole perimeter, which
meant that widening a house moved every window in it.

A window is an opening rather than a slot cut to the roof: it leaves a sill you
shoot over and cannot climb through, and a lintel above it that is solid. That
needed the sightline solver to learn a second question. It answers *how low can
I see*, which is right for walls and crests because those stand on the ground —
and a lintel does not; it hides the top of a target rather than the bottom. The
same walk now carries a ceiling alongside the waterline, by the same equation
upside down.

On flat ground a lintel changes nothing, since every sightline between two men
on one plane passes under it. It starts mattering the moment anything is above
anything else, which is the point: it is what an upper floor will need in order
to exist.

## The editor

`/editor.html`. It mounts the game's own renderer — an editor that draws its own
approximation of the world is an editor that lies, and every disagreement
between the two is a bug found later and blamed on the game.

Two decisions carry most of it. Every operation is reduced to a list of handles
and an outline, so one drag implementation serves all of them; adding an
operation makes it editable by saying where its points are. And undo is
whole-document snapshots rather than inverse operations — a level is tens of
kilobytes of JSON, and an undo method per edit is where editors grow their most
embarrassing bug.

**The overlays are the actual reason it exists.** Placing a wall accurately is
not hard and does not need a tool. Knowing whether that wall made the ground in
front of it a killing zone, or left an approach nobody can cover, is the job —
and nothing about a 3D view of some boxes tells you any of it. Every layer is
computed with the game's own code, because an overlay that disagrees with the
simulation is worse than none at all, being believed.

Pointed at Stepove, *what the defence covers* reports 65% of the walkable ground
covered and **35% seen by nobody**, and draws the uncontested western approach
in plain blue. The sightline probe says the machine gun position holds 38 metres
of ground on average.

| | |
|---|---|
| `V` `X` `Q` | select, measure, sightline probe |
| `B` `W` `L` `O` `H` | building, wall, low wall, obstacle, hedge |
| `G` `R` `D` `K` `M` `C` `U` `P` | sculpt, road, ditch, bank, mound, crater, paint, patch |
| `1` `2` `3` | operator, defender, objective |
| `[` `]` | turn the selection (or the armed piece) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo, redo |
| `Ctrl+C` / `Ctrl+V` | copy, paste — through storage, so it crosses levels |
| `Ctrl+↑` / `Ctrl+↓` | reorder the selected operation |
| `F` `T` | frame the level, look straight down |
| right-drag / shift-right-drag / wheel | pan, orbit, zoom |

Checks that need the level *built* rather than merely read — a house whose door
a wall was laid across, an objective no team can reach — run continuously
alongside the structural ones. Playtest hands the running game exactly what is
on screen, not the last thing saved.

## The world

Terrain is a **heightfield**, and that is what lets ground do tactical work:
dead ground you can cross unseen, a reverse slope a defender sits behind, and a
ditch you are genuinely *below* rather than beside. Roads and ditches are
operations on the surface rather than objects placed on it — a road flattens
across its width while still riding over the hill it crosses, a ditch cuts down,
a shell deforms the ground and throws up a lip.

Structures are **vector segments** at any angle, with a fabric, hit points, and
a sill/top pair so one type covers a full wall, a waist-high revetment, a window
sill and the lintel above it. Props carry the category a grid cannot express:
bushes are **concealment, not cover** — they hide you without stopping anything.

Each fabric is drawn as the thing it is rather than as a stretched box: panels
under an oversailing coping course for masonry, staggered courses for a sandbag
revetment, posts and rails for a fence you can see through, a low spill of
chunks for rubble. Runs are cut into panels that each stand on the ground
beneath themselves, so a long wall climbs a slope instead of hovering over it.
Cover is the subject of this game, so what a piece of it is made of has to be
readable at a glance from across the map.

What is underfoot does something too: a road is the quickest way across a map
and the most exposed, and the mud in the bottom of a ditch is slow enough that
taking it is a decision.

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

Measured on Stepove — 170×130 m, 135 wall segments, 253 props, 26 men.

```
scene build            ~365 ms at mission start   (was 215 ms before lintels)
simulation             0.91 ms/tick               (5% of a 60 Hz budget)
navmesh                ~2850 cells
sightline              1.50 us over Stepove       (1.39 us before the ceiling test)
level rebuild (editor) ~145 ms for a structure edit, terrain reused
overlay sweep          ~115 ms for 5,500 samples against 14 defenders
```

The simulation cost has risen with the last few passes — per-soldier nerve, the
ceiling term in the sightline solver, richer posture and ordnance. Still five
per cent of a frame, so it is recorded rather than worried about.

## What is deliberately not here yet

- **The PMC layer** — contracts, payroll, gear, a persistent roster. This is
  what makes losing Voss hurt rather than decrementing a counter, and it goes
  on top of a tactical layer that already works.
- **Upper floors.** `Building.storey` is reserved and always 0. The lintel work
  above was the prerequisite; elevation is the one addition that changes
  sightlines qualitatively rather than just moving them.
- **Roofs**, which is why a building still reads as a plan rather than a
  building. Same piece of work as the storey.
- **Sound**, which does more for a firefight than most of the visuals.
- **Interior clearing behaviour** — room entry is currently just movement.
- **Emplaced crew-served weapons**, which would fix a defence whose belt-fed is
  a single point of failure.
- **A mission shape that bites** — a clock, reinforcements, extraction. Nothing
  currently makes time cost anything, so the correct way to play any contract is
  slowly: there is no pressure a careful plan trades against, and the only limit
  on patience is the player's. A contract needs a reason to hurry before its
  tempo decisions mean anything.

Only ever verified on headless software rendering at a few frames a second. It
has never been looked at on a real GPU.
