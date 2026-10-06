# Packs

A **pack** is a directory of YAML files that defines game content. The
engine has no genre knowledge: the zombie, vampire and garden mini-games
under `packs/` are pure data on top of the same code.

```sh
npm run packs                       # list the packs under packs/
npm run check -- zombie             # validate only (adds std, std-needs)
npm run play  -- zombie             # play in the terminal
npm run play  -- vampire --seed 7
npm run play  -- garden
npm run play  -- zombie hardmode    # a game plus a mod
```

`check` also accepts a *library* stack with no `start` (e.g.
`npm run check -- std std-needs`): it validates the content and
reports it as not playable on its own. `play` still requires a `start`.

Name only the packs you want: the engine adds their dependencies and
orders the [stack](#stacks). Keys: arrows / WASD / numpad /
`hjklyubn` move (8 directions), `q` quits. When the player has an
inventory, `g` takes everything that fits from every reachable container,
`1`–`9` use inventory stack N and `d` followed by `1`–`9` drops stack N (so
digits and `d` no longer move; arrows, `hjklyubn`, `w`/`a`/`s` and the
numpad with NumLock off still do). `x` opens a numbered list of the pack
[actions](#actions) that can be started here, and `c` a numbered list of
the [recipes](#recipes) that can be made now (when there are none it shows
`Nothing to craft` and up to three recipes with what they need); `1`–`9`
start one and any other key closes the list. Moving cancels whatever the
player is doing. The
same packs run in the browser in isometric view: see [iso.md](iso.md).

Diagonal moves never cut corners: a diagonal step needs the target and
both orthogonal neighbours to be walkable (keyboard and click-to-move
alike).

## Layout

```
packs/zombie/
  pack.yaml            # manifest (required)
  archetypes.yaml      # any other *.yaml / *.yml file, at any depth
  assets.yaml
  assets/car_s.svg     # images referenced by the `assets` domain
  maps/city.yaml       # part maps ({ id: house_a, tiled: maps/parts/house_a.tmj }) and the composite city
  maps/parts/house_a.tmj  # Tiled map + tileset (read only when a map references them)
  maps/parts/house_a.tsj
  start.yaml
  clock.yaml
  survival.yaml        # statuses and systems
  items.yaml
  loot.yaml            # loot tables and distributions
  actions.yaml
  recipes.yaml
  lighting.yaml
```

File names and layout are free. The loader reads a pack's **text files**:
`*.yaml`/`*.yml` content files and Tiled `*.tmj`/`*.tsj` files. Only YAML
files are domain files; a Tiled file is read only when a [map](#tiled-maps)
references it (unreferenced ones are ignored). Each content file holds one or more
top-level **domain keys**; entries from all files of a pack are merged per
domain. Any other top-level key is a load error.

| Domain key     | Shape           |
|----------------|-----------------|
| `measurements` | list of entries |
| `assets`       | list of entries |
| `tiles`        | list of entries |
| `archetypes`   | list of entries |
| `maps`         | list of entries |
| `systems`      | list of entries |
| `statuses`     | list of entries |
| `items`        | list of entries |
| `loot`         | list of entries |
| `behaviors`    | list of entries |
| `actions`      | list of entries |
| `recipes`      | list of entries |
| `distributions`| list (no ids)   |
| `start`        | one mapping     |
| `clock`        | one mapping     |
| `lighting`     | one mapping     |

## Manifest: `pack.yaml`

```yaml
namespace: zmb          # required, [a-z][a-z0-9_]*
name: Zombie Town       # required
version: 0.1.0          # required
depends: [std, std_needs]  # optional; each loads before this pack
kind: game              # optional: game | mod | library (default: library)
description: Scavenge a 256×256 town while the dead close in.  # optional
```

`kind` tells tools and the browser's title screen what the pack is. The
loader checks it against the whole stack:

| Kind      | Meaning | Check |
|-----------|---------|-------|
| `game`    | A playable game | The pack itself defines a base `start` (not an `override: true` one) |
| `mod`     | Changes other packs ([overrides](#mods-and-overrides)) | Lists at least one `depends` |
| `library` | Shared content (the [stdpack](#standard-packs)) | None |

Any other `kind` is an error with a suggestion; `description` must be a
string. Both end up in `Definition.packs` (`PackInfo.kind`,
`PackInfo.description`). The shipped `std` and `std-needs` are libraries;
`zombie`, `vampire` and `garden` are games.

## Stacks

A playable game is a **stack** of packs: stdpacks, a game, and maybe
mods. `play`, `check`, `npm run packs -- --stack` and the browser's
`?packs=` take the packs you **want**; the resolver (`resolveStack` in
`src/core/load/stack.ts`) returns every requested pack plus the
transitive closure of their `depends`, each once.

- **Tokens.** A token is a pack's **directory name** or its
  **namespace**: `std-needs` and `std_needs` both work. On the command
  line, a token with a path separator (`packs/zombie`, `../mods/hard`) is
  a pack **directory**. An unknown token is an error with a *did you
  mean* suggestion and the list of available packs.
- **Order.** Dependencies always load before their dependents. Otherwise
  the request order is kept: a depth-first walk over the tokens in order,
  visiting each pack's `depends` in listed order and emitting a pack after
  its dependencies. So:
  - a list that already has its dependencies first (`std std-needs
    zombie`) resolves to exactly that order;
  - `zombie` resolves to `std, std_needs, zmb`;
  - `zombie hardmode` puts `hardmode` after `zmb` and everything it
    needs;
  - between **unrelated** mods, the request order decides which loads
    later, and so which wins an [override](#mods-and-overrides)
    conflict.
- **Errors.** A dependency cycle names it (`a → b → a`); a `depends` on a
  namespace that no pack has names the pack that declares it. Duplicate
  tokens collapse to the first occurrence.

**Catalog.** The resolver works over a catalog of manifests
(`buildCatalog`): on the command line, every directory directly under
`packs/` (relative to the current directory) that has a `pack.yaml`, plus
any explicit directory argument outside it; `--packs-dir <dir>` replaces
`packs/`. Two directories with the same namespace, or a malformed
manifest, are catalog errors; `play` and `check` print them like load
errors and exit non-zero. When the resolved stack differs from the
arguments, both print it on one line to stderr:

```sh
$ npm run check -- zombie
stack: std, std_needs, zmb
OK: std@0.1.0, std_needs@0.1.0, zmb@0.1.0 — …
```

**`npm run packs`** lists the catalog: directory, namespace, version,
kind, depends and description, games first, then mods, then libraries,
each sorted by directory. `npm run packs -- --stack zombie hardmode`
prints the resolved stack instead, in load order. It also takes
`--packs-dir`.

## Domains

### `measurements`

Generic numeric values (health, hunger, blood, suspicion…).

| Field     | Type                                  | Default    | Notes |
|-----------|---------------------------------------|------------|-------|
| `id`      | id                                    | required   | |
| `label`   | string                                | required   | Shown in the HUD |
| `min`     | number                                | `0`        | |
| `max`     | number, measurement id, or expression | unbounded  | Evaluated per entity |
| `initial` | number                                | required   | Default starting value |
| `rate`    | number or expression                  | none       | Drift **per second** |

Each tick (10 ticks/s) every entity gets `rate / 10` added to each of its
measurements; then all values are clamped to `[min, max]`. A numeric
`rate` costs nothing per tick beyond the addition. When `max` is a bare
measurement id it means *this entity's value of that measurement*
(`max: max_hp`); otherwise it is an [expression](expressions.md):

```yaml
measurements:
  - id: blood
    label: Blood
    max: "max(10, self.std:hp / 2)"
    initial: 50
    rate: -0.8
```

### `assets`

Images used by the isometric renderer: a single image, or one image per
direction (no spritesheets or animation yet). Asset ids are namespaced and
referenced like any other id. For the conventions the shipped art follows,
see [art.md](art.md).

| Field        | Type                 | Default    | Notes |
|--------------|----------------------|------------|-------|
| `id`         | id                   | required   | |
| `file`       | path                 | —          | Relative to the pack root; must exist in the pack and end in `.svg` or `.png` |
| `directions` | facing → path or `{ file, anchor? }` | — | One image per drawn facing (see below) |
| `anchor`     | `[ax, ay]`           | `[0.5, 1]` | Normalized image point (each in `[0, 1]`) placed on the entry's anchor spot; shared by every direction |

An asset has **either** `file` **or** `directions` (both, or neither, is a
load error).

**Anchor conventions** (on the 64×32 tile diamond, see [iso.md](iso.md)):

- a **tile** sprite's anchor goes on the **bottom vertex** of the tile's
  diamond — with the default `[0.5, 1]`, a 64×32 image covers a flat tile
  exactly and a 64×64 image is a block rising 32 px above it;
- an **archetype** sprite's anchor goes on the tile's **ground centre** —
  with `[0.5, 1]` a character stands on the bottom edge of its image; use
  e.g. `[0.5, 0.92]` to put the feet a little higher (on a drop shadow).

**Facings.** Directions are named on the map compass (maps are drawn
north-up; `x` grows east, `y` grows south). On screen:

| Facing | Map step `(dx, dy)` | Screen direction | Mirror partner |
|--------|---------------------|------------------|----------------|
| `n`    | `( 0, −1)`          | up-right         | `w`            |
| `ne`   | `( 1, −1)`          | right            | `sw`           |
| `e`    | `( 1,  0)`          | down-right       | `s`            |
| `se`   | `( 1,  1)`          | down (toward the camera) | itself |
| `s`    | `( 0,  1)`          | down-left        | `e`            |
| `sw`   | `(−1,  1)`          | left             | `ne`           |
| `w`    | `(−1,  0)`          | up-left          | `n`            |
| `nw`   | `(−1, −1)`          | up (away from the camera) | itself |

The 4-way set is `n`, `e`, `s`, `w` (the four faces of the tile diamond);
the default facing is `s`.

**Directional assets.** `directions` maps facings to images. A value is a
path, or `{ file, anchor? }` whose `anchor` overrides the entry's. Every
file follows the `file` rules.

- If any diagonal (`ne`, `se`, `sw`, `nw`) is listed the asset is
  **8-way**, otherwise **4-way**.
- A missing facing uses its **mirror partner**'s image, flipped
  horizontally around the anchor spot; a listed facing is never mirrored.
  So the set must be complete under mirroring: a 4-way asset needs one of
  `n`/`w` and one of `e`/`s` (2 drawings); an 8-way asset also needs `se`,
  `nw` and one of `ne`/`sw` (5 drawings). Otherwise the load error names
  the facings that cannot be produced.
- Unknown keys and an empty mapping are load errors.

Which facing is shown depends on what references the asset: **tiles** use
their map cell's legend [`facing`](#maps) (so an 8-way asset on a tile only
shows `n`/`e`/`s`/`w`), **archetypes** face their movement direction, and
**ground piles** always show `s`. A 4-way asset showing a diagonal facing
snaps to a neighbouring cardinal (see [iso.md](iso.md#facing)).

```yaml
# packs/zombie/assets.yaml
assets:
  - id: car_img                # 4-way: n and e are mirrors of w and s
    directions:
      s: assets/car_s.svg      # 64×64 block
      w: assets/car_w.svg
  - id: shambler_img           # 8-way: n, e and sw are mirrored
    anchor: [0.5, 0.92]        # shared by every direction
    directions:
      s:  assets/shambler_s.svg
      se: assets/shambler_se.svg
      ne: assets/shambler_ne.svg
      w:  assets/shambler_w.svg
      nw: { file: assets/shambler_nw.svg, anchor: [0.5, 0.92] }

# packs/zombie/tiles.yaml
tiles:
  - { id: car, label: Wrecked car, glyph: "&", color: "#a33a2a", walkable: false, sprite: car_img }
```

Entries without a `sprite` get a placeholder generated from their `color`.
The ASCII renderer ignores sprites. The art of the shipped packs is pixel
art on a 2 px grid; [art.md](art.md) is its style guide (sizes, anchors,
shading, palettes and the generator).

### `tiles`

| Field      | Type             | Default      | Notes |
|------------|------------------|--------------|-------|
| `id`       | id               |              | |
| `label`    | string           |              | |
| `glyph`    | single character |              | ASCII renderer |
| `color`    | `#rrggbb` or name|              | e.g. `"#8a8a8a"`, `white`, `bright_yellow`; also the placeholder color |
| `walkable` | boolean          |              | |
| `raised`   | boolean          | `!walkable`  | Iso rendering only: a raised block, depth-sorted with entities, instead of flat ground. Walkability is unchanged |
| `opaque`   | boolean          | `!walkable`  | Blocks line of sight (`can_see`). Like `raised`, it defaults from `walkable` and an explicit value wins: a window is `walkable: false, opaque: false` |
| `sprite`   | asset id         | placeholder  | Anchored at the diamond's bottom vertex |
| `tags`     | list of `[a-z][a-z0-9_]*` | `[]` | Tested by `tile.has_tag("x")` / `has_tag(tile, "x")` |
| `container`| `{ capacity: <number ≥ 0> }` | none | Every map cell with this tile gets its own [container](#containers); its label is the tile's label |
| `climb`    | `up` or `down`   | none         | A **link** to the same cell one floor up or down (stairs, ladders); see [Floors](#floors). The tile must be walkable |

Tile tags and archetype tags are separate: `self.has_tag("water")` never
sees the tags of the tile the entity stands on, and `tile.has_tag(...)`
never sees the entity's.

```yaml
tiles:
  - { id: tap, label: Water tap, glyph: "~", color: "#3b8eea", walkable: true, tags: [water] }
  - { id: fridge, label: Fridge, glyph: F, color: "#e8e8f0", walkable: false, container: { capacity: 25 } }
  - { id: crate, label: Crate, glyph: x, color: "#b08850", walkable: true, container: { capacity: 40 } }
```

Tile containers may be walkable (a floor crate you stand on) or not (a
fridge you walk up to).

### `archetypes`

Templates for entities (the player and everything else).

| Field            | Type                  | Default | Notes |
|------------------|-----------------------|---------|-------|
| `id`             | id                    |         | |
| `label`          | string                |         | |
| `glyph`, `color` | as for tiles          |         | |
| `tags`           | list of `[a-z][a-z0-9_]*` | `[]` | Tested by `has_tag` |
| `measurements`   | list of measurement ids | `[]`  | Which measurements the entity has |
| `initial`        | map id → number       |         | Overrides a measurement's `initial` |
| `ticks_per_step` | positive integer      | `2`     | Movement speed (ticks per tile) |
| `ticks_per_turn` | non-negative integer  | `1`     | Ticks per 45° turn before stepping in a new direction; `0` turns instantly (see [iso.md](iso.md#facing)) |
| `sprite`         | asset id              | placeholder | Anchored at the tile's ground centre |
| `inventory`      | `{ capacity, items? }` | none   | Every entity of the archetype gets its own inventory [container](#containers). `items` maps item id → count, filled in the order written; they must fit in `capacity` (load error otherwise) |
| `behavior`       | behavior id           | none    | The [behavior](#behaviors) driving every non-player entity of the archetype (short or qualified id) |

```yaml
archetypes:
  - id: shambler
    label: Shambler
    glyph: Z
    color: "#5fae3e"
    tags: [undead]
    measurements: [std:hp]
    initial: { hp: 40 }
  - id: survivor
    # …
    inventory:
      capacity: 15
      items: { water_bottle: 1, crackers: 1 }
```

Entities without `inventory` have none: expressions read `0`/`false` for
their items, and player actions fail with `no_inventory`.

### `maps`

A map comes either from **ASCII** fields (`legend`, `rows` or `floors`,
`rooms`) or from a **Tiled** JSON map (`tiled`); mixing the two is a load
error. Both load to the same map definition. ASCII is a fixture format (tests, small
maps like `garden`); real worlds are edited in [Tiled](#tiled-maps).

| Field    | Type                         | Notes |
|----------|------------------------------|-------|
| `id`     | id                           | |
| `tiled`  | path to a `.tmj`             | relative to the pack root, like asset `file`s; replaces `legend`/`rows`/`floors`/`rooms` (see [Tiled maps](#tiled-maps)) |
| `legend` | map char → `{ tile, spawn?, player?, facing? }` | `tile`: tile id; `spawn`: archetype id placed on that cell; `player: true` marks the player start (exactly one per start map, on any floor); `facing`: orientation of the cell's tile (see below) |
| `rows`   | list of equal-length strings | a one-floor map; every character must be in the legend, except the space (an [empty cell](#floors)) |
| `floors` | list of `{ rows }`           | a map with stacked floors instead of `rows`: entry *z* is floor *z*, and every floor has the same size (see [Floors](#floors)) |
| `rooms`  | list of `{ rect: [x, y, w, h], tags: [...], floor? }` | optional; see below |

```yaml
maps:
  - id: town
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: road, player: true }
      "Z": { tile: road, spawn: shambler }
    rows:
      - "#####"
      - "#.@Z#"
      - "#####"
```

**Facing.** A legend entry may set `facing: n | e | s | w` (default `s`;
diagonals and other values are load errors) to orient the **tile** of its
cells in the iso view: a directional [asset](#assets) shows that facing,
and a placeholder draws a darker stripe on the edge it faces. Use one
legend character per orientation:

```yaml
      "&": { tile: car, facing: e }
      "%": { tile: car, facing: w }
      "F": { tile: fridge, facing: s }   # against a north wall
```

`facing` does not affect `spawn` or `player` (entities turn toward their movement
direction, starting at `s`). It is static, render-only map data: not part
of world snapshots or hashes, and ignored by walkability, opacity,
containers, sight and the ASCII renderer.

**Rooms** are rectangles of cells with room tags (`kitchen`, `cellar`…).
A cell's room tags are the union of the tags of every rect that contains
it; rects may overlap. A rect must lie inside the map with `w, h ≥ 1`, and
`tags` must be a non-empty list of `[a-z][a-z0-9_]*`. Room tags are not
namespaced, and they are a third tag set, separate from tile and
archetype tags. Expressions test them with `tile.in_room("kitchen")`, and
[`distributions`](#distributions) use them to pick loot tables.

```yaml
    rooms:
      - { rect: [2, 2, 4, 3], tags: [kitchen] }
      - { rect: [7, 2, 2, 3], tags: [bathroom] }
      - { rect: [10, 2, 6, 3], tags: [bedroom], floor: 1 }   # upstairs
```

A room lies on one floor: `floor` (default `0`) must exist.

#### Floors

A map is a stack of **floors** `z = 0, 1, …` of the same size. Every map
loaded before floors existed is a one-floor map and behaves exactly as
before. Cells are numbered `(z * height + y) * width + x`; with one floor
that is the row-major `y * width + x`.

```yaml
maps:
  - id: house
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "<": { tile: stairs }          # climb: up
      ">": { tile: landing }
      "@": { tile: floor, player: true }
    floors:
      - rows: ["#####", "#@.<#", "#####"]
      - rows: ["     ", " #.>#", " ### "]
```

- **Empty cells.** A cell may hold no tile: in every floor's rows the
  **space** means empty, unless the legend defines `" "`. An empty cell is
  not walkable, not opaque, has no container and is not drawn (the floors
  below and the outside show through). In expressions its `tile.id` is
  `""` and `tile.has_tag(...)` is false. `set_tile` can neither target nor
  make one (`invalid_target`).
- **Links.** A cell whose tile has `climb: up` is linked to the same
  `(x, y)` one floor up; `climb: down`, one floor down. A link is an edge in
  both directions (the far cell needs no `climb`), and it exists only while
  **both ends are walkable**, checked live, so a pack action's `set_tile`
  can block or open stairs. A* crosses links (cost 1, after the 8 same-floor
  directions); crossing one is one step of `ticks_per_step` that does not
  turn the entity. Keyboard `step` intents never take a link.
- **Spawns** and the player start may be on any floor; spawns are ordered
  by `z`, then row-major.
- **Reach** is on one floor: containers, tile actions, stations,
  `take`/`put` and ground piles need the same floor and Chebyshev ≤ 1 on
  `(x, y)`. `drop` puts the pile on the player's floor.
- **Sight** stays on one floor: `can_see` is false across floors.
  **Hearing** is 3D: one floor counts as one tile, and floors (like walls)
  do not muffle.
- Load errors name the floor (`floors[1].rows[3]`). A `climb` cell whose far
  cell is outside the map, empty or not walkable in the map data is a load
  error naming both cells; so is `climb` on a tile that is not walkable.

#### Tiled maps

```yaml
maps:
  - id: town
    tiled: maps/town.tmj
```

The engine reads [Tiled](https://www.mapeditor.org/)'s **JSON** formats
only: maps (`.tmj`) and external tilesets (`.tsj`). A `.tmx`/`.tsx` (XML)
path is a load error: use *File → Export As… → JSON map files* (or *JSON
tileset files*) in Tiled. Tile ids and facings come from **custom
properties** on tileset tiles, never from gids or flip flags.

| Where             | Property    | Type   | Meaning |
|-------------------|-------------|--------|---------|
| tileset tile      | `tile`      | string | pack tile id; local ids resolve in the map's pack, qualified ids (`std:floor`) work too. Required on every tile a layer uses |
| tileset tile      | `facing`    | string | `n`/`e`/`s`/`w`, as the legend's `facing`; default `s` |
| `spawn` object    | `archetype` | string | archetype id placed on the object's cell |
| `room` object     | `tags`      | string | room tags separated by commas or spaces |

**Tile layers.** Every *visible* tile layer contributes, in layer order;
layers inside groups are flattened in order. Per cell the **top-most
non-empty** tile wins, so furniture can be painted on a layer above the
floor. Hidden layers (and hidden groups) are ignored. A cell left empty on
every layer of its floor is an [empty cell](#floors).

**Floors.** A group layer with an integer custom property **`floor`**
holds that floor's tile layers and object layers (its `player`, `spawn`
and `room` objects are on that floor). Layers outside any floor group
belong to floor 0, so a map without floor groups is a one-floor map.
Floor numbers must be unique and contiguous from 0, and a floor group
inside another floor group is a load error; groups without `floor` inside a
floor group are flattened into it.

| Where             | Property    | Type   | Meaning |
|-------------------|-------------|--------|---------|
| group layer       | `floor`     | int    | the floor (`z`) of the layers inside it |

**Objects** are matched by their **class** (`type` in Tiled ≤ 1.8,
`class` in Tiled ≥ 1.9):

- `player`: the player start (one per map; required on the start map);
- `spawn`: places the `archetype` property's archetype;
- `room`: a rectangle with a `tags` property; same rules as ASCII rooms.

An object without a class is ignored (use it for notes); any other class
is a load error. Objects in hidden object layers are ignored; rotated
objects are errors. A point object's cell is `floor(x / u), floor(y / u)`,
where `u` is the tile height on isometric maps (Tiled stores isometric
object positions in tile-height units on both axes) and the tile size on
orthogonal maps. Rooms round their rectangle to whole cells. Spawns are
ordered **row-major** (then by object id), whatever their order in the
file, so entity ids match an ASCII map and survive reordering in Tiled.

**Supported:** `isometric` and `orthogonal` orientation (both read as the
same grid); embedded and external `.tsj` tilesets (a `source` is relative
to the `.tmj`); image-collection and single-image tilesets (the engine
never loads their images); layer data as a JSON array (*CSV* format) or
*Base64 (uncompressed)*. Ignored: render order, tile size (except for
object coordinates), map properties, layer offsets, opacity and tint.

**Rejected** (load errors that name the Tiled setting): infinite maps
(disable *Infinite* in Map Properties), `staggered`/`hexagonal`
orientation, compressed layer data (set *Tile Layer Format* to *CSV* or
*Base64 (uncompressed)*), flipped or rotated tiles (use a tileset tile
with a `facing` property instead), gids outside every tileset, and TMX/TSX.
Templates (`.tx`), `.world` files, animations and Wang sets are not read
(only the resulting gids are). Errors name the Tiled file, a JSON path
(e.g. `maps/town.tmj layers[1].data[517]`), the cell, and the YAML map
entry that referenced the file.

**Setting up a tileset in Tiled:**

1. Start from an exported map (below), or create a map with *Orientation:
   Isometric*, tile size 64×32, *Infinite* off.
2. *New Tileset…* → *Collection of Images*, saved as JSON (`.tsj`) next to
   the map. Add the tile images (e.g. the pack's `assets/*.svg`); they are
   only a preview.
3. Select each tile and add a custom string property `tile` with the pack
   tile id, plus `facing` if it should not face `s`. Add one tileset tile
   per (tile, facing) pair.
4. Paint the floor on one layer and furniture on layers above it.
5. Add an object layer with `player`/`spawn`/`room` objects (set *Class*,
   then the `archetype` or `tags` property).

**Exporting an ASCII map** writes it as an isometric Tiled map plus an
image-collection tileset, to start editing in Tiled:

```sh
npm run map:export -- packs/std packs/std-needs packs/zombie --map town_center --out packs/zombie/maps/parts
```

It writes `town_center.tmj` (one `ground` tile layer and one `objects` layer with
the player, a `spawn` point per spawn at the cell centre, and a `room`
rectangle per room; a multi-floor map gets one `floor N` group per floor,
with the `floor` property, holding those two layers, and empty cells are
gid 0) and `town_center.tsj` (one tile per tile/facing pair used,
with the tile's image for that facing as a preview). The output is
byte-stable, and loading it gives the same map as the ASCII original.

#### Composite maps

A big map is assembled from reusable **part maps**: a house drawn once and
placed twenty times. A composite `maps` entry has no cells of its own:

```yaml
# packs/zombie/maps/city.yaml (abridged)
maps:
  - id: house_a
    tiled: maps/parts/house_a.tmj
  - id: city
    size: [256, 256]       # [w, h], each ≥ 1
    fill: grass            # floor-0 cells no part covers
    player: [132, 127]     # [x, y] or [x, y, z]; required on a start map
    parts:
      - { map: town_center, at: [106, 117] }
      - { map: house_a, at: [12, 12] }
      - { map: house_a, at: [23, 12] }   # a part may appear many times
    rooms:                 # extra rooms, in composite coordinates (as ASCII `rooms`)
      - { rect: [0, 0, 256, 9], tags: [fields] }
    populate:              # see below
      - { archetype: shambler, count: 50, rect: [56, 56, 50, 50] }
```

| Field | Notes |
|---|---|
| `size` | Required, `[w, h]` with each ≥ 1. |
| `fill` | Tile for floor-0 cells no part covers. Required when any floor-0 cell is uncovered. Upper floors stay empty where uncovered. |
| `parts` | `{ map, at: [x, y] }` entries. `map` is any non-composite map (ASCII or Tiled), local or qualified. |
| `player` | The player start; required on a start map. Part maps' own player markers are **ignored**. |
| `rooms` | Extra rooms (with optional `floor`), added after the parts' rooms. |
| `populate` | Optional, see [populate](#populate). |

Composition:

- The composite has as many floors as its tallest part. A part covers its
  whole rectangle on floor 0 (its own empty cells stay empty); only floor-0
  cells no part covers get `fill`.
- Each part's cells, facings, spawns, rooms and populate entries are offset
  by `at`. Spawns are ordered by part, then `z`, then row-major (so entity
  ids follow the part order).
- Link (`climb`) validation runs on the composed map.
- A map used only as a part needs no player marker.

Load errors: a part outside `size`; **two parts overlapping** (reported with
both part indices and the first shared cell); a part that is itself a
composite (no nesting); an unknown part map (with *did you mean*); `player`
outside the map or on a non-walkable cell; `fill` missing while cells are
uncovered; and mixing composite fields (`size`, `fill`, `parts`, `player`)
with ASCII (`legend`, `rows`, `floors`) or `tiled` fields.

`npm run map:export` on a composite writes the plain map it composes (its
populate entries stay in YAML).

#### Populate

`populate` scatters many NPCs with a seeded RNG. It is allowed on **any**
map; on a part map it is applied **once per placement**, offset by `at`.

```yaml
populate:
  - { archetype: shambler, count: 50, rect: [56, 56, 50, 50] }
  - { archetype: crawler, count: 1, floor: 1, room: bedroom }
```

| Field | Notes |
|---|---|
| `archetype` | Required. |
| `count` | Integer ≥ 1. |
| `rect` | `[x, y, w, h]` inside the map; defaults to the whole map. |
| `floor` | Default 0. |
| `room` | A room tag: only cells in such a room. |

**Candidate cells** are walkable, inside the rect, on the floor, in the room
(when given), not a container tile, and not the player start. At world
creation, right after the explicit spawns, entries are applied in order
(the parts' entries first, then the composite's own): each draws `count`
cells **without replacement**, skipping cells an earlier entry took, so a
cell gets at most one populated entity (it may still hold an explicit
spawn). Entity ids follow placement order. Draws use a dedicated RNG
derived from the seed (its own salt, like loot): `world.rng` and loot rolls
are unaffected.

Candidates do not depend on the seed, so counts are checked at load: a
`count` above the entry's candidates (per placement) is an error, and so is
one that might not fit after the cells earlier overlapping entries can take.
Saves store the placed entities; `restore` never re-populates.

### `systems`

Periodic rules that run on their own. Each system runs **once per entity**
when it is due.

| Field     | Type                 | Default          | Notes |
|-----------|----------------------|------------------|-------|
| `id`      | id                   | required         | Own id space |
| `every`   | number (sim seconds) | `0.1` (each tick)| Must be > 0 and a whole number of ticks (`every × 10` an integer); converted to ticks at load |
| `for`     | expression           | `true`           | Entity filter |
| `when`    | expression           | `true`           | Extra condition, evaluated only when `for` holds |
| `effects` | list                 | required         | Non-empty; see below |

A system with a period of *n* ticks fires on every tick *t* where
`(t + 1) % n == 0`, so it first fires after `every` seconds. For each
entity, in entity order, it runs its effects when `for` and then `when`
are truthy, with `self` = that entity and `tile` = the tile under it.
Systems run in definition order: pack load order, then the order of
entries within the pack. A system that is not due costs nothing.

**Effects** act on `self`:

| Effect                                                  | Meaning |
|---------------------------------------------------------|---------|
| `{ type: apply, measurement: <id>, delta: <n or expr> }` | Add `delta` to the measurement |
| `{ type: set, measurement: <id>, value: <n or expr> }`   | Replace the measurement's value |
| `{ type: noise, radius: <n or expr> }`                   | Emit a noise at `self`'s cell (see below) |

(`set_tile`, which edits the map, is only allowed in the effects of
tile-targeted [actions](#actions).)

- An effect on a measurement the entity does not have is skipped.
- Each effect sees the values left by the effects before it, and by the
  systems before it on the same tick.
- Values are clamped once, at the clamp phase of the tick, not after each
  effect.

**Noise.** A `noise` effect emits one noise at `self`'s current cell, with
`self` as its source and `radius` (tiles, evaluated at emission time) as its
hearing radius. It takes no `measurement` and works on any entity. A radius
`<= 0` emits nothing. Noises are **events**, not a field over the map: in
the [hear phase](#tick-order) of the same tick, every entity other than the
source within `dx² + dy² + dz² <= radius²` hears it (one floor counts as
one tile). **Walls and floors are ignored.** Each
entity remembers only its **last heard noise**: the nearest of the tick
(ties go to the earlier emission), with the cell and the tick. Entities that
hear nothing keep their previous memory. Everyone hears, including the
player and entities without a behavior. Packs decide who reacts, with
[`heard(entity, seconds)`](expressions.md) in statuses and transitions and
the `investigate` [behavior](#behaviors) activity. Hearing costs
O(noises × entities) on ticks with noise and nothing on silent ticks.

```yaml
systems:
  - id: drink
    every: 1                       # once per sim second
    for: 'self.has_tag("living")'
    when: 'tile.has_tag("water")'
    effects:
      - { type: apply, measurement: thirst, delta: -8 }
  - id: collapse
    every: 5
    when: "self.hunger >= 100"
    effects:
      - { type: apply, measurement: hp, delta: -3 }
  - id: crunch                     # broken glass is loud underfoot
    every: 0.2
    for: 'self.has_tag("living")'
    when: 'tile.has_tag("glass")'
    effects:
      - { type: noise, radius: 12 }
```

### `statuses`

Derived states such as *Hungry* or *Sunburnt*. They enter and exit on
conditions and add drift while active.

| Field   | Type       | Default    | Notes |
|---------|------------|------------|-------|
| `id`    | id         | required   | Own id space |
| `label` | string     | required   | Shown in the HUD |
| `for`   | expression | `true`     | Which entities can have the status |
| `when`  | expression | required   | Enter condition |
| `until` | expression | `not when` | Exit condition (use it for hysteresis) |
| `rates` | map measurement id → number or expression | `{}` | Extra drift **per sim second** while active |

- An inactive status becomes active when `for` and `when` are truthy.
- An active status becomes inactive when `until` is truthy or `for`
  becomes falsy.
- While active, each `rates` entry is added to that measurement's `rate`
  (entries for measurements the entity lacks are ignored). Constant rates
  are folded at load time, as for `rate`.
- Expressions test statuses with `has_status(entity, "id")` or
  `self.has_status("id")` (see [expressions](expressions.md#functions)).
- Active statuses are simulation state: they are part of `snapshot()` and
  `hash()`.

```yaml
statuses:
  - id: hungry
    label: Hungry
    for: 'self.has_tag("living")'
    when: "self.hunger >= 70"
    until: "self.hunger < 40"      # stays hungry until well fed
    rates: { hp: -0.2 }
```

Statuses can react to sight with
[`can_see`](expressions.md#built-in-functions). A range pair gives the
hysteresis: notice at 8 tiles, lose track only past 12 or behind a wall.

```yaml
statuses:
  - id: alert
    label: Alert
    for: 'self.has_tag("undead")'
    when: 'can_see(self, player, 8)'
    until: 'not can_see(self, player, 12)'
```

### `behaviors`

A behavior is a declarative **state machine** that moves NPCs. Each state
runs one built-in **activity**, and **transitions** are ordinary
expressions. Archetypes opt in with `behavior: <id>`. Behaviors have their
own id space.

| Field     | Type                 | Default  | Notes |
|-----------|----------------------|----------|-------|
| `id`      | id                   | required | |
| `initial` | state name           | required | Must be a key of `states` |
| `states`  | mapping name → state | required | Non-empty; names match `[a-z][a-z0-9_]*` |

A **state**:

| Field     | Type                                  | Default | Notes |
|-----------|---------------------------------------|---------|-------|
| `do`      | `idle`, `wander`, `pursue`, `flee`, `home` or `investigate` | required | The activity |
| `target`  | expression (entity or tile)           | —       | Required for `pursue`/`flee`, a load error elsewhere. Evaluated with `self` = the entity, e.g. `player` |
| `radius`  | integer ≥ 0                           | none    | `wander` only: maximum Chebyshev distance from home. Omitted = unbounded |
| `repath`  | sim seconds, whole ticks, > 0         | `1`     | `pursue`/`investigate` only: minimum interval between A* re-plans |
| `on`      | list of `{ when: expr, to: state }`   | `[]`    | Checked in order; the first truthy `when` wins |
| `timeout` | `{ after: sim seconds, to: state }`   | none    | Fires once the entity has been in the state for `after` seconds (whole ticks, > 0) |
| `done`    | state name                            | none    | `home`/`investigate` only: the state to switch to once arrived, or when the path fails |

Every `to`, `done` and `initial` must name a state of the same behavior.
Unknown fields and misplaced `target`/`radius`/`repath`/`done` are load
errors.

Each entity has a **home**: its spawn cell. Behaviors run in the **think**
phase (phase 0 of the [tick](#tick-order)), once per behavior-driven entity
in ascending id order:

1. **Transitions**: the current state's `on` entries in order, then its
   `timeout`, then `done`. The first that fires switches state, clears the
   entity's path and pending intent, and restarts the state's timer. **At
   most one transition per entity per tick**; the new state's activity runs
   in the same tick.
2. **Activity**: it may set the entity's pending movement intent, which
   phase 1 applies like any queued intent (walls, corners,
   `ticks_per_step`, A*). An activity never moves the entity directly.

Entities on a step cooldown still check transitions. A "ready" entity is
one whose next step fires in this tick (`moveCooldown ≤ 1`).

| Activity | Semantics |
|----------|-----------|
| `idle`   | Does nothing (an existing path or intent is kept). |
| `wander` | When ready and without a path: one draw from the world RNG picks one of 8 directions or "stay". The step is issued only if it is allowed and ends within `radius` of home; otherwise the entity stays this tick. No draw when not ready. |
| `pursue` | Evaluates `target` to a cell. If the entity is on it or 8-adjacent, it clears its path and waits. Otherwise it queues `goto` (with `adjacent: true`) on entering the state, and later when at least `repath` has passed since its last plan **and** it has no path or the target cell has moved. At most one A* per `repath` window; an unreachable target (`lastGoto.ok == false`) waits for the next window. |
| `flee`   | When ready: among the allowed neighbour steps, the one that maximizes the squared distance to `target`, only if it **strictly** increases it; ties go to the first in the order N, NE, E, SE, S, SW, W, NW. Nothing when cornered. No RNG, no A*. |
| `home`   | Once per entry into the state: a `goto` to the home cell (nothing if already there). `done` fires on a later tick once the entity is home, or when that goto failed. Without `done` the entity idles at home. |
| `investigate` | Walks to the entity's last heard [noise](#systems) cell; takes no `target`. Never heard anything: does nothing. On or 8-adjacent to the heard cell: clears its path and waits. Otherwise it queues `goto` (with `adjacent: true`) when it has not issued one yet in this state, or when the heard cell changed since its last plan and at least `repath` has passed, so a newer noise retargets the walk without a self-transition. `done` fires on a later tick than the plan once the entity is on or adjacent to the heard cell, when the last goto failed, or when it has never heard a noise. |

- On [multi-floor maps](#floors), `pursue`, `investigate` and `home` path
  in 3D (A* crosses links), so NPCs follow across stairs; "on or
  8-adjacent" also requires the same floor. `wander` and `flee` only take
  `step`s on the entity's own floor.
- The **player** is never driven by a behavior, even if its archetype has
  one; it stays under input control.
- Only `wander` draws from the world RNG, in id order, so runs stay
  deterministic. Behavior state (`home`, current state and since when, the
  last planned goto) is part of `snapshot()` and `hash()`.
- Queued intents on a behavior-driven entity may be overwritten by its
  activity.
- Transitions see the statuses computed at the end of the previous tick.

```yaml
behaviors:
  - id: shambler
    initial: wander
    states:
      wander:
        do: wander
        radius: 6
        on:
          - { when: 'self.has_status("alert")', to: chase }
      chase:
        do: pursue
        target: player
        on:
          - { when: 'not self.has_status("alert")', to: search }
      search:
        do: idle
        on:
          - { when: 'self.has_status("alert")', to: chase }
          - { when: 'heard(self, 1)', to: investigate }
        timeout: { after: 5, to: wander }
      investigate:                 # sight beats sound: `alert` is checked first
        do: investigate
        on:
          - { when: 'self.has_status("alert")', to: chase }
        done: search

archetypes:
  - id: shambler
    # …
    behavior: shambler
```

### `items`

Item kinds. Items are **plain data inside containers**, not entities: a
container holds stacks `{ item, count }`.

| Field    | Type                      | Default     | Notes |
|----------|---------------------------|-------------|-------|
| `id`     | id                        | required    | Own id space |
| `label`  | string                    | required    | |
| `glyph`, `color` | as for tiles      | required    | ASCII ground piles; iso placeholder colour |
| `weight` | number ≥ 0                | required    | Per unit; rounded to 0.01 |
| `tags`   | list of `[a-z][a-z0-9_]*` | `[]`        | Item tags (separate from tile, room and archetype tags) |
| `sprite` | asset id                  | placeholder | Iso ground-pile sprite, anchored at the tile's ground centre |
| `use`    | mapping                   | none        | Items without `use` cannot be used |

`use` is `{ label?, when?, effects, consume?, duration?, interrupt? }`:

- `label` — the verb shown in the UI, `"Use"` by default;
- `when` — an optional condition with `self` = the user; when falsy the
  use fails with `cannot_use`;
- `effects` — a non-empty list of `apply`/`set`/`noise` effects on `self`,
  exactly as in [`systems`](#systems). They run immediately, in order, and
  see each other's results; values are clamped at the next clamp phase. A
  `noise` effect is emitted only when the use succeeds (e.g. an alarm clock
  with `consume: 0`);
- `consume` — units removed per use, a non-negative integer (default `1`;
  `0` makes the item reusable);
- `duration` — sim seconds, as for [actions](#actions) (default `0`). A
  use with a duration > 0 is **timed**: the item must still be held and
  `when` must still hold at completion, and `effects` run and `consume`
  units are removed only then. `0` keeps the use instant, exactly as above;
- `interrupt` — an optional condition checked every tick of a timed use
  after its start; truthy ends it with `interrupted` (the item is kept).

```yaml
    use:
      label: Apply
      when: "self.hp < 100"
      duration: 3
      interrupt: "heard(self, 0.2)"   # a noise nearby wastes the attempt
      effects:
        - { type: apply, measurement: hp, delta: 20 }
```

```yaml
items:
  - id: canned_beans
    label: Canned beans
    glyph: "%"
    color: "#c9a227"
    weight: 0.4
    tags: [food]
    use:
      label: Eat
      effects:
        - { type: apply, measurement: hunger, delta: -35 }
  - { id: toaster, label: Toaster, glyph: "]", color: "#a0a0a0", weight: 3 }
```

### `actions`

Things that take time, started by the player with `{ kind: 'act' }`
(see [player actions](#player-actions)): barricading a window, closing
shutters, resting.

| Field       | Type                         | Default  | Notes |
|-------------|------------------------------|----------|-------|
| `id`        | id                           | required | Own id space |
| `label`     | string                       | required | Verb shown in the UI, e.g. `Barricade` |
| `progress`  | string                       | `label`  | Text shown while in progress, e.g. `Barricading` |
| `target`    | `self` or a tile filter      | required | See below |
| `when`      | expression                   | `true`   | Checked at start and at completion |
| `unavailable` | string                     | none     | UI text shown when `when` is falsy (default `Not now`), e.g. `Only in the crypt` |
| `tools`     | list of item ids             | `[]`     | Held (≥ 1 unit) at start and at completion; never consumed |
| `consume`   | map item id → integer ≥ 1    | `{}`     | Held at start and at completion; removed at completion |
| `duration`  | number ≥ 0 or expression     | `0`      | Sim seconds (see below) |
| `interrupt` | expression                   | none     | Checked every tick after the start; truthy cancels |
| `effects`   | list                         | `[]`     | Run once, at completion. An action with no `effects` and no `consume` is a load error |

**Targets.** `target: self` acts on the actor; `tile` is the cell under
it. A **tile filter** `{ tiles?: [tile ids], tags?: [tile tags] }` (at
least one non-empty list) matches a cell whose tile is listed **or** has
any of the tags; the action then targets one cell `(x, y)`: the actor's
cell or one of the 8 around it (the reach of containers). In that action's
`when`, `interrupt`, `duration` and `effects`, `tile` is the **target
cell** (see [expressions](expressions.md)); `self` is still the actor.
Unknown tile or item ids are load errors with suggestions; a tag that no
loaded tile carries is a load **warning**. The filter is compiled to one
flag per tile, so matching a cell is a single array read.

**Effects** are those of [systems](#systems) (`apply`/`set`/`noise` act on
the actor; a `noise` is emitted at the actor's cell), in order, plus
**`set_tile`**, allowed only in the effects of tile-targeted actions:

| Effect                              | Meaning |
|-------------------------------------|---------|
| `{ type: set_tile, tile: <tile id> }` | Replace the tile at the target cell |

- The new tile must not have a `container` (load error), and neither may
  the target cell's current tile (checked at run time: the action fails
  with `invalid_target`). Container identity never changes.
- The cell keeps its legend `facing`. Walkability and opacity change at
  once: pathfinding and line of sight read the live grid (nothing is
  cached across calls). Paths already in progress are not recomputed; a
  step into a cell that is no longer walkable fails and clears the path.
- If the new tile is not walkable and any entity (the actor included)
  stands on the target cell, the whole action fails with `occupied` at
  completion: no effect runs and nothing is consumed.
- `world.tileVersion` increases on every change (renderers redraw the
  changed cells). Changed cells are simulation state: `snapshot().tiles`
  lists `[cellIndex, tileId]` for every cell that differs from the map,
  sorted by cell index, and `hash()` covers them.

**Duration.** In sim seconds, like `systems.every`. A number must be a
whole number of ticks (load error otherwise). An expression is evaluated
**once, at start** (with `tile` bound as above); its result is rounded up
to whole ticks, and a negative result counts as 0. A 0-tick action
completes in the phase it starts in: it is instant and never becomes an
activity.

**The activity.** Started with a duration > 0, an action (or a timed item
use) becomes the actor's **activity**:
`{ kind: 'act' | 'use', action?, item?, x, y, startTick, endTick }` with
`endTick = startTick + ticks`. Starting it clears the actor's path and
pending intent, so the player stops walking. It is part of the entity's
snapshot and of `hash()`, and `world.activityProgress()` returns
`{ label, fraction }` (the `progress` text, or the use's label) or `null`.

- **Cancel:** a movement intent applied for the actor (a `step` or a
  click's `goto`) and every newly queued player action (`act`, `craft`,
  `use`, `take`, `put`, `drop`) end it with `cancelled`, before the new one is
  applied. Of several actions queued in one tick, the last one started
  wins.
- **Interrupt:** in every tick **after** the start tick, `interrupt` (if
  any) is evaluated first, with `self` = the actor; truthy ends it with
  `interrupted`. Hearing runs after the work step, so `heard(self, s)` sees
  a noise from the previous tick only when `s ≥ 0.2`. An entity never
  hears its own noises, so the player's own hammering never interrupts the
  player.
- **Complete:** in the work step of the tick where `tick == endTick` (a
  6-second action started on tick 100 completes on tick 160): `when`, the
  tools, the consumed items, reach and the filter are checked again (the
  world may have changed; a failure ends it with that reason), then the
  `occupied` check, then the effects run in order, then `consume` units
  are removed.
- A cancelled or interrupted activity has no effects and consumes
  nothing; there is no partial progress. Defeat freezes the world as
  usual, with the activity left in the snapshot.

```yaml
actions:
  - id: barricade
    label: Barricade
    progress: Barricading
    target: { tiles: [window] }
    tools: [hammer]
    consume: { plank: 2, nails: 4 }
    duration: 6
    effects:
      - { type: set_tile, tile: barricaded_window }
      - { type: noise, radius: 14 }        # heard when the last nail goes in
  - id: rest
    label: Rest
    progress: Resting
    target: self
    when: 'tile.has_tag("crypt")'
    unavailable: Only in the crypt
    duration: 10
    interrupt: 'heard(self, 1)'
    effects:
      - { type: apply, measurement: hp, delta: 30 }
```

`world.availableActions()` lists what the player could start right now:
every `self` action, then every tile action on each matching cell in reach
(the player's floor, row-major), then each inventory stack with a `use`. Each entry is
`{ kind, action?, item?, x?, y?, z?, label, ok, reason?, missing?, unavailable? }`;
entries whose target matches but whose tools, consumed items, inventory or
`when` fail are included with `ok: false` and the reason, and cells out of
reach or not matching are omitted. `missing` lists `{ item, label, count }`
for each absent tool or consumed item (`count` = units still needed), and
`unavailable` is the action's text when `when` fails. It is pure:
`random()` in a `when` draws from a throwaway copy of the RNG, so `hash()`
never changes. The terminal opens these with `x` (followed by `take all`
for each reachable non-empty container).

`world.interactionsAt(x, y, z?)` lists what the player can choose at **any**
cell (`z` defaults to the player's floor), ignoring reach (the browser's [context menu](ui.md) is built from
it). Entries, in order: every tile action whose filter matches the cell's
tile (definition order); every [recipe](#recipes) whose station matches it
(kind `craft`, definition order); for each container on the cell (tile container,
ground pile) an `open` entry, plus `take_all` when it is not empty;
`climb` entries *Go up* / *Go down* when the cell has an open
[link](#floors) that way (with `intent`, the goto to the link's far end);
every `self` action when the cell is the player's own; and `walk` when the
cell is walkable and not the player's. Each entry is
`{ id, label, kind, ok, reason?, missing?, unavailable?, action?, actions?, container?, intent?, inReach }`:
`ok`/`reason` use the same checks as `act` with reach left out (`take_all`
fails with `no_inventory`, or `too_heavy` when no stack fits at all),
`action` is the action to queue (the first `take` of a `take_all`, whose
`actions` lists them all), and `inReach` says whether the player can do it
without walking. It returns `[]` out of bounds or once the game has ended,
and is pure like `availableActions()`.

`reasonText(entry)` (in `src/core/hud.ts`) turns an entry's reason into
short UI text: `Needs: Hammer, 2× Plank` for `missing`, the
`unavailable` text or `Not now` for `cannot_act`, `Can't do that here` for
`invalid_target`, `Can't get there` for `unreachable`, and so on.

### `recipes`

Crafting: a recipe turns items into other items. It consumes some items,
needs tools in the inventory, may need a **station** (a nearby tile such
as a stove), and takes time. Started by the player with `{ kind: 'craft' }`
(see [player actions](#player-actions)). Recipes run on the same activity
lifecycle as [actions](#actions): the same progress bar, cancellation,
`interrupt` and completion-only rules.

| Field       | Type                         | Default        | Notes |
|-------------|------------------------------|----------------|-------|
| `id`        | id                           | required       | Own id space |
| `label`     | string                       | required       | Name of the result, e.g. `Hot beans` |
| `verb`      | string                       | `Craft`        | Shown as `<verb>: <label>` in menus, e.g. `Cook: Hot beans` |
| `category`  | string                       | `General`      | Grouping in the crafting panel |
| `consume`   | map item id → integer ≥ 1    | required       | Non-empty; held at start and at completion, removed at completion |
| `tools`     | list of item ids             | `[]`           | Held (≥ 1 unit) at start and at completion; never consumed |
| `produce`   | map item id → integer ≥ 1    | required       | Non-empty; added at completion, in the order written |
| `station`   | tile filter `{ tiles?, tags? }` | none        | The cell the recipe is made at, in reach (see [actions](#actions) for filters) |
| `when`      | expression                   | `true`         | Checked at start and at completion |
| `unavailable` | string                     | none           | UI text shown when `when` is falsy |
| `duration`  | number ≥ 0 or expression     | `0`            | Sim seconds, as for actions |
| `interrupt` | expression                   | none           | As for actions |
| `effects`   | list (`apply`/`set`/`noise`) | `[]`           | Extra effects on the crafter, run last at completion; `set_tile` is a load error |
| `progress`  | string                       | `<verb>: <label>` | Text shown while in progress |

An item listed in both `consume` and `tools` is a load error; unknown item
or tile ids are load errors with suggestions, and a station tag that no
tile carries is a load warning. In `when`, `interrupt`, `duration` and
`effects`, `self` is the crafter and `tile` is the **station cell** for
station recipes (the cell under the crafter otherwise), bound exactly like
the target of a tile action. All recipes are known from the start; there
is no learning.

**Completion**, after every start check passes again (`when`, tools,
consumed items, and the station's reach and filter):

1. the `consume` items are removed;
2. each `produce` entry is added to the crafter's inventory, in the order
   written, as many units as fit;
3. any **overflow** goes to the ground pile on the crafter's cell (created
   if needed, as for `drop`);
4. `effects` run.

Consumed items leave **before** produced ones arrive, so a recipe that
lightens the load never fails for lack of room. The record is
`{ kind: 'craft', item: '', recipe, moved, dropped?, ok, stage, … }` with
`moved` = total units produced and `dropped` = the units that went to the
ground (only when > 0); `actionText` reads `You make 1× Hot beans.`, with
` (some dropped on the ground)` on overflow. `containerVersion` increases.
The activity snapshot is `{ kind: 'craft', recipe, x, y, startTick,
endTick }` (`x`/`y` = the station cell, or the crafter's cell).

```yaml
recipes:
  - id: cook_beans
    label: Hot beans
    verb: Cook
    category: Cooking
    station: { tags: [heat] }          # a stove next to you
    consume: { canned_beans: 1 }
    produce: { hot_beans: 1 }
    duration: 5
    effects:
      - { type: noise, radius: 3 }     # the sizzle
  - id: tear_bandage
    label: Bandage
    verb: Make
    category: Medical
    consume: { rag: 2 }
    produce: { bandage: 1 }
    duration: 3
```

`world.availableRecipes()` lists **every** recipe, in definition order
(the crafting panel is built from it). Each entry is
`{ recipe, label, verb, category, ok, reason?, missing?, unavailable?, station? }`;
for a station recipe, `station` is the cell it would use (the first
matching cell in reach, row-major), and a recipe with no matching cell in
reach is `ok: false, reason: 'out_of_reach'` (`recipeHint` shows it as
`Go to a Stove`, from the first matching tile's label). In
`world.interactionsAt(x, y)`, every recipe whose station matches the cell
is an entry of kind `craft` labelled `<verb>: <label>`, after the tile
actions and before the containers; recipes without a station are not
listed per cell. Both queries are pure (no RNG, no `hash()` change).

### Containers

A container holds items up to a weight **capacity**. There are three
kinds:

- **tile** containers — one per map cell whose tile has `container`;
- **inventories** — one per entity whose archetype has `inventory`;
- **ground piles** — created when the player drops items on a cell with
  no pile yet; unlimited capacity; removed when they become empty.

Contents are an ordered list of stacks with **at most one stack per item**:
adding an item already present grows its stack, a new item is appended,
and a stack that reaches 0 is removed. Weight is the only limit (no slot
or stack limits).

Weights and capacities are rounded to 0.01 at load and the simulation
sums and compares them as integer **hundredths**, so `0.1 × 3` fits a
capacity of `0.3` exactly. A container's load is Σ `weight × count`; a
move into it is allowed only if the load stays ≤ `capacity`. Expressions
and the HUD show weights in normal units.

Containers get sequential integer ids that are never reused: tile
containers in cell order (floor by floor, row-major), then inventories in
entity order;
ground piles get the next id when they are created. Containers are
simulation state (`snapshot().containers`, covered by `hash()`) and do no
per-tick work.

### `loot`

Loot tables fill tile containers when the world is created.

```yaml
loot:
  - id: kitchen_food
    rolls: [1, 3]                    # integer, or [min, max] inclusive
    entries:
      - { item: canned_beans, weight: 3, count: [1, 2] }
      - { item: water_bottle, weight: 2 }       # count defaults to 1
      - { table: junk, weight: 1 }             # nested table, rolled once
      - { nothing: true, weight: 2 }
```

| Field     | Type                          | Default  | Notes |
|-----------|-------------------------------|----------|-------|
| `id`      | id                            | required | Own id space |
| `rolls`   | integer ≥ 0 or `[min, max]`   | `1`      | Number of picks |
| `entries` | list                          | required | Non-empty |

Each roll picks one entry with probability proportional to its `weight`
(a positive integer, default `1`). An entry is **exactly one** of
`item: <id>`, `table: <loot id>` or `nothing: true`. `count` (an integer
or `[min, max]`, both ≥ 1, default `1`) is only allowed on `item` entries.
A nested `table` is rolled once, with its own `rolls`. Cycles between
tables are a load error.

### `distributions`

Which loot table fills which tile container. A plain list without ids:

```yaml
distributions:
  - { container: cupboard, room: kitchen, table: kitchen_food }
  - { container: cupboard, table: bedroom_stuff }
  - { container: car, table: glovebox }
```

- `container` — a tile id; the tile must have `container`;
- `room` — optional room tag;
- `table` — a loot table id.

Each tile container takes the **first most specific** match: an entry
whose `room` is one of the cell's room tags beats an entry without
`room`; ties go to the first entry in definition order. A container with
no match starts empty.

**Loot generation** happens once, in the `World` constructor, over tile
containers in row-major order, with a **dedicated RNG** derived from the
world seed: it never touches the world RNG, so movement and `random()`
sequences are the same as without loot. The same definition and seed
always give the same contents. Items that do not fit a container are
dropped silently; the loader **warns** (without failing) when a table's
maximum possible weight exceeds the capacity of a container it is
distributed to.

### Player actions

The shells change the world through player **actions**, queued with
`world.queueAction(action)`. This queue is separate from movement
intents, so looting never cancels walking (but a new action cancels an
[activity](#actions) in progress).

| Kind   | Fields                                  | Effect |
|--------|-----------------------------------------|--------|
| `take` | `container`, `item`, `count?` (default all) | Container → player inventory |
| `put`  | `container`, `item`, `count?`           | Player inventory → container |
| `drop` | `item`, `count?`                        | Player inventory → the ground pile on the player's cell (created if missing) |
| `use`  | `item`                                  | Runs the item's `use`, then removes `consume` units (at completion when timed) |
| `act`  | `action`, `x?`, `y?`, `z?`              | Starts a pack [action](#actions); `x`/`y` are required for tile targets and forbidden for `self`; `z` defaults to the player's floor |
| `craft`| `recipe`, `x?`, `y?`, `z?`              | Starts a [recipe](#recipes); for a station recipe `x`/`y` name the station cell (omitted: the first matching cell in reach, row-major); forbidden without a station; `z` defaults to the player's floor |

An `act` is checked in this order: the action id resolves
(`unknown_action`); the actor has an inventory if the action needs
`tools`/`consume` (`no_inventory`); the target is in reach and matches the
filter (`out_of_reach` / `invalid_target`); tools and consumed items are
held (`missing`); `when` is truthy (`cannot_act`). A `craft` is checked
in the same order, with `unknown_recipe` first and the station in place of
the target (`out_of_reach` when no matching cell is in reach).

- `container` is a numeric container id (`world.containersAt(x, y, z?)`,
  `world.reachableContainers()`); `item` is a qualified item id. Like
  `interactionsAt(x, y, z?)` and `roomTagsAt(x, y, z?)`, `containersAt`
  defaults `z` to the player's floor.
- **Reach:** the container's cell must be the player's cell or one of the
  8 around it, on the player's floor. Inventories cannot be targeted by
  `take`/`put`.
- `take`/`put` move as many units as fit, up to `count`; moving 0 units is
  a failure.
- Every action records `world.lastAction`:
  `{ kind, item, action?, recipe?, moved, dropped?, ok, stage, reason?, tick }`.
  `item` is empty for `act` and `craft`, `action` is the qualified action
  id (`act` only) and `recipe` the qualified recipe id (`craft` only).
  `moved` counts units moved, consumed, or produced (`craft`, whose
  `dropped` counts the overflow put on the ground). `stage` is `start` when a timed
  activity starts (or fails to start), and `complete` for an instant
  action (take/put/drop, an instant use or a 0-second act) or when an
  activity ends (completed, cancelled, interrupted, or failed its
  re-check). `reason` is one of `out_of_reach`, `too_heavy`, `missing`,
  `cannot_use`, `no_inventory`, `unknown_container`, `unknown_action`,
  `unknown_recipe`, `invalid_target`, `cannot_act`, `occupied`, `cancelled`,
  `interrupted` or `unreachable` (a `goto.then` whose goto found no
  path, see below). `lastAction` is written on start, on completion and on
  cancellation or interruption; `actionText` (in `src/core/hud.ts`) turns
  it into a message such as `You start barricading.` or
  `Barricade interrupted.`.
- Pending actions and `lastAction` are part of `snapshot()`. Once the game
  has ended (after defeat or victory) `queueAction` ignores its input.

A `goto` intent (`{ kind: 'goto', x, y, z?, adjacent?, then? }`) walks an
A* path; `z` defaults to the entity's floor, and the path may cross
[links](#floors). With `adjacent: true` it ends on the reachable walkable
tile 8-adjacent to the goal on the goal's floor (or the goal itself, if
walkable) with the shortest path; the browser uses it when you click a
non-walkable container. `world.climbIntent(dz)` (`dz` = 1 or -1) returns
the goto that crosses the link at the player's cell in that direction, or
`null` when there is none; the shells bind it to their climb keys.

**Walk-then-act.** A player's `goto` may carry `then: <action>` (any
action of the table above). When the path ends with the player standing on
its last cell, `then` is appended to the action queue and applied in the
same tick's action step (phase 1, step 2), exactly as if a shell had
queued it, so every check runs as usual and it may still fail. A goto
whose path is empty (already at the goal, or already adjacent with
`adjacent: true`) queues it in the same tick.

- If A* finds **no path**, `then` is dropped and `world.lastAction`
  records `{ kind, item, action?, moved: 0, ok: false, stage: 'complete',
  reason: 'unreachable', tick }` (`You can't get there.`).
- If the path is cleared before arrival (a step fails because a cell
  became unwalkable, a new intent replaces it, or a timed activity starts),
  `then` is dropped silently; a new goto's own `then` replaces it.
- The pending `then` is part of the entity snapshot (`then`) and of
  `hash()`. Only the player's intents may carry it: `queueIntent` with
  `then` for another entity throws.

`world.approachIntent(action)` returns the intent a shell should queue for
an action: `null` when it is already in reach or needs none (`self` acts,
recipes without a station or cell, `use`, `drop`), so the shell queues the
action directly; otherwise
`{ kind: 'goto', x, y, z, adjacent: <target not walkable>, then: action }`
targeting the action's cell (the container's cell for `take`/`put`, `x`/`y`/`z`
for `act` and `craft`).

Movement intents (`step` and `goto`) are queued with
`world.queueIntent(intent, entity?)`; `entity` defaults to the player, and
an entity of another world throws. Each entity keeps its own pending
`intent` and `lastGoto` (both in its snapshot); `world.lastGoto` is the
player's. Entities do not block each other. The shells drive the player; NPCs
are driven by their archetype's [behavior](#behaviors).

### Tick order

`World.step()` runs these phases in order:

0. **think**: NPCs beyond the active radius are marked dormant for the
   tick (see [simulation](#simulation)); the other [behaviors](#behaviors)
   switch state (at most once) and issue movement intents, in ascending id
   order (the player is skipped);
1. three steps:
   1. apply **each entity's** movement intent, in ascending id order (the
      player is id 0; dormant NPCs are skipped); applying one cancels that entity's
      [activity](#actions);
   2. the queued (player) actions, in FIFO order; each cancels the
      player's activity first, and may start a new one (a 0-second action
      completes here);
   3. **work**: advance every entity's activity, in id order (the
      `interrupt` check, then completion on its `endTick`); an activity
      does nothing in the tick it started;
2. measurement drift: `rate` plus the `rates` of the statuses active at the
   **start** of the tick;
3. systems that are due, in definition order;
4. **hear**: skipped when no noise was emitted this tick; otherwise each
   entity records the nearest noise it heard (see [noise](#systems)).
   Noises are emitted in order: player actions and completed activities
   (phase 1), then systems
   (definition order, entity order). `world.noises` lists this tick's
   noises until the next tick starts;
5. clamp every measurement to `[min, max]`;
6. status update: every `for`/`when`/`until` sees the statuses as they were
   at the start of this phase, so status definition order does not matter;
7. outcome check: defeat first (see `start.defeat`), then victory (see
   `start.victory`) only if defeat did not trigger on this tick;
8. `tick++`.

Statuses are also evaluated once when the world is created, after the
initial clamp. So a status entered on tick *t* first changes drift on tick
*t + 1*. Likewise, statuses see a noise in the tick it is emitted, and
behavior transitions see it in the next tick's think phase.

### `start`

```yaml
start:
  map: town           # map id
  player: survivor    # archetype id
  defeat:             # optional
    when: "self.hp <= 0"
    message: "You did not survive the outbreak."
  victory:            # optional
    when: 'self.count_item("car_battery") >= 1 and tile.in_room("garage")'
    message: "You got the car running!"
  simulation:         # optional, all fields optional
    active_radius: 64        # tiles (Chebyshev), or `none`
    npc_path_budget: 4000    # A* nodes per NPC search
    player_path_budget: 60000
```

Exactly one `start` must exist across all loaded packs (one *base*
definition, plus any number of `override: true` patches — see
[Mods and overrides](#mods-and-overrides)). Typically the last (game) pack
defines it; loading two game packs that both define `start` is an error.

`defeat` ends the game: its `when` expression is evaluated at the end of
each tick with `self` = the player. When it becomes truthy the world
records the defeat (tick and `message`, which defaults to `"Game over"`),
the HUD shows it, and from then on the simulation is frozen and player
input is ignored. Without `defeat` the game never ends.

`victory` has the same shape and validation as `defeat` (`when` with
`self` = the player, optional `message`; unknown fields and conditions that
evaluate to an entity or tile are load errors). It is checked in the same
phase, right after defeat: when defeat triggers on a tick, victory is not
checked on that tick. When `when` becomes truthy the world records the
victory (tick and `message`, which defaults to `"Victory"`), the HUD shows
it, and the world is frozen exactly as after defeat: `step()` is a no-op,
queued intents and actions are ignored, and the browser panels become
read-only. `victory` is part of `snapshot()` and `hash()`, and a world has
at most one of the two outcomes. A pack may define either, both or
neither.

#### Simulation

`start.simulation` tunes the cost of big maps:

- **`active_radius`** (default 64): at the start of each tick, an NPC
  whose Chebyshev distance on `(x, y)` from the player (any floor) exceeds
  the radius is **dormant** for that tick: it does not think, does not
  apply its intent or advance its path (both are kept), and does not count
  its `moveCooldown` down. It still drifts, runs systems, updates statuses,
  hears noises and counts for defeat and victory. Dormancy is derived from
  positions, never saved or hashed (`world.isDormant(e)`,
  `world.activeCount`). `none` disables it. On maps smaller than the radius
  nothing is ever dormant.
- **`npc_path_budget`** / **`player_path_budget`** (defaults 4 000 /
  60 000): A* gives up after expanding that many nodes and the goto fails,
  as for an unreachable goal (behaviors take their failure or `done` path).
  Before searching, the grid's **connected-region labels** (8-way moves
  without corner cutting, plus links; recomputed lazily after `set_tile`)
  reject a goal in another region than the start at once; with
  `adjacent: true` the goto fails only when no walkable neighbour of the
  goal shares the start's region.

The world also keeps entities in a **16×16 chunk index** per floor
(`world.entitiesNear(x, y, z?, r)`, id order); hearing uses it, with the
same result as checking every pair.

### `clock`

The in-game calendar. Game time is derived from the tick count, so the
clock adds no simulation state; expressions read it through `world.day`,
`world.hour`, `world.is_day` and friends (see
[expressions](expressions.md#scope)), and the HUD shows `Day D HH:MM`.

| Field        | Type             | Default   | Notes |
|--------------|------------------|-----------|-------|
| `day_length` | number (seconds) | `1440`    | Sim seconds per in-game day; must be > 0. `1440` means 1 sim second = 1 game minute (a day lasts 24 real minutes) |
| `start`      | `"HH:MM"`        | `"08:00"` | Time of day at tick 0, on day 1 |
| `dawn`       | `"HH:MM"`        | `"06:00"` | Daylight starts (inclusive) |
| `dusk`       | `"HH:MM"`        | `"20:00"` | Daylight ends (exclusive); must be after `dawn` |

Times are 24-hour `HH:MM` strings (`00:00`–`23:59`); quote them in YAML.
Daylight does not wrap past midnight.

```yaml
# packs/vampire/content.yaml
clock:
  start: "20:00"      # the game begins at dusk (night)
```

**One** loaded pack defines `clock`; a second definition is an error
naming the first pack. A pack that depends on it may patch it with
`override: true` (see [Mods and overrides](#mods-and-overrides)). If no pack
defines it, the defaults above apply. Like `start`, it belongs in the game
pack, not in a stdpack.

### `lighting`

A day/night tint for the isometric view. It is **visual only**: the
simulation and expressions never see it, and the ASCII renderer ignores it.

```yaml
lighting:
  tint:
    - { at: "05:00", color: "#3a4a80" }
    - { at: "07:00", color: "#ffffff" }
    - { at: "19:00", color: "#ffd9b0" }
    - { at: "21:00", color: "#3a4a80" }
```

`tint` is a non-empty list of keyframes: `at` is an `"HH:MM"` time of day
and `color` a `#rrggbb` value (no duplicate times; order does not matter).
The colour is interpolated linearly in RGB between consecutive keyframes
and wraps around midnight from the last keyframe back to the first; a
single keyframe gives a constant tint. The scene's ground and objects are
multiplied by it (`#ffffff` = unchanged). Without `lighting` nothing is
tinted. Like `clock`, **one** loaded pack defines it; later packs may
patch it with `override: true`.

## Standard packs

The **stdpack** is a set of optional packs with generic content that many
games share. A game lists the ones it wants before its own pack. Following
VISION decision 8, the stdpack uses nothing a third-party pack could not:
it is plain YAML on the same loader, and the engine never names its ids.

| Pack (directory) | Namespace   | Depends | Contents |
|------------------|-------------|---------|----------|
| `std`            | `std`       | —       | measurement `hp` (Health, 0–100); archetype `humanoid`; tiles `floor`, `wall`, `door`, `stairs` (`climb: up`, raised, glyph `<`, 4-way art rising toward its facing) and `landing` (the floor cell at the top of the stairs, glyph `>`) |
| `std-needs`      | `std_needs` | `std`   | measurements `hunger`, `thirst`, `fatigue`; statuses `hungry`, `thirsty`, `exhausted` (drain `hp`), `burdened` (carrying ≥ 80% of capacity adds fatigue) |

**Opting in to needs.** An entity takes part in `std-needs` by listing the
measurements in its archetype and carrying the `living` tag, which every
need status tests in its `for` filter:

```yaml
archetypes:
  - id: survivor
    tags: [humanoid, living]
    measurements: [hp, hunger, thirst, fatigue]
```

An entity without the tag or the measurements is unaffected. What the
needs *do* beyond those statuses (sleeping in a bed, collapsing when
starved, food items) stays in the genre pack: `zombie` depends on
`[std, std_needs]` and adds its own systems, while `vampire` depends on
`[std]` only. More stdpacks are added as genres repeat patterns.

## Namespaces and references

- Namespaces and local ids match `[a-z][a-z0-9_]*`.
- **Definitions** may write a short id (`survivor`) — the loader prefixes
  the pack's namespace (`zmb:survivor`) — or a qualified id, which must use
  the pack's own namespace.
- **References** (in fields such as `measurements`, `tile`, `spawn`,
  `start.map`, and in expressions) may be qualified (`std:hp`) or short.
  A short reference resolves to the referencing pack's own namespace
  first, else to the **unique** match among the packs it directly
  `depends` on. Ambiguous or missing references are load errors;
  qualify to disambiguate.
- A qualified reference must name the pack's own namespace or one of its
  `depends`.
- Each kind (measurements, assets, tiles, archetypes, maps, systems,
  statuses, items, loot tables) has its own id space. Tags (tile,
  archetype, item and room tags) are not namespaced.
- Redefining an existing id is an error. To change or delete another
  pack's entry, restate its qualified id with `override: true` or
  `remove: true` (see [Mods and overrides](#mods-and-overrides)).

## Mods and overrides

A pack stacked on others can **tune** or **remove** what they define
without copying it. It patches by **qualified id**: it restates the id and
only the fields it changes.

```yaml
# packs/hardmode/tweaks.yaml   (pack.yaml: kind: mod, depends: [std_needs, zmb])
measurements:
  - id: std_needs:hunger
    override: true
    rate: 0.2              # only this field changes
archetypes:
  - id: zmb:shambler
    override: true
    tags: [undead, fast]   # lists are replaced wholesale
    sprite: null           # null clears an optional field (back to its default)
systems:
  - id: zmb:crunch
    remove: true
clock:
  override: true
  start: "20:00"
```

**Overrides.** Any entry of a list domain (`measurements`, `assets`,
`tiles`, `archetypes`, `maps`, `systems`, `statuses`, `items`, `loot`,
`behaviors`, `actions`, `recipes`) may carry `override: true`:

- The `id` must be **qualified**, and its namespace must be one of the
  pack's **direct `depends`** (the same rule as qualified references). A
  short id, the pack's own namespace (edit your own entry directly) or a
  namespace the pack does not depend on is an error, and so is an unknown
  id (with a *did you mean*).
- **Shallow merge:** every top-level field the override lists replaces the
  current one; omitted fields are kept. Nested values are replaced
  **whole**: a mapping (`inventory`, `use`, `directions`, `target`…) or a
  list (`tags`, `parts`, `populate`, `effects`, `rows`…). There are no list
  operators and no deep merge.
- **`field: null`** removes the field: the entry behaves as if it had never
  been written, so an optional field gets its default and a required one
  is reported *missing* at the override.
- `override: false` is the same as omitting it; any other value is an
  error. An override that lists only `id` and `override` warns that it
  changes nothing.
- The merged entry is validated like a fresh definition (unknown fields,
  types, references, expressions; a map still cannot mix composite, ASCII
  and Tiled fields).
- The entry keeps the **position** of its original definition, so system
  order, RNG order and indices do not change.

**Provenance.** Each field remembers the pack that **last wrote** it.
References in it (ids, room tags, every name in an expression) resolve in
**that pack's scope**: an original `zmb:survivor` listing `hunger` keeps
resolving it through `zmb`'s depends even if the mod does not depend on
`std_needs`, while a field the mod writes resolves through the mod's
depends. Relative paths (asset `file`/`directions`, map `tiled`) are read
from the writing pack's files, and the asset's images load from that pack.
Errors and warnings name the writing pack, file, line and key path.

**Removals.** `remove: true` deletes an entry of a direct dependency (same
id rules). A removal lists only `id` and `remove`; any other field, or
`override` together with `remove`, is an error. The entry gets no index
and is not in `def.ids`; later entries move down so indices stay dense.
Removal is validated **jointly**: any remaining reference to the removed
id, from any pack (the original one included), is an error naming the
remover — in fields, legends, Tiled tile properties, loot entries, recipe
items and expressions (`has_status("x")`, `count_item("x")`…):

```
zmb survival.yaml:28 systems[0].effects[1].delta: expression error in "1 - 0.5 * self.has_status("hungry")": has_status: unknown status 'std_needs:hungry' (removed by pack 'hardmode')
```

Overriding a removed entry is an error; removing it again warns.

**Singletons.** `start`, `clock` and `lighting` accept `override: true`
inside the mapping, with the same merge, `null` and provenance rules.
`start.defeat`, `start.victory`, `start.simulation` and `lighting.tint`
are replaced whole; `defeat: null` removes the defeat condition. The
overriding pack must **transitively depend** on the pack that first
defined the singleton, and an override with no earlier definition is an
error ("nothing to override"). A second definition *without* `override`
is still an error (it suggests `override: true` when the pack depends on
the first definer).

**Order and conflicts.** Patches apply in pack load order, and within a
pack in file and entry order; a pack may patch what an earlier pack
already patched. When a pack **P** writes a field (or removes an entry)
that an override from an earlier pack **Q** already wrote, and P does
**not** transitively depend on Q, the load **warns** and P wins:

```
warning: vamp content.yaml:3 clock.start: also overridden by pack 'zmb' (clock.yaml:2); 'vamp' wins (later in load order)
```

There is no warning when P depends on Q (the patch is intentional), when
only the original definer wrote the field, or when the overrides touch
different fields. `distributions` have no ids and cannot be patched.

**Checking a stack.** `npm run check` prints one line per pack that patched
anything (`hardmode: 2 overrides, 1 removal`). With `--overrides` it lists
the stack and every patch:

```
npm run check -- zombie hardmode --overrides
stack:
  std        0.1.0
  std_needs  0.1.0
  zmb        0.1.0
  hardmode   1.0.0
patches:
  hardmode  override  measurement std_needs:hunger  [rate]
  hardmode  remove    system      zmb:crunch
  hardmode  override  clock                         [start]
```

The loaded definition lists the same patches in `def.patches`
(`{ domain, id, pack, op, fields }`, `id` null for singletons). It is
diagnostic only: snapshots, hashes and saves do not include it. A save
records the packs of its stack, so a mod is part of it; a save naming a
removed id fails with the usual unknown-id error.

## Validation

The loader collects **every** error before failing; each names the pack,
file, line and YAML key path:

```
zmb archetypes.yaml:6 archetypes[0].measurements[1]: unknown measurement 'hungr' (did you mean 'hunger'?)
```

It checks YAML syntax, unknown top-level keys and fields, required fields
and types, id syntax, duplicate ids, unknown/ambiguous references (with
Levenshtein ≤ 2 suggestions), expression syntax and names, ragged map
rows, characters missing from the legend, unmet `depends`, a missing
or duplicate `start`, a duplicate or malformed `clock` (non-positive
`day_length`, times that aren't `HH:MM`, `dawn` not before `dusk`), and assets: missing files (with suggestions),
unsupported extensions, malformed or out-of-range anchors, and unknown
`sprite` references. For M2 content it also checks: `every` that is not
positive or not a whole number of ticks; empty `effects`; unknown effect
types or fields; effects missing `measurement`/`delta`/`value`; unknown
measurements in effects or `rates` keys (with suggestions); conditions
(`for`/`when`/`until`/`defeat.when`/`victory.when`) that evaluate to an entity or tile;
non-numeric `delta`/`value`/`rates`; `has_status` with a non-literal or
unknown id; malformed tile tags; and `lighting` problems (empty `tint`,
malformed times or colours, duplicate `at`, a second pack defining it).
For M3 content it checks: negative weights or capacities; unknown item,
loot table, tile or room tag references (with suggestions); `use` with
empty `effects` or a negative or non-integer `consume`; a starting
inventory over its capacity; room rects out of bounds or empty, and empty
room tags; loot entries that are not exactly one of `item`/`table`/
`nothing`, non-positive or non-integer entry weights, bad `rolls`/`count`
ranges, `count` on a non-item entry, and table cycles; `distributions`
whose `container` tile has no `container`; and non-literal ids in
`count_item`/`has_item`/`in_room`. For M4 content: `noise` effects without
`radius`, with a `measurement` or another unknown field, or with a
non-numeric `radius`; `target` on `investigate`; and `done` outside
`home`/`investigate`. For M5 content: an action without `target`, with a
`target` that is neither `self` nor a mapping, a tile filter with no
non-empty `tiles`/`tags` list or an unknown field, unknown tile or item ids
in filters, `tools`, `consume` or `set_tile` (with suggestions), a
consumed count that is not an integer ≥ 1, an action with neither
`effects` nor `consume`, `set_tile` outside a tile-targeted action (systems,
item uses and `self` actions included) or placing a tile with a
`container`, a `duration` that is negative or not a whole number of ticks
(actions and item uses), and `doing` with a non-literal or unknown action
id. For recipes: missing or empty `consume`/`produce`, a count that is not
an integer ≥ 1, an item in both `consume` and `tools`, unknown item or
tile ids (with suggestions), a malformed `station` filter, and `set_tile`
in `effects`. For mods (M7): an `override`/`remove` target that is a short
id, the pack's own namespace, a namespace the pack does not directly
depend on, or an unknown id (with suggestions); `override`/`remove` values
other than `true`/`false`; `override` together with `remove`; fields other
than `id` on a removal; overriding a removed entry; references to a
removed id (naming the remover); a singleton override without a base
definition or from a pack that does not depend on its definer; and a
required field cleared with `null`. Warnings (e.g. a loot table that can
exceed a container's capacity, a filter or station tag no tile carries, an
override that changes nothing, a second removal of the same entry, or two
unrelated packs patching the same field) are printed but do not fail the
load.
A successful load returns an immutable, fully
resolved definition (ids → indices, expressions → closures).

## Engine layout

- `src/core/` — platform-free simulation core: `expr/` (lexer, parser,
  compiler), `load/` (pack parsing, namespaces, validation, and `stack.ts`: the pack
  catalog and stack resolver), `clock.ts`
  (in-game calendar derived from the tick), `lighting.ts` (`tintAt`),
  `hud.ts` (renderer-independent HUD model), `sim/`
  (world, grid, RNG, A*, containers, and `activity.ts`: the requirement
  checks and lifecycle of timed actions, item uses and recipes, shared
  by every activity source). No Node built-ins, DOM or Pixi.
- `src/node/read-pack.ts` — reads a pack directory into
  `{ relativePath: text }` (plus the names of its other files) for the
  loader.
- `src/iso/` — Pixi isometric renderer: projection, depth buckets,
  camera, textures and placeholders.
- `src/web/` — browser shell: pack loading via Vite, input, HUD,
  inventory, loot and crafting panels (`panels.ts`, `I`/`Tab` toggles the
  inventory, `C` the crafting panel),
  title screen (`picker.ts`, `picker-dom.ts`), error screen, `main.ts`.
- `src/ascii/` — pure ASCII renderer and the terminal shell.
- `src/cli/` — `play`, `check` and `packs`; `common.ts` turns arguments
  into a resolved stack for all three.
