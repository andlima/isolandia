---
id: ux-help
area: web
priority: 40
depends_on: [ux-time-controls, ux-message-log]
description: UX — one bindings table as the single source for every browser key and gesture, a `?` controls overlay grouped by context, an Escape pause menu (Resume, Controls, Game, Title screen) with a defined Escape priority, a first-run "Press ? for controls" hint and a Help [?] button for touch; the terminal gets `?` help from its own table
---

# UX — Controls overlay and pause menu

## Goal

The game has about 25 keys and gestures, and they are only documented in
`docs/ui.md`. A new player can't find out that `E` opens the menu, `I`
the inventory or `J` the journal. Touch players have no hint at all. The
handlers in `src/web/main.ts` and the docs' Keys table are kept in sync
by hand. `Escape` closes whatever is open, but with nothing open it does
nothing, whereas most games open a pause menu there.

This spec puts every binding in **one table**. The game draws a
**controls overlay** from it (`?`), the docs table is checked against
it, and **Escape** opens a small **pause menu** when nothing else needs
closing.

Playable result: on a first visit, start `town+zombie`. A hint at the top
says *Press ? for controls* (on touch, *Tap ? for controls*) and fades
after a few seconds. Press `?`. The world pauses and an overlay lists
*Moving*, *Interacting*, *Windows*, *Time* and *Game* sections with keys
on the left and descriptions on the right, and mouse and touch gestures
alongside. `Escape` closes it and the world resumes. Press `Escape`
again with nothing open: a pause menu appears (*Resume*, *Controls*,
*Game…*, *Title screen*). In the terminal, `?` prints the key list until
any key.

## Acceptance Criteria

### Bindings table

1. **`src/web/bindings.ts`** exports `BINDINGS: readonly Binding[]`,
   where `Binding = { id, keys: string[], gesture?: { mouse?: string,
   touch?: string }, label, section, context?: 'menu' | 'dialogue' |
   'window' }`. Examples:
   - `{ id: 'inventory', keys: ['I', 'Tab'], label: 'Inventory / transfer
     window', section: 'Windows' }`;
   - `{ id: 'menu', keys: ['E'], gesture: { mouse: 'Right-click', touch:
     'Long-press' }, label: 'Action menu', section: 'Interacting' }`.

   It covers every browser key and gesture in today's Keys table, plus
   the keys added by `ux-time-controls` (`P`, `+`, `-`) and
   `ux-message-log` (`M`), and `?` / `Escape` from this spec. Sections,
   in order: Moving, Interacting, Windows, Time, Game, View.
2. **The key handlers dispatch through the table**: a lookup from
   `KeyboardEvent.code` / `key` to a binding `id` (keeping the current
   `code`-vs-`key` distinctions, e.g. `<` / `>` match by `key`). The big
   `if (code === …)` chain in `main.ts` becomes a `switch` on the id.
   Behaviour doesn't change, except for the new bindings.
3. A test fails when a binding id has no handler, or when the Keys table
   in `docs/ui.md` is missing a binding's keys. The docs table may still
   be written by hand, but it must list every key in `BINDINGS`.

### Controls overlay

4. **`?`** (by `key`, so any layout that types `?` works), the **Help
   [?]** button (top right, next to Journal, always shown) and the pause
   menu's *Controls* open a centred overlay drawn from the pure
   **`helpView(BINDINGS, input)`**. `input` is `'mouse' | 'touch'`,
   detected from the last pointer type, with `matchMedia('(pointer:
   coarse)')` as the initial guess. The view lists the sections in order,
   each row with keys rendered as `<kbd>` chips and the gesture for the
   current input. Context-only rows (menu or dialogue keys) are grouped
   under a small heading, for example *In the action menu*.
5. The overlay **pauses the world** while it is open (a shell pause like
   the auto-pause in `ux-time-controls`: it doesn't override a manual
   `P`). It closes with `Escape`, `?`, the × button or a click outside
   it. It scrolls on small screens and is readable at 360 px.
6. While a conversation is open, `?` still opens the overlay on top. The
   dialogue box keeps the keys when the overlay is closed.

### Pause menu

7. **Escape priority** (one pure function, `escapeTarget(state)`, with a
   test):
   1. the controls overlay;
   2. the context menu;
   3. the dialogue box (leave, as today);
   4. the open windows (transfer, crafting, journal, log, Game), closing
      the most recently opened one;
   5. otherwise, toggle the **pause menu**.
8. The **pause menu** is a small centred panel with *Resume*, *Controls*,
   *Game…* (opens the Game panel: saves, export, import), and *Title
   screen* (the same plain navigation as the Game panel's button). It
   pauses the world while it is open, has keyboard focus on *Resume*,
   supports arrows and `Enter`, and closes with `Escape` or *Resume*.
   After defeat or victory it still opens, without pausing anything.

### First-run hint

9. On the first game start in this browser (a `localStorage` flag, with
   errors ignored, so the hint simply shows again when storage is
   blocked), a hint *Press ? for controls* (*Tap ? for controls* on
   touch) appears under the top edge for about 6 s, then fades. Opening
   the overlay sets the flag at once. The hint is also added to the
   message log as an info line.

### Terminal

10. The terminal gets its own `TERMINAL_BINDINGS` table (in
    `src/ascii/`) with the same `Binding` shape (keys only). `?` shows it
    as text, grouped by section, until any key, in the same way `J` shows
    the journal. The help line ends with `?: help`, and the help line may
    drop its long key list in favour of `?: help` when the terminal is
    narrower than the full line.

### Tests and docs

11. Headless tests:
    - every binding id is handled (2–3);
    - every docs key is present (3);
    - `helpView` for mouse and touch;
    - `escapeTarget` for each priority level, including combinations;
    - the first-run flag with a working and a throwing store;
    - the terminal `?` output.
12. Docs: `docs/ui.md` gets a **Controls and pause menu** section and the
    `?` / `Escape` rows in the Keys table, and the terminal notes mention
    `?`. `README.md`'s quick-start mentions `?`.

## Out of Scope

- Rebinding keys, and settings beyond the auto-pause checkbox from
  `ux-time-controls`.
- A tutorial or guided first quest.
- Gamepad support.
- Localisation of labels.

## Design Notes

- Current code: the key handler and `captureKey` in `src/web/main.ts`,
  `src/web/keys.ts` (movement and climb tables, the `SUPPRESSED_KEYS`
  set, to which `?` needs no addition), panel toggles in
  `src/web/panels.ts`, and the Game panel in `src/web/saves.ts` /
  `game-panel.ts`.
- Movement keys stay in `MOVE_KEYS` for the step logic. The bindings
  table only lists them, for display (one row: *Arrows, WASD, numpad —
  Move*).
- The pause menu and the overlay use the shell pause from
  `ux-time-controls`. Model them as two more pause sources next to the
  window auto-pause.

## Agent Notes

- Implement after `ux-time-controls` and `ux-message-log`, so that their
  keys exist. Read both specs and `docs/ui.md` (Keys) first.
- Keep the dispatch change behaviour-preserving. The existing input
  tests must keep passing unchanged.
