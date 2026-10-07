---
id: ux-smart-click
area: web
priority: 40
depends_on: [ux-object-picking]
description: UX — fewer clicks and a cleaner menu — left-click runs a safe default (open a container, climb, walk) or opens the menu when the object has real actions; Shift-click always walks; hover outline, cursor and tooltip; menu with the default first, durations and costs, 1–9 shortcuts, no Walk here on left-click, and disabled entries folded under "Can't do now"
---

# UX — Smart click, hover and a cleaner menu

## Goal

Every interaction today takes a right-click and a pick from a list. Left
click only walks. Nothing on screen says what can be clicked. The menu
mixes what you can do with what you cannot, and the obvious choice is
often not first. Opening the fridge you are standing next to takes two
clicks; finding out that a window can be barricaded takes right-clicking
around.

This spec makes the common case one click and the menu easy to read:

- **left click does the safe default** (open a container, climb, walk),
  and opens the menu when the object has actions that cost something;
- **hover** shows what is under the pointer and what a click will do;
- the **menu** puts the default first, shows how long things take and
  what they use up, gets number shortcuts, and folds what you can't do
  yet under one row.

It builds on `ux-object-picking` (the target under the pointer). No
simulation changes are needed apart from the optional `duration` and
`uses` fields on `Interaction` (criterion 9).

Playable result: in `zombie`, hover a fridge and see "Fridge · kitchen —
Click: Open"; one click walks over and shows its contents. Click a window
and a menu opens with *Barricade · 8s · uses 2× Plank* (whatever the pack's
duration and costs are) on top; press `1`
to do it. With no hammer, the menu says *Can't do now (1) ▸*, and
expanding it shows *Barricade — Needs: Hammer*. In `vampire`, click
yourself in the crypt and the menu offers *Rest*. Shift-click anywhere
just walks.

## Acceptance Criteria

### Click plan (pure)

