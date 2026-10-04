---
id: m5-timed-actions
area: sim
priority: 40
depends_on: [iso-directional-sprites]
description: M5 core — a pack-defined `actions` domain (self- or tile-targeted, `when`, `tools`/`consume`, `duration`, `interrupt`, completion effects incl. a new `set_tile`), an optional `duration`/`interrupt` on item `use`, a per-entity in-progress activity with progress and deterministic interruption, an `availableActions` query, and progress UI plus a minimal action list in both shells
---

# M5a — Timed actions

## Goal

Almost everything in Zomboid takes time: bandaging, barricading a window,
resting. This spec gives the engine the vocabulary for it, declared in
packs:

- A new **`actions`** domain. An action targets either the actor
  (`self`) or an adjacent **tile** chosen by a tile filter. It has a
  `when` condition, **tools** and **consumed items**, a **duration**, an
  **interrupt** condition and **completion effects**.
- A new **`set_tile`** effect, so an action can change the map
  (window → barricaded window).
- Item **`use`** gains an optional `duration`/`interrupt`. Bandaging
  takes three seconds; eating stays instant.
- The player gets an in-progress **activity** that the simulation advances
  deterministically. A movement intent or a newly queued action cancels
  it, and so does the pack's `interrupt` expression.
- Both shells show a **progress bar** and get a minimal way to start pack
  actions on reachable tiles. The real context menu comes in
  `m5-context-menu`, and crafting comes in `m5-recipes`. Both build on
  the contracts defined here.

Playable result: in `zombie`, the player loots a hammer, planks and nails,
then barricades a window while the shamblers outside hear the hammering.
In `vampire`, the player closes a window's shutters before dawn and rests
in a coffin until a noise wakes them. No engine code may be genre-specific
(VISION.md §3.5, §3.8).

## Acceptance Criteria

### Pack schema: `actions` domain

1. **`actions`** is a new domain: a list of entries with their own id
   space.

   | Field       | Type                         | Default  | Notes |
   |-------------|------------------------------|----------|-------|
   | `id`        | id                           | required | Own id space |
   | `label`     | string                       | required | Verb shown in the UI, e.g. `Barricade` |
   | `progress`  | string                       | `label`  | Text shown while in progress, e.g. `Barricading` |
   | `target`    | `self` or a **tile filter**  | required | See AC 2 |
   | `when`      | expression                   | `true`   | Checked at start and at completion |
   | `tools`     | list of item ids             | `[]`     | Must be in the actor's inventory (≥ 1 unit) at start and at completion; never consumed |
   | `consume`   | map item id → integer ≥ 1    | `{}`     | Must be held at start and at completion; removed at completion |
   | `duration`  | number ≥ 0 or expression (sim seconds) | `0` | See AC 5 |
   | `interrupt` | expression                   | none     | Evaluated every tick while in progress; truthy cancels (AC 7) |
   | `effects`   | list                         | `[]`     | Run once, at completion. An action with no `effects` and no `consume` is a load error |

2. **Targets.**
   - `target: self` acts on the actor. In its expressions, `tile` is the
     cell under the actor.
   - A **tile filter** is a mapping `{ tiles?: [tile ids], tags?: [tile
     tags] }` with at least one non-empty list. A cell matches when its
     tile is in `tiles` **or** has any of the `tags`. Its target is one
     map cell `(x, y)`, which must be the actor's cell or one of the 8
     around it (the same reach as containers). In that action's `when`,
     `interrupt`, `duration` and `effects`, `tile` (and its fields
     `x`/`y`/`id`, `has_tag` and `in_room`) refers to the **target cell**,
     not the cell under the actor. `self` is still the actor.
   - Unknown tile ids, item ids and malformed filters are load errors with
     the usual *did you mean* suggestions. A tag that no tile in the
     loaded packs carries is a load **warning**.
   - The tile filter shape `{ tiles?, tags? }` is a reusable definition.
     `m5-recipes` uses it for crafting stations.
3. **Item `use` additions.** `use` accepts optional `duration` and
   `interrupt` with the same meaning as in AC 1. A `use` with
   `duration` > 0 becomes timed:
   - the item must be held at start and at completion;
   - `when` is checked at both points;
   - `effects` run and `consume` units are removed **at completion**.

   `duration` 0, the default, keeps today's instant behaviour exactly.
