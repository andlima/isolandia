---
id: pack-event-triggers
area: sim
priority: 40
depends_on: []
description: "Event triggers — systems fire on events instead of polling: `on: step` (the tick an entity lands on a cell, so footsteps stop being `every: 0.2`), `on: noise` (the tick it hears one, run right after the hear phase), `once: true` (at most once per entity, saved), and `interrupt: { on: noise }` on actions, item uses and recipes checked when the noise lands; the crunch/creak/hop systems, the survival tip and the bandage lose their periods, guards and tick-order comment"
---

# Event triggers for systems and interrupts

## Goal

Packs express "when something happens" by polling. The footstep noises
`town:crunch` (`every: 0.2`), `vamp:creak` (`every: 0.1`) and
`garden:hop` (`every: 0.2`) mean "a noise on each step" but fire while
standing still, at a period guessed from the walking speed, and go quiet
for a fast walker. One-shot rules are hand-built: `zmb:survival_tip` runs
every second and guards itself with `not in_journal(...)`. And the tick
order leaks into pack data: the bandage's `interrupt: "heard(self, 0.2)"`
carries a comment explaining that hearing lands after the work step, so
0.2 s is the shortest window the next tick still sees.

This spec adds **event triggers**, the primitive the VISION pain-points
survey asks for, without a script hook and without generic control flow:

- a system may fire **on an event** (`on: step`, `on: noise`) instead of
  on a period;
- a system may fire **at most once** per entity (`once: true`);
- an activity may be interrupted **by an event** (`interrupt: { on:
  noise }`), checked on the tick the event lands.

Playable result: the same games, with footsteps that follow steps exactly
(one crunch per step, none while idle), a bandage that is spoiled by the
noise that reaches you and no later, and packs with fewer periods, guards
and comments. Determinism, snapshots and hashes are preserved; no engine
code is genre-specific.

## Acceptance Criteria

### Pack schema

