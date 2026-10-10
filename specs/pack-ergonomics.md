---
id: pack-ergonomics
area: load
priority: 40
depends_on: [pack-event-triggers]
description: "Pack ergonomics — load-time shorthands from the YAML pain-points survey: `{ apply: { hunger: -35, thirst: 3 } }` and `{ set: … }` effect entries, a per-file `defaults: { for: … }` for systems and statuses, `{ scale: n }` / `{ add: n }` on numeric override fields so a mod tunes an upstream rate without copying it, a one-level-deeper merge of `start.defeat` / `start.victory` / `start.simulation`, and the `count_tagged` / `has_tagged` / `fraction` built-ins; every shipped pack converted, no simulation or save change"
---

# Pack ergonomics

## Goal

The YAML pain-points survey in `VISION.md` §7 lists verbose forms that
every pack repeats and that no primitive is missing for: two spellings
for changing a measurement (`rates: { hp: -0.2 }` on statuses versus
`{ type: apply, measurement: hp, delta: -0.2 }`, 32 times in effects),
`for: 'self.has_tag("living")'` restated on every rule of a file (10
times for `living`, 7 for `undead`, 5 for `bunny`), overrides that copy
upstream values to change one number (`hardship` restates the whole
`std_needs:thirst` rate expression, which drifts silently if upstream
changes; `zombie` and `vampire` restate `defeat.when` to change only the
message), and expressions that sum `count_item` calls or hard-code a
measurement's maximum (`self.hp < 25` for "a quarter of health").

This spec adds **load-time shorthands only**. Each expands in the loader
to what packs write today, so the simulation, the compiled definition's
shape, snapshots, hashes and saves do not change. The result is packs
that read as the rule they state, and mods that tune instead of copy.

## Acceptance Criteria

### Effect shorthands

1. An entry of any `effects` list may be an **`apply` mapping** or a
   **`set` mapping** instead of a typed effect:

   ```yaml
   effects:
     - { apply: { hunger: -35, thirst: 3 } }
     - { set: { liquor: 100 } }
     - { apply: { hp: "-2 * self.has_status(\"sunburnt\")" }, on: npc }
   ```

   - It expands, in the loader, to one `apply` (or `set`) effect per key,
     in mapping order, with the key as the measurement reference (short
     or qualified, resolved in the entry's scope like `measurement:`
     today) and the value as the `delta` (or `value`): a number or an
     expression, with the same validation and errors as the long form.
   - The only other key allowed next to `apply` or `set` is `on`, with
     the same rule as the long form (`on: npc` in dialogues only); `type`
     next to `apply`/`set`, both `apply` and `set` in one entry, an empty
     mapping, or a non-mapping value are load errors naming the entry.
   - Error locations point at the key inside the mapping
     (`effects[0].apply.hunger`), so a wrong measurement id or a bad
     expression is reported where it is written.
   - The long form stays valid and is documented as the general one.
   - It is accepted everywhere effects are: systems, item uses, actions,
     recipes, quest stages, dialogue nodes and choices.

### Per-file defaults

2. A content file may carry a new top-level key **`defaults`** (added to
   `DOMAIN_KEYS`), a mapping of field defaults for the entries defined in
   **that file**:

   ```yaml
   defaults:
     for: 'self.has_tag("undead")'
   systems:
     - id: daylight            # gets the file's `for`
       every: 1
       when: 'world.is_day and not tile.has_tag("shade")'
       effects: [{ apply: { hp: -0.2 } }]
     - id: everyone            # opts out
       for: "true"
       …
   ```

   - `for` is the only key this spec defines; any other key is a load
     error listing the supported ones.
   - The default applies to every `systems` and `statuses` entry of the
     file that does **not** write `for` itself. An entry that writes
     `for` (even `for: "true"`) keeps its own.
   - It never applies to `override: true` or `remove: true` entries: an
     override changes only what it lists, and a default would silently
     patch `for` on the upstream entry. It also applies to no other
     domain (an `actions` entry has no `for`); a file with `defaults` but
     no `systems` or `statuses` entries warns that the default is unused.
   - The expression is compiled in the writing pack's scope and keeps
     the `self.has_tag("x")` fast path (`forTag`) exactly as if it were
     written on the entry. Errors in it are reported once, at
     `defaults.for`, and the field's provenance (for overrides and
     `check --overrides`) is the file's `defaults` location.
   - `docs/packs.md` (Layout) lists `defaults` with the domain keys and
     says it is per file, not per pack.

### Numeric override terms

