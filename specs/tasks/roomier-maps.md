---
id: roomier-maps
area: packs
priority: 40
depends_on: []
description: Roomier town and estate maps — bigger house/store/garage/park parts with ≥3-wide rooms and 2-wide hallways, a redone town_center and mansion, 5-wide roads, yards between buildings, a ~308×308 city and a 128×128 estate; zombie/vampire overrides, tests and docs follow the new coordinates, and the M7 move-equivalence test is retired
---

# Roomier maps for the town (zombie) and the estate (vampire)

## Goal

The maps feel cramped. Houses are 11×11 with rooms 1–3 tiles wide, there is
only a 1-tile grass gap between neighbours, and roads are 3 tiles wide. With
dozens of NPCs, players and zombies jam in doorways and corridors. This task
makes the buildings and streets **roomier**: bigger rooms, wider hallways
and doorways, wider roads, and yards between buildings. The maps grow to fit
roughly the same number of buildings and entities.

It covers the `town` pack's `city` and all its parts, which both the base
town game and the zombie mod use, and the vampire `estate`: the mansion,
graveyards and cottages. It is pure content plus the tests and docs that
depend on coordinates. **No engine changes.**

## Acceptance Criteria

### Interior rules (all buildings below)

1. In every building, each **room interior** (floor cells inside the walls)
   is at least **3 tiles wide** along its shorter side. Exceptions: closets
   and bathrooms may be 2 wide, and stairwells may be as wide as the stairs.
2. Corridors and hallways are at least **2 tiles wide**. Every room is
   reachable from the building's entrance without stepping past furniture,
   so furniture never blocks the only path. Furniture stands against walls,
   not in the middle of a walkway.
3. Each building's main entrance is a door with **walkable floor on at
   least 2×2 cells** inside and outside it. A garage may use a 2-wide
   opening (two doors, or a door plus floor) for its car.
4. Every building keeps what it has now: the same kinds of rooms (`room`
   objects with the same tags, which drive loot tables), the same kinds of
   furniture and containers, a comparable amount of each (± ~50 %, more is
   fine), its floors and stairs, windows and the door count. The house
   variants stay distinct (`house_b` keeps broken glass at its front door,
   `house_c` keeps its upstairs bedroom). Fridges still follow the facing
   convention in `packs/town/maps/README.md`.

### Town parts (`packs/town/maps/parts/*.tmj`, edited as Tiled JSON)

5. Target sizes. The implementer may adjust each by a few tiles but must
   then keep the block arithmetic in AC 7 consistent:

   | Part          | Now   | Target |
   |---------------|-------|--------|
   | `house_a/b/c` | 11×11 | ~15×15 |
   | `garage`      | 11×11 | ~15×15 |
   | `store`       | 22×11 | ~30×15 |
   | `park`        | 22×22 | ~30×30 (more open grass, hedges and paths as now, the wreck kept) |
   | `road_h` / `road_v` / `crossing` | 44×3 / 3×44 / 3×3 | block length × **5** / 5 × block length / **5×5** |

6. **`town_center`** is redone to the same rules. It stays the old town
   block: four houses, two on either side of an east–west road through the
   middle, each with a kitchen, bathroom, bedroom and hallway along the
   road. The north-east house keeps its stairs to a second-floor bedroom,
   and there are cars on the road. Its middle road is 5 wide like the city
   roads. Expected size is ~60×30, depending on the house interiors. Its
   in-part `player` marker stays on that road.

### City (`packs/town/maps/city.yaml`)

7. Still a 5×5 grid of blocks with the same **kinds** of block in the same
   places: the centre block (`town_center` plus houses above and below it),
   four commercial blocks (stores, garages, houses), four downtown
   residential blocks, four park corners and residential outskirts. Each
   block is laid out as **lots**, with **at least 2 tiles of grass yard
   between any two buildings** and at least 1 tile between a building and a
   road. Roads are **5 wide**, and there is a grass margin around the edge
   (≥ 9 tiles, as now). The expected result is ~52×52 blocks of 3×3 house
   lots, which makes the city about **308×308**. The exact size follows from
   the parts, but it must be ≥ 280×280 and ≤ 360×360.
8. Residential blocks hold fewer, larger houses: about 9 per block instead
   of 16. Commercial blocks keep at least 2 stores and 2–4 garages. The
   centre block must fit `town_center`, so it may be a different shape
   inside, but it uses the same yard and road rules.
9. `player` sits on `town_center`'s road at its new coordinates.
10. The comment and header at the top of `city.yaml` and
    `packs/town/maps/README.md` ("Layout of the city", "Parts" with their
    sizes and coordinates) are rewritten to match. You may generate the long
    `parts:` list with a throwaway script, but do not commit one unless it
    is small, documented and useful for future edits.

### Zombie (`packs/zombie/outbreak.yaml`)

11. `town:town_center` `spawns` are moved to equivalent spots in the new
    layout: inside the same houses and rooms, one upstairs in the north-east
    house, none on the player's start cell or next to it. The `town:house_c`
    upstairs crawler stays as it is.
12. `town:city` `populate` rects are re-derived for the new block grid,
    with the same density pattern (denser downtown, sparser outskirts, the
    centre block left to its spawns, the fields around the edge). Each
    rect's count is scaled so the **total NPC count stays within ±10 % of
    today's** (`World.create` currently gives 961 entities including the
    player).
13. The zombie victory, a car battery from a garage while in a `garage`
    room, must still be achievable. Garages keep their loot and their
    `garage` room tag.

### Vampire (`packs/vampire/maps/*`)

