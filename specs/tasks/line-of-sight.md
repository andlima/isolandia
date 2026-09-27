---
id: line-of-sight
area: sim
priority: 30
depends_on: []
description: M4 groundwork — tiles get an `opaque` flag (default `!walkable`), a deterministic, symmetric, allocation-free grid line of sight in src/core/sim, and a `can_see(a, b[, range])` expression built-in; both genres add an `alert` status on NPCs that see the player; no behaviors or AI
---

# Line of sight (M4 groundwork)

## Goal

M4 is perception (sight and noise) plus `behaviors`. `npc-movement` already
lets any entity move. This task adds the **sight primitive**: a way to ask
"can entity A see entity/tile B?" over the tile grid. Pack data exposes it
through one expression built-in, so statuses and systems (and later M4
behaviors) can react to it.

It adds no AI, no behaviors and no noise. Nothing moves differently.
Perception becomes observable through statuses only.

## Acceptance Criteria

### Pack schema: tile `opaque`

1. `tiles[]` gets an optional boolean **`opaque`** field that defaults to
   **`!walkable`**, the same way `raised` does. Walls, cars, fridges and
   bookshelves block sight. Floors, doors and grass do not. `TileDef` gains
   `readonly opaque: boolean`, and the loader handles the field through the
   existing `Fields` list, so an unknown field is still an error.
2. The vampire `window` tile (not walkable) sets **`opaque: false`**. You can
   see through a window but can't walk through it. No other tile needs an
   explicit value, but add one wherever the default reads wrong.

### Grid and line-of-sight algorithm (`src/core/sim/`)

3. `Grid` gains a row-major **`opaque: Uint8Array`**, built next to `walk`,
   and an `opaqueAt(x, y)` helper. Out of bounds counts as opaque.
4. A pure function, for example `lineOfSight(grid, x0, y0, x1, y1): boolean`
   in a new `src/core/sim/sight.ts`, with these required properties:
   - **Endpoints are ignored.** Only cells strictly between the two points
     are tested, so an entity standing next to a wall, or looking at a wall
     tile, is not blocked by that wall. Same cell and adjacent cells
     (Chebyshev 1) are always visible.
   - **Symmetric.** `lineOfSight(a, b) === lineOfSight(b, a)` for every pair
     of in-bounds cells.
   - **No seeing through diagonal wall corners.** If the line passes
     diagonally between two orthogonally adjacent cells that are both
     opaque, it is blocked. This mirrors `canStep`'s no-corner-cutting rule.
   - **Deterministic and integer-only.** No floating-point accumulation
     that could differ between platforms, no RNG, and **no allocation per
     call**.
   - **Entities never block sight.** Only tiles do.
   - Either endpoint out of bounds returns `false`.
5. The recommended approach, which is not mandatory as long as the
   properties hold: walk an integer Bresenham line from a to b, and also
   from b to a, and treat the pair as visible if either walk is clear. The
   OR makes the result symmetric. During each walk, a diagonal step is
   blocked when both of its orthogonal neighbours are opaque.

### Expression built-in: `can_see`

6. **`can_see(a, b)`** and **`can_see(a, b, range)`**:
   - `a` and `b` are entities or tiles (`isPointType`), like the distance
     functions.
   - `range` is numeric. When given, the result is `false` if
     `euclidean(a, b) > range` (inclusive at exactly `range`). This
     **range check runs before the line walk**, so far-away pairs cost
     O(1).
   - The result is boolean, so it works in arithmetic like `is_day`.
   - Argument-count and type errors are load errors, with messages in the
     style of `distanceCheck`.
7. The compiled expression reaches the grid through a new `ExprContext`
   member, for example `los(x0, y0, x1, y1): boolean`, that `World` wires
   to `lineOfSight` over its grid. Evaluation must not allocate: no
   argument arrays on the hot path if the generic `Builtin.impl` path would
   allocate. Follow how `has_tag` / `has_status` are special-cased if
   needed.
8. `can_see` appears in `BUILTIN_NAMES`, so the unknown-function "did you
   mean" hint knows it. It has **no** method form.
9. Every other place that builds an `ExprContext` (tests, `check`, fixtures)
   gets a working or stub `los`, so everything compiles and runs.

### Two-genre usage

10. Each genre pack adds an **`alert`** status on its NPCs, driven by sight
    of the player with hysteresis. It only needs to be observable in
    status state, with no gameplay effect required:
    - `packs/zombie`: `for: 'self.has_tag("undead")'`,
      `when: 'can_see(self, player, 8)'`,
      `until: 'not can_see(self, player, 12)'`.
    - `packs/vampire`: the same shape for `bat` (`for:
      'self.has_tag("beast")'`), with ranges you choose.

    The player never gets `alert`, because it lacks those tags. Keep the
    status in the genre packs. Moving a shared version up into a stdpack is
    a later decision.
