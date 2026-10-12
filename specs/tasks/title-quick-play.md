---
id: title-quick-play
area: web
priority: 40
depends_on: []
description: "Title screen with quick-play cards: packs opt in with a `featured: N` manifest field, the screen shows them as big one-click buttons that start the game at once, and today's full picker (every game and mod, extra-mod checkboxes, seed, Play) moves into a collapsed Advanced section. Garden, zombie, vampire and western are featured."
---

# Title screen: quick-play cards and an Advanced section

## Goal

The title screen (`src/web/picker.ts`, `src/web/picker-dom.ts`) lists every
`game` and `mod` pack as equal rows, with their resolved stacks, extra-mod
checkboxes, a seed field and a Play button. A new player sees seven rows,
including `hardship` (a modifier, not a game) and `town` (a quiet sandbox),
and has to pick, then press Play. There is no sane default.

This task gives the screen **3 to 4 quick-play cards** at the top. One
click on a card starts that game with the default seed. Everything that
exists today moves into a collapsed **Advanced** section for people who
want a custom stack, extra mods or a chosen seed. Which packs are featured
is **pack data**, not code: `src/` stays genre-agnostic, so a pack opts in
through a new `featured` field in its `pack.yaml`. The `?packs=` URL
contract, the resolver and the in-game UI are untouched.

## Acceptance Criteria

1. **Manifest field `featured`.** `pack.yaml` accepts an optional
   `featured: <N>` where N is a positive integer (1, 2, 3…), the display
   order among featured packs (lower first). In `src/core/load/pack.ts`:
   - `featured` joins `MANIFEST_FIELDS` so it is not reported as unknown.
   - `Manifest.featured: number | null` (null when absent).
   - Any other value (string, 0, negative, non-integer, list) is a load
     error at `featured` with the message
     `field 'featured' must be a positive integer`, in the style of the
     existing `description` check. The pack stays usable otherwise, as
     for a bad `description`.
   - `featured` on a `library` pack is a load error:
     `only game and mod packs can be featured`.
2. **Catalog and definition carry it.** `CatalogPack.featured: number |
   null` in `src/core/load/stack.ts` (set by `buildCatalog`) and
   `PackInfo.featured: number | null` in `src/core/definition.ts` (set
   wherever `kind` and `description` are copied in the loader). Both have
   a short doc comment.
3. **Shipped manifests.** `packs/garden/pack.yaml` gets `featured: 1`,
   `packs/zombie/pack.yaml` `featured: 2`, `packs/vampire/pack.yaml`
   `featured: 3`, `packs/western/pack.yaml` `featured: 4`. `town`,
   `noir`, `hardship`, `std` and `std-needs` are not featured. `npm run
   check` and every shipped stack load as before.
4. **Picker model** (`src/web/picker.ts`, still a pure function):
   - `PickerView.featured: readonly PickerCard[]`, where `PickerCard` has
     `dir`, `name`, `description`, `stack` (resolved namespaces), `enabled`,
     `reason` (why it is disabled, or null) and `query` (`?packs=<dir>&seed=<seed>`
     for an enabled card, null otherwise). Cards are the packs with a
     non-null `featured`, sorted by `featured` then `dir`. A featured pack
     whose own stack does not resolve is still listed, disabled, with the
     reason, like a row.
   - The card's `query` uses the same `seed` argument as `PickerView.query`
     and the same readable-comma formatting (`?packs=garden&seed=1`).
   - `rows`, `mods`, `stack`, `query` and `errors` keep their exact current
     meaning. Every existing picker test passes unchanged.
5. **Title screen DOM** (`src/web/picker-dom.ts`, styles in `index.html`):
   - Below the `isolandia` title, when the model has at least one card: a
     cards block (`#picker .picker-cards`), one `<button class="picker-card">`
     per card showing its `name` (or `dir` when empty) and `description`.
     A click calls `navigate(card.query)` at once. No Play press is
     needed. A disabled card shows its `reason` instead of the description
     and is `disabled`. Cards are large, finger-friendly targets (at least
     44 px tall, full width on narrow screens, a 2-column grid at 480 px
     and up), consistent with the page's monospace dark theme.
   - Under the cards, a `<details class="picker-advanced">` whose
     `<summary>` reads `Advanced: build your own stack`. Inside it is
     exactly today's content: the rows, the extra-mod checkboxes, the
     `Loads:` hint, the seed field and the Play button, with their current
     ids and classes (`picker-row`, `picker-mod`, `picker-play`…) and
     current behaviour. The details element is **closed** by default when
     there is at least one card and **open** when there are no cards, so a
     catalog with no featured packs looks and works like today.
   - Catalog errors (`picker-errors`) render above the cards, where they
     are today, not inside the details.
   - Changing the seed field also changes the cards' queries (the model is
     re-rendered on input, as today). Cards keep working while the details
     element is open.
