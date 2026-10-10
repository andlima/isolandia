---
id: browser-bench
area: web
priority: 45
depends_on: []
description: "Browser benchmark for the real renderer — `?bench=<s>` on the game page drives a deterministic camera sweep and overview over the loaded map and publishes fps, frame, tick and chunk figures with the GPU string (on screen and as `window.__benchResult`); `npm run bench` runs the spike and the shipped games to `docs/bench/`, and `BENCH_CDP` attaches to an already running browser so Windows Chrome or a phone can give real-GPU numbers"
---

# Browser benchmark for the real renderer

## Goal

The only browser frame-rate measurement in the repo is the S0 spike's `?bench`
mode on a 128×128 placeholder world, and even that has never been run with a
real GPU (`docs/spikes/s0-results.md` still says "pending"). The renderer that
matters now is `src/iso` on the shipped games: the 343×343 zombie city with
~960 entities, two floors, edge walls and cutaway. `docs/perf.md` measures its
tick in Node and calls browser fps "a manual follow-up". This spec makes that
follow-up a reproducible command: the game page gets the same kind of bench
mode the spike has, `npm run bench` runs it on the shipped games, and the
script can attach to a browser it did not launch, which is how a real GPU is
reached from WSL (Windows Chrome) or from a phone.

## Acceptance Criteria

1. **`?bench=<seconds>` on the game page.** With `?packs=…` (and optionally
   `?seed=`), `index.html?bench=30` loads the game as usual, then runs a
   benchmark instead of accepting play input: pointer, keyboard and gesture
   input are ignored, the pause menu, help overlay and panels stay closed,
   the pace is forced to 1× and never paused, and the camera is driven by the
   bench path (criterion 2) instead of `CameraRig`. The world ticks normally
   from the seed (NPCs move, the player stands where the map starts it). A
   non-positive or non-integer `?bench=` value shows the parameter error
   screen like the other parameters (`parseParams` gains `bench`, 0 when
   absent, with an error entry on bad input). Without `?packs=` the title
   screen shows as before and `bench` is ignored.
2. **Deterministic camera path.** A pure function of elapsed time, map size
   (cells and render chunk size) and viewport, in `src/web/bench.ts`, after
   the spike's `BenchRunner.camera`: a 1 s warm-up on the player (not
   measured), then **80 %** of the duration in a **serpentine sweep** over
   every render chunk row of the map at zoom **0.75**, then the remaining
   **20 %** as an **overview** of the map centre at `MIN_ZOOM`. The sweep
   covers the whole map whatever the duration, so its speed is map-dependent;
   the result records `sweepCellsPerSecond`. The view floor stays the start
   floor and cutaway behaves as in play. Tests cover the path: it starts on
   row 0, every chunk row is visited, the zoom values and phase boundaries
   are right, and the overview is centred on the map.
3. **Measurements.** Per frame: frame interval, CPU time of the shell's
   frame (sim ticks + scene update + render call), `SceneStats`
   (`visibleEntities`, `builtChunks`, `visibleChunks`); per tick: tick time.
   The summary has the spike's shape (`fpsAvg`, `fpsP5`, `fpsMin`,
   `frameMsP95`, `cpuMsAvg`, `cpuMsP95`, `tickMsAvg`, `tickMsP95`, `ticks`,
   `frames`, `visibleEntitiesAvg`, `phases: { sweep, overview }` each with
   the per-phase figures) plus: `packs` (resolved directories), `map` (id,
   width, height, floors), `entities`, `activeAvg`, `dormantAvg`,
   `builtChunksMax`, `visibleChunksAvg`, `droppedMs` (the loop's backlog,
   criterion for "the sim could not keep up"), `worldEndedAtTick` (null
   unless the game ended during the run; the run continues regardless),
   `renderer` (`webgl`/`webgpu` from Pixi), `gpu` (the `WEBGL_debug_renderer_info`
   unmasked renderer, or Pixi's adapter info for WebGPU), `userAgent`,
   `viewport` (width, height, devicePixelRatio, Pixi resolution), `seed`,
   `durationS`. Percentiles are nearest-rank, as in `src/web/perf.ts`
   (`Samples.percentile`); the summarizer is pure and tested with fixed
   samples.
4. **Publishing the result.** When the run ends the page sets
   `window.__benchResult` to the summary, logs one line
   `BENCH_RESULT <json>` to the console, and shows the key figures **on
   screen** in a DOM overlay (fps avg/p5, frame p95, tick avg/p95, per-phase
   fps, the `gpu` string) with a **Copy JSON** button, so a phone or a
   browser without a debugger attached can still report. The F3 perf line
   keeps working during the run.
5. **`npm run bench` runs targets.** `scripts/bench.mjs` takes
   `BENCH_TARGETS` (comma-separated, default `spike,zombie,vampire`): `spike`
   is the existing spike run (unchanged: `BENCH_N`, seed, 20 s default), a
   game name is the game page with that game's resolved stack (as
   `npm run smoke` passes a short stack and lets the resolver add
   dependencies). Per target it writes `docs/bench/<target>.json` with the
   same envelope as today (`generatedAt`, `host`, `browser`, `seconds`,
   `runs`) and prints the one-line summary. `BENCH_SECONDS` keeps its
   meaning; the default for a game target is **60** (the city's sweep is
   22 chunk rows of 343 cells: 20 s would fly). The spike JSON moves from
   `docs/spikes/s0-bench.json` to `docs/bench/spike.json`; the S0 results doc
   is updated to the new path. `docs/bench/*.json` is **committed** when
   generated on a real GPU and otherwise left out (see 8).