11. `npm run check` passes for `std,std-needs,zombie` and `std,vampire`.
    The engine guard test still finds no genre or stdpack words in `src/`.

### Tests (`test/`)

12. A new `test/sight.test.ts` using small inline maps:
    - an open room, where everything is visible;
    - a wall between two points blocks sight, and a gap (door) in the wall
      lets it through;
    - endpoints are ignored: an entity next to a wall sees along it, and a
      wall tile itself is visible from the floor in front of it;
    - diagonal corners: two opaque orthogonal neighbours block a diagonal
      line, and one opaque neighbour does not;
    - a non-walkable `opaque: false` tile (window) blocks movement but not
      sight;
    - out-of-bounds endpoints return `false`;
    - **symmetry**: a brute-force check over every pair of cells on a
      seeded random map of at least 12×12 with about 30% opaque cells;
    - `opaque` defaults: omitted equals `!walkable`, and an explicit value
      wins.
13. `test/expr.test.ts`:
    - `can_see` with 2 and 3 arguments, with entity and tile arguments;
    - the range is inclusive at exactly `range`;
    - `1 + can_see(self, player)` evaluates;
    - wrong arity or argument types are load errors;
    - a typo (`can_se`) suggests `can_see`.
14. Scenario tests on the real packs:
    - zombie: an undead NPC with a clear line to the player within 8 tiles
      gets `alert`, and it clears once the player is out of sight (moved
      behind a wall or past 12 tiles);
    - vampire: a bat's alert is triggered through the window, or at least
      the vampire window is not opaque in the loaded definition.

    Place entities or queue intents as needed. `npc-movement` made NPCs
    movable.
15. Determinism: the existing two-genre determinism tests still pass, with
    the same seed and inputs giving the same hash. The hash string may
    change because `alert` now enters the snapshot through statuses.

### Docs

16. `docs/packs.md` `### tiles` table: add the `opaque` row (default
    `!walkable`, explained next to `raised`). In `### statuses`, or where it
    fits best, add a short example using `can_see`.
17. `docs/expressions.md` built-in table: add `can_see(a, b)` /
    `can_see(a, b, range)` and describe the line-of-sight rules briefly
    (tiles only, endpoints ignored, symmetric, no corner peeking, range is
    euclidean and inclusive).
18. `VISION.md`: in §7, record the decision briefly. Sight is **tile-based
    line of sight** with an `opaque` tile flag (default `!walkable`),
    symmetric, entities don't block, exposed as `can_see`. In §8, note that
    sight exists as M4 groundwork. Noise and behaviors stay open.

### Gates

19. `npm run typecheck` and `npm test` pass, and `npm run build` still
    succeeds.

## Out of Scope

- Noise, hearing, or any event system.
- `behaviors`, AI, state machines or utility AI. NPCs react only through
  statuses, and nothing moves differently.
- Field-of-view computation (visible-cell sets), fog of war, or rendering
  what the player or NPCs can see in the shells.
- Light and darkness affecting sight (day/night, `lighting`, tile light
  levels).
- Facing or vision cones, and per-archetype sight ranges as schema fields.
  Range stays an expression argument.
- Entity occupancy or entities blocking sight or movement.
- Caching or visibility precomputation. Per-call cost is O(line length),
  bounded by the range early-out.
- A `can_see` with four numbers (coordinate form).

## Design Notes

- Load: `src/core/load/load.ts` around the tile `Fields` list (line ~349)
  already derives `raised` from `walkable`. Do the same for `opaque`.
- Grid: `src/core/sim/grid.ts` builds `walk` from `tiles[t].walkable`. Build
  `opaque` the same way.
- Expressions: `src/core/expr/compile.ts` has `BUILTINS`, `distanceCheck`,
  `deltas`, `SPECIAL_NAMES` and `METHODS`. The generic builtin path passes
  an `args` array. If that allocates per evaluation, compile `can_see` as a
  special case that reads the coordinates of the compiled argument values
  directly, then applies the range test and `ctx.los`.
- `World` builds `ExprContext` in `src/core/sim/world.ts`. Wire `los` there
  as a closure over the grid, created once rather than per tick.
- Keep the algorithm in its own module so later M4 work (a field-of-view
  set, noise propagation) can reuse the grid accessors without going
  through the expression layer.
