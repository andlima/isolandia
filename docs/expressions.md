# Expression language

A small, pure expression language used in pack fields such as a
measurement's `max` and `rate`. Ported from rogue-engine, with three
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
| `tile`   | tile   | The tile under `self`: `tile.x`, `tile.y`, `tile.id`          |
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
  short (`self.hp`) or qualified (`self.base:hp`) id. An entity that does
  not have the measurement reads `0`.
- `self.has_tag("tag")` — method form of `has_tag(self, "tag")`.

`tile.id` is the qualified tile id, e.g. `tile.id == "base:floor"`.

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

The distance functions also accept four numbers: `manhattan(x1, y1, x2, y2)`.

`random` and `roll` draw from the world RNG, so results are part of the
deterministic simulation: same seed + same inputs ⇒ same values.

## Namespacing

Every definition id is qualified with its pack namespace (`zmb:hunger`).
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
so `self.zmb:hunger` compiles to roughly `(ctx) => ctx.self.m[7]`; the
runtime never parses or looks names up.

The loader reports, with file, key path and line:

- syntax errors (with the character position),
- unknown identifiers (`slef` → *did you mean 'self'?*),
- unknown measurements in member paths (with a near-miss suggestion),
- unknown functions (`maxx` → *did you mean 'max'?*) and wrong arity,
- type errors (e.g. arithmetic on an entity; a `rate`/`max` that is not
  numeric).

Numeric constants are folded: `rate: "-0.8"` is stored as a plain number
and the tick loop skips the expression call entirely.