3. An **override** (`override: true`, in a list domain or in `start` /
   `clock` / `lighting`) may give a top-level field of type *number* or
   *number or expression* a **term mapping** instead of a value:

   | Form              | Meaning |
   |-------------------|---------|
   | `{ scale: n }`    | The current value multiplied by `n` |
   | `{ add: n }`      | The current value plus `n` |
   | `{ scale: n, add: m }` | `current × n + m` (scale first) |

   `n` and `m` are **numbers** (not expressions). The fields that take a
   term are those the loader already reads as `number` or `number or
   expression` at the top level of an entry: measurement `min`, `max`,
   `initial`, `rate`; system `every`; action and recipe `duration`; var
   `initial`, `min`, `max`; faction `reputation`, `hostile_below`,
   `friendly_from`; clock `day_length`. A term on any other field, on a
   field the upstream entry does not have (nothing to scale), on a
   non-override entry, or with keys other than `scale` and `add`, is a
   load error with the field path.
   - When the current value is a **number**, the result is a number
     (`rate: 0.1` scaled by 2 is `0.2`), folded at load so a constant
     rate stays a free addition per tick.
   - When the current value is an **expression**, the result is the
     expression wrapped in parentheses: `(0.1 + 0.05 * (self.hunger >=
     50) + 0.05 * world.is_day) * 2 + 0`, compiled in the scope of the
     pack that wrote the original expression (its references still
     resolve through that pack's depends), with provenance recorded as
     written by the overriding pack. The `add` part is omitted from the
     text when it is `0`, and the `scale` part when it is `1`.
   - A term is applied to the field's value **after** every earlier
     patch, so two mods that each scale a rate by 2 give ×4, and a mod
     that depends on another sees its result. The usual "unrelated packs
     wrote the same field" warning still applies.
   - `check --overrides` prints the field with its term, e.g.
     `hardship  override  measurement  std_needs:thirst  [rate ×2]`.
   - A measurement whose `max` is a bare measurement id (`max: max_hp`)
     is a reference, not a number: a term on it is an error.

### Deeper merge for `start`

4. In a `start` override, the sub-mappings **`defeat`**, **`victory`**
   and **`simulation`** merge **per field** (one level deeper than
   `m7-overrides`): a listed key replaces that key, omitted keys are
   kept, `key: null` clears one, and `defeat: null` still removes the
   whole condition.

   ```yaml
   start:
     override: true
     defeat: { message: "You did not survive the outbreak." }   # keeps town's `when`
   ```

   - A sub-mapping with no upstream value (the base `start` has no
     `victory` and the mod writes `victory: { message: … }` alone) is
     validated as a fresh definition, so the missing `when` is an error
     at the override.
   - Provenance and `check --overrides` work per sub-field (`[defeat.message]`).
   - `lighting.tint` and every other nested value keep the whole
     replacement rule.

### Expression built-ins

5. Three new built-ins, with the usual load-time resolution of string
   literals and method forms (`self.count_tagged("food")`):

   | Built-in | Value |
   |----------|-------|
   | `count_tagged(entity, "tag")` | Units of every item carrying that item tag in the entity's inventory (`0` without one) |
   | `has_tagged(entity, "tag")` | `count_tagged(entity, "tag") > 0` |
   | `fraction(entity, "measurement")` | `(value − min) / (max − min)` of the entity's measurement, in `[0, 1]` |

   - An item tag that no loaded item carries is a load **warning** (as
     for tile-filter tags), with the usual *did you mean*. The runtime
     is one scan of one inventory with a precomputed per-item flag.
   - `fraction` on a measurement with **no `max`** is a load error ("no
     maximum to take a fraction of"). With a per-entity `max`
     (expression or measurement id) it is evaluated at call time; when
     the resolved max is not finite or not above `min`, or the entity
     lacks the measurement, the value is `0`.
   - They work in every expression scope, including `for` fast paths
     (they do not qualify for `forTag`).

### Packs

6. Every shipped pack (`std`, `std-needs`, `town`, `garden`, `hardship`,
   `zombie`, `vampire`, `noir`, `western`) is converted so that:
   - every `apply`/`set` effect on a measurement uses the mapping
     shorthand (keep the long form only where `on: npc` plus a second
     effect type makes it clearer, if anywhere);
   - a file whose `systems` and `statuses` all share a `for` moves it to
     `defaults` (`packs/vampire/survival.yaml`, `packs/zombie/undead.yaml`,
     the bunny rules in `packs/garden/rules.yaml`, the stranger rules in
     `packs/western/duel.yaml`, the `living` rules in
     `packs/town/survival.yaml` and `packs/std-needs/statuses.yaml`);
     files with mixed `for`s keep them on the entries;
   - `hardship` writes `rate: { scale: 2 }` for `std_needs:hunger` and
     `std_needs:thirst` instead of restating the values;
   - `zombie` and `vampire` override only `defeat.message`;
   - `town:stocked` uses `self.count_tagged("food") +
     self.count_tagged("drink") >= 4` (the town's items already carry
     `food` and `drink`);
   - `vampire`'s `scorched` stage uses `fraction(self, "hp") < 0.25`
     and its comment no longer names the maximum.
7. **Equivalence.** For each shipped stack, the definition loaded after
   the conversion is the same as before it, field by field, except for
   provenance locations: a test loads every stack at the parent commit's
   pack data (kept as fixtures under `test/fixtures/`, or regenerated by
   a script) and at the converted data and compares the compiled
   definitions' serialisable shape and, for the town, garden, zombie,
   vampire, noir and western scenarios, the world `hash()` after a
   fixed run. Simpler: the existing determinism and scenario tests pin
   their hashes, and those hashes do not change.

### Tests and docs

8. Headless tests cover:
   - **Effect shorthand:** expansion order, `on: npc`, every error in
     AC 1 with its location, mixed long and short entries in one list.
   - **Defaults:** applied to systems and statuses, not to overrides or
     removals, `for: "true"` opts out, the `forTag` fast path survives,
     unused-default warning, unknown key error, provenance in
     `def.patches` when a mod's file uses `defaults` on its own entries.
   - **Terms:** numbers and expressions, scope of the wrapped
     expression (a reference the mod cannot see still resolves),
     stacking across two mods, every error in AC 3, the
     `check --overrides` line.
   - **Deeper merge:** `defeat.message` alone, `victory` with a missing
     `when`, `defeat: null`, per-sub-field warnings between unrelated
     mods.
   - **Built-ins:** `count_tagged`/`has_tagged` with stacks of several
     tagged items and no inventory; `fraction` with a numeric max, a
     measurement-id max, an expression max that evaluates to Infinity;
     the load error without `max`; unknown tag warning.
   - **Equivalence** (AC 7) and the genre-word guard.
9. **Docs.**
   - `docs/packs.md` documents the shorthand under systems (effects), the
     `defaults` key under Layout, terms and the deeper merge under Mods
     and overrides (with the `check --overrides` format), and updates the
     examples (`crunch`, `drink`, `collapse`, the hardmode example).
   - `docs/expressions.md` documents the three built-ins.
   - `VISION.md` §7 strikes the matching bullets of the pain-points
     survey (two spellings, `for` repeated, overrides force copying, no
     count by item tag, no fraction-of-max) and records the decisions:
     shorthands expand at load and change no definition shape; defaults
     are per file and never touch overrides; numeric terms wrap
     expressions textually in the original scope; `start` sub-mappings
     merge one level deeper, a deliberate narrow revisit of
     `m7-overrides`.

## Out of Scope

- **Pack parameters** (`param("x")` read by expressions and set by mods):
  `scale`/`add` cover the survey's cases; parameters are a later spec if
  a third mod needs a value that is not a scale of an upstream one.
- Terms on nested values (loot `entries[].weight`, status `rates`,
  effect `delta`), list operators (append, remove-one) and any other
  deep merge; `hardship` keeps restating `kitchen_food`.
- A pack-wide `defaults` (in `pack.yaml`) and defaults for other fields
  (`every`, `hud`, `category`).
- A `sprite` default from the entry's id (an asset rename across nine
  packs and the art pipeline) and a `max_of`/`min_of` built-in.
- Density-based `populate`, derived "roofed" exposure, and anything that
  changes the simulation.

## Design Notes

- **Shorthand expansion** belongs in the `effects` parser in
  `src/core/load/load.ts`: detect `apply`/`set` keys before the `type`
  check and push the expanded `MeasurementEffectDef`s; the `Fields`
  helper in `src/core/load/validate.ts` gives key-level sources.
- **Defaults** are resolved before patching: the raw-pack reader in
  `src/core/load/pack.ts` sees the file's `defaults` and attaches the
  `for` value, with its source, to each eligible raw entry that lacks
  one, so the rest of the loader is unchanged. Keep the per-file scope
  there (a file's defaults never leak to another file of the pack).
- **Terms** are applied in `src/core/load/patch.ts` (`merge`), where the
  current raw value and its provenance are known: for a number, replace
  the raw value; for a string expression, replace it with the wrapped
  text and keep the original field's scope while recording the new
  pack as the writer. The validator needs the list of term-capable
  fields per domain; keep it next to the field lists the parsers
  already use so the two cannot drift (a test can assert every listed
  field is read as a number term by its parser).
- **Deeper merge** is a small special case in the singleton merge for
  `start`: merge `defeat`, `victory` and `simulation` per key instead of
  replacing the mapping.
- **Built-ins** follow `itemCount` in `src/core/expr/compile.ts`; item
  tags are resolved to a per-item `Uint8Array` flag at load, like tile
  filters. `fraction` reads `maxOf`-style evaluation of the measurement's
  `max`; keep it allocation-free.

## Agent Notes

- Read first: `docs/packs.md` (Layout, systems, measurements, Mods and
  overrides, Validation), `docs/expressions.md`, `src/core/load/pack.ts`,
  `src/core/load/patch.ts`, `src/core/load/load.ts` (`effects`,
  `numberTerm`, the system/status/measurement parsers),
  `src/core/expr/compile.ts` (`itemCount`, `has_tag`), `src/cli/overrides.ts`,
  `test/overrides.test.ts`, `test/loader.test.ts`, `test/expr.test.ts`.
- This spec lands after `pack-event-triggers`: convert the `on: step`
  and `once` systems like any other (they take `defaults.for` and the
  `apply` shorthand).
- Suggested order: effect shorthand; built-ins; defaults; terms; deeper
  merge; pack conversion with the hash-pinned tests as the safety net;
  docs and VISION.
- Keep the conversions mechanical and one pack per commit, so a hash
  change points at one file.
