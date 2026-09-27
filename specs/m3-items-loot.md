---
id: m3-items-loot
area: sim
priority: 40
depends_on: [m2-systems-statuses]
description: M3 looting loop — pack-defined `items` (weight, tags, use effects), weight-capped containers (tile containers, entity inventories, ground piles), map `rooms` with tags, seeded `loot` tables picked per container and room by `distributions`, instant take/drop/put/use actions, item-aware expressions, and inventory/loot UI in both shells
---

# M3 — Items, containers and loot

## Goal

Make the world lootable, declared entirely in packs:

- **`items`** have a weight and tags, and can be **used** to run effects on
  the user (eat, drink, bandage).
- **Containers** hold items up to a weight capacity. There are three kinds:
  containers built into tiles (fridge, crate), entity **inventories**, and
  **ground piles** created by dropping items.
- Maps gain **rooms**: rectangles with tags (`kitchen`, `cellar`…).
- **Loot tables** fill containers when the world is created. The table for
  each container is chosen by its tile and its room (`distributions`).

The milestone is playable when, in `base+zombie` and `base+vampire`, the
player can walk into a house, open containers, take what fits, and survive
by eating or drinking from the inventory instead of standing on a tile.

Items are **plain data inside containers**, not entities: a stack is
`{ item, count }`. No engine code may be genre-specific (VISION.md §3.5).

## Acceptance Criteria

### Pack schema additions

1. **`items` domain** (a list of entries):

   | Field    | Type                      | Default     | Notes |
   |----------|---------------------------|-------------|-------|
   | `id`     | id                        | required    | Own id space |
   | `label`  | string                    | required    | |
   | `glyph`, `color` | as for tiles      | required    | ASCII ground piles, iso placeholder |
   | `weight` | number ≥ 0                | required    | Per unit. Stored in integer **hundredths** (see AC 4) |
   | `tags`   | list of `[a-z][a-z0-9_]*` | `[]`        | Item tags, separate from tile and archetype tags |
   | `sprite` | asset id                  | placeholder | Iso ground-pile sprite |
   | `use`    | mapping                   | none        | See below. Items without `use` cannot be used |

   `use` is `{ label?, when?, effects, consume? }`:
   - `label` is the verb shown in the UI. It defaults to `"Use"`.
   - `when` is an optional expression with `self` set to the user. When
     it is falsy, the use fails with the reason `cannot_use`.
   - `effects` is a non-empty list in the M2 vocabulary (`apply`/`set` on
     `self`). The effects run immediately, in order, and see each other's
     results. Values are clamped at the next clamp phase, as in M2.
   - `consume` is a non-negative integer, `1` by default. It is how many
     units one use removes. `0` makes the item reusable.
2. **Tile containers.** `tiles` accept an optional
   `container: { capacity: <number ≥ 0> }`. Every map cell with such a tile
   gets its own container when the world is created. The container's label
   is the tile's label. Tile containers may be walkable (a floor crate) or
   not (a fridge).
3. **Inventories.** `archetypes` accept an optional
   `inventory: { capacity: <number ≥ 0>, items?: map item id → count }`.
   - Every entity of that archetype gets its own inventory, filled with
     `items` in the order they are written.
   - Those starting items must fit in `capacity`; otherwise it is a load
     error.
   - Entities without `inventory` have none. Actions that need one fail
     with the reason `no_inventory`.
4. **Weight.**
   - Weights and capacities are rounded to 0.01 at load. The simulation
     compares and sums them as integers (hundredths), so there is no float
     drift.
   - A container's load is Σ `weight × count`. A move into a container is
     allowed only if the load stays ≤ `capacity`.
   - Ground piles have unlimited capacity.
   - Expressions and the UI show weights in normal units (hundredths / 100).
5. **Container contents.**
   - Contents are an ordered list of stacks, with **at most one stack per
     item id**. Adding an item already present increases that stack's
     count. A new item id is appended at the end.
   - A stack whose count reaches 0 is removed.
   - There is no per-stack or per-slot limit; weight is the only limit.
6. **Rooms.** `maps` accept an optional list
   `rooms: [{ rect: [x, y, w, h], tags: [kitchen, …] }]`.
   - A cell's room tags are the union of the tags of every rect that
     contains it. Rects may overlap.
   - A rect must lie inside the map and have `w, h ≥ 1`, and `tags` must be
     non-empty. Anything else is a load error.
   - Expressions gain `tile.in_room("tag")` and `in_room(tile, "tag")`,
     which test the room tags of the cell under `self`. Room tags, tile tags
     and entity tags are three separate sets.
