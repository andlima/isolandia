---
id: m7-stacks
area: load
priority: 40
depends_on: [m7-overrides]
description: M7 pack stacks — a platform-free pack catalog (directory name ↔ namespace, manifest `kind` game/mod/library and `description`), a stable dependency-ordered stack resolver so `play zombie` or `?packs=zombie,hardmode` pulls in and orders every `depends`, `npm run packs` to list the catalog, browser save slots keyed by the resolved stack, and a browser title screen that picks a game or mod plus optional extra mods
---

# M7b — Pack stacks and the picker

## Goal

With mods, a playable game is a **stack** of packs: stdpacks, a base, a
genre mod and maybe a balance mod. Today every shell needs the full
list, in dependency order (`packs/std packs/std-needs packs/zombie`).
That gets unwieldy with mods and is easy to get wrong.

This spec lets the user name only the packs they **want**. The engine
adds and orders their dependencies. Pack manifests also say what kind of
pack they are, so the browser can offer a title screen that picks a game
and optional mods.

Override semantics are in `m7-overrides`. The content restructure is in
`m7-town-base`. No engine code may be genre-specific.

## Acceptance Criteria

### Manifest

1. `pack.yaml` gains two optional fields:

   ```yaml
   namespace: zmb
   name: Zombie Town
   version: 0.2.0
   kind: game            # game | mod | library   (default: library)
   description: Scavenge a 256×256 town while the dead close in.
   depends: [std, std_needs]
   ```

   - `kind` is metadata for tools and the picker. The loader checks it
     against the **whole stack**:
     - A `game` must itself define a base `start`.
     - A `mod` must list at least one `depends`.
     - A `library` is not checked.
   - Any other `kind` value is an error with a suggestion. `description`
     must be a string.
   - The existing packs get their kinds: `std` and `std-needs` are
     `library`; `zombie`, `vampire` and `garden` are `game`.
   - `PackInfo` in the `Definition` carries `kind` and `description`.

### Catalog and resolver (core, platform-free)

2. **`buildCatalog(entries: { dir: string; manifest: string }[])`**
   parses only the manifests and returns a catalog: one record per pack
   (`dir`, `namespace`, `name`, `version`, `kind`, `description`,
   `depends`) plus errors.
   - Two directories with the same namespace is a catalog error.
   - A malformed manifest is a catalog error naming the directory. The
     rest of the catalog stays usable.
   - It reuses the loader's manifest validation and does not duplicate
     it.
3. **`resolveStack(catalog, requested: string[])`** returns the ordered
   list of pack records to load, or errors.
   - Each requested token matches a pack's **directory name** or its
     **namespace** (`std-needs` and `std_needs` both work). An unknown
     token is an error with a *did you mean* suggestion and the list of
     available packs.
   - The result contains every requested pack plus the **transitive
     closure** of their `depends`, each pack once.
   - **Order:** dependencies always come before their dependents.
     Otherwise the request order is kept: a depth-first walk over the
     requested tokens in order, visiting `depends` in listed order,
     emitting each pack after its dependencies. As a result:
     - every list that is valid today (deps already first) resolves to
       **exactly the same order**;
     - `[zombie]` resolves to `std, std_needs, zmb`;
     - `[zombie, hardmode]` puts `hardmode` after `zmb` and everything
       it needs;
     - load order between **unrelated** mods follows the request, which
       is what decides `m7-overrides` conflicts.
   - A dependency cycle is an error naming the cycle (`a → b → a`). An
     unknown namespace in `depends` is an error naming the pack that
     declares it.
   - Duplicate tokens collapse to the first occurrence.
4. The catalog and resolver live in `src/core/load/` (for example
   `stack.ts`), are exported from `src/core/index.ts`, and import no
   Node, DOM or Pixi modules.

### Command line

5. `play` and `check` accept **pack names or pack directories**, mixed:
   `npm run play -- zombie`, `npm run play -- packs/zombie hardmode`,
   `npm run check -- std std-needs`.
   - The catalog is every directory directly under **`packs/`** (relative
     to the current directory) that has a `pack.yaml`, plus any explicit
     directory argument outside it.
   - **`--packs-dir <dir>`** replaces `packs/` as the catalog root.
   - After resolving, both commands print the stack on one line to
     stderr when it differs from the arguments
     (`stack: std, std_needs, zmb`).
   - Errors from the catalog or the resolver are printed like load
     errors and exit non-zero.
   - The full explicit lists used today keep working unchanged.
6. **`npm run packs`** (new script `src/cli/packs.ts`) prints the catalog
   as a table: directory, namespace, version, kind, depends and
   description. Games come first, then mods, then libraries, each group
   sorted by directory. With `--stack <names…>`, it prints the resolved
   stack instead.

### Browser

