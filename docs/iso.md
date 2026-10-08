# Isometric view

The browser build plays the same packs as the terminal, in isometric view
(PixiJS). The engine code is the same for every genre; only the packs
change.

## Running

```sh
npm run dev          # http://localhost:5173/  (the S0 spike is at /spike.html)
npm run build        # dist/index.html + dist/spike.html
npm run preview      # serve the build
npm run smoke        # Playwright: each game and the title screen, screenshots in docs/screens/
```

`npm run smoke` needs Chromium (set `BENCH_CHROMIUM` to a Chrome/Chromium
binary if Playwright's own download is unavailable, `SMOKE_HEADED=1` for a
visible window). It fails on console errors, a blank canvas or a load-error
screen.

### Query parameters

| Param            | Default       | Meaning |
|------------------|---------------|---------|
| `?packs=a,b,…`   | none: the title screen | Packs to play: directory names under `packs/` or namespaces. Dependencies are added and ordered by the [stack resolver](packs.md#stacks), as on the command line |
| `?seed=N`        | `1`           | Integer world seed |

For example `?packs=town`, `?packs=vampire&seed=7`, or
`?packs=zombie,hardship` for the town with two mods
(`?packs=std,std-needs,town,zombie,hardship` still works and loads the
same stack). When loading fails — including an unknown pack name or a
resolver error — the page shows the complete error list, formatted like
`npm run check`, instead of the game, with a **Back to the title screen**
link.

Saves, exports and imports are keyed on the **resolved** pack directory
list, so `?packs=zombie` and `?packs=std,std-needs,town,zombie` share the same
slots (and slots saved under the full list before stacks existed stay
reachable).

### Title screen

Without a `packs` parameter, the page shows a **title screen** instead of
a game. It is built from the bundled catalog (every `packs/<dir>/pack.yaml`
in the Vite glob), so `src/` stays genre-agnostic.

- It lists every pack of [kind](packs.md#manifest-packyaml) `game`, then
  every `mod`, with its `name`, `description` and resolved stack. A pack
  whose stack does not resolve is disabled with the reason.
- Choosing one shows **checkboxes for the other mods**. A mod can be
  checked only if the chosen pack plus the checked mods plus it still
  resolve; otherwise it is disabled with the reason (a mod already in the
  stack is disabled too). Checked mods are appended in click order, which
  decides the load order between unrelated mods.
- **Play** navigates to `?packs=<chosen>,<checked…>&seed=<seed>`; the seed
  field defaults to 1.

The screen is a thin DOM layer (`src/web/picker-dom.ts`) over the pure
`pickerModel(catalog, chosen, checked, seed)` in `src/web/picker.ts`.
The in-game Game panel's **Title screen** button returns here (plain
navigation: unsaved progress is lost, as on reload).

## Controls

| Input                          | Action |
|--------------------------------|--------|
| Click / tap a tile             | Walk there (A\* path). The target is outlined while the path is active; an unreachable tile flashes red |
| Arrows, WASD, numpad (held)    | Move in 8 directions, screen-relative (`W` = straight up on screen, `W`+`D` = up-right, i.e. map-north); unlike the terminal, which stays grid-aligned. Cancels any path |
| Drag (mouse or one finger)     | Pan; stops following the player |
| Wheel / pinch                  | Zoom around the cursor / pinch centre, 0.25×–3× |
| `Space`                        | Re-centre on the player and follow again |
| `H`                            | Toggle the HUD |
| `I` / `Tab`                    | Toggle the [transfer window](ui.md#transfer-window) in inventory-only mode (when the player has an inventory) |
| `PageUp` / `<`, `PageDown` / `>` | Climb the stairs or ladder you stand on, up or down a floor |

A drag never counts as a click (8 px threshold). The HUD shows the
in-game day and time (`Day 1 08:02`, from the pack's `clock`) and the
player's measurements, from the same `hudModel` as
the ASCII HUD, plus a `Status: …` line while the player has active
statuses. When the pack's `start.defeat` condition is met, the HUD adds the
defeat message and a centred banner covers the canvas; the camera still
pans and zooms, but movement input is ignored. `start.victory` works the
same way with its own, gold-on-green banner (`#victory`).

## Transfer window

The DOM panels are built from the same `hudModel` (the view functions are
pure and unit-tested) and turn button clicks into `world.queueAction`:

- the **transfer window** (`src/web/transfer.ts`, see
  [ui.md](ui.md#transfer-window)) shows a reachable container (the
  player's cell or the 8 around it) next to the inventory: clicking a
  stack moves all of it, Shift-click one unit. It opens on a container
  from the context menu's *Open* (or a left click), never by itself, and
  `I`/`Tab` opens it with the inventory only (use buttons and *Drop*). Pack
  [actions](packs.md#actions) are in the **context menu** (right-click,
  long-press or `E`; see [ui.md](ui.md)), which outlines its target cell
  while open;
- while the player is busy with a timed action or use, a **progress bar**
  (`#activity`) shows its progress text and percentage; moving or starting
  another action cancels it.

A map edit (`set_tile`, e.g. a barricaded window) bumps
`world.tileVersion`; the scene then rebuilds the render chunks with
changed cells or edges (their ground, raised blocks and edge slabs).

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
map as the game does, minus the height of raised blocks (edge layers show
their tile on the cell, see [Tiled maps](packs.md#tiled-maps)).

World coordinates are continuous tile units; tile `(i, j)` covers
`[i, i+1)×[j, j+1)` and its diamond's top vertex is at `iso(i, j)`. Picking
targets what is drawn under the pointer (see [Picking](#picking)); its
ground fallback inverts the projection and floors, and a click on a raised
block's top face (drawn 32 px above its ground) picks the block.

- Flat tiles are drawn in a ground layer of 16×16-tile render chunks;
  chunks outside the viewport are hidden.
- Edge slabs, raised tiles, ground piles and entities share an object
  layer with one container per diagonal `x + y`. Inside a diagonal,
  objects sort by `x + y`, then `x`, then edges, blocks, piles and
  entities in that order (`src/iso/depth.ts`). Moving entities use their interpolated
  position and change container when their diagonal changes, so only the
  containers whose contents changed are re-sorted.

## Edges

[Edge tiles](packs.md#edge-walls) (walls, doors, windows, fences) are drawn
as **thin wall slabs** on the sides of a cell's diamond, not as blocks:

- **Where.** With the projection above, the `n` edge of `(x, y)` runs from
  `iso(x, y)` to `iso(x + 1, y)`, the diamond's top-right side; the `w`
  edge from `iso(x, y)` to `iso(x, y + 1)`, its top-left side. Both
  sprites are anchored on the top vertex `iso(x, y)` (`edgeAnchorIso`).
- **One image, mirrored.** The two sides are horizontal mirrors of each
  other, so a single-image asset is drawn as is for `n` and mirrored
  (`scale.x = −1` around the anchor) for `w` (`TextureBank.edge`). A
  directional asset uses its own `n` and `w` images (or their mirrored
  partners). See [art.md](art.md#edge-images) for the image size and
  anchor.
- **Placeholder.** An edge tile without a sprite gets a procedural slab in
  its colour: wall height (`BLOCK_H`), 1/8 of a tile thick, its front face
  darkened to 72 % and its end to 55 %, like a block.
- **Joints.** A slab runs 1/16 of a tile past both vertices, so slabs
  meeting at a vertex (a corner or a T) overlap into a small corner post
  instead of leaving a gap.
- **Depth.** An edge is keyed by the cell it belongs to with the `Edge`
  layer, below blocks, piles and entities. So the `n` edge of `(x, y)`
  draws in front of everything in `(x, y − 1)` (an earlier diagonal) and
  behind everything in `(x, y)`, and the `w` edge likewise with
  `(x − 1, y)`: an entity standing in a doorway or beside a wall is never
  drawn behind the wrong slab.
- **Chunks.** A render chunk builds the edges of its cells with its
  blocks, hides them with it, and a `set_tile` on an edge rebuilds that
  chunk.
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
  markers), so you see inside buildings. Their edges go with them.
- **Fade.** On the view floor, a raised block fades to alpha 0.35 when it
  is in front of the player and close on screen: its diagonal `x + y` is
  in `(px + py, px + py + 3]` and `|(x − y) − (px − py)| ≤ 2`. Edges fade
  by the same rule applied to the cell they belong to: the `n` and `w`
  edges of a fading cell fade. So the south side of the player's cell (the
  `n` edge of the cell below it) and its east side (the `w` edge of the
  cell to its right) count as in front, and its own `n` and `w` do not.
  This also applies on one-floor maps; with nothing raised in front of the
  player the view is unchanged.
- **Picking.** A click picks what is drawn under it (see
  [Picking](#picking)); its ground fallback picks on the view floor, with
  its offset (raised blocks by their top face, as above). When that cell
  is empty (or outside the map), the floors below are tried in order, so
  clicking the street from a balcony works. Clicks yield `{ x, y, z }`,
  and click-to-move issues a goto with that `z`.
- The HUD shows `Floor N` when the map has more than one floor.

## Picking

Left click, right-click and long-press target the **object drawn under
the pointer**, not the floor diamond under it (`scene.pickTarget(sx, sy)`;
the pure logic is `src/iso/hit.ts` and `src/iso/pick.ts`, tested headless).

- **Hit masks.** Every texture drawn for a tile, archetype or item gets a
  mask of its opaque pixels (alpha ≥ 0.5), read back from the texture's
  pixels on its art-pixel grid (2×2 iso px for SVG art and placeholders,
  one pixel for PNGs). Asset masks are built when the `TextureBank` is
  created (`textures.maskMs` times it); placeholder masks when the
  placeholder is first baked. Drop shadows and glass are not hits. A
  mirrored facing reads its partner's mask right to left, around the
  anchor spot.
- **Frontmost sprite.** Floors are tried from the view floor down; floors
  above it are cut away and never hit. On each floor, the edge slabs,
  raised blocks, ground piles and entities actually drawn (built, visible chunks; piles
  and entities at their rendered position) are candidates, and the one
  drawn last (diagonal, then `depthKey`) whose mask contains the point
  wins. Blocks and edges are searched only in the cells whose sprite can
  reach the point.
- **Cutaway click-through.** Blocks and edges faded in front of the player
  are skipped (a block's top face included), so a click reaches the room
  behind them.
- **Ground fallback.** When no sprite on a floor is hit, the floor's
  ground pick is used if that cell is filled (a floor covers everything
  below it); otherwise the next floor down is tried, and if every floor
  misses, the view floor's pick. Without sprite hits this is `pickCell`.
- A target is `{ kind: 'ground' | 'tile' | 'pile' | 'entity', x, y, z }`
  (plus the pile's container or the entity), or
  `{ kind: 'edge', x, y, z, side }` for a slab: the edge on `side` (`n` or
  `w`) of cell `(x, y)`. Callers use its cell; an entity's cell is its
  simulation cell, and the player's own sprite gives the player's cell.
  Hovering an edge shows its tile's label, and its context menu lists the
  edge's actions (barricade, shutter; see [ui.md](ui.md#clicking-walls)).

## Lazy chunks and culling

The scene never builds the whole map (`src/iso/scene.ts`; the bookkeeping
is the Pixi-free `src/iso/chunks.ts`, tested headless):

- **Render chunks** are 16×16 cells of one floor. A chunk's ground
  container, raised blocks and edges are built **the first time it is near the
  view**: visible (its iso bounds, grown for tall blocks, meet the view
  plus a 96 px margin), or one chunk away from a visible one on the same
  floor.
- Built chunks live in an **LRU**; past `MAX_BUILT_CHUNKS` (160) the least
  recently needed are **destroyed** (sprites and containers), never one
  needed this frame. Built chunks that leave the view are hidden.
- **Map edits** (`world.tileVersion`) rebuild only the built chunks whose
  cells or edges changed; an unbuilt chunk is built from the live grid, so it picks
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
bottom vertex (edge sprites at its top vertex), archetype sprites at the
tile's ground centre. All assets
are loaded before the first frame; one that fails to load logs a warning
and falls back to its placeholder. SVG assets are rasterized at `MAX_ZOOM`
resolution, so pixel art stays sharp at every zoom (see [art.md](art.md)).

Without a sprite, a placeholder is generated lazily, at most once per
definition entry and facing, from its `color`:

- **flat tile** — a 64×32 diamond in the color;
- **raised tile** — a 32 px block: the top face in the color, the left and
  right faces darkened to 72 % and 55 %;
- **edge tile** — a thin slab on the cell's side, shaded the same way (see
  [Edges](#edges));
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
