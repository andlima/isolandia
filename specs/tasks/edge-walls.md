---
id: edge-walls
area: engine
priority: 40
depends_on: []
description: Zomboid-style thin walls — walls, doors, windows and fences move from full grid cells onto the edges between cells (north/west edge per cell); grid, A*, regions, line of sight, reach, actions, saves, the ASCII and Tiled map formats, the iso renderer (thin wall slabs, cutaway, picking) and the ASCII view all learn edges; every shipped map is mechanically converted keeping its size and coordinates
---

# Edge walls: thin walls between cells

## Goal

Walls today are full tiles. A wall cell is a whole 64×64 block in the iso
view and takes a whole cell of floor space. This task moves the **wall-like
tiles** (walls, doors, windows, barricaded/shuttered windows, fences, park
hedges) **onto the edges between cells**, as in *Project Zomboid*. A wall is
a thin slab along one side of a cell, and rooms use the space walls used to
take up.

This is a cross-cutting engine change: grid model, movement, pathfinding,
sight, reach and actions, saves, both map formats, both renderers, plus a
mechanical conversion of every shipped map. Map sizes and the coordinates
of furniture, spawns and the player start do **not** change.

## Model

- Each cell `(x, y, z)` owns two optional edges: its **north edge** `n`
  (between `(x, y-1)` and `(x, y)`) and its **west edge** `w` (between
  `(x-1, y)` and `(x, y)`). The south and east sides of a cell are the `n`
  of the cell below it and the `w` of the cell to its right. Map-border
  edges need no representation: out of bounds is already impassable and
  opaque.
- An **edge tile** is a tile with the new field `edge: true` in its tile
  definition. It still has `walkable` (here: can be crossed) and `opaque`
  (blocks sight across it), with the same defaults as today
  (`opaque ?? !walkable`). Edge tiles are only valid on edges, and other
  tiles are only valid in cells. The loader and validator report a misplaced
  tile as an error.
- Edge tiles in the shipped packs are `std:wall`, `std:door`,
  `town:window`, `town:barricaded_window`, `vampire:shuttered_window`,
  `garden:fence`, and any other tile that only ever forms 1-thick wall runs
  (check every pack).

## Acceptance Criteria

### Grid and simulation (`src/core/sim`)

1. `Grid` stores per-floor edge tiles (two typed arrays by cell index, `n`
   and `w`, `EMPTY_TILE` where there is no edge), and derives from them
   "blocks movement" and "blocks sight" arrays the way `walk`/`opaque` are
   derived for cells. Add accessors: `edgeAt(x, y, z, side)`,
   `setEdge(i, side, tile)` (bumps `version` and records the change against
   the map, like `setTile` / `changed`), and a crossing test between two
   orthogonally adjacent cells.
2. **Movement:** `canStep` also requires the crossed edge to be walkable.
   A diagonal step needs both L-shaped routes (x then y, y then x) to be
   fully clear: every cell walkable and every crossed edge walkable. This
   matches today's no-corner-cutting rule.
3. **A\*** (`astar.ts`), `findPathAdjacent` and **region labels**
   (`Grid.regions`) use the same rule, so two cells share a region exactly
   when A* can walk between them. The inner loop stays allocation-free.
4. **Line of sight** (`sight.ts`): a Bresenham step between orthogonal
   neighbours is blocked by an opaque edge between them. A diagonal step is
   blocked when **both** L routes are blocked, by an opaque cell or an
   opaque edge. The result stays symmetric and integer-only. "Adjacent
   cells always see each other" now holds only when no opaque edge
   separates them (for diagonals, when at least one L route is clear).
   Floors and out-of-bounds rules are unchanged.
5. **Reach:** everywhere the sim treats a cell as within reach (the
   Chebyshev ≤ 1 checks in `activity.ts` and `world.ts`: tile actions,
   containers / `reachableContainers`, recipe stations, the
   `goto … adjacent` / `findPathAdjacent` arrival cells, and behaviour
   `near` arrival), a cell 8-adjacent to the actor is in reach only if
   no **non-walkable** edge separates them. The test uses the edge
   part of rule 2 and ignores whether the target cell itself is walkable.
   A fridge on the far side of a thin wall is **not** reachable. One across
   an open door is.
