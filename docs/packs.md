# Packs

A **pack** is a directory of YAML files that defines game content. The
engine has no genre knowledge: the zombie and vampire mini-games under
`packs/` are pure data on top of the same code.

```sh
npm run check -- packs/std packs/std-needs packs/zombie   # validate only
npm run play  -- packs/std packs/std-needs packs/zombie   # play in the terminal
npm run play  -- packs/std packs/vampire --seed 7
```

`check` also accepts a *library* stack with no `start` (e.g.
`npm run check -- packs/std packs/std-needs`): it validates the content and
reports it as not playable on its own. `play` still requires a `start`.

Packs are loaded in the order given. Keys: arrows / WASD / numpad /
`hjklyubn` move (8 directions), `q` quits. When the player has an
inventory, `g` takes everything that fits from every reachable container,
`1`–`9` use inventory stack N and `d` followed by `1`–`9` drops stack N (so
digits and `d` no longer move; arrows, `hjklyubn`, `w`/`a`/`s` and the
numpad with NumLock off still do). The same packs run in the
browser in isometric view: see [iso.md](iso.md).

Diagonal moves never cut corners: a diagonal step needs the target and
both orthogonal neighbours to be walkable (keyboard and click-to-move
alike).

## Layout

```
packs/zombie/
  pack.yaml            # manifest (required)
  archetypes.yaml      # any other *.yaml / *.yml file, at any depth
  assets.yaml
  assets/car_s.svg     # images referenced by the `assets` domain
  maps/town.yaml
  start.yaml
  clock.yaml
  survival.yaml        # statuses and systems
  items.yaml
  loot.yaml            # loot tables and distributions
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
| `items`        | list of entries |
| `loot`         | list of entries |
| `behaviors`    | list of entries |
| `distributions`| list (no ids)   |
| `start`        | one mapping     |
| `clock`        | one mapping     |
| `lighting`     | one mapping     |

## Manifest: `pack.yaml`

```yaml
namespace: zmb          # required, [a-z][a-z0-9_]*
name: Zombie Town       # required
version: 0.1.0          # required
depends: [std, std_needs]  # optional; each must be loaded earlier
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
    max: "max(10, self.std:hp / 2)"
    initial: 50
    rate: -0.8
```

### `assets`

Images used by the isometric renderer: a single image, or one image per
direction (no spritesheets or animation yet). Asset ids are namespaced and
referenced like any other id. For the conventions the shipped art follows,
see [art.md](art.md).

| Field        | Type                 | Default    | Notes |
|--------------|----------------------|------------|-------|
| `id`         | id                   | required   | |
| `file`       | path                 | —          | Relative to the pack root; must exist in the pack and end in `.svg` or `.png` |
| `directions` | facing → path or `{ file, anchor? }` | — | One image per drawn facing (see below) |
| `anchor`     | `[ax, ay]`           | `[0.5, 1]` | Normalized image point (each in `[0, 1]`) placed on the entry's anchor spot; shared by every direction |

An asset has **either** `file` **or** `directions` (both, or neither, is a
load error).

**Anchor conventions** (on the 64×32 tile diamond, see [iso.md](iso.md)):

- a **tile** sprite's anchor goes on the **bottom vertex** of the tile's
  diamond — with the default `[0.5, 1]`, a 64×32 image covers a flat tile
  exactly and a 64×64 image is a block rising 32 px above it;
- an **archetype** sprite's anchor goes on the tile's **ground centre** —
  with `[0.5, 1]` a character stands on the bottom edge of its image; use
  e.g. `[0.5, 0.92]` to put the feet a little higher (on a drop shadow).

**Facings.** Directions are named on the map compass (maps are drawn
north-up; `x` grows east, `y` grows south). On screen:

| Facing | Map step `(dx, dy)` | Screen direction | Mirror partner |
|--------|---------------------|------------------|----------------|
| `n`    | `( 0, −1)`          | up-right         | `w`            |
| `ne`   | `( 1, −1)`          | right            | `sw`           |
| `e`    | `( 1,  0)`          | down-right       | `s`            |
| `se`   | `( 1,  1)`          | down (toward the camera) | itself |
| `s`    | `( 0,  1)`          | down-left        | `e`            |
| `sw`   | `(−1,  1)`          | left             | `ne`           |
| `w`    | `(−1,  0)`          | up-left          | `n`            |
| `nw`   | `(−1, −1)`          | up (away from the camera) | itself |

The 4-way set is `n`, `e`, `s`, `w` (the four faces of the tile diamond);
the default facing is `s`.

**Directional assets.** `directions` maps facings to images. A value is a
path, or `{ file, anchor? }` whose `anchor` overrides the entry's. Every
file follows the `file` rules.

- If any diagonal (`ne`, `se`, `sw`, `nw`) is listed the asset is
  **8-way**, otherwise **4-way**.
- A missing facing uses its **mirror partner**'s image, flipped
  horizontally around the anchor spot; a listed facing is never mirrored.
  So the set must be complete under mirroring: a 4-way asset needs one of
  `n`/`w` and one of `e`/`s` (2 drawings); an 8-way asset also needs `se`,
  `nw` and one of `ne`/`sw` (5 drawings). Otherwise the load error names
  the facings that cannot be produced.
- Unknown keys and an empty mapping are load errors.

Which facing is shown depends on what references the asset: **tiles** use
their map cell's legend [`facing`](#maps) (so an 8-way asset on a tile only
shows `n`/`e`/`s`/`w`), **archetypes** face their movement direction, and
**ground piles** always show `s`. A 4-way asset showing a diagonal facing
snaps to a neighbouring cardinal (see [iso.md](iso.md#facing)).

```yaml
# packs/zombie/assets.yaml
assets:
  - id: car_img                # 4-way: n and e are mirrors of w and s
    directions:
      s: assets/car_s.svg      # 64×64 block
      w: assets/car_w.svg
  - id: shambler_img           # 8-way: n, e and sw are mirrored
    anchor: [0.5, 0.92]        # shared by every direction
    directions:
      s:  assets/shambler_s.svg
      se: assets/shambler_se.svg
      ne: assets/shambler_ne.svg
      w:  assets/shambler_w.svg
      nw: { file: assets/shambler_nw.svg, anchor: [0.5, 0.92] }

