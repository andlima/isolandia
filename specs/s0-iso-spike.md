---
id: s0-iso-spike
area: spike
priority: 10
depends_on: []
description: S0 viability spike — TS + PixiJS isometric world of 4×4 chunks with ~500 A* wanderers, click-to-move player and an fps benchmark
---

# S0 — Isometric viability spike (TypeScript + PixiJS)

## Goal

Confirm (or refute) the TypeScript + PixiJS stack decision in `VISION.md` §3
before any engine work starts. Build a throwaway-quality but measurable demo:
a 4×4 grid of 32×32-tile chunks rendered in isometric projection, ~500
entities wandering via A* on a fixed-tick headless simulation, a
click-to-move player, and a repeatable fps/tick-time benchmark whose results
are written down in the repo.

## Acceptance Criteria

1. **Project scaffold.** A root `package.json` (ESM, `"private": true`) using
   **Vite + TypeScript (strict)** and **PixiJS v8**, with scripts:
   `dev`, `build`, `typecheck` (`tsc --noEmit`), `test` (`node:test` over
   TypeScript, e.g. via `tsx --test`), and `bench` (see AC 9). Runtime
   dependencies are limited to `pixi.js`; everything else is a dev dependency.
   `.gitignore` covers `node_modules/` and `dist/`.
2. **Headless simulation, decoupled from rendering.** All simulation code
   lives under `spike/sim/` and must not import `pixi.js` or reference DOM
   globals (`window`, `document`, `performance` is allowed). A test asserts
   the sim runs in plain Node for ≥ 100 ticks with 500 entities.
3. **World.** 4×4 chunks × 32×32 tiles (128×128 tiles total), generated
   from a **seeded** RNG (seed configurable via `?seed=` query param, fixed
   default). ~15% of tiles are blocked (walls/obstacles) and the walkable
   area is connected (or unreachable targets are handled without errors).
   Chunk boundaries are purely a storage/render concept — paths cross them
   transparently.
4. **Fixed-tick loop.** Simulation advances at **10 ticks/s** with an
   accumulator (catches up with a capped number of ticks per frame; never
   spirals). Simulation state is mutable (no per-tick immutable copies).
   Rendering interpolates entity positions between the previous and current
   tick, so movement looks smooth at display refresh rate.
5. **Wanderers.** Entity count configurable via `?n=` (default 500). Each
   wanderer picks a random walkable destination, computes an **A\*** path
   (8-directional or 4-directional — choose one and document it; no corner
   cutting through blocked tiles), follows it one tile per N ticks, and
   picks a new destination on arrival. Path requests are **budgeted** (max
   requests per tick, queued otherwise) so a burst of 500 requests cannot
   stall a tick.
6. **Isometric rendering.** Classic **2:1 dimetric** projection with
   64×32 px tile diamonds. Tiles and entities are procedural placeholders
   (colored diamonds / simple shapes drawn with Pixi Graphics or generated
   textures) — no external art assets. Requirements:
   - Each chunk's static ground layer is built once and cached (e.g.
     `cacheAsTexture` / render texture), not redrawn per frame.
   - Chunks and entities outside the viewport are culled.
   - Entities (and blocked tiles drawn as raised blocks, if any) are
     depth-sorted correctly so nearer objects occlude farther ones.
7. **Camera and input.** Pan (drag and/or WASD/arrow keys), zoom (mouse
   wheel, clamped), and **click-to-move**: clicking a tile converts screen →
   world → tile coordinates (inverse projection, zoom- and pan-aware) and
   the player (visually distinct entity) paths there via the same A*. The
   clicked target is highlighted. Touch: a tap acts as click-to-move so the
   demo is usable on a phone.
8. **HUD.** On-screen overlay showing fps (rolling average), frame time,
   average and p95 sim tick time (ms), entity count, and visible chunk
   count. Togglable with a key.