14. **`mansion.tmj`** (now 22×14) is redone to the same interior rules. It
    keeps the great hall (carpet, crypts, font, coffins) in the middle with
    side rooms west and east, the library (bookshelves facing `s` on the
    north wall) below-west, the wine cellar below-east, room tags `hall`,
    `library`, `cellar`, the windows with sunbeams falling through them, the
    north door to the grounds, and the ladder in the library's south-east
    corner up to the attic `study` (oak chest, a bat). Expected size is
    ~30×20. The player still starts in the great hall.
15. In **`estate.yaml`**, the `cottage` and `graveyard` ASCII parts get
    bigger. Cottages are ~14×10 with a ≥3-wide interior, a 2-wide clear path
    from the door, and a chest and bookshelves against walls. Graveyards
    have 2-wide aisles between the coffin rows and the gate on the south
    side. Keep the same coffin count (±2) and 8 bats per plot.
16. The estate grows to **128×128** (`fill: sunbeam`), with the same
    arrangement: the mansion in the middle, four graveyards (two on each
    side of the upper half), six cottages along the south, and at least 3
    tiles of open ground between any two parts. Bat `populate` rects are
    re-derived to keep the mansion's surroundings clear, and the total
    entity count stays within ±10 % of today's (~154).
17. `packs/vampire/maps/README.md` is updated with the new sizes,
    coordinates and player start.

### Tests and fixtures

18. `GENRE_AT` in `test/helpers.ts` gets the new placements of
    `town:town_center` and `vamp:mansion`. Every genre scenario that uses
    `genreCell` (sight, interaction, recipes, chunked, noise, actions,
    behaviors, and any others) is updated to the matching cells in the
    redone `town_center` and mansion. Each test must still exercise **the
    same thing**: same furniture, room, door, line-of-sight or noise
    situation. Do not weaken assertions to make a test pass. Re-pick seeds
    only where a test documents that its seed was chosen for an RNG
    outcome, and say so in a comment.
19. The **M7 move-equivalence test** (`test/town.test.ts`, "Equivalence
    with the games before the move") compares against the pre-M7 worlds in
    `test/fixtures/m7-*.json`, and this task changes the maps on purpose.
    Retire it: remove that test block, the two fixture files and
    `scripts/equivalence-fixture.ts`. Also remove `test/equivalence.ts` if
    nothing else uses it. Remove the `CHANGED_CONTAINERS` / `RENAMED_ITEMS`
    helpers with it.
20. Size checks are kept or adjusted: `test/chunked.test.ts` (city ≥
    240×240 and estate ≥ 96×96 still hold, so they may stay), and
    `test/pick.test.ts` with its "256×256" title and wording. Update the
    wording where it names a size.
21. **New test, `test/maps.test.ts` or similar:** for the town and vampire
    stacks, load the start map and check:
    - (a) the map size is in the ranges from AC 7 and AC 16;
    - (b) every door is reachable from the player start (the same region
      check `chunked.test.ts` already does, if it doesn't already cover
      this);
    - (c) for each `room` object in the parts, the walkable cells inside
      the room include at least one 3×3 square of walkable cells. Rooms
      tagged `bathroom` and stairwells are exempt (they need only 2×2);
    - (d) every road cell has at least 5 road cells across its width.
      A simple check is: every maximal run of `road` cells, horizontal or
      vertical, that crosses the road is ≥ 5 long.
22. `npm run typecheck`, `npm test` and `npm run smoke` pass.
    `npm run check` (the pack validator) reports no new warnings for the
    town, zombie, vampire and hardship stacks and their joint stacks.

### Docs

23. Every place that states the old sizes is updated: `README.md`,
    `packs/town/pack.yaml` `description`, `docs/packs.md` (the `town` row
    and anything else that names the city size or coordinates),
    `docs/saves.md`, `VISION.md` (status lines naming 256×256 / 96×96),
    `test/scenario.test.ts`'s comment. Leave historical specs in `specs/`
    alone.
24. `docs/perf.md`: re-run `npm run bench:sim` for zombie and vampire and
    update the table rows and the sizes in the text. Steady p95 must stay
    under the recorded 10 ms target. If it rises noticeably (> 2× today's
    0.38 ms), call it out in the doc and in the completion report.

## Out of Scope

- Engine or renderer changes, new tile kinds or new art. Use existing tiles
  only. If a sidewalk would help, use `road` or `grass`; don't add a tile.
- The garden pack and the hardship mod. Hardship only overrides loot and
  recipes, but it must still load and pass.
- New gameplay: new building types, new loot tables, new NPC archetypes.
- Rebalancing zombie or bat counts beyond keeping the totals within ±10 %.
- Updating old specs in `specs/` that mention 256×256.

## Design Notes

- Parts are Tiled JSON (`.tmj` and their per-part `.tsj` tileset). They can
  be edited by script: read the JSON, write a new `data` array and new
  objects, then keep the existing tileset GIDs. Or author a part as an ASCII
  `legend`/`rows` map in YAML, then convert it with
  `npm run map:export -- <pack-dirs>… --map <id> --out <dir>`, which gives
  stable, round-trippable output. Both are fine. The committed result must
  stay `.tmj` + `.tsj`, so it can still be edited in Tiled.
- `room` objects drive loot: keep their names and tags, and make their
  rects cover the new interiors.
- Multi-floor parts (`town_center`, `house_c`, `mansion`) use `floor N`
  groups. Stairs/landing and ladder cells must line up between floors.
- The city's `parts:` list is long and regular. Generating it from a small
  table of block types, then pasting the result, keeps it reviewable.
- Watch the active radius (`start.simulation.active_radius: 64`) and the
  A* budgets in `packs/town/start.yaml`. The bigger city may need a larger
  `player_path_budget` so a long click-to-walk across town still succeeds.
  Adjust it only if a test or smoke run shows the need.
