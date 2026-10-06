---
id: m7-town-base
area: content
priority: 40
depends_on: [m7-overrides, m7-stacks]
description: M7 playable result — a genre-free `town` base game (the 256×256 town, its tiles, furniture, mundane items, loot, cooking/bandage recipes, barricading, needs-driven resident; playable alone as a quiet sandbox), zombie and vampire rebuilt as `mod` packs on top of it (zombie populates the town via map overrides; vampire reuses base content but keeps its estate via start/clock/lighting overrides), a genre-agnostic `hardship` balance mod using overrides and removals, joint-validation coverage of mixed stacks, and a test that the base stays free of genre words
---

# M7c — One town, two mods

## Goal

The M7 promise from VISION §5: **"zombie and vampire as mods of the same
base."**

Today `zombie` and `vampire` are separate games. They duplicate generic
content: windows, furniture, food, the day/night setup. Neither can be
loaded with the other. This spec:

- extracts a **genre-free base game**, `town`;
- rebuilds both genres as **mods** of it, using the override and removal
  semantics of `m7-overrides` and the stacks of `m7-stacks`;
- adds a small **balance mod** that works with either genre.

Switching genre is then switching mod, as VISION §1 asks.

Decisions already made for this spec:

- The base is **playable on its own** as a quiet sandbox.
- The **vampire keeps its estate map**. It reuses the base's generic
  content and overrides `start`, `clock` and `lighting` to play there.

No engine code changes are expected. If one is needed, it must be
genre-free and covered by tests.

## Acceptance Criteria

### The `town` base game

1. New pack **`packs/town/`**:
   - manifest: `namespace: town`, `kind: game`,
     `depends: [std, std_needs]`, with a description;
   - it holds every **genre-free** piece the zombie pack defines today,
     moved rather than copied:
     - the **city** composite map, all its part maps and Tiled files,
       and its rooms;
     - the tiles `road`, `grass`, `car`, `glass`, `window`,
       `barricaded_window`, `bed`, `stove`, `fridge`, `cupboard`,
       `cabinet`, `dresser`, `crate`;
     - their assets and image files;
     - the mundane items (food, drinks, `bandage`, `alarm_clock`,
       `car_battery` and the other junk) and their assets;
     - the loot tables and distributions;
     - the recipes `cook_beans` and `tear_bandage`;
     - the action `barricade`;
     - the status `stocked`;
     - the systems `sleep`, `bleed`, `collapse` and `crunch`;
     - the `clock` and `lighting`.
   - It has a player archetype **`resident`**, the current `survivor`
     renamed. It has the same tags (`humanoid`, `living`), measurements,
     inventory and sprite.
   - It defines a base **`start`**:
     - `map: city`, `player: resident`;
     - a generic `defeat` (`self.hp <= 0`, "You did not make it.");
     - **no** `victory`;
     - the current `simulation` block.
   - The town's own `populate` entries and part-map `populate` entries
     are **empty**. The base has no NPCs.
2. `npm run play -- town` and `?packs=town` start the resident in the
   empty town. The player can loot, eat, cook, sleep, barricade and
   lose to starvation. No NPC exists and nothing pursues the player.
3. **Genre-free check.** A new test scans every file under `packs/town/`
   and `packs/hardship/` (YAML, Tiled JSON and asset file names). Words
   it rejects, case-insensitive and whole word:
   - the genre namespaces `zmb`, `vamp`, `gdn`;
   - the genre words of the `src/` leak test: `zombie`, `vampire`,
     `undead`, `shambler`, `mansion`, `blood`, `bunny`…;
   - `bat`, `coffin`, `crypt` and `survivor`.

   The stdpack words (`hunger`, `thirst`, …) are allowed in packs.

### Zombie as a mod

4. Running the zombie stack does not lose content:
   - `zombie` keeps its namespace `zmb`;
   - it becomes `kind: mod` with `depends: [std, std_needs, town]` and
     a bumped `version`;
   - it keeps only zombie content: the `shambler` and `crawler`
     archetypes and their assets, the `shambler` behavior, the `alert`
     status, and the zombie flavour text.
