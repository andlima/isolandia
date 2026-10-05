---
id: m6-save-load
area: sim
priority: 40
depends_on: [m5-recipes]
description: M6 persistence — a versioned JSON save file (`world.save()` / `World.restore()`) built on the snapshot, with exact round-trip equivalence (same snapshot, same future hashes), id-level validation against the loaded packs, browser quicksave/quickload, three save slots and file export/import, and terminal `--load` / `S` / `L`
---

# M6a — Save and load

## Goal

Exploring a town takes longer than one sitting. This spec makes a running
world **persistent**: the core can turn a `World` into a JSON save file
and rebuild an equivalent `World` from it, and both shells can save and
load.

"Equivalent" is strict. A restored world has the **same snapshot**. Given
the same inputs, it reaches the **same hashes** as the original on every
later tick. The determinism the engine already guarantees therefore
survives a save/load cycle. Later M6 specs (`m6-tiled-maps`, `m6-floors`,
`m6-chunked-world`) extend the format and must keep this guarantee.

No engine code may be genre-specific.

## Acceptance Criteria

### Snapshot changes

1. `WorldSnapshot` gains what a restore needs that it lacks today:
   - **`nextContainer`**: the next container id. Ids are never reused, so
     this cannot be derived from the live containers once a ground pile
     has been removed.
   - **`seed`**: the world seed, which `World` now keeps as
     `readonly seed`.
   - **`tiles`** changes from `[cellIndex, tileId]` to
     **`[x, y, tileId]`**, sorted row-major. This keeps saves readable and
     independent of the cell-index layout, which `m6-floors` changes.

   The new fields are part of `hash()`. No test pins literal hash values,
   so only the shape changes. Every existing determinism test must still
   pass.

### Core API

2. **`world.save(): SaveFile`** returns a plain JSON-serializable object:

   ```ts
   interface SaveFile {
     format: 'isolandia-save';
     version: 1;
     /** Loaded packs, in load order. */
     packs: { namespace: string; version: string }[];
     /** Qualified id of the start map, and its size. */
     map: { id: string; width: number; height: number };
     state: WorldSnapshot;
   }
   ```

   - `save()` is **pure**: it does not change `hash()`, draw RNG or
     record warnings.
   - It works on an ended world (defeat or victory).
   - It contains no wall-clock time. Shells add their own metadata
     (AC 8) outside `SaveFile` or in a wrapper.
3. **`World.restore(def, save): RestoreResult`**, where:

   ```ts
   type RestoreResult =
     | { ok: true; world: World; warnings: string[] }
     | { ok: false; errors: string[] };
   ```

   - It never throws on bad input, including non-objects, wrong types
     and truncated JSON that the caller already parsed.
   - It reports **all** errors it can find, not just the first.
4. **Validation.** These are errors:
   - `format` is not `isolandia-save`, or `version` is unsupported. The
     message names the supported versions.
   - The **pack namespaces** differ from `def.packs`, in order. The
     message lists both lists.
   - The map id or size differs from the definition's start map.
   - Any **qualified id** does not resolve: archetype, measurement,
     status, item, tile, action, recipe, or behavior state name for the
     entity's archetype behavior. Each error includes a *did you mean*
     suggestion (reuse `nearMiss`) and the JSON path, e.g.
     `state.entities[12].archetype`.
   - Entity ids are not exactly `0..n-1` in order, or `player` is not
     one of them.
   - An inventory's `owner` is missing, or its archetype has no
     `inventory`. An archetype with an `inventory` whose entity has no
     inventory container in the save is also an error.
   - A container `id` is duplicated or `≥ nextContainer`.
   - A cell (entity position, `from`, `home`, path cell, container cell,
     changed tile, activity target, heard noise, plan) is out of bounds.
   - A tile container's cell does not hold a container tile in the
     restored grid. Changed tiles are applied before this check.

   These are **warnings**, and the restore still succeeds:
   - A pack's **version** differs from the save.
   - A measurement the archetype now has is missing from the save. It
     gets the archetype's initial value.
   - A saved measurement the archetype no longer has is dropped.

   Behaviour, item and recipe data changes inside a pack (new effects,
   different durations) are not detected. The save stores state, not
   rules.