4. **`set_tile` effect.** `{ type: set_tile, tile: <tile id> }` is allowed
   only in the `effects` of tile-targeted actions. Anywhere else it is a
   load error, including systems, item uses and self actions. It replaces
   the tile at the target cell. Rules:
   - Neither the new tile nor the target cell's current tile may have a
     `container`. For the new tile this is a load error. For the current
     tile it is checked at run time, and the action fails with
     `invalid_target`. Container identity therefore never changes.
   - The cell's legend `facing` (from `iso-directional-sprites`) is kept.
   - The grid's walkability and opacity arrays are updated at once. Every
     cached pathfinding structure is invalidated, and so is any cached
     line-of-sight structure. Paths already in progress are not
     recomputed: a step into a cell that is no longer walkable fails, as
     today, and clears the path.
   - If the new tile is not walkable and any entity stands on the target
     cell, the whole action fails at completion with `occupied`. Nothing
     is consumed and no effect runs.
   - The world keeps a `tileVersion` counter that increases on every
     change, so shells can detect map edits cheaply. Changed cells are
     simulation state: `snapshot()` includes them as a sorted list of
     `[cellIndex, tileId]` that differ from the map, and `hash()` covers
     them.

   Effects run in order, as in systems. `apply`/`set`/`noise` still act on
   `self`, the actor, and a `noise` effect is emitted at the actor's cell.

### Duration and the activity

5. **Duration.** `duration` is in sim seconds, like `systems.every`. A
   number must be a whole number of ticks (load error otherwise). An
   expression is evaluated **once, at start**. Its result is rounded up to
   whole ticks, and a negative result becomes 0. A duration of 0 ticks
   completes in the same phase in which it starts, so it behaves as an
   instant action.
6. **Starting.** A new action kind is queued with
   `world.queueAction({ kind: 'act', action, x?, y? })`. `x`/`y` are
   required for tile targets and forbidden for `self`. `{ kind: 'use',
   item }` is unchanged. On start, in phase 1 (after movement), the engine
   checks, in this order:
   1. the action id resolves (`unknown_action`);
   2. the actor has an inventory if the action needs `tools`/`consume`
      (`no_inventory`);
   3. the target is in reach and matches the filter (`out_of_reach` /
      `invalid_target`);
   4. tools and consumed items are held (`missing`);
   5. `when` is truthy (`cannot_act`).

   If all checks pass and the duration is > 0, the actor gets an
   **activity**: `{ kind: 'act' | 'use', action?, item?, x, y, startTick,
   endTick }`. Starting an activity also **clears the actor's path and
   pending intent**, so the player stops walking. The activity is part of
   the entity snapshot and of `hash()`. Only the player starts activities
   in this spec, but the field and the per-tick advance work for any
   entity.
7. **Cancellation and interruption.**
   - A movement intent applied for the player in phase 1 cancels the
     activity with reason `cancelled`, including a `goto` or `step` queued
     by a click or key.
   - Any newly queued action (`act`, `use`, `take`, `put`, `drop`) cancels
     the activity with reason `cancelled` before that action is applied.
     If several actions are queued in one tick, the last activity started
     wins.
   - While an activity is in progress, in every tick **after** its start
     tick, the `interrupt` expression (if any) is evaluated before the
     completion check, with `self` set to the actor and `tile` set as in
     AC 2. If it is truthy, the activity ends with reason `interrupted`.
   - A cancelled or interrupted activity has **no effects and consumes
     nothing**. There is no partial progress.
   - Defeat freezes the world as today. An activity in progress at defeat
     simply stays in the snapshot.
8. **Completion.** `endTick = startTick + n`, where *n* is the duration in
   ticks. A duration of 0 completes immediately in step 2 of phase 1 and
   never creates an activity. Otherwise, the activity completes in the
   work step of the tick where `tick == endTick`, after the interrupt
   check. A 6-second action started on tick 100 completes on tick 160:
   - The `when` condition, tools, consumed items, reach and the target
     filter are checked again. The world may have changed: a zombie may
     have barricaded the window first, or the item may have been dropped.
     If a check fails, the activity ends with the matching reason.
   - Then the `occupied` check runs for `set_tile` (AC 4).
   - Then effects run in order, and `consume` items are removed.

   The start-tick work step does nothing for a new activity: no interrupt
   check and no completion.
9. **Tick order.** Phase 1 becomes:
   1. movement intents (id order), which may cancel the player's activity;
   2. queued player actions (FIFO), which may cancel or start activities;
   3. **work**: advance every entity's activity, in id order (interrupt
      check, then completion).

   Noises from completion effects are emitted in phase 1, with the other
   player-action noises, so they are heard in the same tick.
   `docs/packs.md` "Tick order" documents this.
10. **Results.** `ActionRecord` gains:
    - an `action?: string` field, the qualified action id for `act`;
    - a `stage: 'start' | 'complete'` field. Instant actions (duration 0,
      take/put/drop and instant use) record a single `complete` record;
    - new reasons: `unknown_action`, `invalid_target`, `cannot_act`,
      `occupied`, `cancelled`, `interrupted`.

    `world.lastAction` is written on start, on completion and on
    cancellation or interruption. `actionText` in `src/core/hud.ts` gives
    readable messages for all of them, e.g. `You start barricading.`,
    `Barricade interrupted.` and `You can't reach that.`.