# packs/zombie/tiles.yaml
tiles:
  - { id: car, label: Wrecked car, glyph: "&", color: "#a33a2a", walkable: false, sprite: car_img }
```

Entries without a `sprite` get a placeholder generated from their `color`.
The ASCII renderer ignores sprites. The art of the shipped packs is pixel
art on a 2 px grid; [art.md](art.md) is its style guide (sizes, anchors,
shading, palettes and the generator).

### `tiles`

| Field      | Type             | Default      | Notes |
|------------|------------------|--------------|-------|
| `id`       | id               |              | |
| `label`    | string           |              | |
| `glyph`    | single character |              | ASCII renderer |
| `color`    | `#rrggbb` or name|              | e.g. `"#8a8a8a"`, `white`, `bright_yellow`; also the placeholder color |
| `walkable` | boolean          |              | |
| `raised`   | boolean          | `!walkable`  | Iso rendering only: a raised block, depth-sorted with entities, instead of flat ground. Walkability is unchanged |
| `opaque`   | boolean          | `!walkable`  | Blocks line of sight (`can_see`). Like `raised`, it defaults from `walkable` and an explicit value wins: a window is `walkable: false, opaque: false` |
| `sprite`   | asset id         | placeholder  | Anchored at the diamond's bottom vertex |
| `tags`     | list of `[a-z][a-z0-9_]*` | `[]` | Tested by `tile.has_tag("x")` / `has_tag(tile, "x")` |
| `container`| `{ capacity: <number ≥ 0> }` | none | Every map cell with this tile gets its own [container](#containers); its label is the tile's label |

Tile tags and archetype tags are separate: `self.has_tag("water")` never
sees the tags of the tile the entity stands on, and `tile.has_tag(...)`
never sees the entity's.

```yaml
tiles:
  - { id: tap, label: Water tap, glyph: "~", color: "#3b8eea", walkable: true, tags: [water] }
  - { id: fridge, label: Fridge, glyph: F, color: "#e8e8f0", walkable: false, container: { capacity: 25 } }
  - { id: crate, label: Crate, glyph: x, color: "#b08850", walkable: true, container: { capacity: 40 } }
```

Tile containers may be walkable (a floor crate you stand on) or not (a
fridge you walk up to).

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
| `inventory`      | `{ capacity, items? }` | none   | Every entity of the archetype gets its own inventory [container](#containers). `items` maps item id → count, filled in the order written; they must fit in `capacity` (load error otherwise) |
| `behavior`       | behavior id           | none    | The [behavior](#behaviors) driving every non-player entity of the archetype (short or qualified id) |

```yaml
archetypes:
  - id: shambler
    label: Shambler
    glyph: Z
    color: "#5fae3e"
    tags: [undead]
    measurements: [std:hp]
    initial: { hp: 40 }
  - id: survivor
    # …
    inventory:
      capacity: 15
      items: { water_bottle: 1, crackers: 1 }
```

Entities without `inventory` have none: expressions read `0`/`false` for
their items, and player actions fail with `no_inventory`.

### `maps`

ASCII maps are a fixture format for M0 (larger worlds will use Tiled).

| Field    | Type                         | Notes |
|----------|------------------------------|-------|
| `id`     | id                           | |
| `legend` | map char → `{ tile, spawn?, player?, facing? }` | `tile`: tile id; `spawn`: archetype id placed on that cell; `player: true` marks the player start (exactly one per start map); `facing`: orientation of the cell's tile (see below) |
| `rows`   | list of equal-length strings | every character must be in the legend |
| `rooms`  | list of `{ rect: [x, y, w, h], tags: [...] }` | optional; see below |

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

**Facing.** A legend entry may set `facing: n | e | s | w` (default `s`;
diagonals and other values are load errors) to orient the **tile** of its
cells in the iso view: a directional [asset](#assets) shows that facing,
and a placeholder draws a darker stripe on the edge it faces. Use one
legend character per orientation:

```yaml
      "&": { tile: car, facing: e }
      "%": { tile: car, facing: w }
      "F": { tile: fridge, facing: s }   # against a north wall
```

`facing` does not affect `spawn` or `player` (entities face their movement
direction, starting at `s`). It is static, render-only map data: not part
of world snapshots or hashes, and ignored by walkability, opacity,
containers, sight and the ASCII renderer.

**Rooms** are rectangles of cells with room tags (`kitchen`, `cellar`…).
A cell's room tags are the union of the tags of every rect that contains
it; rects may overlap. A rect must lie inside the map with `w, h ≥ 1`, and
`tags` must be a non-empty list of `[a-z][a-z0-9_]*`. Room tags are not
namespaced, and they are a third tag set, separate from tile and
archetype tags. Expressions test them with `tile.in_room("kitchen")`, and
[`distributions`](#distributions) use them to pick loot tables.

```yaml
    rooms:
      - { rect: [2, 2, 4, 3], tags: [kitchen] }
      - { rect: [7, 2, 2, 3], tags: [bathroom] }
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
| `{ type: noise, radius: <n or expr> }`                   | Emit a noise at `self`'s cell (see below) |

- An effect on a measurement the entity does not have is skipped.
- Each effect sees the values left by the effects before it, and by the
  systems before it on the same tick.
- Values are clamped once, at the clamp phase of the tick, not after each
  effect.

**Noise.** A `noise` effect emits one noise at `self`'s current cell, with
`self` as its source and `radius` (tiles, evaluated at emission time) as its
hearing radius. It takes no `measurement` and works on any entity. A radius
`<= 0` emits nothing. Noises are **events**, not a field over the map: in
the [hear phase](#tick-order) of the same tick, every entity other than the
source within `dx² + dy² <= radius²` hears it. **Walls are ignored.** Each
entity remembers only its **last heard noise**: the nearest of the tick
(ties go to the earlier emission), with the cell and the tick. Entities that
hear nothing keep their previous memory. Everyone hears, including the
player and entities without a behavior. Packs decide who reacts, with
[`heard(entity, seconds)`](expressions.md) in statuses and transitions and
the `investigate` [behavior](#behaviors) activity. Hearing costs
O(noises × entities) on ticks with noise and nothing on silent ticks.

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
  - id: crunch                     # broken glass is loud underfoot
    every: 0.2
    for: 'self.has_tag("living")'
    when: 'tile.has_tag("glass")'
    effects:
      - { type: noise, radius: 12 }
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

Statuses can react to sight with
[`can_see`](expressions.md#built-in-functions). A range pair gives the
hysteresis: notice at 8 tiles, lose track only past 12 or behind a wall.

```yaml
statuses:
  - id: alert
    label: Alert
    for: 'self.has_tag("undead")'
    when: 'can_see(self, player, 8)'
    until: 'not can_see(self, player, 12)'
```

### `behaviors`

A behavior is a declarative **state machine** that moves NPCs. Each state
runs one built-in **activity**, and **transitions** are ordinary
expressions. Archetypes opt in with `behavior: <id>`. Behaviors have their
own id space.

| Field     | Type                 | Default  | Notes |
|-----------|----------------------|----------|-------|
| `id`      | id                   | required | |
| `initial` | state name           | required | Must be a key of `states` |
| `states`  | mapping name → state | required | Non-empty; names match `[a-z][a-z0-9_]*` |

A **state**:

| Field     | Type                                  | Default | Notes |
|-----------|---------------------------------------|---------|-------|
| `do`      | `idle`, `wander`, `pursue`, `flee`, `home` or `investigate` | required | The activity |
| `target`  | expression (entity or tile)           | —       | Required for `pursue`/`flee`, a load error elsewhere. Evaluated with `self` = the entity, e.g. `player` |
| `radius`  | integer ≥ 0                           | none    | `wander` only: maximum Chebyshev distance from home. Omitted = unbounded |
| `repath`  | sim seconds, whole ticks, > 0         | `1`     | `pursue`/`investigate` only: minimum interval between A* re-plans |
| `on`      | list of `{ when: expr, to: state }`   | `[]`    | Checked in order; the first truthy `when` wins |
| `timeout` | `{ after: sim seconds, to: state }`   | none    | Fires once the entity has been in the state for `after` seconds (whole ticks, > 0) |
| `done`    | state name                            | none    | `home`/`investigate` only: the state to switch to once arrived, or when the path fails |

Every `to`, `done` and `initial` must name a state of the same behavior.
Unknown fields and misplaced `target`/`radius`/`repath`/`done` are load
errors.

Each entity has a **home**: its spawn cell. Behaviors run in the **think**
phase (phase 0 of the [tick](#tick-order)), once per behavior-driven entity
in ascending id order:

1. **Transitions**: the current state's `on` entries in order, then its
   `timeout`, then `done`. The first that fires switches state, clears the
   entity's path and pending intent, and restarts the state's timer. **At
   most one transition per entity per tick**; the new state's activity runs
   in the same tick.
2. **Activity**: it may set the entity's pending movement intent, which
   phase 1 applies like any queued intent (walls, corners,
   `ticks_per_step`, A*). An activity never moves the entity directly.

Entities on a step cooldown still check transitions. A "ready" entity is
one whose next step fires in this tick (`moveCooldown ≤ 1`).

| Activity | Semantics |
|----------|-----------|
| `idle`   | Does nothing (an existing path or intent is kept). |
| `wander` | When ready and without a path: one draw from the world RNG picks one of 8 directions or "stay". The step is issued only if it is allowed and ends within `radius` of home; otherwise the entity stays this tick. No draw when not ready. |
| `pursue` | Evaluates `target` to a cell. If the entity is on it or 8-adjacent, it clears its path and waits. Otherwise it queues `goto` (with `adjacent: true`) on entering the state, and later when at least `repath` has passed since its last plan **and** it has no path or the target cell has moved. At most one A* per `repath` window; an unreachable target (`lastGoto.ok == false`) waits for the next window. |
| `flee`   | When ready: among the allowed neighbour steps, the one that maximizes the squared distance to `target`, only if it **strictly** increases it; ties go to the first in the order N, NE, E, SE, S, SW, W, NW. Nothing when cornered. No RNG, no A*. |
| `home`   | Once per entry into the state: a `goto` to the home cell (nothing if already there). `done` fires on a later tick once the entity is home, or when that goto failed. Without `done` the entity idles at home. |
| `investigate` | Walks to the entity's last heard [noise](#systems) cell; takes no `target`. Never heard anything: does nothing. On or 8-adjacent to the heard cell: clears its path and waits. Otherwise it queues `goto` (with `adjacent: true`) when it has not issued one yet in this state, or when the heard cell changed since its last plan and at least `repath` has passed, so a newer noise retargets the walk without a self-transition. `done` fires on a later tick than the plan once the entity is on or adjacent to the heard cell, when the last goto failed, or when it has never heard a noise. |

- The **player** is never driven by a behavior, even if its archetype has
  one; it stays under input control.
- Only `wander` draws from the world RNG, in id order, so runs stay
  deterministic. Behavior state (`home`, current state and since when, the
  last planned goto) is part of `snapshot()` and `hash()`.
- Queued intents on a behavior-driven entity may be overwritten by its
  activity.
- Transitions see the statuses computed at the end of the previous tick.

```yaml
behaviors:
  - id: shambler
    initial: wander
    states:
      wander:
        do: wander
        radius: 6
        on:
          - { when: 'self.has_status("alert")', to: chase }
      chase:
        do: pursue
        target: player
        on:
          - { when: 'not self.has_status("alert")', to: search }
      search:
        do: idle
        on:
          - { when: 'self.has_status("alert")', to: chase }
          - { when: 'heard(self, 1)', to: investigate }
        timeout: { after: 5, to: wander }
      investigate:                 # sight beats sound: `alert` is checked first
        do: investigate
        on:
          - { when: 'self.has_status("alert")', to: chase }
        done: search

archetypes:
  - id: shambler
    # …
    behavior: shambler
```

### `items`

Item kinds. Items are **plain data inside containers**, not entities: a
container holds stacks `{ item, count }`.

| Field    | Type                      | Default     | Notes |
|----------|---------------------------|-------------|-------|
| `id`     | id                        | required    | Own id space |
| `label`  | string                    | required    | |
| `glyph`, `color` | as for tiles      | required    | ASCII ground piles; iso placeholder colour |
| `weight` | number ≥ 0                | required    | Per unit; rounded to 0.01 |
| `tags`   | list of `[a-z][a-z0-9_]*` | `[]`        | Item tags (separate from tile, room and archetype tags) |
| `sprite` | asset id                  | placeholder | Iso ground-pile sprite, anchored at the tile's ground centre |
| `use`    | mapping                   | none        | Items without `use` cannot be used |

`use` is `{ label?, when?, effects, consume? }`:

- `label` — the verb shown in the UI, `"Use"` by default;
- `when` — an optional condition with `self` = the user; when falsy the
  use fails with `cannot_use`;
- `effects` — a non-empty list of `apply`/`set`/`noise` effects on `self`,
  exactly as in [`systems`](#systems). They run immediately, in order, and
  see each other's results; values are clamped at the next clamp phase. A
  `noise` effect is emitted only when the use succeeds (e.g. an alarm clock
  with `consume: 0`);
- `consume` — units removed per use, a non-negative integer (default `1`;
  `0` makes the item reusable).

```yaml
items:
  - id: canned_beans
    label: Canned beans
    glyph: "%"
    color: "#c9a227"
    weight: 0.4
    tags: [food]
    use:
      label: Eat
      effects:
        - { type: apply, measurement: hunger, delta: -35 }
  - { id: toaster, label: Toaster, glyph: "]", color: "#a0a0a0", weight: 3 }
```

### Containers

A container holds items up to a weight **capacity**. There are three
kinds:

- **tile** containers — one per map cell whose tile has `container`;
- **inventories** — one per entity whose archetype has `inventory`;
- **ground piles** — created when the player drops items on a cell with
  no pile yet; unlimited capacity; removed when they become empty.

Contents are an ordered list of stacks with **at most one stack per item**:
adding an item already present grows its stack, a new item is appended,
and a stack that reaches 0 is removed. Weight is the only limit (no slot
or stack limits).

Weights and capacities are rounded to 0.01 at load and the simulation
sums and compares them as integer **hundredths**, so `0.1 × 3` fits a
capacity of `0.3` exactly. A container's load is Σ `weight × count`; a
move into it is allowed only if the load stays ≤ `capacity`. Expressions
and the HUD show weights in normal units.

Containers get sequential integer ids that are never reused: tile
containers in row-major cell order, then inventories in entity order;
ground piles get the next id when they are created. Containers are
simulation state (`snapshot().containers`, covered by `hash()`) and do no
per-tick work.

### `loot`

Loot tables fill tile containers when the world is created.

```yaml
loot:
  - id: kitchen_food
    rolls: [1, 3]                    # integer, or [min, max] inclusive
    entries:
      - { item: canned_beans, weight: 3, count: [1, 2] }
      - { item: water_bottle, weight: 2 }       # count defaults to 1
      - { table: junk, weight: 1 }             # nested table, rolled once
      - { nothing: true, weight: 2 }
```

| Field     | Type                          | Default  | Notes |
|-----------|-------------------------------|----------|-------|
| `id`      | id                            | required | Own id space |
| `rolls`   | integer ≥ 0 or `[min, max]`   | `1`      | Number of picks |
| `entries` | list                          | required | Non-empty |

Each roll picks one entry with probability proportional to its `weight`
(a positive integer, default `1`). An entry is **exactly one** of
`item: <id>`, `table: <loot id>` or `nothing: true`. `count` (an integer
or `[min, max]`, both ≥ 1, default `1`) is only allowed on `item` entries.
A nested `table` is rolled once, with its own `rolls`. Cycles between
tables are a load error.

### `distributions`

Which loot table fills which tile container. A plain list without ids:

```yaml
distributions:
  - { container: cupboard, room: kitchen, table: kitchen_food }
  - { container: cupboard, table: bedroom_stuff }
  - { container: car, table: glovebox }
```

- `container` — a tile id; the tile must have `container`;
- `room` — optional room tag;
- `table` — a loot table id.

Each tile container takes the **first most specific** match: an entry
whose `room` is one of the cell's room tags beats an entry without
`room`; ties go to the first entry in definition order. A container with
no match starts empty.

**Loot generation** happens once, in the `World` constructor, over tile
containers in row-major order, with a **dedicated RNG** derived from the
world seed: it never touches the world RNG, so movement and `random()`
sequences are the same as without loot. The same definition and seed
always give the same contents. Items that do not fit a container are
dropped silently; the loader **warns** (without failing) when a table's
maximum possible weight exceeds the capacity of a container it is
distributed to.

### Actions

The shells change containers through instant player **actions**, queued
with `world.queueAction(action)`. This queue is separate from movement
intents, so looting never cancels walking.

| Kind   | Fields                                  | Effect |
|--------|-----------------------------------------|--------|
| `take` | `container`, `item`, `count?` (default all) | Container → player inventory |
| `put`  | `container`, `item`, `count?`           | Player inventory → container |
| `drop` | `item`, `count?`                        | Player inventory → the ground pile on the player's cell (created if missing) |
| `use`  | `item`                                  | Runs the item's `use`, then removes `consume` units |

- `container` is a numeric container id (`world.containersAt(x, y)`,
  `world.reachableContainers()`); `item` is a qualified item id.
- **Reach:** the container's cell must be the player's cell or one of the
  8 around it. Inventories cannot be targeted by `take`/`put`.
- `take`/`put` move as many units as fit, up to `count`; moving 0 units is
  a failure.
- Every action records `world.lastAction`:
  `{ kind, item, moved, ok, reason?, tick }`, where `reason` is one of
  `out_of_reach`, `too_heavy`, `missing`, `cannot_use`, `no_inventory` or
  `unknown_container`.
- Pending actions and `lastAction` are part of `snapshot()`. After defeat
  `queueAction` ignores its input.

A `goto` intent with `adjacent: true` ends on the reachable walkable tile
8-adjacent to the goal (or the goal itself, if walkable) with the shortest
path; the browser uses it when you click a non-walkable container.

Movement intents (`step` and `goto`) are queued with
`world.queueIntent(intent, entity?)`; `entity` defaults to the player, and
an entity of another world throws. Each entity keeps its own pending
`intent` and `lastGoto` (both in its snapshot); `world.lastGoto` is the
player's. Entities do not block each other. The shells drive the player; NPCs
are driven by their archetype's [behavior](#behaviors).

### Tick order

`World.step()` runs these phases in order:

0. **think**: [behaviors](#behaviors) switch state (at most once) and
   issue movement intents, in ascending id order (the player is skipped);
1. apply **each entity's** movement intent, in ascending id order (the
   player is id 0), then the queued (player) actions, in FIFO order;
2. measurement drift: `rate` plus the `rates` of the statuses active at the
   **start** of the tick;
3. systems that are due, in definition order;
4. **hear**: skipped when no noise was emitted this tick; otherwise each
   entity records the nearest noise it heard (see [noise](#systems)).
   Noises are emitted in order: player actions (phase 1), then systems
   (definition order, entity order). `world.noises` lists this tick's
   noises until the next tick starts;
5. clamp every measurement to `[min, max]`;
6. status update: every `for`/`when`/`until` sees the statuses as they were
   at the start of this phase, so status definition order does not matter;
7. defeat check (see `start.defeat`);
8. `tick++`.

Statuses are also evaluated once when the world is created, after the
initial clamp. So a status entered on tick *t* first changes drift on tick
*t + 1*. Likewise, statuses see a noise in the tick it is emitted, and
behavior transitions see it in the next tick's think phase.

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
pack, not in a stdpack.

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

## Standard packs

The **stdpack** is a set of optional packs with generic content that many
games share. A game lists the ones it wants before its own pack. Following
VISION decision 8, the stdpack uses nothing a third-party pack could not:
it is plain YAML on the same loader, and the engine never names its ids.

| Pack (directory) | Namespace   | Depends | Contents |
|------------------|-------------|---------|----------|
| `std`            | `std`       | —       | measurement `hp` (Health, 0–100); archetype `humanoid`; tiles `floor`, `wall`, `door` |
| `std-needs`      | `std_needs` | `std`   | measurements `hunger`, `thirst`, `fatigue`; statuses `hungry`, `thirsty`, `exhausted` (drain `hp`), `burdened` (carrying ≥ 80% of capacity adds fatigue) |

**Opting in to needs.** An entity takes part in `std-needs` by listing the
measurements in its archetype and carrying the `living` tag, which every
need status tests in its `for` filter:

```yaml
archetypes:
  - id: survivor
    tags: [humanoid, living]
    measurements: [hp, hunger, thirst, fatigue]
```

An entity without the tag or the measurements is unaffected. What the
needs *do* beyond those statuses (sleeping in a bed, collapsing when
starved, food items) stays in the genre pack: `zombie` depends on
`[std, std_needs]` and adds its own systems, while `vampire` depends on
`[std]` only. More stdpacks are added as genres repeat patterns.

## Namespaces and references

- Namespaces and local ids match `[a-z][a-z0-9_]*`.
- **Definitions** may write a short id (`survivor`) — the loader prefixes
  the pack's namespace (`zmb:survivor`) — or a qualified id, which must use
  the pack's own namespace.
- **References** (in fields such as `measurements`, `tile`, `spawn`,
  `start.map`, and in expressions) may be qualified (`std:hp`) or short.
  A short reference resolves to the referencing pack's own namespace
  first, else to the **unique** match among the packs it directly
  `depends` on. Ambiguous or missing references are load errors;
  qualify to disambiguate.
- A qualified reference must name the pack's own namespace or one of its
  `depends`.
- Each kind (measurements, assets, tiles, archetypes, maps, systems,
  statuses, items, loot tables) has its own id space. Tags (tile,
  archetype, item and room tags) are not namespaced.
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
For M3 content it checks: negative weights or capacities; unknown item,
loot table, tile or room tag references (with suggestions); `use` with
empty `effects` or a negative or non-integer `consume`; a starting
inventory over its capacity; room rects out of bounds or empty, and empty
room tags; loot entries that are not exactly one of `item`/`table`/
`nothing`, non-positive or non-integer entry weights, bad `rolls`/`count`
ranges, `count` on a non-item entry, and table cycles; `distributions`
whose `container` tile has no `container`; and non-literal ids in
`count_item`/`has_item`/`in_room`. For M4 content: `noise` effects without
`radius`, with a `measurement` or another unknown field, or with a
non-numeric `radius`; `target` on `investigate`; and `done` outside
`home`/`investigate`. Warnings (e.g. a loot table that can
exceed a container's capacity) are printed but do not fail the load.
A successful load returns an immutable, fully
resolved definition (ids → indices, expressions → closures).

## Engine layout

- `src/core/` — platform-free simulation core: `expr/` (lexer, parser,
  compiler), `load/` (pack parsing, namespaces, validation), `clock.ts`
  (in-game calendar derived from the tick), `lighting.ts` (`tintAt`),
  `hud.ts` (renderer-independent HUD model), `sim/`
  (world, grid, RNG, A*, containers). No Node built-ins, DOM or Pixi.
- `src/node/read-pack.ts` — reads a pack directory into
  `{ relativePath: text }` (plus the names of its other files) for the
  loader.
- `src/iso/` — Pixi isometric renderer: projection, depth buckets,
  camera, textures and placeholders.
- `src/web/` — browser shell: pack loading via Vite, input, HUD,
  inventory/loot panels (`panels.ts`, `I`/`Tab` toggles the inventory),
  error screen, `main.ts`.
- `src/ascii/` — pure ASCII renderer and the terminal shell.
- `src/cli/` — `play` and `check`.
