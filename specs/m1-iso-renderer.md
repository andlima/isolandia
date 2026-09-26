---
id: m1-iso-renderer
area: render
priority: 30
depends_on: [m0-sim-core]
description: M1 isometric renderer — PixiJS browser shell over the M0 sim, 2:1 dimetric tiles with depth sorting, camera, click-to-move with A*, and a pack assets manifest (SVG/PNG sprites with generated placeholders)
---

# M1 — Isometric renderer

## Goal

Play the same M0 games (`base+zombie`, `base+vampire`) in the browser in
isometric view. That means a PixiJS renderer that reads the headless `World`,
plus click-to-move pathfinding in the sim and a pack-level **assets
manifest**, so that the art is data too. The milestone is playable when both
genres can be explored in iso by mouse/touch and keyboard, with measurements
ticking in a HUD, and neither genre needs engine code (VISION.md §3.5).

## Acceptance Criteria

### Layout and boundaries

1. New code is split as follows:
   - `src/core/`: sim additions (pathfinding, goto intent, render-facing
     movement state) and loader additions (assets). It stays platform-free.
     The existing boundary test must keep passing unchanged.
   - `src/iso/`: the Pixi renderer (projection, scene, depth sorting,
     camera, textures). It imports `pixi.js` and `src/core`. It does not
     import DOM-only shell code or Node built-ins.
   - `src/web/`: the browser shell (pack loading via Vite, input, HUD
     overlay, error screen, `main.ts`).

   Extend the boundary test so that nothing outside `src/iso/`, `src/web/`
   and `spike/` imports `pixi.js`. It must also check that `src/iso/` and
   `src/web/` do not import from `spike/`.
2. `spike/` stays untouched. `index.html` now boots the game (`src/web/main.ts`).
   The spike moves to `spike.html`, which Vite builds as a second page, so
   `npm run dev` and `npm run build` serve both. Update `scripts/bench.mjs`
   so that it targets `spike.html` and `npm run bench` still works.
   `test/iso.test.ts` may keep testing the spike, and the new projection
   code gets its own tests.

### Pack schema additions

3. **`assets` domain** (a list of entries), with these fields:
   - `id`
   - `file`: a path relative to the pack root. It must exist in the pack
     and end in `.svg` or `.png`.
   - optional `anchor: [ax, ay]`: normalized image coordinates in `[0, 1]`,
     default `[0.5, 1]`.

   Assets are single images; spritesheets and animation are out of scope.
   Asset ids are namespaced and resolved like every other id.
4. **Sprite references.** `tiles` and `archetypes` accept an optional
   `sprite` field that holds an asset id reference, resolved with the usual
   namespacing rules. The anchor point is placed as follows:
   - for a **tile** sprite, at the bottom vertex of the tile's diamond;
   - for an **archetype** sprite, at the tile's ground centre.
5. **`raised`** (an optional tile boolean, default `!walkable`) tells the
   renderer whether a tile is flat ground or a raised block. The block must
   be depth-sorted with entities. This affects rendering only. Walkability
   is unchanged.
6. **Loader and validation.**
   - `PackSource` gains the list of non-YAML file paths in the pack (names
     only, no contents).
   - `readPack` (Node) fills that list, so `npm run check` validates assets
     too.
   - New load errors, reported with location like every other error:
     - an asset file is missing (with a "did you mean" suggestion);
     - an asset has an unsupported extension;
     - `anchor` is out of range or malformed;
     - a `sprite` reference is unknown.
   - `Definition` gains `assets` (`id`, `index`, `pack` namespace, `file`,
     `anchor`) and the matching `ids.assets` lookup. `TileDef` and
     `ArchetypeDef` gain `sprite: number | null` and (tiles only)
     `raised`.
   - The ASCII renderer ignores sprites.

### Simulation additions

7. **No corner cutting.** A diagonal step requires the target and both
   orthogonal neighbours to be walkable. This applies to keyboard intents
   and pathfinding alike. Update M0 tests and fixtures where needed.
8. **Pathfinding.** An 8-directional A* lives in `src/core/sim/`:
   - octile heuristic;
   - typed arrays, with buffers reused between searches;
   - deterministic tie-breaking;
   - returns `null` for blocked or unreachable goals.

   It can be ported from `spike/sim/astar.ts` (a copy, not an import).
