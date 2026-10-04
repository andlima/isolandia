---
id: bunny-garden
area: packs
priority: 40
depends_on: []
description: A third, kid-friendly game pack "Bunny Garden" (packs/garden, namespace gdn) in which a bunny gathers carrots while a sleepy cat and butterflies roam the garden; it adds a genre-neutral `start.victory` win condition to the engine (mirroring `start.defeat`) and full pixel art in the shipped style
---

# Bunny Garden: a third, cute game pack + `start.victory`

## Goal

isolandia ships two horror games: `zombie` (Zombie Town) and `vampire`
(Vampire Mansion). This task adds a **third, very different genre**: a
gentle, cute game for kids. The pack is called **Bunny Garden**. It lives
in `packs/garden` with namespace `gdn` and depends on `[std]` only.

The player is a **bunny** in a sunny garden. The goal is to gather
**carrots** from the carrot patches. Clover and strawberries restore the
bunny's **energy**, and so does napping in the **burrow**. A **sleepy cat**
wanders the garden. When it spots the bunny it chases it playfully, and it
loses interest when the bunny hides in a bush or gets far away. Hopping on
the gravel path is noisy, so the cat comes to check. **Butterflies**
flutter around the flowers and flit away from the bunny. Nothing ever gets
hurt. There is **no defeat**. The game is **won** when the bunny has
gathered enough carrots.

Winning needs one small engine feature: a genre-neutral `start.victory`
that mirrors `start.defeat`. Everything else is pack content (YAML plus
pixel art) on the existing engine. No engine code may name garden content
(VISION.md §3.8).

## Acceptance Criteria

### Engine: `start.victory`

1. `start` accepts an optional `victory: { when, message? }` with the same
   shape and validation as `defeat`. `when` is a condition expression with
   `self` = player. Validation also rejects unknown fields and conditions
   that evaluate to an entity or tile. The default `message` is
   `"Victory"`. `Definition.start` gains `victory: VictoryDef | null`; a
   shared type with `DefeatDef` is fine.
2. The world checks victory in the same phase as defeat (tick-order
   phase 7). Defeat is checked first. If defeat triggers on a tick,
   victory is not checked on that tick. When victory's `when` becomes
   truthy, the world records `victory = { tick, message }`. From then on
   it is **frozen exactly like after defeat**: `step()` is a no-op, and
   `queueIntent`/`queueAction` ignore their input. `victory` is part of
   `snapshot()` and `hash()`, like `defeat`. A world has at most one of
   the two outcomes.
3. The HUD model (`src/core/hud.ts`) exposes `victory`
   (`{ message, clock, text }`), as it does for defeat. The ASCII HUD
   prints its line. The web banner (`src/web/hud.ts`) shows it. The banner
   may share the defeat banner element but must be visually distinct, for
   example with a different id/class and colour. The inventory and loot
   panels become read-only after victory, as they do after defeat.
4. Tests cover: loading with and without `victory`, the default message,
   validation errors (unknown field, a non-boolean-ish condition), a world
   that wins and then freezes (step, intents and actions are ignored, and
   the snapshot/hash include victory), defeat taking precedence on the
   same tick, and the HUD model text.
5. Docs: `docs/packs.md` documents `start.victory` next to `defeat`. This
   covers the `start` example, the tick-order phase 7 wording and the
   "After defeat" notes in Actions and Containers, which now apply to
   either outcome.

### Pack content: `packs/garden`

6. `packs/garden/pack.yaml`: `namespace: gdn`, `name: Bunny Garden`,
   `version: 0.1.0`, `depends: [std]`. `npm run check -- packs/std
   packs/garden` passes.
7. **Measurement** `energy` (Energy, 0–100, initial about 80). It drifts
   slowly down, faster at night (`world.is_day`). Tune it so that an idle
   bunny becomes **sleepy** during day 1 but nothing bad ever happens.
   The status `sleepy` (with hysteresis) has no damage. It may lower
   `energy` further or simply show in the HUD. There is **no
   `std:hp` loss anywhere and no `defeat`**.
