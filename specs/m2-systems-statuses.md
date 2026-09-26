---
id: m2-systems-statuses
area: sim
priority: 40
depends_on: [m1-iso-renderer]
description: M2 survival loop — pack-defined `systems` (periodic effects), `statuses` (enter/exit conditions with rate modifiers), tile tags, a `start.defeat` game-over condition, and a `lighting` domain driving a day/night tint in the iso renderer
---

# M2 — Systems, statuses and day/night

## Goal

Build the first real survival loop on top of the world clock, declared
entirely in packs:

- **`systems`** are rules that run on their own over time.
- **`statuses`** are derived states such as *Hungry* or *Sunburnt*. They
  enter and exit on conditions and change measurement drift while active.
- A pack-defined **defeat** condition ends the game.
- A **`lighting`** domain tints the isometric view by time of day.

The milestone is playable when `base+zombie` and `base+vampire` each give
you a day to survive:

- measurements drift and statuses appear;
- the player can recover by going to the right tiles, or dies;
- the scene darkens at night.

No engine code may be genre-specific (VISION.md §3.5).

## Acceptance Criteria

### Pack schema additions

1. **Tile tags.**
   - `tiles` accept an optional `tags` list, with the same syntax and default
     (`[]`) as archetype tags.
   - Expressions gain `tile.has_tag("x")` and `has_tag(tile, "x")`, alongside
     the existing entity forms.
   - `has_tag` on the `tile` of an entity reads the tile under that entity.
   - Tags on tiles and archetypes are separate: an entity's tags are never
     the tags of its tile, and a tile's tags are never an entity's tags.
2. **`systems` domain** (a list of entries). Each entry is a periodic rule
   that runs once per entity:

   | Field     | Type           | Default     | Notes |
   |-----------|----------------|-------------|-------|
   | `id`      | id             | required    | Own id space |
   | `every`   | number (sim seconds) | `0.1` (every tick) | Must be > 0 and a whole number of ticks (`every × 10` an integer, with a tolerance for float noise); converted to ticks at load |
   | `for`     | expression     | `true`      | Entity filter |
   | `when`    | expression     | `true`      | Extra condition, evaluated after `for` |
   | `effects` | list           | required, non-empty | See AC 3 |

   - A system with period *n* ticks fires on every tick *t* where
     `(t + 1) % n == 0`, so it first fires after `every` seconds have
     elapsed.
   - For each entity, in entity order, the system runs its effects when
     `for` and then `when` are truthy. `self` is that entity and `tile` is
     the tile under it.
   - Systems run in definition order: pack load order, then the loader's
     existing merge order within a pack.
3. **Effect vocabulary.** M2 has two effect types. Both act on `self`:
   - `{ type: apply, measurement: <id>, delta: <number | expression> }`
     adds `delta` to the measurement.
   - `{ type: set, measurement: <id>, value: <number | expression> }`
     replaces the measurement's value.

   Rules that apply to both:
   - An effect on a measurement the entity does not have is skipped
     silently.
   - Each effect sees the values left by the effects before it in the same
     system, and by the systems before it on the same tick.
   - Values are clamped at the tick's usual clamp phase (AC 6), not after
     every effect.
   - Unknown `type`s and unknown fields are load errors.
4. **`statuses` domain** (a list of entries):

   | Field   | Type       | Default     | Notes |
   |---------|------------|-------------|-------|
   | `id`    | id         | required    | Own id space |
   | `label` | string     | required    | Shown in the HUD |
   | `for`   | expression | `true`      | Which entities can have the status |
   | `when`  | expression | required    | Enter condition |
   | `until` | expression | `not when`  | Exit condition, which allows hysteresis |
   | `rates` | map measurement id → number or expression | `{}` | Extra drift **per sim second** while the status is active |

   - An inactive status becomes active when `for` and `when` are truthy.
   - An active status becomes inactive when `until` is truthy or `for`
     becomes falsy.
   - Active statuses are part of the simulation state, and each entity's
     set is included in `snapshot()` and `hash()`.
   - While a status is active, each `rates` entry is added to that
     measurement's drift, like `rate`. Entries for measurements the entity
     lacks are ignored.
   - Numeric constants are folded, as they are for `rate`.
5. **Status expressions.**
   - Expressions gain `has_status(entity, "id")` and the method form
     `self.has_status("id")`. The id must be a **string literal**, resolved
     at load time with the usual namespacing rules.
   - An unknown status id is a load error with a "did you mean" suggestion.
   - At runtime the check is a set lookup, never a string comparison.