9. **Goto intent.**
   - The player can queue `goto(x, y)`. At the start of the next tick the
     sim computes a path and the player then follows it, one step per
     `ticksPerStep`.
   - A directional (keyboard) intent cancels an active path.
   - If the goal is unreachable or blocked, the intent is dropped and the
     world records it so the shell can show feedback (e.g. a
     `lastGoto: { x, y, ok }` field or an event list drained by the shell).
   - Paths and goto intents are part of deterministic state. Add a
     determinism test that mixes goto and keyboard intents.
10. **Render-facing movement state.** Each entity exposes where its current
    step started (`fromX`, `fromY`) and the tick it started on. A pure
    function in `src/core` (or `src/iso`) computes an entity's continuous
    render position from that state, the world tick and the frame's
    interpolation alpha. An entity walking a path or holding a key must
    move at constant visual speed, with no pause between tiles.

### Renderer

11. **Projection.** Use 2:1 dimetric with a **64×32 px** tile diamond.
    Put pure, tested functions for world↔iso↔screen conversion, picking
    (screen → tile), and depth keys in `src/iso/`. Record the projection
    and tile size decision in `VISION.md` §7.
12. **Scene.**
    - Draw flat tiles in a ground layer, grouped into render chunks
      (16×16 tiles), and cull chunks outside the viewport.
    - Draw raised tiles and entities in a depth-sorted object layer.
    - The object layer must **not** re-sort every object every frame. Use
      per-row or per-chunk buckets (or an equivalent) so that only buckets
      whose contents changed are re-sorted. This addresses the S0 finding
      in `docs/spikes/s0-results.md`.
    - Avoid the spike's huge per-chunk `cacheAsTexture` ground. Use tile
      sprites from generated or loaded textures, batched by Pixi.
13. **Placeholders.** When a tile or archetype has no `sprite`, generate
    one from its `color`:
    - a flat diamond for flat tiles;
    - a shaded block (top plus two side faces) for raised tiles;
    - an upright marker for entities, with the archetype glyph drawn on it.

    Generated textures are cached per definition entry, so each one is
    built only once.
14. **Assets.** The shell maps `(pack namespace, file)` to a URL, loads
    every referenced asset before the first frame, and applies the asset's
    anchor as defined in AC 4. If an asset fails to load at runtime, log a
    warning and use the placeholder instead. Do not crash.
15. **Camera and input.**
    - The camera follows the player by default.
    - Drag (mouse or one finger) pans and disables follow.
    - The wheel or a pinch zooms around the cursor or pinch centre, from
      0.25× to 3×.
    - `Space` re-centres and re-enables follow.
    - Click or tap on a tile issues `goto`. The target tile is outlined
      while a path is active, and an unreachable click flashes it red.
    - Arrow keys, WASD and numpad move the player in 8 directions while
      held, the same bindings as the terminal. They cancel any path.
    - A drag must not also count as a click.
16. **HUD.**
    - A DOM overlay shows the player's measurements (`label: value/max`)
      and the in-game clock.
    - The overlay and the ASCII HUD block are built from one shared pure
      `hudModel(world)`, so both renderers show the same data. The ASCII
      render output (and its snapshot test) must stay byte-identical.
    - `H` toggles the HUD.
17. **Loop.** The shell runs 10 ticks/s from an accumulator, with at most
    5 ticks per frame and any backlog beyond that dropped (the same rule as
    the spike), and renders every animation frame with interpolation.

### Browser shell

18. **Pack loading in the browser.**
    - `src/web/` builds `PackSource`s from Vite
      `import.meta.glob('/packs/**/*')`: YAML as raw text, other files as
      URLs.
    - Keep the glob call thin. A pure function turns the glob result into
      `PackSource`s plus a URL map, and it is unit-tested in Node.
    - Query params:
      - `?packs=base,zombie`: an ordered list of pack directory names.
        This is the default.
      - `?seed=N`.
19. **Load errors.** When loading fails, the page shows the complete error
    list, formatted the same way as the CLI, instead of the game. An
    unknown pack name in `?packs=` is also reported there.

### Two-genre validation

20. Load both `?packs=base,zombie` and `?packs=base,vampire` in the
    browser and make them playable in iso:
    - Each genre pack ships **at least two hand-written SVG assets**, used
      by at least one tile and one archetype.
    - Each genre pack keeps at least one entry on generated placeholders,
      so both paths are exercised.
    - `npm run check` passes for both combos.
    - No genre words appear in `src/`.