8. **Tiles** (the names are a guide; small changes are fine if they keep
   the roles):
   - `grass`, `flowers` (flat, walkable);
   - `gravel`: a walkable path tagged `crunchy`. A system emits noise
     (radius about 7) while a `bunny`-tagged entity stands on it;
   - `burrow`: flat, walkable, tagged `burrow`. Standing on it restores
     energy quickly ("nap"), with a gentle maximum;
   - `bush`: walkable, `raised: true` and tagged `hiding`. The bunny hides
     in it;
   - `carrot_patch`: a walkable container whose loot is carrots;
   - `berry_bush`: a non-walkable container that holds strawberries and
     clover;
   - `wheelbarrow`: a non-walkable, oriented (4-way) container with
     garden odds and ends;
   - `pond`: non-walkable, `opaque: false`, `raised: false` (flat water);
   - `fence`: non-walkable, `opaque: false` (low).

   The map also uses std `floor`/`wall`/`door` for a small garden shed.
9. **Items**:
   - `carrot`: the goal item. It has **no `use`**, so eating a carrot can
     never put the win out of reach.
   - `clover` and `strawberry`: `use` restores energy.
   - `acorn` and `feather`: junk.
   Weights and the bunny's inventory capacity must allow carrying the
   victory amount plus some snacks.
10. **Archetypes**:
    - `bunny` (player): tags `[bunny, critter]`, measurements `[energy]`,
      `ticks_per_step: 1`. It starts with an inventory holding a clover
      or two.
    - `cat`: tags `[cat]`, with behavior `cat`.
    - `butterfly`: tags `[bug]`, with behavior `butterfly`.
11. **Statuses**:
    - `sleepy` on the bunny;
    - `hidden` on the bunny while it stands on a `hiding` tile;
    - `curious` on the cat. It is entered when the cat can see the bunny
      within about 5 tiles **and the bunny is not hidden**. It is exited
      past about 8 tiles or once the bunny is hidden. Use
      `has_status(player, "hidden")` or an equivalent supported
      expression; check docs/expressions.md;
    - `alert` on the butterfly (sees the bunny within about 3 tiles).
12. **Behaviors**:
    - `cat`: `nap` (idle at home, with a timeout to `stroll`); `stroll`
      (wander, radius about 6); `chase` (pursue the player while
      `curious`); `investigate` noises when not curious; then return home
      and nap. While the cat is adjacent to the bunny, a status on the
      bunny (for example `startled`) drains some energy. That is the only
      "cost". It is not damage.
    - `butterfly`: wander near the flowers, flee while `alert`, then go
      home.
13. **Clock and lighting**: the game starts in the morning, for example
    `07:00`. The lighting has a soft, bright pastel day and a gentle
    blue-violet night that stays readable.
14. **Start**: map `garden`, player `bunny`, and
    `victory: { when: 'self.count_item("carrot") >= N', message: … }`.
    Use a cheerful message, for example "You gathered all the carrots!
    Snack time!". Choose N (for example 10) so that the map's carrot
    patches hold enough carrots on every seed: guarantee it through the
    loot `rolls`/`count`, not luck.
15. **Map** `garden`: a fenced garden of roughly 24×16 with the burrow
    near the player's start, several carrot patches, berry bushes,
    flower beds, bushes, a pond, a gravel path, a small shed (std walls,
    door and floor) with a wheelbarrow, one or two cats and a few
    butterflies. Rooms tag areas such as `veggies` and `shed` so loot
    `distributions` can use them.

### Pixel art

16. Every tile, archetype and item of `garden` has a pixel-art sprite in
    `packs/garden/assets.yaml`. It follows docs/art.md: 2 px grid, sizes
    and anchors, top-left light, at most 32 colours. Characters (`bunny`,
    `cat`, `butterfly`) are **8-way** (5 drawings). `wheelbarrow` is
    **4-way** (2 drawings). Everything else is a single `file`. The
    drawings live in `art/garden.mjs` on top of `art/lib.mjs` (and
    `art/characters.mjs` where useful) and are generated by
    `scripts/pixel-art.mjs`, with `garden` added to its `PACKS`. The look
    is **cute**: round shapes, big eyes, a bright pastel palette. The
    bunny has long ears that read in every facing. The butterfly hovers
    above its shadow, like the bat.
