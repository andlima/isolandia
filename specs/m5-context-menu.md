---
id: m5-context-menu
area: web
priority: 40
depends_on: [m5-timed-actions]
description: M5 interaction — a right-click / long-press context menu in the browser listing what can be done at a cell (pack tile actions, containers, self actions, walk here), disabled entries with readable reasons, and deterministic walk-then-act via a `then` action on `goto` intents
---

# M5b — Context menu and walk-then-act

## Goal

Zomboid's interaction model is: right-click something and get a menu of
what you can do with it. If it is out of reach, the character walks over
and then does it. `m5-timed-actions` added pack-defined actions and an
`availableActions()` query, but you can only start an action from a list
in the loot panel, and only when you are already in reach.

This spec adds:

- **walk-then-act** in the simulation: a `goto` intent can carry a
  `then` action, which the engine queues on arrival. It is deterministic
  and part of the snapshot;
- a core **interaction query** for any cell, near or far, with readable
  reasons for disabled entries (`Needs: Hammer, 2× Plank`);
- a browser **context menu**, opened by right click, by touch long-press
  or by a key, built from a pure menu model.

Playable result: in `zombie`, right-click a window across the room and
choose *Barricade*. The survivor walks up and starts hammering. If the
nails are missing, the entry is greyed out and says so. In `vampire`,
right-click a window and choose *Close shutters*; right-click your own
cell in the crypt and choose *Rest*.

## Acceptance Criteria

### Simulation: walk-then-act

1. **`GotoIntent.then`.** `GotoIntent` gains an optional `then: Action`,
   using the same `Action` union as `queueAction`.
   - Only the player's intents may carry `then`. `queueIntent` with
     `then` for another entity throws.
   - The pending `then` is part of the entity snapshot and of `hash()`.
2. **Arrival.** When the player's path from that `goto` ends with the
   player standing on its last cell, the `then` action is appended to the
   action queue. It is then applied in the same tick's action step (phase
   1, step 2 of `m5-timed-actions`), exactly as if a shell had queued it.
   - A `goto` whose path is empty (already at the goal, or already
     adjacent with `adjacent: true`) queues `then` in the same tick.
   - Because arrival happens through the normal action queue, every
     check (reach, filter, tools, `when`) runs as usual, and the action
     may still fail, e.g. if the window was barricaded in the meantime.
3. **Dropping `then`.**
   - If A* finds **no path**, `then` is dropped and `world.lastAction`
     records `{ kind, stage: 'complete', ok: false, reason: 'unreachable',
     tick }`. `unreachable` is a new reason, and `actionText` covers it.
   - If the path is **cleared before arrival** (a step fails because a
     cell became unwalkable, or a new intent or action replaces it),
     `then` is dropped silently. A new intent's own `then`, if any,
     replaces it.
4. **Choosing the approach.** `world.approachIntent(action)` is a helper
   that returns the intent a shell should queue for an action. For an
   action that is already in reach, or that needs no reach (`self` and
   `use`), it returns `null`, and the shell queues the action directly.
   Otherwise it returns `{ kind: 'goto', x, y, adjacent: <target not
   walkable>, then: action }` targeting the action's cell. For
   `take`/`put` the target is the container's cell; for `act` it is
   `x`/`y`.

### Core: interaction query

5. **`world.interactionsAt(x, y)`** returns the entries the player can
   choose at a cell, ignoring reach. It is pure: no RNG draws and no
   state change, and `hash()` is unchanged (same rule as
   `availableActions()`). Entries, in this order:
   1. every pack **tile action** whose filter matches the cell's current
      tile, in action definition order;
   2. for each **container** on the cell (tile container, ground pile):
      an `open` entry, plus a `take_all` entry when the container is not
      empty;
   3. when `(x, y)` is the **player's own cell**: every `self` action;
   4. **walk here**, when the cell is walkable and is not the player's
      cell.

   Each entry is `{ id, label, kind, ok, reason?, missing?, action?,
   container?, inReach }`:
   - `ok`/`reason` come from the same checks as `m5-timed-actions`, with
     reach excluded;
   - `missing` lists `{ item, label, count }` for absent tools or
     consumed items;
   - `inReach` says whether the player can act without walking.

   The cell must be in bounds, and the query returns `[]` out of bounds
   or after defeat.
6. `availableActions()` entries from `m5-timed-actions` also gain
   `missing`, with the same shape, so every UI shares one source of
   "what's missing".
7. `reasonText(entry)` in `src/core/hud.ts` turns reasons into short UI
   strings:
   - `missing` becomes `Needs: Hammer, 2× Plank`;
   - `cannot_act` becomes `Not now`, or the action's optional
     `unavailable` text;
   - `invalid_target` becomes `Can't do that here`;
   - other reasons get matching readable text.
8. **Optional `unavailable` field.** Pack actions accept an optional
   `unavailable: string` field, the text shown when `when` is falsy. For
   example, vampire `rest` uses `"Only in the crypt"`. `docs/packs.md`
   documents it.

### Browser menu

9. **Menu model.** `contextMenu(world, x, y): MenuItem[]` (in
   `src/web/menu.ts`) is a pure function over `interactionsAt` and has no
   DOM types. Each `MenuItem` is `{ label, disabled, hint?, run }`:
   - `hint` is the reason text for disabled items;
   - `run` is `{ intent?: GotoIntent; actions?: Action[]; openLoot?:
     boolean }`.

   Items map as follows:
   - **Tile action / take all:** in reach → `actions: [a]`; out of reach
     → `intent: approachIntent(a)`.
   - **Open:** in reach → `openLoot: true`. Out of reach → a `goto`
     (adjacent when needed), with `openLoot: true` deferred until the
     loot panel sees the container in reach. The loot panel already
     auto-shows reachable containers; reuse that.
   - **Walk here:** `intent: clickIntent(world, x, y)`.

   Disabled items stay in the list, so players learn what exists.
