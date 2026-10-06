# isolandia — Vision and early decisions

> Memory document to support writing the first specs.
> It is not a spec: it records the *why*, the decisions already made and the
> open questions. Update it when a decision changes.

## 1. Goal

A **data-driven** engine for open-world RPGs in **isometric perspective**,
in the vein of *Project Zomboid*: systemic simulation (needs, time, loot,
AI, crafting) in a persistent world built on a tile grid.

The differentiator we are after: building worlds of **completely different
genres** (zombie, vampire, wild west, noir…) **from scratch**, essentially
with **assets + declarative configuration files**, with little need for
scripts. Switching genre should mean switching *pack*, not code.

Realistic target: **80–90% declarative**, with an escape hatch (sandboxed
script hooks) for the rest. Matching Zomboid's scope is not a goal.

## 2. Origin: lessons from `rogue-engine`

Sibling project at `~/code/rogue-engine` — a turn-based ASCII roguelike,
fully defined in YAML. It serves as a proof of concept for the declarative
model.

**Reuse (concepts, and possibly ported code):**

| Concept | Where it lives in rogue-engine | Use here |
|---|---|---|
| Generic measurements (`hp` is just another one) | `docs/schema.md`, `src/runtime/state.js` | Hunger, blood, reputation, suspicion… everything is a measurement |
| Expression language | `src/expressions/`, `docs/expressions.md` | Conditions and formulas across the schema |
| Effects pipeline | `src/runtime/effects.js` | Basis of the effects vocabulary (to be expanded) |
| Interaction flows | `src/runtime/flow.js`, `docs/interaction-flows.md` | Context menu (right click) and targeting |
| Tags + load-time validation | `src/config/loader.js` | Even more critical with stacked mods |
| ASCII renderer | `src/renderer/ascii.js` | Debugging/testing the simulation before isometric |
| Spec-driven agent workflow | `AGENTS.md`, `.spec.toml`, `specs/` | Same workflow in this repo |

**Do not reuse:**

- **Immutable per-turn** `dispatch(state, action)` — does not scale to
  continuous ticks with hundreds/thousands of entities.
- **Maps as ASCII strings** — fine for test fixtures, not for the world.

**Lesson learned:** YAML tends to turn into a bad programming language.
E.g. the shrine in `games/pirate.yaml` repeats `when: 'actor.doubloons >= 5'`
across five effects. Defense: **rich primitives** (systems, behaviors,
recipes, loot tables, dialogues, statuses) instead of ever more powerful
generic control flow; and accept script hooks when YAML gets worse than
code.

## 3. Decisions made

1. **Stack: TypeScript.** Simulation in plain TS; renderer with **PixiJS**
   (WebGL); game servable from an HTML page. Desktop later via **Tauri**
   (or Electron) wrapping the same build, if needed.
   - Main reason: the spec-driven agent workflow works best with
     everything in text, headless tests in Node (`node:test`) and visual
     verification via Playwright.
   - Godot was considered (it also exports to web, has a great editor and
     better performance), but in a data-driven engine the editor would be
     largely bypassed. If we ever migrate, **specs, schema and packs
     survive**; only the code is rewritten.
2. **Decoupled simulation:** the core does not depend on the DOM or Pixi.
   It runs in Node (tests), in a Web Worker (browser) or in a desktop
   shell. The renderer is just a consumer of the state.
3. **Fixed-tick time** (on the order of 10 ticks/s) over a **tile grid**;
   movement interpolated only at render time. Mutable state in the
   simulation (no immutable copy per tick).
4. **Namespaced IDs from day one** (`std_needs:hunger`, `vamp:blood`), even
   before a mod system exists.
5. **Two-genre rule:** every milestone is validated with **two mini-games
   of different genres** (e.g. zombie + vampire), to keep genre
   assumptions from leaking into the engine.
