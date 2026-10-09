# isolandia

A data-driven engine for isometric open-world RPGs, in the vein of
*Project Zomboid*: systemic simulation (needs, time, loot, AI) on a tile
grid, where a whole game — zombies, vampires, a wild-west town — is
defined by **packs** of YAML and assets rather than code.

The engine knows no genre. Hunger, health, coffins and shambling hordes
are all declared by packs; switching genre means switching pack. See
[`VISION.md`](VISION.md) for the goals, decisions and roadmap.

> **Status:** early development. Milestones S0–M3 are done: simulation
> core, isometric renderer, clock and day/night, systems and statuses,
> items, containers and room-based loot. Next up: perception and AI
> behaviors (M4).

## Play online

The latest `main` is published at <https://andlima.github.io/isolandia/>
(the same query parameters work, e.g. `?packs=zombie`). Saves live in the
browser's local storage, and a new version may refuse older saves.

## Quick start

Requires Node.js.

```bash
npm install
npm run dev          # browser game (Vite) at http://localhost:5173
```

The page opens on a title screen: pick a game (and optional mods) and a
seed. Or go straight to a game with query parameters; dependencies are
added for you:

```
http://localhost:5173/?packs=town
http://localhost:5173/?packs=zombie
http://localhost:5173/?packs=vampire&seed=42
http://localhost:5173/?packs=zombie,hardship
```

Press `?` (or the **Help [?]** button) for every key and gesture, and
`Escape` for the pause menu. Move with the arrow keys, WASD or the numpad,
or click a tile to walk there. Right-click (or long-press) a tile for what
you can do there, or press `E` for your own cell (see
[docs/ui.md](docs/ui.md)). `C` opens the crafting panel. On stairs,
`PageUp`/`<` and `PageDown`/`>` climb a floor (the floors above you are cut
away). Space recenters the camera. `F5` quicksaves, `F9` quickloads and `O`
opens the Game panel with three save slots and file export/import (see
[docs/saves.md](docs/saves.md)).

### Terminal

The same simulation runs headless, rendered as top-down ASCII:

```bash
npm run play -- zombie [--seed N]
npm run play -- town                      # the base game alone: a quiet sandbox
npm run play -- vampire hardship          # a genre mod plus a balance mod
npm run play -- zombie --load isolandia-save.json
```

`?` lists the keys. `q` quits, `g` takes everything nearby, `1`–`9` uses
an item, `d 1`–`9` drops one, `<`/`>` climb stairs. `S` saves to
`--save-file` (default `isolandia-save.json`) and `L` loads it.

## Packs

A pack is a directory with a `pack.yaml` manifest and any number of
`*.yaml` files. Every ID is namespaced (`std_needs:hunger`, `vamp:blood`), and
packs are loaded on top of each other, dependencies first. Name the
packs you want and the engine adds what they `depends` on
(see [docs/packs.md](docs/packs.md#stacks)):

```
packs/
  std/        # stdpack: health, a humanoid archetype, basic tiles
  std-needs/  # stdpack: hunger/thirst/fatigue and their statuses (optional)
  town/       # game "Town": a genre-free 343×343 town with furniture, food,
              #   loot, cooking, barricading; a quiet sandbox on its own
  zombie/     # mod "Zombie Town": the dead fill the town; find a car battery
  vampire/    # mod "Vampire Mansion": blood, sunlight, coffins, on its estate
              #   (reuses the town's generic content)
  hardship/   # mod: needs drain faster, food is scarcer (works with either)
  garden/     # "Bunny Garden": a gentle game for kids — gather carrots,
              #   hide from a sleepy cat; won with start.victory (uses std only)
```

Switching genre is switching mod: `zombie` and `vampire` both stack on
`town` (see [docs/packs.md](docs/packs.md#shipped-packs)).

Validate a pack stack without running it:

```bash
npm run packs                                  # list the available packs
npm run check -- vampire
npm run check -- zombie --overrides            # what the mod changes in the town
npm run check -- garden
npm run check -- garden --save my-save.json   # validate a save too
```

Every milestone is validated with two games of different genres, so genre
assumptions stay out of the engine.

## Development

| Command | What it does |
|---|---|
| `npm test` | Run the test suite (`node:test`, headless) |
| `npm run typecheck` | Type-check with `tsc` |
| `npm run build` | Production build of the browser game |
| `npm run packs` | List the pack catalog (`-- --stack <packs…>` for a resolved stack) |
| `npm run bench:sim` | Headless simulation benchmark |
| `npm run map:export -- <pack-dir>… --map <id> --out <dir>` | Export a map as an isometric Tiled map + tileset (see `docs/packs.md`) |

Source layout:

| Path | Contents |
|---|---|
| `src/core/` | Genre-free simulation: world, ticks, expressions, pack loader |
| `src/iso/` | PixiJS isometric renderer |
| `src/web/` | Browser shell: input, HUD, panels |
| `src/ascii/`, `src/cli/`, `src/node/` | Terminal renderer, CLI entry points, reading packs from disk |
| `packs/` | Game content |
| `docs/` | Reference: [packs](docs/packs.md), [expressions](docs/expressions.md), [iso projection](docs/iso.md), [browser UI](docs/ui.md) |
| `specs/` | Specs for each milestone and task |

Work is spec-driven: each feature is described in a spec under `specs/`
and implemented in its own git worktree. See [`AGENTS.md`](AGENTS.md) for
the workflow and conventions.