10. **Opening the menu.**
    - **Right-click** on the canvas: the `contextmenu` event, with the
      default prevented. It picks the tile under the pointer with the
      same `pickTile` used for left click.
    - **Touch long-press:** `Gestures` gains a `longPress(sx, sy)`
      handler that fires once when a single pointer stays within
      `DRAG_THRESHOLD` for ≥ `LONG_PRESS_MS` (500). A long-press never
      also produces a click, and a drag or a second finger cancels it.
      To keep the timing testable without timers, `Gestures` takes an
      injectable clock and a `tick(now)` method (called from the frame
      loop), instead of `setTimeout`.
    - **Keyboard:** `E` opens the menu for the player's own cell, at the
      player's screen position.

    Left click keeps its current behaviour.
11. **Menu behaviour (DOM).**
    - The menu is positioned at the pointer and clamped inside the
      viewport, and works at 360 px width.
    - Arrow keys move the selection, Enter selects, and Escape closes.
    - A click outside, a pan or zoom, opening another menu, or defeat
      closes it.
    - Selecting an enabled item runs it (queues the intent and/or
      actions, opens loot) and closes the menu. Disabled items show
      their `hint` and do nothing.
    - The menu shows the title of the target cell, e.g. the tile label,
      plus a room tag when present.
    - Items are computed **when the menu opens**. The simulation
      re-validates on execution, so stale menus are harmless.
12. **Iso highlight.** While the menu is open, the target cell gets the
    same kind of outline already used for unreachable flashes, but
    steady.
13. **Loot panel.** Remove the "Actions" section added by
    `m5-timed-actions` from the loot panel. Tile actions now live in the
    context menu, and self actions are reached by right-clicking your own
    cell or pressing `E`. The inventory panel's Use buttons are unchanged.

### ASCII shell

14. The ASCII `x` list (from `m5-timed-actions`) adds, after the
    in-reach actions, `take all` entries for reachable non-empty
    containers. It builds from `interactionsAt` over the reachable cells,
    so both shells share the core query. ASCII gets no cursor or far
    targeting in this spec.

### Tests and docs

15. Headless tests cover:
    - **`then`:** arrival on a path, an empty path, no path
      (`unreachable`), a path cut mid-way by `set_tile`, replacement by a
      new intent, the snapshot/hash, and determinism across two runs;
    - **`approachIntent`:** in reach, out of reach, a non-walkable target;
    - **`interactionsAt`:** ordering, the `missing` lists,
      `inReach`, own-cell self actions, out of bounds, and that `hash()`
      and the RNG are untouched;
    - **`contextMenu`:** mappings for both genres (zombie window from afar
      with and without materials; vampire shutter and rest);
    - **`Gestures`:** long-press fires once, never with a click, and is
      cancelled by a drag or a second pointer, using an injected clock;
    - **`reasonText`:** each reason.
16. **Docs.**
    - `docs/packs.md` documents `goto.then`, the `unreachable` reason and
      `unavailable`.
    - A short "Interaction" section (in `docs/packs.md` or a new
      `docs/ui.md`) describes the menu, the long-press and the `E` key.
    - `VISION.md` §7 records:
      - walk-then-act lives in the sim, as `goto.then`;
      - menus are built from a pure core query;
      - disabled entries are shown with reasons.

## Out of Scope

- Item submenus in the world menu (use or drop from the right-click
  menu). The inventory panel still handles items.
- Entity targets (right-click an NPC), combat and dialogue.
- Recipes and crafting entries. `m5-recipes` adds them to the same
  query.
- Queues of multiple actions, shift-click to queue, and hotkeys per
  action.
- A cursor or look mode for the ASCII shell.
- Gamepad input.

## Design Notes

- Store `then` on the entity (`e.then`) next to `e.path`. In
  `applyIntent`, clear it wherever `path` is cleared due to failure or
  replacement. In the branch where the path finishes (`pathPos >=
  path.length` after a successful move), push it to the world's action
  queue. Keep the action-queue push ordered before `applyActions` in the
  same tick. Movement already runs before actions in phase 1, so this
  holds naturally.
- `interactionsAt` and `availableActions` should share one internal
  checker that `m5-timed-actions` already factored (requirements check
  with a `skipReach` flag). Do not duplicate the check order.
- Keep the DOM part of the menu thin (`src/web/menu-dom.ts` or a class in
  `menu.ts` behind a pure model), following the `panels.ts` split.
- `pickTile` already accounts for raised tiles. Reuse it for the
  context-menu target.

## Agent Notes

- Read these first:
  - `specs/m5-timed-actions.md` and its implementation (the activity
    module and `availableActions`);
  - `src/web/main.ts`, `src/web/input.ts`, `src/web/gestures.ts` and
    `src/web/panels.ts`;
  - `src/core/sim/world.ts` (`applyIntent`, `applyActions`).
- Chromium is unavailable in the sandbox. Put all logic in pure, tested
  functions; the DOM layer only renders and forwards events.
- Make sure the browser's own context menu is suppressed only on the game
  canvas, not on panels.
