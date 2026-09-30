---
id: npc-behaviors
area: sim
priority: 30
depends_on: []
description: M4 core — a pack-defined `behaviors` domain (declarative state machines with `on`/`timeout`/`done` transitions and built-in activities idle, wander, pursue, flee, home), bound per archetype, run in a new think phase that issues per-entity movement intents; zombies wander and chase on `alert`, bats roost, flee and fly home
---

# NPC behaviors: declarative state machines (M4 core)

## Goal

`npc-movement` made every entity movable through intents. `line-of-sight`
gave packs `can_see` and an `alert` status on NPCs. Neither of them makes
anything move by itself. This task adds the missing piece: a **`behaviors`**
domain in which a pack declares a **state machine**. Each state runs one
built-in **activity** (`idle`, `wander`, `pursue`, `flee`, `home`), and
**transitions** are ordinary expressions. Archetypes opt in with
`behavior: <id>`. Each tick, a new **think** phase turns the current
activity into a movement intent. The existing intent machinery then applies
it.

The playable result: in `std,std-needs,zombie`, shamblers and crawlers
wander around their spawn point, chase the survivor once they are `alert`,
and give up after losing sight of them. In `std,vampire`, bats wander their
roost, flee from the vampire when `alert`, and fly home once calm.

This decides the VISION §7/§8 question "state machine vs utility AI" in
favour of **state machines for now**. Utility AI remains possible later as
another activity or selector. Noise, combat and NPC actions are **not**
part of this task.

## Acceptance Criteria

### Pack schema: `behaviors` domain

1. New domain **`behaviors`**: a list of entries with their own id space
   (namespaced like every other domain, and listed in the loader's domain
   table so an unknown key is still an error):

   | Field     | Type                          | Default  | Notes |
   |-----------|-------------------------------|----------|-------|
   | `id`      | id                            | required | |
   | `initial` | state name                    | required | Must be a key of `states` |
   | `states`  | mapping name → state          | required | Non-empty; names match `[a-z][a-z0-9_]*` |

   A **state** is a mapping:

   | Field     | Type                                  | Default | Notes |
   |-----------|---------------------------------------|---------|-------|
   | `do`      | `idle` \| `wander` \| `pursue` \| `flee` \| `home` | required | The activity |
   | `target`  | expression (entity or tile)           | —       | **Required** for `pursue`/`flee`, a load error for the others. Compiled with `self` = the entity; its type must be a point type (`isPointType`), e.g. `player` |
   | `radius`  | integer ≥ 0                           | none    | `wander` only: maximum Chebyshev distance from home. Omitted = unbounded |
   | `repath`  | sim seconds > 0, whole ticks          | `1`     | `pursue` only: minimum interval between A* re-plans (rules as for `systems.every`) |
   | `on`      | list of `{ when: expr, to: state }`   | `[]`    | Checked in order, and the first truthy `when` wins |
   | `timeout` | `{ after: sim seconds, to: state }`   | none    | Fires once the entity has been in the state for `after` seconds (whole ticks, > 0) |
   | `done`    | state name                            | none    | `home` only: the state to switch to once the entity is home, or when the home path fails |

   Every `to`/`done`/`initial` must name an existing state of the same
   behavior. Unknown fields, a missing `target` or a misplaced one, a
   non-point `target`, an unknown `do`, a bad `radius`, `repath` or `after`,
   or `done` on a non-`home` state are **load errors**, reported with source
   positions like other domains. `npm run check` reports them.
2. **`archetypes[].behavior`**: an optional reference to a behavior id,
   resolved like other references (short or qualified). An unknown id is a
   load error. `ArchetypeDef` gains `behavior: number | null` (an index).
3. `Definition` gains `behaviors: BehaviorDef[]` and `ids.behaviors`. States
   are resolved to indices at load, and expressions are compiled closures, so
   the runtime does no string lookups.

### Runtime (`src/core/sim/`)

4. **Per-entity behavior state.** `Entity` gains `homeX`/`homeY` (its spawn
   cell, fixed), plus, for entities whose archetype has a behavior,
   `state` (state index), `stateTick` (tick at which the state was entered)
   and whatever pursue bookkeeping is needed (for example the last planned
   target cell and plan tick). Entities without a behavior have
   `state = -1` and cost nothing in the think phase.
5. **The player is never driven by a behavior.** `world.player` skips the
   think phase even if its archetype has `behavior`. It remains controlled
   by input.
