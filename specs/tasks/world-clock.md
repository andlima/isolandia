---
id: world-clock
area: core
priority: 30
depends_on: []
description: M2 groundwork — a pack-defined in-game calendar (day length, start time, daylight hours), world.day/hour/minute/time_of_day/is_day in expressions and the HUD, both genres using it; plus a VISION.md status refresh
---

# World clock and time in expressions

## Goal

Before the full M2 milestone (`systems`, `statuses`, day/night tint), give
the sim an **in-game calendar**. Game time is derived from the tick count
through a pack-defined time scale. Expressions can read the time of day, and
the HUD shows the in-game date and time. Both genre packs use it to prove
it's genre-agnostic: zombie starts in the morning, vampire at dusk, and
vampire blood drains faster in daylight.

Also refresh `VISION.md` so it reflects where the project stands.

This task introduces **no new sim state**. The clock is a pure function of
`tick`, so determinism, snapshots and hashes are unaffected.

## Acceptance Criteria

### Pack schema: `clock` domain

1. New optional top-level domain key **`clock`**, a single mapping (shaped
   like `start`). Fields and defaults:

   | Field        | Type             | Default   | Meaning |
   |--------------|------------------|-----------|---------|
   | `day_length` | number (seconds) | `1440`    | Real (sim) seconds per in-game day. `1440` means 1 sim second = 1 game minute |
   | `start`      | `"HH:MM"`        | `"08:00"` | In-game time of day at tick 0, on day 1 |
   | `dawn`       | `"HH:MM"`        | `"06:00"` | Daylight starts (inclusive) |
   | `dusk`       | `"HH:MM"`        | `"20:00"` | Daylight ends (exclusive) |

2. **At most one** loaded pack may define `clock`. A second definition is a
   load error that names the other pack, the same way duplicate `start` is
   handled. If no pack defines it, the engine defaults above apply, so
   existing fixtures and the base pack keep loading.
3. **Load errors**, reported with location like every other error:
   - unknown field (via the existing `Fields` mechanism);
   - `day_length` is not a finite number > 0;
   - a time that isn't `"HH:MM"` with `HH` in 00–23 and `MM` in 00–59;
   - `dawn` is not strictly before `dusk`. Daylight doesn't wrap past
     midnight in this task.
4. `Definition` gains `clock: { dayLength: number; start: number; dawn:
   number; dusk: number }`, with times stored as minutes since midnight
   (or an equivalent documented unit). Defaults are filled in by the loader.

### Clock model

5. A pure function in `src/core` (for example `clockAt(def.clock, tick,
   ticksPerSecond)`) returns:
   - `day`: integer, starting at 1;
   - `hour`: integer 0–23;
   - `minute`: integer 0–59;
   - `timeOfDay`: float hours in `[0, 24)`;
   - `isDay`: `dawn <= timeOfDay < dusk`.

   Game minutes elapsed = `(tick / ticksPerSecond) * 1440 / dayLength`,
   added to `start`, and they roll over into later days. `World` exposes
   this, for example a `clock` getter.
6. Unit tests cover:
   - tick 0 equals `start` on day 1;
   - rollover past midnight increments `day`;
   - `isDay` at exactly `dawn` (true) and exactly `dusk` (false);
   - a non-default `day_length`.

### Expressions

7. `world` gains the fields `day`, `hour`, `minute`, `time_of_day`
   (numbers) and `is_day` (boolean), next to the existing `tick` and
   `seconds`. `world.seconds` keeps its meaning (sim seconds, `tick /
   ticksPerSecond`), so `rate` stays per sim second. The unknown-field
   "did you mean" hint lists the new fields.
8. Evaluating a clock field must not allocate or parse. For example, the
   context carries what's needed and the field compiles to arithmetic over
   `ctx.tick`, or the world updates cached clock values once per tick.
   Values must be correct for the tick the expression runs in, meaning the
   same `ctx.tick` the tick loop already sets.
9. Tests:
   - each new field compiles and evaluates correctly at a known tick;
   - `world.is_day` works in arithmetic (`1 + world.is_day`);
   - `world.hours` (a typo) is a load error with a suggestion.

### HUD