6. **Tick order.** `World.step()` runs these phases in order:
   1. apply the intent;
   2. measurement drift: `rate` plus the `rates` of the statuses active at
      the **start** of the tick;
   3. systems that are due;
   4. clamp;
   5. status update;
   6. defeat check (AC 7);
   7. `tick++`.

   In the status update phase:
   - every `for`/`when`/`until` sees the status sets as they were at the
     start of this phase, so the order in which statuses are defined does
     not change the result;
   - statuses are also evaluated once in the `World` constructor, after the
     initial clamp.

   Determinism must hold: the same definition, seed and intents give the
   same hashes.
7. **Defeat.**
   - `start` gains an optional `defeat` field:
     `{ when: <expression>, message?: string }`. `message` defaults to
     `"Game over"`.
   - The expression is evaluated with `self` set to the player.
   - When it becomes truthy, the world records
     `defeat: { tick, message }` (exposed as `world.defeat` and included in
     the snapshot). From then on `step()` is a no-op and `queueIntent`
     ignores input.
   - Without `defeat`, the game never ends, as it does today.
8. **`lighting` domain** (one mapping):

   ```yaml
   lighting:
     tint:
       - { at: "05:00", color: "#3a4a80" }
       - { at: "07:00", color: "#ffffff" }
       - { at: "19:00", color: "#ffd9b0" }
       - { at: "21:00", color: "#3a4a80" }
   ```

   - `tint` is a non-empty list of keyframes. Each keyframe has `at`, an
     `"HH:MM"` time, and `color`, a `#rrggbb` value.
   - The tint is a linear RGB interpolation between consecutive keyframes by
     time of day. It wraps around midnight from the last keyframe back to
     the first. A single keyframe gives a constant tint.
   - A pure function `tintAt(lighting, timeOfDay)` in `src/core/` returns
     the colour. The resolved `lighting` is on `Definition`, or `null` when
     no pack defines it (which means no tint).
   - **At most one** loaded pack may define `lighting`, with the same rule
     and error as `clock`.
9. **Validation.** Every new rule reports errors with pack, file, line and
   key path, and the loader still collects all errors before failing. New
   load errors:
   - `every` is non-positive, or is not a whole number of ticks;
   - `effects` is empty;
   - an effect has an unknown type;
   - an effect is missing `measurement`/`delta`/`value`;
   - an unknown measurement in an effect or in a `rates` key (with a
     suggestion);
   - an expression in `for`/`when`/`until`/`defeat.when` evaluates to an
     entity or tile;
   - a `delta`/`value`/`rates` expression is not numeric;
   - `has_status` gets a non-literal id or an unknown one;
   - malformed tile tags;
   - `lighting` problems:
     - an empty `tint`;
     - a malformed time or colour;
     - duplicate `at` values;
     - a second pack defines `lighting`.

   `Definition` gains `systems`, `statuses`, `lighting`, the matching
   `ids.systems` / `ids.statuses` lookups, `TileDef.tags` and
   `start.defeat`.

### Shells

10. **HUD.**
    - `hudModel` gains `statuses`, the labels of the player's active
      statuses in definition order, and `defeat`, which is the message plus
      the formatted clock at the defeat tick, or `null`.
    - The ASCII HUD adds a `Status: A, B` line only when at least one status
      is active, and a defeat line only when defeated. Existing ASCII
      snapshot tests (which have no statuses) must stay byte-identical.
    - The browser HUD shows the same lines. On defeat it also shows a
      centred banner over the canvas. The camera still pans and zooms, but
      movement input is ignored.
    - The terminal shell keeps rendering after defeat until `q`.
11. **Day/night tint (iso).**
    - The iso scene multiplies the ground and object layers by
      `tintAt(lighting, timeOfDay)`. Path/target markers and the DOM HUD are
      not tinted.
    - `timeOfDay` is computed from `tick + alpha`, so the tint changes
      smoothly between ticks. Add a pure clock helper for fractional ticks
      if needed, and do not accumulate floats.
    - With no `lighting`, nothing is tinted and the scene looks as it does
      in M1.
    - The ASCII renderer ignores `lighting`.

### Two-genre validation

12. Both genre packs use every new primitive:
    - tile tags;
    - at least one status with `rates`;
    - at least one system that hurts and one that restores;
    - `start.defeat`;
    - `lighting`.

    They must not need any engine code. Suggested content, to be tuned by
    the implementer:
    - **zombie:**
      - add a `fatigue` measurement;
      - add *Hungry*, *Thirsty* and *Exhausted* statuses with hysteresis,
        each draining `base:hp`;
      - restore via systems on tagged tiles (e.g. `food`, `water`, `bed`),
        adding new walkable tiles to `town` where needed;
      - defeat on `player.base:hp <= 0`.
    - **vampire:**
      - a *Sunburnt* status or a sunburn system for `undead` entities on
        `sunlit` tiles (e.g. floor next to windows, or outdoors) while
        `world.is_day`;
      - a *Starving* status when `blood` is low, draining `hp`;
      - a `blood` source tile (tag) that restores blood;
      - `shade` / `crypt` tiles where the vampire is safe by day;
      - defeat on hp ≤ 0.

    Headless scenario tests (see AC 13) must show that, for each genre:
    - an idle player gains at least one status during the first in-game
      day, and is defeated within the first **two** in-game days;
    - a scripted player that uses the restoring tiles (goto intents) is
      still alive at the end of day 2.

    `npm run check` must pass for both combos, and `src/` must contain no
    genre words.

