# Performance (M6 chunked world)

Spec: `specs/m6-chunked-world.md`. The target is the zombie **city** (the
`town` base's city, populated by the `zombie` mod since M7): a
343×343 composite map (roomier since `roomier-maps`; 256×256 before),
two floors in places, ~960 entities (960 since `populate-density`: 895
placed by the four density entries, the 58 house crawlers, six spawns and
the player; 961 with the hand-counted rects before it), at the 10 Hz tick. Recorded target (not a test gate): **steady p95 ≤ 10 ms per tick in
Node** on the dev machine.

## How to run

```bash
npm run bench:sim -- --packs std,std-needs,town,zombie [--ticks 3000] [--seed 1] [--active-radius 64|none]
npm run bench:sim -- --packs std,std-needs,town,vampire
npm run bench:sim                     # the S0 spike and stress worlds, unchanged
```

`--packs` runs the **real** `World` on a shipped game, with no rendering.
The player walks a fixed route (map centre → the four corners at 10 % / 90 %
→ centre, re-planned whenever it stops, a waypoint counting as reached
within one tile), so the active area moves across the map. It reports tick
avg/p95/max, active entities (avg, min–max), dormant entities, A*
expansions per tick (avg, max) and the search counters (`world.pathStats`).
`--active-radius` overrides `start.simulation.active_radius` for
comparison.

## Results (Node)

Dev machine: WSL2 Linux, 8 cores, Node v24.14.1. 3000 ticks (5 sim
minutes), seed 1. The max is the first ticks (JIT warm-up and the first
region labelling of the city's 235 298 cells).

| Game | Map | Entities | Active radius | Tick avg | Tick p95 | Tick max | Active avg (min–max) | Dormant avg | A* expanded/tick avg | max | Searches | Region rejects | Budget hits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zombie | city 343×343×2 | 961 | 64 | 0.26 ms | 0.46 ms | 36.3 ms | 144 (73–250) | 817 | 17.5 | 3912 | 5038 | 0 | 0 |
| zombie | city 343×343×2 | 961 | none | 0.44 ms | 0.72 ms | 32.0 ms | 961 | 0 | 17.8 | 3912 | 5160 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | 64 | 0.09 ms | 0.16 ms | 6.2 ms | 138 (41–154) | 16 | 5.6 | 4253 | 140 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | none | 0.10 ms | 0.19 ms | 6.4 ms | 154 | 0 | 4.7 | 4233 | 142 | 0 | 0 |
| garden | garden 24×16 | 6 | 64 | 0.01 ms | 0.02 ms | 1.4 ms | 6 | 0 | 0.3 | 140 | 97 | 0 | 0 |

The steady p95 on the city is **0.46 ms**, ~22× under the 10 ms target
(0.38 ms on the old 256×256 city: the bigger map spreads the same NPCs
thinner, so fewer are active, but the walk is longer and NPC searches
cross wider rooms and yards). The max rose with the map: the first region
labelling covers 1.8× the cells. Load (parse, compose, validate) takes
~220–260 ms and `World.create` ~80–100 ms.

## Edge walls

Since `edge-walls`, walls, doors, windows and fences are thin edges between
cells instead of cells (`specs/tasks/edge-walls.md`). Steps, A* and sight
read the edge arrays (`blockN`/`blockW`, `opaqueN`/`opaqueW`) next to the
cell arrays. Same machine, route and seed, 3000 ticks:

| Game | Map | Entities | Active radius | Tick avg | Tick p95 | Tick max | Active avg (min–max) | Dormant avg | A* expanded/tick avg | max | Searches | Region rejects | Budget hits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zombie | city 343×343×2 | 961 | 64 | 0.27 ms | 0.56 ms | 30.4 ms | 146 (73–254) | 815 | 25.2 | 3662 | 7491 | 0 | 0 |
| zombie | city 343×343×2 | 961 | none | 0.39 ms | 0.62 ms | 22.9 ms | 961 | 0 | 21.4 | 3662 | 6081 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | 64 | 0.09 ms | 0.18 ms | 7.4 ms | 138 (42–154) | 16 | 8.0 | 4333 | 371 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | none | 0.09 ms | 0.16 ms | 9.9 ms | 154 | 0 | 9.1 | 4334 | 408 | 0 | 0 |
| garden | garden 24×16 | 7 | 64 | 0.01 ms | 0.03 ms | 2.0 ms | 7 | 0 | 0.3 | 140 | 97 | 0 | 0 |

The city's steady p95 went from 0.46 to 0.56 ms (1.2×), still ~18× under
the 10 ms target; no figure rose above 2×. Rooms grew by a row and a
column when the wall cells became edges, so NPCs search a little more
(A* expansions per tick 17.5 → 25.2 on the city, more searches on the
estate), which accounts for the rise.

## NPC perception

Since `npc-perception`, every shambler and crawler (900 of the city's 960
entities), the estate's bats and the garden's animals carry a sight sense
(`senses.sight`), and a **senses step** at the end of the status update
keeps or loses each one's seen target and looks for a new one. The search
uses a second chunk index holding only the entities some sense looks for
(the city: the player alone), so an entity with nothing in range reads a
few empty buckets; the step costs ~0.03 ms per tick on the city with
dormancy (~0.09 ms with every entity awake). Same machine, route and seed,
3000 ticks:

| Game | Map | Entities | Active radius | Tick avg | Tick p95 | Tick max | Active avg (min–max) | Dormant avg | A* expanded/tick avg | max | Searches | Region rejects | Budget hits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zombie | city 343×343×2 | 960 | 64 | 0.22 ms | 0.34 ms | 22.5 ms | 143 (84–250) | 817 | 24.6 | 3662 | 7282 | 0 | 0 |
| zombie | city 343×343×2 | 960 | none | 0.45 ms | 0.66 ms | 21.2 ms | 960 | 0 | 21.9 | 3662 | 6284 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | 64 | 0.10 ms | 0.16 ms | 10.0 ms | 138 (42–154) | 16 | 8.0 | 4333 | 371 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | none | 0.11 ms | 0.20 ms | 10.5 ms | 154 | 0 | 9.1 | 4334 | 408 | 0 | 0 |
| garden | garden 24×16 | 7 | 64 | 0.01 ms | 0.03 ms | 2.9 ms | 7 | 0 | 0.3 | 140 | 97 | 0 | 0 |

No figure moved beyond run-to-run noise (the same build measured
0.21 / 0.30 ms on the city right before the change; the A* counters are
identical, since the converted behaviors chase and search as before).
Node v24.14.1.

## Steps

The spec's order, with what each step did to the numbers (the 256×256
city of the time, 961 entities; the "before" figures are the same build with the step's feature
switched off or measured right before it landed):

1. **Composite maps and populate**: the city itself; 0.28 ms avg per tick
   with no dormancy, profiled as status updates (~19 %), drift (~9 %) and
   the per-entity loops of `step`.
2. **The benchmark**: `bench:sim --packs` (above).
3. **Dormancy** (active radius 64): avg 0.35 → 0.22 ms, p95 0.59 → 0.38 ms.
   About 70 % of the NPCs are dormant on average; drift, systems and
   statuses still run for them, so the gain is the think and movement work.
   Two generic cuts in the per-entity work came with it: a `for` filter that
   is exactly `self.has_tag("…")` is decided once per archetype, and the
   status update no longer allocates per entity (0.275 → 0.207 ms avg with
   no player movement).
4. **Region labels and budget**: the city is one connected region (doors
   join every building to the roads), so no goto was rejected or cut off on
   this route: the largest player search expanded 4 922 nodes, the largest
   NPC search 1 108 on the estate. Labelling the 131 072 cells takes 3–7 ms
   and happens on the first search and after `set_tile`. What the labels
   buy is the worst case: an unreachable goal fails without flooding the
   map (tested), and a budget bounds any search.
5. **Chunk index**: hearing visits only the 16×16 chunks a noise reaches;
   with only a few noises per tick the difference is within noise here.
   `entitiesNear` is the query API for later systems.
6. **Renderer**: lazy, evicted chunks and culled sprites (see
   `docs/iso.md#lazy-chunks-and-culling`); not measurable headless.

## Browser

`npm run bench` measures the real renderer (`src/iso`) in a browser: it
builds, serves the build once, runs `?bench=<seconds>` on each target and
writes `docs/bench/<target>.json` (`generatedAt`, `host`, `browser`,
`seconds`, `runs`) with a one-line summary per run on the console.
`BENCH_TARGETS` (default `spike,zombie,vampire`) names the targets:
`spike` is the S0 spike page (`spike.html`, 20 s, one run per `BENCH_N`
count, see `docs/spikes/s0-results.md`); any other name is a game, run on
the game page with that game's resolved stack (`?packs=<game>` lets the
resolver add the dependencies, as `npm run smoke` does), 60 s by default.

