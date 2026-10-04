---
id: m5-recipes
area: sim
priority: 40
depends_on: [m5-context-menu]
description: M5 crafting — a pack-defined `recipes` domain (consume/tools/produce, optional station tile filter, duration, interrupt, extra effects) run as a third timed-activity source, overflow to the ground, an `availableRecipes` query, station entries in the context menu, a crafting panel and ASCII list, and cooking/bandage/blood recipes in both genre packs
---

# M5c — Recipes

## Goal

Crafting completes M5 ("bandaging, cooking, barricading"). A **recipe**
turns items into other items:

- it consumes some items and needs tools in the inventory;
- it may need a **station**, a nearby tile such as a stove or a blood
  font;
- it takes time.

Recipes run on the same activity machinery as `m5-timed-actions`, so
they get the same progress bar, cancellation, `interrupt` and
completion-only rules, and they appear in the `m5-context-menu` menu
when you right-click a station.

Playable result:

- In `zombie`, the player loots canned beans, right-clicks a stove and
  picks *Cook: Hot beans*. They also tear rags into a bandage anywhere.
- In `vampire`, the player fills an empty vial at the blood font and
  mixes blood wine. That second recipe needs no station.

No engine code may be genre-specific.

## Acceptance Criteria

### Pack schema: `recipes` domain

1. **`recipes`** is a new domain: a list with its own id space.

   | Field       | Type                         | Default        | Notes |
   |-------------|------------------------------|----------------|-------|
   | `id`        | id                           | required       | |
   | `label`     | string                       | required       | Name of the result, e.g. `Hot beans` |
   | `verb`      | string                       | `Craft`        | Shown as `<verb>: <label>` in menus, e.g. `Cook: Hot beans` |
   | `category`  | string                       | `General`      | Grouping in the crafting panel |
   | `consume`   | map item id → integer ≥ 1    | required       | Non-empty |
   | `tools`     | list of item ids             | `[]`           | Held, never consumed |
   | `produce`   | map item id → integer ≥ 1    | required       | Non-empty |
   | `station`   | tile filter `{ tiles?, tags? }` | none        | Same shape and validation as `m5-timed-actions` AC 2 |
   | `when`      | expression                   | `true`         | Checked at start and at completion |
   | `unavailable` | string                     | none           | Hint when `when` is falsy (as for actions) |
   | `duration`  | number or expression (sim seconds) | `0`      | Same rules as actions |
   | `interrupt` | expression                   | none           | Same rules as actions |
   | `effects`   | list (`apply`/`set`/`noise`) | `[]`           | Extra completion effects on the crafter. `set_tile` is a load error here |
   | `progress`  | string                       | `<verb>: <label>` | Text shown while in progress |

   - An item id that appears in both `consume` and `tools` is a load
     error.
   - Unknown item or tile ids are load errors with *did you mean*
     suggestions.
   - A station tag that no tile carries is a warning, as for actions.
2. **Bindings.** In `when`, `interrupt`, `duration` and `effects`:
   - `self` is the crafter;
   - `tile` is the **station cell** for station recipes, and the cell
     under the crafter otherwise. This uses the same rebinding as tile
     actions.

### Simulation

3. **Starting.** A new action kind is queued with
   `world.queueAction({ kind: 'craft', recipe, x?, y? })`.
   - For station recipes, `x`/`y` name the station cell. If they are
     omitted, the engine picks the **first matching cell in reach in
     row-major order**, which is deterministic.
   - For recipes without a station, `x`/`y` are forbidden.
   - Start checks follow the `m5-timed-actions` order, with `recipe` in
     place of `action`:
     1. `unknown_recipe` (new reason);
     2. `no_inventory`;
     3. `out_of_reach`/`invalid_target`, for the station;
     4. `missing`;
     5. `cannot_act`.
4. **Activity.** A recipe is a third activity source (`kind: 'craft'`)
   in the shared lifecycle module. Starting, cancellation (by movement or
   a new action), `interrupt`, completion re-checks, completion-only
   effects and snapshot/hash behave **exactly** as for pack actions. A
   duration of 0 completes instantly.
5. **Completion.** After the re-checks, in this order:
   1. remove the `consume` items;
   2. add each `produce` entry to the crafter's inventory, in the order
      written, as many units as fit;
   3. put any **overflow** on the ground pile at the crafter's cell,
      creating the pile if needed;
   4. run `effects`.

   Consumed items are removed **before** produced items are added, so a
   recipe that lightens the load cannot fail for lack of room. The
   `ActionRecord` has `kind: 'craft'`, a `recipe` field and
   `moved` = total units produced. `actionText` reads, e.g., `You make
   1× Hot beans.`, adding ` (some dropped on the ground)` on overflow.
   `containerVersion` increments.
6. **Queries.**
   - `world.availableRecipes()` lists **every** recipe, in definition
     order, for the crafting panel. Each entry is `{ recipe, label,
     verb, category, ok, reason?, missing?, station?: { x, y } }`.
     `station` is the chosen in-reach cell. A station recipe with no
     matching cell in reach has `ok: false, reason: 'out_of_reach'`.
   - `world.interactionsAt(x, y)` (from `m5-context-menu`) gains, after
     tile actions and before containers, one entry per recipe whose
     station matches the cell, with label `<verb>: <label>`.
   - Recipes without a station are not listed per cell; they live in the
     crafting panel.
   - `world.approachIntent` supports `craft` with a station cell.
   - Both queries stay pure: no RNG and no `hash()` change.

### Shells