7. **`loot` domain** (a list of tables):

   ```yaml
   loot:
     - id: kitchen_food
       rolls: [1, 3]                    # integer, or [min, max] inclusive
       entries:
         - { item: canned_beans, weight: 3, count: [1, 2] }
         - { item: water_bottle, weight: 2 }       # count defaults to 1
         - { table: junk, weight: 1 }             # nested table, rolled once
         - { nothing: true, weight: 2 }
   ```

   - Each roll picks one entry, with probability proportional to its
     `weight` (a positive integer).
   - An entry is exactly one of `item`, `table` or `nothing: true`.
   - `count` is an integer or `[min, max]`, both ≥ 1. It is only allowed
     on `item` entries.
   - A nested `table` is rolled once, with its own `rolls`.
   - Cycles between tables are a load error.
8. **`distributions` domain** (a list):
   `{ container: <tile id>, room?: <room tag>, table: <loot id> }`.
   - The `container` tile must have `container`.
   - When the world is created, each tile container takes the **first
     most specific** match. An entry whose `room` is one of the cell's
     room tags beats an entry without `room`. Ties go to the first entry,
     in definition order.
   - A container with no match starts empty.
9. **Loot generation.**
   - Loot is rolled once, in the `World` constructor, over tile containers
     in row-major cell order.
   - It uses a **dedicated RNG**, derived from the world seed, and does not
     touch the world RNG. Existing movement and `random()` sequences stay
     the same for the same seed.
   - Items that do not fit the container's capacity are dropped silently.
     The loader warns (it does not fail) when a table's maximum possible
     weight exceeds the capacity of a container it is distributed to.
   - The same definition and seed always give the same contents.
10. **Item expressions.**
    - `count_item(entity, "id")` and `self.count_item("id")` return the
      number of units of an item in the entity's inventory, or `0`.
    - `has_item(entity, "id")` and `self.has_item("id")` are the same as
      `count_item(...) > 0`.
    - `self.carry_weight` and `self.carry_capacity` read the inventory's
      load and capacity in normal units, or `0` without an inventory.
    - Item ids must be **string literals**, resolved at load time like
      `has_status`: unknown ids are errors with a suggestion. The runtime
      never compares strings.

### Simulation

11. **Actions.** `World` gains `queueAction(action)`. It is separate from
    `queueIntent`, so looting never cancels walking. Actions are FIFO,
    applied during the intent phase after the movement intent, all in the
    same tick. The action kinds are:

    | Kind   | Fields                                  | Effect |
    |--------|-----------------------------------------|--------|
    | `take` | `container`, `item`, `count?` (default all) | Container → player inventory |
    | `put`  | `container`, `item`, `count?`           | Player inventory → container |
    | `drop` | `item`, `count?`                        | Player inventory → the ground pile on the player's cell (created if missing) |
    | `use`  | `item`                                  | Runs the item's `use`, then removes `consume` units |

    - `container` is a numeric container id (AC 12). `item` is a qualified
      item id.
    - **Reach:** the container's cell must be the player's cell or
      8-adjacent to it (Chebyshev ≤ 1). Inventories cannot be targeted by
      `take`/`put`; taking from other entities is out of scope.
    - **Partial moves:** `take`/`put` move as many units as fit, up to
      `count`. Moving 0 units is a failure.
    - Every action records `world.lastAction`:
      `{ kind, item, moved, ok, reason?, tick }`. `reason` is one of
      `out_of_reach`, `too_heavy`, `missing`, `cannot_use`,
      `no_inventory` or `unknown_container`. A new object is created each
      time, as with `lastGoto`.
    - The pending action queue and `lastAction` are part of `snapshot()`.
    - After defeat, `queueAction` ignores its input, like `queueIntent`.
12. **Container identity.**
    - Containers get sequential integer ids that are never reused.
    - Ids are assigned in this order: tile containers in row-major order,
      then entity inventories in entity order. Ground piles get the next
      id when they are created.
    - A ground pile that becomes empty is removed.
    - `world.containersAt(x, y)` lists the containers on a cell, in id
      order. `world.reachableContainers()` lists every container the player
      can reach now, in id order, excluding the player's own inventory.
    - `snapshot()` gains `containers`: for each container its `id`, `kind`
      (`tile` | `inventory` | `ground`), its cell or owner entity id, and
      its stacks as `[itemId, count]`. `hash()` covers them.
    - If existing golden hashes change because of the new snapshot field,
      update them and say so in the PR.
13. **Goto to an adjacent tile.** `GotoIntent` gains `adjacent?: boolean`.
    When it is true, the path ends on the reachable walkable tile that is
    8-adjacent to the goal (or on the goal itself, if it is walkable) and
    has the shortest path. Ties are broken deterministically. This is how
    the shells walk up to a fridge.