6. **World maps edited in Tiled** (JSON) once the world grows; ASCII stays
   valid for fixtures. **Done (spec `m6-tiled-maps`, M6):** maps take
   `tiled: <file>.tmj`; the zombie town and vampire mansion are Tiled maps.
7. **Minimal dependencies**, in the spirit of rogue-engine (YAML parser,
   PixiJS; anything else justified case by case).
8. **Three tiers, GURPS-style** (a generic core + setting supplements, not
   a system with the genre built in like D&D):
   - **Engine (code, genre-free):** vocabulary only — entities,
     components, measurements, statuses, tags, actions with duration,
     systems, behaviors, containers, grid/space, time, expressions. No
     "hunger", "hp", "combat", not even a special "player": the player is
     an entity controlled by input; life and death are measurements and
     rules declared by a pack.
   - **Stdpack (data, optional, "batteries included"):** pieces that
     several genres reuse — needs (hunger/thirst/sleep), health and
     damage, weighted inventory, day/night, melee combat… Each game picks
     what it uses (a noir game can skip combat) and can tune or replace
     any piece.
   - **Genre packs:** zombie, vampire, wild west… they only compose and
     tune the engine and the stdpack; this is where zombies, coffins and
     shuriken live.

   Working rules:
   - When two genre packs repeat the same YAML pattern, it moves up into
     the stdpack (or becomes a new engine primitive) — it never becomes
     generic control flow in YAML (see §2).
   - Engine code contains no genre terms; a test that searches `src/` for
     words like `zombie`, `vampire`, `hunger`, `hp` catches leaks.
   - Whatever the stdpack does, a third-party pack must be able to do the
     same way: the stdpack uses no shortcuts the engine does not expose
     to everyone.
   - When possible, validate with a very different third genre (noir with
     no combat, a space station with oxygen instead of food) to expose
     assumptions that zombie and vampire share.

## 4. Target schema primitives (sketch, not final)

- **measurements** — numeric values with min/max/initial (inherited).
- **statuses** — states derived from thresholds (`hunger > 70 → Hungry`),
  with ongoing effects (the equivalent of *moodles*).
- **systems** — rules that run on their own over time:
  ```yaml
  systems:
    - id: vamp:sunburn
      every: 10s
      for: "has_tag(self, 'vampire')"
      when: "world.is_day and tile.exposed_to_sky"
      effects:
        - { type: apply, measurement: hp, delta: -2 }
  ```
- **actions** — with `requires`, `flow`, **`duration`** and interruption
  (almost everything in Zomboid takes time and has a progress bar).
- **behaviors** — declarative AI: senses (sight, hearing) + state machine
  or utility AI:
  ```yaml
  behaviors:
    zmb:shambler:
      senses: { sight: 8, hearing: 15 }
      states:
        wander:      { do: random_walk, on: { sees: player -> chase, hears: noise -> investigate } }
        investigate: { do: goto_last_noise, timeout: 30s -> wander }
        chase:       { do: pursue, on: { adjacent: target -> attack, lost: target -> investigate } }
  ```
- **items / containers** — weight, capacity, categories.
- **loot tables** — distribution by **room tag** (`kitchen`, `saloon`…).
- **recipes** — declarative crafting.
- **factions, dialogues, quest flags, journal** — social layer (noir,
  wild west).
- **assets manifest** — sprites/spritesheets referenced by ID.
- **packs** — base + packs that override/extend, validated together.

## 5. Incremental roadmap

Every milestone ends **playable** and passes the two-genre rule.

