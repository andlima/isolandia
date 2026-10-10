---
id: npc-perception
area: sim
priority: 40
depends_on: []
description: "NPC perception — a `senses.sight` block on archetypes (notice and lose ranges, target tags) that the engine tracks with hysteresis as `self.sees` / `self.seen`, `conceals: true` statuses that hide an entity from every sense, behavior-level any-state transitions (`behaviors[].on` with `except`), `self.seen` as a `pursue`/`flee` target with `none` rules; the five copy-pasted alert statuses and the riders' transitions converted, save version 8"
---

# NPC perception: senses and any-state transitions

## Goal

Perception is copy-pasted five times. `zmb:alert`, the bat's `alert`, the
cat's `curious`, the fox's `sly` and the butterfly's `alert` are each a
status entered on `can_see(self, player, N)` and left beyond a wider range
(`packs/zombie/undead.yaml`, `packs/vampire/survival.yaml`,
`packs/garden/rules.yaml`), and the western riders inline the same pair in
their behavior (`packs/western/people.yaml`). Every behavior then repeats
the same transition in most states to keep "sight beats sound" by hand:
the shambler checks `alert` in 3 of 4 states, the cat `curious` in 4 of 6,
the fox repeats `world.is_day → den` in 3. Concealment is per observer:
`curious` and `sly` both append `not has_status(player, "hidden")` to
`when` and `until`, and a new observer that forgets it sees through the
bushes. And every NPC can only look for `player`: `can_see(self, player)`,
`target: player`, which the faction games hit first (`m8-factions`, out of
scope there: "NPCs finding other NPCs").

This spec adds the two primitives the VISION §7 survey names, now that
the pattern has met its third genre:

- **senses** on archetypes: a `sight` sense with a notice range, a wider
  lose range and the tags of what it looks for; the engine keeps, per
  entity, the one target it currently sees (`self.sees`, `self.seen`),
  honouring **concealing statuses**;
- **any-state transitions** on behaviors, checked before the current
  state's own, with an `except` list for the states that ignore them.

Playable result: the same games, with the perception written once per
archetype instead of once per status plus once per state, hiding that
works against every observer, and behaviors that can chase what they see
rather than only the player. `can_see` stays pure geometry. No engine code
is genre-specific; determinism, snapshots and hashes are preserved.

## Acceptance Criteria

### Pack schema: senses

