# S0 — Isometric viability spike: results

Spec: `specs/s0-iso-spike.md`. Stack under test: TypeScript (strict) + PixiJS v8
(WebGL by default, WebGPU opt-in) + Vite, headless sim in plain TS.

## How to run

```bash
npm ci
npm run dev            # open the printed URL
npm test               # headless unit tests (node:test via tsx)
npm run bench          # build + serve + Playwright Chromium, n=500 and n=2000
npm run bench:sim      # headless Sim.step() tick times (no browser)
```

Query parameters:

| Param | Default | Meaning |
|---|---|---|
| `seed` | `1337` | World + entity RNG seed |
| `n` | `500` | Number of wanderers (the player is extra) |
| `bench` | off | `?bench=20` runs a 20 s deterministic camera sweep, then publishes `window.__benchResult` and logs `BENCH_RESULT {...}` |
| `renderer` | `webgl` | `webgpu` to prefer Pixi's WebGPU renderer |

Controls: drag / WASD / arrows to pan, mouse wheel or pinch to zoom (0.2–3×),
click or tap a tile to walk the player (yellow, larger) there. The target tile
is outlined yellow (red flash if it is blocked). `H` toggles the HUD, `Space`
centres on the player.

`npm run bench` env vars: `BENCH_SECONDS` (default 20), `BENCH_N` (default
`500,2000`), `BENCH_SEED`, `BENCH_HEADED=1` (headed browser, real GPU),
`BENCH_CHROMIUM=/path/to/chrome` (use a system browser when Playwright cannot
download its own). Output: `docs/spikes/s0-bench.json`.

The bench run is: 1 s warm-up (not measured), 80 % of the time a serpentine
sweep over every chunk row at zoom 0.75, 20 % a zoomed-out (0.2) view of the
whole map where every block and entity is on screen — the worst case for depth
sorting and draw calls. Results are reported overall and per phase.

## Design choices worth knowing

- **Movement: 8-directional A\*** with octile heuristic and no corner cutting
  (a diagonal step needs both orthogonal neighbours walkable). Typed arrays +
  binary heap, reused between searches via a generation stamp.
- **World**: 4×4 chunks × 32×32 tiles, ~15 % blocked (wall segments + rocks).
  Walkable pockets not connected to the main region are filled, so every
  walkable tile is reachable; A\* still returns `null` for unreachable goals
  and wanderers just re-roll.
- **Ticks**: 10 ticks/s, accumulator with max 5 ticks per frame; any backlog
  beyond that is dropped (the sim slows down instead of spiralling).
- **Path budget**: at most 32 A\* requests per tick, FIFO queue for the rest;
  player clicks jump the queue. The initial burst of 500 requests drains in
  16 ticks.
- **Speed**: wanderers take 3 ticks per tile, the player 2. The sim stores
  continuous positions for the current and previous tick; the renderer
  interpolates with the loop's alpha.
- **Rendering**: each chunk's ground (1024 diamonds) is one `Graphics`
  cached with `cacheAsTexture({ resolution: 1 })`. Blocked tiles are raised
  block sprites that share one depth-sorted container (`sortableChildren`,
  `zIndex = (x + y) * 1024 + x`) with the entities. Culling hides chunks
  (ground + blocks) and entities outside the viewport. The HUD is a DOM
  overlay.
- Entities do not collide with each other (out of scope).

## Measured results

### Headless sim (Node 24, i5-11300H, WSL2)

Measured directly with `Sim.step()` via `npm run bench:sim`
(`scripts/sim-bench.ts`; seed 1337, 600 ticks; the first 100 ticks include
the initial path-request burst):

| n | burst avg | burst p95 | burst max | steady avg | steady p95 | steady max |
|---|---|---|---|---|---|---|
| 500 | 0.98 ms | 4.45 ms | 10.25 ms | 0.62 ms | 1.62 ms | 2.57 ms |
| 2000 | 3.61 ms | 6.32 ms | 6.76 ms | 2.34 ms | 4.01 ms | 6.13 ms |

Max values are single-tick outliers and vary between runs (GC, JIT warm-up).