11. **Expressions.**
    - `self.busy` (or `busy(entity)`) is `true` while the entity has an
      activity.
    - `doing(entity, "action_id")` is `true` while the entity's activity
      is that action. Its second argument is a string literal resolved
      at load time, as `has_status` is.
    - Both are documented in `docs/expressions.md`. These are enough for
      a pack to write, e.g., a status `focused` that applies while
      `doing(self, "rest")`.

### Query API

12. **`world.availableActions()`** returns, for the player, every
    action that could be started right now:
    - every `self` action;
    - every tile action × each matching cell within reach, in row-major
      order;
    - each item in the inventory with a `use`.

    Each entry is `{ kind, action?, item?, x?, y?, label, ok, reason? }`.
    Entries whose target and filter match but whose tools, consumed items
    or `when` fail are **included** with `ok: false` and the reason. The
    context menu shows them disabled. Entries out of reach or not
    matching the filter are omitted. The query is pure: no RNG draws and
    no state change. Expressions that call `random` inside `when` are
    evaluated with a throwaway RNG, so the query never advances
    `world.rng`.
13. `world.activityProgress(entity = player)` returns `null` or `{ label,
    fraction }`, where `label` is the action's `progress` text (or the
    item use's label) and `fraction` is in `[0, 1]`.

### Shells

14. **HUD.** `hudModel` gains an `activity: { label, fraction } | null`.
    - The ASCII HUD shows it as `Barricading [######----] 60%`.
    - The browser HUD shows a progress bar (the DOM HUD is fine; no Pixi
      required) and, optionally, a small bar over the player's sprite.
15. **Starting pack actions.** This is a minimal UI that
    `m5-context-menu` will supersede for tile actions. Both shells read
    `availableActions()`:
    - **Browser:** an "Actions" section in the loot panel lists the `ok`
      and not-`ok` entries for tile and self actions. Not-`ok` entries are
      disabled, with the reason as text. Clicking an entry queues the
      action.
    - **ASCII:** `x` opens a numbered list (like the `d` drop prefix);
      `1`–`9` start an action; any other key closes the list. Movement
      keys still cancel an activity.
    - The inventory's Use buttons work unchanged. Timed uses now show
      progress.
16. **Iso map edits.** When `tileVersion` changes, the iso scene
    re-renders the affected cells. Rebuilding the containing render chunk
    and the raised-object layer is fine. The ASCII renderer already reads
    the grid each frame, and a test proves that it shows the new glyph.

### Packs (two-genre rule)

17. **zombie:**
    - New items `hammer` (tool), `plank` and `nails`, added to existing
      loot tables so that a normal seed yields enough for at least one
      barricade. A test pins one seed.
    - New tiles `window` (walkable: false, opaque: false) and
      `barricaded_window` (walkable: false, opaque: true). Some house
      walls in `town` become windows.
    - Action `barricade`: target `{ tiles: [window] }`, tools `[hammer]`,
      consume `{ plank: 2, nails: 4 }`, `duration: 6`, effects
      `set_tile barricaded_window` plus a `noise` of radius ≥ 12. It has
      no `interrupt`: only moving or a new action cancels it. The
      hammering noise is emitted at completion, so shamblers react to a
      finished barricade.
    - `bandage`'s `use` gets `duration: 3` and `interrupt: 'heard(self,
      0.1)'`, so a nearby noise startles the player and wastes the attempt
      (the bandage is not consumed).
18. **vampire:**
    - New tile `shuttered_window` (walkable: false, opaque: true).
    - Action `shutter`: target `{ tiles: [window] }`, `duration: 2`, no
      tools, `set_tile shuttered_window`.
    - Self action `rest`: `when: 'tile.has_tag("crypt")'`,
      `duration: 10`, `interrupt: 'heard(self, 1)'`, effects that restore
      `hp`.
    - This exercises a self target, an interrupt by noise and a no-item
      action.

### Tests and docs

19. Headless tests (`node:test`) cover:
    - each load error and warning in AC 1–5;
    - instant vs timed completion tick math (a 6-second action completes
      exactly 60 ticks after it starts);
    - cancellation by step, goto and a new action;
    - interruption by expression, checked from the tick after the start;
    - re-check failures at completion (an item dropped mid-way, the tile
      already changed);
    - `occupied`;
    - that `set_tile` updates walk/opaque, A* and `can_see`;
    - the snapshot/hash of the activity and changed tiles;
    - that `availableActions()` leaves `hash()` and the RNG untouched;
    - `busy`/`doing`;
    - both pack scenarios end to end (zombie barricade, vampire rest
      interrupted by a noise).

    The existing determinism tests keep passing, and the engine
    genre-word guard test still passes.
