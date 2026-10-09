---
id: m6-tiled-maps
area: load
priority: 40
depends_on: [m5-recipes]
description: "M6 map authoring — maps can come from Tiled JSON (`maps[].tiled: <file>.tmj`, embedded or external `.tsj` tilesets whose tiles name a pack tile and facing, stacked tile layers, `player`/`spawn`/`room` objects), a `map:export` CLI that writes an ASCII map to an isometric 64×32 Tiled map plus tileset, and the zombie town and vampire mansion converted to Tiled with identical simulation results"
---

# M6b — Tiled maps

## Goal

ASCII rows were always meant as a fixture format (VISION §3.6). The M6
town is too big to hand-write as rows. Maps need a real editor, and the
decision is **Tiled**.

This spec lets a pack map point at a **Tiled JSON map** (`.tmj`). The
loader turns it into the same `MapDef` the ASCII path produces, so the
simulation, the renderers, loot and save files do not change.

An **exporter** writes an existing ASCII map out as an isometric Tiled
map. The two genre maps are converted with it:

- `zombie:town`;
- `vampire:mansion`.

Every scenario keeps producing the same hashes. ASCII stays supported for
the garden and for test fixtures.

`m6-floors` adds floors to both formats, and `m6-chunked-world` composes
maps from parts. This spec handles one floor and one file per map.

## Acceptance Criteria

### Pack sources

1. A pack's **text files** now include `*.tmj` and `*.tsj` alongside
   YAML:
   - `PackSource.files` carries their text;
   - `readPack` reads them;
   - the browser glob imports them as raw text.

   Only YAML files are parsed as domain files. Tiled files are read only
   when a map references them. `otherFiles` keeps listing every other
   file. A `.tmj`/`.tsj` that no map references is ignored silently.

### Pack schema

2. A `maps` entry takes **either** the ASCII fields (`legend`, `rows`,
   `rooms`) **or** **`tiled: <path>`**, a path to a `.tmj` relative to
   the pack root, as asset `file` paths are. It cannot take both:
   - mixing the two is a load error;
   - a missing file is a load error with *did you mean* over the pack's
     `.tmj` files;
   - a `.tmx` (XML) path is a load error that says to save as JSON in
     Tiled (`File → Export As… → JSON map files`).

### Tiled map support