7. `?packs=` accepts the same tokens and is resolved with the same
   resolver over a catalog built from the Vite glob. `?packs=zombie`
   therefore plays the zombie stack.
   - Unknown packs and resolver errors go to the existing error screen.
   - **Save slots, exports and imports** key on the **resolved
     directory list**. `?packs=zombie` and
     `?packs=std,std-needs,zombie` share the same slots, and slots saved
     before this spec under the full list stay reachable.
8. **Title screen.** Without a `packs` parameter, the page shows a
   picker instead of loading a default game.
   - It lists every `game` and every `mod` pack (games first) with its
     `name`, `description` and resolved stack.
   - Choosing one shows **checkboxes for the other `mod` packs**. A mod
     can be checked only if `resolveStack(chosen + checked)` succeeds,
     and an unresolvable mod is shown disabled with the reason. Checked
     mods are appended in click order.
   - **Play** navigates to `?packs=<chosen>,<checked…>&seed=<seed>`. The
     seed comes from a numeric field that defaults to 1.
   - The picker is a thin DOM layer over a pure **`pickerModel(catalog,
     chosen, checked)`** that returns the rows, their enabled state,
     reasons and the target URL query.
   - `body[data-default-packs]` is removed.
9. The error screen gains a **"Back to the title screen"** link. The
   in-game save/load panel gains a **"Title screen"** button that
   navigates to the page without parameters. It is plain navigation:
   unsaved progress is lost, as on reload.
10. `scripts/smoke.mjs` uses short stacks (`zombie`, `vampire`,
    `garden`). It also checks that the bare URL renders the picker with
    at least one row and no console errors.

### Tests and docs

11. Tests, in a new `test/stacks.test.ts` plus additions to
    `test/web.test.ts`:
    - catalog parsing and its errors (duplicate namespace, bad `kind`,
      malformed manifest);
    - resolver order cases (AC 3), including that every explicit stack
      used in the repo's tests and scripts resolves to itself;
    - cycle and unknown-dependency errors;
    - `kind` checks against a stack (a `game` without a `start`, a
      `mod` without `depends`);
    - CLI argument mixing and `--packs-dir`, through a pure argument
      resolver function;
    - `pickerModel` rows, disabled mods with reasons, and the URL;
    - save slot keys being equal for a short and a full request.
12. Every existing test passes. The shipped stacks load the same
    definition as before, apart from the new `PackInfo` fields, and give
    the same hashes.
13. Documentation:
    - `docs/packs.md` documents `kind`, `description`, the resolver order
      rule, short CLI usage, `npm run packs` and `--packs-dir`.
    - Its examples use short stacks where that reads better.
    - `docs/ui.md` (or `docs/iso.md`, wherever the browser shell is
      described) documents the title screen and the `?packs=` tokens.
    - `README.md` quick-start commands use the short form.

## Out of Scope

- Installing third-party packs in the browser (zip upload, File System
  Access API). Only packs bundled under `packs/` are listed.
- Version constraints in `depends` (`std >= 0.2`), optional dependencies
  and soft ordering hints (`load_after`). Request order is the only
  tie-breaker.
- Remembering the last chosen stack across visits, and per-stack
  settings.
- Restructuring the shipped packs (`m7-town-base`) and override
  semantics (`m7-overrides`).
- Thumbnails or art for the picker. Text rows are enough.

## Design Notes

- Extract the manifest checks from `parseManifest` in `pack.ts` into a
  function both the loader and `buildCatalog` call.
- `kind` checks need the resolved singletons, so run them at the end of
  `Loader.run`, where `start` is known. A `game` "defines a base
  `start`" if that pack has a `start` mapping without `override: true`.
- The browser catalog comes from the same `import.meta.glob` result
  (`TEXT`): pick out the `packs/<dir>/pack.yaml` keys. `availablePacks`
  becomes a catalog lookup.
- `params.ts` keeps parsing only. Resolution happens in `main.ts` after
  the catalog is built, and the resolved directory list replaces
  `params.packs` everywhere (`slotKey`, `exportFileName`, imports).
- Keep `src/cli/common.ts` the single place that turns argv into a
  resolved stack for `play`, `check` and `packs`.

## Agent Notes

- Read these first:
  - `src/core/load/pack.ts` (`parseManifest`);
  - `src/cli/common.ts`, `src/cli/check.ts`, `src/cli/play.ts`;
  - `src/web/main.ts`, `src/web/params.ts`, `src/web/packs.ts`,
    `src/web/saves.ts`, `src/web/errors.ts`, `src/web/game-panel.ts`;
  - `scripts/smoke.mjs`.
- Chromium is unavailable in the sandbox. Keep the picker logic in
  `pickerModel` and test it with `node:test`. The DOM layer should only
  render rows and wire clicks.
- Run `npm test`, `npm run typecheck`, `npm run build`, `npm run packs`
  and `npm run check -- zombie` / `vampire` / `garden` before reporting.
