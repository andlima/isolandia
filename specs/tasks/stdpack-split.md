---
id: stdpack-split
area: packs
priority: 30
depends_on: []
description: Apply VISION decision 8 — replace the `base` pack with a stdpack split into optional packs (`std`: health, humanoid, basic tiles; `std-needs`: hunger/thirst/fatigue and the generic need statuses), rewire zombie/vampire, tests, scripts, web defaults and docs, and extend the genre-word guard to stdpack terms
---

# Stdpack split: `base` → `std` + `std-needs`

## Goal

VISION.md decision 8 defines three tiers: a genre-free engine, an optional
"batteries included" **stdpack**, and genre packs. The §7 open question
asks whether the current `base` pack should become the stdpack, and
whether it should be one pack or several optional ones. This task settles
it: **several optional packs**, starting with two.

- **`packs/std/`** (namespace `std`) replaces `packs/base/`. It has the same
  content: the `hp` measurement, the `humanoid` archetype, and the
  `floor`/`wall`/`door` tiles.
- **`packs/std-needs/`** (namespace `std_needs`, because namespaces must
  match `[a-z][a-z0-9_]*`) takes the generic needs out of the zombie pack:
  the `hunger`/`thirst`/`fatigue` measurements and the `hungry`/`thirsty`/
  `exhausted`/`burdened` statuses. It depends on `std`.
- The zombie pack uses both. The vampire pack uses only `std`, which shows
  that a game can skip `std-needs`.
- The engine guard test also catches stdpack terms, so the engine can't
  quietly start depending on them.

This task is **pure data and plumbing**. It adds no engine features and
changes no sim semantics. Zombie and vampire must play exactly as before.
The only visible difference is qualified ids (`std:hp`, `std_needs:hunger`,
…).

## Acceptance Criteria

### `std` pack

1. `packs/base/` is gone. `packs/std/` contains `pack.yaml` with
   `namespace: std`, `name: Standard`, `version: 0.1.0`, and no depends.
   Its content is identical to the old base pack (same ids, labels,
   values, glyphs and colors), moved as-is. Use `git mv` so history
   follows the files.

### `std-needs` pack

2. `packs/std-needs/pack.yaml` has `namespace: std_needs`, a human `name`
   (e.g. `Standard needs`), `version: 0.1.0` and `depends: [std]`.
3. It defines the following, **moved verbatim** from the zombie pack (same
   ids, labels, values, expressions and comments where they still make
   sense):
   - measurements `hunger`, `thirst`, `fatigue` (from
     `packs/zombie/needs.yaml`, which is deleted);
   - statuses `hungry`, `thirsty`, `exhausted`, `burdened` (from
     `packs/zombie/survival.yaml`).
4. The opt-in convention is **documented** in the pack (a header comment)
   and in `docs/packs.md`. An entity takes part in the needs by listing
   the measurements in its archetype and carrying the `living` tag, which
   the statuses' `for` filters test. An entity without the tag or the
   measurements is unaffected.
5. Everything zombie-specific stays in `packs/zombie/survival.yaml`: the
   `stocked` status (it references zombie items), and the `sleep`,
   `bleed` and `collapse` systems. These refer to the moved ids by short
   name (`hunger`, `has_status("hungry")`, …), which resolves through
   `depends`.

### Genre packs

6. `packs/zombie/pack.yaml` has `depends: [std, std_needs]`.
   `packs/vampire/pack.yaml` has `depends: [std]`.
7. Every qualified `base:` reference in pack YAML becomes `std:`
   (`packs/zombie/archetypes.yaml` `measurements: [base:hp]`,
   `packs/vampire/content.yaml` `max: "max(10, self.base:hp / 2)"`). Short
   references stay short.
8. **Behavior is unchanged.** For the same seed and inputs, a zombie or
   vampire run produces the same measurement values, statuses, loot and
   defeat timing as before. The existing scenario/looter tests
   (`test/scenario.test.ts`, `test/items.test.ts`, `test/systems.test.ts`,
   …) keep passing with only id/path updates to their expectations and no
   numeric changes. If any golden hash or snapshot changes *only* because
   of namespace strings, update it and say so in the PR description.

### Load orders everywhere

