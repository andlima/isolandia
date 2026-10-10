---
id: populate-density
area: load
priority: 45
depends_on: []
description: "Populate by density — `density: n` (entities per 100 candidate cells) as an alternative to `count` on `populate` entries, and a `where` expression over `tile` to pick the cells (rooms, tags, exposure); `check --populate` lists candidates and counts per entry; the zombie outbreak's 36 hand-computed rects become 4 entries over 3 tagged rooms"
---

# Populate by density

## Goal

Spawn grids are hand-computed. `packs/zombie/outbreak.yaml` scatters the
dead over the 343×343 city with **36 `populate` rects**, one per 59×59
block and its roads, each with a count worked out by hand (25 in the
suburbs, 50 plus 6 crawlers downtown, 12 per strip of fields), and the
block of `town_center` left out by not listing it. Re-laying the town,
adding a sixth row of blocks or wanting "twice as many zombies" means
redoing the arithmetic, and a mod that wants a different distribution
copies all 36 lines (`populate` is replaced whole by an override).

`populate` already has what a density needs: a seeded draw over
**candidate cells** that do not depend on the seed, and a `room` filter.
This spec lets an entry say **how dense** instead of **how many**, and
**which cells** with an expression over the cell instead of a rectangle,
so a distribution is a few lines over tagged regions. Load-time only: the
draw, the RNG, world creation and saves do not change.

## Acceptance Criteria

### Pack schema

