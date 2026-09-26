---
id: m0-sim-core
area: core
priority: 20
depends_on: [s0-iso-spike]
description: M0 simulation core — tile grid, entities, fixed-tick loop, measurements, compiled expressions, namespaced YAML pack loader and a top-down ASCII terminal renderer
---

# M0 — Simulation core

## Goal

Build the first real engine code: a headless, deterministic simulation core
(grid, entities, fixed ticks, measurements, compiled expressions) fed by a
validated YAML pack loader with namespaced IDs, plus a top-down ASCII
terminal renderer. The milestone is playable when you can walk a character
around a map in the terminal and watch measurements change over time — in
**two packs of different genres** (VISION.md §3.5), neither of which
requires engine code changes.

## Acceptance Criteria

### Layout and boundaries

1. Engine code lives under `src/core/` (sim, expressions, loader) and
   `src/ascii/` (renderer + terminal shell). Nothing in `src/core/` imports
   `pixi.js`, Node built-ins (`fs`, `path`, `process`…) or DOM globals, so
   it can later run in a browser or Web Worker. File access is isolated in a
   Node adapter (e.g. `src/node/read-pack.ts`) that turns a pack directory
   into an in-memory `{ relativePath: fileText }` map for the loader.
2. The S0 spike code (`spike/`) is left untouched; M0 does not import from
   it. The only new runtime dependency is the `yaml` package.

### Packs and loader

3. **Pack format.** A pack is a directory with a `pack.yaml` manifest
   (`namespace`, `name`, `version`, optional `depends: [namespace…]`) and
   any number of other `*.yaml` files at any depth. Each content file holds
   one or more top-level **domain keys** (`measurements`, `tiles`,
   `archetypes`, `maps`, `start`); content from all files of a pack is
   merged per domain. Unknown top-level keys are load errors.
4. **Namespaced IDs.** Namespaces and local IDs match `[a-z][a-z0-9_]*`.
   Definitions may write a short id (`hunger`) — the loader prefixes the
   pack's namespace (`zmb:hunger`) — or a qualified id, which must use the
   pack's own namespace. **References** (in fields and expressions) may be
   qualified (`base:hp`) or short; a short reference resolves to the
   referencing pack's namespace first, else to the unique match among the
   packs it `depends` on; ambiguous or missing → load error.
5. **Multiple packs, no overrides yet.** `loadPacks([...])` accepts an
   ordered list of packs. `depends` must be satisfied by an earlier pack in
   the list. Defining an ID that already exists is a load error (override
   semantics are M7).
6. **Schema (M0 subset).**
   - `measurements`: `id`, `label`, `min` (default 0), `max` (number,
     measurement reference, or expression; default unbounded), `initial`,
     optional `rate` (per-second drift: number or expression evaluated per
     entity each tick, applied as `rate / ticksPerSecond`, then clamped).
   - `tiles`: `id`, `label`, `glyph` (single char), `color`, `walkable`.
   - `archetypes`: `id`, `label`, `glyph`, `color`, `tags` (list),
     `measurements` (list of measurement ids the entity has), optional
     per-measurement `initial` overrides.
   - `maps`: `id`, `legend` (char → `{ tile, spawn? }`), `rows` (list of
     equal-length strings). ASCII maps are an M0/fixture format; Tiled comes
     in M6.
   - `start`: `map`, `player` (archetype id). Exactly one `start` across all
     loaded packs (the last pack may define it).
7. **Validation.** The loader collects **all** errors before failing (not
   just the first), each with pack namespace, file path, YAML key path and
   source line when available. It catches at least: YAML syntax errors,
   missing/mistyped required fields, invalid id syntax, duplicate ids,
   unknown references (with Levenshtein ≤ 2 "did you mean" suggestions),
   expression syntax errors, unknown identifiers/functions inside
   expressions, ragged map rows, legend chars missing from the legend,
   unmet `depends`, and a missing/duplicate `start`. The output of a
   successful load is an immutable, fully resolved **definition** object
   that runtime code trusts without re-checking.

### Expressions

8. Port the rogue-engine expression language (grammar, operators,
   short-circuit booleans, built-ins `min max clamp abs floor ceil random
   roll manhattan chebyshev euclidean`, and `has_tag`) with these changes:
   - **Compiled at load time** to closures; runtime never parses. Member
     paths like `self.hunger` are resolved at compile time to a measurement
     **index**, not a string lookup.
   - Qualified identifiers: `ns:id` with no whitespace is a single token in
     member position (`self.vamp:blood`).
   - `/` is **float** division (measurements are continuous here).
     Division/modulo by zero returns 0 and records a warning.
   - Scope for M0: `self`, `player`, `tile` (`{x, y}` + tile id),
     `world` (`tick`, `seconds`). `random`/`roll` use the world's seeded
     RNG.
   - Expressions are pure: no mutation of world state.
   - A `docs/expressions.md` documents the grammar, scope, built-ins and
     namespacing rules.

### Simulation