20. **Docs.**
    - `docs/packs.md` documents the `actions` domain, tile filters,
      `set_tile`, `use.duration`/`interrupt`, the new action kinds,
      reasons and stages, and the updated tick order.
    - `docs/expressions.md` documents `busy`/`doing` and how `tile` binds
      in tile-targeted actions.
    - `VISION.md` §7 records the decisions:
      - actions are pack-defined with self/tile targets;
      - effects apply only at completion;
      - moving or a new action cancels, plus an `interrupt` expression;
      - durations are evaluated once at start.

      §5 notes M5 as in progress.

## Out of Scope

- The right-click context menu and walk-then-act (`m5-context-menu`).
- Recipes and crafting (`m5-recipes`).
- Entity-targeted actions (attack, feed on, give to), NPCs starting
  actions from behaviors, and combat.
- Partial progress or per-tick effects while working, resuming an
  interrupted action, and action queues ("do these three things").
- Skills or XP modifying durations. A pack may already write `duration`
  as an expression over measurements.
- Containers on mutable tiles, tile health/damage, zombies breaking
  barricades (a later spec can add a behavior activity that uses
  `set_tile`), and multi-cell targets.
- Game-time units for `duration` (`30m`).
- Pack override semantics for `actions` (M7).

## Design Notes

- **Shared machinery for later specs.** Keep the requirement checks
  (`tools`/`consume`/`when`/reach/filter) and the activity lifecycle in
  one small module, e.g. `src/core/sim/activity.ts`, with a single
  internal "activity source" interface: label, progress text, target
  kind, checks, duration, interrupt and onComplete. Pack actions and
  timed item uses are two sources. `m5-recipes` adds a third, so it
  should not need to touch the lifecycle code.
- Compile the tile filter at load to a per-tile-index `Uint8Array` of
  matches. Matching a cell is then one array read.
- **Binding `tile` to the target cell.** `ExprContext` currently derives
  `tile` from `self`. Add an optional override (target x/y) on the
  context that `tile*` accessors consult, set and cleared around action
  evaluation. Do not allocate per evaluation.
- **`set_tile`.**
  - `Grid` needs a `setTile(i, tileIndex)` that updates `cells`, `walk`
    and `opaque` and bumps a version counter.
  - `Pathfinder` and any sight caches should check that version (or be
    dropped) instead of being rebuilt every tick.
  - The world's `tileTagSets` lookup already reads `grid.cells` live.
    Verify that `ctx` and the think env do too.
  - For snapshots, compare `grid.cells` against `map.cells` on demand, or
    keep a `Map<cellIndex, tileIndex>` of overrides.
- **Interruption ordering.** Cancelling on a new movement intent must be
  deterministic and independent of the shell. Do it where the intent is
  applied (phase 1), not inside `queueIntent`. A shell calling
  `queueIntent` then `queueAction` in the same frame must yield the same
  result in Node and in the browser.
- `availableActions()` must not allocate unbounded garbage per frame. The
  browser calls it only when the panel is open, or when `tick` or
  `containerVersion`/`tileVersion` changes.

## Agent Notes

- Read these first:
  - `VISION.md` §4 (actions) and §7;
  - `docs/packs.md` (items, Actions, Tick order);
  - `src/core/sim/world.ts` (`applyAction`, `runEffects`, `step`);
  - `src/core/sim/grid.ts`, `src/core/sim/astar.ts` and
    `src/core/sim/sight.ts`;
  - `src/core/load/load.ts` (how `items.use` and `systems.effects` are
    validated);
  - `src/core/hud.ts`, `src/web/panels.ts` and `src/ascii/terminal.ts`.
- Suggested order:
  1. defs and loader validation;
  2. the activity lifecycle with timed `use`;
  3. pack actions with self targets;
  4. tile targets and `tile` rebinding;
  5. `set_tile`, grid invalidation and snapshots;
  6. `availableActions`;
  7. the HUD and shells;
  8. iso re-render;
  9. pack content and scenarios;
  10. docs.
- Map edits must keep exactly one player start and a rectangular map. Do
  not break `npm run play` or the browser build for either genre.
- `heard()` excludes a noise's own source (only entities *other than* the
  source hear it). A test should pin that a player's own completion noise
  never interrupts the player's next timed action.
- Chromium is unavailable in the sandbox. Keep panel and HUD logic in
  pure functions that are testable without the DOM, as `panels.ts`
  already does.