1. A [`populate`](../docs/packs.md#populate) entry takes **`density`**
   as an alternative to `count`:

   ```yaml
   populate:
     - { archetype: shambler, density: 1.1, room: downtown }   # 1.1 per 100 candidate cells
   ```

   | Field     | Type         | Notes |
   |-----------|--------------|-------|
   | `density` | number > 0   | Entities per **100 candidate cells**; the count is `round(density × candidates / 100)` |
   | `where`   | expression   | Keeps only the candidate cells where it is truthy (AC 3) |

   - Exactly one of `count` and `density` is required; both, neither, or a
     non-positive or non-numeric `density` are load errors.
   - The count is computed per **placement**, from that placement's
     candidates on the composed map (a part's `rect`, `floor` and `room`
     are offset as today): a part map with a density entry placed five
     times gets five draws, each sized by its own candidates.
   - A density that rounds to **0** places nothing and is **not** an
     error (a `density: 0.1` in a 20-cell room); `check --populate` shows
     it (AC 5).
2. **Candidates** are as today (walkable, no container tile, not the
   player start, in the rect, floor and room) **and** where `where` holds.
   The count check of a `count` entry and the overlap check ("might not
   fit after earlier entries") run unchanged on the final candidates, with
   the derived count for density entries.
3. **`where`** is an expression evaluated **once per candidate cell at
   load**, with `tile` = that cell (`tile.x`, `tile.y`, `tile.z`,
   `tile.id`, `tile.has_tag`, `tile.in_room`, and any later tile member),
   as the target cell of a tile action. `self`, `player`, `npc`, `world`,
   `random` and `roll` are load errors naming the field ("populate
   `where` sees only `tile`"), as is a non-boolean result type. `room:
   bedroom` and `where: 'tile.in_room("bedroom")'` give the same
   candidates; `where` is for what `room` cannot say:

   ```yaml
   where: 'tile.in_room("downtown") and not tile.in_room("center")'
   where: 'tile.has_tag("grass")'
   ```
4. `density` and `where` are fields of a populate entry: an override
   replaces the `populate` list whole, as today.

### Tools

5. `npm run check -- <packs> --populate` prints, for every map with
   populate entries (parts expanded per placement, in application order),
   one line per entry: the map, the archetype, `count N` or `density d →
   N`, the candidate cells after `where`, and the cells left after
   earlier overlapping entries; then the map's total. Unchanged without
   the flag.

### Packs

6. **zombie:** `town:city`'s override gains three `rooms` in composite
   coordinates, `town` (`[9, 9, 325, 325]`, the 5×5 grid of blocks and
   roads), `downtown` (`[73, 73, 197, 197]`, the 3×3 around the centre)
   and `center` (`[137, 137, 69, 69]`, `town_center`'s block), and its
   `populate` becomes four entries: shamblers and crawlers downtown
   excluding the centre, shamblers in the rest of the town, and shamblers
   in the fields (`not tile.in_room("town")`), with densities chosen so
   the city gets **within ±10 %** of today's 896 populated entities (848
   shamblers, 48 crawlers) and the same shape (denser downtown, sparse
   fields, the centre block left to its spawns). The comment explains the
   densities in one line each. `town:house_c`'s `count: 1` crawler stays.
7. The zombie scenario and determinism tests are updated for the new
   placement (entity ids and positions change once); every shipped stack
   loads and `npm run check` on each passes; `docs/perf.md`'s entity count
   stays about 960 (note the new figure).

### Tests and docs

8. Headless tests cover:
   - **Loader:** both/neither of `count`/`density`, bad densities, every
     `where` error (forbidden scope names, `random`, non-boolean), and
     that `where` composes with `rect`, `floor` and `room`.
   - **Counts:** a density entry on a known map places `round(d × c /
     100)` entities; rounding to 0 places none without error; per
     placement on a part placed twice; the overlap check with a density
     entry before a `count` entry; `where` narrowing the candidates.
   - **Determinism:** the same seed gives the same placement; the draw
     for other entries and the loot RNG are unchanged (hash of a world
     whose populate uses `count` is the same as before this spec).
   - **Check:** `--populate` output for a small map, byte-stable.
   - **Zombie:** the city's populated total within the band of AC 6, the
     centre block holding only its six spawns, and downtown denser than
     the suburbs per block.
9. **Docs.** `docs/packs.md` (populate) documents `density`, `where` and
   the rounding; Validation documents `check --populate`; `VISION.md` §7
   records the decision under the YAML pain points: spawn density is
   **per candidate cell over tagged rooms**, with `where` as the cell
   filter; no Tiled region layer was needed because rooms already tag
   regions on every map kind.

## Out of Scope

- Changing the draw (without replacement, dedicated RNG), the application
  order (parts first, then the map's own) or when populate runs (world
  creation only; no respawn, no re-populate on restore).
- Density per **area** rather than per candidate cell, `min`/`max` clamps
  on a density count, or a seed-dependent count.
- Weighted archetype lists in one entry (`archetypes: { shambler: 9,
  crawler: 1 }`), groups or hordes, and placement constraints such as a
  minimum distance between entities or from the player.
- `where` reading anything but the cell (no `world`, no entity): it runs
  at load, before a world exists.
- List operators for `populate` in overrides (a mod still replaces the
  list; `density` makes the replacement short).

## Design Notes

- **Loader.** `populateEntries()` in `src/core/load/load.ts` parses the
  entry; add `density` and `where` to its `Fields` list, compile `where`
  with a tile-only scope (a new scope flag like the `npc` one in
  `compile.ts`: `self`/`player`/`world`/`npc` and `random`/`roll` become
  errors) and store the compiled closure on `PopulateDef` (`count:
  number | null`, `density: number | null`, `where: ((ctx) => boolean) |
  null`).
- **Candidates.** `populateCandidates()` in `definition.ts` is the single
  source for both the load check and world creation; give it the `where`
  test using a lightweight `TileRef`-like context (cell position, tile
  id, tags, rooms via `map.rooms.cellSet`). Resolve the derived count
  there too (`populateCount(map, tiles, p)`), so `checkPopulate()`,
  `World` and the `--populate` printer agree by construction.
- **Composite offsets.** A part's entries are offset in `assembleComposite`
  (`populate.push({ ...e, x: e.x + p.x, y: e.y + p.y })`); the `where`
  closure sees composite coordinates then, which is what `tile.in_room`
  on the composite's rooms needs. Candidates and counts per placement are
  computed on the composed map, like the count check today.
- **Rooms on the city.** Today `town:city` has no `rooms`, so the zombie
  override's list replaces nothing. `tile.in_room("center")` resolves the
  tag at load like `room: center` does (`roomTag()`), in the pack that
  wrote the field.
- **Check.** Follow `--overrides` in `src/cli/check.ts` / `common.ts`.

## Agent Notes

- Read first: `docs/packs.md` (composite maps, populate, rooms),
  `src/core/load/load.ts` (`populateEntries`, `checkPopulate`,
  `withPopulate`, the composite assembler), `src/core/definition.ts`
  (`PopulateDef`, `populateCandidates`), `src/core/sim/world.ts` (the
  populate loop near `populateCandidates`), `src/core/expr/compile.ts`
  (scope flags), `test/chunked.test.ts`, `test/maps.test.ts`.
- Suggested order: `PopulateDef` and loader; `where` scope in the
  compiler; candidates and counts; `check --populate` (use it to pick
  the zombie densities); the zombie conversion; tests; docs and VISION.
- Candidate counts in the city include upstairs floors (59 houses have a
  second floor) and exclude walls and furniture, so a 69×69 block has
  about 4 400 candidates, not 4 761: pick densities from `--populate`,
  not from the rect area.
- Keep the `id: "…"` frontmatter rule in mind if you add specs; quote
  YAML strings that contain `: ` in pack comments too.
- Chromium is unavailable in the sandbox: everything in this spec is
  headless.
