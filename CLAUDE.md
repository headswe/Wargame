# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A real-time tactical game about a PMC commanding fireteams of operators.
TypeScript + three.js, no framework, no build step beyond Vite.

## Commands

```bash
npm run dev           # http://localhost:5173
npm test              # headless simulation tests, ~30s
npm run typecheck     # tsc --noEmit (also runs as part of build)
npm run build         # typecheck + vite build
npm run balance       # scripted assaults, measured — see "Measure before you argue"
npm run level-report  # ground analysis for every shipped level
npm run playtest      # drives the real game in a browser   } both need
npm run editor-check  # drives the level editor in a browser } `npm run dev` up
```

A single test file: `node --test --experimental-strip-types test/sim.test.ts`.
A single test by name: add `--test-name-pattern "flanking"`.
One map, one plan: `npm run balance -- stepove bounding` (map first, then plan).

The browser tools take an output directory as their first argument and default
to the repo root; pass a scratch directory so screenshots do not land in the
working tree.

## The rule that shapes everything: `src/sim/` is pure

`src/sim/` imports nothing from `three` and nothing from `src/render/`. Check
before adding an import there. This is not tidiness — it is what lets the whole
tactical layer run headless at thousands of ticks a second, which is what makes
`npm run balance` able to answer "does flanking actually beat a frontal assault
across 20 seeds" in a few seconds. Breaking it silently costs the only
instrument this project has.

Everything random draws from `Rng` (mulberry32, `src/sim/rng.ts`) so a mission
replays exactly from its seed. Do not reach for `Math.random()` inside the sim.

Tests run under Node's `--experimental-strip-types`, which erases types rather
than emitting code for them. Anything with runtime semantics is rejected
outright, so **no `enum` of any kind** (plain or `const`) and no constructor
parameter properties anywhere `src/sim/`, `test/` or `tools/` can reach. Hence
the pattern used throughout — a frozen object plus a type of the same name:

```ts
export const Faction = { Player: 0, Hostile: 1 } as const;
export type Faction = (typeof Faction)[keyof typeof Faction];
```

It reads like an enum at every call site and costs nothing at runtime. Follow it
rather than reaching for `enum` and discovering at test time why nobody did.

## Architecture

```
src/sim/      the game, deterministic, headless
src/sim/world/  terrain, occlusion, navmesh, level format
src/render/   three.js views — read the sim, never write to it
src/editor/   the level editor
src/input/    mouse and keyboard
src/ui/       DOM HUD and the contract picker
src/library.ts  levels the player made, in localStorage (editor writes, picker reads)
test/         headless simulation tests
tools/        browser checks and the balance harness
```

Three pages off one dev server: `/` (game, `?level=<id>` skips the picker),
`/editor.html` (`?level=<id>` opens one), `/walls.html` (wall fabric look-book).
All three are real build inputs in `vite.config.ts`.

**A level is data, not a function.** An ordered list of terrain and structure
operations that round-trips through JSON (`src/sim/world/level-data.ts`). Order
is a program: a road laid before a ditch is cut through by it, one laid after
rides over it. `validateLevel` reports every problem rather than throwing on the
first — an editor has to display work in progress. `migrate` brings old files
forward; a file from a newer format is refused rather than half-read.

**Two grids see the world, and both round thin geometry up.** The sightline
field and the navmesh each claim every cell a wall passes through, widening it
to the cell half-diagonal — `STAMP_FLOOR` in `src/sim/world/geometry.ts`. A wall
slightly fatter than drawn is invisible; a wall that is not there is a hole in
the map. The consequence bites constantly: **any opening cut to let a man or a
sightline through must be widened by `max(thickness, STAMP_FLOOR)`**, or it
closes up entirely and nothing tells you.

**Sightlines are a waterline solve, not a ray march.** Exposure is a fraction of
a silhouette, not a distance. A span with an underside (a lintel above a window)
adds a ceiling term — the same equation upside down. See
`src/sim/world/occlusion.ts`.

**The renderer must not approximate the sim.** The editor mounts the game's own
`WorldView` and computes every overlay with the game's own code. An editor or an
overlay that disagrees with the simulation is worse than none, because it is
believed.

## Measure before you argue

`npm run balance` runs scripted assaults across seeds and reports survivors,
rounds fired and — the number that mattered most — how often a defender had a
shot available at all. Treat the absolute numbers as a fixture; what they are
good for is *comparison*, the same plans before and after a change.

Habits this repo has paid for:

- **Run the control.** "79% of defender deaths happen while repositioning"
  meant nothing until the baseline turned out to be 59%.
- **Five seeds is not enough to see a two-man effect.** `BALANCE_SEEDS=20 npm
  run balance` when a change looks like it moved something small.
- **The scripted plans are fixtures, not play.** They exist to hold still. A
  measurement taken against a moving instrument tells you nothing — so if a
  change alters what the plans do, that is the finding, not a nuisance.
- **A shared helper silently buffs both sides.** Defender siting and the
  player's cover search share `findCover`; improving it handed the defence a
  free upgrade and flipped a balance test. Check who else calls what you touch.
- **Do not turn a stopping condition into a metric.** The 200s cutoff in the
  harness is a control so runs are comparable; it is not a win condition, and
  the game has no clock.

## Conventions

Comments say *why*, in prose, at the density of the surrounding file — the
reasoning that would otherwise be lost, including debt and mistakes worth not
repeating. Do not add comments that restate the code.

Commit subjects are what changed *for the player or the reader*, imperative and
concrete: "Make it possible to put men along a wall", "Stop reporting a test
cutoff as if it were a rule". Bodies explain the reasoning and record what was
measured. `git log` is the design record — read it before changing something
that looks arbitrary; it usually is not.

Deliberate debt gets a comment saying it is deliberate and why (see the
`alongCover: false` note in `digIn`, `src/sim/sim.ts`).

## Verifying

`npm test` and `npm run build` are the floor. Anything touching rendering, the
editor or input also needs a browser run — `npm run playtest` or `npm run
editor-check` with `npm run dev` up — because the failures that matter there
(an opening bricked up, a slot with no field of fire, a cursor that will not
place a man along a wall) are invisible to the headless tests and were all
found by looking.