6. **Smoke script** (`scripts/smoke.mjs`): the title-screen check waits
   for `#picker .picker-card, #picker .picker-row` (the rows are inside a
   closed `<details>` and so not visible), reports the number of cards and
   rows, and fails when there is neither. The `title.png` screenshot is
   kept.
7. **Docs.**
   - `docs/packs.md`: the manifest example and the field list (near
     `kind` and `description`) document `featured`, its validation and
     that only `game`/`mod` packs can set it. The Shipped packs section
     names the four featured packs.
   - `docs/iso.md`, "Title screen": describe the cards (one click starts
     the game with the seed field's value, default 1), the Advanced
     details and that the featured set comes from `featured` in
     `pack.yaml`.
   - `README.md`: the "title screen" sentence mentions the quick-play
     cards and the Advanced section.
8. **Tests.**
   - `test/stacks.test.ts`: `buildCatalog` reads `featured` (1, absent →
     null); `featured: 0`, `featured: x`, `featured: 1.5` and
     `featured: [1]` each give the positive-integer error; `featured` on a
     library gives the library error; the shipped catalog has exactly
     `garden`, `zombie`, `vampire`, `western` featured, in that order by
     number. `PackInfo.featured` is set after `loadPacks`.
   - `test/web.test.ts` (extend `STACK_YAML` or a copy): `pickerModel`
     with no featured packs gives `featured: []`; with `featured` on
     `other` (1) and `game` (2) the cards come in that order with
     `query` `?packs=other&seed=1` and `?packs=game&seed=1`, and a custom
     seed flows into card queries; a featured `broken` card is listed
     disabled with its reason and `query: null`; the existing `rows`,
     `mods` and `query` results are unchanged by featuring.
9. `npm run typecheck`, `npm test` and `npm run check` pass. Run `npm run
   smoke` if a Playwright browser is installed and report the result;
   it is not a gate.

## Out of Scope

- A "Continue" or last-save card on the title screen.
- Remembering the last played stack or seed in `localStorage`.
- Card art, screenshots or thumbnails for featured packs.
- Changing the `?packs=` or `?seed=` parameters, the resolver, the Game
  panel or the in-game "Title screen" button.
- Featuring stacks of more than one pack (e.g. `zombie,hardship`). A card
  is a single pack token; its dependencies come from the resolver.
- Changing any pack content other than the four manifest lines.
- The `spike.html` page.

## Design Notes

- Keep the model/DOM split: `pickerModel` decides everything (which cards,
  their order, their queries, their reasons); `picker-dom.ts` only renders
  and wires clicks. The `showPicker(catalog, navigate)` signature stays,
  so `main.ts` does not change.
- Manifest validation lives next to the `description` check in
  `readManifest`. Treat `null` like absent, as `description` does. The
  library check can live in the same place since `kind` is already known
  there; a kind error plus a featured error on the same manifest is fine.
- `PackInfo.featured` is set in the loader where `PackInfo` objects are
  built from manifests (search for `description: m.description` or the
  `PackInfo` construction in `src/core/load/`).
- For the cards' `stack`/`reason`, reuse the existing `stackOf` helper
  over `[p.dir]`, as rows do.
- Suggested CSS: `.picker-cards { display: grid; gap: 8px; margin-bottom:
  16px }`, `@media (min-width: 480px) { grid-template-columns: 1fr 1fr }`;
  `.picker-card` like `.picker-row` with more padding, a larger
  `.picker-name` and a `#ffd23f` border on hover/focus-visible;
  `.picker-advanced summary { cursor: pointer; color: #c9a25a }`.
- Smoke: Playwright's `waitForSelector` waits for a visible element, so
  the selector must include `.picker-card`; `$$eval` counts both lists
  regardless of visibility.

## Agent Notes

Read `src/web/picker.ts`, `src/web/picker-dom.ts`, `src/web/main.ts`
(`showPicker` call), `src/core/load/pack.ts` (`readManifest`,
`MANIFEST_FIELDS`), `src/core/load/stack.ts` (`buildCatalog`,
`CatalogPack`), `src/core/definition.ts` (`PackInfo`), the picker tests in
`test/web.test.ts` (from `STACK_YAML`), the catalog tests in
`test/stacks.test.ts`, `scripts/smoke.mjs`, and the "Title screen" section
of `docs/iso.md` plus the manifest section of `docs/packs.md`. The core
change is a few lines; most of the work is the model's `featured` list,
the DOM restructuring into cards plus `<details>`, and the tests. Remember
to quote nothing in YAML here: `featured: 1` is a plain integer.