6. **Attach to a running browser.** `BENCH_CDP=<endpoint>` (an
   `http://host:port` or `ws://…` DevTools endpoint) makes the script
   `chromium.connectOverCDP` instead of launching, open its pages in a new
   context of that browser, and close only what it opened. Two companions:
   `BENCH_HOST` (default `localhost`) is the address the Vite preview binds,
   and `BENCH_PUBLIC_URL` (default the preview's own URL) is the base URL the
   browser opens, for when the browser sees the server at a different
   address (Windows Chrome reaches WSL's `localhost`; a phone needs the LAN
   address). `BENCH_VIEWPORT=WxH` sets the viewport of launched browsers
   (default `1920x1080`); an attached browser keeps its own window size
   unless `BENCH_VIEWPORT` is given. `BENCH_HEADED` and `BENCH_CHROMIUM`
   keep working for launched browsers. The `browser` field of the envelope
   says `(attached)` for a CDP run.
7. **Docs.** `docs/perf.md` gains a **Browser** section: how to run, what
   each phase measures, how to attach Windows Chrome from WSL
   (`chrome.exe --remote-debugging-port=9222` plus `BENCH_CDP`) and how a
   phone reports (open the URL on the LAN, read the overlay), an explicit
   warning that a `gpu` string naming **SwiftShader** or **llvmpipe** is
   software rendering and must not be recorded as a result, and a results
   table per game (dev machine via `npm run bench`, mid-range laptop, phone)
   with the automated row filled from `docs/bench/*.json` when a real GPU
   is available and otherwise marked pending with the reason.
   `docs/spikes/s0-results.md` keeps its tables, points at the new JSON path
   and at the Browser section for the attach route. The README's script
   table lists `npm run bench`. `docs/ui.md` documents `?bench=`.
8. **Verification without a GPU.** The implementing environment can run
   Chromium only headless with software GL (see Agent Notes). The gate is:
   `BENCH_TARGETS=zombie BENCH_SECONDS=5 npm run bench` completes, writes a
   JSON whose `gpu` names the software renderer and whose counts are
   plausible (`ticks` ≈ 50, `frames` > 0, `builtChunksMax` > 1,
   `visibleEntitiesAvg` > 0 in the sweep). Do **not** commit a
   software-rendered JSON. `npm run smoke` is unchanged and still passes.
9. **Engine untouched.** No change under `src/core`; the bench lives in the
   shell (`src/web`) and reads `SceneStats` and `World` counters that exist
   already. `npm run typecheck`, `npm test` and `npm run build` pass.

## Out of Scope

- Any rendering optimisation (depth sort buckets, chunk cache sizes, atlas
  ground). This spec measures; a change to the renderer gets its own spec
  with these numbers as its "before".
- Benchmarking the terminal shell, WebGPU comparisons on the game page
  (`?renderer=` stays a spike-only parameter), or an NPC-density sweep like
  the spike's `n`: the games run as shipped.
- Driving a phone from the script (remote debugging over USB); the phone
  route is "open the URL, read the overlay".
- Filling the laptop and phone rows: a human with the device does that.
- Changing the spike's `BenchRunner` beyond what the shared path helper
  needs; the spike page keeps its own code.

## Design Notes

- **Where the hooks are.** `src/web/main.ts`: `parseParams` at the top of
  `main()`; the frame callback near the end computes `cam` from
  `rig.update(...)`, then `scene.update(cam, width, height, loop.alpha,
  now)` returns `SceneStats`, then `app.renderer.render(app.stage)`. The
  bench replaces the `cam` line while running, wraps the frame body to time
  CPU, and reads `loop.droppedMs`, `world.activeCount` and
  `world.entities.length`. Tick times come from the `FixedTickLoop` step
  (where `perf.tick` is already fed). `input.ts` and `gestures.ts` have the
  pointer and key handlers to leave disconnected (do not register them, or
  set an `enabled` flag as the spike's controller does).
- **Camera.** `cameraAt(x, y, screenX, screenY, zoom)` in
  `src/iso/projection.ts` builds a `CameraState` that puts iso point (x, y)
  at a screen point, which is all the path needs: project the cell with
  `worldToIso`-equivalent (`projection.ts`), centre it. Render chunks are
  16×16 (`src/iso/chunks.ts`); `MAX_BUILT_CHUNKS = 160` means the overview
  of the city cannot have every chunk built, which is what the overview is
  for (the LRU under pressure).
- **Reuse.** The spike's `spike/bench.ts` is the model for the path and the
  summarizer. Put the shared pure parts (`benchCamera`, `summarizePhases`,
  the result types) in `src/web/bench.ts` and test them in
  `test/bench.test.ts`; the spike may import them or keep its copy, but the
  spike page must keep producing its current JSON shape (`docs/spikes`
  tables refer to it).
- **GPU string.** WebGL: `gl.getExtension('WEBGL_debug_renderer_info')` and
  `UNMASKED_RENDERER_WEBGL` on Pixi's `renderer.gl`; the spike does this
  already. Software strings seen so far: `SwiftShader`, `llvmpipe`.
- **Script.** `scripts/bench.mjs` builds once, serves once, loops targets.
  For the game page the URL is `index.html?packs=<game>&bench=<s>[&seed=]`.
  `connectOverCDP` returns a browser whose `contexts()[0]` is the user's;
  create a fresh context, and on exit close that context only.
  `preview({ preview: { host: BENCH_HOST } })` binds the server; a `host`
  of `0.0.0.0` makes it reachable on the LAN.
- **Determinism caveat.** The world is deterministic per seed, but frame
  counts and therefore the number of ticks per frame depend on the machine,
  so two runs render different tick boundaries; that is fine for a
  benchmark and the doc should say so.

## Agent Notes

- Read first: `spike/bench.ts`, `spike/main.ts` (how the spike wires it),
  `scripts/bench.mjs`, `scripts/smoke.mjs` (stack resolution and the
  `__iso` ready hook), `src/web/main.ts` (frame loop), `src/web/params.ts`,
  `src/web/perf.ts`, `src/iso/scene.ts` (`SceneStats`),
  `src/iso/projection.ts` (`MIN_ZOOM`, `cameraAt`), `docs/perf.md`.
- Playwright's Chromium is installed on the dev machine via
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu22.04-x64 npx playwright install
  chromium` (Ubuntu 20.04 is not a supported platform). Inside the agent
  sandbox only **headless** works: creating Unix sockets is denied, so a
  headed Chromium cannot reach WSLg's display and exits with SIGTRAP, and
  Windows interop is blocked. Headless reports `llvmpipe`, about 6 fps on
  the spike at n=500: do not read anything into those numbers and do not
  commit them. Use short `BENCH_SECONDS` (5) while iterating; a worktree
  needs its own `node_modules` (`npm ci`), a symlink to the main checkout
  is read-only.
- `npm run bench` and `npm run smoke` both build to `dist/` and serve on
  fixed ports (4174, 4175); run them one at a time.
- Keep the engine-term test happy: nothing genre-specific in `src/`; the
  game names live only in the script's defaults and the docs.
