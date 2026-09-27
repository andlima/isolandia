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
  clock.yaml
  survival.yaml        # statuses and systems
  lighting.yaml
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
| `systems`      | list of entries |
| `statuses`     | list of entries |
| `start`        | one mapping     |
| `clock`        | one mapping     |
| `lighting`     | one mapping     |

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
| `tags`     | list of `[a-z][a-z0-9_]*` | `[]` | Tested by `tile.has_tag("x")` / `has_tag(tile, "x")` |

Tile tags and archetype tags are separate: `self.has_tag("water")` never
sees the tags of the tile the entity stands on, and `tile.has_tag(...)`
never sees the entity's.

```yaml
tiles:
  - { id: tap, label: Water tap, glyph: "~", color: "#3b8eea", walkable: true, tags: [water] }
```

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

### `systems`

Periodic rules that run on their own. Each system runs **once per entity**
when it is due.

| Field     | Type                 | Default          | Notes |
|-----------|----------------------|------------------|-------|
| `id`      | id                   | required         | Own id space |
| `every`   | number (sim seconds) | `0.1` (each tick)| Must be > 0 and a whole number of ticks (`every × 10` an integer); converted to ticks at load |
| `for`     | expression           | `true`           | Entity filter |
| `when`    | expression           | `true`           | Extra condition, evaluated only when `for` holds |
| `effects` | list                 | required         | Non-empty; see below |

A system with a period of *n* ticks fires on every tick *t* where
`(t + 1) % n == 0`, so it first fires after `every` seconds. For each
entity, in entity order, it runs its effects when `for` and then `when`
are truthy, with `self` = that entity and `tile` = the tile under it.
Systems run in definition order: pack load order, then the order of
entries within the pack. A system that is not due costs nothing.

**Effects** act on `self`:

| Effect                                                  | Meaning |
|---------------------------------------------------------|---------|
| `{ type: apply, measurement: <id>, delta: <n or expr> }` | Add `delta` to the measurement |
| `{ type: set, measurement: <id>, value: <n or expr> }`   | Replace the measurement's value |

- An effect on a measurement the entity does not have is skipped.
- Each effect sees the values left by the effects before it, and by the
  systems before it on the same tick.
- Values are clamped once, at the clamp phase of the tick, not after each
  effect.

```yaml
systems:
  - id: drink
    every: 1                       # once per sim second
    for: 'self.has_tag("living")'
    when: 'tile.has_tag("water")'
    effects:
      - { type: apply, measurement: thirst, delta: -8 }
  - id: collapse
    every: 5
    when: "self.hunger >= 100"
    effects:
      - { type: apply, measurement: hp, delta: -3 }
```

### `statuses`

Derived states such as *Hungry* or *Sunburnt*. They enter and exit on
conditions and add drift while active.

| Field   | Type       | Default    | Notes |
|---------|------------|------------|-------|
| `id`    | id         | required   | Own id space |
| `label` | string     | required   | Shown in the HUD |
| `for`   | expression | `true`     | Which entities can have the status |
| `when`  | expression | required   | Enter condition |
| `until` | expression | `not when` | Exit condition (use it for hysteresis) |
| `rates` | map measurement id → number or expression | `{}` | Extra drift **per sim second** while active |

- An inactive status becomes active when `for` and `when` are truthy.
- An active status becomes inactive when `until` is truthy or `for`
  becomes falsy.
- While active, each `rates` entry is added to that measurement's `rate`
  (entries for measurements the entity lacks are ignored). Constant rates
  are folded at load time, as for `rate`.