1. **`clickPlan(world, target)`** in `src/web/menu.ts` is a pure function
   (no DOM) that says what a plain left click on a `PickTarget` does. Let
   `entries = world.interactionsAt(x, y, z)` for the target's cell:
   - `actionable` = the **enabled** (`ok`) entries of kind `act` or
     `craft`;
   - `safe` = the first enabled `open` entry; else the `climb` entry when
     the cell has **exactly one** climb direction; else `walk`.

   The plan is:
   - `{ kind: 'run', entry: safe }` when `actionable` is empty and `safe`
     exists. Running it is exactly what choosing that entry in the menu
     does today (walk-then-open, climb, `clickIntent`);
   - `{ kind: 'menu' }` when `actionable` is not empty, or when there is no
     `safe` entry but the cell has other entries (disabled actions, two
     climb directions, a `take_all` without `open`…);
   - `{ kind: 'walk' }` (today's `clickIntent`, adjacent when needed) when
     `entries` is empty, so clicking a plain wall still walks next to it.

   On the player's own cell, `walk` is never `safe`. A cell with only
   self actions (`Rest`) gives `menu`, and a cell with nothing gives
   `{ kind: 'none' }`.
2. **Shift + left click** always walks (`clickIntent`), ignoring the plan.
   It is the escape hatch when the default is not wanted.
3. **Touch:** a tap is a left click. A long-press opens the menu, as
   right-click does.
4. **Right-click** (and long-press, and `E`) always opens the menu and
   never runs the default directly.

### Menu

5. **One menu, two openings.** The menu opened by a left click (plan
   `menu`) and by right-click/long-press/`E` share one model. They differ
   only in that the right-click menu ends with **Walk here** (when the cell
   is walkable and not the player's own) and the left-click menu does not.
6. **Order.** `contextMenu` returns, for the target cell:
   1. the **default** entry first: the plan's `safe` entry when it is not
      `walk`, marked `default: true` and labelled with a "click" hint;
   2. the other **enabled** entries in today's `interactionsAt` order;
   3. **Walk here** (right-click menu only);
   4. a single **fold row** `Can't do now (N) ▸` when `N > 0` entries are
      disabled. It is collapsed by default. Expanding it (click, `Enter`
      or `→` on it) shows those entries greyed out with their
      `reasonText`, as today. They are never chosen.

   A menu with no enabled entries opens with the fold row expanded.
7. **Details on enabled entries.** An `act`/`craft` entry shows, after
   its label, its **duration** when it is > 0 (`8s`, `1m 20s`, in sim
   seconds) and a short **uses** line for consumed items (`uses 2× Plank`).
   Tools are not listed, since they are not spent. Recipes show their
   `produce` count when it is > 1 (`Cook: Hot beans ×2`).
8. **Shortcuts.** Enabled entries are numbered `1`–`9` in display order,
   and pressing the digit chooses that entry. Arrow keys move over enabled
   entries and the fold row (and over disabled entries while expanded).
   `Enter` chooses, `Escape` closes. Every closing rule from
   `docs/ui.md` stays (click outside, pan, zoom, another menu, game end).
9. **Core support.** `Interaction` gains two optional fields, both filled
   purely (no RNG, `hash()` unchanged, as for the rest of
   `interactionsAt`):
   - `duration?: number`: the action's or recipe's duration in sim
     seconds, evaluated as the start would evaluate it now. It is omitted
     when evaluation needs state only known at start or fails;
   - `uses?: readonly { item, label, count }[]`: what completion consumes.

   `availableActions()` / `availableRecipes()` may reuse the same helper.
   The ASCII `x` list may show them but is not required to.

### Hover (mouse and pen only)

10. On every pointer move over the canvas (throttled to once per frame),
    and when the world changes under a still pointer (tick,
    `containerVersion`, `tileVersion`), the shell picks the target with
    `pickTarget` and computes `hoverInfo(world, target)` (pure):
    `{ title, hint, cursor }`.
    - `title`: the tile label and its room tags as in `menuTitle`
      (`Fridge · kitchen`); for an entity target, its archetype label;
      for a pile, `Ground` plus its first item labels.
    - `hint`: from the click plan: `Click: Open`, `Click: Go up`,
      `Click: 3 actions`, or empty for a plain walk.
    - `cursor`: `pointer` for `run`/`menu` plans, `default` for walk,
      `not-allowed` for `none`.
11. **Outline.** The hovered target's cell gets a subtle outline in the
    iso scene's marker layer, distinct from the menu-target and path
    outlines. For a raised tile or entity, the outline covers its cell.
    It is hidden while the menu is open, while panning, and when the
    pointer leaves the canvas.
12. **Tooltip.** A small DOM label near the pointer shows `title` and,
    on a second line, `hint`. It is kept inside the viewport like the
    menu (`clampMenu`). It appears after the pointer has rested ~150 ms
    on a target and is hidden while the menu is open or while dragging.
    `H` (HUD toggle) also hides tooltips.
13. Hover is not shown for touch input, where a tap acts at once and
    there is no hover.

### Tests and docs

14. Headless tests cover:
    - `clickPlan` for both genres: zombie fridge (`run` open, from afar
      too), zombie window with and without materials (`menu`), stairs
      with one and with two directions, a wall with nothing (`walk`), a
      pile (`run` open), the player's own cell with and without self
      actions (`menu` / `none`), and vampire shutters (`menu`);
    - `contextMenu` ordering: default first, enabled next, Walk here
      only for the right-click variant, the fold row's count, and the
      fold expanded when nothing is enabled;
    - numbering, and that disabled entries are never numbered or chosen;
    - `duration`/`uses` on `interactionsAt` entries, with `hash()` and the
      RNG unchanged;
    - `hoverInfo` titles, hints and cursors.
15. **Docs.** `docs/ui.md` is updated: the click rules (default, menu,
    Shift-click, touch), hover, the menu layout, the `1`–`9` keys, and the
    Keys table. `docs/packs.md` documents the new `Interaction` fields.
    `VISION.md` §7 records the decision: "left click runs a safe default
    (open, climb, walk), or opens the menu when the object has actions
    that cost something; disabled entries fold under *Can't do now*".

## Out of Scope

- The loot/inventory window (`ux-transfer-window`). Plan `run` on a
  container still ends in today's loot panel.
- Pack-declared defaults (`primary: true`) and running a costly action on
  a plain left click.
- Radial menus, entity interactions (talk, attack), interacting with the
  faced tile, key rebinding.
- Visual restyling of panels beyond what the menu and tooltip need.

## Design Notes

- Today's menu: `contextMenu`, `menuTitle`, `runMenuItem`, `clampMenu`,
  `moveSelection` in `src/web/menu.ts`; DOM in `src/web/menu-dom.ts`;
  click wiring in `src/web/main.ts` (`click`, `menu`, `longPress`,
  `KeyE`); CSS in `index.html` (`#menu`). Marker outlines are in
  `src/iso/scene.ts` (`target`, `invalid`, `menuMark`).
- `clickPlan` should reuse `contextMenu`'s mapping (in reach → actions,
  out of reach → `approachIntent` / walk-then-open) rather than duplicate
  it: e.g. `run` carries the `MenuItem` to pass to `runMenuItem`.
- Hover calls `interactionsAt` often. Cache `hoverInfo` per target cell
  and recompute only when the target or the world versions change.
- `Shift` is read from the pointer event. `Input` currently gives
  `click(sx, sy)` only, so it will need the modifier state.

## Agent Notes

- Read `docs/ui.md` and spec `m5-context-menu` (the current model) first.
- Keep `E` opening the menu on the player's own cell.
- The `walk` fallback must keep the current `clickIntent` behaviour for
  non-walkable cells (`adjacent: true`), or clicking walls breaks.
