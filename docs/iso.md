# Isometric view

The browser build plays the same packs as the terminal, in isometric view
(PixiJS). The engine code is the same for every genre; only the packs
change.

## Running

```sh
npm run dev          # http://localhost:5173/  (the S0 spike is at /spike.html)
npm run build        # dist/index.html + dist/spike.html
npm run preview      # serve the build
npm run smoke        # Playwright: both genres, screenshots in docs/screens/
```

`npm run smoke` needs Chromium (set `BENCH_CHROMIUM` to a Chrome/Chromium
binary if Playwright's own download is unavailable, `SMOKE_HEADED=1` for a
visible window). It fails on console errors, a blank canvas or a load-error
screen.

### Query parameters

| Param            | Default       | Meaning |
|------------------|---------------|---------|
| `?packs=a,b,…`   | `std,std-needs,zombie` | Ordered pack directory names under `packs/` (same order rule as the CLI) |
| `?seed=N`        | `1`           | Integer world seed |

For example `?packs=std,vampire&seed=7`. When loading fails — including an
unknown pack name — the page shows the complete error list, formatted like
`npm run check`, instead of the game. The default list lives in
`index.html` (`data-default-packs`) so that `src/` stays genre-agnostic.

## Controls

| Input                          | Action |
|--------------------------------|--------|
| Click / tap a tile             | Walk there (A\* path). The target is outlined while the path is active; an unreachable tile flashes red |
| Arrows, WASD, numpad (held)    | Move in 8 directions, screen-relative (`W` = straight up on screen, `W`+`D` = up-right, i.e. map-north); unlike the terminal, which stays grid-aligned. Cancels any path |
| Drag (mouse or one finger)     | Pan; stops following the player |
| Wheel / pinch                  | Zoom around the cursor / pinch centre, 0.25×–3× |
| `Space`                        | Re-centre on the player and follow again |
| `H`                            | Toggle the HUD |
| `I` / `Tab`                    | Toggle the inventory panel (when the player has an inventory) |
| `PageUp` / `<`, `PageDown` / `>` | Climb the stairs or ladder you stand on, up or down a floor |

