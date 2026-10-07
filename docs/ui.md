# Browser UI

## Interaction

**Left click does the safe default.** A plain left click (or a tap) on an
object runs what is safe there, and opens the menu when the object has
actions that cost something. The rule is the pure function
`clickPlan(world, target)` in `src/web/menu.ts`, over
`world.interactionsAt(x, y, z)` for the target's cell:

- the **safe** entry is the first enabled **Open**, else **Go up** /
  **Go down** when the cell has exactly one way, else **Walk here**;
- when the cell has no enabled tile action or recipe, the click **runs**
  the safe entry, exactly as choosing it in the menu would (walk up to a
  fridge and show its contents, climb the stairs, walk);
- when it has one (*Barricade* you can do now, *Cook* at a stove), or has
  entries but nothing safe (only disabled actions, stairs that go both
  ways), the click opens the **menu**;
- a cell with nothing on it (a plain wall) walks there, next to it when it
  cannot be entered, as before; on your own cell with nothing to do the
  click does nothing, and with only self actions (*Rest*) it opens the
  menu.

**Shift + click** always just walks there. **Right-click**, a
**long-press** and **`E`** always open the menu and never run the default.
On a touch screen a tap is a left click and a long-press opens the menu.

**The menu** is one model for both openings, `contextMenu(world, x, y, z,
opening)` (`src/web/menu-dom.ts` only renders it). Rows, in order:

1. the **default** (the safe entry, unless it is *Walk here*), with a
   `click` tag;