5. The zombie mod turns the base into today's zombie game with
   **overrides only**. It does not copy base content:
   - `town:city` `populate` gets today's shambler zones, and the part
     map that today carries the bedroom crawler gets its crawler
     `populate`;
   - `start` gets the zombie `defeat` message and today's `victory`
     (the car battery in the garage);
   - `town:resident` gets the `Survivor` label. Other cosmetic
     overrides are optional.
6. **Equivalence.** On the same seed, `zombie` gives the same world as
   the zombie stack before this spec, up to namespaces:
   - same map size and cells;
   - same player start;
   - same number of entities per archetype local id (`resident` counts
     as `survivor`);
   - same containers with the same contents by item local id.

   A test asserts this against a fixture recorded **before** the move:
   a small JSON of counts and a cell digest committed with the test.
   Hashes may change, because ids and namespaces change. The existing
   zombie scenario and behavior tests are updated to the new ids and
   must pass with the **same** expectations: the same ticks, outcomes
   and counts.

### Vampire as a mod

7. `vampire` keeps its namespace `vamp`. It becomes `kind: mod` with
   `depends: [std, town]`, keeps its maps (`mansion`, `graveyard`,
   `cottage`, `estate`), and:
   - **reuses base content instead of its own copies**: its `window`
     tile is deleted, and the estate and mansion maps use
     `town:window`;
     - any other vamp tile or item that is functionally identical to a
       base one (same walkability, opacity, container and tags; only
       label, colour or art differ) is replaced the same way;
     - `shutter` still turns a (base) window into the vampire's
       `shuttered_window`. The `town:barricade` action targets windows
       too and stays offered in the vampire stack. That is fine and
       intended: the stack really contains it.
   - overrides `start`: `map: estate`, `player: vampire`, the vampire
     `defeat`, and its own `simulation` values if it has any today;
   - overrides `clock` (`start: "20:00"`, plus any other field it sets
     today) and `lighting` (its tint).
   - The base's systems and statuses must not affect the vampire or the
     bats, which do not carry `living`. If one would, fix its filter in
     `town` without genre terms.
8. **Equivalence** for `vampire`, as in AC 6:
   - same estate map, player start and entity counts per archetype;
   - same containers by item local id, except items renamed to base
     items under AC 7 (list them in the test);
   - the same clock and lighting values;
   - the existing vampire scenario tests pass with the same
     expectations after id updates.

### Balance mod

9. New pack **`packs/hardship/`**: `namespace: hardship`, `kind: mod`,
   `depends: [std_needs, town]`. It uses only overrides and removals:
   - it overrides at least two `std_needs` measurement rates (for
     example hunger and thirst drain faster);
   - it overrides at least one `town` loot table (sparser food);
   - it **removes** one `town` entry that nothing else references, for
     example `tear_bandage`.

   It must load **without errors or warnings** in both
   `[zombie, hardship]` and `[vampire, hardship]`.

### Joint validation

10. Tests load these stacks:
   - **`[town]`, `[zombie]`, `[vampire]`, `[garden]`**,
     `[zombie, hardship]` and `[vampire, hardship]` load **without
     warnings**;
   - **`[zombie, vampire]`** loads without errors. It warns only for
     fields that **both** mods override, at least `start.defeat`. The
     test lists those fields exactly. Fields only one mod touches
     (`start.map`, `start.player`, `clock`, `lighting`, `populate`) do
     not warn. The vampire loads later, so its fields win: the world
     starts on the estate with the vampire. The zombie's `victory` is
     inherited. That is expected joint behaviour, and the test asserts
     it.
   - **`[vampire, zombie]`** loads with the mirror-image warnings. It
     starts on the estate with the vampire too, because the zombie mod
     never overrides `start.map`/`player`. The zombie's `defeat` message
     wins. The test asserts this, which documents that load order
     settles only the conflicting fields.

   Each playable stack runs 300 ticks deterministically: same seed,
   same hashes.