6. **Think phase.** `World.step()` gets a new first phase, before intents:
   for each entity with a behavior, in ascending id order:
   1. **Transitions.** Check the current state's `on` entries in order (with
      `ctx.self` = the entity), then its `timeout`
      (`tick - stateTick >= afterTicks`), then `done` (see `home`). The first
      one that fires switches state: set `state` and `stateTick = tick`,
      clear the entity's `path` and pending `intent`, and reset the pursue
      bookkeeping. **At most one transition per entity per tick.** The new
      state's activity then runs in this same tick.
   2. **Activity.** Run the current state's activity (below). An activity
      may set the entity's pending intent. It never moves the entity
      directly. Movement happens in phase 1 through the existing
      `applyIntent`, so walls, corner rules, `ticks_per_step` cooldowns and
      A* behave exactly as for queued intents.

   Entities on cooldown still think (transitions must not lag), but
   activities that step (`wander`, `flee`) only issue a step when
   `moveCooldown <= 1`, which means the step will fire in this tick's phase 1.
   Externally queued intents on a behavior-driven entity may be overwritten
   by its activity. That is expected.
7. **Activities:**
   - **`idle`**: does nothing (it doesn't clear an existing path either;
      transitions already clear it).
   - **`wander`**: when the entity is ready to step and has no path, take
      **one** draw from the world RNG (`world.rng`) and pick one of 8
      directions or "stay" from it. Issue a `step` intent only if
      `grid.canStep` allows it and the destination is within `radius`
      (Chebyshev) of home. Otherwise the entity stays this tick. There are
      no draws when the entity is not ready. Use preallocated, frozen step
      intents so wandering does not allocate per tick.
   - **`pursue`**: evaluate `target` to a cell. If the entity is already
      Chebyshev-adjacent to (or on) it, clear the path and do nothing.
      Otherwise queue `{ kind: 'goto', x, y, adjacent: true }` when there
      is no active path, **or** when the target cell has changed since the
      last plan and at least `repath` ticks have passed since that plan.
      So there is at most one A* per pursuing entity per `repath` window.
      An unreachable target leaves `lastGoto.ok === false`, and the entity
      stays put until the next re-plan window.
   - **`flee`**: when ready to step, among the 8 neighbours allowed by
      `grid.canStep`, pick the one that maximizes the squared euclidean
      distance to `target`. Only pick one that **strictly increases** it
      compared with the current cell, and break ties by a fixed direction
      order. Issue a `step` intent for it, or nothing if cornered. No RNG
      and no A*.
   - **`home`**: on entering the state (or when there is no path and the
      entity is not home), queue a `goto` to `(homeX, homeY)`, once per
      entry. `done` fires on a later tick once the entity is on its home
      cell, **or** when that goto failed (`lastGoto.ok === false` for the
      goto issued in this state). Without `done`, the entity simply idles at
      home.
8. **Tick order** becomes: **0. think** (behaviors) → 1. intents, then
   actions → 2. drift → 3. systems → 4. clamp → 5. statuses → 6. defeat →
   7. `tick++`. Transitions therefore see the statuses computed at the end of
   the previous tick (e.g. `alert` from `can_see`). The think phase is
   skipped after defeat, like everything else.
9. **Determinism.** The RNG is only drawn by `wander`, in id order, so same
   definition + seed + inputs ⇒ same hash. `EntitySnapshot` gains `home:
   [x, y]` and `behavior: { state: string, since: number } | null` (plus any
   pursue bookkeeping that affects future ticks). The snapshot still
   round-trips through `JSON.stringify`. Hash strings change, and that is
   expected.
10. **Cost.** Entities without a behavior add no work beyond the loop check.
    No per-tick allocation for `idle`/`wander`/`flee`. A* runs only from
    `pursue`/`home` goto intents, bounded as above.
11. **No genre words in `src/`.** The engine guard test must still pass.
    `wander`, `pursue`, `flee`, `home` and `idle` are generic engine
    vocabulary.

### Two-genre usage

12. **`packs/zombie`**: a behavior (for example `zmb:shambler`) used by both
    `shambler` and `crawler`:
    - `wander` (`radius` ~6): `on: self.has_status("alert") → chase`;
    - `chase`: `pursue`, `target: player`: `on: not
      self.has_status("alert") → search`;
    - `search`: `idle` (or a short-radius `wander`): `on: alert → chase`,
      `timeout` ~5 s → `wander`.

    The crawler is slower only through its existing `ticks_per_step`.
    Zombies do **no damage** in this task.
13. **`packs/vampire`**: a behavior for `bat`:
    - `roost`: `wander` (`radius` ~3): `on: alert → flee`;
    - `flee`: `flee`, `target: player`: `on: not alert → return`;
    - `return`: `home`, `done → roost`, `on: alert → flee`.

    Tune ranges so it plays sensibly on the mansion map. `humanoid` spawns
    get no behavior.
14. `npm run check` passes for `std,std-needs,zombie` and `std,vampire`.