9. **Benchmark mode.** `?bench=<seconds>` runs the demo with a
   deterministic camera sweep over the whole map for the given duration and
   then publishes a JSON result (fps avg/p5/min, frame-time p95, tick-time
   avg/p95, entity count, user agent, renderer type WebGL/WebGPU) to
   `window.__benchResult` and the console. `npm run bench` builds, serves
   the build, runs it in Playwright (Chromium) with `n=500` and `n=2000`,
   and writes the results to `docs/spikes/s0-bench.json`.
10. **Unit tests** (`npm test`, headless) cover at least: iso projection and
    its inverse round-trip (including under zoom/pan), A* (finds a path,
    respects blocked tiles and no corner cutting, returns "no path" for
    unreachable targets), seeded world generation determinism, and the
    tick accumulator (correct tick count for given elapsed time, catch-up
    cap).
11. **Verify gates.** `.spec.toml` gains `[[verify.gates]]` for
    `npm run typecheck`, `npm test` and `npm run build` (with an
    `install_command = "npm ci"` under `[bootstrap]`), and all pass.
12. **Results write-up.** `docs/spikes/s0-results.md` records: how to run
    the demo and the benchmark, the measured desktop numbers from AC 9
    (noting whether headless Chromium used GPU or software rendering), an
    empty table for manual measurements on a mid-range laptop and a phone
    (to be filled by a human), observed bottlenecks, and a clear
    preliminary verdict on TS + Pixi with the risks that remain.

## Out of Scope

- YAML loading, packs, namespaced IDs, measurements, expressions (M0).
- Real art, sprite sheets, asset manifest, walls with cutaway, multiple
  floors (M1/M6).
- Perception, behaviors, combat, items — wanderers only walk.
- Web Worker offloading of the sim (may be mentioned as a follow-up in the
  write-up if tick time is a bottleneck).
- Tauri/Electron packaging, save/load, Tiled maps.
- Making the spike code reusable engine code — it may be discarded; clarity
  and measurability beat architecture.

## Design Notes

- Suggested layout:
  ```
  index.html
  spike/main.ts          # bootstrap: parse query params, create app, loop
  spike/sim/             # world gen, rng, grid, astar, entities, tick loop (no Pixi/DOM)
  spike/render/          # iso projection, chunk layers, entity sprites, camera, HUD
  spike/bench.ts         # bench-mode camera sweep + stats collection
  scripts/bench.mjs      # Playwright runner for `npm run bench`
  test/*.test.ts
  ```
- Projection (2:1, tile 64×32): `screenX = (x - y) * 32`,
  `screenY = (x + y) * 16`; the inverse must account for camera offset and
  zoom. Keep projection functions pure so they are unit-testable.
- Depth sort key: `x + y` (then `x` as tiebreaker) on interpolated
  positions; sorting only visible entities is enough.
- A* on a 128×128 grid: use a binary heap and typed arrays
  (`Float32Array`/`Int32Array`) indexed by `y * width + x`; avoid allocating
  per-node objects. Octile heuristic if 8-directional.
- Use a small seeded PRNG (e.g. mulberry32) — no dependency needed.
- Playwright is a dev dependency used only by `npm run bench`; it is **not**
  a verify gate (browser download is not guaranteed in CI/sandbox). If the
  browser cannot be installed in the implementation environment, still ship
  the script, and state in `s0-results.md` that the numbers are pending.
- VISION.md §3.7: minimal dependencies — justify anything beyond `pixi.js`,
  `vite`, `typescript`, `tsx`, `playwright`, `@types/node`.

## Agent Notes

- Read `VISION.md` (Portuguese) §3, §5 (S0 row) and §6 first.
- Get the headless sim + tests green before touching Pixi; then render
  tiles, then entities, then input, then HUD/bench.
- PixiJS v8 API differs from v7 (async `app.init()`, `Graphics` chained
  API, `cacheAsTexture`). Check the installed version's types rather than
  relying on memory of older APIs.
- Do not fill in the manual laptop/phone measurements with invented
  numbers — leave them for a human.