| # | Milestone | Playable result | Status |
|---|---|---|---|
| S0 | **Feasibility spike** (before anything else): 4×4 chunks of 32×32 isometric tiles, ~500 entities wandering with A*, player moves by click; measure fps on a mid-range laptop and a phone | Confirms (or not) TS + Pixi | ✅ done¹ |
| M0 | Simulation core: grid, entities, tick loop, measurements, compiled expressions, namespaced YAML loader; **top-down ASCII** render | Walk around and watch measurements change over time | ✅ done |
| M1 | Isometric renderer: tiles, depth sort, camera, click-to-move (A*), assets manifest, directional sprites² | The same game, in iso | ✅ done |
| M2 | Clock, day/night, `systems`, `statuses` | Survive a day with hunger/thirst/sleep | ✅ done |
| M3 | Items, weight, containers, loot tables by room tag | Loot a house | ✅ done |
| M4 | Perception (sight/noise) + `behaviors` | A horde that hears the window breaking | ✅ done |
| M5 | Actions with duration, context menu, recipes | Bandaging, cooking, barricading | ✅ done |
| M6 | Chunked world, multiple floors, Tiled maps, save/load | An explorable small town | ✅ done |
| M7 | Packs/mods: stacking, overrides, joint validation | Zombie and vampire as mods of the same base |  |
| M8 | Social layer: factions, dialogues, quests, journal | A short noir mystery / a wild-west duel |  |
| M9 | Sandboxed script hooks | A mod that is "impossible" in pure YAML |  |

¹ S0: the headless simulation benchmark is measured; the **browser fps**
numbers (mid-range laptop and phone) are still **pending** — the manual
table and `s0-bench.json` still need to be filled in (see
`docs/spikes/s0-results.md`, "Browser benchmark"). The spike's verdict is
only confirmed after that.

² Added after M1 (spec `iso-directional-sprites`): 4/8-way assets with
mirroring, character facing (simulation state since spec `turn-before-move`), legend `facing` for tiles; see
§7.

## 6. Risks

- **Isometric art is expensive**, and it is what makes one genre *look*
  like another. Start with placeholders (colored blocks, Kenney packs)
  until ~M4.
- **Performance:** compile expressions to closures at load; per-chunk
  depth sorting; NPCs beyond an active radius go dormant (M6). Measured on
  the 256×256 zombie city with 961 entities (`docs/perf.md`): **0.22 ms avg,
  0.38 ms p95 per tick** in Node (0.35 / 0.59 ms without dormancy), far
  under the 10 ms target. Browser fps on the city is still a manual
  follow-up (as in S0). LOD for drift and systems is not needed yet.
- **Scope:** Zomboid has more than a decade of development. The target is
  a small core in which switching genre = switching pack.
- **YAML creep** (see §2): prefer new primitives or script hooks over ever
  more complex generic conditionals.
- **Mods in the browser:** installing third-party mods requires a zip
  upload or the File System Access API; with Tauri it becomes a normal
  folder.

## 7. Open questions

- ~~Pack format: pure YAML, or YAML + generated JSON? One file per domain
  (`items.yaml`, `systems.yaml`…) or free-form?~~ **Decided in M0:**
  **pure YAML** (no generated JSON). A pack is a directory with `pack.yaml`
  (`namespace`, `name`, `version`, `depends`) and a **free-form layout** of
  `*.yaml` files at any depth; each file carries one or more **domain
  keys** (`measurements`, `tiles`, `archetypes`, `maps`, `start`…) and the
  content is **merged per domain** within the pack. Unknown keys are a
  load error. See `docs/packs.md`.
- ~~State machine vs utility AI for `behaviors` — or both?~~ **Decided
  (task `npc-behaviors`, M4 core):** **state machines, for now.** A
  pack-defined **`behaviors`** domain declares **declarative state
  machines**: each state runs one **built-in activity** (`idle`, `wander`,
  `pursue`, `flee`, `home`) and **transitions** are ordinary expressions
  (`on` in order, then `timeout`, then `home`'s `done`; at most one per
  tick). Archetypes opt in with `behavior: <id>`; the player is never
  driven. Behaviors tick in a new **think** phase (phase 0, before
  intents) that **only issues movement intents**, so walls, cooldowns and
  A* behave exactly as for input. Only `wander` draws RNG, in id order, so
  runs stay deterministic. **Utility AI is deferred**; it could come later
  as another activity or state selector. No nested states or enter/exit
  effects yet. See `docs/packs.md`.
