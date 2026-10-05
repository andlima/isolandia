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

## Quick start

Requires Node.js.

```bash
npm install
npm run dev          # browser game (Vite) at http://localhost:5173
```

The browser loads `std,std-needs,zombie` by default. Pick packs and a seed with
query parameters:

```
http://localhost:5173/?packs=std,vampire&seed=42
http://localhost:5173/?packs=std,garden
```

Move with the arrow keys, WASD or the numpad, or click a tile to walk
there. Right-click (or long-press) a tile for what you can do there, or
press `E` for your own cell (see [docs/ui.md](docs/ui.md)). `C` opens the
crafting panel. Space recenters the camera. `F5` quicksaves, `F9`
quickloads and `O` opens the Game panel with three save slots and file
export/import (see [docs/saves.md](docs/saves.md)).

### Terminal

The same simulation runs headless, rendered as top-down ASCII:

```bash
npm run play -- packs/std packs/std-needs packs/zombie [--seed N]
npm run play -- packs/std packs/std-needs packs/zombie --load isolandia-save.json
```

`q` quits, `g` takes everything nearby, `1`–`9` uses an item, `d 1`–`9`
drops one. `S` saves to `--save-file` (default `isolandia-save.json`) and
`L` loads it.

## Packs

A pack is a directory with a `pack.yaml` manifest and any number of
`*.yaml` files. Every ID is namespaced (`std_needs:hunger`, `vamp:blood`), and
packs are loaded in order on top of each other:

```
packs/
  std/        # stdpack: health, a humanoid archetype, basic tiles
  std-needs/  # stdpack: hunger/thirst/fatigue and their statuses (optional)
  zombie/     # "Zombie Town": loot, survival systems, a small town map
              #   (uses std + std-needs)
  vampire/    # "Vampire Mansion": blood, sunlight, coffins (uses std only)
  garden/     # "Bunny Garden": a gentle game for kids — gather carrots,
              #   hide from a sleepy cat; won with start.victory (uses std only)
```

Validate a pack stack without running it:

```bash
npm run check -- packs/std packs/vampire
npm run check -- packs/std packs/garden
npm run check -- packs/std packs/garden --save my-save.json   # validate a save too
```

Every milestone is validated with two games of different genres, so genre
assumptions stay out of the engine.

## Development

| Command | What it does |
|---|---|
| `npm test` | Run the test suite (`node:test`, headless) |
| `npm run typecheck` | Type-check with `tsc` |
| `npm run build` | Production build of the browser game |
| `npm run bench:sim` | Headless simulation benchmark |

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