10. `hudModel` shows in-game time:
    - `clock` becomes `Day D HH:MM`, for example `Day 1 08:02`;
    - `time` becomes `Time: Day D HH:MM (tick N)`.

    Both renderers pick this up through the shared `hudModel`. Update the
    ASCII snapshot in `test/render.test.ts` and the `hudModel` test in
    `test/web.test.ts` to the new strings. This is the only intended
    change to ASCII output. Remove `formatClock` if it's no longer used,
    or keep it if it's still useful.
11. Optional: add a small day/night marker to the HUD (e.g. `☀`/`☾` or
    `(day)`/`(night)`). If you add one, it goes in `hudModel` so both
    renderers get it.

### Two-genre usage

12. Each genre pack defines `clock`, and the two differ:
    - `packs/zombie`: `start: "08:00"`, other fields at their defaults or
      explicit.
    - `packs/vampire`: `start: "20:00"`, so the game begins at dusk.
    - Neither uses the base pack for `clock`. Base stays genre-neutral and
      doesn't define it.
13. At least one measurement in each genre pack reads the clock:
    - vampire `blood` drains faster in daylight, for example
      `rate: "-0.8 - 1.2 * world.is_day"`;
    - zombie: a small daytime or hour-based effect, for example thirst
      builds a bit faster during the day.

    `npm run check` passes for `base,zombie` and `base,vampire`. No genre
    words appear in `src/`.

### Docs

14. `docs/packs.md` gains `clock` in the domain table and a `### clock`
    section with the field table, the at-most-one rule and an example.
15. `docs/expressions.md` scope table lists the new `world.*` fields.
    `world.seconds` stays documented as sim seconds.
16. `docs/iso.md` HUD description mentions that the clock shows the
    in-game day and time.

### VISION.md refresh

17. Update `VISION.md` (it's in Portuguese; keep writing in Portuguese):
    - §5 roadmap table: add a status marker (column or suffix) showing
      **S0, M0, M1 as done**. Also note the pending S0 browser benchmark
      numbers from `docs/spikes/s0-results.md`.
    - §7: record the calendar decision. The time scale comes from a
      pack-defined `clock` (default 1 day = 24 real minutes). It's derived
      from the tick, adds no state, and at most one pack defines it until
      override semantics exist (M7). Point to `docs/packs.md`.
    - §8 "Próximo passo": replace the stale list (S0 → M0 → schema →
      renderer) with the real next step. That's the **M2 spec**
      (`systems`, `statuses`, day/night tint in iso), which builds on this
      clock. Mention open M2 design questions only briefly, and don't
      decide them.

### Gates

18. `npm run typecheck` and `npm test` pass. `npm run build` still
    succeeds.

## Out of Scope

- `systems`, `statuses`, `every:` intervals and any scheduler (M2 spec).
- Day/night tint or lighting in the iso renderer.
- Changing the tick rate, pausing, or fast-forward / time-scale controls in
  the shell.
- Daylight windows that wrap midnight, seasons, calendars with
  months/weekdays, per-day variation.
- Pack override semantics for `clock` beyond "at most one" (M7).
- Duration strings like `"24m"`. `day_length` is a plain number of seconds.

## Design Notes

- Follow the existing `start` domain handling in `src/core/load/load.ts`
  (`start()` + `Fields`) for parsing, the duplicate check and error
  locations. `pack.ts` needs `clock` added to the known domain keys, with
  single-mapping semantics like `start`.
- `WORLD_FIELDS` in `src/core/expr/compile.ts` drives both member
  compilation and the typo hint. The compiler doesn't currently get the
  calendar. Either pass clock constants through `ExprContext` (it already
  carries `tick` and `ticksPerSecond`) or cache per-tick clock values on
  the context from `World.step`. Whatever you choose, keep `ctx` updated
  before measurement rates run and before the constructor's initial clamp,
  where `tick` is 0.
- Clock numbers: with the defaults, tick 25 at 10 ticks/s is 2.5 sim
  seconds = 2.5 game minutes after 08:00, so `Day 1 08:02`. Use `floor`
  for minutes. Floating-point care: compute from integer ticks, and avoid
  accumulating per-tick increments.
- The vampire game starting at 20:00 with dusk at 20:00 means it starts at
  night (`isDay` false). That's intended.
