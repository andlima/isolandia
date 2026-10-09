---
id: m7-overrides
area: load
priority: 40
depends_on: []
description: "M7 mod semantics — a pack can patch (`override: true`, shallow per-field) or remove (`remove: true`) any list-domain entry of a pack it depends on by qualified id, and patch the singleton `start`/`clock`/`lighting`; each field keeps the scope and source of the pack that wrote it, indices stay dense, references to removed entries are load errors, overrides of the same field by unrelated packs warn (later wins), and `check --overrides` lists what every pack changed"
---

# M7a — Overrides and removals

## Goal

Today a pack can only **add** content. Redefining an existing id is an
error, and `clock`, `lighting` and `start` may each be defined only
once. M7 turns packs into **mods**: a pack stacked on top of others can
**tune** what they define, or **remove** it, without copying it.

This spec covers only the loader semantics (VISION §7, "override
semantics between packs"). The decision is **patch by qualified id**:
the mod restates the id and only the fields it changes. There is no
generic patch language. Later specs build on it: `m7-stacks` resolves
load order and adds a picker, and `m7-town-base` restructures the genre
packs as mods.

No engine code may be genre-specific. The loader stays in `src/core/`
with no Node, DOM or Pixi imports.

## Acceptance Criteria

### Overriding list-domain entries

1. Any entry of a **list domain** (`measurements`, `assets`, `tiles`,
   `archetypes`, `maps`, `systems`, `statuses`, `items`, `loot`,
   `behaviors`, `actions`, `recipes`) may carry **`override: true`**:

   ```yaml
   # packs/hardmode/tweaks.yaml   (pack.yaml: depends: [std_needs, zmb])
   measurements:
     - id: std_needs:hunger
       override: true
       rate: 0.2              # only this field changes
   archetypes:
     - id: zmb:shambler
       override: true
       tags: [undead, fast]   # lists are replaced wholesale
       sprite: null           # null clears an optional field (back to its default)
   ```

   - The `id` must be **qualified**. Its namespace must be one of the
     pack's **direct `depends`**, which is the same visibility rule as
     qualified references. A short id, the pack's own namespace, or a
     namespace the pack does not depend on is a load error. The message
     says which `depends` to add, or that the pack should edit its own
     entry directly.
   - The target must exist in that domain. An unknown id is an error,
     with a *did you mean* suggestion.
   - **Shallow merge:** every top-level field the override lists
     replaces the field of the current definition. Fields it omits are
     kept. A nested value is replaced whole: a mapping (`inventory`,
     `use`, `directions`, `target`…) or a list (`tags`, `parts`,
     `populate`, `effects`, `rows`…). `override` itself is never copied.
   - **`field: null`** removes the field. The entry then behaves as if
     the field had never been written: the default applies for an
     optional field, and a required field reports *missing* at the
     override's location.
   - `override: false` is the same as omitting the key. Any other value
     is an error.
   - An override that lists only `id` and `override` is allowed and
     produces a warning ("changes nothing").
   - The merged entry is validated exactly like a fresh definition:
     unknown fields, types, references and expressions. Mixing
     composite and ASCII map fields after a merge is still an error.
2. **Provenance per field.** Each field of a merged entry remembers the
   pack that **last wrote** it.
   - **References** in that field, short or qualified, resolve in that
     pack's **scope**. This includes measurements, tiles, items,
     archetypes, maps, loot tables, actions, behaviors, statuses, room
     tags and every name inside **expressions**. Example: an original
     `zmb:survivor` that lists `hunger` keeps resolving it through
     `zmb`'s depends, even when the overriding pack does not depend on
     `std_needs`.
   - **Relative file paths** resolve against the writing pack's files.
     This covers asset `file`/`directions` and map `tiled`. `AssetDef.pack`
     is the pack that wrote the image field(s), so the browser loads the
     image from that pack.
   - **Errors and warnings** name the writing pack, file, line and key
     path, the same as for unmerged entries.
3. Entries keep the **position** of their original definition. Overrides
   never reorder systems, statuses, behaviors or anything else, and
   iteration-order-dependent behavior (system order, RNG order) stays as
   it was without the override.

### Removing list-domain entries

4. **`remove: true`** deletes an entry of a dependency:

   ```yaml
   systems:
     - id: zmb:crunch
       remove: true
   ```

   - It follows the same id rules as `override` (qualified, a direct
     dependency, must exist).
   - A removal lists only `id` and `remove`. Any other field is an error,
     and so is `override` and `remove` together.
   - The entry is **gone** from the definition. It gets no index, and
     `def.ids` does not list it. Indices stay **dense**: later entries
     move down, and `def.ids` and every resolved index agree.
   - **Joint validation:** any remaining reference to a removed id is a
     load error, from any pack, the original pack included. This covers
     fields, map legends, Tiled tile properties, loot entries, recipe
     items and expressions such as `has_status("x")` or
     `count_item("x")`. The message names the pack that removed it:
     ``unknown system 'zmb:crunch' (removed by pack 'hardmode')``.
   - A later override of a removed entry is an error ("removed by pack
     …"). A second removal of the same entry is a warning.

### Singleton domains

5. `start`, `clock` and `lighting` accept **`override: true`** inside
   the mapping:

   ```yaml
   clock:
     override: true
     start: "20:00"
   ```

   - The same shallow merge, `null` and per-field provenance rules
     apply (AC 1–2). `start.defeat`, `start.victory`,
     `start.simulation` and `lighting.tint` are replaced whole.
     `defeat: null` removes the defeat condition.
   - The overriding pack must **transitively depend** on the pack that
     first defined the singleton. Otherwise it is an error.
   - `override: true` when no earlier pack defines the singleton is an
     error ("nothing to override").
   - Defining a singleton a second time **without** `override` is still
     an error, as today. The message now suggests `override: true` when
     the pack depends on the first definer.
   - "Exactly one `start`" means exactly one *base* definition, plus any
     number of overrides.

### Order and conflicts

6. Patches apply in **pack load order**. Within a pack they apply in the
   loader's existing file and entry order. A pack may patch an entry an
   earlier pack already patched.
7. **Conflicts warn, later wins.** Take a field (or a removal) written by
   an override from pack **Q**. Pack **P**, loaded later, writes the
   same field or removes the entry. If P does **not** transitively depend
   on Q, the load emits a **warning** and P's value wins:

   ```
   warning: vamp content.yaml:3 clock.start: also overridden by pack 'zmb' (zombie/clock.yaml:2); 'vamp' wins (later in load order)
   ```

   - P depending on Q means the patch is intentional, so there is no
     warning.
   - Overriding a field that only the **original** definer wrote is
     never a conflict.
   - Two overrides of **different** fields of the same entry never
     conflict.
   - The same rules apply to singletons.

### Definition and tools

8. The `Definition` gains **`patches`**: a frozen list, in application
   order, of
   `{ domain, id /* null for singletons */, pack, op: 'override' | 'remove', fields: string[] /* [] for remove */ }`.
   - It is **diagnostic only**. `snapshot()`, `hash()` and saves do not
     include it.
   - A save made with a stack that includes a mod already records that
     mod in `packs` (`m6-save-load`), so the save format does not change.
   - A save whose state names a removed id fails with the existing
     unknown-id error.
9. **`npm run check -- <packs…> --overrides`** prints the loaded stack
   (namespace, version) and then one line per patch:

   ```
   hardmode  override  measurement std_needs:hunger  [rate]
   hardmode  remove    system      zmb:crunch
   vamp      override  clock                         [start]
   ```

   Without the flag, `check` prints only a one-line summary per pack
   that patched anything, for example
   `hardmode: 3 overrides, 1 removal`. The existing output is otherwise
   unchanged.

### Tests and docs

10. Fixture-based tests, in a new `test/overrides.test.ts` (in-memory
    packs via `test/helpers.ts`), cover at least:
    - a field override, an omitted field kept, a nested mapping
      replaced whole, and `null` back to a default;
    - per-field scope: an inherited expression resolves through the
      original pack's depends, and an overriding expression resolves
      through the mod's depends;
    - an asset `file` override loaded from the mod's files, and a map
      `tiled` override reading the mod's `.tmj`;
    - removal, with dense re-indexing checked through `def.ids` and the
      arrays, and a dangling reference reported in a legend, in an
      expression and in a loot entry, each naming the remover;
    - every error case in AC 1, 4 and 5 (short id, own namespace,
      non-dependency, unknown id with suggestion, `override` together
      with `remove`, extra fields on a removal, override after a
      removal, singleton override without dependency or without a base
      definition);
    - conflict warnings for unrelated packs, and no warning when P
      depends on Q or when fields differ;
    - preserved order: overriding a system does not change its index
      or the world's hashes over 100 ticks, compared with an identical
      stack whose override changes nothing. The "changes nothing"
      warning is expected there.
    - `def.patches` contents, and `check --overrides` output (via the
      CLI module's pure formatting function).
11. Every existing test passes unchanged. The shipped packs do not use
    overrides yet, so loading them gives the same definition and the
    same hashes.
12. Documentation:
    - `docs/packs.md` gains a **Mods and overrides** section covering
      the YAML above, the merge, `null` and provenance rules, removal and
      joint validation, singleton overrides, conflict warnings and
      `check --overrides`.
    - The statements "Redefining an existing id is an error — overrides
      come in M7" and "(override semantics come in M7)" are replaced.
    - The Validation section lists the new errors and warnings.
    - VISION §7 marks the override question **decided**, with a short
      summary and a link to the docs.

## Out of Scope

- Load-order resolution from `depends`, pack discovery, manifest
  `kind`/`description` and the browser picker. These belong to
  `m7-stacks`.
- Restructuring the shipped packs into a base plus mods. That is
  `m7-town-base`.
- List operators (append to `tags`, insert a map part, `tags+:`…) and
  deep merge. Revisit only if real mods keep restating long lists.
- Overriding or removing **`distributions`**. They have no ids, so a
  mod can only add more.
- Overriding a pack's own entries, and overriding by short id.
- Renaming ids, and migrating saves across overrides.
- Script hooks (M9).

## Design Notes

- Resolve patches in a new step between `defineIds` and the builders.
  Collect base definitions per domain, apply patches in pack order, then
  assign **dense indices** to the survivors. The `SymbolTable` must know
  removed ids, so `resolve` can explain them. Today `define` assigns the
  index immediately. Split registration from indexing, or rebuild the
  table after patches.
- Represent a merged entry as the merged `JsonObject` plus a per-key
  origin map `{ scope, src }`, keyed by top-level field. `Defined` keeps
  the original's `scope`/`src` for `id` and fallback, and gains
  `origin(key)`. The builders call `d.scope` and `f.at(key)` in many
  places. Give `Fields` a per-key source (e.g. a `srcOf(key)` hook), and
  thread a per-key scope through the helpers that resolve or compile
  (`expr`, `condition`, `numberTerm`, `symbols.ref`). Do not keep using a
  single scope per entry.
- Assets and Tiled maps look up "the pack" by `d.scope.namespace` today
  (`this.packs.find(...)`). Change these lookups to the origin of the
  field holding the path.
- `Fields` rejects unknown keys, so strip `override` before constructing
  it. Never let `override`/`remove` reach the builders.
- Transitive dependency checks need the dependency closure per pack.
  Compute it once in `parsePacks`.
- Keep conflict detection independent of the builders: track
  `lastWriter[entry][field]` while applying patches.

## Agent Notes

- Read these first:
  - `src/core/load/load.ts` (pipeline in `run`, `parsePacks`,
    `defineIds`, `asset`, `map`, `start`, `clock`, `lighting`);
  - `src/core/load/resolve.ts`, `src/core/load/pack.ts`,
    `src/core/load/validate.ts`;
  - `docs/packs.md` (Namespaces and references, Validation);
  - `src/cli/check.ts`.
- Write the dense-index and removed-reference tests first. Index drift is
  the easiest way to corrupt a definition silently.
- `load.ts` is ~1850 lines. Put the patch step in its own module
  (`src/core/load/patch.ts`) rather than growing `load.ts`.
- Run `npm test`, `npm run typecheck` and
  `npm run check -- packs/std packs/std-needs packs/zombie` (and the
  vampire and garden stacks) before reporting.