5. **Exact restore.** A restored world:
   - does **not** roll loot or draw RNG. Containers, stacks, their order
     and loads come from the save; loads are recomputed from item weights;
   - sets `tick`, the RNG state, the action queue, `lastAction`,
     `defeat`/`victory`, every entity field in the snapshot (position,
     `from`, `stepTick`, cooldown, facing, remaining path with
     `pathPos = 0`, measurements, statuses, `intent`, `lastGoto`, `home`,
     behavior state/since/plan, heard noise, activity, `then`) and the
     changed tiles, through `Grid.setTile` so that walkability and
     opacity follow;
   - rebuilds the activity from its source ids, target, `startTick` and
     `endTick`, with the same `Activity` object shape `ActivityRunner`
     creates;
   - recomputes each entity's `max` **without** re-clamping values, and
     does **not** re-run status updates. The saved status flags are kept
     as they are;
   - starts with no pending noises and no expression warnings, and
     builds its pathfinder lazily, as `World.create` does.
6. **Round-trip invariant.** For any world `w` built from the shipped
   packs or test fixtures:
   - `World.restore(def, JSON.parse(JSON.stringify(w.save())))` gives a
     world whose `snapshot()` deep-equals `w.snapshot()`;
   - stepping both worlds `N` more ticks with the same intents and actions
     gives equal `hash()` on **every** tick;
   - restoring and saving again gives a `SaveFile` that deep-equals the
     first.

   A shared helper `assertRoundTrip(world, script)` in `test/helpers.ts`
   checks all three. The later M6 specs reuse it.

### Shells

7. **Browser.**
   - **F5 quicksaves** and **F9 quickloads**. Both call
     `preventDefault`, so F5 never reloads the page.
   - The **`O` key** and a HUD button toggle a **"Game" panel**. It shows
     the quicksave and **three slots**. Each shows `Day N, HH:MM`, the
     tick and a saved-at wall-clock time. Each has **Save**, **Load**
     (disabled when empty) and **Delete** buttons.
   - The panel also has **Export** (downloads `isolandia-<packs>-day<N>.json`)
     and **Import** (a file input). An import goes through
     `World.restore` like a slot load.
   - Storage is `localStorage`, under a key that includes the
     comma-joined pack list (`isolandia:save:std,std-needs,zombie:slot1`),
     so each game has its own slots. Every read and write is in
     `try/catch`. A failure (quota, private mode, blocked storage) shows a
     short message in the panel or HUD and never breaks the game.
   - **Loading replaces the running world**:
     - the scene, HUD, panels and context menu are rebuilt (or reset)
       for the new world, with no references to the old one left;
     - the fixed-tick loop's accumulator is reset;
     - the camera recenters on the player.
   - Load errors from AC 4 show in the panel as a list. The current game
     keeps running. Warnings show as a dismissible note after a
     successful load.
   - Saving and loading are allowed after defeat or victory. Loading
     un-freezes the game if the saved world had not ended.
   - The panel's view model is a pure function, as in `panels.ts`:
     slot metadata in, rows out. Storage access sits behind a small
     `SaveStore` interface (`list/read/write/remove`) with a
     `localStorage` implementation and an in-memory one for tests.
8. **Slot metadata** is stored next to the `SaveFile`, never inside
   `state`:
   - `{ savedAt: ISO string, day, time: "HH:MM", tick, packs }`;
   - wrapper: `{ meta, save }`.

   Export writes the same wrapper. Import accepts both the wrapper and a
   bare `SaveFile`.
9. **Terminal.**
   - `npm run play -- <packs…> --load <file>` starts from a save instead
     of a fresh world. Errors are printed and the exit code is 1;
     warnings are printed and the game starts.
   - `--save-file <path>` (default `isolandia-save.json` in the current
     directory) names the file used in-game:
     - **`S`** writes it (wrapper format) and shows `Saved to <path>.`;
     - **`L`** loads it and shows `Loaded <path>.` or the first error,
       plus `(+N more)`.
   - `--seed` together with `--load` is an error, since the save carries
     its seed.
   - `handleKey` stays free of I/O. It returns `'save'` or `'load'` (as
     it returns `'quit'`), and the terminal loop does the file work.
   - `S`/`L` must be matched **before** the lowercase `KEYMAP` fallback,
     which today turns Shift+`s`/Shift+`l` into moves. They stop being
     moves; lowercase `s`/`l` still move.
