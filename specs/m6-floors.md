---
id: m6-floors
area: sim
priority: 40
depends_on: [m6-save-load, m6-tiled-maps]
description: M6 multiple floors — maps with stacked floors (ASCII `floors:`, Tiled floor groups), empty cells, `climb` link tiles that A* crosses (stairs and ladders), entities/containers/rooms/actions with a floor `z`, same-floor sight and 3D hearing, iso rendering of stacked floors with upper-floor cutaway and near-wall fading, floor keys and Go up/Go down menu entries, save format v2, and upstairs rooms in both genre packs
---

# M6c — Multiple floors

## Goal

A town has upstairs bedrooms, attics and towers. This spec gives the grid
a third axis: a map is a stack of **floors**, `z = 0, 1, …`. Floors are
joined by **link tiles** (stairs, ladders) that pathfinding crosses, so
the following all work across floors:

- click-to-move;
- walk-then-act;
- zombies pursuing the player upstairs.

In the iso view, the floors above the player are cut away, so you can see
inside buildings. Walls between you and the camera fade.

Every map in use today is a one-floor map and must behave **exactly** as
before.

Playable result:

- In `zombie`, one house has an upstairs bedroom. The player climbs the
  stairs, loots the dresser, and a shambler that heard the window
  follows them up.
- In `vampire`, an attic study above the library holds a chest and a
  bat.

No engine code may be genre-specific.

## Acceptance Criteria

### Map data

1. **Grid.**
   - A `MapDef` gains **`floors`** (≥ 1). `cells` and `facings` hold
     `floors × height × width` entries.
   - The **cell index** becomes `(z * height + y) * width + x`
     everywhere: grid arrays, paths, containers by cell, changed tiles,
     rooms and A*. With `floors = 1` it equals today's `y * width + x`.
   - `Grid` gains `floors`, `inBounds(x, y, z)` and `index(x, y, z)`.
     Every `(x, y)` accessor gains a `z` parameter **defaulting to 0**,
     so one-floor callers are untouched.
2. **Empty cells.**
   - A cell may hold **no tile** (sentinel `EMPTY_TILE`). It is not
     walkable, not opaque, has no container, and is not drawn.
   - `grid.tileAt` returns `undefined` for it. In expressions,
     `tile.id` is `""` and `tile.has_tag(...)` is false.
   - `set_tile` can neither target an empty cell nor make one; both are
     `invalid_target`.
3. **ASCII format.**
   - A map takes either `rows` (one floor, as today) or **`floors`**: a
     list of `{ rows }`, index = `z`. All floors must have the same size.
     The errors name the floor (`floors[1].rows[3]`).
   - In every floor, the **space character means empty** unless the
     legend defines `" "`.
   - `player` and `spawn` legend cells may be on any floor.
   - `rooms[]` gains **`floor`** (default 0, must exist).
   - Spawns are ordered by `z`, then row-major.
4. **Tiled format.**
   - A **group layer** with an integer custom property **`floor`** holds
     that floor's tile layers and object layers.
   - Layers outside any floor group belong to floor 0, so `m6-tiled-maps`
     maps are unchanged.
   - Floor numbers must be unique and contiguous from 0; a nested floor
     group is a load error.
   - A cell empty on every layer of its floor is now an **empty cell**,
     not an error.
   - The exporter writes one `floor N` group per floor. The round-trip
     test from `m6-tiled-maps` covers multi-floor maps.
5. **Links.**
   - Tiles gain **`climb: up | down`**. A cell whose tile has
     `climb: up` is **linked** to the same `(x, y)` one floor up;
     `down`, one floor down.
   - A link is an edge in both directions. The far cell does not need a
     `climb` of its own.
   - The edge exists **only while both ends are walkable**, checked live,
     so `set_tile` can block or open stairs.
   - At load, a `climb` cell whose far cell is outside the map or not
     walkable in the map data is a load error naming both cells.
   - `climb` on a non-walkable tile is a load error.

### Simulation

6. **Entities and intents.**
   - Entities gain **`z`**, **`fromZ`** and **`homeZ`**. The planned and
     heard cells gain `z`.
   - `GotoIntent` gains optional **`z`**, which defaults to the entity's
     current floor. `adjacent` looks only at the goal's own floor.
   - `StepIntent` stays on the entity's floor and never takes a link.
   - **`world.climbIntent(dz: 1 | -1)`** returns the goto that crosses
     the link at the player's cell in that direction, or `null` when
     there is none. Shells use it for the climb keys.
7. **Pathfinding.**
   - A* searches the 3D grid. Its neighbours are the 8 same-floor
     neighbours (no corner cutting, as today) plus the **link** at the
     cell, if any, with cost **1**.
   - The heuristic stays octile on `(x, y)`, which remains admissible.
   - Tie-breaking stays deterministic: the link neighbour comes after the
     8 directions.