9. Every place that loads the real packs uses the new ordered lists:
   `std, std-needs, zombie` and `std, vampire`. This includes at least:
   - tests that read `packs/base` (`test/loader.test.ts`,
     `test/world.test.ts`, `test/scenario.test.ts`,
     `test/movement.test.ts`, and any others found by grep);
   - `scripts/smoke.mjs` and `scripts/sim-bench.ts` (keep the bench labels
     meaningful, e.g. `std+zombie`);
   - `index.html` `data-default-packs` (→ `std,std-needs,zombie`) and the
     doc comment in `src/web/params.ts`;
   - the example commands in `README.md` and in `docs/`.
10. Synthetic test fixtures that merely *name* a pack `base` (e.g. the fake
    file maps in `test/web.test.ts`, or inline fixture packs in
    `test/loader.test.ts`) can stay as they are. Rename them only if that
    makes the test clearer. Tests that assert against the **real** base
    pack's ids (`base:hp`, `base:humanoid`, `zmb:hunger`, …) must be
    updated to `std:…` / `std_needs:…`.
11. Loading `packs/zombie` without `std-needs` gives the existing clear
    "unmet dependency" load error (add a loader test for this). Loading
    `std` + `std-needs` alone, with no genre pack, is not required to be
    playable, since there is no `start`, but `npm run check -- packs/std
    packs/std-needs` must pass validation.

### Engine guard

12. Extend the genre-word test in `test/boundaries.test.ts` ("no genre
    words in src/") so it also rejects **stdpack terms**: at least `hp`,
    `health`, `fatigue`, `hungry`, `thirsty`, `humanoid`. Rename the test
    or add a sibling test so its message says that engine code must not
    name stdpack or genre content either.
13. Fix the two current leaks it will catch. Keep each message helpful by
    using a neutral example:
    - `src/core/load/load.ts` (~line 828): the effects error example
      `{ type: apply, measurement: hp, delta: -1 }` → e.g.
      `measurement: energy`.
    - `src/core/expr/compile.ts` (~line 388): the `has_status()` error
      example `"hungry"` → e.g. `"stunned"`.
    Update any test that matches those messages literally.
    `src/` must end up free of every word in the extended list.

### Docs

14. `docs/packs.md` and `docs/expressions.md`: examples switch from
    `base:` to `std:` (e.g. `tile.id == "std:floor"`,
    `self.std:hp`). Add a short "Standard packs" subsection to
    `docs/packs.md` that lists `std` and `std-needs`, their contents,
    their depends, and the `living` opt-in, and states the decision 8 rule
    that the stdpack uses nothing a third-party pack could not.
15. `README.md`: the pack tree and commands reflect `std/` and
    `std-needs/`.
16. `VISION.md`: mark the §7 stdpack open question as **decided** (struck
    through with a "**Decided (task `stdpack-split`):**" note, the same
    style as the others). The note records the split into optional packs,
    the `std`/`std_needs` namespaces, the `living` opt-in, what stayed in
    zombie, and that more packs (e.g. `std-melee`) get added as genres
    repeat patterns. Leave the roadmap and §8 otherwise untouched.

### Quality gates

17. `npm run typecheck`, `npm test`, `npm run smoke` and `npm run build`
    all pass. `npm run check -- packs/std packs/std-needs packs/zombie`
    and `npm run check -- packs/std packs/vampire` report no errors.
18. `grep -rn "packs/base\|base:" --include=*.ts --include=*.mjs
    --include=*.yaml --include=*.md --include=*.html .` (outside
    `node_modules`, `.git` and `specs/`) finds no leftover references to
    the real base pack. Synthetic fixtures (AC 10) and unrelated uses of
    "base" (e.g. Vite's `base: './'`) are fine.

## Out of scope

- Removing the engine's special `player` concept (decision 8 says the
  player is just an input-controlled entity). That is a separate refactor.
  Do not add `player` to the guard list.
- Moving systems (`sleep`, `bleed`, `collapse`), `lighting`, `clock`,
  items, loot or containers into the stdpack.
- Pack override/merge semantics (M7). Games still pick whole packs.
- Any new engine primitive or schema field.
- A third genre pack.