6. **Edge targets for actions:** tile-targeted actions (`target: { tiles:
   […] }`, and the `tags` filters if any) match an **edge** whose tile
   passes the filter, as well as a cell. An edge target is `(x, y, z,
   side)`. It is in reach from **either** of the two cells it separates
   (same floor, orthogonal only). `set_tile` on an edge target replaces the
   edge tile, and it must be an edge tile: a non-edge tile there is a
   load-time error, and the reverse too. The `World` action API, intents
   (`goto … then`), action records, `contextMenu` and `clickPlan` all carry
   the optional `side`. Barricading a town window and shuttering a vampire
   window work end to end from either side.
7. Noise is unchanged: walls still do not muffle.

### Saves (`save.ts`, `docs/saves.md`)

8. Changed edges are saved and restored exactly, alongside changed cells.
   Action records and intents with an edge `side` round-trip too.
   `SAVE_VERSION` becomes 3. Older versions (whose maps had wall cells)
   are refused with a clear message saying the save predates edge walls.
   Remove the v1→v2 migration code if nothing else needs it. `hash()`
   covers edges.

### Map formats (`src/core/load`)

9. **ASCII maps:** a map (or one entry of `floors`) may set `edges: true`.
   It then uses **double-resolution** rows: `2·h + 1` rows of `2·w + 1`
   characters.
   - Cell `(x, y)` is at row `2y+1`, column `2x+1`.
   - The `n` edge of `(x, y)` is at row `2y`, column `2x+1`.
   - The `w` edge of `(x, y)` is at row `2y+1`, column `2x`.
   - Vertex positions (even row, even column) are ignored, so any
     character (`+`, `#`, space) may go there for looks.
   - A space at an edge position means no edge.

   Edge positions take legend entries whose tile is an edge tile, and cell
   positions take the rest. Errors point at the exact row/column. A map
   without `edges: true` keeps today's notation, and putting an edge tile
   in a cell there is an error whose hint names the converter (AC 13).
10. **Tiled maps** (`tiled.ts`): a tile layer with the custom string
    property `edge` = `n` or `w` holds that side's edges for its floor (it
    goes inside the floor group on multi-floor maps). Edge layers may hold
    only edge tiles, and ordinary layers only non-edge tiles. Several edge
    layers of the same side merge as tile layers do (top-most wins).
    `npm run map:export` writes edge layers, and the round trip
    ASCII ↔ Tiled stays stable.
11. **Composite maps:** a placed part copies its edges with its cells. A
    part replaces the cells **and edges** inside its rect. `fill` sets no
    edges.
12. `rooms` (ASCII and Tiled `room` objects) are unchanged in format.
    `npm run check` validates the new rules and warns about an edge tile
    used in a cell or vice versa.

### Mechanical conversion of the shipped maps

13. Add a converter, `npm run map:edges -- <pack-dirs>… [--map <id>]`. It
    is kept in the repo and documented for modders. It rewrites ASCII maps
    in place to the `edges: true` notation and Tiled parts to cell + edge
    layers, keeping each map's size. The rule treats every cell holding an
    edge tile as a **vertex**:
    - For two wall-like cells side by side, `(x, y)` and `(x+1, y)`, put
      the `n` edge on cell `(x, y)`. For `(x, y)` above `(x, y+1)`, put the
      `w` edge on cell `(x, y)`.
    - The edge's tile is the tile of the cell that owns it (`(x, y)`). So a
      door between two walls produces exactly one door edge, and a run of
      windows the same number of window edges.
    - The former wall-like cell becomes ground. It takes the tile of its
      south neighbour, else east, else south-east, using the first one
      that is a plain walkable, non-raised, non-container tile. Otherwise it
      takes the map's most common such tile. Facings are dropped.
    - A wall-like cell with no wall-like orthogonal neighbour (an isolated
      pillar or a single hedge) and any ambiguity are **reported**. The
      script does not guess. Fix those by hand.
    - `room` rects (ASCII `rooms` and Tiled objects) grow by one cell north
      and/or west where those cells were wall-like and are now inside the
      room.
