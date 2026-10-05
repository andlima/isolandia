---
id: m6-chunked-world
area: sim
priority: 40
depends_on: [m6-floors]
description: M6 scale — composite maps built from reusable part maps (`parts`, `fill`), seeded `populate` zones, a 16×16 chunk index for entities, an active radius beyond which NPCs go dormant, budgeted A* with region labels for instant unreachable checks, lazily built and evicted render chunks with entity culling, perf HUD and a real-world sim benchmark, and a ~256×256 zombie town with ~1000 entities plus a composite vampire estate
---

# M6d — Chunked world

## Goal

M6's playable result is **an explorable small town**. The target is a
stress case: a **~256×256** zombie town, two floors in places, with
**~1000 entities**, running at the 10 Hz tick in Node and in the
browser.

Today everything assumes a small map:

- every NPC thinks every tick;
- A* floods the whole map when a goal is unreachable;
- the renderer builds every chunk up front;
- maps are single hand-made files.

This spec adds:

1. **Composite maps**: a big map assembled from reusable part maps (a
   house drawn once, placed twenty times), plus **populate zones** that
   scatter many NPCs with a seeded RNG.
2. A **chunk index** and an **active radius**: NPCs far from the player
   go dormant, so their cost is near zero.
3. **Bounded pathfinding**: a node budget, plus region labels that
   reject unreachable goals without searching.
4. **Lazy rendering**: chunks and sprites exist only near the camera.
5. **Measurement**: a benchmark on the real town and a perf line in the
   HUD.

No engine code may be genre-specific.

## Acceptance Criteria

### Composite maps

1. A `maps` entry may be a **composite**:

   | Field     | Type | Notes |
   |-----------|------|-------|
   | `id`      | id   | |
   | `size`    | `[w, h]` | Required, each ≥ 1 |
   | `fill`    | tile id | Tile for floor-0 cells no part covers. Required if any floor-0 cell is uncovered. Upper floors stay empty where uncovered |
   | `parts`   | list of `{ map, at: [x, y] }` | `map` is any non-composite map (ASCII or Tiled), local or qualified. A part may appear many times |
   | `player`  | `[x, y]` or `[x, y, z]` | Required on a start map. Part maps' own player markers are **ignored** |
   | `rooms`   | as ASCII `rooms` (with `floor`) | Extra rooms in composite coordinates, added after the parts' rooms |
   | `populate`| see AC 2 | Optional |

   Composition rules:
   - The composite has as many floors as its tallest part.
   - Each part's cells, facings, spawns and rooms are offset by `at`.
     Spawns stay in part order, then row-major inside each part; the
     overall order is by part, then `z`, then row-major.
   - Errors:
     - a part outside `size`;
     - **two parts overlapping**, on any cell or floor, reported with
       both part indices and the first shared cell;
     - a part that is itself a composite (no nesting);
     - an unknown part map (with *did you mean*);
     - `player` outside the map or on a non-walkable cell;
     - mixing composite fields with ASCII or `tiled` fields.
   - Link (`climb`) validation runs on the composed map.
   - A map used only as a part needs no player marker, as today for
     non-start maps.