- ~~Override semantics between packs: full replacement by ID, deep merge,
  or explicit patch operations?~~ **Decided (spec `m7-overrides`, M7):**
  **patch by qualified id.** A pack restates a **direct dependency's** id
  with `override: true` and only the fields it changes (a **shallow**
  merge: each listed top-level field replaces the old one whole, lists and
  mappings included; `field: null` clears it), or deletes the entry with
  `remove: true`. `start`, `clock` and `lighting` take `override: true`
  too. Each field keeps the **scope and files of the pack that wrote it**;
  entries keep their position and indices stay dense; references to a
  removed id are load errors naming the remover. Unrelated packs writing
  the same field **warn, later wins**. No list operators or deep merge;
  `distributions` cannot be patched. `check --overrides` lists every
  patch. See `docs/packs.md` (Mods and overrides).
- Script hook language: sandboxed JS (Worker/`ShadowRealm`) or Lua
  (wasmoon/fengari)?
- Combat: real time over ticks, or something more tactical?
- ~~Projection: classic 2:1 dimetric? Tile size?~~ **Decided in M1:**
  **classic 2:1 dimetric** with a **64×32 px** tile diamond
  (`iso.x = (x − y)·32`, `iso.y = (x + y)·16`); 32 px raised blocks; tile
  sprites anchored at the bottom vertex of the diamond, archetype sprites
  at the center of the tile floor. See `docs/iso.md`. Cutaway walls remain
  open (M6).
- How much of the ASCII renderer survives as a permanent debugging tool?
- ~~Stdpack (decision 8): the current `base` pack (`hp`, `humanoid`) already
  plays this role. Rename it to namespace `std`? One pack or several
  optional ones (`std-needs`, `std-melee`…)? The needs currently in
  `packs/zombie/needs.yaml` and generic statuses like `burdened`
  (`packs/zombie/survival.yaml`) are candidates to move up into it.~~
  **Decided (task `stdpack-split`):** the stdpack is **several optional
  packs**. `base` became **`packs/std/`** (namespace `std`: `hp`,
  `humanoid`, `floor`/`wall`/`door`), and **`packs/std-needs/`** (namespace
  `std_needs`, depends on `std`) holds the `hunger`/`thirst`/`fatigue`
  measurements and the `hungry`/`thirsty`/`exhausted`/`burdened` statuses.
  Entities opt in to the needs by listing the measurements and carrying
  the **`living`** tag. What is zombie-specific stayed in the zombie pack
  (the `stocked` status and the `sleep`/`bleed`/`collapse` systems); zombie
  depends on `[std, std_needs]`, vampire only on `[std]`. More packs (e.g.
  `std-melee`) get added as genres repeat patterns. The engine guard test
  rejects stdpack terms in `src/` as well as genre words. See
  `docs/packs.md`.
- ~~Time scale / game calendar?~~ **Decided (task `world-clock`, M2
  groundwork):** the scale comes from a pack-defined **`clock`** domain
  (`day_length`, `start`, `dawn`, `dusk`); the default is **1 game day =
  24 real minutes** (1 simulation second = 1 game minute). Game time is
  **derived from the tick** — it adds no state, so determinism, snapshots
  and hashes do not change. Expressions read `world.day`, `world.hour`,
  `world.minute`, `world.time_of_day` and `world.is_day`; `rate` stays per
  simulation second. **One pack** defines `clock`; since M7 later packs
  may patch it with `override: true`. See `docs/packs.md`.