14. Run the converter on every shipped map: `packs/garden/maps/garden.yaml`,
    every `packs/town/maps/parts/*.tmj` (including the park hedges and the
    multi-floor `town_center` / `house_c`), `packs/vampire/maps/mansion.*`
    and the ASCII parts in `estate.yaml`, and any other map or mod part with
    wall-like tiles. Check by hand that each building is still closed (no
    gaps at corners), that every door is reachable from the player start
    (`test/maps.test.ts` already checks doors; extend it to door edges), and
    that stairs/landings and ladders still line up. Commit the converted
    maps.
15. Map sizes, the player start, spawns, furniture and container cells keep
    their coordinates, so `GENRE_AT` and most `genreCell` test cells still
    hold. Where a test depended on a wall **cell** (sight blocked by a wall,
    a wall next to the player, a window to barricade), re-point it at the
    equivalent edge. Each test still checks the same situation. Do not
    weaken assertions.
16. Pack overrides and the zombie/vampire/hardship mods still load.
    `packs/town/maps/README.md` and `packs/vampire/maps/README.md` describe
    the edge layers.

### Iso renderer (`src/iso`, `art/`)

17. Edge tiles are drawn as **thin wall slabs**, wall height (`BLOCK_H`) and
    about 1/8 of a tile thick. They stand on the cell's top-right (`n`) or
    top-left (`w`) diamond side. The `w` image is the horizontal mirror of
    the `n` image, so one drawn image per edge tile is enough. Directional
    assets with explicit `n`/`w` images are also accepted. Placeholder
    edges with no sprite are drawn procedurally (like `block()` today).
    Where edges meet at a vertex, the joint is drawn without visible gaps or
    overlaps. A small corner post per vertex is acceptable.
18. New pixel art for `wall`, `door` (a frame with an open doorway, so you
    can see through it), `town:window`, `barricaded_window`, the vampire
    window and `shuttered_window`, and the garden `fence` (low, see-over).
    Generate it with `scripts/pixel-art.mjs` from `art/*.mjs` as edge
    images. Update the `assets.yaml` comments, the `.tsj` tileset images,
    and `docs/art.md` (size and anchor of an edge image).
19. **Depth:** an `n` edge of cell `(x, y)` draws in front of everything in
    `(x, y-1)` and behind the entities in `(x, y)`, and the same for `w`
    with `(x-1, y)`. Add a depth layer in `depth.ts`, so an entity standing
    in a doorway or beside a wall is never drawn behind the wrong slab.
20. **Cutaway:** edges in front of the player fade like raised blocks do
    (`cutaway.ts`), using the same diagonal/spread rule on the edge's
    position. The south and east sides of the player's own cell count as in
    front. Floors above the view floor hide their edges too.
21. **Picking:** `PickTarget` gains `{ kind: 'edge', x, y, z, side }`.
    Clicking a slab's opaque pixels picks it, and faded edges are skipped
    as faded blocks are. Hover shows the edge tile's label. The context
    menu lists edge actions (barricade, shutter). A plain left click on a
    wall edge walks next to it on the clicked side.
22. Chunked building and map-edit redraws (`scene.ts`) cover edges: a
    `set_tile` on an edge rebuilds that chunk.

### ASCII view (`src/ascii`)

23. `renderAscii` draws the player's floor in the same double-resolution
    layout as AC 9. A viewport of `w × h` **cells** gives `2w + 1`
    characters by `2h + 1` lines. Edges use their tile's glyph and colour.
    A vertex shows the glyph and colour of an adjacent edge when it has
    one, and a space otherwise. Piles and entities sit at cell positions.
    The terminal shell (`terminal.ts`) and the `colors` array follow the
    new shape. ASCII-snapshot tests are updated.

### Tests, perf and docs

24. New tests cover: edge storage and `setEdge`/`changed`; stepping and
    diagonal corner rules across edges; A* and region labels around a thin
    wall with a door; line of sight blocked by a wall edge and not by a
    window or open door edge, including symmetry and the diagonal case;
    reach blocked through a wall but not through a door; barricading a
    window edge from both sides; save round-trip of changed edges; ASCII
    `edges: true` parsing and its errors; Tiled edge layers; the converter
    on a small fixture (corner, T-junction, door, window run, isolated
    pillar reported, room rect growth); iso depth/cutaway/pick for edges
    (pure parts); and the ASCII view's shape.
