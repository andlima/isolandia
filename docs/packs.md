# Packs

A **pack** is a directory of YAML files that defines game content. The
engine has no genre knowledge: the zombie and vampire mini-games under
`packs/` are pure data on top of the same code.

```sh
npm run check -- packs/base packs/zombie        # validate only
npm run play  -- packs/base packs/zombie        # play in the terminal
npm run play  -- packs/base packs/vampire --seed 7
```

Packs are loaded in the order given. Keys: arrows / WASD / numpad /
`hjklyubn` move (8 directions), `q` quits. The same packs run in the
browser in isometric view: see [iso.md](iso.md).

Diagonal moves never cut corners: a diagonal step needs the target and
both orthogonal neighbours to be walkable (keyboard and click-to-move
alike).

## Layout

```
packs/zombie/
  pack.yaml            # manifest (required)
  needs.yaml           # any other *.yaml / *.yml file, at any depth
  archetypes.yaml
  assets.yaml
  assets/car.svg       # images referenced by the `assets` domain
  maps/town.yaml
  start.yaml
```

File names and layout are free. Each content file holds one or more
top-level **domain keys**; entries from all files of a pack are merged per
domain. Any other top-level key is a load error.

| Domain key     | Shape           |
|----------------|-----------------|
| `measurements` | list of entries |
| `assets`       | list of entries |
| `tiles`        | list of entries |
| `archetypes`   | list of entries |
| `maps`         | list of entries |
| `start`        | one mapping     |

## Manifest: `pack.yaml`

```yaml
namespace: zmb          # required, [a-z][a-z0-9_]*
name: Zombie Town       # required
version: 0.1.0          # required
depends: [base]         # optional; each must be loaded earlier
```

## Domains

### `measurements`

Generic numeric values (health, hunger, blood, suspicion…).

| Field     | Type                                  | Default    | Notes |
|-----------|---------------------------------------|------------|-------|
| `id`      | id                                    | required   | |
| `label`   | string                                | required   | Shown in the HUD |
| `min`     | number                                | `0`        | |
| `max`     | number, measurement id, or expression | unbounded  | Evaluated per entity |
| `initial` | number                                | required   | Default starting value |
| `rate`    | number or expression                  | none       | Drift **per second** |

Each tick (10 ticks/s) every entity gets `rate / 10` added to each of its
measurements; then all values are clamped to `[min, max]`. A numeric
`rate` costs nothing per tick beyond the addition. When `max` is a bare
measurement id it means *this entity's value of that measurement*
(`max: max_hp`); otherwise it is an [expression](expressions.md):

```yaml
measurements:
  - id: blood
    label: Blood
    max: "max(10, self.base:hp / 2)"
    initial: 50
    rate: -0.8
```

### `assets`

Single images used by the isometric renderer (no spritesheets or
animation yet). Asset ids are namespaced and referenced like any other id.

| Field    | Type                 | Default    | Notes |
|----------|----------------------|------------|-------|
| `id`     | id                   | required   | |
| `file`   | path                 | required   | Relative to the pack root; must exist in the pack and end in `.svg` or `.png` |
| `anchor` | `[ax, ay]`           | `[0.5, 1]` | Normalized image point (each in `[0, 1]`) placed on the entry's anchor spot |

**Anchor conventions** (on the 64×32 tile diamond, see [iso.md](iso.md)):

- a **tile** sprite's anchor goes on the **bottom vertex** of the tile's
  diamond — with the default `[0.5, 1]`, a 64×32 image covers a flat tile
  exactly and a 64×64 image is a block rising 32 px above it;
- an **archetype** sprite's anchor goes on the tile's **ground centre** —
  with `[0.5, 1]` a character stands on the bottom edge of its image; use
  e.g. `[0.5, 0.92]` to put the feet a little higher (on a drop shadow).

```yaml
# packs/zombie/assets.yaml
assets:
  - id: car_img
    file: assets/car.svg       # 64×64 block
  - id: shambler_img
    file: assets/shambler.svg  # 32×48 character
    anchor: [0.5, 0.92]

# packs/zombie/tiles.yaml
tiles:
  - { id: car, label: Wrecked car, glyph: "&", color: "#a33a2a", walkable: false, sprite: car_img }
```

Entries without a `sprite` get a placeholder generated from their `color`.
The ASCII renderer ignores sprites.

### `tiles`