17. `docs/art.md` lists the garden palette. `test/art.test.ts` adds the
    stack `['std', 'garden']` and its 8-way/4-way expectations, and it
    passes.

### Integration, tests and docs

18. Add `garden: ['packs/std', 'packs/garden']` to `test/helpers.ts`
    `GAMES`. Also add the garden stack to `scripts/smoke.mjs` and
    `scripts/sim-bench.ts` next to the other two.
19. Add tests on the real pack. Extend the existing per-genre test files
    where that fits, for example with a `garden:` case:
    - loader: `std + garden` loads, and the victory is parsed;
    - scenario: an **idle** bunny is never defeated and does not win
      within 2 days, but becomes `sleepy` on day 1. A **collecting bot**
      (extend `test/looter.ts` if needed) uses only goto/take/use and
      **wins within 1 in-game day on seeds 1–5**;
    - behaviors/sight: the cat becomes `curious` and chases a visible
      bunny, and it loses interest when the bunny steps into a bush;
    - noise: hopping on gravel draws a napping/strolling cat to
      investigate;
    - existing determinism loops over `['zombie', 'vampire']` include
      `garden` wherever the test is genre-agnostic.
20. `test/boundaries.test.ts`: add garden content words (for example
    `bunny|carrot|gdn`) to the genre regex. `src/` must stay free of them.
21. Docs: add the garden to the `README.md` packs list (with a URL
    example `?packs=std,garden`) and to the opening of `docs/packs.md`
    ("zombie, vampire and garden mini-games"). The browser default stack
    stays `std,std-needs,zombie`.
22. Verify gates pass: `npm run typecheck`, `npm test`,
    `npm run check -- packs/std packs/std-needs packs/zombie`,
    `npm run check -- packs/std packs/vampire` and
    `npm run check -- packs/std packs/garden`.
23. If a browser is available, run `npm run smoke` and commit the
    refreshed `docs/screens/` screenshots, including the garden. Smoke is
    not a gate. If it cannot run, say so in the completion report.

## Out of Scope

- Any engine feature other than `start.victory`. This means no
  speed-changing statuses, no dialogue, no score, no multi-level maps and
  no new behavior activities.
- Damage, health loss or defeat in the garden pack.
- Changing the zombie or vampire packs (except adding them to new shared
  test loops), or the browser's default pack stack.
- Animation and sound.
- A level-select or main-menu UI. The game is chosen with
  `?packs=std,garden`, as today.

## Design Notes

- Defeat is implemented in `src/core/load/load.ts` (`defeat()` and
  `start`), `src/core/definition.ts` (`DefeatDef`, `start`),
  `src/core/sim/world.ts` (`checkDefeat`, the `defeat` field, the snapshot
  and the guards in `queueAction`/`queueIntent`/`step`),
  `src/core/hud.ts`, `src/web/hud.ts`, `src/web/panels.ts` and the ASCII
  HUD. Mirror each place for victory. A shared `ended`/`outcome` helper
  is welcome if it keeps the code simple.
- Hiding works through a status on the bunny (`hidden`) that the cat's
  `curious` condition tests. Bushes stay `opaque: false`. This avoids any
  sight-rule change.
- The cat must never trap the bunny. Entities do not block each other, so
  this holds naturally. Keep the `startled` drain mild, so that the
  collecting bot still wins on every seed.
- Pick tag and status names that do not clash with the zombie/vampire
  regexes in `test/boundaries.test.ts`.
- Vite picks up `packs/garden/**` automatically via `import.meta.glob`.

## Agent Notes

- Read `docs/packs.md`, `docs/expressions.md`, `docs/art.md`,
  `packs/vampire/` (the closest template: one content pack on `std`, with
  behaviors and noise) and `art/vampire.mjs` before starting.
- Do the engine `start.victory` work and its tests first, then the pack
  YAML with placeholder sprites. Tune the scenario numbers before
  drawing, and do the pixel art last.
- Use `node scripts/pixel-art.mjs garden --preview out.png` to inspect
  the drawings. Do not commit the preview.