```bash
npm run bench                                       # spike (n=500, 2000), zombie and vampire
BENCH_TARGETS=zombie BENCH_SECONDS=30 npm run bench  # one game, shorter
BENCH_HEADED=1 npm run bench                        # a visible Chromium (the real GPU when there is one)
BENCH_CHROMIUM=/usr/bin/chromium npm run bench      # a system browser when Playwright's own is missing
BENCH_SEED=7 npm run bench                          # the world seed (default 1)
```

`npm run bench` and `npm run smoke` both build to `dist/` and serve on
fixed ports (4174, 4175): run them one at a time.

### What a run measures

`index.html?packs=<game>&bench=<s>[&seed=N]` loads the game as usual and
then runs the benchmark instead of play: pointer, keys and gestures are
ignored, no window or menu opens, the pace is 1× and never pauses, and the
world ticks from the seed (NPCs move; the player stands where the map
starts it, so the view floor is the start floor and the cutaway is the
one you see in play). The camera follows a path that depends only on
elapsed time, map size and viewport (`src/web/bench.ts`):

1. **Warm-up** (1 s, not measured): on the player at 1×, while the first
   chunks and sprites are built.
2. **Sweep** (80 % of the duration): a serpentine over every 16-cell
   render-chunk row of the map at zoom 0.75, left to right on even rows
   and back on odd ones, hopping one chunk down at the end of each row. It
   covers the whole map whatever the duration, so its speed depends on the
   map and is recorded as `sweepCellsPerSecond` (the city's 22 rows of
   343 cells: ~164 cells/s in a 60 s run). It exercises chunk building
   and eviction, entity sprites coming and going, and the depth sort of a
   moving view.