- ~~How do `systems` schedule work, how do `statuses` enter and exit, how
  is day/night configured, and how does the game end?~~ **Decided in M2:**
  - **`systems`** use **simulation seconds** (`every: 1`, default one
    tick); `every` must be a whole number of ticks and becomes a period in
    ticks at load. They run once per entity (`for` filters, then `when`),
    with `apply`/`set` effects on `self`. Game-time units (`every: 30m`)
    come later.
  - **`statuses`** enter with `when` and exit with `until` (default
    `not when`), which gives **hysteresis**; while active they add their
    `rates` to the drift. They are simulation state (snapshot/hash) and
    expressions test them with `has_status(entity, "id")`, resolved to an
    index at load.
  - The tick order is fixed: intent → drift (with the `rates` of the
    statuses active at the start of the tick) → systems → clamp →
    statuses → defeat → `tick++`.
  - The day/night tint is **its own domain, `lighting`** (`at`/`color`
    keyframes interpolated in RGB), purely visual; at most one pack
    defines it, like `clock`.
  - Defeat is **`start.defeat`** (`when` evaluated with `self` = player,
    optional `message`); when it fires, the world freezes and ignores
    input.
  - Tiles get their own **`tags`** (`tile.has_tag("x")`), separate from
    archetype tags.
- ~~Items as entities or as data in containers? How do tile/room tags feed
  loot tables?~~ **Decided in M3:**
  - **Items are data inside containers**, not entities: a stack is
    `{ item, count }` (at most one per item). There are three kinds of
    container: built into the tile (`tiles[].container`), an entity's
    **inventory** (`archetypes[].inventory`) and a **ground pile**
    (created when items are dropped, removed when it empties). Container
    ids are sequential and never reused.
  - **Weights in integer hundredths**: weights and capacities are rounded
    to 0.01 at load and summed/compared as integers, with no float drift
    (`0.1 × 3` fits in `0.3`). Expressions and UI show normal units.
  - **Rooms are rectangles** (`maps[].rooms: [{ rect, tags }]`); a cell's
    tags are the union of the rectangles that contain it. Room, tile and
    entity tags are three separate sets (`tile.in_room("x")`).
  - **The most specific distribution wins**: each tile container uses the
    first `distributions` entry whose `room` is in the cell's tags;
    otherwise the first one without `room`; ties → definition order.
  - **Loot has its own RNG**, derived from the world seed, rolled once in
    the `World` constructor; the world RNG is untouched, so movement and
    `random()` do not change. Nested tables, `nothing` and cycles (a load
    error) are supported.
  - **Actions are instant until M5**: `take`/`put`/`drop`/`use` go into
    their own queue (`queueAction`, separate from movement intents),
    applied in the intent phase right after movement, with a reach of 1
    tile (Chebyshev) and the result in `world.lastAction`. Duration,
    progress bar and interruption come in M5.
- ~~How do actions take time?~~ **Decided (spec `m5-timed-actions`, M5
  core):**
  - **Actions are pack-defined** in an **`actions`** domain, with a
    **`self`** target or a **tile** target picked by a tile filter
    (`{ tiles?, tags? }`, one of the 8 cells around the actor or its own).
    In a tile action's expressions, `tile` is the target cell. A new
    **`set_tile`** effect edits the map (never onto or off a container
    tile). Item `use` gains the same `duration`/`interrupt`.
  - **Effects apply only at completion**, after every start check
    (`when`, tools, consumed items, reach, filter) passes again; nothing is
    consumed before. There is no partial progress and no resuming.
  - **Moving or queueing a new action cancels** the activity, and so does
    the pack's **`interrupt`** expression, checked every tick after the
    start. Cancellation happens in the tick's intent phase, so it does not
    depend on the shell.
  - **Durations are evaluated once, at start** (a number or an
    expression in sim seconds, rounded up to whole ticks); a 0-tick action
    is instant and behaves exactly as before.
  - The activity, and every cell that differs from the map, are
    simulation state (snapshot and hash). `world.availableActions()` is a
    pure query for the shells; the context menu (`m5-context-menu`) and
    recipes (`m5-recipes`) build on it.