The tick budget at 10 ticks/s is 100 ms. Even at 2000 entities the sim uses
under 5 % of it, so the sim is not a bottleneck at this scale.

### Browser benchmark (`npm run bench`)

**Pending.** The implementation environment (Ubuntu 20.04 under WSL2, sandboxed)
cannot install Playwright's Chromium: Playwright 1.63 reports
`Playwright does not support chromium on ubuntu20.04-x64`, and there is no
Linux Chrome installed. `docs/spikes/s0-bench.json` has **not** been generated
yet. Run `npm run bench` on a supported host, or use
`BENCH_CHROMIUM=/path/to/chrome npm run bench`. Then fill in this table from
the JSON and note whether the `gpu` field shows a hardware GPU or SwiftShader
(software rendering):

| n | fps avg | fps p5 | fps min | frame p95 | tick avg | tick p95 | renderer | GPU / software |
|---|---|---|---|---|---|---|---|---|
| 500 | — | — | — | — | — | — | — | — |
| 2000 | — | — | — | — | — | — | — | — |

### Manual measurements (to be filled in by a human)

Use `?bench=20` (and `?bench=20&n=2000`) on each device and copy the numbers
from the console `BENCH_RESULT` line, or read the HUD during free play.

| Device | Browser | n | fps avg | fps p5 | frame p95 (ms) | tick p95 (ms) | Notes |
|---|---|---|---|---|---|---|---|
| Mid-range laptop | | 500 | | | | | |
| Mid-range laptop | | 2000 | | | | | |
| Phone | | 500 | | | | | |
| Phone | | 2000 | | | | | |

## Observed / expected bottlenecks

- **Chunk ground caches use a lot of GPU memory.** Each chunk is about
  2048×1024 px, so 16 cached chunks take about 128 MB of RGBA textures even at
  resolution 1. That is fine on desktop but a real risk on phones. It also
  makes the ground blurry when zoomed in above 1×. At M6 scale (many more
  chunks) we would need smaller render chunks, texture eviction for distant
  chunks, or tile sprites from an atlas (one batched draw per chunk, no
  cache).
- **Depth sort is a full sort every frame.** Blocks (~2500) and entities
  share one sorted container, so Pixi re-sorts every child whenever any
  `zIndex` changes, which is every frame while anything moves. That includes
  hidden children. This is O(k log k) with k ≈ 4500 at n=2000. Per-chunk or
  per-row buckets (VISION §6 already suggests "per-chunk depth sorting")
  would bound it to what is visible.
- **The zoomed-out overview is the worst case.** Everything is visible, so no
  culling helps. The benchmark measures this phase on its own.
- **Path request bursts.** A burst of full-map A\* searches caps the tick at
  about 8 ms with the 32-request budget. A time-based budget (for example
  2 ms per tick) would be more robust than a count-based one.
- The sim runs on the main thread. At the measured tick times a Web Worker
  is not needed yet, but it is the natural next step if perception and
  behaviours (M4) raise the cost by 10× or more.

## Preliminary verdict

**TS + Pixi: go, provisionally.** The parts that could be measured here are
comfortably fast. The headless sim with typed-array A\* runs 2000 wandering
entities in about 2.4 ms per tick (under 5 % of the 100 ms tick budget). The
whole spike (sim + iso projection + input) is plain TypeScript with fast,
headless unit tests, which fits the agent-driven workflow that motivated the
choice. Pixi v8's API (`cacheAsTexture`, `sortableChildren`, generated
textures) covers the rendering needs without extra dependencies.

Remaining risks, in order:

1. **Unmeasured rendering fps.** The browser numbers (desktop, laptop, phone)
   are still pending. The verdict must be confirmed once `s0-bench.json` and
   the manual table are filled in. If the phone overview case is well below
   30 fps, revisit the depth-sort and ground-cache strategy before M1. That
   is not a reason to change stack.
2. **Mobile GPU memory** from the cached chunk textures (see above).
3. **Depth sorting at scale.** Multiple floors and walls with cutaway (M6)
   make sorting harder than the single-layer case tested here.