9. **World.** A `World` created from a definition + seed holds the grid
   (typed array of tile indices), entities, tick counter and seeded RNG.
   Measurement values are stored per entity in a `Float64Array` indexed by
   the measurement's load-time index (no per-tick object allocation for
   measurements).
10. **Fixed ticks.** `world.step()` advances exactly one tick at
    **10 ticks/s**. Each tick: apply queued player intent (move one tile in
    8 directions if walkable; configurable ticks-per-step in the
    archetype, default 2), then apply `rate` to every entity measurement,
    then clamp to `min`/resolved `max`. State is mutable in place.
11. **Determinism.** Same definition + seed + sequence of intents ⇒
    identical state. `world.snapshot()` returns a plain JSON-serializable
    view and `world.hash()` a stable hash; a test runs two worlds for 1000
    ticks with the same inputs and asserts equal hashes.

### ASCII renderer and terminal shell

12. `renderAscii(world, viewport)` is a **pure** function returning lines
    of text (map glyphs with entities on top, centered on the player,
    clipped to the viewport) plus a HUD block listing the player's
    measurements (`label: value/max`, one decimal) and the in-game clock.
    It has no ANSI codes; color is applied by the terminal shell only.
13. `npm run play -- <pack-dir> [<pack-dir>…] [--seed N]` starts a
    terminal session in real time (10 ticks/s): arrow keys / WASD / numpad
    move, `q` quits. On load errors it prints every error and exits
    non-zero. `npm run check -- <pack-dir>…` validates packs without
    playing.

### Two-genre validation

14. Ship three packs under `packs/`:
    - `base` — shared tiles (floor, wall, door), `hp`, a humanoid
      archetype.
    - `zombie` (namespace `zmb`, depends on `base`) — `hunger` and
      `thirst` rising over time, a small town map, a few idle zombie
      archetypes placed via legend.
    - `vampire` (namespace `vamp`, depends on `base`) — `blood` draining
      over time and a `max` expressed as an expression (e.g. tied to
      `base:hp`), a mansion map.
    Both `base+zombie` and `base+vampire` load cleanly and are playable;
    no genre words appear in `src/`.
15. **Tests** (`npm test`) cover: lexer/parser/compiler (precedence,
    qualified ids, float division, divide-by-zero warning), loader happy
    path per pack combo, one failing fixture per validation rule in AC 7
    (asserting the error message and location), measurement `rate` +
    clamping over N ticks, movement blocked by non-walkable tiles, ASCII
    render snapshot of a small fixture map, and determinism (AC 11).
    Existing verify gates (`typecheck`, `test`, `build`) pass.
16. `docs/packs.md` documents the pack layout, domain keys, fields and
    namespacing rules with examples. `VISION.md` §7 is updated to record the
    pack-format decision taken here (YAML only, free file layout with
    domain keys merged per pack).

## Out of Scope

- `systems`, `statuses`, clock/day-night beyond a tick counter (M2).
- Effects pipeline, actions, flows, items, inventory (M3/M5).
- AI/behaviors — non-player entities stand still (M4).
- Pathfinding / click-to-move and the isometric renderer (M1).
- Pack overrides/patches, mod stacking semantics (M7).
- Browser shell for the ASCII renderer; save/load; chunked worlds.

## Design Notes

- Reference implementation to port from: `~/code/rogue-engine`
  (`src/expressions/`, `docs/expressions.md`, `src/config/loader.js` for
  `SchemaError` style and Levenshtein suggestions, `docs/schema.md`).
  Port the concepts to TypeScript; do not copy the immutable
  `dispatch(state, action)` model (VISION.md §2).
- Suggested modules: `src/core/expr/{lexer,parser,compile}.ts`,
  `src/core/load/{pack,resolve,validate,errors}.ts`,
  `src/core/sim/{world,rng,grid}.ts`, `src/ascii/{render,terminal}.ts`,
  `src/node/read-pack.ts`, `src/cli/{play,check}.ts`.
- Loader pipeline: parse YAML (keep line info via `yaml`'s CST/`LineCounter`)
  → collect raw definitions per pack → qualify ids → build symbol table →
  resolve references → compile expressions against the symbol table →
  freeze. Stages accumulate errors in a shared list.
- Compiling a path like `self.zmb:hunger` should produce roughly
  `(ctx) => ctx.self.m[7]`; unknown paths fail at compile time, not
  runtime.
- Keep `rate` evaluation cheap: a numeric literal rate should skip the
  expression call entirely.
- Run the CLIs through `tsx` (already a dev dependency from S0).

## Agent Notes

- Read `VISION.md` §2–§4 and the rogue-engine docs listed above before
  starting.
- Order: expressions (with tests) → loader + validation → world/tick →
  ASCII render → terminal shell → packs → docs.
- Watch AC 1: it's easy to leak `fs` or `process` into `src/core/` via the
  loader. Add a test (or lint-style check in `npm test`) that scans
  `src/core/**` imports and fails on Node built-ins or `pixi.js`.
- Keep pack content tiny — the goal is proving the engine is
  genre-agnostic, not building content.
