---
id: noise-hearing
area: sim
priority: 30
depends_on: []
description: M4 completion — a `noise` effect (in systems and item use) emitted at self's cell, a hear phase that records each entity's last heard noise (euclidean radius, walls ignored, cost O(noises × entities) only on noisy ticks), a `heard(entity, seconds)` expression built-in and an `investigate` behavior activity; zombies investigate broken glass and alarm clocks, bats investigate creaky floorboards
---

# Noise and hearing (M4 completion)

## Goal

M4's playable target is "a horde that hears the window breaking". Sight
(`can_see`) and behaviors (state machines) are delivered. This task adds
**noise**: packs emit it through a new **`noise` effect**, every entity
within its radius **hears** it and remembers where it came from, expressions
test it with **`heard(entity, seconds)`**, and a new **`investigate`**
behavior activity walks an NPC to the last noise it heard.

The playable result: in `std,std-needs,zombie`, a survivor who crunches over
broken glass (or winds up an alarm clock) draws nearby shamblers to the
spot. If a shambler sees the survivor on the way, it switches to chasing
them. In `std,vampire`, the vampire's steps on creaky floorboards bring
roosting bats over to look, and they fly home afterwards.

This settles the VISION §8 question "how noise is represented without a
per-tick cost proportional to the map": noises are **events**, not a field
over the grid. Hearing is a distance check per (noise, entity) pair, done
only on ticks when some noise was emitted.

## Acceptance Criteria

### Pack schema: `noise` effect

1. A new effect type, **`noise`**, valid wherever effects are valid today
   (`systems[].effects` and `items[].use.effects`):

   | Field    | Type                    | Default  | Notes |
   |----------|-------------------------|----------|-------|
   | `type`   | `noise`                 | required | |
   | `radius` | number or expression    | required | Hearing radius in tiles (euclidean, inclusive). Compiled as a number term with the same scope as other effect values, and evaluated at emission time |

   `measurement` is **not** allowed on a `noise` effect. As for `apply` and
   `set`, a misspelled or unknown field is a load error, and so are a missing
   `radius` and a non-numeric `radius` expression. The unknown-effect-type
   message lists `noise` among the expected types. `EffectDef` becomes a
   discriminated union (measurement effects vs. `{ type: 'noise', ...term }`),
   and every consumer narrows on `type`.
2. **Emission.** Running a `noise` effect emits one noise at **`self`'s
   current cell**, with **`self` as the source** and the evaluated radius. A
   radius `<= 0` (or NaN) emits nothing. Unlike measurement effects, a noise
   effect does not depend on the entity having any measurement. For item
   `use`, the noise is emitted only when the use succeeds, in effect order.

### Runtime (`src/core/sim/`)

3. **Noise events.** The world keeps a per-tick list of pending noises
   `{ x, y, radius, source }`. They are appended in emission order: first
   player actions (phase 1), then systems in definition order and entity id
   order (phase 3). The list is reused (cleared, not reallocated), so ticks
   with no noise allocate nothing for hearing. After the hear phase, the
   world exposes this tick's noises read-only (e.g. `world.noises`) for
   tests and future shell use. It is cleared at the start of the next tick's
   emission.
4. **Hear phase.** It is a new phase that runs right after systems. It is
   skipped entirely when no noise was emitted this tick. For each noise, in
   emission order, and each entity in id order: if the entity is **not the
   source** and `dx² + dy² <= radius²`, the noise is a candidate for that
   entity. **Walls and opacity are ignored.** Each entity keeps the
   **nearest** candidate from this tick (ties: the earlier emission), and
   records it as `heardX`, `heardY`, `heardTick = tick`. Entities that hear
   nothing keep their previous memory. The initial value is
   `heardTick = -1` (never heard). All entities hear, including the player
   and entities without a behavior. Packs decide who reacts.
5. **Tick order** becomes: 0. think → 1. intents, then actions → 2. drift →
   3. systems → **4. hear** → 5. clamp → 6. statuses → 7. defeat →
   8. `tick++`. As a result, statuses see a noise in the same tick it is
   emitted, and behavior transitions see it on the next tick's think phase.
   Everything is skipped after defeat, as now.
6. **Cost.** On a tick with *k* noises and *n* entities, hearing costs
   O(k·n) arithmetic with no allocation and no grid traversal. It costs
   nothing on silent ticks.

### Expressions