11. `npm run check -- <stack> --overrides` on `[zombie]` and `[vampire]`
    lists the overrides from AC 5 and AC 7. These outputs appear,
    abridged, in `docs/packs.md`.

### Shells, docs, cleanup

12. The shells:
    - `scripts/smoke.mjs` combos are `town`, `zombie`, `vampire`,
      `garden` and `zombie,hardship`;
    - the title screen (`m7-stacks`) lists `town` and `garden` under
      games, and `zombie`, `vampire` and `hardship` under mods;
    - CLI examples in `docs/` and `README.md` use these stacks.
13. Saves made with the old stacks no longer load (pack list mismatch).
    That is acceptable. `docs/saves.md` says so in one line.
14. Docs:
    - `docs/packs.md`:
      - the layout example and the map docs point at `packs/town/`;
      - a **Shipped packs** table lists every pack with kind, depends
        and contents, extending the *Standard packs* table;
      - the Mods section shows the zombie and vampire mods as worked
        examples;
    - `packs/*/maps/README.md` and `docs/art.md` follow the moved files;
    - VISION §5 marks **M7 ✅ done**, and §8 *Next step* describes M7's
      result and names M8 (social layer) as next;
    - VISION decision 8's "Genre packs" bullet mentions that genres are
      now mods of a base game.
15. `npm test`, `npm run typecheck` and `npm run build` pass. Every pack
    in the catalog passes `npm run check`, alone or in its
    smallest playable stack.

## Out of Scope

- New gameplay or content beyond moving, renaming and the listed
  overrides. Exception: the `hardship` mod.
- Merging the vampire estate into the town map. The estate stays the
  vampire's map, per the decision above.
- Moving `garden` onto `town`. It stays a game on `std`, as the third
  genre that shares nothing with the town.
- New stdpacks. Patterns that zombie and vampire still repeat after this
  spec (for example both `alert` statuses) are noted in VISION §7 as
  candidates and not moved here.
- Migrating old saves.

## Design Notes

- Do the move in two steps, and commit the equivalence fixture first:
  1. Record the AC 6 and AC 8 fixtures from the **current** packs
     (entity counts per archetype local id, container contents per item
     local id, a cell digest per floor with tile local ids, the player
     start, and clock and lighting values) with a small script, and
     commit them.
  2. Move the content. The equivalence tests then pin the move.
- Local ids should stay the same wherever possible (`town:window` was
  `zmb:window`). Short references inside the moved files then keep
  working, and the fixtures compare by local id.
- Tiled tilesets name pack tiles. After the move, the town's tilesets
  resolve in `town`'s scope. The vampire's Tiled files that use the base
  window need `town:window` or a short `window` that resolves through
  its depends. Check `docs/packs.md#tiled-maps` for how tile properties
  resolve.
- Overriding a part map's `populate` changes it for **every placement**
  of that part. That is how today's crawler works, so it is equivalent.
- Asset image files move with their `assets` entries. With
  `m7-overrides` per-field provenance, a zombie override of an asset
  `file` would load from `packs/zombie/`. The spec does not need one.

## Agent Notes

- Read these first:
  - `docs/packs.md` (the Mods section from `m7-overrides`, stacks from
    `m7-stacks`);
  - `packs/zombie/**`, `packs/vampire/**`;
  - `test/scenario.test.ts`, `test/helpers.ts`, and every test that
    loads `packs/zombie` or `packs/vampire`
    (`grep -rn "packs/zombie\|packs/vampire\|zmb:\|vamp:" test scripts`);
  - `scripts/smoke.mjs`.
- `git mv` files so history follows them.
- After the move, run `npm run check -- <stack> --overrides` for each
  stack and read the output. An unexpected override or a warning usually
  means a file was copied instead of moved.
- Run `npm test`, `npm run typecheck`, `npm run build` and the `check`
  commands from AC 15 before reporting.
