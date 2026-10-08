---
id: m8-flags-quests
area: sim
priority: 40
depends_on: []
description: M8 groundwork — world-level `vars` (declared numbers, `var()` in expressions, `set_var`/`add_var` effects), a `quests` domain of ordered stages entered by `when` or by a `quest` effect with success/failure ends, a `journal` domain of one-time entries (`journal` effect, `in_journal()`), a quest phase in the tick, save version 4, a browser journal panel (`J`) with update toasts and a terminal journal, and small quests in zombie and vampire
---

# M8a — World variables, quests and journal

## Goal

The social layer of M8 (dialogues, factions, a noir mystery, a western
duel) needs the world to **remember story facts**. Today all state lives
on entities (measurements, statuses, inventories), and the only goals are
a single `start.victory` or `start.defeat` expression.

This spec adds three declarative primitives:

- **`vars`**: named world-level numbers, such as `bartender_paid` or
  `clues_found`;
- **`quests`**: ordered stages the player moves through, either on their
  own (`when`) or by effects, ending in success or failure;
- **`journal`**: one-time entries that the player collects, such as clues,
  rumours and notes.

The browser and the terminal get a journal view. Later M8 specs build on
these: dialogue choices set vars and advance quests, and the noir game's
clues are journal entries.

Playable result: in `zombie`, the journal shows *Get out of town: The
wrecks on the road might run with a fresh battery*, which updates once a
battery is in hand and completes on escape. In `vampire`, a quest tracks
surviving the first dawn. No engine code may be genre-specific.

## Acceptance Criteria

### Pack schema

1. **`vars`** is a new domain: a list with its own id space.

   | Field     | Type    | Default    | Notes |
   |-----------|---------|------------|-------|
   | `id`      | id      | required   | |
   | `label`   | string  | the id     | For tools and debugging only; never shown to players |
   | `initial` | number or boolean | `0` | `true`/`false` are stored as `1`/`0` |
   | `min`     | number  | `-Infinity`| |
   | `max`     | number  | `Infinity` | `min <= initial <= max`, or a load error |

   Vars are **world-level**: one value per world, not per entity. Values
   are clamped to `[min, max]` whenever they are written.
2. **`journal`** is a new domain: a list with its own id space.

   | Field      | Type   | Default  | Notes |
   |------------|--------|----------|-------|
   | `id`       | id     | required | |
   | `text`     | string | required | Non-empty |
   | `category` | string | `Notes`  | Grouping in the journal view, e.g. `Clues` |

3. **`quests`** is a new domain: a list with its own id space.

   | Field    | Type   | Default  | Notes |
   |----------|--------|----------|-------|
   | `id`     | id     | required | |
   | `title`  | string | required | |
   | `stages` | list   | required | Non-empty, ordered |
   | `hidden` | boolean | `false` | A hidden quest is not shown in the journal view until it ends |

   A **stage**:

   | Field     | Type       | Default  | Notes |
   |-----------|------------|----------|-------|
   | `id`      | name       | required | `[a-z][a-z0-9_]*`, unique within the quest |
   | `journal` | string     | required | What the journal shows while the quest is at this stage |
   | `when`    | expression | none     | Enters the stage automatically (AC 7) |
   | `end`     | `success` or `failure` | none | Entering this stage ends the quest |
   | `effects` | list       | `[]`     | Run once on entering, with `self` = the player |

   Unknown fields and duplicate stage ids are load errors. A quest that
   can never start is also a load error: none of its stages has a `when`,
   and no `quest` effect in any loaded pack names it.

   Several `end` stages may follow one another (`solved`, then
   `wrong_man`); the quest phase's "last truthy stage" rule (AC 7) picks
   between them. Stage order is therefore also priority order.
4. **Expressions.** New built-ins. Every id argument is a **string
   literal**, short or qualified, resolved at load time like
   `has_status`: an unknown id is a load error with a *did you mean*
   suggestion, and the runtime check is an array read.

   | Built-in | Value |
   |----------|-------|
   | `var("id")` | The var's current value (a number) |
   | `in_journal("id")` | Whether the entry has been added |
   | `quest_active("q")` | Started and not ended |
   | `quest_reached("q", "stage")` | The quest's current stage index is that stage's index or higher (ended quests keep their final stage). It is positional, so test endings with `quest_succeeded`/`quest_failed` |
   | `quest_succeeded("q")` / `quest_failed("q")` | The quest ended in a stage with `end: success` / `end: failure` |

   They work in every expression: systems, statuses, behaviors, actions,
   recipes, item uses, `start.defeat` and `start.victory`.
