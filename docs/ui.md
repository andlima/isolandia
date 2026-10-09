# Browser UI

## Interaction

**Left click does the safe default.** A plain left click (or a tap) on an
object runs what is safe there, and opens the menu when the object has
actions that cost something. The rule is the pure function
`clickPlan(world, target)` in `src/web/menu.ts`, over
`world.interactionsAt(x, y, z)` for the target's cell:

- an enabled **Talk to …** (an NPC with a [dialogue](packs.md#dialogues)
  on the cell) always runs: clicking an NPC you can talk to walks up to it
  and talks (see [Dialogue box](#dialogue-box));
- otherwise the **safe** entry is the first enabled **Open**, else **Go up** /
  **Go down** when the cell has exactly one way, else **Walk here**;
- when the cell has no enabled tile action or recipe, the click **runs**
  the safe entry, exactly as choosing it in the menu would (walk up to a
  fridge and show its contents, climb the stairs, walk);
- when it has one (*Barricade* you can do now, *Cook* at a stove), a
  disabled *Talk to …* (an NPC that will not talk now), or has
  entries but nothing safe (only disabled actions, stairs that go both
  ways), the click opens the **menu**;
- a cell with nothing on it walks there, next to it when it cannot be
  entered, as before (a plain wall: see [Clicking walls](#clicking-walls)); on your own cell with nothing to do the
  click does nothing, and with only self actions (*Rest*) it opens the
  menu.

**Shift + click** always just walks there. **Right-click**, a
**long-press** and **`E`** always open the menu and never run the default.
On a touch screen a tap is a left click and a long-press opens the menu.

**The menu** is one model for both openings, `contextMenu(world, x, y, z,
opening)` (`src/web/menu-dom.ts` only renders it). Rows, in order:

1. the **default** (the safe entry, unless it is *Walk here*), with a
   `click` tag;
2. the other **enabled** entries in `interactionsAt` order: *Talk to …*
   per NPC with a dialogue on the cell, tile actions
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
from afar walks up to the container and then opens it in the
[transfer window](#transfer-window); *Take all* from afar takes the first
stack on arrival and opens the container in the transfer window for the
rest. Items are computed when the menu
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
click does (`Click: Open`, `Click: Go up`, `Click: Talk to Barkeep`,
`Click: 3 actions`, nothing for a walk). An NPC that will not talk now shows
its dialogue's `unavailable` text instead (`He ignores you`), and a click
opens the menu. An NPC of a [faction](packs.md#factions) adds the
faction and the player's tier with it after its name (`Officer · Police
(Wary)`, from `world.attitudeOf`); when the faction is hostile to the
player, that part shows in the danger colour. It is the pure
`hoverInfo(world, target)` (with `standing` and `hostile` for such an NPC;
`hoverTitleLine` builds the first line), recomputed once per frame at most
and only when the target, the tick, `containerVersion`, `tileVersion` or
`journalVersion` changes. Hover is hidden while the menu is open, while
dragging and when the pointer leaves the canvas; `H` hides the tooltip
with the HUD.

**Clicks target what is drawn under the pointer.** Left click,
right-click, long-press and hover pick the object whose visible pixels are
under the pointer: the top half of a fridge is the fridge, a zombie's head
in front of a wall is the zombie (its cell), your own character is your
cell (as `E`). Shadows, glass and blocks faded in front of you are clicked
through; empty spots fall back to the ground cell. See
[iso.md](iso.md#picking).

Pack actions are not listed in the transfer window; item uses are its
*Use* buttons (the item's `use.label`).

### Clicking walls

Walls, doors, windows and fences are [edges](packs.md#edge-walls), thin
slabs between two cells. In the iso view each slab is its own target
(`{ kind: 'edge', x, y, z, side }`): the edge on the `n` or `w` side of
cell `(x, y)`.

- **Hover** shows the edge tile's label (`Window`, `Barricaded window`)
  and what a click does.
- **The menu** for an edge lists the actions on it (*Barricade* on a
  window, *Close shutters* on a vampire window), with the same default, fold row
  and walk-then-act as a cell. It has no *Walk here*.
- **A plain left click on a wall** (an edge with nothing to do) walks next
  to it **on the clicked side**: the iso view shows an edge's south face
  (`n`) or east face (`w`), which belongs to cell `(x, y)`, so the walk
  ends there, or on the cell across the edge when `(x, y)` cannot be
  entered (`edgeWalkIntent`). **Shift + click** does the same.
- An edge action is in reach from either cell the edge separates, so you
  can barricade a window from inside or outside.
- An edge faded in front of you (the south and east sides of your cell
  and the walls just past them) is clicked through, like a faded block.

## HUD

The HUD is a styled overlay at the top left, drawn from the pure
`hudView(hudModel(world))` (`src/web/hud.ts`, a plain object with no DOM
types; the terminal prints `hudLines` of the same model):

- **Clock card**: `Day D · HH:MM`, a sun by day or a moon by night (from
  `world.is_day`, `hudModel(world).isDay`) and a `Floor N` chip on maps with
  more than one floor. The tick number shows only in the F3 perf line.
- **Measurement bars**, one per player measurement not hidden with
  [`hud.hide`](packs.md#measurements): label, a bar of the value's place in
  `[min, max]` and the value (`23/100`, or `23` without a finite max, which
  has no bar). The bar is **green** (`ok`), **amber** (`warn`) or **red**
  (`danger`) by the measurement's `hud` levels, and a neutral grey-blue for
  a measurement without `hud.bad`. A red row pulses gently (not under
  `prefers-reduced-motion`).
- **Status chips** under the bars, one per active player status in
  definition order: red for tone `bad`, green for `good`, grey for
  `neutral` (see [statuses](packs.md#statuses)). Hovering a chip with a
  mouse or pen, or tapping it, shows a tooltip with the label, the
  status's `hud.description` and its rates on your measurements now
  (`Health −0.2/s`).
- **Carrying bar** (when you have an inventory): `Carrying w/cap`, amber
  from 80 % of capacity and red when full.
- **Nearby**: the `Nearby: …` text as one muted line, cut with `…`.
- The **latest action** text (`Took 2 Canned beans`, `Too heavy`), for 3
  seconds.

The activity bar, the defeat and victory banners, journal toasts and the
perf line are separate elements and keep their places. The overlay is at
most 240 px wide with a translucent background and takes no pointer
events except on the chips. Below 560 px of viewport width it is compact:
the bars carry a 2–3 letter abbreviation of the label (`Hun`, `Thi`)
instead of the label, and the chips wrap. It re-renders only when the
view changes; values are rounded (bars in whole percent) so a drifting
measurement does not rebuild it every tick. `H` hides it with the hover
tooltips.

In the terminal the same levels colour the HUD lines: a measurement line
is yellow at `warn` and red at `danger`, and the `Status:` line is red
while any active status has tone `bad` (`hudLineLevels`).

## Time

The world runs at the pack's `ticks_per_second` (1×). The shell can
**pause** it and run it at **2×, 4× or 8×**: the simulation still steps one
fixed tick at a time, only more (or no) ticks are asked for per second of
wall time. Pause and speed belong to the shell (the pure `Pace` in
`src/core/pace.ts`, used by both shells): they are never saved or hashed,
the same inputs at the same ticks give the same world at any speed, and a
load keeps the current pause and speed.

- **`P`** or the **`Pause`** key toggles pause; **`+`** / **`=`** / numpad
  **`+`** go faster and **`-`** / numpad **`-`** slower (stopping at 8× and
  1×). They work with the transfer window, crafting panel, journal or Game
  panel open, but not while the context menu or the dialogue box has the
  keys (a conversation already pauses the world).
- **Clock card.** Under the clock, a **⏸ / ▶** button toggles pause and a
  **⏩ 1×** button cycles `1× → 2× → 4× → 8× → 1×`; both are real buttons
  (touch and keyboard). While paused the card shows **Paused** and the map is
  dimmed and desaturated (visual only). After defeat or victory it shows
  neither **Paused** nor a speed; the buttons still click but change nothing
  you can see, since the world no longer steps.
- **Speed.** At speed `s` the frame loop (`FixedTickLoop`) counts wall time
  `s` times over and runs at most `5 × s` ticks a frame; changing speed or
  unpausing never runs a burst of catch-up ticks. When the sim cannot keep
  up, it slows down instead of spiralling (`droppedMs`), as at 1×.
- **Auto-pause.** The Game panel's **Pause while windows are open**
  checkbox (default off, stored in `localStorage` under
  `isolandia:pause-while-windows`) pauses the world while the transfer
  window, crafting panel, journal or Game panel is open. It is separate
  from the manual pause: `P` always flips what the card shows, so pressing
  it during a window pause resumes, and closing the window then does not
  pause again; a manual pause stays when the window closes.

**While paused** clicks, Shift-clicks, the context menu, the transfer
window's buttons and Craft still queue intents and actions; they apply on
the first tick after unpausing. Movement keys are ignored (no steps or
turns), and a key held through the pause must be pressed again. Hover
tooltips, the camera (pan, zoom, `Space` recenter) and the panels work. The
latest-action line and the journal toast freeze with the world; wall-clock
notes (the save message) keep their time.

In the terminal, `p` toggles pause and `+` / `=` / `-` change speed; the
help line shows `PAUSED`, or the speed when not 1× (`4×`), before the
`active N, dormant M` status. Movement keys do nothing while paused.

## Transfer window

One window moves items between a container and your inventory: the
container on the left, what you carry on the right, each stack with its
icon (the item's `sprite` image, drawn pixel-crisp, or a swatch of its
`color` and `glyph`), label, count and weight.

- **Opening.** *Open* in the context menu (or a left click on a
  container, see above) opens the window on that container. Chosen from
  afar, it opens once you arrive. The window never opens by itself: the
  HUD's `Nearby:` line is the passive cue. **`I` / `Tab`** opens it with
  your inventory only, or switches an open window to inventory-only and
  back.
- **Moving.** Clicking a stack moves **all of it** to the other side (as
  many units as fit); **Shift + click** moves **one**. Rows are buttons:
  `Enter` on a focused row moves the stack, `Shift + Enter` one unit.
  **Take all** and **Put all** sit above each pane. A move that fails
  (`Too heavy`, …) shows the message under the weight bar for a few
  seconds, as well as on the HUD. Inventory rows have small **Use** and
  **Drop** buttons that do not move the row; in inventory-only mode
  clicking a row does nothing, its buttons still work.
- **Tabs.** Every reachable container has a tab (tile containers and
  ground piles, the pile on your own cell included), with its load and
  capacity. Clicking a tab shows that container. Dropping an item while
  the window is open makes the ground pile appear as a tab. When the shown
  container leaves reach (you walked away, the pile emptied), the next
  tab is selected; with none left the window goes back to inventory-only
  if `I` opened it, and closes otherwise.
- **Closing.** `Escape`, the **×** button, or opening the crafting or
  Game panel closes it.
- **Layout.** The window sits at the bottom right and stays below the
  middle of the screen, so it never covers your character at the default
  zoom. The two panes scroll on their own; on screens narrower than
  560 px they stack, container on top. After defeat or victory everything
  is disabled.

The view is the pure function `transferView(world, openContainer,
readOnly, icons)` in `src/web/transfer.ts` (tabs, the selected
container's stacks, the inventory with `Carrying: w/cap` and a fill
fraction, and *Take all* / *Put all*); `src/web/transfer-dom.ts` renders
it, re-rendering only when the view's JSON changes. Icon URLs come from
the same pack asset URLs the renderer loads (`itemIconUrls`).

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

## Dialogue box

Talking to an NPC (a click on it, *Talk to …* in its menu, or walking up
first when it is out of reach) opens a [conversation](packs.md#dialogues)
and **pauses the world**. A box at the bottom of the screen shows the
speaker's name, the line, and the visible answers numbered `1`–`9`.
Disabled answers are greyed out with the reason underneath (`Needs: 2×
Coin`, or the choice's `unavailable` text).

- `1`–`9`, a click or a tap choose an answer;
- the arrow keys move over the enabled answers and `Enter` chooses the
  selected one; with nothing selected, `Enter` picks the only enabled
  answer (when there is exactly one);
- `Escape` leaves the conversation. At a node that cannot be left
  (`leave: false`) the box shakes briefly and says `You can't walk away
  now.`

While the box is open, map clicks, movement keys, the context menu and the
transfer window (`I`, `Tab`) are off, and hover tooltips are hidden. The
journal (`J`) and the Game panel (`O`, `F5`, `F9`) still open on top. A
choice that adds a journal entry or moves a quest shows its toast at once.

The box is the pure `dialogueBox(world.conversationView())` and
`dialogueKey(box, selected, code)` (`src/web/dialogue.ts`); the DOM layer
(`dialogue-dom.ts`) re-renders when `world.conversationVersion` changes.

In the terminal, `x` lists *Talk to …* for each NPC in reach. While a
conversation is open, the screen shows the speaker, the line and the
numbered answers (disabled ones with their hint in brackets) under the
map: digits choose, `Escape` leaves (or says `You can't walk away now.`),
and movement keys do nothing.

## Journal

`J` or the **Journal [J]** button (top right; shown when the packs define
quests, journal entries or factions that are not hidden) toggles the
**Journal** panel. It shows:

- **Active**: each started quest's title and its current stage's text;
- **Done**: ended quests, marked ✓ (success) or ✗ (failure), with their
  last stage's text;
- one section per entry `category`, in order of first use, listing that
  category's entries in the order added;
- **Standing**: each [faction](packs.md#factions) that is not hidden, in
  definition order: its label, the player's tier and standing (`Police:
  Wary (-22)`, rounded) and a small bar from -100 to 100 with a mark at 0
  (`standingRows` in `src/core/journal.ts`).

Hidden quests appear only once they end. The panel is the pure
`journalView(world)` (`src/web/panels.ts`, over `world.journal()` and the
shared `journalSections`), re-rendered only when `world.journalVersion`
changes. It has no buttons, so it stays as it is after defeat or victory.

**Toasts.** When a tick changes a quest's stage or adds an entry, the HUD
shows `Journal: <quest title>: <stage text>` or `Journal: <entry text>` for
about 4 s, under the top edge. Several events in one tick show the last
one plus `(+N)`; the text is one line, cut with `…`. It is the pure
`journalToast(events, world)` (`src/core/journal.ts`), read from
`world.journalEvents` right after each step. A hidden quest's stages make
no toast until it ends. A standing that moves into another tier toasts
`<Label>: <from> → <to>` (`Police: Neutral → Wary`, `standingToast`);
hidden factions never toast.

The terminal has the same journal: `J` (uppercase; lowercase `j` still
moves) shows it as text in the same layout until any key, with the
standing lines (`Police: Wary (-22)`) last, and a stage change, entry or
tier change puts the same toast text on the message line.

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
| Click / tap | Talk to an NPC, the safe default (open, climb, walk), or the menu |
| Shift + click | Walk there |
| Right-click / long-press | Menu (with *Walk here*) |
| `E` | Menu on your own cell |
| `1`–`9` (menu open) | Choose that menu row |
| Arrows / `Enter` / `Escape` (menu open) | Move, choose (or fold/unfold), close |
| `1`–`9` / click (dialogue box open) | Choose that answer |
| Arrows / `Enter` / `Escape` (dialogue box open) | Move, choose (or the only enabled answer), leave |
| `PageUp` / `<` | Go up the stairs you stand on (`world.climbIntent(1)`) |
| `PageDown` / `>` | Go down (`world.climbIntent(-1)`) |
| `I` / `Tab` | Transfer window, inventory only (again: back to the container, or close) |
| `Escape` | Close the transfer window (or the menu, when open) |
| Click / Shift + click a stack (window open) | Move the whole stack / one unit |
| `C` | Crafting panel |
| `J` | [Journal](#journal) panel |
| `O` | Game panel (save slots, export, import) |
| `F5` / `F9` | Quicksave / quickload |
| `H` | Toggle the HUD (and hover tooltips) |
| `F3` | Toggle the perf line: tick ms (avg/p95 over the last 100 ticks), fps, active and dormant entities, built and visible chunks |
| `Space` | Recenter the camera |
| `P` / `Pause` | Pause or resume ([Time](#time)) |
| `+` / `=` / numpad `+` | Faster (2×, 4×, 8×) |
| `-` / numpad `-` | Slower (down to 1×) |

The climb keys are matched by `KeyboardEvent.key`, so `<` and `>` follow
the keyboard layout; with no link at your cell they do nothing. On a map
with more than one floor the HUD shows `Floor N` (your floor `z`, the
ground floor being `Floor 0`).

In the terminal (`npm run play`), `S` saves to the `--save-file` and `L`
loads it, `p` pauses and `+` / `=` / `-` change the speed, and `J` shows the journal; lowercase `s`, `l` and `j` still move. `<` / `>` climb (with no link
the message line says `No way up here.` / `No way down here.`), the `x`
list starts with *Go up* / *Go down* when you stand on a link, the map
shows your floor only (empty cells are spaces), and the status lines add
`Floor N` on multi-floor maps. While any NPC is dormant (beyond the active
radius, see `docs/packs.md#simulation`), the bottom line ends with
`active N, dormant M`.