### Tests (`test/`)

15. A new `test/behaviors.test.ts`, mostly with small inline fixture packs:
    - loader: every error from AC 1–2 is reported (a spot check of each
      class), a valid behavior loads with resolved indices, and a short and
      a qualified `behavior:` reference both resolve;
    - `idle` never moves the entity. `wander` stays within `radius` over
      1000+ ticks, respects walls and moves at the archetype's
      `ticks_per_step`. A world with no behavior-driven entities draws no
      RNG in the think phase (`world.rng.state` unchanged);
    - transitions: `on` order (first match wins), `timeout` after exactly N
      ticks, at most one transition per tick, and a transition clears path
      and intent;
    - `pursue` reaches adjacency to a moving target, and re-plans at most
      once per `repath` window (count `lastGoto` objects). An unreachable
      target fails cleanly;
    - `flee` strictly increases distance each step it takes and stops when
      cornered;
    - `home` walks back to the spawn cell and then fires `done`, and a
      failed home path also fires `done`;
    - the player ignores a `behavior` on its archetype;
    - the think phase is skipped after defeat.
16. Scenario tests on the real packs:
    - zombie: with the survivor placed in plain view, a shambler becomes
      `alert`, enters `chase` and ends Chebyshev-adjacent to the player
      within a bounded number of ticks. After the player is moved out of
      sight, it ends up back in `wander` via `search`;
    - vampire: a bat that sees the vampire enters `flee` and its distance to
      the player grows. Once out of sight it goes `return` → `roost` near its
      spawn.
17. Determinism: 1000+ tick runs on both genres, with behaviors active and
    some player input, produce identical `hash()`/`snapshot()` across two
    runs.
18. Existing tests that assumed NPCs stand still on the real packs (for
    example the `world.test.ts` "Non-player entities stand still" check and
    `npc-movement.test.ts` cases that drive shamblers by hand) are updated.
    Move them to inline fixtures without behaviors, or assert the new
    behavior. Do not weaken what they verify about the intent machinery.

### Docs

19. `docs/packs.md`: a new `### behaviors` section (schema table, each
    activity's exact semantics, the transition order `on` → `timeout` →
    `done`, one transition per tick, player exemption, and an example), the
    `behavior` row in `### archetypes`, and `### Tick order` updated with
    phase 0.
20. `VISION.md` §7: record the decision. `behaviors` are **declarative state
    machines** with built-in activities (`idle`, `wander`, `pursue`, `flee`,
    `home`) and expression transitions, ticked in a think phase that only
    issues movement intents. Utility AI is deferred. §8: sight and behaviors
    are delivered. Noise, NPC actions and combat remain open. Update the M4
    row status only if you consider M4 playable ("a horde that hears the
    window breaking" still needs noise, so it most likely stays open).

### Gates

21. `npm run typecheck`, `npm test` and `npm run build` pass.

## Out of Scope

- Noise, hearing, and "last known position" memory. `pursue` always uses the
  target's current cell.
- Utility AI, behavior trees, nested or hierarchical states, and
  per-state enter/exit effects.
- Combat, damage from adjacency, and NPC actions (take/put/drop/use).
- Entity occupancy or collision (entities still overlap freely).
- Targets other than a single point expression (no "nearest entity with
  tag" query and no target lists).
- An expression built-in to read an entity's behavior state (e.g.
  `in_state`).
- Shell UI for behavior state (a debug overlay can be a later task).
  The shells only need to keep compiling and rendering NPC movement, which
  they already interpolate.
- Pathfinding performance work, and LOD/sleeping for far-away NPCs.

## Design Notes

- Loader: `src/core/load/load.ts` follows the `status()`/`system()` pattern
  with `Fields` for unknown-key checks. `system()` already converts seconds to
  whole ticks (`every`). Reuse that helper for `repath` and `timeout.after`.
  Archetype fields are listed around line 416.
- Expressions: compile `target` with the same scope used for status/system
  conditions (`self`, `player`, `tile`, `world`). `player` compiles to an
  `entity`-typed value. Read x/y from the compiled result, as `can_see`
  does, so there is no argument array.
- Runtime: `World.step()` in `src/core/sim/world.ts`. Add a `think()`
  method called before the intent loop. Set `e.intent` directly (the entity
  is known to belong to the world) rather than going through
  `queueIntent`'s checks. For `home`'s failure check, compare
  `lastGoto.tick` against the tick at which the home goto was issued.
- Preallocate the nine step intents (and a fixed direction table shared by
  `wander` and `flee`) at module level.
- Keep activity code in its own module (e.g. `src/core/sim/behavior.ts`),
  so that noise-driven activities (`investigate`) can be added later without
  growing `world.ts`.