10. **Check CLI.** `npm run check -- <packs…> --save <file>` validates a
    save against the packs and prints errors and warnings in the
    existing `check` style. The exit code is 1 on errors.

### Tests and docs

11. Headless tests cover:
    - **Round trip** (`assertRoundTrip`) on `std`+`std-needs`+`zombie`,
      `std`+`vampire` and `garden`, saving:
      - at tick 0;
      - mid-path, and with a `goto.then` pending;
      - mid-activity (an action, a timed item use, a recipe);
      - after a ground pile was created **and removed**, which checks
        `nextContainer`;
      - after `set_tile`;
      - with NPCs in every behavior activity, including `investigate`
        after a noise;
      - after defeat.
    - **Scripted fuzz:** for each genre, a seeded random script of
      steps, gotos and actions over 600 ticks. It saves at three random
      ticks and asserts round-trip equivalence to the end.
    - **Validation:** every error and warning in AC 4, each with its
      JSON path, and that `restore` never throws on garbage (`null`, `[]`,
      `{}`, wrong types in every field of a valid save).
    - **Purity:** `save()` leaves `hash()` unchanged.
    - **Browser models:** the Game panel's view model, `SaveStore`
      (in-memory), the quota-failure message, wrapper/bare import and the
      export file name.
    - **Terminal:** the `S`/`L` key handling via the existing
      `handleKey` test seam.
    - **Guards:** the genre-word guard and every existing determinism test
      still pass.
12. **Docs.**
    - A new `docs/saves.md`: the file format, the version policy (bump
      `version` on any breaking change to `state`; `restore` keeps
      reading every older version it lists), the validation rules, the
      round-trip invariant, and the shell controls.
    - `docs/ui.md` lists the new keys.
    - `VISION.md` §7 records the decisions:
      - a save is a snapshot plus pack identity;
      - restore is exact and rolls nothing;
      - pack version drift is a warning and id drift is an error;
      - saves live in browser `localStorage` slots and exported files.

## Out of Scope

- Autosave, saving on a timer, and saving on quit.
- Compression or binary formats. Plain JSON is enough, and a 256×256
  town with ~1000 entities must still fit in `localStorage`. Note the
  measured size in `docs/saves.md`.
- Migrating saves across **pack** changes beyond the warnings in AC 4.
  Mod and override semantics are M7.
- Saving the camera, open panels or other UI state.
- Cloud sync and multiple save profiles.
- Saving the definition itself. A save is only valid with the same packs
  loaded.

## Design Notes

- Build `save()` on `snapshot()`, and restore by creating a world without
  side effects and then overwriting its state. A private constructor path
  (for example `new World(def, seed, { restore: true })`) skips spawning,
  container creation and `rollLoot`. Do **not** create a normal world and
  then patch it: `rollLoot` and the constructor's clamp/status update
  would already have run.
- Resolve ids with `def.ids`. Collect errors in one pass and do not stop
  at the first.
- Keep the restore code in its own module (`src/core/sim/save.ts`) that
  reaches into `World` through a narrow internal interface. `world.ts`
  is already 1400 lines.
- The `Activity` rebuild must not call `ActivityRunner.start`. That
  re-runs start checks and could record a different `lastAction`.
  Construct the activity from the source and the saved ticks.
- Browser world swapping is easiest if `main.ts` gains a small
  `GameSession` that owns world, scene, HUD, panels and menu, with a
  `dispose()`. Keep the camera rig and the Pixi `Application` across
  sessions.

## Agent Notes

- Read these first:
  - `src/core/sim/world.ts` (`snapshot`, constructor, `spawn`,
    `addContainer`, `pruneGround`);
  - `src/core/sim/activity.ts`;
  - `src/web/main.ts`, `src/web/panels.ts`;
  - `src/ascii/terminal.ts`, `src/cli/play.ts`, `src/cli/check.ts`.
- Write `assertRoundTrip` first and run it on a world at tick 0. It will
  find every field the restore misses.
- `Float64Array` measurement values must survive JSON exactly. Values
  are finite doubles, and `JSON.stringify` round-trips them. `Infinity`
  only appears in `max`, which is recomputed, never saved.
- Chromium is unavailable in the sandbox. Keep the browser logic in pure
  functions and test those.