A drag never counts as a click (8 px threshold). The HUD shows the
in-game day and time (`Day 1 08:02`, from the pack's `clock`) and the
player's measurements, from the same `hudModel` as
the ASCII HUD, plus a `Status: …` line while the player has active
statuses. When the pack's `start.defeat` condition is met, the HUD adds the
defeat message and a centred banner covers the canvas; the camera still
pans and zooms, but movement input is ignored. `start.victory` works the
same way with its own, gold-on-green banner (`#victory`).

## Inventory and loot panels

Two DOM panels are built from the same `hudModel` (`src/web/panels.ts`;
the view functions are pure and unit-tested) and turn button clicks into
`world.queueAction`:

- the **inventory panel** (`I`/`Tab`) lists the player's stacks with the
  item's use button (its `use.label`) and *Drop*, plus `Carrying: w/cap`;
- the **loot panel** opens by itself whenever a container is within reach
  (the player's cell or the 8 around it). It lists each container's stacks
  with *Take* (one unit) and *Take all*, and a *Put* section to move
  inventory stacks into a reachable container. Pack
  [actions](packs.md#actions) are in the **context menu** (right-click,
  long-press or `E`; see [ui.md](ui.md)), which outlines its target cell
  while open;
- while the player is busy with a timed action or use, a **progress bar**
  (`#activity`) shows its progress text and percentage; moving or starting
  another action cancels it.

A map edit (`set_tile`, e.g. a barricaded window) bumps
`world.tileVersion`; the scene then rebuilds the render chunks with
changed cells (their ground and raised blocks).

Clicking a non-walkable container tile (a fridge) walks to the closest
tile next to it (`goto` with `adjacent: true`). After defeat or
victory the panels stay visible but read-only.

## Day/night tint

If a pack defines [`lighting`](packs.md#lighting), the ground and object
layers are multiplied by `tintAt(lighting, timeOfDay)` (Pixi `tint` on the
two containers, updated only when the colour changes). The time of day is
computed from `tick + alpha`, so the tint changes smoothly between ticks.
Path/target markers and the DOM HUD are not tinted. Without `lighting` the
scene is untinted. The colour logic lives in pure functions
(`src/core/lighting.ts`, `src/iso/tint.ts`).

## Projection

Classic **2:1 dimetric**, tile diamond **64×32 px** (`src/iso/projection.ts`):

```
iso.x = (x - y) * 32
iso.y = (x + y) * 16
screen = iso * zoom + offset
```

Maps exported for [Tiled](packs.md#tiled-maps) (`npm run map:export`)
are isometric with the same 64×32 tile diamond and axes, so Tiled shows a
map as the game does, minus the height of raised blocks.

World coordinates are continuous tile units; tile `(i, j)` covers
`[i, i+1)×[j, j+1)` and its diamond's top vertex is at `iso(i, j)`. Picking
inverts the projection and floors; a click on a raised block's top face
(drawn 32 px above its ground) picks the block.

- Flat tiles are drawn in a ground layer of 16×16-tile render chunks;
  chunks outside the viewport are hidden.
- Raised tiles, ground piles and entities share an object layer with one
  container per diagonal `x + y`. Inside a diagonal, objects sort by
  `x + y`, then `x`, then blocks, piles and entities in that order. Moving entities use their interpolated
  position and change container when their diagonal changes, so only the
  containers whose contents changed are re-sorted.
- The sim runs at 10 ticks/s from an accumulator (at most 5 ticks per
  frame; any further backlog is dropped); every animation frame renders with
  interpolation, so walking is smooth and has constant speed.

## Floors

On a map with stacked [floors](packs.md#floors) (`src/iso/scene.ts`,
rules in `src/iso/cutaway.ts`):

- **Height.** Floor `z` is drawn raised by `z × FLOOR_H` iso px, with
  `FLOOR_H = BLOCK_H` (32), so a floor sits on top of the walls below it.
  An entity's height is interpolated with its position, so climbing the
  stairs is smooth; the camera follows that height.
- **Draw order** is floor by floor: floor 0 ground, floor 0 markers,
  floor 0 objects, then floor 1, and so on. Each floor keeps its own
  per-diagonal depth buckets. Empty cells draw nothing, so the floors below
  and the outside show through.
- **Cutaway.** The **view floor** is the player's floor; while climbing,
  it switches at the step's midpoint. Floors **above** the view floor are
  hidden (their whole container: ground, blocks, piles, entities and
  markers), so you see inside buildings.
- **Fade.** On the view floor, a raised block fades to alpha 0.35 when it
  is in front of the player and close on screen: its diagonal `x + y` is
  in `(px + py, px + py + 3]` and `|(x − y) − (px − py)| ≤ 2`. This also
  applies on one-floor maps; with no raised blocks in front of the player
  the view is unchanged.
- **Picking.** A click picks on the view floor, with its offset (raised
  blocks by their top face, as above). When that cell is empty (or outside
  the map), the floors below are tried in order, so clicking the street
  from a balcony works. Clicks yield `{ x, y, z }`, and click-to-move
  issues a goto with that `z`.
- The HUD shows `Floor N` when the map has more than one floor.

## Lazy chunks and culling

The scene never builds the whole map (`src/iso/scene.ts`; the bookkeeping
is the Pixi-free `src/iso/chunks.ts`, tested headless):

- **Render chunks** are 16×16 cells of one floor. A chunk's ground
  container and raised blocks are built **the first time it is near the
  view**: visible (its iso bounds, grown for tall blocks, meet the view
  plus a 96 px margin), or one chunk away from a visible one on the same
  floor.
- Built chunks live in an **LRU**; past `MAX_BUILT_CHUNKS` (160) the least
  recently needed are **destroyed** (sprites and containers), never one
  needed this frame. Built chunks that leave the view are hidden.
- **Map edits** (`world.tileVersion`) rebuild only the built chunks whose
  cells changed; an unbuilt chunk is built from the live grid, so it picks
  up its edits when it is first built.
- **Culling.** Entity and ground-pile sprites exist only while their cell
  (an entity's interpolated position and floor) is in a **built, visible**
  chunk: they are created when they enter one and destroyed when they
  leave. A new sprite takes the entity's current facing and its depth
  bucket, so depth sorting and facing carry over.
- `scene.update()` returns stats: built, visible and total chunks, entities
  drawn on visible floors, and live sprites. The browser's F3 line shows
  them (see `docs/ui.md`).

## Sprites and placeholders

Tiles and archetypes may reference an asset (`sprite:`; see
[packs.md](packs.md#assets)). Tile sprites are anchored at the diamond's
bottom vertex, archetype sprites at the tile's ground centre. All assets
are loaded before the first frame; one that fails to load logs a warning
and falls back to its placeholder. SVG assets are rasterized at `MAX_ZOOM`
resolution, so pixel art stays sharp at every zoom (see [art.md](art.md)).

Without a sprite, a placeholder is generated lazily, at most once per
definition entry and facing, from its `color`:

- **flat tile** — a 64×32 diamond in the color;
- **raised tile** — a 32 px block: the top face in the color, the left and
  right faces darkened to 72 % and 55 %;
- a tile whose legend sets **`facing`** explicitly also gets a front-edge
  cue: a darker stripe along the diamond edge it faces (on the top face for
  raised blocks). Cells without an explicit `facing` look unchanged;
- **entity** — an upright rounded marker in the color with a drop shadow and
  the archetype's `glyph` drawn on it (dark or light text by luminance),
  plus a dark **wedge** on the shadow pointing in the entity's facing
  (screen direction; drawn over the body so `nw`/`n`/`w` stay visible);
- **ground pile** — a small sack in the colour of the pile's first item
  (or that item's `sprite`, anchored at the ground centre). Piles are
  tinted by day/night like other objects.

Colors are `#rrggbb` or the terminal color names (`bright_yellow`, …).

## Facing

Facings are named on the map compass (`n` = up-right on screen, `e` =
down-right, `se` = toward the camera…; the full table is in
[packs.md](packs.md#assets)).

- **Entities turn, then walk.** Facing is simulation state
  (`Entity.facing`, `s` at spawn, part of snapshots and hashes);
  `facingOf(entity)` (core, `sim/motion.ts`) just returns it. To step in a
  direction it is not facing, an entity first rotates one compass point
  (45°) toward it per `ticks_per_turn` ticks (archetype field, default 1),
  the short way round (clockwise on a reversal), and steps once it faces
  that way. The pending step or path waits meanwhile. A blocked step still
  turns the entity to face it; `ticks_per_turn: 0` turns and steps in the
  same tick. Each turning beat is a discrete sprite switch (no turn
  interpolation); an entity that stops keeps its last facing.
- **Browser keys: tap turns, hold walks.** A fresh movement key press
  queues a step with `turnInPlace: true`: the player turns toward it and
  stays put (or steps at once if already facing that way). Holding the key
  past `HOLD_MS` (200 ms, `src/web/keys.ts`) then walks as usual. Paths,
  click-to-move, NPCs and the terminal still turn and then walk.
- **Tiles** face their map cell's legend `facing` (default `s`); **ground
  piles** always face `s`.
- **Mirroring.** A directional asset's missing facing uses its mirror
  partner's image with `scale.x = −1`, which flips it around the anchor
  spot. The loader normalizes every asset to a list of distinct images
  plus a per-facing `{ image, mirrored }` table, so the renderer never
  re-derives it; each image is loaded once.
- **Snapping.** A diagonal facing shown with a 4-way asset snaps to one of
  its two neighbouring cardinals: the one this sprite showed last if it is
  one of them (so walking diagonally after a straight step does not flip),
  otherwise the clockwise one (`ne→e`, `se→s`, `sw→w`, `nw→n`). The
  last-shown facing is renderer state only (`resolveFacing` in
  `core/facing.ts` is the pure rule).
- The scene checks each visible entity's facing every frame but swaps the
  texture, anchor and mirroring only when the direction it shows changes.
  Depth sorting, culling and the day/night tint are unaffected.