| Field      | Type             | Default      | Notes |
|------------|------------------|--------------|-------|
| `id`       | id               |              | |
| `label`    | string           |              | |
| `glyph`    | single character |              | ASCII renderer |
| `color`    | `#rrggbb` or name|              | e.g. `"#8a8a8a"`, `white`, `bright_yellow`; also the placeholder color |
| `walkable` | boolean          |              | |
| `raised`   | boolean          | `!walkable`  | Iso rendering only: a raised block, depth-sorted with entities, instead of flat ground. Walkability is unchanged |
| `sprite`   | asset id         | placeholder  | Anchored at the diamond's bottom vertex |

### `archetypes`

Templates for entities (the player and everything else).

| Field            | Type                  | Default | Notes |
|------------------|-----------------------|---------|-------|
| `id`             | id                    |         | |
| `label`          | string                |         | |
| `glyph`, `color` | as for tiles          |         | |
| `tags`           | list of `[a-z][a-z0-9_]*` | `[]` | Tested by `has_tag` |
| `measurements`   | list of measurement ids | `[]`  | Which measurements the entity has |
| `initial`        | map id → number       |         | Overrides a measurement's `initial` |
| `ticks_per_step` | positive integer      | `2`     | Movement speed (ticks per tile) |
| `sprite`         | asset id              | placeholder | Anchored at the tile's ground centre |

```yaml
archetypes:
  - id: shambler
    label: Shambler
    glyph: Z
    color: "#5fae3e"
    tags: [undead]
    measurements: [base:hp]
    initial: { hp: 40 }
```

### `maps`

ASCII maps are a fixture format for M0 (larger worlds will use Tiled).

| Field    | Type                         | Notes |
|----------|------------------------------|-------|
| `id`     | id                           | |
| `legend` | map char → `{ tile, spawn?, player? }` | `tile`: tile id; `spawn`: archetype id placed on that cell; `player: true` marks the player start (exactly one per start map) |
| `rows`   | list of equal-length strings | every character must be in the legend |

```yaml
maps:
  - id: town
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: road, player: true }
      "Z": { tile: road, spawn: shambler }
    rows:
      - "#####"
      - "#.@Z#"
      - "#####"
```

### `start`

```yaml
start:
  map: town           # map id
  player: survivor    # archetype id
```

Exactly one `start` must exist across all loaded packs. Typically the last
(game) pack defines it; loading two game packs that both define `start`
is an error.

## Namespaces and references

- Namespaces and local ids match `[a-z][a-z0-9_]*`.
- **Definitions** may write a short id (`hunger`) — the loader prefixes
  the pack's namespace (`zmb:hunger`) — or a qualified id, which must use
  the pack's own namespace.
- **References** (in fields such as `measurements`, `tile`, `spawn`,
  `start.map`, and in expressions) may be qualified (`base:hp`) or short.
  A short reference resolves to the referencing pack's own namespace
  first, else to the **unique** match among the packs it directly
  `depends` on. Ambiguous or missing references are load errors;
  qualify to disambiguate.
- A qualified reference must name the pack's own namespace or one of its
  `depends`.
- Each kind (measurements, tiles, archetypes, maps) has its own id space.
- Redefining an existing id is an error — overrides come in M7.

## Validation

The loader collects **every** error before failing; each names the pack,
file, line and YAML key path:

```
zmb archetypes.yaml:6 archetypes[0].measurements[1]: unknown measurement 'hungr' (did you mean 'hunger'?)
```

It checks YAML syntax, unknown top-level keys and fields, required fields
and types, id syntax, duplicate ids, unknown/ambiguous references (with
Levenshtein ≤ 2 suggestions), expression syntax and names, ragged map
rows, characters missing from the legend, unmet `depends`, a missing
or duplicate `start`, and assets: missing files (with suggestions),
unsupported extensions, malformed or out-of-range anchors, and unknown
`sprite` references. A successful load returns an immutable, fully
resolved definition (ids → indices, expressions → closures).

## Engine layout

- `src/core/` — platform-free simulation core: `expr/` (lexer, parser,
  compiler), `load/` (pack parsing, namespaces, validation), `sim/`
  (world, grid, RNG). No Node built-ins, DOM or Pixi.
- `src/node/read-pack.ts` — reads a pack directory into
  `{ relativePath: text }` (plus the names of its other files) for the
  loader.
- `src/iso/` — Pixi isometric renderer: projection, depth buckets,
  camera, textures and placeholders.
- `src/web/` — browser shell: pack loading via Vite, input, HUD, error
  screen, `main.ts`.
- `src/ascii/` — pure ASCII renderer and the terminal shell.
- `src/cli/` — `play` and `check`.