7. A new built-in **`heard(entity, seconds)`**: true when the entity has
   heard a noise and `ctx.tick - heardTick < seconds × ticksPerSecond`
   (with `seconds` numeric; a value `<= 0` is always false). Examples: with
   `seconds = 1` and 10 ticks/s, a noise heard at tick *t* is true from the
   status update of tick *t* through tick *t + 9*, so the next think phase
   (tick *t + 1*) sees it. It follows the `can_see` pattern: the argument
   count and types are checked at compile time (the first argument must be
   an entity), there is no argument array at runtime, and it is added to the
   special-name list. It is also available with method syntax
   (`self.heard(2)`), the same way `has_status` is.

### Behaviors: `investigate` activity

8. A new activity, **`investigate`**, walks to the entity's last heard noise
   cell. `ACTIVITIES` and the docs' `do` list include it.
   - `target` is a **load error** on `investigate`, because the destination
     is the heard cell. `repath` is allowed, with pursue's rules and default.
     `done` is allowed, so `done` becomes valid on `home` and `investigate`
     only.
   - Each tick: if the entity has never heard anything, do nothing (`done`,
     if set, fires on the next tick). If it is Chebyshev-adjacent to or on
     the heard cell, clear the path and do nothing. Otherwise it queues
     `{ kind: 'goto', x: heardX, y: heardY, adjacent: true }` in two cases:
     when no goto has been issued yet in this state, or when the heard cell
     changed since the last plan and at least `repath` ticks have passed
     since that plan. A newer noise therefore retargets the walk without a
     self-transition.
   - **`done`** fires, on a later tick than the plan and in the usual `on` →
     `timeout` → `done` order, in any of these cases: the entity is
     Chebyshev-adjacent to or on the heard cell, the last goto issued in
     this state failed (`lastGoto.ok === false`), or the entity has never
     heard a noise. Reuse `home`'s `planTick`/`lastGoto` bookkeeping, and
     keep the activity code in `src/core/sim/behavior.ts`.
9. **Snapshot and determinism.** `EntitySnapshot` gains `heard: { x, y, tick }
   | null`. Hearing draws no RNG. Same definition + seed + inputs ⇒ same
   `hash()`. Hash strings change, and that is expected.
10. **No genre words in `src/`.** `noise`, `heard`, `hear` and `investigate`
    are generic engine vocabulary. The engine guard test must still pass.

### Two-genre usage

11. **`packs/zombie`**: "the window breaking".
    - A new walkable tile **`glass`** ("Broken glass", tag `glass`, not
      opaque), placed in `maps/town.yaml` at a few spots near house doors and
      in a hallway, where the survivor plausibly walks.
    - A system (e.g. `crunch`, `every: 1`) that emits
      `{ type: noise, radius: ~12 }` for `living` entities standing on a
      `glass` tile.
    - A new item **`alarm_clock`** (weight ~0.5, `use: { label: Wind up,
      consume: 0 }`) with a noise radius of ~20, added to an existing loot
      table (e.g. `bedroom_stuff`).
    - The `shambler` behavior gains an `investigate` state. `wander` and
      `search` switch to it on `heard(self, 1)`. The investigating state has
      `on: alert → chase` and `done → search`. The `alert` → `chase` rules
      that already exist in `wander`/`search` stay first in their `on`
      lists, so sight beats sound.
12. **`packs/vampire`**:
    - A new walkable tile **`creaky`** ("Creaky floorboards"), placed in
      `maps/mansion.yaml` on a few floor cells near the bats' spawns, in
      spots the vampire plausibly crosses. Keep the rooms' existing
      shade/sunlit semantics, which means a creaky cell inside a shaded room
      also carries `shade`.
    - A system that emits a noise (radius ~8) for `undead` entities standing
      on a `creaky` tile.
    - The `bat` behavior gains an `investigate` state. `roost` switches to it
      on `heard(self, 1)`. The investigating state has `on: alert → flee` and
      `done → return`.

    Tune the radii so both play sensibly on their maps.
13. `npm run check` passes for `std,std-needs,zombie` and `std,vampire`.

### Tests (`test/`)

14. A new `test/noise.test.ts`, mostly with small inline fixture packs:
    - loader: `noise` without `radius`, with `measurement`, with an unknown
      field, and with a non-numeric `radius` are errors. A valid noise loads
      in both `systems` and `items.use`. The unknown-type message lists
      `noise`. `target` on `investigate` and `done` on `wander` are errors,
      and `done` on `investigate` loads;
    - hearing: the radius is inclusive (at exactly `radius`: heard; just
      beyond: not heard). Walls don't block. The source doesn't hear itself.
      With two noises in one tick, the nearest wins, and on a tie the earlier
      emission wins. Memory persists across silent ticks. A radius of 0 or a
      negative radius emits nothing. A silent world leaves every
      `heardTick === -1` and `world.noises` empty;
    - timing: a status using `heard(self, 1)` turns on in the emission tick
      and turns off exactly after `ticksPerSecond` ticks. A behavior
      transition on `heard` fires in the next tick's think phase;
    - item `use` emits a noise only on success, and a failed `when`
      emits none;
    - `investigate`: the NPC reaches adjacency to the heard cell and then
      fires `done`. A newer noise retargets it, at most once per `repath`
      window. An unreachable noise cell fires `done` via the failed goto. An
      entity that has never heard anything fires `done`;
    - `heard()` compile errors: wrong argument count and a non-entity first
      argument.
