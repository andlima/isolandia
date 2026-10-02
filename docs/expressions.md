# Expression language

A small, pure expression language used in pack fields such as a
measurement's `max` and `rate`, system and status conditions, effect
values, status `rates` and `start.defeat.when`. Ported from rogue-engine, with three
changes: expressions are **compiled at load time**, identifiers can be
**namespaced**, and `/` is **float** division.

Expressions are **pure**: they read state and never mutate it.

## Grammar

```
expr        = or_expr
or_expr     = and_expr ("or" and_expr)*
and_expr    = not_expr ("and" not_expr)*
not_expr    = "not" not_expr | comparison
comparison  = addition (("==" | "!=" | "<=" | ">=" | "<" | ">") addition)?
addition    = multiply (("+" | "-") multiply)*
multiply    = unary (("*" | "/" | "%") unary)*
unary       = "-" unary | postfix
postfix     = primary ( "(" args ")" | "." IDENT )*
primary     = NUMBER | STRING | "true" | "false" | IDENT | "(" expr ")"
IDENT       = [A-Za-z_][A-Za-z0-9_]* ( ":" [A-Za-z_][A-Za-z0-9_]* )?
```

Precedence, lowest to highest: `or`, `and`, `not`, comparisons,
`+ -`, `* / %`, unary `-`, calls and member access. Comparisons do not
chain (`a < b < c` is a syntax error).

### Literals

| Type    | Examples              |
|---------|-----------------------|
| Number  | `42`, `3.14`, `.5`    |
| String  | `"hello"`, `'world'`  |
| Boolean | `true`, `false`       |

### Operators

| Op                         | Meaning                                                   |
|----------------------------|-----------------------------------------------------------|
| `+ - *`                    | Arithmetic                                                |
| `/`                        | **Float** division (`7 / 2` is `3.5`)                     |
| `%`                        | Remainder (JavaScript semantics)                          |
| `== !=`                    | Strict equality                                           |
| `< <= > >=`                | Numeric comparison                                        |
| `and or not`               | Short-circuit booleans; `and`/`or` return an operand      |

Division or modulo by zero returns `0` and records a warning
(`Division by zero` / `Modulo by zero`) on the world instead of crashing.

Booleans may be used in arithmetic (`true` is 1), which is handy for
thresholds: `0.6 + 0.4 * (self.hunger >= 50)`. Using an entity, tile or
string in arithmetic is a load error.

## Scope

| Name     | Type   | Meaning                                                       |
|----------|--------|---------------------------------------------------------------|
| `self`   | entity | The entity the expression is evaluated for                    |
| `player` | entity | The player entity                                             |
| `tile`   | tile   | The tile under `self`: `tile.x`, `tile.y`, `tile.id`, `tile.has_tag("x")`, `tile.in_room("x")` |
| `world`  | —      | World time; see the fields below                              |