3. **Overview** (the last 20 %): the map centre at the minimum zoom
   (0.25). Far more chunks are in view than `MAX_BUILT_CHUNKS` (160)
   keeps built, so this is the chunk LRU under pressure and the most
   sprites on screen at once.

Per frame the run records the frame interval, the CPU time of the shell's
frame (sim ticks + scene update + render call) and the scene stats
(visible entities, built and visible chunks); per tick, the tick time. The
summary is published three ways when the run ends: `window.__benchResult`,
one `BENCH_RESULT <json>` line on the console, and an on-screen overlay
with the key figures and a **Copy JSON** button (for a phone, or a browser
without a debugger attached). It holds `fpsAvg`, `fpsP5`, `fpsMin`,
`frameMsP95`, `cpuMsAvg`, `cpuMsP95`, `tickMsAvg`, `tickMsP95`, `ticks`,
`frames`, `visibleEntitiesAvg`, `builtChunksMax`, `visibleChunksAvg`,
`activeAvg`, `dormantAvg`, `droppedMs` (the loop's backlog dropped under
its tick cap: anything but 0 means the sim could not keep up),
`worldEndedAtTick` (null unless the game ended during the run, which goes
on regardless), `phases.sweep` and `phases.overview` (the frame figures
per phase), and `renderer` (`webgl` or `webgpu`), `gpu`, `userAgent`,
`viewport` (width, height, devicePixelRatio, Pixi resolution), `packs`
(the resolved directories), `map` (id, width, height, floors),
`entities`, `seed` and `durationS`. Percentiles are nearest-rank, as the
perf line's. The **F3** perf line is on from the start of a run and the
key still toggles it.