14. **Determinism and cost.**
    - Same definition, seed, intents and actions ⇒ same hashes.
    - Containers do no per-tick work. `count_item` is a scan of one
      inventory's stacks.
    - `npm run bench:sim` must not regress by more than 5% on the existing
      scenario. Report the ticks/s before and after in the PR.

### Shells

15. **HUD model.** `hudModel` gains:
    - `inventory`: the player's stacks (`label`, `count`, `weight`,
      `useLabel` or null), plus `weight` and `capacity`. It is `null`
      without an inventory.
    - `nearby`: the reachable containers, each with an id, a label, a
      position and its stacks.
    - `lastAction`: a short text (e.g. `Took 2 Canned beans`,
      `Too heavy`), or null.

    The shells only render these. All formatting lives in the pure HUD
    module. ASCII snapshot tests for packs without items must stay
    byte-identical.
16. **Terminal shell.**
    - The HUD adds `Carrying: w/cap` and an inventory line with numbered
      stacks, only when the player has an inventory. It adds a `Nearby:`
      line only when a container is reachable.
    - New keys:
      - `g` takes everything that fits from every reachable container;
      - `1`–`9` use inventory stack N;
      - `d` followed by `1`–`9` drops stack N.

      These keys do not clash with `hjklyubn`.
    - Ground piles render with the first stack's item glyph and colour when
      no entity is on the cell.
17. **Browser shell.**
    - A DOM **inventory panel** lists the player's stacks, with Use (the
      item's `useLabel`) and Drop buttons, and shows weight/capacity. `I`
      or `Tab` toggles it.
    - A **loot panel** opens automatically when at least one container is
      reachable. It lists each reachable container's stacks, with
      *Take* / *Take all* buttons and a *Put* option from the inventory.
    - Clicking a non-walkable container tile sends a `goto` with
      `adjacent: true`.
    - Ground piles render in iso, depth-sorted with objects, using the
      first stack's item `sprite` or a small generated placeholder in the
      item's colour. The day/night tint applies to them.
    - After defeat, the panels are read-only.

### Two-genre validation

18. Both genre packs use every new primitive:
    - items with `use`;
    - tile containers in at least two kinds of room;
    - `rooms`;
    - nested `loot` tables;
    - `distributions` with and without `room`;
    - a starting player inventory;
    - `count_item`/`has_item` in a status or system.

    They need no engine code. Suggested content, to be tuned by the
    implementer:
    - **zombie:**
      - add houses with `kitchen`, `bathroom` and `bedroom` rooms;
      - add fridge, cupboard, medicine cabinet and dresser containers, and
        make the wrecked cars into glovebox containers;
      - add items such as canned food and water bottles (which lower
        hunger/thirst), a bandage (restores hp) and heavy junk;
      - replace the `food` standing-tile system with items;
      - add a *Burdened* status when `carry_weight` is near
        `carry_capacity`, which raises fatigue.
    - **vampire:**
      - add a `cellar` room with wine racks that hold blood vials (which
        restore blood);
      - put a `library` in the mansion;
      - add a *heavy cloak* item that suppresses *Sunburnt* while carried
        (`not self.has_item("cloak")` in its `when`);
      - the blood font may remain.

    Headless scenario tests on the real packs must show, for each genre,
    that:
    - an idle player is still defeated within two in-game days;
    - a scripted player survives to the end of day 2 using only
      `goto`/`take`/`use`, and never stands on a restoring tile;
    - taking stops at capacity, with reason `too_heavy`.

    Test several seeds. `npm run check` must pass for both combos, and
    `src/` must contain no genre words.

### Validation, tests and docs

19. **Load errors**, reported with pack, file, line and key path, and
    collected before failing:
    - negative weight or capacity;
    - unknown item, loot table, tile or room tag references (with
      suggestions);
    - `use` with empty `effects` or a negative or non-integer `consume`;
    - starting inventory over capacity;
    - a room rect out of bounds or empty, or empty room tags;
    - loot problems:
      - an entry that is not exactly one of `item`/`table`/`nothing`;
      - a non-positive or non-integer entry weight;
      - a bad `rolls`/`count` range;
      - `count` on a non-item entry;
      - a table cycle;
    - a `distributions` `container` whose tile has no `container`;
    - a non-literal id in `count_item`/`has_item`/`in_room`.

    `Definition` gains:
    - `items`, `loot` and `distributions`, with `ids.items` and
      `ids.loot`;
    - `TileDef.container`;
    - `ArchetypeDef.inventory`;
    - `MapDef.rooms` (resolved to a per-cell room-tag lookup).