15. Scenario tests on the real packs:
    - zombie: the survivor stands on (or is moved onto) a glass tile, out of
      sight of a shambler that is within the radius. The shambler enters
      `investigate` and ends Chebyshev-adjacent to the noise cell (or enters
      `chase` if it sees the survivor on the way) within a bounded number of
      ticks. Using `alarm_clock` from the inventory also triggers
      `investigate`;
    - vampire: the vampire steps on creaky floorboards within earshot of a
      bat. The bat enters `investigate` (or `flee`, if it sees the vampire),
      and eventually returns to `roost` near its spawn.
16. Determinism: 1000+ tick runs on both genres, with behaviors, noise and
    some player input, produce identical `hash()`/`snapshot()` across two
    runs.
17. Existing tests keep passing. Update expectations that shift because of
    the new map tiles, loot contents or snapshot fields, without weakening
    what they verify.

### Docs

18. `docs/packs.md`: document the `noise` effect in the effects description
    under `### systems` (and mention it under `### items`), add
    `investigate` to `### behaviors` (semantics, `done` rules, no `target`),
    and add the hear phase to `### Tick order`. `docs/expressions.md`: add
    `heard(entity, seconds)` to the built-in table, with the timing example
    from AC 7.
19. `VISION.md` §7: record the decision. Noise is **events** emitted by a
    `noise` effect at `self`'s cell. Hearing is euclidean, inclusive, and
    **ignores walls for now**. Each entity remembers only its **last heard
    noise** (nearest within a tick), and `investigate` walks to it. Cost is
    O(noises × entities) on noisy ticks only. §8 and the M4 row: noise is
    delivered. Mark M4 ✅ if the zombie scenario plays as "the horde hears
    the noise". NPC actions and combat move to later milestones, so update
    the open-questions text accordingly.

### Gates

20. `npm run typecheck`, `npm test` and `npm run build` pass.

## Out of Scope

- Walls or doors muffling sound, flood-fill propagation, or attenuation.
- Footstep noise from movement, noise on take/put/drop, or tile fields
  that emit noise without a system.
- Throwing items or emitting noise at a cell other than `self`'s.
- Per-archetype hearing range or deafness (packs filter via transitions and
  `for`).
- "Last known position" for `pursue`, or a memory of more than one noise.
- An expression that reads the heard cell (e.g. as a `flee`/`pursue`
  target), and `heard` on tiles.
- Shell UI for noises (ripples, a debug overlay). The shells only need to
  keep compiling and running.
- Combat, NPC actions and utility AI.

## Design Notes

- Loader: `EFFECT_FIELDS` in `src/core/load/load.ts` (~line 79) maps a type
  to its value key. `noise` breaks the "`measurement` + value" shape, so
  branch in `effects()` (~line 953): `noise` uses fields `['type', 'radius']`
  and `numberTerm` for `radius`. The `ACTIVITIES` table is at ~line 81.
  Target/done validation lives in the behaviors loader next to it.
- Runtime: `runSystems()` and `applyAction()` in `src/core/sim/world.ts`
  currently loop over effects and skip the ones whose `has[eff.measurement]
  !== 1`. Narrow on `eff.type === 'noise'` first and call a private
  `emitNoise(source, radius)`. Add `hear()` to `step()` after `runSystems()`.
  Keep the pending-noise buffer as a reused array (or parallel typed arrays)
  whose length is reset per tick.
- `Entity` gains `heardX`, `heardY` and `heardTick` (-1). Expose them on
  `ExprEntity` only as far as the compiled `heard()` needs.
- Expressions: `src/core/expr/compile.ts` — follow `canSee` (~line 470) and
  the `SPECIAL_NAMES` list (~line 209). `heard` needs `ctx.tick` and the
  ticks-per-second value (take it from the compile context, as `world.seconds`
  does).
- `investigate` mirrors `pursue` (goto adjacent, repath window) and `home`
  (`done` via `planTick`/`lastGoto`). Generalize `transition()`'s `done`
  branch so it handles both activities cleanly, rather than duplicating it.