The world is deterministic per seed, but the number of frames, and so the
number of ticks each frame runs, depends on the machine: two runs step the
same world but render different tick boundaries. That is fine for a
benchmark; compare the figures, not the frames.

### Software rendering is not a result

A `gpu` string naming **SwiftShader** or **llvmpipe** is software
rendering: it is what headless Chromium, and any Linux session without
GPU access (the agent sandbox, a plain WSL shell), falls back to, and its
single-digit fps say nothing about the renderer. Never record such a run
in the tables below and never commit its JSON. `docs/bench/*.json` is
committed only when it was generated on a real GPU; a software-rendered
file is left out (delete it after reading it).

### A real GPU from WSL: attach Windows Chrome

Headless Chromium under WSL renders in software and a headed one needs
WSLg. The real GPU is reached by attaching the script to a Chrome that
runs on Windows with its DevTools port open:

```bat
:: in Windows (cmd or PowerShell), on a scratch profile
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-bench
```

```bash
# in WSL
BENCH_CDP=http://localhost:9222 npm run bench
```

`BENCH_CDP` (an `http://host:port` or `ws://…` DevTools endpoint) makes
the script connect over CDP instead of launching: it opens its pages in a
new window (context) of that browser and, on exit, closes only that window
and disconnects. Windows Chrome reaches the WSL preview at `localhost`, so
the default URL works; WSL reaches Windows' `localhost:9222` with WSL2's
mirrored networking mode (or WSL1; otherwise forward the port with
`netsh interface portproxy`). The envelope's `browser` says `(attached)`.
`BENCH_VIEWPORT=WxH` sets the window size (an attached browser otherwise
keeps its own; a launched one defaults to 1920×1080). `BENCH_HOST` (default
`localhost`) is the address the preview binds and `BENCH_PUBLIC_URL`
(default the preview's own URL) the base URL the browser opens, for a
browser that sees the server at another address (`BENCH_HOST=0.0.0.0` with
the machine's LAN address in `BENCH_PUBLIC_URL`).

### A phone

The phone route is manual: serve the build on the LAN, open the URL on the
phone and read the overlay.

```bash
npm run build && npm run preview -- --host    # prints the network URL
# on the phone: http://<lan address>:4173/index.html?packs=zombie&bench=60
```

When the run ends the overlay shows fps avg/p5, frame p95, tick avg/p95,
the per-phase fps and the `gpu` string; **Copy JSON** puts the full result
on the clipboard to paste into a note or a chat. Driving a phone from the
script (remote debugging over USB) is not supported.

### Results

Per game: the automated row is filled from `docs/bench/<game>.json` when a
real GPU is available; the laptop and phone rows are filled by a human
with the device (`BENCH_CDP` from WSL, or the phone route). A row stays
**pending** until a hardware `gpu` string has been seen.

**Zombie city** (343×343×2, ~960 entities; 22 chunk rows, 60 s):

| Device | Browser | GPU | fps avg | fps p5 | frame p95 | tick avg / p95 | sweep fps | overview fps | built chunks max | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Dev machine (`npm run bench`) | | | | | | | | | | **pending**: the sandbox's headless Chromium reports `llvmpipe` (software); run with `BENCH_CDP` or `BENCH_HEADED=1` on a host with a GPU |
| Mid-range laptop | | | | | | | | | | |
| Phone | | | | | | | | | | |

**Vampire estate** (128×128×2, ~154 entities; 8 chunk rows, 60 s):

| Device | Browser | GPU | fps avg | fps p5 | frame p95 | tick avg / p95 | sweep fps | overview fps | built chunks max | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Dev machine (`npm run bench`) | | | | | | | | | | **pending**: as above |
| Mid-range laptop | | | | | | | | | | |
| Phone | | | | | | | | | | |

The free-play check still works for a quick look: `npm run dev`, press
**F3**, walk across the city and watch the perf line (tick avg/p95, fps,
active and dormant entities, built and visible chunks).