3. **Accepted maps.**
   - `orientation` is `orthogonal` or `isometric`. Both are read as the
     same logical grid; isometric is what the exporter writes.
   - `infinite: false`. Infinite maps are a load error ("disable *Infinite*
     in Map Properties").
   - `renderorder`, `tilewidth`/`tileheight` (used only for object
     coordinates), map properties and layer offsets, opacity and tint
     colors are ignored.
   - `staggered` and `hexagonal` orientations are load errors.
4. **Tilesets.**
   - Embedded tilesets and external **`.tsj`** tilesets are both
     supported. A `source` path is resolved relative to the `.tmj` file,
     as Tiled writes it. A `.tsx` source is a load error, like `.tmx`.
   - Each tileset tile that a layer uses must have a custom property
     **`tile`**, a string naming a pack tile id. Local ids resolve in the
     map's pack namespace, as in legends; qualified ids are accepted.
     Unknown ids are load errors with *did you mean*.
   - A tile may have a **`facing`** property (`n|e|s|w`) with the legend's
     meaning and validation. The default is `s`.
   - Image-collection and single-image tilesets are both fine. Images are
     never loaded by the engine.
5. **Tile layers.**
   - Every **visible** tile layer contributes, in layer order. Layers
     inside groups are flattened in order. For each cell, the
     **top-most non-empty** gid wins, so furniture can be painted on a
     layer above the floor.
   - Hidden layers (`visible: false`) are ignored.
   - Layer `data` may be a JSON array, or `encoding: base64` **without**
     compression (decode with `atob`, which exists in Node and the
     browser). Any `compression` is a load error naming the Tiled setting
     to change.
   - A **flipped or rotated** gid (any of the top flag bits set) is a load
     error. Use a tileset tile with a `facing` property instead.
   - A gid with no `tile` property, or outside every tileset, is a load
     error. It names the tileset, the local tile id and the first cell
     where it is used.
   - A cell left empty on every layer is a load error, reported once per
     map with the count and the first few cells. `m6-floors` relaxes
     this.
6. **Objects.** Each object is identified by its `type` (Tiled ≤ 1.8) or
   `class` (Tiled ≥ 1.9), whichever is non-empty:
   - **`player`**: the player start. Exactly one per start map, as for
     legends.
   - **`spawn`**: places the archetype named by the string property
     **`archetype`**. Local ids resolve in the map's namespace.
   - **`room`**: a rectangle whose string property **`tags`** lists room
     tags separated by commas or spaces. It has the same validation as
     ASCII `rooms`.

   Rules for all objects:
   - An object with no type/class is ignored, so authors can keep notes.
   - An unknown type/class is a load error with *did you mean* over
     `player`, `spawn`, `room`.
   - Non-zero `rotation` is a load error.
   - Objects in hidden object layers are ignored.
7. **Coordinates.**
   - An object's cell is `floor(x / u)`, `floor(y / u)`, where `u` is
     `tilewidth` for orthogonal maps and `tileheight` for isometric maps.
     Tiled stores isometric object positions in tile-height units on both
     axes.
   - A room is `x0 = round(x / u)`, `y0 = round(y / u)`,
     `w = round(width / u)`, `h = round(height / u)`. It must lie inside
     the map with `w, h ≥ 1`.
   - A spawn or player outside the map is a load error.
8. **Spawn order is row-major** (then by object `id`), whatever the order
   of objects in the file. Entity ids therefore match the ASCII loader
   and do not change when objects are reordered in Tiled.
9. **Errors** carry the Tiled file and a JSON path (for example
   `maps/town.tmj: layers[1].data[517]`), plus `(cell 21, 11)` where a
   cell applies. They also name the YAML map entry that referenced the
   file.

### Exporter

10. `npm run map:export -- <pack-dir>… --map <id> --out <dir>` loads the
    packs and writes the map as:
    - **`<id>.tmj`**: isometric, `tilewidth: 64`, `tileheight: 32`, the
      projection from `docs/iso.md`. It holds one tile layer `ground` with
      array data, and one object layer `objects` with a `player` point, a
      `spawn` point per spawn at the cell's centre, and a `room`
      rectangle per ASCII room.
    - **`<id>.tsj`**: an external image-collection tileset with one tile
      per (tile id, facing) pair used by the map. Each tile has the
      `tile`/`facing` properties. Its `image` is the tile's asset file for
      that facing, relative to the `.tsj` (the unmirrored image of the
      nearest direction, as a preview only), or no image for placeholder
      tiles.

    The map references the tileset with a relative `source`. Output is
    stable: the same input gives byte-identical files (sorted tileset
    tiles, 2-space JSON, trailing newline).
11. **Round trip.** For every ASCII map in the shipped packs and the test
    fixtures, `export → load` gives a `MapDef` that deep-equals the
    ASCII one: cells, facings, spawns in order, player start and rooms.
    Room rects may come back in a different order only if the resulting
    `cellSet` is identical. The exporter writes them in the original
    order, so they should not.

### Packs

12. **Conversion:**
    - `zombie:town` and `vampire:mansion` are exported with the CLI into
      `packs/zombie/maps/town.{tmj,tsj}` and
      `packs/vampire/maps/mansion.{tmj,tsj}`;
    - their YAML entries become `{ id, tiled }`, and the ASCII rows and
      legends are deleted;
    - comments that explained the layout (house layout, room purposes)
      move into Tiled object names or a short `maps/README.md` per pack.

    `garden` stays ASCII, to keep both formats exercised by shipped
    content.
13. **Identical results.** Every existing test passes unchanged after the
    conversion, including scenarios, determinism hashes compared run
    against run, reachability and loot placement. Any test that read a
    map's rows must switch to `def.maps`.

### Tests and docs

14. Headless tests cover:
    - **Loader:** each accepted variant:
      - orthogonal and isometric;
      - embedded and external tilesets;
      - array and base64 data;
      - layer stacking;
      - hidden layers;
      - groups;
      - `type` vs `class`.
    - **Errors:** every load error in AC 2–7, with its JSON path and
      cell.
    - **Objects:** spawn ordering independent of object order.
    - **Exporter:** the round trip of AC 11 and byte-stable output.
    - **Web:** the `buildPackSources` change that includes `.tmj`/`.tsj`
      text.
    - **Guards:** the genre-word guard and all determinism tests still
      pass.
15. **Docs.**
    - `docs/packs.md` `maps` gains a **Tiled** subsection:
      - the property conventions (`tile`, `facing`, `archetype`, `tags`);
      - object classes, layer stacking, and the supported and rejected
        settings;
      - a short "set up a tileset in Tiled" walkthrough.

      It also notes that ASCII remains a fixture format.
    - `docs/iso.md` notes that exported maps use the game's own 64×32
      projection, so Tiled shows the map as the game does, minus
      raised-block height.
    - `VISION.md`:
      - §3.6 is marked done;
      - §7 records the decisions:
        - Tiled JSON only (no TMX);
        - tile ids and facings come from tileset tile properties, not gids
          or flip flags;
        - the top-most visible layer wins;
        - objects are matched by class;
        - spawns are ordered row-major.

## Out of Scope

- TMX/TSX (XML), compressed layers, infinite maps, Tiled `.world` files
  (`m6-chunked-world` composes maps its own way) and template objects
  (`.tx`).
- Multiple floors (`m6-floors` adds group layers per floor).
- Tiled-driven loot distributions, containers or item placement.
  Containers still come from container tiles.
- Animated tiles, Wang sets and automapping rules. Authors may use them
  in Tiled, but the engine only reads the resulting gids.
- Hot reloading maps while the game runs.
- A Tiled plugin or a custom export format.

## Design Notes

- Put the Tiled reader in `src/core/load/tiled.ts`. It is pure and
  platform-free: it takes the file text map from `PackSource`. It returns
  the same intermediate the ASCII path builds (`cells`, `facings`,
  `spawns`, `playerStart`, room rects), so rooms and validation share
  one code path after it.
- `JSON.parse` loses line numbers. Report JSON paths instead; that is
  enough to find the spot in Tiled's own JSON view.
- Gid → tile: build one `Int32Array` lookup per map from `firstgid` +
  local ids (−1 for unmapped). The flag bits are `0x80000000`,
  `0x40000000`, `0x20000000` and `0x10000000`.
- The exporter lives in `scripts/map-export.ts` and reuses the loader.
  Write the JSON by hand-ordering keys as Tiled does
  (`compressionlevel`, `height`, `infinite`, `layers`, …), so files
  diff cleanly if someone re-saves them in Tiled.

## Agent Notes

- Read these first:
  - `src/core/load/load.ts` (the `maps` resolver, around `legend`/`rows`);
  - `src/core/load/pack.ts`, `src/node/read-pack.ts`, `src/web/packs.ts`
    and `src/web/main.ts` (the globs);
  - `docs/packs.md` `maps`.
- Do the exporter **before** converting the packs, and prove the round
  trip on the ASCII originals first. Convert only once the round-trip
  test is green.
- Tiled's JSON format reference:
  https://doc.mapeditor.org/en/stable/reference/json-map-format/. Do not
  rely on network access in tests. Hand-written fixtures are enough.
