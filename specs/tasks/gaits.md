---
id: gaits
area: sim
priority: 40
depends_on: []
description: "Gaits (run and sneak): archetypes declare `gaits: { run: { ticks_per_step: 1, noise: 6 }, sneak: { ticks_per_step: 4 } }`, every entity carries a current gait as simulation state (snapshots, hashes, save version 9), a step uses the gait's ticks and emits its footstep noise at the landing cell through the existing noise events, expressions read `self.gait`; the browser runs while Shift is held and toggles sneak with Z, the terminal toggles with r and z, both HUDs show the gait; the resident, humanoid and bunny get run and sneak, the vampire sneak only, and std-needs tires a runner. No new frames: the walk cycle plays at the step's pace."
---

# Gaits: run and sneak

## Goal

Every entity moves at one speed today, its archetype's `ticks_per_step`,
and the only footstep noises are the pack's `on: step` systems (glass,
gravel, creaky boards). This task adds **gaits**: a pack declares, per
archetype, named ways of moving with their own ticks per tile and footstep
noise (`run` is fast and loud, `sneak` slow and quiet), the player picks
one in either shell, and the simulation moves and emits noise accordingly.
It is the simulation half of the M10 "frames and gaits" item in
`VISION.md` §7 (the walk frames landed as task `walk-cycle`); the renderer
needs no new drawings because the walk cycle is clocked by the step
itself, so it simply plays faster or slower.

Engine code stays genre-agnostic (`VISION.md` §3): the engine knows
"gaits" as a vocabulary (a name, a step duration, a noise radius); which
gaits exist, their names and numbers are pack data. `walk` is the one name
the engine reserves, as the default gait every entity has.

## Acceptance Criteria

### Pack schema (`docs/packs.md` → `archetypes`)

1. **New archetype field `gaits`**, an optional mapping from gait name to
   `{ ticks_per_step?, noise?, label? }`:
   ```yaml
   archetypes:
     - id: resident
       ticks_per_step: 2
       gaits:
         run:   { ticks_per_step: 1, noise: 6, label: Running }
         sneak: { ticks_per_step: 4, label: Sneaking }
   ```
   - A gait name is `[a-z][a-z0-9_]*`; anything else is a load error at
     the key with the path (`archetypes[3].gaits.Run`).
   - `ticks_per_step` is a positive integer, as the archetype's; it is
     **required** for every gait except `walk`.
   - `noise` is a number ≥ 0, default `0`: the radius of a footstep noise
     emitted at every landing (criterion 6). `0` emits nothing.
   - `label` is a string, default the name with its first letter in upper
     case (`Run`); the HUD shows it.
   - Unknown keys inside a gait are load errors with a *did you mean*, as
     elsewhere in the loader.