8. **Moving across a link.**
   - Moving along a path across a link is one step. It uses the
     archetype's `ticksPerStep`, sets `fromZ`, and does **not** turn the
     entity: facing is unchanged and there is no turn beat.
   - `renderPosition` interpolates `z` like `x`/`y`.
9. **Reach and targets.**
   - Containers, tile actions, stations, `take`/`put` and ground piles
     all require the **same floor** (Chebyshev ≤ 1 on `x, y`).
   - `containersAt(x, y, z?)`, `interactionsAt(x, y, z?)` and
     `roomTagsAt(x, y, z?)` take an optional `z`, which defaults to the
     player's floor.
   - `ActAction`/`CraftAction` gain an optional `z` with the same
     default.
   - `drop` puts the pile on the player's floor.
10. **Sight and hearing.**
    - `can_see` and `lineOfSight` are **false across floors**.
    - Hearing uses 3D euclidean distance, with one floor counting as one
      tile. Walls and floors still do not muffle.
11. **Expressions.**
    - `self.z` and `tile.z` are readable.
    - `manhattan`, `chebyshev` and `euclidean` include `|dz|` as one tile
      per floor.
    - `tile` is the cell under `self` on `self`'s floor. For tile actions
      and stations it is the target cell.
12. **Behaviors.**
    - `pursue`, `investigate` and `home` path in 3D, so NPCs follow
      across links.
    - `wander` and `flee` pick goals on the entity's own floor only.
    - RNG draw order is unchanged.
13. **Containers and loot.**
    - Tile containers get ids in `z`-major, row-major order, then
      inventories, as today.
    - Loot distributions use the room tags of the container's own floor.
14. **Snapshot and save.**
    - Entity `z`, `fromZ`, home `[x, y, z]`, path cells `[x, y, z]`, plan
      and heard with `z`, activity `z`, `lastGoto.z`, container cells
      `[x, y, z]` and changed tiles `[x, y, z, tileId]` are added to the
      snapshot and `hash()`.
    - `SaveFile.version` becomes **2** and `map` gains `floors`.
      `World.restore` still reads **version 1** saves, treating every
      `z` as 0.
    - `assertRoundTrip` passes on multi-floor worlds, including saving
      mid-climb.

### Rendering and shells

15. **Iso projection.**
    - Floor `z` is drawn raised by `z × FLOOR_H` screen px, with
      **`FLOOR_H = BLOCK_H`**, so a floor sits on top of the walls below
      it.
    - Draw order is floor by floor: floor 0 ground, floor 0 objects,
      floor 1 ground, and so on.
    - Each floor keeps the existing per-diagonal depth buckets.
    - Empty cells draw nothing, so lower floors and the outside show
      through.
16. **Cutaway.**
    - The **view floor** is the player's floor; while climbing it switches
      at the step's midpoint.
    - Floors **above** the view floor are hidden: ground, blocks, piles,
      entities and markers.
    - On the view floor, a raised block **fades** to alpha 0.35 when it
      is in front of the player and close on screen: its diagonal
      `x + y` is in `(px + py, px + py + 3]` and
      `|(x − y) − (px − py)| ≤ 2`.
    - The rule is a pure function in `src/iso/` with unit tests. A
      one-floor map with no raised blocks in front of the player renders
      exactly as before.
17. **Picking.**
    - `pickTile` picks on the view floor, with its offset. When that cell
      is empty, it falls through to lower floors in order, so clicking the
      street from a balcony works.
    - Clicks return `{ x, y, z }`. Click-to-move issues a goto with that
      `z`.
18. **Browser input.**
    - **PageUp/PageDown** and **`<`/`>`** (by `KeyboardEvent.key`)
      queue `climbIntent(+1/−1)`.
    - The context menu gets **"Go up"** and **"Go down"** entries on
      link cells. The new interaction kind `climb` issues a goto to the
      far end, walking there first when needed, and is placed before
      `walk`.
    - The HUD shows `Floor N` when the map has more than one floor.
19. **Terminal.**
    - The ASCII view shows the player's floor. Empty cells are spaces,
      and the status line adds `Floor N` on multi-floor maps.
    - **`<`/`>`** climb via `climbIntent`. With no link, the message
      line shows `No way up here.` or `No way down here.`
    - The `x` action list includes Go up/Go down when available.

### Packs (two-genre rule)

20. **std:**
    - New tile **`stairs`**: walkable, raised, not opaque, `climb: up`,
      glyph `<`.
    - New tile **`landing`**: walkable, flat, glyph `>`. It is the floor
      cell at the top of the stairs.
    - Their pixel art is generated by `art/std.mjs`, following
      `docs/art.md`. The stairs block shows steps rising toward its
      facing, and is directional (4-way, mirrored).