1. **`senses`** is a new optional field of an
   [archetype](../docs/packs.md#archetypes), a mapping with one sense,
   `sight`:

   ```yaml
   archetypes:
     - id: shambler
       senses:
         sight: { notice: 8, lose: 12, targets: [living] }
   ```

   | Field     | Type                 | Notes |
   |-----------|----------------------|-------|
   | `notice`  | number > 0           | Euclidean range (tiles, inclusive) within which a target is noticed |
   | `lose`    | number ≥ `notice`    | Range beyond which a seen target is lost |
   | `targets` | non-empty list of archetype tags | What the sense looks for: entities whose archetype has **any** of the tags |

   - `lose < notice`, a non-positive range, an empty `targets`, a tag not
     matching `[a-z][a-z0-9_]*`, a tag that no loaded archetype carries
     (load error with *did you mean*), unknown keys in `senses` or in
     `sight`, and `senses` that is not a mapping are load errors.
   - `senses` is an ordinary top-level archetype field for
     [overrides](../docs/packs.md#mods-and-overrides): replaced whole,
     `senses: null` removes it.
   - The player's archetype may have senses; they work the same (the
     engine has no special player).
2. **`conceals`** is a new optional boolean field of a
   [status](../docs/packs.md#statuses) (default `false`): while the status
   is active on an entity, **no sense notices that entity**, and a sense
   that had it loses it at its next update. Any other value is a load
   error. It is an ordinary top-level field for overrides.

   ```yaml
   statuses:
     - { id: hidden, label: Hidden, for: 'self.has_tag("bunny")', when: 'tile.has_tag("hiding")', conceals: true }
   ```

### Simulation: the sight sense

3. Each entity whose archetype has `senses.sight` keeps **`seen`**: the id
   of the one entity it currently sees, or none. It is updated once per
   tick in a new **senses** step at the **end of the status update**
   (phase 6, after every status of every entity has been set, so a
   `conceals` status that became active this tick already hides), for
   every non-dormant entity with a sense, in ascending id order:
   1. If `seen` is set, it is **kept** while the target still exists, is
      on the same floor, within `lose` (euclidean on `(x, y)`, inclusive,
      as `can_see`'s range), has tile line of sight to the entity
      (`lineOfSight`, the `can_see` rule: entities never block) and has
      no active `conceals` status. Otherwise it is cleared.
   2. If `seen` is not set (or was just cleared), the **candidates** are
      the other entities whose archetype has any of the `targets` tags,
      on the same floor, within `notice`, not concealed, with line of
      sight. The **nearest** by euclidean distance becomes `seen`; ties
      go to the lowest entity id. No candidate: `seen` stays none.

   So a target noticed at 8 is followed out to 12, behind a wall or into
   a bush it is lost at once, and an entity never switches to a nearer
   target while it still sees its current one.
4. **Dormant** entities (see `start.simulation.active_radius`) do not
   sense: their `seen` is kept as it is until they wake, like their path.
   Entities without senses have no `seen` and cost nothing.
5. **Cost.** The candidate search uses the world's chunk index
   (`entitiesNear`) with radius `notice`, and tests the range before the
   line of sight, so an entity with nothing in range costs one index
   query; keeping a target costs one range check and at most one line
   walk. `npm run bench:sim -- --packs std,std-needs,town,zombie` (960
   entities, 900 of them with a sense) shows no regression beyond noise
   against the figures in `docs/perf.md`; record the new numbers there.

### Expressions

6. Two new entity members, with function forms, in every expression scope
   (`self`, `player`, `npc`):
   - **`self.sees`** / `sees(entity)` — boolean: the entity currently sees
     a target (`seen` is set). An entity without senses reads `false`.
   - **`self.seen`** / `seen(entity)` — the seen entity, or **`none`**
     when it sees nothing (or has no senses).

   Both are **one array read** at runtime (no search). They read the value
   set by the last senses step, so systems, statuses and behaviors of tick
   *t + 1* see what was seen at the end of tick *t*, the same lag as a
   status.
7. **`none`** is the value of `seen` when nothing is seen. It is typed as
   an entity at load (so `hostile(self, self.seen)` and `target:
   self.seen` compile), and every built-in and member is total on it:

   | Use of `none`                                                             | Value |
   |---------------------------------------------------------------------------|-------|
   | `.x`, `.y`, `.z`, `.<measurement>`, `.carry_weight`, `.carry_capacity`    | `0` |
   | `has_tag`, `has_status`, `has_item`, `in_faction`, `busy`, `doing`, `heard`, `sees`, `can_see`, `hostile`, `friendly` | `false` |
   | `count_item`, `attitude`                                                  | `0` |
   | `manhattan`, `chebyshev`, `euclidean`                                     | `Infinity` (so `<= 1` is false and `> 5` is true) |
   | `.seen`                                                                   | `none` |
   | `pursue` / `flee` `target`                                                | `pursue` clears its path and waits; `flee` does nothing |

   There is no `none` literal; test with `self.sees`. The null checks are
   compiled only into expressions whose entity operand may be `none` (one
   derived from `seen`), so `self.hp` and `player.x` stay plain reads.
8. `can_see` is **unchanged**: tile line of sight with an optional range,
   no hysteresis, no concealment. Packs that want geometry keep using it.

### Pack schema: any-state transitions

9. **`on`** is a new optional field of a
   [behavior](../docs/packs.md#behaviors) (next to `initial` and `states`):
   a list of `{ when: expr, to: state, except?: [state, …] }`.

   ```yaml
   behaviors:
     - id: fox
       initial: sleep
       on:
         - { when: 'world.is_day', to: den, except: [sleep, den, bored] }
         - { when: 'self.sees', to: chase, except: [sleep, den, bored] }
       states: …
   ```

   - `to` and every `except` entry must name a state of the behavior
     (load error with *did you mean*); `except` listing `to` is a load
     error (that state is skipped anyway, see AC 10); unknown keys are
     errors. `on: []` is the same as omitting it.
   - `on` is an ordinary top-level field of the behavior for overrides:
     replaced whole.
10. In the think phase the transition test becomes: the behavior's `on`
    entries in order, **skipping** an entry whose `to` is the current
    state (never a self-transition: the state's timer is not restarted)
    or whose `except` lists it; then the current state's `on`, `timeout`
    and `done` as today. Still **at most one transition per entity per
    tick**, with the same effects (path, intent and plan cleared, timer
    restarted). `docs/packs.md` (behaviors) gains a short "Any-state
    transitions" paragraph and the tick order says the behavior's `on`
    comes first.

### Saves

11. `SAVE_VERSION` becomes **8**:
    - each entity snapshot gains `seen: <entity id>` (omitted when none
      or without senses); it is part of `snapshot()` and `hash()`;
    - **version 3 to 7 saves still load**: no entity sees anything, and
      the first tick notices again; `docs/saves.md` says so;
    - a `seen` that is not an existing entity id, is the entity itself,
      or is set on an entity whose archetype has no senses is a restore
      error with the JSON path;
    - `assertRoundTrip` covers a world where some entities see a target
      and others do not.

### Shells

12. The browser **hover** tooltip for an NPC (`hoverInfo`, see
    `docs/ui.md`) adds a line `Has seen you` when the NPC's `seen` is the
    player (`sees: true` on `HoverInfo`); nothing for other targets or
    NPCs without senses. The terminal is unchanged.

### Packs

13. **zombie:** `shambler` and `crawler` get `senses: { sight: { notice:
    8, lose: 12, targets: [living] } }`; the `alert` status is removed;
    the `shambler` behavior gets `on: [{ when: 'self.sees', to: chase }]`,
    `chase` takes `target: self.seen` and `on: [{ when: 'not self.sees',
    to: search }]`, and every other `alert` transition goes; the comment
    "sight beats sound" moves to the behavior's `on`.
14. **vampire:** `bat` gets `senses: { sight: { notice: 6, lose: 10,
    targets: [undead] } }`; `alert` is removed; `screech` fires `when:
    'self.sees'`; the `bat` behavior gets `on: [{ when: 'self.sees', to:
    flee }]`, `flee` takes `target: self.seen` and `not self.sees →
    return`.
15. **garden:** `cat` (`notice: 5, lose: 8`), `fox` (`6, 9`) and
    `butterfly` (`3, 5`) get `senses` with `targets: [bunny]`; `curious`,
    `sly` and `alert` are removed; `hidden` gets `conceals: true` (its
    HUD chip stays); `meow` and `yip` fire on `self.sees and
    chebyshev(self, self.seen) <= 1`; the behaviors get any-state `on`
    lists: the cat `{ sees → chase, except: [bored] }`, the butterfly
    `{ sees → flit }`, the fox `{ is_day → den, except: [sleep, den,
    bored] }` then `{ sees → chase, except: [sleep, den, bored] }`
    (sleeping foxes are not woken by a bunny, as today); `chase` and
    `flit` take `target: self.seen` and exit on `not self.sees`; the
    fox's night condition goes (it is asleep or walking home by day).
    The bunny's `startled` status is unchanged.
16. **western:** `rider` gets `senses: { sight: { notice: 8, lose: 12,
    targets: [stranger] } }` (the Stranger already carries the `stranger`
    tag); `loiter → crowd` becomes `self.sees and hostile(self,
    self.seen)`, `crowd` takes `target: self.seen` and exits on `not
    self.sees`. `black_jack` is unchanged.
17. **Behaviour preserved.** The converted stacks play as before: the
    zombie, vampire and garden scenario tests (zombies chase a survivor in
    sight and search where they lost it; bats flee the vampire and return;
    the cat chases a bunny in the open and loses it in a bush; the fox
    only by night; butterflies flit) pass, updated to read `sees` instead
    of the removed statuses. Every shipped stack (`town`, `garden`,
    `zombie`, `vampire`, `hardship`, `noir`, `western`, and mixed stacks)
    loads, and `npm run check` on each passes.

### Tests and docs

18. Headless tests cover:
    - **Loader:** every load error in AC 1, 2 and 9, and that `senses`,
      `conceals` and `on` can be overridden and cleared.
    - **Sense update:** noticed at `notice`, kept out to `lose`, lost
      beyond it or behind an opaque edge or cell, lost and re-noticed the
      next tick when a `conceals` status enters and exits; the nearest
      candidate wins and ties go to the lowest id; a seen target is kept
      when a nearer one appears; a target on another floor is neither
      noticed nor kept; only `targets` tags are candidates; the entity
      never sees itself; a dormant entity keeps `seen` and re-evaluates
      when it wakes.
    - **Expressions:** `self.sees`, `self.seen`, the function forms,
      `npc.sees` in a dialogue; every row of the `none` table (AC 7),
      including `pursue` and `flee` with a `none` target; one-tick lag
      (a behavior sees `sees` in the think phase after the tick that set
      it).
    - **Any-state transitions:** order (behavior `on` before the state's
      `on`), `except`, no self-transition and no timer restart, one
      transition per tick, the timeout of the current state still
      counting after a skipped entry.
    - **Saves:** `seen` round trip; the version 7 upgrade path (nothing
      seen, noticed again on the first tick); the restore errors of AC 11.
    - **Hover:** `hoverInfo` for an NPC that sees the player and one that
      does not.
    - **Determinism:** the hash-equality runs with the converted packs.
    - **Guards:** the genre-word guard on `src/`.
19. **Docs.**
    - `docs/packs.md` documents `senses` (archetypes), `conceals`
      (statuses), the behavior `on` (behaviors) and the senses step (tick
      order); the `alert` status example under statuses is replaced by a
      `senses` example and the shambler example rewritten.
    - `docs/expressions.md` documents `sees`, `seen` and the `none`
      table, and says `can_see` is unchanged.
    - `docs/saves.md` documents version 8; `docs/ui.md` the hover line;
      `docs/perf.md` the new numbers.
    - `VISION.md` §7 records the decision under the YAML pain points:
      perception is a **sense on the archetype**, with hysteresis and
      concealment in the engine and `can_see` left as geometry; "sight
      beats sound" is an any-state transition; NPCs find other NPCs
      through `targets` tags and `self.seen`, with `none` as the total
      value for "nothing"; and strikes the "NPCs can only target
      `player`" item.

## Out of Scope

- Other senses (hearing stays the `noise` event and `heard`; no smell),
  per-sense conditions (`when` on a sense: night vision, a sleeping NPC
  that sees nothing), facing or vision cones, and light levels.
- Senses on tiles or items, and a sense that tracks several targets or
  remembers a last known position (`pursue` keeps using the target's
  current cell; `investigate` keeps using the last noise).
- Filtering candidates by an expression (`targets: { when: 'hostile(self,
  other)' }`): tags pick the kind of thing seen, transitions decide what
  to do about it. A pack that wants "the nearest hostile" tags its
  enemies.
- A `nearest(...)` built-in independent of senses, target lists, and
  entity-valued `vars`.
- Entering a behavior state or running effects when a target is noticed
  or lost (`on_notice`): a status `when: 'self.sees'` or a transition
  covers today's packs.
- Concealment that depends on the observer (a cat that sees through
  bushes), partial concealment or distance modifiers; a `conceals` status
  hides from every sense.
- Entities blocking sight, and any change to `can_see`, hearing or
  dormancy.
- Removing entities: `seen` handles a missing id defensively, but nothing
  removes entities yet.

## Design Notes

- **State.** Add `seen: number` (-1 for none) to `Entity`, and a
  per-archetype `SenseDef | null` (`notice`, `lose`, `targetTags`, with
  `notice²`/`lose²` precomputed) on `ArchetypeDef`. Precompute at world
  creation a per-archetype bit "is a candidate for sense *k*" or simply a
  `Uint8Array` per archetype of "has any of these tags" for each distinct
  `targets` set, so the candidate test is one array read per neighbour.
- **Senses step.** A `updateSenses()` method called at the end of
  `updateStatuses()` (after the `st` arrays are written), iterating
  `this.entities` and skipping `dormant[e.id] === 1` and archetypes
  without a sense. Use `entitiesNear(x, y, z, notice)` (id order) for
  candidates and `lineOfSight` from `sight.ts` for visibility. The
  "concealed" test is one scan of the status indices flagged `conceals`
  (precompute the list of concealing status indices; empty in most
  stacks, so the test is free).
- **Expressions.** `seen` needs an entity-typed value that may be null at
  runtime. In `compile.ts`, mark compiled entity expressions with
  `nullable: true` when they derive from `seen`, and in `entityArg` /
  member access emit the checked closure only for nullable operands (the
  table in AC 7). `pointArg` (distances, `can_see`) returns a sentinel
  for null; `Infinity` comes from the distance helper, not the sentinel.
  Keep the existing `METHODS` set in sync (`sees`, `seen` as methods).
- **Behavior `target`.** `pursue` and `flee` in `behavior.ts` read
  `s.target!(ctx)` as a `Point`; guard `null` there (pursue: `e.path =
  null; return`, flee: `return`). `BehaviorDef` gains `on` (compiled
  `when`, `to` index, `except` as a `Uint8Array` over states); `think()`
  runs it before `transition()`.
- **Saves.** `save.ts`: write `seen` when `e.seen >= 0`; on read (version
  8) validate against the entity count and the archetype's sense; older
  versions leave -1. Bump `SUPPORTED_SAVE_VERSIONS`.
- **Hover.** `hoverInfo` in `src/web/menu.ts` already branches on NPCs
  for `standing`/`hostile`; add `sees` and render it in `hover-dom.ts`.
- The browser and terminal need no other change: no new events or keys.

## Agent Notes

- Read first: `docs/packs.md` (archetypes, statuses, behaviors, tick
  order, simulation), `docs/expressions.md`, `src/core/sim/world.ts`
  (`step`, `think`, `updateStatuses`, `entitiesNear`, dormancy),
  `src/core/sim/behavior.ts`, `src/core/sim/sight.ts`,
  `src/core/expr/compile.ts` (`entityArg`, `pointArg`, `canSee`,
  `METHODS`), `src/core/load/load.ts` (the `archetype`, `status` and
  `behavior` parsers), `src/core/sim/save.ts`, `test/behaviors.test.ts`,
  `test/sight.test.ts`, `test/scenario.test.ts`.
- Suggested order: defs and loader (senses, conceals, behavior `on`); the
  senses step and `seen`; expressions and `none`; any-state transitions;
  saves; hover; packs and scenario tests; docs, perf and VISION.
- The garden's `hidden` is the only concealing status today; its HUD chip
  (`tone: good`) must keep showing for the bunny.
- Keep the `id: "…"` frontmatter rule in mind if you add specs; quote
  YAML strings that contain `: ` in pack comments too.
- Chromium is unavailable in the sandbox: everything in this spec is
  headless (the hover test is on the pure `hoverInfo`).