- ~~How does the player pick what to do, and how do far targets work?~~
  **Decided (spec `m5-context-menu`, M5):**
  - **Walk-then-act lives in the simulation**, as **`goto.then`**: a
    player `goto` can carry an action that is queued when the path arrives
    (in the same tick's action step), so it is deterministic, part of the
    snapshot and hash, and every check runs as usual. No path records the
    new `unreachable` reason; a path cleared before arrival drops it
    silently. `world.approachIntent(action)` picks the goto for a shell.
  - **Menus are built from a pure core query**, `world.interactionsAt(x,
    y)` (tile actions, containers, self actions, walk here), shared by the
    browser context menu (right-click, long-press, `E`) and the terminal's
    `x` list. The DOM layer is thin over a pure `contextMenu` model.
  - **Disabled entries are shown with reasons** (`Needs: Hammer, 2×
    Plank`, a pack's `unavailable` text such as `Only in the crypt`), so
    players learn what exists; `reasonText` is the one source of that text.
- ~~How does crafting work?~~ **Decided (spec `m5-recipes`, M5):**
  - **Recipes are a separate `recipes` domain** (consume, tools, produce,
    an optional station, `when`, `duration`, `interrupt`, extra effects),
    not a kind of action. They run as a **third activity source** on the
    shared lifecycle of `m5-timed-actions` (same cancellation, interrupt,
    completion-only rules, snapshot and hash). A source declares its
    completion steps in order, so recipes **consume, then produce, then
    run effects** while actions and item uses keep effects-then-consume.
  - **Stations are tile filters**, like action targets: a recipe made at
    a stove is `station: { tags: [heat] }`, bound to the first matching
    cell in reach (row-major) unless the shell names one. Station recipes
    appear in the context menu on the station's cell; the rest live in a
    crafting panel (browser `C`, terminal `c`).
  - **All recipes are known** from the start; no learning, skills or
    success chances.
  - **Overflow goes to the ground**: produced units that do not fit are
    put on the ground pile at the crafter's cell, so a completed recipe
    never loses items or fails for lack of room.
- ~~How is sight represented?~~ **Decided (task `line-of-sight`, M4
  groundwork):** sight is **tile-based line of sight**. Tiles get an
  **`opaque`** flag (default `!walkable`; the vampire window is
  `opaque: false`). The test walks integer Bresenham lines both ways and
  ORs them, so it is **symmetric**; endpoints are ignored, diagonal wall
  corners block, **entities never block**, and it allocates nothing. Pack
  data uses it through the **`can_see(a, b[, range])`** expression
  built-in (euclidean range, inclusive, checked first). No field of view,
  fog of war, light or facing yet. See `docs/expressions.md`.
- ~~How is noise represented without a per-tick cost proportional to the
  map?~~ **Decided (task `noise-hearing`, M4 completion):** noise is
  **events**, not a field over the grid. A **`noise` effect** (in
  `systems` and item `use`) emits a noise at **`self`'s cell** with a
  radius. A **hear** phase right after systems checks each (noise,
  entity) pair: hearing is **euclidean and inclusive**, and **ignores
  walls for now** (no muffling, flood fill or attenuation). Each entity
  remembers only its **last heard noise** (the nearest of its tick), with
  the cell and tick. Expressions test it with **`heard(entity, seconds)`**,
  and the **`investigate`** behavior activity walks to it (`done` once
  adjacent, when the path fails, or when nothing was heard). The cost is
  O(noises × entities) on noisy ticks only, with no allocation and
  nothing on silent ticks. Zombies investigate broken glass and alarm
  clocks; bats investigate creaky floorboards. There is no "last known
  position" for `pursue`, no memory of more than one noise, and no
  per-archetype hearing range yet. See `docs/packs.md`.
- ~~How do things get an orientation in the iso view?~~ **Decided (spec
  `iso-directional-sprites`):** **directional pre-rendered sprites**, in the
  style of classic isometric games; **no real-time 3D** and no change to
  the projection. Assets take `directions` (4-way or 8-way) and
  **horizontal mirroring** fills the rest (5 drawings for 8 ways, 2 for 4).
  Characters face their movement direction. Facing is **simulation
  state** (in snapshots and hashes): an entity turns 45° per
  `ticks_per_turn` beat toward a new direction before it steps (spec
  `turn-before-move`). In the browser a key tap only turns in place and
  a hold walks (spec `turn-in-place`). Map tiles get a static 4-way `facing` from the
  legend. Facing-aware actions (vision cones, interact with the faced
  tile) may come in M5.
  Animation frames are a later step. See `docs/iso.md`.
- ~~How are games saved and loaded?~~ **Decided (spec `m6-save-load`,
  M6):**
  - **A save is a snapshot plus pack identity**: `world.save()` is the
    world snapshot (now with the seed, `nextContainer` and changed tiles
    as `[x, y, id]`) with the format version, the pack namespaces and
    versions, and the start map id and size. Plain JSON, qualified ids,
    no wall-clock time; shells keep their metadata in a wrapper next to it.
  - **Restore is exact and rolls nothing**: `World.restore` rebuilds the
    world through a constructor path without spawning, loot, clamp or
    status updates, so a restored world has the same snapshot and the same
    future hashes. A shared `assertRoundTrip` test helper guards this for
    every later format change.
  - **Pack version drift is a warning, id drift is an error**: unknown
    archetypes, items, tiles, measurements, statuses, actions, recipes and
    behavior states fail the restore (with JSON paths and *did you mean*),
    as do other pack lists or maps; a different pack version, or an added
    or removed measurement, only warns. Rule changes inside a pack are not
    detected.
  - **Saves live in browser `localStorage` slots and exported files**: a
    quicksave (`F5`/`F9`) and three slots per pack list, plus file export
    and import; the terminal saves to a file (`S`/`L`, `--load`) and
    `check --save` validates one. No autosave, compression or cloud sync.
    See `docs/saves.md`.
- ~~How are maps authored once they outgrow ASCII rows?~~ **Decided (spec
  `m6-tiled-maps`, M6):**
  - **Tiled JSON only**: maps are `.tmj` with embedded or external `.tsj`
    tilesets; TMX/TSX (XML), compressed layers and infinite maps are load
    errors. ASCII rows stay supported for fixtures and small maps.
  - **Tile ids and facings come from tileset tile properties** (`tile`,
    `facing`), not from gids or flip flags; flipped gids are errors.
  - **The top-most visible layer wins** per cell; hidden layers are
    ignored and groups are flattened.
  - **Objects are matched by class** (`player`, `spawn` with `archetype`,
    `room` with `tags`); untyped objects are notes.
  - **Spawns are ordered row-major** (then by object id), so entity ids
    match the ASCII loader and do not depend on object order.
  - `npm run map:export` writes an ASCII map as an isometric 64×32 Tiled
    map; round trips are tested. See `docs/packs.md`.
- ~~How do buildings get upstairs?~~ **Decided (spec `m6-floors`, M6):**
  - **Floors are `z ≥ 0` joined by link tiles**: a map is a stack of
    same-size floors (ASCII `floors:`, Tiled `floor` groups); a tile with
    `climb: up`/`down` links its cell to the same `(x, y)` one floor up or
    down, as an edge both ways that exists while both ends are walkable
    (so `set_tile` can block stairs). Cells may be empty (no tile). One-floor
    maps keep their cell indices and behave exactly as before. No basements,
    falling, ramps or multi-cell stairs yet.
  - **A\* crosses links**: pathfinding searches the 3D grid (8 same-floor
    neighbours plus links, cost 1, octile heuristic on `(x, y)`), so
    click-to-move, walk-then-act, `pursue`, `investigate` and `home` work
    across floors; keyboard steps, `wander` and `flee` stay on their floor.
  - **No sight across floors, 3D hearing**: `can_see` is false between
    floors; noises reach 3D euclidean distance with one floor = one tile,
    and floors do not muffle. Reach is same-floor only.
  - **Floors above the player are cut away**: the iso view raises floor `z`
    by `z × BLOCK_H`, hides every floor above the player's (switching at a
    climb's midpoint) and fades the raised blocks just in front of the
    player. Saves become version 2 (every cell gets a `z`); version 1 saves
    still load. See `docs/packs.md#floors` and `docs/iso.md#floors`.

- ~~How does the world scale to a town?~~ **Decided (spec
  `m6-chunked-world`, M6):**
  - **Composite maps from parts, without nesting**: a `maps` entry with
    `size`, `fill`, `parts` (`{ map, at }`), `player`, `rooms` and
    `populate` is assembled at load from non-composite part maps (ASCII or
    Tiled), placed any number of times; parts may not overlap or be
    composites themselves. No rotation, mirroring or random selection.
  - **Seeded `populate`**: zones on any map (applied per placement on a
    part) scatter archetypes on candidate cells, without reuse, with a
    dedicated RNG derived from the seed; counts are checked at load and
    saves store the placed entities.
  - **Derived dormancy beyond an active radius**: an NPC farther than
    `start.simulation.active_radius` (Chebyshev, default 64) from the player
    neither thinks nor moves that tick, but still drifts, runs systems and
    statuses and hears. One O(n) pass per tick; never saved or hashed.
  - **Budgeted A\* with region labels**: searches stop after a node budget
    (NPC 4 000, player 60 000 by default), and connected-region labels
    (recomputed lazily after `set_tile`) reject unreachable goals without
    searching. A 16×16 entity index per floor serves `entitiesNear` and
    hearing.
  - **Lazy, evicted render chunks**: the iso scene builds a 16×16 chunk the
    first time it is near the view, keeps at most 160 in an LRU and
    destroys the rest; entity and pile sprites exist only in built, visible
    chunks. F3 shows a perf line.

## 8. Next step

M6 is delivered: **floors** (spec `m6-floors`), **Tiled maps** (spec
`m6-tiled-maps`), **save/load** (spec `m6-save-load`) and the **chunked
world** (spec `m6-chunked-world`). The zombie game is a 256×256 city built
from house, store, garage, park and road parts around the old town block,
with ~960 dead (dense downtown, sparse at the edges) that rest while far
away; the vampire's mansion stands in a 96×96 estate of graveyards and
village cottages with ~150 bats.

The next step is to author, via `spec-orchestrator`, the **M7 spec**:
packs as mods (stacking, overrides, joint validation), with zombie and
vampire as mods of the same base.

M5 is delivered: **timed actions** (spec `m5-timed-actions`), the
**context menu** (spec `m5-context-menu`) and **recipes** (spec
`m5-recipes`). Survivors barricade windows while the dead hear the
hammering, cook canned beans on a kitchen stove and tear rags into
bandages; the vampire closes shutters before dawn, rests on a crypt floor,
fills empty vials at the blood font and mixes blood wine. Right-click a
window or a stove across the room and the character walks up and starts.

S0, M0, M1, M2, M3 and M4 are delivered: zombie and vampire have a
survival and looting loop (houses and a mansion with rooms, containers
with per-room loot, weighted inventory, eating/drinking/healing with
items) and NPCs that see, hear and react, all in YAML, playable in the
terminal and in iso.

M4 is delivered: **sight** (`opaque` tiles, `can_see`), with an `alert`
status on the NPCs of both genres; **behaviors** (declarative state
machines): zombies wander, chase an `alert`-triggering survivor and give
up after losing sight, while bats roost, flee the vampire and fly home;
and **noise** (`noise` effect, hearing, `heard()`, `investigate`). A
survivor crunching over broken glass or winding up an alarm clock draws
the nearby horde to the spot, and creaky floorboards bring bats over to
look.

Questions moved to later milestones (to be decided in their specs, not
here): how NPCs use containers and items and act beyond movement (today
only the player acts; M5 actions), combat, whether NPCs remember a last
known position, and whether `systems` effects start creating or consuming
items.