2. **`populate`** is allowed on any map. On a part, it is applied per
   placement, offset by `at`. Each entry has:
   - `archetype` (required);
   - `count` (integer ≥ 1);
   - optional `rect: [x, y, w, h]`, which defaults to the whole map;
   - optional `floor` (default 0);
   - optional `room` (a room tag).

   **Candidate cells** are walkable, inside the rect, on the floor, in
   the room if one is given, not a container tile, and not the player
   start. Placement rules:
   - Placement happens in `World` creation, right after the explicit
     spawns, entry by entry in definition order (parts first, then the
     composite's own).
   - Cells are drawn **without replacement** from the candidates, so a
     cell gets at most one populated entity. A cell may still hold an
     explicit spawn.
   - Draws come from a **dedicated RNG** derived from the seed, with its
     own salt, like loot. The world RNG and loot are unaffected.
   - Entity ids follow placement order.
   - `count` greater than the candidate count (per placement) is a
     **load error**. Candidates do not depend on the seed, so this is
     checked at load.
   - Saves store the placed entities, so `restore` never re-populates.

### Simulation scale

3. **Chunk index.**
   - The world keeps entities bucketed by **16×16 chunk per floor**,
     updated whenever an entity changes chunk.
   - `world.entitiesNear(x, y, z, r)` returns the entities within
     Chebyshev distance `r` on `(x, y)`, on any floor when `z` is
     omitted, in **id order**.
   - Hearing uses the index. Its results are **identical** to the
     brute-force pairs: the nearest noise wins, and ties go to emission
     order. A test compares the two on random worlds.
4. **Active radius.**
   - `start` gains `simulation: { active_radius, npc_path_budget,
     player_path_budget }`. All are optional integers.
     `active_radius` is in tiles, default **64**, and may be `none` to
     disable dormancy.
   - At the start of each tick, an NPC whose Chebyshev distance on
     `(x, y)` from the player (any floor) exceeds the radius is
     **dormant** for that tick. A dormant NPC:
     - skips `think`;
     - does not apply intents or advance its path (both are kept as
       they are);
     - does not count down `moveCooldown`.
   - A dormant NPC still drifts, runs systems, updates statuses, hears
     noises and counts for defeat/victory.
   - Dormancy is **derived** from positions. It is not state: not in the
     snapshot, hash or save. It is deterministic.
   - `world.isDormant(e)` and `world.activeCount` are pure queries.
   - On every map smaller than the radius (the garden and every test
     fixture) no entity is ever dormant, and results are unchanged; a
     test asserts this.
5. **Path budget.**
   - A* stops after **`npc_path_budget`** expanded nodes (default
     **4 000**) for NPC searches, and **`player_path_budget`** (default
     **60 000**) for the player's. Hitting the budget returns `null`,
     like an unreachable goal.
   - Behaviors already treat a failed path as their `done` or failure
     case.
   - Expansion counts are deterministic, so the outcome is too.
6. **Region labels.**
   - The grid keeps **connected-region labels** over walkable cells,
     following the same moves as A*: 8-way, no corner cutting, links
     included.
   - A goto whose goal is in a different region from the start (or not
     walkable) fails **without searching**.
   - Labels are computed lazily: on the first query, and again after
     `tileVersion` changes.
   - With `adjacent: true`, the goal's walkable neighbours count, and
     the goto fails only when none share the start's region.
7. **Determinism and saves.**
   - All existing determinism tests pass.
   - `assertRoundTrip` passes on the big town with dormant NPCs present,
     saving and continuing for 300 ticks.
   - A **dormancy round trip** passes: a player walks away from a horde
     and back again.

### Rendering and shells

8. **Lazy render chunks.**
   - The iso scene builds a 16×16 chunk (ground, raised blocks, per
     floor) **the first time it is near the view**. "Near" means
     visible, plus a one-chunk margin.
   - Built chunks are kept in an LRU and evicted beyond
     **`MAX_BUILT_CHUNKS`** (default 160). Evicted chunks are destroyed,
     not just hidden.
   - Map edits rebuild only built chunks. An unbuilt chunk picks up its
     edits when it is first built.
9. **Entity and pile culling.**
   - Sprites exist only for entities and ground piles in built, visible
     chunks. They are created when an entity enters one and destroyed
     when it leaves.
   - Depth sorting and facing still work across the create/destroy.
   - Scene stats report built, visible and total chunks, and live
     sprites.
10. **Perf HUD.** The browser HUD shows a debug line, toggled by **F3**:
    - tick ms (avg/p95 over the last 100 ticks);
    - fps;
    - active and dormant entities;
    - built and visible chunks.

    The terminal shows active/dormant counts on its status line when any
    NPC is dormant.
11. **Benchmark.**
    - `npm run bench:sim -- --packs std,std-needs,zombie [--ticks N]`
      runs the **real** `World` on the shipped town with no rendering. It
      scripts the player on a fixed walk across the map, so the active
      area moves.
    - It reports tick avg/p95/max, active/dormant counts, and A*
      expansions per tick (avg/max). The existing spike benchmark stays
      as is.
    - Results go in a new **`docs/perf.md`**, with a section for browser
      fps to be filled in manually. Chromium is unavailable in the
      sandbox, as in S0.
    - The **target**, recorded but not a test gate, is a steady p95
      ≤ 10 ms per tick in Node on the dev machine.

### Packs (two-genre rule)

12. **zombie: a ~256×256 town.**
    - `start.map` becomes a composite `city` built from **part maps** in
      `packs/zombie/maps/parts/`, all Tiled. At least these:
      - the existing four-house town block, including the upstairs from
        `m6-floors`, as `town_center`;
      - **three house variants**, at least one with two floors;
      - a **store** (room tag `store`, shelf containers with a new loot
        distribution);
      - a **garage** (room tag `garage`);
      - a **park**;
      - horizontal and vertical **road** segments.
    - Houses are placed many times, so the town has dozens of houses.
    - `fill` is `grass`.
    - `populate` brings the total to **~900–1100 entities**, mostly
      shamblers with some crawlers, denser downtown and sparser at the
      edges. Zones keep the area around the player start clear for the
      first seconds of play.
    - The player starts in `town_center`.
    - Existing zombie scenario tests are updated **only** to offset their
      coordinates by `town_center`'s `at`, through a test helper. Their
      logic does not change.
13. **vampire: a composite estate**, at least **96×96**:
    - the mansion (with its attic from `m6-floors`) as one part;
    - at least two other part maps, at least one used more than once
      (for example a graveyard plot and a village cottage);
    - `populate` for bats;
    - **≥ 150 entities** in total.

    Existing vampire scenarios are offset the same way.
14. **Reachability.**
    - Every container and every walkable cell in both start maps is
      reachable from the player start, now checked with region labels.
    - The town keeps each part's doors connected to the roads.
    - Isolated decorative cells (fenced-off areas) are allowed only if
      they hold no container. The test lists exceptions explicitly.

### Tests and docs

15. Headless tests cover:
    - **Composite loader:** offsets, repeated parts, part rooms and
      spawns, extra rooms, `fill` (only floor 0), the floor count, and
      every load error in AC 1–2.
    - **Populate:** deterministic per seed; different seeds give different
      cells and the same count; no reuse of cells; candidate filtering
      (walkable, room, rect, floor, no container tile, not the player
      start); the load error on too large a `count`; the world RNG and
      loot unchanged.
    - **Chunk index:** `entitiesNear`, and hearing equal to brute force.
    - **Dormancy:** the boundary at exactly the radius, that dormant NPCs
      keep paths and intents, that drift and systems still run, `none`,
      and the small-map invariance.
    - **Bounded A*:** the budget cut-off and region-label fast failure,
      with expansion counts exposed to tests; labels refreshed after
      `set_tile`; the `adjacent` case.
    - **Renderer:** chunk LRU build/evict and entity create/destroy, as
      pure bookkeeping functions (no Pixi).
    - **Saves:** round trip on the big town and on a dormancy cycle.
    - **Perf guard** (cheap, structural): on the big town, a 100-tick run
      calls `think` only for active entities, and no A* search exceeds
      its budget.
    - **Guards:** the genre-word guard passes. Heavy tests stay under a
      few seconds each; use fewer ticks on the big maps.
16. **Docs.**
    - `docs/packs.md` documents composite maps (`size`, `fill`, `parts`,
      `player`, `rooms`), `populate`, and `start.simulation`.
    - `docs/iso.md` covers lazy chunks and culling.
    - `docs/perf.md` is new (AC 11).
    - `docs/ui.md` lists F3.
    - `VISION.md`:
      - §5 marks **M6 done**;
      - §6 updates the performance risk with the measured numbers;
      - §7 records the decisions:
        - composite maps from parts, without nesting;
        - seeded `populate`;
        - derived dormancy beyond an active radius;
        - budgeted A* with region labels;
        - lazy, evicted render chunks;
      - §8 points toward M7.

## Out of Scope

- Streaming maps from disk, or a world larger than memory. The whole
  definition and grid stay in memory, and `typed arrays` are enough at
  this size.
- LOD for drift and systems, such as slower ticks for far entities.
  Only movement and thinking go dormant.
- Rotating or mirroring parts, random part selection, and procedural
  town generation.
- Tiled `.world` files and infinite maps.
- Web Workers for the simulation. That is possible later because the
  core is DOM-free, but it is not needed for this target.
- A minimap and fog of war.
- Despawning, respawning, and population over time.

## Design Notes

- Do the work in this order, with a benchmark before and after each
  step, recorded in `docs/perf.md`:
  1. composite maps and populate, with a throwaway big map;
  2. the benchmark;
  3. dormancy;
  4. region labels and budget;
  5. the chunk index;
  6. the renderer.

  If a step does not move the numbers, keep it simple rather than
  clever.
- Dormancy is checked with one pass over entities per tick (Chebyshev
  against the player). That is O(n) with tiny constants, and simpler
  than chunk activation sets. Use the chunk index for queries, not for
  dormancy.
- Region labels: flood-fill with a reusable `Int32Array` queue over
  `walk`, plus link edges. Recomputing 131k cells on a `set_tile` is
  fine, since edits are rare and player-driven.
- The renderer's chunk bookkeeping (which chunks to build or evict, and
  which entities need sprites) should be a pure module fed with view
  bounds and positions, so it is testable without Pixi.
- Hand-editing large Tiled files is error-prone. Write the parts as
  ASCII first if that is easier, then convert them with
  `map:export` (from `m6-tiled-maps`). Ship only the `.tmj`/`.tsj` for
  the zombie parts. Vampire parts may stay ASCII; the two-genre rule
  needs only the composite mechanics in both packs.

## Agent Notes

- Read these first:
  - `src/core/sim/world.ts` (`step`, `think`, `hear`, `spawn`);
  - `astar.ts` and `behavior.ts`;
  - `src/iso/scene.ts`;
  - `scripts/sim-bench.ts`;
  - `docs/spikes/s0-results.md`, for the benchmark style;
  - the `m6-floors` and `m6-tiled-maps` implementations.
- Keep test runtime in check: the whole suite should not grow by more
  than ~30 s. Build the big world once per test file where possible.
- Chromium is unavailable in the sandbox. Browser fps stays a manual
  follow-up, as in S0.
