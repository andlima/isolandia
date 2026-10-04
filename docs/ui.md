# Browser UI

## Interaction

Right-click a tile (or long-press it on a touch screen) to open the
**context menu**: everything you can do at that cell, near or far. Press
`E` to open it for your own cell, at your character.

The menu is built from the core query `world.interactionsAt(x, y)` (see
[packs](packs.md#actions)) by the pure function `contextMenu(world, x, y)`
in `src/web/menu.ts`; `src/web/menu-dom.ts` only renders it. Entries, in
order:

1. the pack's **tile actions** that match the cell's tile (e.g.
   *Barricade* on a window);
2. the **station recipes** whose station matches the cell (e.g.
   *Cook: Hot beans* on a stove), with the same in-reach and walk-then-act
   behaviour as tile actions;
3. **Open** and, when not empty, **Take all from …** for each container on
   the cell;
4. on your own cell, the **self actions** (e.g. *Rest*);
5. **Walk here**, on any other walkable cell.

Entries that cannot be done stay in the list, greyed out, with the reason
underneath (`Needs: Hammer, 2× Plank`, `Only in the crypt`, …), so you
learn what exists.

**Walk-then-act.** Choosing an action that is out of reach walks there
first: the shell queues a `goto` whose `then` is the action
(`world.approachIntent`), and the simulation starts it on arrival. *Open*
from afar walks up to the container and then shows it in the loot panel;
*Take all* from afar takes the first stack on arrival and shows the
container in the loot panel for the rest. Items are computed when the menu
opens; the simulation checks everything again when the action runs, so a
stale menu is harmless.

**Controls.**

- **Right-click** on the game canvas (the browser's own menu is
  suppressed there only, not on the panels). The target is the tile under
  the pointer, picked like a left click.
- **Long-press:** one finger held within the drag threshold (8 px) for
  500 ms opens the menu. A long-press never also counts as a tap, and a
  drag or a second finger cancels it.
- **`E`:** your own cell.
- While the menu is open, the arrow keys move the selection, `Enter`
  chooses, and `Escape` closes it. A click outside (which does nothing
  else), panning, zooming, opening another menu or the end of the game
  close it too. The target cell is outlined while it is open.

Left click still walks to a tile. Pack actions are no longer listed in the
loot panel; item uses stay in the inventory panel (`I` / `Tab`).

## Crafting panel

`C` (or the **Crafting [C]** button at the bottom left) toggles the
crafting panel. It lists every [recipe](packs.md#recipes), grouped by
`category`; each row shows the result, its inputs (`2× Rag`), tools and
station (`at Stove`), and a **Craft** button. Craft is disabled with a
hint when the recipe cannot be made now (`Needs: 2× Rag`, or
`Go to a Stove` when its station is out of reach: right-click the station
to walk there and craft). The view is the pure function
`craftingView(world, readOnly)` in `src/web/panels.ts` over
`world.availableRecipes()`; it re-renders when `tick`, `containerVersion`
or `tileVersion` changes. Recipes without a station live only here, not in
the context menu.