5. **Effects.** New effect types, valid in **every** effect list
   (systems, item uses, actions, recipes, quest stages):

   | Effect | Meaning |
   |--------|---------|
   | `{ type: set_var, var: <id>, value: <number or expression> }` | Write the var (clamped) |
   | `{ type: add_var, var: <id>, delta: <number or expression> }` | Add to the var (clamped) |
   | `{ type: quest, quest: <id>, stage: <stage id> }` | Move the quest to that stage (AC 8) |
   | `{ type: journal, entry: <id> }` | Add the journal entry; a no-op if it is already there |

   - Expressions are evaluated in the effect's usual scope. For example,
     a system's effect runs once per matching entity, so an `add_var` in
     a system that matches 10 entities adds 10 times. Document this.
   - Unknown ids, and a `stage` that is not a stage of that quest, are
     load errors.

### Simulation

6. **State.** The world holds:
   - every var's value (a `Float64Array` indexed by var);
   - per quest: the current stage index (`-1` = not started), the tick it
     entered that stage, and whether it ended;
   - the journal, as the list of added entries in the order added, each
     with the tick it was added.

   All of this is part of `snapshot()` and `hash()`. `world.journalVersion`
   increments on every quest stage change and journal addition, so shells
   can re-render cheaply.
7. **Quest phase.** A new phase runs after statuses and before the
   defeat/victory check, so `victory` can test `quest_succeeded` on the
   same tick:
   - quests are visited in definition order;
   - for each quest that has not ended, find the **last** stage after
     the current one whose `when` is truthy, evaluated with `self` = the
     player. Entering it skips any stages in between;
   - at most one stage change per quest per tick;
   - entering a stage runs its `effects` in order. Those effects may
     change vars, add journal entries or move other quests, so a later
     quest in the same phase sees the change. A quest moved by an effect
     still gets at most one change in the phase.

   A stage's `when` is never evaluated once the quest has passed it or
   ended, so the cost is at most one expression per not-yet-reached
   stage per tick. Stages without `when` cost nothing.
8. **The `quest` effect** moves a quest forward only:
   - a stage before or equal to the current one, or any stage of an
     ended quest, is a **no-op**;
   - otherwise it enters the stage at once, running its effects, as in
     AC 7.

   Entering stages through effects nested more than 8 deep (stage effects
   that move quests whose stage effects move quests…) stops with a
   runtime error naming the chain. This is a guard against pack mistakes,
   not a feature.
9. **Records.** Each stage change and journal addition appends a record
   to `world.journalEvents`: `{ tick, kind: 'stage' | 'entry', quest?,
   stage?, entry? }`, holding only the events of the last tick. Shells
   use it for toasts. It is not saved or hashed.
10. **Queries.** `world.journal()` returns a pure, ordered view model:
    - `quests`: the started quests that are not `hidden`, plus the ended
      hidden ones. Each item is `{ quest, title, stage, text, state:
      'active' | 'success' | 'failure', since }`, ordered active first,
      then by the tick of their last change, newest first;
    - `entries`: the added entries, `{ entry, text, category, tick }`, in
      the order added.

    It draws no RNG and does not change `hash()`.

### Saves

11. `SAVE_VERSION` becomes **4**:
    - the snapshot gains `vars` (`{ qualified id: value }`), `quests`
      (`[{ quest, stage, since, ended }]` for started quests, by qualified
      id and stage id) and `journal` (`[{ entry, tick }]`);
    - **version 3 saves still load**: every var takes its `initial`, no
      quest is started and the journal is empty. Then the first tick's
      quest phase runs as usual;
    - unknown var, quest, stage or entry ids in a save are restore errors
      with JSON paths and *did you mean*, like other ids. A var that the
      packs define but the save lacks takes its `initial` with a
      **warning**, like an added measurement;
    - `assertRoundTrip` covers a world with set vars, quests at several
      stages (one ended) and journal entries.

### Overrides

12. `vars`, `quests` and `journal` take `override: true` and `remove: true`
    like the other list domains (`m7-overrides`):
    - a quest's `stages` is one field, so an override replaces the whole
      list;
    - removing an entry that is still referenced is a load error naming
      the remover;
    - `check --overrides` lists these patches too.

### Shells

13. **Browser journal.**
    - `J` and a HUD button toggle a **Journal** panel. It shows:
      - *Active* quests: the title and the current stage's text;
      - *Done*: ended quests, marked ✓ (success) or ✗ (failure), with
        their last stage's text;
      - one section per entry `category`, in order of first use, listing
        that category's entries in the order added.
    - The panel is a pure function of `world.journal()`, in `panels.ts`
      style, and re-renders when `journalVersion` changes.
    - **Toasts:** when `journalEvents` is non-empty after a step, the HUD
      shows, for about 4 s, `Journal: <quest title>: <stage text>` or
      `Journal: <entry text>`. The text is cut to one line with `…`, and
      several events in one tick show the last one plus `(+N)`. Toasts
      are also a pure model (`journalToast(events, world)`).
    - The panel is read-only after defeat or victory, like the others.
    - `docs/ui.md` lists the key.
