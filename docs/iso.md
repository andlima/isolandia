# Isometric view

The browser build plays the same packs as the terminal, in isometric view
(PixiJS). The engine code is the same for every genre; only the packs
change.

## Running

```sh
npm run dev          # http://localhost:5173/  (the S0 spike is at /spike.html)
npm run build        # dist/index.html + dist/spike.html
npm run preview      # serve the build
npm run smoke        # Playwright: both genres, screenshots in docs/screens/
```

`npm run smoke` needs Chromium (set `BENCH_CHROMIUM` to a Chrome/Chromium
binary if Playwright's own download is unavailable, `SMOKE_HEADED=1` for a
visible window). It fails on console errors, a blank canvas or a load-error
screen.

### Query parameters

| Param            | Default       | Meaning |
|------------------|---------------|---------|
| `?packs=a,b,…`   | `base,zombie` | Ordered pack directory names under `packs/` (same order rule as the CLI) |
| `?seed=N`        | `1`           | Integer world seed |

For example `?packs=base,vampire&seed=7`. When loading fails — including an
unknown pack name — the page shows the complete error list, formatted like
`npm run check`, instead of the game. The default list lives in
`index.html` (`data-default-packs`) so that `src/` stays genre-agnostic.

## Controls

| Input                          | Action |
|--------------------------------|--------|
| Click / tap a tile             | Walk there (A\* path). The target is outlined while the path is active; an unreachable tile flashes red |
| Arrows, WASD, numpad (held)    | Move in 8 directions, screen-relative (`W` = straight up on screen, `W`+`D` = up-right, i.e. map-north); unlike the terminal, which stays grid-aligned. Cancels any path |
| Drag (mouse or one finger)     | Pan; stops following the player |
| Wheel / pinch                  | Zoom around the cursor / pinch centre, 0.25×–3× |
| `Space`                        | Re-centre on the player and follow again |
| `H`                            | Toggle the HUD |

A drag never counts as a click (8 px threshold). The HUD shows the
in-game day and time (`Day 1 08:02`, from the pack's `clock`) and the
player's measurements, from the same `hudModel` as
the ASCII HUD, plus a `Status: …` line while the player has active
statuses. When the pack's `start.defeat` condition is met, the HUD adds the
defeat message and a centred banner covers the canvas; the camera still
pans and zooms, but movement input is ignored.

## Day/night tint

If a pack defines [`lighting`](packs.md#lighting), the ground and object
layers are multiplied by `tintAt(lighting, timeOfDay)` (Pixi `tint` on the
two containers, updated only when the colour changes). The time of day is
computed from `tick + alpha`, so the tint changes smoothly between ticks.
Path/target markers and the DOM HUD are not tinted. Without `lighting` the
scene is untinted. The colour logic lives in pure functions
(`src/core/lighting.ts`, `src/iso/tint.ts`).

## Projection

Classic **2:1 dimetric**, tile diamond **64×32 px** (`src/iso/projection.ts`):

```
iso.x = (x - y) * 32
iso.y = (x + y) * 16
screen = iso * zoom + offset
```

World coordinates are continuous tile units; tile `(i, j)` covers
`[i, i+1)×[j, j+1)` and its diamond's top vertex is at `iso(i, j)`. Picking
inverts the projection and floors; a click on a raised block's top face
(drawn 32 px above its ground) picks the block.

- Flat tiles are drawn in a ground layer of 16×16-tile render chunks;
  chunks outside the viewport are hidden.
- Raised tiles and entities share an object layer with one container per
  diagonal `x + y`. Inside a diagonal, objects sort by `x + y`, then `x`,
  then entities after blocks. Moving entities use their interpolated
  position and change container when their diagonal changes, so only the
  containers whose contents changed are re-sorted.
- The sim runs at 10 ticks/s from an accumulator (at most 5 ticks per
  frame; any further backlog is dropped); every animation frame renders with
  interpolation, so walking is smooth and has constant speed.

## Sprites and placeholders

Tiles and archetypes may reference an asset (`sprite:`; see
[packs.md](packs.md#assets)). Tile sprites are anchored at the diamond's
bottom vertex, archetype sprites at the tile's ground centre. All assets
are loaded before the first frame; one that fails to load logs a warning
and falls back to its placeholder.

Without a sprite, a placeholder is generated once per definition entry from
its `color`:

- **flat tile** — a 64×32 diamond in the color;
- **raised tile** — a 32 px block: the top face in the color, the left and
  right faces darkened to 72 % and 55 %;
- **entity** — an upright rounded marker in the color with a drop shadow and
  the archetype's `glyph` drawn on it (dark or light text by luminance).

Colors are `#rrggbb` or the terminal color names (`bright_yellow`, …).