20. **Tests.** Extend `npm test` with:
    - stack merging and removal;
    - weight arithmetic in hundredths (for example, 0.1 × 3 fits a 0.3
      capacity);
    - partial take/put;
    - every failure reason;
    - reach;
    - ground pile creation and removal;
    - container id stability;
    - loot:
      - determinism;
      - weight distribution: a statistical check over many seeds with a
        loose bound;
      - nesting, `nothing` entries and `rolls` ranges;
      - the world RNG left untouched;
    - distribution specificity and tie order;
    - `in_room`, `count_item`, `has_item`, `carry_weight`;
    - `use` effects, `when` and `consume: 0`;
    - `goto` with `adjacent`;
    - actions ignored after defeat;
    - hash determinism with actions;
    - the HUD model;
    - one failing loader fixture per rule in AC 19;
    - the scenario tests from AC 18.
21. **Docs.**
    - `docs/packs.md` documents:
      - `items`;
      - tile `container`;
      - archetype `inventory`;
      - map `rooms`;
      - `loot`;
      - `distributions`;
      - where actions fit in the tick order.
    - `docs/expressions.md` documents `in_room`, `count_item`, `has_item`
      and `carry_weight`/`carry_capacity`.
    - `VISION.md` marks M3 as done, records the decisions in §7 and updates
      §8 toward M4. The §7 decisions are:
      - items are data in containers;
      - weights are stored in hundredths;
      - rooms are rects;
      - the most specific distribution wins;
      - loot has its own RNG;
      - actions are instant until M5.

## Out of Scope

- Action durations, progress bars, interruption and the right-click
  context menu (M5), and recipes/crafting (M5).
- Equipment slots, wielding, durability, spoilage, item conditions, and
  per-item instance data.
- Nested containers (bags inside inventories), and weight slowing
  movement. Packs can model encumbrance with statuses via `carry_weight`.
- Taking from or giving to other entities, NPC looting, and loot dropped
  on death.
- Respawning loot, lazy loot generation per chunk (M6), and Tiled room
  layers (M6).
- Item effects on entities other than the user, effects that give items
  (such as an empty can after eating), and item-spawning `systems` effects.
- Drag-and-drop UI.
- Pack override or merge semantics for `loot`/`distributions` across packs
  (M7). Until then, these are plain id-keyed lists like `systems`.

## Design Notes

- Put containers in a small module (`src/core/sim/containers.ts`) with
  pure operations: `add`, `remove`, `load` and `fits`. Use parallel arrays
  or a tiny struct per container; stacks are `{ item: number; count:
  number }` with item indices, never strings. `World` owns a
  `Map<number, Container>` plus a per-cell index (`Int32Array` of first
  container id, or a small `Map<cell, id[]>`) for `containersAt`.
- Give each entity an optional `inv: Container | null`, so that
  `count_item` compiles to a scan over `ctx.self.inv`. Resolve the item
  index at load time, as `has_status` does.
- Derive the loot RNG with something like `new Rng(mix(seed, 0x6c6f6f74))`
  so that it does not share state with `world.rng`.
- Pre-resolve loot tables to index arrays with cumulative weights. Check
  for cycles with a DFS at load.
- Resolve rooms to a per-cell `Uint16Array` of room-set ids (unique
  combinations of tags), so that `in_room` is one array read plus a set
  lookup that can be precomputed per (room-set, tag).
- For `goto` with `adjacent: true`, run A* with a multi-goal target (any
  walkable neighbour of the goal) instead of trying 8 separate searches.
- Keep the browser panels thin: build them from `hudModel` and turn
  button clicks into `queueAction`. Chromium is unavailable in the sandbox,
  so the logic has to be testable without the DOM.

## Agent Notes

- Read these first:
  - `VISION.md` §4 (items / containers / loot tables);
  - `docs/packs.md` and `docs/expressions.md`;
  - `src/core/definition.ts`;
  - `src/core/sim/world.ts`;
  - `src/core/expr/compile.ts` (how `has_status` resolves literals);
  - `src/core/load/load.ts`.
- Suggested order:
  1. item defs and container ops;
  2. inventories and actions;
  3. rooms and `in_room`;
  4. loot and distributions;
  5. item expressions;
  6. `goto` with `adjacent`;
  7. the HUD model;
  8. the terminal shell;
  9. the browser panels and iso ground piles;
  10. pack content and scenario tests;
  11. bench and docs.
- Map edits must keep exactly one player start and a rectangular map. Do
  not break `npm run play` for either genre.
- Removing the zombie `food` standing-tile system changes the M2 scenario
  tests. Update them to the new looting scenario rather than keeping dead
  content around.