14. **Terminal.**
    - `J` (uppercase; lowercase `j` still moves) shows the journal as text
      in the same layout, until any key.
    - A stage change or journal addition puts `Journal: …` on the
      message line, with the same text as the toast.

### Packs (two-genre rule)

15. **zombie:**
    - Quest `escape` (*Get out of town*):
      - a stage entered at once (`when: "true"`) with the battery hint;
      - a stage entered when the player holds a `car_battery`;
      - an `end: success` stage with the same condition as today's
        victory.
    - `start.victory` becomes `quest_succeeded("escape")`, with the same
      message.
    - A journal entry (category `Notes`) is added the first time the
      player is `burdened` or `hungry`, via a system with a `journal`
      effect: a one-line survival tip.
16. **vampire:**
    - Quest `first_dawn` (*The first dawn*): started at once, it ends in
      **success** when the vampire is in the crypt and resting (or
      sheltered from the sun, using whatever condition the pack's
      sunburn system already exempts) as day 2 dawns. It ends in
      **failure** if the player's `hp` falls below a quarter of its
      maximum during daylight.
    - It adds no victory: the vampire game stays open-ended.
    - Read `packs/vampire/` and keep the existing ids; adapt the
      conditions to them.
17. Mixed stacks (`m7-town-base`) still load. The town itself defines no
    quests.

### Tests and docs

18. Headless tests cover:
    - **Loader:** every load error in AC 1–5 and 12.
    - **Var clamping**, and the per-entity semantics of `add_var` in
      systems.
    - **Quest phase:** skipping to the last truthy stage, one change per
      quest per tick, effects seen by later quests in the same phase,
      `end` freezing a quest, forward-only `quest` effects, the depth
      guard, and victory on the tick a quest succeeds.
    - **Journal:** idempotent entries, order, `in_journal`, and the
      `journal()` model (ordering, hidden quests).
    - **Saves:** the version 4 round trip, version 3 upgrade, restore
      errors and warnings.
    - **UI models:** the panel view and the toast text.
    - **Scenarios:** the zombie escape quest from start to success, and
      the vampire quest succeeding and, in a second run, failing.
    - **Guards:** determinism tests and the genre-word guard.
19. **Docs.**
    - `docs/packs.md` documents `vars`, `journal`, `quests`, the new
      effects and the quest phase in the tick order.
    - `docs/expressions.md` documents the new built-ins.
    - `docs/saves.md` documents version 4.
    - `VISION.md` §7 records the decisions:
      - vars are world-level declared numbers;
      - quests are ordered stages that only move forward, entered by
        `when` or effects;
      - journal entries are one-time domain entries, not free text.

## Out of Scope

- Dialogues (`m8-dialogues`), factions and reputation (`m8-factions`),
  and the noir and western games (`m8-social-games`).
- String-valued vars, per-entity vars (use measurements), and arrays or
  maps of vars.
- Quest branching into parallel objectives, optional objectives,
  markers on the map or compass arrows, and timers shown in the UI.
- Removing journal entries, or moving quests backward.
- Text templating (`{player}`, var values inside text).
- Quest rewards as a special field: use stage `effects`.

## Design Notes

- Compile var, quest, stage and entry references to indices at load, as
  `has_status` does. `quest_reached` compiles to `stageIndex[q] >= k`,
  with ended quests keeping their final stage index.
- The quest phase must cost almost nothing for packs without quests. It
  should be one loop over not-yet-ended quests, with a precomputed list
  of the stages that have a `when`.
- `set_var` and `add_var` touch no entity, so they ignore `self` except
  inside their expressions. The existing effect runner is keyed on the
  entity; add the new types without making entity effects slower (for
  example, one switch arm each).
- Keep `journalEvents` out of the snapshot. The shells only read it right
  after `step()`.

## Agent Notes

- Read these first:
  - `docs/packs.md` (systems, statuses, effects, tick order, `start`);
  - `docs/saves.md`, `src/core/sim/save.ts` (version handling, restore
    errors);
  - `src/core/expr/compile.ts` (string-literal built-ins such as
    `has_status` and `doing`);
  - `src/core/load/patch.ts` (overrides);
  - `src/web/panels.ts` and the crafting panel (panel style).
- Suggested order:
  1. defs and loader (`vars`, `journal`, `quests`);
  2. the expression built-ins;
  3. the effects;
  4. world state and the quest phase;
  5. saves (version 4, upgrade from version 3);
  6. overrides;
  7. the journal query and shells;
  8. packs and scenarios;
  9. docs and VISION.
- Chromium is unavailable in the sandbox. Keep the panel and toast logic
  in pure functions.