World fields (all derived from the current tick; see the
[`clock`](packs.md#clock) domain for the calendar):

| Field               | Type    | Meaning |
|---------------------|---------|---------|
| `world.tick`        | number  | Ticks since start |
| `world.seconds`     | number  | **Sim** seconds since start (`tick / 10`); `rate` is per sim second |
| `world.day`         | number  | In-game day, starting at `1` |
| `world.hour`        | number  | In-game hour, `0`–`23` |
| `world.minute`      | number  | In-game minute, `0`–`59` (floored) |
| `world.time_of_day` | number  | In-game hours since midnight as a float in `[0, 24)`, e.g. `8.5` at 08:30 |
| `world.is_day`      | boolean | `dawn <= time_of_day < dusk`; `1`/`0` in arithmetic, e.g. `-0.8 - 1.2 * world.is_day` |

Entity members:

- `self.x`, `self.y` — grid position.
- `self.<measurement>` — the entity's current value of a measurement, by
  short (`self.hp`) or qualified (`self.std:hp`) id. An entity that does
  not have the measurement reads `0`.
- `self.has_tag("tag")` — method form of `has_tag(self, "tag")`.
- `self.has_status("id")` — method form of `has_status(self, "id")`.
- `self.count_item("id")`, `self.has_item("id")` — method forms of
  `count_item(self, "id")` / `has_item(self, "id")`.
- `self.carry_weight`, `self.carry_capacity` — the load and capacity of
  the entity's inventory, in normal weight units (`0` without an
  inventory). These names take precedence over measurements.

`tile.id` is the qualified tile id, e.g. `tile.id == "std:floor"`.
`tile.has_tag("water")` (or `has_tag(tile, "water")`) tests the tags of the
tile under `self` (see [tile tags](packs.md#tiles)). `tile.in_room("kitchen")`
(or `in_room(tile, "kitchen")`) tests the [room](packs.md#maps) tags of the
cell under `self`. Tile tags, room tags and entity tags are three separate
sets.

## Built-in functions

| Function                                 | Description                                              |
|------------------------------------------|----------------------------------------------------------|
| `min(a, b)`, `max(a, b)`                 | Minimum / maximum                                        |
| `clamp(v, lo, hi)`                       | Clamp `v` to `[lo, hi]`                                  |
| `abs(x)`, `floor(x)`, `ceil(x)`          | Usual math                                               |
| `random(lo, hi)`                         | Integer in `[lo, hi]` from the world's seeded RNG        |
| `roll(n, sides)`                         | Sum of `n` dice with `sides` faces (seeded RNG)          |
| `manhattan(a, b)`                        | Manhattan distance between entities/tiles                |
| `chebyshev(a, b)`                        | King-move distance                                       |
| `euclidean(a, b)`                        | Straight-line distance (float)                           |
| `has_tag(entity, "tag")`                 | Whether the entity's archetype has the tag               |
| `has_tag(tile, "tag")`                   | Whether the tile under `self` has the tag                |
| `has_status(entity, "id")`               | Whether the entity has the status active                 |
| `count_item(entity, "id")`               | Units of an item in the entity's inventory (`0` without one) |
| `has_item(entity, "id")`                 | `count_item(entity, "id") > 0`                           |
| `in_room(tile, "tag")`                   | Whether the cell under `self` is in a room with that tag |
| `can_see(a, b)`, `can_see(a, b, range)`  | Tile line of sight between entities/tiles, optionally within a euclidean `range` |
| `heard(entity, seconds)`                 | Whether the entity heard a [noise](packs.md#systems) less than `seconds` ago |

The distance functions also accept four numbers: `manhattan(x1, y1, x2, y2)`.

`has_status` takes a **string literal** status id, short or qualified,
resolved at load time with the usual namespacing rules; an unknown id is a
load error with a *did you mean* suggestion. At runtime it is a single
array read (`(ctx) => ctx.self.st[k] === 1`), never a string comparison.

```yaml
when: 'self.has_status("hungry") and tile.has_tag("food")'
```

`count_item` and `has_item` also take a **string literal** item id, short
or qualified, resolved at load time like `has_status` (unknown ids are
load errors with a suggestion). At runtime they scan the stacks of one
inventory by item index; no strings are compared. `in_room` takes a string
literal room tag, checked against the room tags used by the loaded maps
and resolved to an index, so a test is one array read.

```yaml
when: 'self.carry_weight >= 0.8 * self.carry_capacity'
when: 'world.is_day and tile.has_tag("sunlit") and not self.has_item("cloak")'
when: 'self.count_item("canned_beans") >= 2 and tile.in_room("kitchen")'
```

`can_see` answers "can `a` see `b`?" over the tile grid. `a` and `b` are
entities or tiles; there is no method form and no four-number form. The
rules:

- Only tiles block sight, through their [`opaque`](packs.md#tiles) flag
  (default `!walkable`). Entities never block.
- Endpoints are ignored: only cells strictly between `a` and `b` are
  tested, so a wall is visible from the floor in front of it, and the same
  or an adjacent cell is always visible.
- A diagonal step between two opaque orthogonal neighbours is blocked (no
  peeking through wall corners, like movement's no corner cutting).
- The result is symmetric: `can_see(a, b) == can_see(b, a)`. It is
  integer-only and deterministic.
- With `range`, the result is `false` when `euclidean(a, b) > range`
  (a pair exactly `range` apart can still see each other). The range is checked before the
  line is walked, so distant pairs are cheap.

The result is a boolean, so it works in arithmetic (`1 + can_see(self, player)`).

```yaml
when: 'can_see(self, player, 8)'
until: 'not can_see(self, player, 12)'
```

`heard(entity, seconds)` is true when the entity has heard a noise and
`world.tick - heardTick < seconds × ticksPerSecond`. A `seconds` value
`<= 0` is always false. The first argument must be an entity, and the
argument count and types are checked at load time. It also has a method
form: `self.heard(2)`. Hearing happens after systems, so with
`seconds = 1` (10 ticks/s), a noise heard on tick *t* makes `heard` true
from the status update of tick *t* through tick *t + 9*. The next think
phase (tick *t + 1*) sees it.

```yaml
on:
  - { when: 'self.has_status("alert")', to: chase }   # sight beats sound
  - { when: 'heard(self, 1)', to: investigate }
```

`random` and `roll` draw from the world RNG, so results are part of the
deterministic simulation: same seed + same inputs ⇒ same values.

## Namespacing

Every definition id is qualified with its pack namespace (`std_needs:hunger`).
Inside expressions a measurement can be written either way:

- **Qualified** — `self.vamp:blood`. `ns:id` with **no whitespace** around
  the colon is a single token. The namespace must be the expression's own
  pack or one of the packs it `depends` on.
- **Short** — `self.blood`. Resolves to the expression's own pack first,
  then to the unique match among its `depends`. Ambiguous or missing
  references are load errors.

See [packs.md](packs.md#namespaces-and-references) for the full rules.

## Compilation and validation

Expressions are parsed and compiled **once, at load time**, into closures.
Member paths are resolved to measurement **indices** during compilation,
so `self.std_needs:hunger` compiles to roughly `(ctx) => ctx.self.m[7]`; the
runtime never parses or looks names up.

The loader reports, with file, key path and line:

- syntax errors (with the character position),
- unknown identifiers (`slef` → *did you mean 'self'?*),
- unknown measurements in member paths (with a near-miss suggestion),
- unknown functions (`maxx` → *did you mean 'max'?*) and wrong arity,
- type errors (e.g. arithmetic on an entity; a `rate`/`max`, effect
  `delta`/`value` or status rate that is not numeric; a condition that
  evaluates to an entity or tile),
- `has_status`, `count_item`, `has_item` or `in_room` with a non-literal or
  unknown id / room tag.

Numeric constants are folded: `rate: "-0.8"` is stored as a plain number
and the tick loop skips the expression call entirely.