7. **Browser crafting panel.**
   - The `C` key and a HUD button toggle a "Crafting" panel. It lists
     every recipe, grouped by `category`. Each row shows:
     - the label;
     - the inputs (`2× Rag`);
     - the tools;
     - the station (`at Stove`, from the first matching tile's label);
     - a **Craft** button, disabled with the `reasonText` hint when not
       `ok`.
   - Clicking Craft queues the action. A station recipe whose station is
     out of reach is still disabled in the panel (`Go to a Stove`); the
     context menu handles walk-then-craft.
   - The view is a pure function of `availableRecipes()`, in
     `panels.ts` style, and re-renders when `tick`, `containerVersion`
     or `tileVersion` changes.
8. **Context menu.** The station entries from AC 6 appear in the
   right-click menu with the same in-reach and approach behaviour as
   tile actions.
9. **ASCII.** `c` opens a numbered list of `ok` recipes (the first nine),
   in definition order; `1`–`9` craft. When there are none, the list
   shows `Nothing to craft`, followed by up to three not-`ok` recipes
   with their hint, to aid discovery.

### Packs (two-genre rule)

10. **zombie:**
    - New tile `stove` (walkable: false, tags `[heat]`), placed in the
      town kitchens.
    - New items:
      - `hot_beans`: food, with a stronger hunger relief than
        `canned_beans` and a small `fatigue` relief;
      - `rag`.
    - `rag` is added to existing loot tables (dressers and cabinets).
    - Recipes:
      - `cook_beans`: verb `Cook`, category `Cooking`, station
        `{ tags: [heat] }`, consume `{ canned_beans: 1 }`, produce
        `{ hot_beans: 1 }`, `duration: 5`, and a `noise` effect of a
        small radius (a sizzle);
      - `tear_bandage`: verb `Make`, category `Medical`, consume
        `{ rag: 2 }`, produce `{ bandage: 1 }`, `duration: 3`, no
        station.
11. **vampire:**
    - New items:
      - `empty_vial`, added to loot;
      - `blood_wine`: drinkable, restores `blood` and a little `hp`.
    - Recipes:
      - `fill_vial`: verb `Fill`, station `{ tags: [blood] }` (the
        existing font), consume `{ empty_vial: 1 }`, produce
        `{ blood_vial: 1 }`, `duration: 2`;
      - `mix_blood_wine`: verb `Mix`, consume `{ wine: 1, blood_vial: 1 }`,
        produce `{ blood_wine: 1 }`, `duration: 2`, no station.
    - `blood_vial`'s `use` keeps `consume: 1`. Returning an empty vial on
      drinking stays out of scope.

### Tests and docs

12. Headless tests cover:
    - **Loader:** every load error and warning in AC 1.
    - **Station selection:** given `x`/`y`, auto-pick in row-major
      order, and out of reach.
    - **Timing and lifecycle:** instant and timed completion,
      cancellation, interrupt, and the completion re-check when an
      ingredient is dropped mid-way.
    - **Completion:** consume-before-produce ordering, overflow to a new
      or existing ground pile, `moved`, and the `actionText` strings.
    - **Queries:** `availableRecipes()` and the recipe entries in
      `interactionsAt`, which stay pure.
    - **UI models:** the crafting panel view model and the
      context-menu items.
    - **Scenarios:** a zombie scenario loots beans, walks to the stove
      via the menu, cooks and eats them. A vampire scenario fills a vial
      at the font and mixes blood wine.
    - **Guards:** the determinism tests and the genre-word guard still
      pass.
13. **Docs.**
    - `docs/packs.md` documents `recipes`, the `craft` action kind,
      `unknown_recipe`, and the completion order and overflow.
    - `VISION.md`:
      - §5 marks **M5 done**;
      - §7 records the decisions: recipes are a separate domain on the
        shared activity lifecycle, stations are tile filters, all
        recipes are known, and overflow goes to the ground;
      - §8, if present, points toward M6.

## Out of Scope

- Learning or unlocking recipes, skills, XP and success chances.
- Craft-N or "craft all" batches, and queues.
- Item quality, durability, spoilage, and tools wearing out.
- Fuel and stations that must be "on" (stove power). Packs can gate them
  with `when`.
- Station containers as ingredient sources (crafting only from the
  inventory), and pulling from nearby containers.
- Producing tiles or entities. Use pack actions with `set_tile` for
  building.
- Pack overrides of recipes (M7).

## Design Notes

- Add the recipe as a third `ActivitySource` implementation. If adding it
  requires changing the lifecycle code beyond registering the source,
  that is a sign the `m5-timed-actions` abstraction leaked. Fix the
  abstraction rather than special-casing `craft`.
- Compile `consume`/`tools`/`produce` to item-index arrays at load, as
  for actions. Reuse the `missing` computation.
- For overflow, reuse the ground-pile creation path from `drop` instead
  of duplicating it.
- The stove placement must keep the kitchens walkable and keep every
  existing container reachable. Run the existing reachability and
  scenario tests after editing `town`.

## Agent Notes

- Read these first:
  - `specs/m5-timed-actions.md`, `specs/m5-context-menu.md` and their
    implementations (the activity module, `interactionsAt` and
    `src/web/menu.ts`);
  - `docs/packs.md` (items, loot);
  - `packs/zombie/loot.yaml` and `packs/vampire/content.yaml`.
- Suggested order:
  1. defs and loader;
  2. the activity source;
  3. completion and overflow;
  4. the queries;
  5. the context-menu integration;
  6. the crafting panel and ASCII;
  7. packs and scenarios;
  8. docs and VISION.
- Chromium is unavailable in the sandbox. Keep the panel logic in pure
  functions.