2. the other **enabled** entries in `interactionsAt` order: tile actions
   (e.g. *Barricade* on a window), station recipes (*Cook: Hot beans* on a
   stove), *Open* / *Take all from …* per container, *Go up* / *Go down*
   on an open [link](packs.md#floors), and on your own cell the self
   actions (*Rest*);
3. **Walk here**, on a walkable cell other than yours, in the right-click
   (long-press, `E`) menu only;
4. one fold row, **Can't do now (N) ▸**, when N entries cannot be done.
   Expanding it (click, `Enter` or `→` on it) lists them greyed out with
   the reason underneath (`Needs: Hammer, 2× Plank`, `Only in the
   crypt`, …), so you learn what exists; they are never chosen. A menu
   with nothing enabled opens with the fold expanded.

An enabled action or recipe shows after its label how long it takes and
what it uses up (`Barricade · 6s · uses 2× Plank, 4× Nails`); tools are
not listed, since they are not spent. A recipe that makes more than one
unit says so (`Cook: Hot beans ×2`).

**Walk-then-act.** Choosing an action that is out of reach walks there
first: the shell queues a `goto` whose `then` is the action
(`world.approachIntent`), and the simulation starts it on arrival. *Open*
from afar walks up to the container and then shows it in the loot panel;
*Take all* from afar takes the first stack on arrival and shows the
container in the loot panel for the rest. Items are computed when the menu
opens; the simulation checks everything again when the action runs, so a
stale menu is harmless.

**Menu keys.** Enabled rows are numbered `1`–`9`; pressing the digit
chooses that row. The arrow keys move over the enabled rows and the fold
row (and the greyed-out rows while expanded), `Enter` chooses, `→` / `←`
on the fold row expand / collapse it, and `Escape` closes the menu. A
click outside (which does nothing else), panning, zooming, opening
another menu or the end of the game close it too. The target cell is
outlined while it is open.

**Hover** (mouse and pen only; touch has none). Pointing at the canvas
outlines the target's cell faintly, sets the cursor (a hand when a click
runs something or opens the menu, the normal arrow for a plain walk, and
"not allowed" on your own cell with nothing to do) and, after the pointer
rests ~150 ms on a target, shows a tooltip: the title (`Fridge · kitchen`;
an entity's name; `Ground · Crackers, Water bottle` for a pile) and what a
click does (`Click: Open`, `Click: Go up`, `Click: 3 actions`, nothing for
a walk). It is the pure `hoverInfo(world, target)`, recomputed once per
frame at most and only when the target, the tick, `containerVersion` or
`tileVersion` changes. Hover is hidden while the menu is open, while
dragging and when the pointer leaves the canvas; `H` hides the tooltip
with the HUD.

**Clicks target what is drawn under the pointer.** Left click,
right-click, long-press and hover pick the object whose visible pixels are
under the pointer: the top half of a fridge is the fridge, a zombie's head
in front of a wall is the zombie (its cell), your own character is your
cell (as `E`). Shadows, glass and blocks faded in front of you are clicked
through; empty spots fall back to the ground cell. See
[iso.md](iso.md#picking).

Pack actions are not listed in the loot panel; item uses stay in the
inventory panel (`I` / `Tab`).

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

## Saving and loading

The browser keeps a **quicksave** and **three slots** per pack list in
`localStorage` (see [saves](saves.md)).

- **`F5`** quicksaves and **`F9`** quickloads. The page never reloads on
  `F5`, even with a modifier held.
- **`O`** (or the **Game [O]** button at the bottom centre) toggles the
  **Game panel**: the quicksave and each slot with `Day N, HH:MM`, the
  tick and when it was saved, and **Save**, **Load** (disabled when empty)
  and **Delete** buttons. **Export** downloads the running game as
  `isolandia-<packs>-day<N>.json`; **Import** loads such a file (or a bare
  save file). **Title screen** leaves for the [title screen](iso.md#title-screen)
  (plain navigation: unsaved progress is lost, as on reload).
- A load replaces the running world: the scene, HUD, panels and context
  menu are rebuilt and the camera recenters on the player. Errors (wrong
  packs, unknown ids…) are listed in the panel and the current game keeps
  running; warnings (e.g. a newer pack version) show in a dismissible note.
- Saving and loading work after defeat or victory; loading a save of a
  game in progress un-freezes it.
- A storage failure (full quota, private mode, blocked storage) shows a
  short message and never stops the game.

The panel's view is the pure function `gameView` in `src/web/saves.ts`;
storage goes through the small `SaveStore` interface (`localStorage` in
the browser, `MemoryStore` in tests).

## Keys

| Key | Action |
|---|---|
| Arrows, WASD, numpad | Move (screen-relative) |
| Click / tap | Safe default (open, climb, walk) or the menu |
| Shift + click | Walk there |
| Right-click / long-press | Menu (with *Walk here*) |
| `E` | Menu on your own cell |
| `1`–`9` (menu open) | Choose that menu row |
| Arrows / `Enter` / `Escape` (menu open) | Move, choose (or fold/unfold), close |
| `PageUp` / `<` | Go up the stairs you stand on (`world.climbIntent(1)`) |
| `PageDown` / `>` | Go down (`world.climbIntent(-1)`) |
| `I` / `Tab` | Inventory panel |
| `C` | Crafting panel |
| `O` | Game panel (save slots, export, import) |
| `F5` / `F9` | Quicksave / quickload |
| `H` | Toggle the HUD text (and hover tooltips) |
| `F3` | Toggle the perf line: tick ms (avg/p95 over the last 100 ticks), fps, active and dormant entities, built and visible chunks |
| `Space` | Recenter the camera |

The climb keys are matched by `KeyboardEvent.key`, so `<` and `>` follow
the keyboard layout; with no link at your cell they do nothing. On a map
with more than one floor the HUD shows `Floor N` (your floor `z`, the
ground floor being `Floor 0`).

In the terminal (`npm run play`), `S` saves to the `--save-file` and `L`
loads it; lowercase `s` and `l` still move. `<` / `>` climb (with no link
the message line says `No way up here.` / `No way down here.`), the `x`
list starts with *Go up* / *Go down* when you stand on a link, the map
shows your floor only (empty cells are spaces), and the status lines add
`Floor N` on multi-floor maps. While any NPC is dormant (beyond the active
radius, see `docs/packs.md#simulation`), the bottom line ends with
`active N, dormant M`.