25. `npm run typecheck`, `npm test` and `npm run smoke` pass. `npm run
    check` reports no new warnings for every shipped stack.
26. `npm run bench:sim` for zombie and vampire: steady p95 stays under the
    10 ms target. Update `docs/perf.md`, and call out any rise above 2× in
    the doc and the completion report.
27. Docs: `docs/packs.md` (`tiles` → `edge`, maps → `edges: true`
    notation, Tiled edge layers, composite maps, actions' edge targets,
    reach), `docs/iso.md` (edge drawing, depth, cutaway, picking),
    `docs/ui.md` (clicking walls), `docs/art.md`, `docs/saves.md`
    (version 3), and a decision note in `VISION.md`'s decisions list.
    Leave historical specs in `specs/` alone.

## Out of Scope

- Opening and closing doors. Door edges stay always passable and
  see-through, as door tiles are today.
- Redesigning or resizing maps to use the space walls freed up. Only the
  mechanical conversion and the hand fixes it reports are in scope.
- Noise muffling by walls, and light or shadow through windows. Sunbeams
  stay ordinary tiles.
- Diagonal walls, walls on south/east edges as stored data, and edges
  between floors (floors stay cells).
- New gameplay that uses edges (breaking walls, climbing through windows).

## Design Notes

- **Vertex model for the converter.** Old wall cells sit on the lattice
  vertices of the new grid. A building whose wall cells span columns
  `x0..x1` and rows `y0..y1` ends up with interior `[x0, x1-1] × [y0, y1-1]`.
  Its walls are the `n` edges of rows `y0` and `y1` and the `w` edges of
  columns `x0` and `x1`, and the former east-wall column and south-wall row
  become outside ground. Worked through for corners, T-junctions and doors,
  this rule gives closed buildings with exactly one door edge per door
  cell. Check it on `garden.yaml` first: it is small, fenced all round and
  has one shed.
- **Iso geometry:** with `worldToIso(x, y) = ((x−y)·32, (x+y)·16)`, the `n`
  edge of `(x, y)` runs from `iso(x, y)` to `iso(x+1, y)`, the diamond's
  top-right side. The `w` edge runs from `iso(x, y)` to `iso(x, y+1)`, its
  top-left side. These sides are horizontal mirrors of each other, which is
  why one image plus mirroring is enough.
- Keep `Grid` hot paths typed-array based. A* and sight read the edge
  arrays directly, like `walk` and `opaque`. A good shape is
  `edgeN`/`edgeW` (tile ids) plus `blockN`/`blockW` (move) and
  `seeN`/`seeW` (sight) as `Uint8Array`s.
- The crossing test between `(x, y)` and `(x+1, y)` reads `w` of `(x+1, y)`.
  Between `(x, y)` and `(x, y+1)`, it reads `n` of `(x, y+1)`.
- For Tiled layers, the edge tile shows on the cell in Tiled's own view,
  which is acceptable. The `edge` layer property is the source of truth.

## Agent Notes

- This is large. A sensible order:
  1. the `Grid` model, `canStep`, A*, regions and sight, with unit tests;
  2. reach and edge action targets;
  3. the ASCII `edges: true` format and the ASCII view;
  4. the converter, run on `garden.yaml`, then playing it in the terminal
     (`npm run play`);
  5. Tiled edge layers, `map:export`, then converting the town and vampire
     maps;
  6. saves;
  7. the iso renderer, art, picking and cutaway;
  8. docs and perf.
- Read `docs/packs.md` (tiles, maps, Tiled, composite maps, actions),
  `docs/iso.md`, `src/core/sim/grid.ts`, `astar.ts`, `sight.ts`,
  `activity.ts`, `world.ts` (reach, `goto`, `contextMenu`, `clickPlan`),
  `src/core/load/load.ts` (ASCII maps, tiles, `set_tile`), `tiled.ts`,
  `src/iso/scene.ts`, `cutaway.ts`, `pick.ts` and `depth.ts` before
  starting.
- `test/maps.test.ts` already checks room interiors and door
  reachability. After conversion, rooms grow by one row/column, so those
  checks should still pass or get easier.