2. **`walk` is implicit.** Every archetype has gait `walk`, index 0, with
   the archetype's `ticks_per_step`, `noise: 0` and label `Walking`. A
   pack may restate it under `gaits` to change `noise` or `label`;
   `walk.ticks_per_step` is a load error ("set the archetype's
   `ticks_per_step`") so one number never appears in two places.
   Declared gaits follow in mapping order (indices 1…n).
3. **Definition.** `ArchetypeDef` gains `gaits: readonly GaitDef[]`
   (`{ name, ticksPerStep, noise, label }`, `[0]` always `walk`) and
   `ticksPerStep` stays as the walk value for every existing caller.
   `gaits` is an ordinary top-level field for overrides: replaced whole
   with `override: true`, `gaits: null` leaves only `walk`; `check
   --overrides` lists it like any other field.

### Simulation (`src/core/sim`)

4. **Gait is entity state.** `Entity` gains `gait: number` (index into
   its archetype's `gaits`, 0 at spawn) and `stepTicks: number` (the
   duration in ticks of the step in flight; equals the walk ticks before
   any step). `stepProgress` divides by `e.stepTicks` instead of
   `e.archetype.ticksPerStep`, so `renderPosition` and `walkFrame` need no
   change and a gait change never moves the sprite mid-step.
5. **A step uses the current gait.** `move` and `climb` set
   `moveCooldown` and `stepTicks` to the gait's `ticksPerStep`. The
   pursue/wander/home activities, keyboard steps, goto paths, link steps
   and the `ready` test (`moveCooldown ≤ 1`) all pick it up through
   `moveCooldown`; nothing else in the tick order changes. `ticks_per_turn`
   is not a gait property and is unchanged.
6. **Footstep noise.** Right after a landing in `move` or `climb`, a gait
   with `noise > 0` emits a noise of that radius from the entity (its new
   cell), through `emitNoise`, so it is heard in the same tick's hear
   phase, listed in `world.noises`, triggers `on: noise` systems and event
   interrupts, and never reaches its own source. It is emitted in phase 1
   before the step systems, so a runner on glass makes two noises that
   tick (the gait's and `crunch`'s); the hear phase keeps the nearest per
   listener as today.
7. **`world.setGait(name)`**: a synchronous player input (like
   `queueIntent`, called between ticks) that sets the player's gait by
   name and returns `true`, or returns `false` and changes nothing when
   the player's archetype has no gait of that name. It takes effect from
   the next step; the step in flight keeps its `stepTicks`. It is not an
   intent: it does not replace or cancel a pending step or goto, a path or
   an activity. There is no NPC API in this task (criterion 17).
8. **Expressions.** `self.gait` (and `player.gait`, `npc.gait`, any entity
   value) is the gait **name** as a string, typed `string`, so
   `self.gait == "run"` and `self.gait != "walk"` compile with the existing
   `==` / `!=`. `gait` joins `ENTITY_FIELDS`, so like `sees` it shadows a
   measurement of the same short name (no shipped pack has one; no new
   loader check is required). `docs/expressions.md` documents it under
   the entity fields, with the shadowing noted as for the other fields.
9. **Snapshots, hashes and saves.** `EntitySnapshot` gains `gait` (the
   name, **omitted when `walk`**) and `stepTicks` (always written).
   `SAVE_VERSION` becomes 9; versions 3 to 8 still load with every entity
   walking and `stepTicks` = its archetype's walk ticks (no warnings). A
   version 9 `gait` naming a gait the entity's archetype lacks is a restore
   error with the JSON path and the archetype's gait names; a non-integer
   or < 1 `stepTicks` is an error. `assertRoundTrip` holds across a run
   where the player changes gait mid-step. `docs/saves.md` gets the version
   row and the upgrade paragraph.

### Shells

10. **Browser keys** (`src/web/keys.ts`, `input.ts`, `bindings.ts`):
    - **Hold Shift to run.** `ShiftLeft` / `ShiftRight` keydown and keyup
      are tracked like movement keys (through a `run` binding in
      `BINDINGS`, section *Moving*, keys `['Shift']`, label `Run (hold)`),
      not through `on.key`. While Shift is held the shell wants gait `run`;
      `window` blur and the pause clear it like held movement keys.
    - **Tap `Z` to toggle sneak** (binding `sneak`, codes `['KeyZ']`,
      label `Sneak (toggle)`, no auto-repeat). The toggle is shell state,
      shown in the HUD, and survives Shift: Shift held wins while held,
      release returns to sneak if toggled, else walk.
    - **Applied before every tick**, in `Input.beforeTick`, next to the
      held-step re-queue: the shell calls `world.setGait(want)` with the
      wanted gait (`run` while Shift is held, else `sneak` if toggled, else
      `walk`) **only when it differs from the player's current gait**, so a
      no-op costs nothing. When the archetype lacks the gait (`false`), the
      shell keeps wanting it silently (the vampire ignores Shift and the
      HUD shows nothing).
    - Shift + click still walks there (unchanged); a goto path runs while
      Shift stays held and walks once released, because the gait is set
      per tick and read per step.
    - Touch has no run or sneak control (out of scope).
11. **Terminal keys** (`src/ascii/terminal.ts`, `bindings.ts`): `r`
    toggles run and `z` toggles sneak (pressing the active one goes back to
    walk; the other replaces it). They call `world.setGait` at once (the
    terminal has no held keys); when the archetype lacks the gait the
    message line says `You can't run.` / `You can't sneak.` (the label in
    lower case). Both rows join `TERMINAL_BINDINGS` under *Moving*; the
    help line is unchanged apart from the `?` screen listing them. `r` and
    `z` were free; `s` and `l` keep moving.
12. **HUD** (`src/core/hud.ts`, `src/web/hud.ts`): `HudModel` gains
    `gait: string | null`, the gait's label when the player's gait is not
    `walk`, else null. `hudLines` adds it as its own line right after the
    measurements (before carrying); the browser HUD shows it as a chip
    next to the status chips (neutral grey), rebuilt only when it changes,
    like the rest of the view. `docs/ui.md` (HUD and Keys, both shells)
    and the terminal paragraph are updated; the Keys-table test
    (`test/help.test.ts`) still passes with the new rows.
13. **Renderer: nothing new.** The walk cycle's frame comes from
    `stepProgress`, so running plays a frame every 50 ms and sneaking
    every 200 ms with no change to `src/iso`; `docs/iso.md` (facing
    bullet) gets one sentence saying so. No run or sneak frames.

### Packs

14. **Shipped gaits** (numbers from `VISION.md` §7: run 1, walk 2, sneak 4
    at 10 ticks/s):
    | Archetype | walk | run | sneak |
    |---|---|---|---|
    | `std:humanoid` | 2 | 1, noise 6 | 4 |
    | `town:resident` | 2 | 1, noise 6 | 4 |
    | `garden:bunny` | 2 | 1, noise 3 | 4 |
    | `vamp:vampire` | 1 | — | 2 |
    The vampire already walks at 1 tick, so it has no `run` (Shift does
    nothing, the terminal says `You can't run.`); that is the shipped case
    for criterion 7's `false`. Labels `Running` / `Sneaking`. The zombie,
    noir and western players are `town:resident` through the town base, so
    every shipped game except the vampire's can run; the shamblers hear a
    runner within 6 tiles and `investigate` as they do glass.
15. **Running costs something.** `std-needs` adds a system `running`
    (`every: 1`, `for` the file's `living` default, `when: 'self.gait ==
    "run"'`) that applies `fatigue` at about three times the day-time
    drift (`+0.25` per second; the implementer may tune it so a minute of
    running is noticeable but not exhausting). This is the shipped use of
    `self.gait`.
16. **`check`** runs clean on every shipped stack (`npm run check`), and
    `check --overrides` is unchanged in shape.

### Out of scope markers, tests, docs

17. **NPCs keep walking.** No behavior field sets a gait and no activity
    changes it; `gait` is 0 for every NPC forever in this task. The field
    is per entity so a later task can add a behavior-state `gait` without
    touching saves again.
18. **Tests** (`node:test`, headless):
    - Loader (`test/gaits.test.ts` or next to the archetype tests): the
      happy path (indices, `walk` first with the archetype's ticks, labels
      defaulted and given, `noise` default 0), and each error in criteria 1
      and 2 asserting file, path and message.
    - Sim: a run step sets `moveCooldown` and `stepTicks` to 1 and emits a
      noise at the landing cell heard by a listener in range and not by the
      runner; a sneak step takes 4 ticks; `setGait` mid-step leaves
      `stepProgress` continuous (the same values before and after the
      call) and the **next** step uses the new ticks; `setGait` with an
      unknown name returns `false` and changes nothing; a goto path
      switches pace between steps when the gait changes; `self.gait` in a
      system `when` fires only while running; `hash()` changes when the
      gait changes.
    - Saves: round trip with a gait set mid-step; a version 8 fixture
      loads walking with the right `stepTicks`; the two version 9 errors.
    - Shells: `MoveKeys`-style unit tests for the wanted gait (Shift held,
      Z toggled, both, release, blur/pause clear), the terminal toggles
      and refusal messages, `hudLines` with and without a gait.
    - Determinism: `npm run bench:sim` unchanged (NPCs never change gait).
19. **`npm test`, `npm run typecheck`, `npm run check` pass.** `npm run
    smoke` and `npm run bench` are reported as not runnable in the sandbox
    if that is still the case, not as passing.
20. **Docs.** `docs/packs.md`: the `gaits` row in the archetype table and a
    `#### Gaits` subsection (the fields, the implicit `walk`, the noise
    rule and when it is heard, the override rule, the example above);
    the tick-order paragraph of phase 1 and the noise bullet of phase 4
    mention gait footsteps. `docs/expressions.md`: `gait` under entity
    fields. `docs/saves.md`, `docs/ui.md`, `docs/iso.md` as in criteria
    9, 12, 13. `VISION.md` §7, the M10 "frames and gaits" bullet: a note
    that gaits landed as task `gaits` (archetype `gaits`, `self.gait`,
    footstep noise, Shift / Z and r / z) and that idle and activity poses,
    per-gait frames and spritesheets remain for `m10-anim-gaits`; §5's
    M10 row is unchanged (still open).

## Out of Scope

- NPC gaits: behavior states or activities choosing a gait (`chase: { do:
  pursue, gait: run }`), a `gait` effect. The data model allows it later.
- Run, sneak or idle animation frames, activity poses, spritesheets.
- Sneaking affecting sight (`senses` modifiers, a per-gait `conceals`);
  packs can approximate it with a status on `self.gait == "sneak"`.
- A touch control for running or sneaking; a HUD button.
- Stamina or a speed cap from statuses (`burdened` slowing the walk);
  `ticks_per_step` stays a per-gait constant.
- A finer tick rate (ruled out in `VISION.md` §7); the vampire therefore
  has no `run`.
- Wall muffling, per-archetype hearing ranges, noise kinds.

## Design Notes

- **Why `stepTicks` on the entity.** `stepProgress` needs the duration of
  the step in flight; reading the current gait's ticks would make the
  sprite jump when Shift is pressed mid-step. Storing the duration with
  the step (set where `moveCooldown` is) keeps `renderPosition` exact and
  makes the restore exact for the price of one integer per entity. It is
  always written in saves because it is not derivable after an upgrade of
  gait mid-step.
- **Why `setGait` applies at once and not via an intent.** Intents are one
  per entity and would collide with the pending step or goto; the gait is
  orthogonal state read at step time, so an immediate write between ticks
  is deterministic (shells only touch the world between ticks) and leaves
  the intent queue alone. The browser applies it in `beforeTick` so Shift
  behaves like a held key with no per-frame work.
- **Why the noise goes through `emitNoise` in phase 1.** It reuses the
  pending list, the chunked hearing, `on: noise` systems, interrupts and
  `world.noises` unchanged, and it is heard in the same tick as the `on:
  step` systems' noises. Do not make it an `on: step` system: it has no
  pack definition and must not count as `fired`.
- **Expression field.** Add `gait` to `ENTITY_FIELDS` and `entityMember`
  as `{ fn: guarded(t, 'walk', (e) => e.archetype.gaits[e.gait].name),
  type: 'string' }`; `ExprEntity` gains `gait?: number` and the archetype
  reference it already lacks, or simpler, a `gaitName?: () => string`;
  pick what keeps `ExprEntity` free of `ArchetypeDef`. Compare with how
  `sees` is guarded for a null entity.
- **Loader.** `gaits` goes in the archetype's field list
  (`src/core/load/load.ts`, `archetype()`), parsed by a `gaits(f, ticksPerStep)`
  helper beside `senses(f)`; reuse `f.mapping`, the name regex used for
  tags and the near-miss helper for unknown keys. `GaitDef` lives in
  `src/core/definition.ts` next to `SenseDef`.
- **Save checks.** In `checkEntity` (`src/core/sim/save.ts`) read `gait`
  by name against `archetype.gaits` and `stepTicks` with `c.int(…, 1)`;
  default both when `root.version < 9`. Follow the `seen`/version-8
  pattern for the version gate and the `docs/saves.md` wording.
- **Shell state.** Browser: a small pure `GaitKeys` (or a method on
  `MoveKeys`) holding `shift: boolean` and `sneak: boolean` with
  `want(): string`; `Input` feeds Shift keydown/keyup and the `Z` tap and
  exposes the wanted gait to `beforeTick`. Terminal: a `gait` field on
  `KeyState` is unnecessary since the world holds it; the toggle reads
  `world.player.gait` to decide between set and clear.
- **HUD chip.** The browser view already renders status chips from the
  model; the gait chip is one more entry in that list with a `neutral`
  tone and no tooltip, placed first so it does not reorder the statuses.

## Agent Notes

- Read first: `AGENTS.md`, this spec, `specs/tasks/walk-cycle.md` (how
  the step clock drives the frames), `specs/npc-perception.md` (the
  `senses` field: the loader, save and docs pattern to copy),
  `src/core/sim/motion.ts`, `src/core/sim/world.ts` (`move`, `climb`,
  `applyPlayerIntent`/the intent phase around line 2000, `emitNoise`,
  `snapshot`), `src/core/sim/save.ts` (`checkEntity`),
  `src/core/expr/compile.ts` (`entityMember`, `ENTITY_FIELDS`),
  `src/web/keys.ts`, `src/web/input.ts`, `src/web/bindings.ts`,
  `src/ascii/terminal.ts` (`handleKey`), `src/ascii/bindings.ts`,
  `src/core/hud.ts`, `docs/packs.md` (`archetypes`, `systems` noise,
  tick order), `docs/saves.md` (version policy).
- Order: definition + loader + tests → entity state, `move`/`climb`,
  `stepProgress`, `setGait`, noise + tests → expression field + test →
  snapshot, save version 9, restore + round-trip tests → HUD model →
  browser keys and HUD chip → terminal keys → packs and `std-needs`
  system → `npm run check` on every stack → docs and VISION.
- `test/animations.test.ts` asserts `ticksPerStep` on an archetype; it
  stays valid (walk ticks). `test/save.test.ts` fixtures carry version 8:
  add a version 9 fixture rather than editing them.
- The `walk` gait's `label` default is `Walking` but the HUD shows no chip
  for it; the label exists so a pack can show it if it restates `walk`
  (not needed for the HUD rule above).
- Chromium cannot start in the sandboxed shell, so `npm run smoke` and
  `npm run bench` fail for that reason; say so in the report instead of
  retrying.
- Frontmatter note: the `description` is quoted because it contains `: `.
