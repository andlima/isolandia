---
id: tile-exposure
area: sim
priority: 45
depends_on: []
description: "Tile exposure — a derived per-cell `tile.exposed` (open to the sky) computed at load from the map's enclosing edges, empty cells and the floor above, with `encloses: false` for low fences and an `exposed: true|false` tile override for sunbeams and awnings; `check --exposure <map>` draws it; the vampire pack drops its `shade`/`sunlit` tags and its untagged floors stop burning"
---

# Tile exposure: a derived "open to the sky"

## Goal

Exposure is tagged tile by tile. The vampire pack puts `shade` on
`carpet`, `creaky`, `crypt` and `font` and `sunlit` on `sunbeam`
(`packs/vampire/content.yaml`), and its survival rules read the tags:
`sunburnt` enters on `tile.has_tag("sunlit")` and leaves on `shade`,
`daylight` hurts on `not tile.has_tag("shade")`, the dawn quest counts
`shade` as safe. Any floor that forgets the tag burns as if outdoors: the
mansion's corridors and side rooms are `std:floor` (184 cells of the
estate) and scorch the vampire at noon, and every new floor tile a mod
adds inherits the bug. `VISION.md` §4 sketched the fix from the start as
`tile.exposed_to_sky`.

This spec adds a **derived, static per-cell property**, `exposed`, computed
once at load from the geometry packs already draw: walls, doors and
windows are [edge tiles](../docs/packs.md#edge-walls) that enclose, upper
floors have empty cells where there is no building, and a floor above is a
ceiling. Floors are floors again; what makes the indoors is the walls.
Two small overrides keep the deliberate exceptions: an edge tile can opt
out of enclosing (a low fence) and a tile can force its cells exposed or
covered (a sunbeam under a window, an awning). No simulation state, no
save change.

Playable result: the vampire estate plays as before (the sun still falls
through the windows), the mansion's plain floors are shaded like the
carpet beside them, and a mod can lay any floor without learning the
tags.

## Acceptance Criteria

### The rule

1. Every cell of every loaded map has a boolean **`exposed`** ("open to
   the sky"), computed at load after the map's cells and edges are final
   (for a composite, on the composed map). A non-empty cell is exposed
   when it is **not enclosed** and **not covered**, unless its tile
   overrides it (AC 4):
   - **Enclosed.** On each floor, cells are grouped into **areas**: two
     4-neighbouring non-empty cells are in the same area unless the edge
     between them holds an **enclosing** edge tile (AC 3). An area is
     **open** when any of its cells lies on the map border, or is
     4-adjacent, across a non-enclosing edge position, to an **empty
     cell**. Every cell of an area that is not open is enclosed. (Cells
     are grouped whatever their walkability: furniture inside a room is
     inside the room.)
   - **Covered.** A cell with a non-empty cell at the same `(x, y)` on the
     floor above is covered.
   - An empty cell is never exposed (`tile.exposed` is false there, like
     `tile.has_tag`).

   So the vampire mansion's great hall (walled, with a door to the
   grounds) is enclosed, the attic is enclosed (the void around it is
   outside its walls), the library is both enclosed and covered, the
   roads and parks of the town are open, a walled graveyard with a gate
   is enclosed, and a fenced garden is open once fences do not enclose.
2. `exposed` is **static map data**, like rooms and facings: computed
   once at load, not part of `snapshot()` or `hash()`, and **not updated by
   `set_tile`** (barricading a window or shuttering it changes neither;
   the shipped packs never open a wall). `docs/packs.md` says so.

### Pack schema

3. **`encloses`** is a new optional boolean field of a
   [tile](../docs/packs.md#tiles), allowed only with `edge: true` (a load
   error elsewhere), default **`true`**: whether the edge counts as a wall
   for the enclosure rule. Walls, doors, windows, barricades and shutters
   keep the default; a low fence sets `encloses: false`.
4. **`exposed`** is a new optional boolean field of a tile (cell tiles
   only; a load error on an edge tile): when set, every cell with this
   tile is exposed (`true`) or not (`false`) **regardless of the rule**.
   `exposed: true` on `sunbeam` keeps the sun falling through a window
   inside an enclosed hall; `exposed: false` on an awning or a lean-to
   shades an open yard. Unset (the default) means derived.
5. Both are ordinary top-level tile fields for
   [overrides](../docs/packs.md#mods-and-overrides) (`exposed: null` goes
   back to derived); a tile override that changes `encloses`, `exposed` or
   `edge` changes the exposure of every map that uses the tile, since the
   rule runs on the final stack.

### Expressions

6. **`tile.exposed`** (and `exposed(tile)`) is a new boolean tile member
   in every expression scope: the cell under `self` or, in a tile-targeted
   action, the target cell, as for `tile.has_tag`. It is one array read.
   `docs/expressions.md` documents it next to `tile.in_room`.

### Tools

7. `npm run check -- <packs> --exposure <map id>` prints the map floor by
   floor as ASCII: one character per cell, `.` exposed, `#` enclosed or
   covered (not exposed), a space for an empty cell, with the floor number
   above each; on a map wider than the terminal it still prints every
   column (the output is for files and tests, not pretty printing). An
   unknown map id is an error with *did you mean*. `check` without the
   flag is unchanged.

### Packs

8. **vampire:** `carpet`, `creaky`, `crypt` and `font` lose the `shade`
   tag; `sunbeam` loses `sunlit` and gets `exposed: true` (the sunbeams
   under the mansion's windows and the open ground of the estate both stay
   sunlit; the comment says why). `sunburnt` becomes `when: 'world.is_day
   and tile.exposed and not self.has_item("cloak")'`, `until: 'not
   world.is_day or not tile.exposed'`; `daylight` becomes `when:
   'world.is_day and tile.exposed'`; the dawn quest's `tile.has_tag("shade")`
   becomes `not tile.exposed`. The `crypt` and `blood` tags stay (they
   gate `rest` and `feed`). The vampire plays as before: in the great
   hall by day the vampire is safe on the carpet and burns on a sunbeam;
   in the graveyard it is safe; on the estate's open ground it burns; the
   `std:floor` cells inside the mansion no longer hurt.
9. **garden:** `fence` gets `encloses: false` (the garden is open to the
   sky everywhere; the comment says a fence does not make a room).
10. **town, std:** no tile change needed (`std:wall`, `std:door`,
    `town:window` and the barricade enclose by default). Every shipped
    stack loads and `npm run check` on each passes, and the exposure of
    the town's city is: every house, store and garage interior not
    exposed, every road, park and yard exposed (a test asserts a few
    known cells of `town_center`).

### Tests and docs

11. Headless tests cover:
    - **Rule:** on small ASCII maps with `edges: true`: a walled room with
      a door is enclosed; a room with one wall missing is open; an area
      touching the border is open; a fence (`encloses: false`) encloses
      nothing; a window (`opaque: false`) does enclose; furniture inside a
      room is enclosed; an upper-floor room surrounded by empty cells is
      enclosed and the cells under it are covered; a cell under a balcony
      (no walls, floor above) is covered; `exposed: true` / `false`
      overrides win; empty cells are never exposed; a composite's parts
      are judged on the composed map (a part whose interior touches its
      own border is enclosed once placed inside a filled composite).
    - **Loader:** `encloses` on a non-edge tile, `exposed` on an edge
      tile, non-boolean values; overrides setting and clearing both.
    - **Expressions:** `tile.exposed` in a status, in a system and as the
      target cell of a tile action; false on an empty cell.
    - **Check:** `--exposure` output for a small map, byte-stable.
    - **Vampire:** the scenarios of AC 8 on the estate (`genreCell` for
      mansion coordinates) and that the mansion's plain floors are not
      exposed; the garden is fully exposed; `town_center` cells of AC 10.
    - **Determinism:** the existing hash-equality runs with the converted
      packs (exposure is not hashed, so the vampire hashes may change only
      through the changed rules).
    - **Guards:** the genre-word guard on `src/` (`exposed`, `encloses`
      are engine vocabulary; `sun`, `shade` are not).
12. **Docs.**
    - `docs/packs.md` documents `encloses` and `exposed` in the tiles
      table, the rule in a new "Exposure" subsection under maps (after
      Edge walls), with the note that it is static and ignores `set_tile`,
      and `check --exposure` under Validation.
    - `docs/expressions.md` documents `tile.exposed`.
    - `VISION.md` §7 records the decision under the YAML pain points:
      exposure is **derived from enclosure and cover** at load, static,
      with `encloses` and `exposed` as the two overrides; `shade`/`sunlit`
      tags are gone; §4's `tile.exposed_to_sky` becomes `tile.exposed`.

## Out of Scope

- Updating exposure after `set_tile` (knocking down a wall or building
  one at run time), and exposure as simulation state.
- Light, shadows, weather or temperature: `exposed` is a boolean a pack
  reads; rain and cold are pack rules on top of it.
- Rendering: the day/night tint, cutaways and sprites do not read
  `exposed` (an "indoors is not tinted" rule is a later, visual spec).
- Partial or directional exposure (a cell half under a roof), roof
  layers in Tiled, and a `roofs` map field: cover comes from the floor
  above only.
- A per-cell override in maps (`exposed` on a legend entry or a Tiled
  property); tiles and their overrides cover the shipped cases.
- `tile.indoors` or other synonyms; packs write `not tile.exposed`.

## Design Notes

- **Where it runs.** `MapDef` gains `exposed: Uint8Array` (1 per cell).
  Compute it in the loader right where `rooms` are finalised for ASCII,
  Tiled and composite maps (`load.ts`, the map builders and the
  composite assembler), after `cells`, `edgeN`, `edgeW` are final: a
  flood fill per floor with an explicit stack (no recursion; the city
  has 235 298 cells), O(cells). Treat the edge arrays as the enclosure
  test: `encloses(edgeW[j])` between `(x, y)` and `(x + 1, y)`,
  `encloses(edgeN[j])` between `(x, y)` and `(x, y + 1)`. Then apply
  cover (floor above non-empty) and the tile overrides.
- **Verified on the shipped maps** with a prototype of exactly this rule:
  on the estate every `shade` cell is not exposed, every `sunlit` cell is
  exposed except the 11 sunbeams inside the mansion (hence AC 4), the
  184 `std:floor` cells inside the mansion are not exposed, the attic is
  enclosed, the garden is fully exposed, and the city is 77.6 % exposed
  with every interior enclosed. Standalone part maps whose walls sit on
  their own border read as open; only the composed map matters.
- **Expressions.** `TileRef` (or the `ExprContext` tile accessors used by
  `in_room`) gains `exposed` reading `map.exposed[index]`; `tile.exposed`
  compiles like `tile.in_room` with no argument. Keep `TileRef` cheap: no
  per-call allocation.
- **Check.** Follow `--overrides` in `src/cli/check.ts` and `common.ts`
  for the flag plumbing; the printer is a pure function over `MapDef`
  (testable without the CLI).
- `Grid` does not need `exposed` (the simulation only reads it through
  expressions), but exposing it there is fine if it keeps the hot paths
  untouched.

## Agent Notes

- Read first: `docs/packs.md` (tiles, maps, edge walls, floors, composite
  maps, validation), `docs/expressions.md` (`tile` scope),
  `src/core/load/load.ts` (the ASCII, Tiled and composite map builders;
  `roomSets`), `src/core/definition.ts` (`MapDef`, `TileDef`,
  `EMPTY_TILE`), `src/core/expr/compile.ts` (`inRoom`, `pointArg`),
  `src/cli/check.ts`, `test/maps.test.ts`, `test/edges.test.ts`,
  `test/floors.test.ts`, `test/chunked.test.ts`.
- Suggested order: `TileDef` fields and loader errors; the rule on
  `MapDef`; `tile.exposed`; `check --exposure` (use it to eyeball the
  estate and the city); packs; tests; docs and VISION.
- The vampire scenarios in `test/scenario.test.ts` and `test/town.test.ts`
  use `genreCell('vampire', x, y)` for mansion coordinates (the mansion
  sits at `[49, 54]` in the estate).
- Keep the `id: "…"` frontmatter rule in mind if you add specs; quote
  YAML strings that contain `: ` in pack comments too.
- Chromium is unavailable in the sandbox: everything in this spec is
  headless.