21. **zombie:**
    - One town house gains a **second floor**, with stairs in its
      hallway, a bedroom (room tag `bedroom`, dresser and bed, so loot
      rolls) and a window.
    - One shambler starts upstairs.
    - The rest of floor 1 is empty, so the street shows through.
22. **vampire:** the mansion gains an **attic study** above the library,
    with a ladder-like stairs tile, a `chest` (room tag `study`, with a
    loot distribution), and a `bat` spawn.
23. **Reachability.** The existing reachability tests extend to every
    floor: every container and every walkable cell on every floor is
    reachable from the player start.

### Tests and docs

24. Headless tests cover:
    - **Loader:** ASCII `floors`, spaces as empty, `rooms[].floor`,
      Tiled floor groups and every new load error.
    - **Grid:** cell indexing, and that one-floor maps keep identical
      indices.
    - **A*:** across one and two links, a link that `set_tile` blocks,
      determinism and tie order.
    - **Movement:** a link step's timing, facing and `fromZ`; StepIntent
      never climbs.
    - **Reach:** containers and actions on another floor are
      `out_of_reach`.
    - **Sight and hearing:** sight across floors is false, and 3D
      hearing distance.
    - **Behaviors:** a pursuer follows the player upstairs.
    - **Save:** round trip on multi-floor worlds, and v1 → v2 load.
    - **Renderer:** the cutaway and fade rules, picking fall-through and
      the floor offset, as pure functions.
    - **Shells:** the browser climb keys and the menu entries; the
      terminal `<`/`>` and floor rendering.
    - **Scenarios:**
      - zombie: the player climbs, loots the upstairs dresser, and a
        shambler follows after a noise;
      - vampire: the player reaches the attic and opens the chest.
    - **Guards:** the genre-word guard and all determinism tests still
      pass. Hashes are compared run against run; their values change
      because the snapshot shape changes.
25. **Docs.**
    - `docs/packs.md`: `maps` (floors, empty cells, `rooms[].floor`, Tiled
      floor groups), `tiles.climb`, and floors in reach and sight.
    - `docs/expressions.md`: `z` and the distance rules.
    - `docs/iso.md`: `FLOOR_H`, draw order, cutaway, fade and picking.
    - `docs/ui.md`: the new keys.
    - `docs/saves.md`: version 2.
    - `VISION.md` §7 records the decisions:
      - floors are `z ≥ 0` with link tiles;
      - A* crosses links;
      - there is no sight across floors and hearing is 3D;
      - floors above the player are cut away.

## Out of Scope

- Basements (`z < 0`), falling, jumping, and climbing through windows.
- Multi-cell stairs footprints, ramps, and partial heights.
- Seeing up or down through holes in the simulation (sight stays
  same-floor), and roofs as their own layer.
- Elevators and timed or locked links. Packs can block a link with
  `set_tile` through a pack action.
- Per-floor lighting, and dimming lower floors.
- Rotating the camera.

## Design Notes

- Do the cell-index change first, as a pure refactor with `floors = 1`
  and no behaviour change; every test should stay green. Then add `z`.
  That isolates the risky part.
- `Grid.link(i)`: precompute a per-tile `climb` direction (`0`, `+1`,
  `−1`) and resolve the far index as `i ± width × height`, checking both
  ends' `walk` live. A* asks it once per expanded node.
- `EMPTY_TILE = 0xffff` fits the existing `Uint16Array`. The loader
  should reject more than 65 535 tiles, which is far beyond any pack.
- The renderer's per-diagonal buckets (`depth.ts`) become per
  `(floor, diagonal)`. Hide a whole floor by toggling its root
  container's `visible`. Do not walk sprites.
- `pickTile` already handles raised blocks. Run it once per candidate
  floor with the iso origin shifted by `z × FLOOR_H`.

## Agent Notes

- Read these first:
  - `src/core/sim/grid.ts`, `astar.ts`, `world.ts` (every
    `y * width + x` and `width` use), `behavior.ts`, `sight.ts`;
  - `src/core/sim/save.ts` (from `m6-save-load`);
  - `src/core/load/tiled.ts` (from `m6-tiled-maps`);
  - `src/iso/scene.ts`, `projection.ts`, `depth.ts`.
- `grep -n "\* width\|\.width +\|% .*width"` finds most index
  arithmetic. `Pathfinder` arrays must be sized to all floors.
- Edit the zombie and vampire maps in their `.tmj` files, by script or
  by hand, keeping the exporter's key order. Re-run the reachability
  tests after each edit.
- Chromium is unavailable in the sandbox. Keep renderer rules in pure,
  tested functions.