1. **`on`** is a new optional field of a [system](../docs/packs.md#systems):

   | Field  | Type                | Default | Notes |
   |--------|---------------------|---------|-------|
   | `on`   | `step` or `noise`   | none    | Fire on an event instead of a period |
   | `once` | boolean             | `false` | Fire at most once per entity (AC 5) |

   - `every` together with `on` is a load error ("an event system has no
     period"). Any other `on` value is an error with a *did you mean*.
   - `for`, `when` and `effects` keep their meaning. `for` is still
     evaluated first, then `when`, with `self` = the entity the event
     happened to and `tile` = the cell under it **after** the event (the
     cell arrived at, for `step`).
   - `once: false` is the same as omitting it; any other value is an error.
2. **`on: step`** fires for an entity on the tick it **lands on a cell**:
   a step to a neighbouring cell or a climb across a link (a floor
   change). It does not fire for a turn in place, a failed step, a
   cancelled path or a dormant NPC (which never moves). It fires for the
   player and NPCs alike, and for every step of a path.
3. **`on: noise`** fires for an entity on the tick it **hears a noise**
   (the tick its remembered last noise is set, as `heard(self, 0.1)`
   reads). An entity that hears two noises in one tick fires once. The
   noise's source never hears its own noise, so it never fires for it.
4. **`interrupt`** on [actions](../docs/packs.md#actions), item
   [`use`](../docs/packs.md#items) and [recipes](../docs/packs.md#recipes)
   accepts, besides today's expression, a mapping:

   ```yaml
   interrupt: { on: noise }
   interrupt: { on: noise, when: "not self.has_status(\"calm\")" }
   ```

   - `on` is required and only `noise` is valid; `when` is an optional
     expression in the activity's usual scope (`self`, `tile` = the
     target cell as for the expression form). Unknown keys are errors.
   - An activity with an event interrupt ends as `interrupted` on the
     tick its actor hears a noise (AC 7), with `when` truthy if given. It
     is not checked on the tick the activity starts, like the expression
     form, and the noise must land **after** the start: a noise heard
     earlier in the same tick as the start does not interrupt.
5. **`once: true`** makes a system fire **at most once per entity**: after
   its effects run for an entity, the system never fires for that entity
   again, in this world or in any save of it. It combines with `every`
   (the default period) or with `on`. A `once` system whose `for` and
   `when` never hold never fires; a system that fires but whose effects
   all turn out to be no-ops (a journal entry already there) still counts
   as fired.

### Simulation

6. **Step systems** run in the **systems phase** (phase 3), in definition
   order with the periodic systems, each for every entity that landed on
   a cell this tick (its `stepTick` was set this tick); the test is one
   comparison per entity, with no new per-entity state. Their effects see
   and are seen by the other systems exactly as today (definition order,
   entity order), and a `noise` they emit is heard in this tick's hear
   phase, as `crunch` is today.
7. **Noise systems and event interrupts** run in a new sub-phase right
   **after hear** (phase 4) and before clamp:
   1. for every entity whose activity has an event interrupt and which
      heard a noise this tick, the `when` check and the `interrupted`
      end, in entity id order;
   2. the `on: noise` systems, in definition order, for every entity
      that heard a noise this tick, in entity order.

   The sub-phase is skipped on silent ticks, like hear. A `noise` effect
   emitted here is **carried to the next tick**: it is heard in the next
   tick's hear phase (the existing carry mechanism), never in this one,
   so a tick always runs one hear phase and a scream that startles the
   neighbours is a chain of ticks, never a loop inside one. Statuses
   (phase 6) see the measurements these systems changed on the same
   tick, as for any system.
8. **`once` state** is simulation state: per entity, which `once`
   systems have fired for it. It is part of `snapshot()` and `hash()`,
   as `fired: [<qualified system id>, …]` on the entity (sorted, omitted
   when empty). The runtime check is a bit per (entity, once-system), so
   a fired system costs nothing more than the `for` test. Systems without
   `once` keep no state.
9. **Tick order doc.** `docs/packs.md` (Tick order) lists the new
   sub-phase as `4b` ("event interrupts, then `on: noise` systems") and
   says that step systems are part of phase 3. The statement "statuses see
   a noise in the tick it is emitted, and behavior transitions see it in
   the next tick's think phase" gains "and noise systems and event
   interrupts see it in the same tick, right after hearing".

### Saves

10. `SAVE_VERSION` becomes **7**:
    - each entity snapshot gains `fired` (AC 8), by qualified id;
    - **version 3 to 6 saves still load**: no system counts as fired, so
      a `once` system may fire again after the upgrade; `docs/saves.md`
      says so;
    - an unknown system id in `fired`, or an id of a system that is not
      `once`, is a restore error with the JSON path and *did you mean*;
    - `assertRoundTrip` covers a world where a `once` system has fired
      for some entities and not others.

### Overrides

11. `on` and `once` are ordinary top-level fields of a system: an
    override may set or clear them (`on: null` goes back to a periodic
    system, which then needs `every` or takes its default), and the
    merged entry is validated as a fresh definition (so `every` left in
    place next to an added `on` is an error at the override). The
    `interrupt` mapping is replaced whole, like any nested mapping.

### Packs

12. **town:** `crunch` becomes `on: step` with the same `for`, `when` and
    noise (no `every`), and the tile comment on `glass` says "crunches
    underfoot on every step". The bandage `use` becomes `interrupt: { on:
    noise }` and loses its tick-order comment.
13. **vampire:** `creak` becomes `on: step`. The `rest` action's
    `interrupt: 'heard(self, 1)'` becomes `interrupt: { on: noise }`.
14. **garden:** `hop` becomes `on: step`. The bunny's `startled` status
    keeps `heard(self, 1)` (a status is not an activity).
15. **zombie:** `survival_tip` becomes `once: true`, `every: 1`, with the
    `not in_journal("travel_light")` guard removed from its `when`.
16. Every shipped stack (`town`, `garden`, `zombie`, `vampire`,
    `hardship`, `noir`, `western`, and mixed stacks) loads, and
    `npm run check` on each passes.

### Tests and docs

17. Headless tests cover:
    - **Loader:** every load error in AC 1, 4 and 11 (`every` with `on`,
      unknown `on`, bad `once`, `interrupt` mapping errors), and that
      `interrupt` keeps accepting an expression.
    - **Step systems:** exactly one firing per step, none while idle, one
      per path cell, one for a climb, none for a turn in place or a
      blocked step; `tile` is the cell arrived at; a noise emitted by a
      step system is heard the same tick.
    - **Noise systems:** fire on the hearing tick only, once per entity
      for two noises in a tick, never for the source; their effects are
      visible to statuses on the same tick; a noise they emit is heard
      on the next tick (and a two-entity "echo" pack advances one hop per
      tick, never hanging).
    - **Event interrupts:** an action interrupted on the tick the noise
      lands (recorded as `interrupted`), not on its start tick; `when`
      falsy leaves it running; the expression form unchanged; a bandage
      scenario where a noise 0.1 s before completion still spoils it.
    - **`once`:** fires once per entity, independently per entity; a
      no-op effect still counts; the state survives a save round trip;
      the version 6 upgrade path.
    - **Determinism:** the existing hash-equality runs still pass with
      the converted packs, and the garden, town and vampire scenarios
      (footstep noises reaching the cat, zombies and bats) keep working.
    - **Guards:** the genre-word guard on `src/`.
18. **Docs.**
    - `docs/packs.md` documents `on`, `once`, the interrupt mapping and
      the tick order (AC 9), with the `crunch` example rewritten to
      `on: step`.
    - `docs/saves.md` documents version 7.
    - `VISION.md` §7 records the decision under the YAML pain points:
      footsteps, one-shots and noise interrupts are **events**, as
      `on`/`once` on systems and `interrupt: { on }` on activities;
      noise systems run after hearing and their noises carry to the next
      tick; tile-level `on_enter` hooks were not added because a step
      system with a tile `when` covers them for every tile at once.

## Out of Scope

- Tile-level hooks (`tiles[].on_enter`), status `on_enter`/`on_exit`
  effects, and behavior transitions on events (behaviors keep polling
  `heard(self, s)` in the think phase; "any-state transitions" belong
  to a perception spec).
- A `noise` scope in expressions (source, radius, distance of the noise
  that triggered the system) and `on: noise` filtered by radius or
  source; `heard` and distances cover today's packs.
- Other events (`on: damage`, `on: status`, `on: take`, `on: enter_room`,
  `on: day`), and an `on` for quests or dialogues.
- Interrupts on anything but noise (`interrupt: { on: step }` is movement,
  which already cancels an activity).
- A world-level `once` (use a `for` on the player's tag, or a var).
- Changing when behaviors see noises, or how far a noise carries.

## Design Notes

- **Step detection** needs no new state: `World.move` and `World.climb`
  set `e.stepTick = tick + 1`, so in the systems phase "landed this tick"
  is `e.stepTick === tick + 1`. `stepTick` is already in the snapshot.
  Hearing is `e.heardTick === tick` after `hear()`.
- **Phase split.** Keep `runSystems()` for periodic and step systems and
  add a second loop for noise systems, driven by the `hearIds` list that
  `hear()` already fills (the entities that heard something this tick),
  so a noisy tick costs O(hearers × noise systems) and a silent tick
  nothing. Precompute three lists of systems at load: periodic, step,
  noise.
- **Carry.** `beginInput()` already carries pending noises across a
  conversation input with `noiseCarry`; noise systems emit into the same
  pending list after `hear()` has run, so the carry flag must be set
  when the list is non-empty at the end of the sub-phase. Make sure
  `step()` does not clear those noises at its start.
- **Event interrupts** are a new field on `ActivitySource`
  (`interruptOn: 'noise' | null` plus the optional `interruptWhenFn`);
  the runner gets an `interruptOnNoise(e, tick)` entry point called from
  the sub-phase. The start-tick rule is `tick > a.startTick`, as in
  `advance()`.
- **`once` bits:** a `Uint8Array` per entity sized to the number of
  `once` systems (indexed by a dense once-index), allocated only when the
  stack has any; the snapshot maps set bits to qualified ids.
- The browser and terminal need no change: no new UI, events or keys.

## Agent Notes

- Read first: `docs/packs.md` (systems, actions, tick order, noise),
  `src/core/sim/world.ts` (`step`, `runSystems`, `hear`, `emitNoise`,
  `move`, `climb`, `beginInput`), `src/core/sim/activity.ts`
  (`advance`, `end`), `src/core/load/load.ts` (the `system` and `effects`
  parsers, `conditionExpr`), `src/core/sim/save.ts` (version handling),
  `test/noise.test.ts`, `test/systems.test.ts`, `test/actions.test.ts`.
- Suggested order: defs and loader; step systems; the hear sub-phase
  with noise systems and the carry; event interrupts; `once` and saves;
  packs; docs and VISION.
- Keep the `id: "…"` frontmatter rule in mind if you add specs; here,
  quote YAML strings that contain `: ` in pack comments too.
- Chromium is unavailable in the sandbox: everything in this spec is
  headless.
