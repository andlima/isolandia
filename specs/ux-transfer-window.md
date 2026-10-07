---
id: ux-transfer-window
area: web
priority: 40
depends_on: []
description: UX — replace the auto-shown loot panel and its Put matrix with one transfer window opened on a container — container tabs on the left, inventory on the right, item icons, click moves a whole stack, Shift-click moves one, Take all / Put all, weight bar; the inventory panel becomes the same window without a container
---

# UX — Transfer window

## Goal

Looting today goes through a text panel that **pops up by itself**
whenever any container is in reach. It lists every reachable container,
moves **one unit per click** (`Take`), and puts items back through a grid
of `Put → <container>` buttons, one per inventory stack per container.
Inventory is a second panel in another corner. Emptying a fridge of six
cans takes six clicks, and putting things back means hunting for the
right button in a matrix.

This spec replaces both with a single **transfer window**: what is in
the container on one side, what you carry on the other, with icons.
Clicking a stack moves all of it to the other side.

Playable result: in `zombie`, open a kitchen counter (from the context
menu, or with one click once `ux-smart-click` lands). A window shows the
counter's stacks on the left with their icons and your inventory on the
right. Click *Canned beans ×3* and all three move across, and the weight
bar fills. Shift-click a *Rag ×4* in your inventory and one rag goes into
the counter. Click the *Fridge* tab to loot the fridge next to it without
reopening anything. Walk away and the window closes. Press `I` and the
same window opens with only your inventory and its *Use* / *Drop*
buttons.

## Acceptance Criteria

### View model (pure)

1. **`transferView(world, openContainer | null, readOnly)`** in
   `src/web/panels.ts` (or a new `src/web/transfer.ts`) is a pure function
   over `hudModel` with no DOM types. It returns:
   - `tabs`: one per **reachable** container (`reachableContainers()`
     order), with `{ id, label, weight, capacity | null, selected }`.
     `selected` is `openContainer` when it is reachable. The list is empty
     when `openContainer` is null (inventory-only mode);
   - `container`: the selected container's stacks, or null;
   - `inventory`: the player's stacks and `carrying` (`w / cap`) plus a
     fill fraction for a weight bar;
   - per stack: `{ item, label, count, weight, icon, move, moveOne, use?,
     drop }`, where `move`/`moveOne` are `take`/`put` actions with `count`
     omitted (the whole stack: the engine moves as many units as fit) and
     `count: 1`; `use` (with the item's use label) and `drop` exist on
     inventory stacks only;
   - `takeAll` (every container stack) and `putAll` (every inventory
     stack into the selected container), each null when its source is
     empty.

   Everything is disabled once the game has ended (`readOnly`), as
   today.
2. **Icons.** `icon` is the item's `sprite` asset when it has one (the
   asset's file URL, as loaded by the renderer), else a placeholder
   swatch from the item's `color` and `glyph`. The DOM draws icons with
   `image-rendering: pixelated`, so pixel art stays crisp.

### Window behaviour (DOM)

3. **Opening.**
   - The context-menu **Open** entry (and any later caller of
     `openLoot(container)`) opens the window with that container's tab
     selected. When the container is out of reach, the window opens once
     it comes into reach. This reuses the existing deferred `focus` of
     `Panels.openLoot`.
   - **`I` / `Tab`** toggle the window in inventory-only mode, or switch
     an open transfer window to inventory-only and back.
   - The window **no longer opens by itself** when a container comes into
     reach. The HUD's `Nearby:` line stays as the passive cue.
4. **Moving.**
   - Clicking a stack row moves the **whole stack** to the other side
     (`move`). **Shift-click** moves **one** (`moveOne`).
   - *Take all* and *Put all* buttons sit above each pane.
   - A move that fails (`too_heavy`, …) shows the `actionText` message
     inside the window (e.g. under the inventory weight bar) for a few
     seconds, as well as on the HUD.
   - Rows are buttons (keyboard-focusable). `Enter` on a focused row
     moves the stack and `Shift+Enter` moves one.
   - On inventory rows, *Use* and *Drop* are small buttons whose clicks
     do not trigger the row's move.
   - In inventory-only mode, clicking a row does nothing. Its buttons
     still work.
5. **Tabs.** Every reachable container (tile containers and ground piles,
   including the pile on the player's own cell) has a tab. Clicking a tab
   selects it. When the selected container leaves reach (the player
   walked away, the pile emptied and vanished), the next reachable tab is
   selected. If none is left, the window falls back to inventory-only
   mode when it was opened with `I`, and **closes** otherwise.
6. **Closing.** `Escape`, a close button, or opening the
   crafting/game panel closes it. Dropping items while the window is open
   makes the ground pile appear as a tab.
7. **Layout.** One window, two panes side by side (container left,
   inventory right), each scrolling on its own. On viewports narrower
   than ~560 px the panes stack vertically (container on top). The window
   is anchored at the bottom right, like the loot panel today, and never
   covers the player's sprite at the default zoom. It updates live,
   re-rendering only when its
   view changes, as the panels do today.
8. **Removed.** The old `#loot` panel, its `Put` matrix and the
   standalone `#inventory` panel are removed, together with their CSS and
   the `lootView`/`inventoryView` functions (or those are rewritten as
   `transferView`). The crafting panel and the game panel are unchanged.

### Tests and docs

9. Headless tests cover `transferView`:
   - tabs for several reachable containers, the selected tab, and
     reselection when the selected one leaves reach;
   - `move` carries no `count` and `moveOne` carries `count: 1`, in both
     directions;
   - `takeAll` / `putAll` and their null cases;
   - icons for an item with a sprite and one without;
   - read-only after defeat;
   - an end-to-end step: queuing `move` for a stack of 3 moves 3 units
     (and fewer when weight allows fewer), using the zombie and vampire
     packs.
10. **Docs.** `docs/ui.md` replaces the loot and inventory panel text
    with the transfer window (opening, moving, Shift-click, tabs,
    closing, `I`/`Tab`, narrow layout) and updates the Keys table.
    `docs/screens/` screenshots from `npm run smoke` may be refreshed, but
    that is not required.

## Out of Scope

- Drag-and-drop (a later spec may add it on top of the same view model).
- Moving a chosen amount (a count dialog), sorting and filtering.
- Equipment slots, item tooltips beyond the label, count and weight.
- NPC inventories and trading (M8 social layer).
- The ASCII shell's loot commands.
- Changing what *Open* or a left click does (`ux-smart-click`).

## Design Notes

- Current code: `inventoryView`, `lootView` and the `Panels` class in
  `src/web/panels.ts`; `openLoot` comes from `src/web/menu-dom.ts`
  (`ContextMenu` constructor) and `src/web/main.ts`; CSS `#inventory`,
  `#loot` and `.panel` in `index.html`; `hudModel` / `HudContainer` in
  `src/core/hud.ts`.
- Take and put already move "as many units as fit, up to `count`"
  (`docs/packs.md`, Player actions), so whole-stack moves need no engine
  change.
- Asset URLs: `src/web/main.ts` already resolves pack asset files to URLs
  for `loadAssetTextures`. Pass the item → URL map to the window instead
  of extracting textures from Pixi.
- This spec does not depend on `ux-smart-click`. If both land, a left
  click on a container (plan `run` → Open) opens this window. Keep
  `openLoot(container)` as the single entry point so they meet there.

## Agent Notes

- Read `docs/ui.md` (current panels) and `docs/packs.md` (Containers,
  Player actions) first.
- Keep the panel's "re-render only when the JSON of the view changes"
  approach, so the DOM is not rebuilt every tick.
- Check the 360 px width: the stacked layout must keep every button
  reachable.