- Expressions test statuses with `has_status(entity, "id")` or
  `self.has_status("id")` (see [expressions](expressions.md#functions)).
- Active statuses are simulation state: they are part of `snapshot()` and
  `hash()`.

```yaml
statuses:
  - id: hungry
    label: Hungry
    for: 'self.has_tag("living")'
    when: "self.hunger >= 70"
    until: "self.hunger < 40"      # stays hungry until well fed
    rates: { hp: -0.2 }
```

### Tick order

`World.step()` runs these phases in order:

1. apply the player's intent (movement);
2. measurement drift: `rate` plus the `rates` of the statuses active at the
   **start** of the tick;
3. systems that are due, in definition order;
4. clamp every measurement to `[min, max]`;
5. status update: every `for`/`when`/`until` sees the statuses as they were
   at the start of this phase, so status definition order does not matter;
6. defeat check (see `start.defeat`);
7. `tick++`.

Statuses are also evaluated once when the world is created, after the
initial clamp. So a status entered on tick *t* first changes drift on tick
*t + 1*.

### `start`

```yaml
start:
  map: town           # map id
  player: survivor    # archetype id
  defeat:             # optional
    when: "self.hp <= 0"
    message: "You did not survive the outbreak."
```

Exactly one `start` must exist across all loaded packs. Typically the last
(game) pack defines it; loading two game packs that both define `start`
is an error.

`defeat` ends the game: its `when` expression is evaluated at the end of
each tick with `self` = the player. When it becomes truthy the world
records the defeat (tick and `message`, which defaults to `"Game over"`),
the HUD shows it, and from then on the simulation is frozen and player
input is ignored. Without `defeat` the game never ends.

### `clock`

The in-game calendar. Game time is derived from the tick count, so the
clock adds no simulation state; expressions read it through `world.day`,
`world.hour`, `world.is_day` and friends (see
[expressions](expressions.md#scope)), and the HUD shows `Day D HH:MM`.

| Field        | Type             | Default   | Notes |
|--------------|------------------|-----------|-------|
| `day_length` | number (seconds) | `1440`    | Sim seconds per in-game day; must be > 0. `1440` means 1 sim second = 1 game minute (a day lasts 24 real minutes) |
| `start`      | `"HH:MM"`        | `"08:00"` | Time of day at tick 0, on day 1 |
| `dawn`       | `"HH:MM"`        | `"06:00"` | Daylight starts (inclusive) |
| `dusk`       | `"HH:MM"`        | `"20:00"` | Daylight ends (exclusive); must be after `dawn` |

Times are 24-hour `HH:MM` strings (`00:00`–`23:59`); quote them in YAML.
Daylight does not wrap past midnight.

```yaml
# packs/vampire/content.yaml
clock:
  start: "20:00"      # the game begins at dusk (night)
```

**At most one** loaded pack may define `clock`; a second definition is an
error naming the first pack (override semantics come in M7). If no pack
defines it, the defaults above apply. Like `start`, it belongs in the game
pack, not in a shared base pack.

### `lighting`

A day/night tint for the isometric view. It is **visual only**: the
simulation and expressions never see it, and the ASCII renderer ignores it.

```yaml
lighting:
  tint:
    - { at: "05:00", color: "#3a4a80" }
    - { at: "07:00", color: "#ffffff" }
    - { at: "19:00", color: "#ffd9b0" }
    - { at: "21:00", color: "#3a4a80" }
```

`tint` is a non-empty list of keyframes: `at` is an `"HH:MM"` time of day
and `color` a `#rrggbb` value (no duplicate times; order does not matter).
The colour is interpolated linearly in RGB between consecutive keyframes
and wraps around midnight from the last keyframe back to the first; a
single keyframe gives a constant tint. The scene's ground and objects are
multiplied by it (`#ffffff` = unchanged). Without `lighting` nothing is
tinted. Like `clock`, **at most one** loaded pack may define it.

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
- Each kind (measurements, assets, tiles, archetypes, maps, systems,
  statuses) has its own id space.
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
or duplicate `start`, a duplicate or malformed `clock` (non-positive
`day_length`, times that aren't `HH:MM`, `dawn` not before `dusk`), and assets: missing files (with suggestions),
unsupported extensions, malformed or out-of-range anchors, and unknown
`sprite` references. For M2 content it also checks: `every` that is not
positive or not a whole number of ticks; empty `effects`; unknown effect
types or fields; effects missing `measurement`/`delta`/`value`; unknown
measurements in effects or `rates` keys (with suggestions); conditions
(`for`/`when`/`until`/`defeat.when`) that evaluate to an entity or tile;
non-numeric `delta`/`value`/`rates`; `has_status` with a non-literal or
unknown id; malformed tile tags; and `lighting` problems (empty `tint`,
malformed times or colours, duplicate `at`, a second pack defining it).
A successful load returns an immutable, fully
resolved definition (ids → indices, expressions → closures).

## Engine layout

- `src/core/` — platform-free simulation core: `expr/` (lexer, parser,
  compiler), `load/` (pack parsing, namespaces, validation), `clock.ts`
  (in-game calendar derived from the tick), `lighting.ts` (`tintAt`),
  `hud.ts` (renderer-independent HUD model), `sim/`
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