### Tests, performance and docs

13. Extend `npm test` with:
    - the systems schedule: phase, `every` → ticks conversion, and the
      `for`/`when` order;
    - `apply`/`set` sequencing, and clamping only at the clamp phase;
    - status enter/exit with hysteresis, independence from definition
      order, and `rates` applied from the next tick;
    - `has_status` at load and at runtime;
    - tile tags in expressions;
    - defeat freezing the world and ignoring intents;
    - determinism with statuses and systems, including hash equality across
      two runs;
    - `tintAt`: keyframe hits, midpoints, midnight wrap, single keyframe;
    - one failing loader fixture per new rule in AC 9;
    - the HUD model with statuses and defeat;
    - the two-genre scenario tests from AC 12, run on the real packs.
14. `npm run bench:sim` still runs and includes systems and statuses. A
    system that is not due costs no expression calls on that tick. Report
    the ticks/s before and after in the PR description.
15. Documentation:
    - `docs/packs.md` documents `systems`, effects, `statuses`, tile
      `tags`, `start.defeat` and `lighting`, with examples and the tick
      order;
    - `docs/expressions.md` documents `has_status` and `tile.has_tag`;
    - `docs/iso.md` mentions the tint;
    - `VISION.md` marks M2 as done, records the decisions in §7 (systems use
      sim seconds; statuses use `when`/`until` hysteresis; `lighting` is its
      own domain; `start.defeat`) and updates §8.

## Out of Scope

- Actions, durations, items, eating or sleeping as player actions (M3/M5).
  Restoring happens only by standing on tagged tiles.
- Effects on entities other than `self`, spawning, messages or logs,
  effects on tiles, and system `offset`/phase fields.
- Status icons, per-status tint or glyph overrides, and status stacking or
  intensity levels.
- Lighting as a sim concept (light level in expressions, light sources,
  shadows, vision). The tint is visual only.
- Restart after defeat (reloading or re-running is enough), win
  conditions, and save/load.
- Game-time units for `every` (e.g. `30m`), and pack override semantics
  for `lighting`/`clock` (M7).

## Design Notes

- Compile systems and statuses like `rate`/`max`: expressions become
  closures at load time and ids become indices. Store active statuses per
  entity as a `Uint8Array` (or a bitset) indexed by status index, so that
  `has_status` compiles to `(c) => c.self.st[k] === 1`.
- Pre-compute per status which measurement indices its `rates` touch.
  Drift then becomes: base rate plus, for each active status, its folded
  constant or closure. Keep the constant-rate fast path (no expression call
  when all terms are constants).
- Group systems by period in a small schedule (e.g. `Map<period,
  systems[]>`) so that each tick only visits due groups.
- For the status update, compute the next status flags into a scratch
  buffer, then swap. That is what makes the result independent of
  definition order (AC 6).
- In Pixi v8 `Container.tint` propagates to children. Setting it on the
  ground and object containers is enough. Only update it when the colour
  changes.
- Clock helpers already derive time from the integer tick. For the tint,
  `minuteOfDay` over `tick + alpha` is fine because it is still a single
  division, not an accumulation.
- `start.defeat.message` is plain pack text. The engine's default
  (`"Game over"`) must stay genre-neutral.

## Agent Notes

- Read `VISION.md` §4 (the `systems` sketch), `docs/packs.md`,
  `docs/expressions.md`, `src/core/sim/world.ts`, `src/core/expr/compile.ts`
  and `src/core/load/load.ts` first.
- Suggested order:
  1. tile tags;
  2. `statuses` plus `has_status`;
  3. `systems` and effects;
  4. the tick order and defeat;
  5. `lighting` and `tintAt`;
  6. the HUD and shells;
  7. the iso tint;
  8. pack content and scenario tests;
  9. bench and docs.
- Scenario tests should drive the real packs with `goto` intents. Keep them
  fast: 2 in-game days is about 28,800 ticks with the default clock, which
  is cheap headless. Tune pack numbers so the idle and scripted outcomes
  are robust across seeds (test a few seeds).
- Do not break `npm run play` for either genre. Map edits must keep
  exactly one player start and a rectangular map.
- Chromium is unavailable in the sandbox. Keep Pixi code thin and put
  colour logic in pure, tested functions.