### Tests and docs

21. Extend `npm test` to cover:
    - projection round-trips and picking at diamond edges;
    - depth-key ordering, including a raised tile against an entity in
      front of and behind it;
    - A*: straight line, detour, no corner cutting, unreachable goal,
      deterministic tie-breaks;
    - goto following, cancellation by a key, and the unreachable-goto
      record;
    - interpolation continuity across consecutive steps;
    - loader happy path with assets, plus one failing fixture per new rule
      in AC 6;
    - the web pack-source builder;
    - boundary checks (AC 1).

    Existing verify gates (`typecheck`, `test`, `build`) must pass.
22. Add `npm run smoke`, a Playwright script that:
    - opens both genre combos;
    - fails on console errors;
    - asserts the canvas is not blank;
    - saves screenshots under `docs/screens/`.

    It honours `BENCH_CHROMIUM` like the bench. It is **not** a verify gate
    because Chromium cannot be installed in the implementation
    environment. It must still work on a supported host.
23. Documentation:
    - `docs/packs.md` documents `assets`, `sprite`, `raised` and the anchor
      conventions, with an example.
    - A new `docs/iso.md` covers how to run the game, the controls, the
      query params, the projection constants, and how placeholders are
      derived.

## Out of Scope

- Multiple floors, wall cutaway or transparency, roofs (M6).
- Spritesheets, animation frames, directional sprites, texture atlas
  packing.
- Lighting, day/night tint (M2), fog of war and vision (M4).
- NPC movement or AI; entity–entity collision (M4).
- Tiled maps, chunked sim worlds, save/load (M6).
- Running the sim in a Web Worker; mobile performance tuning beyond
  culling and batching.
- Context menus and actions (M5); pack overrides (M7).
- Filling in the pending S0 browser benchmark numbers.

## Design Notes

- Read `docs/spikes/s0-results.md` ("Observed / expected bottlenecks")
  first. M1 should apply those lessons, not repeat the spike's scene
  design.
- `spike/render/iso.ts` and `spike/render/input.ts` hold working
  projection, zoom-at-cursor and drag/tap disambiguation code. Port what
  is useful into `src/iso/` and `src/web/`.
- Depth key for a tile-anchored object at `(x, y)`: sort by `x + y`, then
  by `x`. A raised tile and an entity on the same diagonal need a
  consistent tie-break (entity after the ground-level block behind it).
  Moving entities use their interpolated position for sorting.
- Per-row buckets are a simple option: one container per `x + y`
  diagonal, and entities move between buckets when their rounded diagonal
  changes. Only that bucket's `sortableChildren` re-sorts. Another option
  is per-render-chunk containers ordered once. Either is fine if the AC 12
  property holds.
- Interpolated position example: `progress = clamp((tick - stepStartTick +
  alpha) / ticksPerStep, 0, 1)`, then lerp from `from` to the current
  tile.
- Goto intents fit the existing `queueIntent` model as a tagged union
  (`{ kind: 'step', dx, dy } | { kind: 'goto', x, y }`). Keep "latest
  intent wins".
- Asset URLs: Vite's `import.meta.glob('/packs/**/*.{svg,png}', { query:
  '?url', import: 'default', eager: true })` gives hashed URLs in builds.
  YAML can use `{ query: '?raw', import: 'default', eager: true }`.
- Hand-written SVGs should be tiny (a few shapes) and sized to the 64×32
  grid (e.g. 64×32 floors, 64×64 blocks, ~32×48 characters).
  Placeholder-level art is the goal (VISION §6).

## Agent Notes

- Suggested order:
  1. corner rule and A* with goto in core, with tests;
  2. loader assets, with tests;
  3. pure projection, depth and interpolation functions, with tests;
  4. Pixi scene;
  5. web shell and input;
  6. SVGs and pack updates;
  7. smoke script;
  8. docs.
- Do not break the terminal game: `npm run play -- packs/base
  packs/zombie` must still work, including with the new corner rule.
- Chromium is unavailable in the implementation sandbox, so rely on the
  pure-function tests for correctness. Keep Pixi-dependent code thin.
- `tsconfig.json` already includes `vite/client` types, so
  `import.meta.glob` typechecks without casts.
