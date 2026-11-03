# isolandia — Decision log

> The questions that `VISION.md` has settled, with the decision, where it
> was made (spec or task) and what it ruled out, plus the milestone
> history. `VISION.md` keeps the goal, the principles, the roadmap and the
> **open** questions; when one of those is decided, its entry moves here.
> The reference for *how things work today* is `docs/` — an entry here is
> the record of *why*, frozen at the time of the decision, and may lag the
> code.

Entries are grouped by the milestone that decided them and read as
*question → decision*. Specs live under `specs/`.

## M0 — simulation core

### Pack format: pure YAML, or YAML + generated JSON? One file per domain or free-form?

**Decided in M0:** **pure YAML** (no generated JSON). A pack is a directory
with `pack.yaml` (`namespace`, `name`, `version`, `depends`) and a
**free-form layout** of `*.yaml` files at any depth; each file carries one
or more **domain keys** (`measurements`, `tiles`, `archetypes`, `maps`,
`start`…) and the content is **merged per domain** within the pack.
Unknown keys are a load error. See `docs/packs.md`.

## M1 — isometric renderer

### Projection: classic 2:1 dimetric? Tile size?

**Decided in M1:** **classic 2:1 dimetric** with a **64×32 px** tile
diamond (`iso.x = (x − y)·32`, `iso.y = (x + y)·16`); 32 px raised blocks;
tile sprites anchored at the bottom vertex of the diamond, archetype
sprites at the center of the tile floor. See `docs/iso.md`. Cutaway walls
remain open (M6).

### How do things get an orientation in the iso view?

**Decided (spec `iso-directional-sprites`):** **directional pre-rendered
sprites**, in the style of classic isometric games; **no real-time 3D** and
no change to the projection. Assets take `directions` (4-way or 8-way) and
**horizontal mirroring** fills the rest (5 drawings for 8 ways, 2 for 4).
Characters face their movement direction. Facing is **simulation state**
(in snapshots and hashes): an entity turns 45° per `ticks_per_turn` beat
toward a new direction before it steps (spec `turn-before-move`). In the
browser a key tap only turns in place and a hold walks (spec
`turn-in-place`). Map tiles get a static 4-way `facing` from the legend.
Facing-aware actions (vision cones, interact with the faced tile) may come
in M5. Animation frames are a later step. See `docs/iso.md`.

## M2 — clock, systems, statuses

### Time scale / game calendar?

**Decided (task `world-clock`, M2 groundwork):** the scale comes from a
pack-defined **`clock`** domain (`day_length`, `start`, `dawn`, `dusk`);
the default is **1 game day = 24 real minutes** (1 simulation second = 1
game minute). Game time is **derived from the tick** — it adds no state,
so determinism, snapshots and hashes do not change. Expressions read
`world.day`, `world.hour`, `world.minute`, `world.time_of_day` and
`world.is_day`; `rate` stays per simulation second. **One pack** defines
`clock`; since M7 later packs may patch it with `override: true`. See
`docs/packs.md`.

### How do `systems` schedule work, how do `statuses` enter and exit, how is day/night configured, and how does the game end?

**Decided in M2:**

- **`systems`** use **simulation seconds** (`every: 1`, default one tick);
  `every` must be a whole number of ticks and becomes a period in ticks at
  load. They run once per entity (`for` filters, then `when`), with
  `apply`/`set` effects on `self`. Game-time units (`every: 30m`) come
  later.
- **`statuses`** enter with `when` and exit with `until` (default `not
  when`), which gives **hysteresis**; while active they add their `rates`
  to the drift. They are simulation state (snapshot/hash) and expressions
  test them with `has_status(entity, "id")`, resolved to an index at load.
- The tick order is fixed: intent → drift (with the `rates` of the
  statuses active at the start of the tick) → systems → clamp → statuses →
  defeat → `tick++`.
- The day/night tint is **its own domain, `lighting`** (`at`/`color`
  keyframes interpolated in RGB), purely visual; at most one pack defines
  it, like `clock`.
- Defeat is **`start.defeat`** (`when` evaluated with `self` = player,
  optional `message`); when it fires, the world freezes and ignores input.
- Tiles get their own **`tags`** (`tile.has_tag("x")`), separate from
  archetype tags.

### Stdpack (decision 8): rename `base` to `std`? One pack or several optional ones?

The `base` pack (`hp`, `humanoid`) already played the stdpack role; the
needs in `packs/zombie/needs.yaml` and generic statuses like `burdened`
were candidates to move up.

**Decided (task `stdpack-split`):** the stdpack is **several optional
packs**. `base` became **`packs/std/`** (namespace `std`: `hp`,
`humanoid`, `floor`/`wall`/`door`), and **`packs/std-needs/`** (namespace
`std_needs`, depends on `std`) holds the `hunger`/`thirst`/`fatigue`
measurements and the `hungry`/`thirsty`/`exhausted`/`burdened` statuses.
Entities opt in to the needs by listing the measurements and carrying the
**`living`** tag. What is zombie-specific stayed in the zombie pack (the
`stocked` status and the `sleep`/`bleed`/`collapse` systems); zombie
depends on `[std, std_needs]`, vampire only on `[std]`. More packs (e.g.
`std-melee`) get added as genres repeat patterns. The engine guard test
rejects stdpack terms in `src/` as well as genre words. See
`docs/packs.md`.

## M3 — items, containers, loot

### Items as entities or as data in containers? How do tile/room tags feed loot tables?

**Decided in M3:**

- **Items are data inside containers**, not entities: a stack is `{ item,
  count }` (at most one per item). There are three kinds of container:
  built into the tile (`tiles[].container`), an entity's **inventory**
  (`archetypes[].inventory`) and a **ground pile** (created when items are
  dropped, removed when it empties). Container ids are sequential and
  never reused.
- **Weights in integer hundredths**: weights and capacities are rounded to
  0.01 at load and summed/compared as integers, with no float drift (`0.1
  × 3` fits in `0.3`). Expressions and UI show normal units.
- **Rooms are rectangles** (`maps[].rooms: [{ rect, tags }]`); a cell's
  tags are the union of the rectangles that contain it. Room, tile and
  entity tags are three separate sets (`tile.in_room("x")`).
- **The most specific distribution wins**: each tile container uses the
  first `distributions` entry whose `room` is in the cell's tags;
  otherwise the first one without `room`; ties → definition order.
- **Loot has its own RNG**, derived from the world seed, rolled once in
  the `World` constructor; the world RNG is untouched, so movement and
  `random()` do not change. Nested tables, `nothing` and cycles (a load
  error) are supported.
- **Actions are instant until M5**: `take`/`put`/`drop`/`use` go into
  their own queue (`queueAction`, separate from movement intents), applied
  in the intent phase right after movement, with a reach of 1 tile
  (Chebyshev) and the result in `world.lastAction`. Duration, progress bar
  and interruption come in M5.

## M4 — perception and behaviors

### State machine vs utility AI for `behaviors` — or both?

**Decided (task `npc-behaviors`, M4 core):** **state machines, for now.**
A pack-defined **`behaviors`** domain declares **declarative state
machines**: each state runs one **built-in activity** (`idle`, `wander`,
`pursue`, `flee`, `home`) and **transitions** are ordinary expressions
(`on` in order, then `timeout`, then `home`'s `done`; at most one per
tick). Archetypes opt in with `behavior: <id>`; the player is never
driven. Behaviors tick in a new **think** phase (phase 0, before intents)
that **only issues movement intents**, so walls, cooldowns and A* behave
exactly as for input. Only `wander` draws RNG, in id order, so runs stay
deterministic. **Utility AI is deferred**; it could come later as another
activity or state selector. No nested states or enter/exit effects yet.
See `docs/packs.md`.

### How is sight represented?

**Decided (task `line-of-sight`, M4 groundwork):** sight is **tile-based
line of sight**. Tiles get an **`opaque`** flag (default `!walkable`; the
vampire window is `opaque: false`). The test walks integer Bresenham lines
both ways and ORs them, so it is **symmetric**; endpoints are ignored,
diagonal wall corners block, **entities never block**, and it allocates
nothing. Pack data uses it through the **`can_see(a, b[, range])`**
expression built-in (euclidean range, inclusive, checked first). No field
of view, fog of war, light or facing yet. See `docs/expressions.md`.

### How is noise represented without a per-tick cost proportional to the map?

**Decided (task `noise-hearing`, M4 completion):** noise is **events**,
not a field over the grid. A **`noise` effect** (in `systems` and item
`use`) emits a noise at **`self`'s cell** with a radius. A **hear** phase
right after systems checks each (noise, entity) pair: hearing is
**euclidean and inclusive**, and **ignores walls for now** (no muffling,
flood fill or attenuation). Each entity remembers only its **last heard
noise** (the nearest of its tick), with the cell and tick. Expressions
test it with **`heard(entity, seconds)`**, and the **`investigate`**
behavior activity walks to it (`done` once adjacent, when the path fails,
or when nothing was heard). The cost is O(noises × entities) on noisy
ticks only, with no allocation and nothing on silent ticks. Zombies
investigate broken glass and alarm clocks; bats investigate creaky
floorboards. There is no "last known position" for `pursue`, no memory of
more than one noise, and no per-archetype hearing range yet. See
`docs/packs.md`.

## M5 — timed actions, context menu, recipes

### How do actions take time?

**Decided (spec `m5-timed-actions`, M5 core):**

- **Actions are pack-defined** in an **`actions`** domain, with a
  **`self`** target or a **tile** target picked by a tile filter (`{
  tiles?, tags? }`, one of the 8 cells around the actor or its own). In a
  tile action's expressions, `tile` is the target cell. A new
  **`set_tile`** effect edits the map (never onto or off a container
  tile). Item `use` gains the same `duration`/`interrupt`.
- **Effects apply only at completion**, after every start check (`when`,
  tools, consumed items, reach, filter) passes again; nothing is consumed
  before. There is no partial progress and no resuming.
- **Moving or queueing a new action cancels** the activity, and so does
  the pack's **`interrupt`** expression, checked every tick after the
  start. Cancellation happens in the tick's intent phase, so it does not
  depend on the shell.
- **Durations are evaluated once, at start** (a number or an expression
  in sim seconds, rounded up to whole ticks); a 0-tick action is instant
  and behaves exactly as before.
- The activity, and every cell that differs from the map, are simulation
  state (snapshot and hash). `world.availableActions()` is a pure query
  for the shells; the context menu (`m5-context-menu`) and recipes
  (`m5-recipes`) build on it.

### How does the player pick what to do, and how do far targets work?

**Decided (spec `m5-context-menu`, M5):**

- **Walk-then-act lives in the simulation**, as **`goto.then`**: a player
  `goto` can carry an action that is queued when the path arrives (in the
  same tick's action step), so it is deterministic, part of the snapshot
  and hash, and every check runs as usual. No path records the new
  `unreachable` reason; a path cleared before arrival drops it silently.
  `world.approachIntent(action)` picks the goto for a shell.
- **Menus are built from a pure core query**, `world.interactionsAt(x,
  y)` (tile actions, containers, self actions, walk here), shared by the
  browser context menu (right-click, long-press, `E`) and the terminal's
  `x` list. The DOM layer is thin over a pure `contextMenu` model.
- **Disabled entries are shown with reasons** (`Needs: Hammer, 2× Plank`,
  a pack's `unavailable` text such as `Only in the crypt`), so players
  learn what exists; `reasonText` is the one source of that text.

### How does crafting work?

**Decided (spec `m5-recipes`, M5):**

- **Recipes are a separate `recipes` domain** (consume, tools, produce, an
  optional station, `when`, `duration`, `interrupt`, extra effects), not a
  kind of action. They run as a **third activity source** on the shared
  lifecycle of `m5-timed-actions` (same cancellation, interrupt,
  completion-only rules, snapshot and hash). A source declares its
  completion steps in order, so recipes **consume, then produce, then run
  effects** while actions and item uses keep effects-then-consume.
- **Stations are tile filters**, like action targets: a recipe made at a
  stove is `station: { tags: [heat] }`, bound to the first matching cell
  in reach (row-major) unless the shell names one. Station recipes appear
  in the context menu on the station's cell; the rest live in a crafting
  panel (browser `C`, terminal `c`).
- **All recipes are known** from the start; no learning, skills or success
  chances.
- **Overflow goes to the ground**: produced units that do not fit are put
  on the ground pile at the crafter's cell, so a completed recipe never
  loses items or fails for lack of room.

### How many clicks does a common interaction take?

**Decided (spec `ux-smart-click`):** **left click runs a safe default
(open, climb, walk), or opens the menu when the object has actions that
cost something; disabled entries fold under *Can't do now*.**

- The default is the first enabled `open`, else the cell's only `climb`,
  else `walk`; costly actions (`act`, `craft`) never run on a plain click.
  Shift-click always walks; right-click, long-press and `E` always open
  the menu, which alone offers *Walk here*.
- The menu puts the default first, numbers enabled entries `1`–`9` and
  shows each action's duration and the items it uses up
  (`Interaction.duration` / `uses`, filled purely by the core).
- Hover (mouse and pen) outlines the target and shows a tooltip with what
  a click will do; touch has no hover.

### Can the player pause or speed up time?

**Decided (spec `ux-time-controls`):** **pause and speed belong to the
shell.** A pure `Pace` (`src/core/pace.ts`) shared by both shells holds a
pause and one of **four speeds (1×, 2×, 4×, 8×)**; the shell asks for that
many fixed ticks per wall second (none while paused) and the sim still
steps one tick at a time. They are **never saved or hashed** and do not
affect determinism; a load keeps them. No slow motion, no in-sim time
skips (sleep), no automatic drop to 1× on danger yet. The conversation
pause stays world state.

## M6 — chunked world, floors, Tiled maps, saves

### How are games saved and loaded?

**Decided (spec `m6-save-load`, M6):**

- **A save is a snapshot plus pack identity**: `world.save()` is the world
  snapshot (now with the seed, `nextContainer` and changed tiles as `[x,
  y, id]`) with the format version, the pack namespaces and versions, and
  the start map id and size. Plain JSON, qualified ids, no wall-clock
  time; shells keep their metadata in a wrapper next to it.
- **Restore is exact and rolls nothing**: `World.restore` rebuilds the
  world through a constructor path without spawning, loot, clamp or
  status updates, so a restored world has the same snapshot and the same
  future hashes. A shared `assertRoundTrip` test helper guards this for
  every later format change.
- **Pack version drift is a warning, id drift is an error**: unknown
  archetypes, items, tiles, measurements, statuses, actions, recipes and
  behavior states fail the restore (with JSON paths and *did you mean*),
  as do other pack lists or maps; a different pack version, or an added or
  removed measurement, only warns. Rule changes inside a pack are not
  detected.
- **Saves live in browser `localStorage` slots and exported files**: a
  quicksave (`F5`/`F9`) and three slots per pack list, plus file export
  and import; the terminal saves to a file (`S`/`L`, `--load`) and `check
  --save` validates one. No autosave, compression or cloud sync. See
  `docs/saves.md`.

### How are maps authored once they outgrow ASCII rows?

**Decided (spec `m6-tiled-maps`, M6):**

- **Tiled JSON only**: maps are `.tmj` with embedded or external `.tsj`
  tilesets; TMX/TSX (XML), compressed layers and infinite maps are load
  errors. ASCII rows stay supported for fixtures and small maps.
- **Tile ids and facings come from tileset tile properties** (`tile`,
  `facing`), not from gids or flip flags; flipped gids are errors.
- **The top-most visible layer wins** per cell; hidden layers are ignored
  and groups are flattened.
- **Objects are matched by class** (`player`, `spawn` with `archetype`,
  `room` with `tags`); untyped objects are notes.
- **Spawns are ordered row-major** (then by object id), so entity ids
  match the ASCII loader and do not depend on object order.
- `npm run map:export` writes an ASCII map as an isometric 64×32 Tiled
  map; round trips are tested. See `docs/packs.md`.

### How do buildings get upstairs?

**Decided (spec `m6-floors`, M6):**

- **Floors are `z ≥ 0` joined by link tiles**: a map is a stack of
  same-size floors (ASCII `floors:`, Tiled `floor` groups); a tile with
  `climb: up`/`down` links its cell to the same `(x, y)` one floor up or
  down, as an edge both ways that exists while both ends are walkable (so
  `set_tile` can block stairs). Cells may be empty (no tile). One-floor
  maps keep their cell indices and behave exactly as before. No basements,
  falling, ramps or multi-cell stairs yet.
- **A\* crosses links**: pathfinding searches the 3D grid (8 same-floor
  neighbours plus links, cost 1, octile heuristic on `(x, y)`), so
  click-to-move, walk-then-act, `pursue`, `investigate` and `home` work
  across floors; keyboard steps, `wander` and `flee` stay on their floor.
- **No sight across floors, 3D hearing**: `can_see` is false between
  floors; noises reach 3D euclidean distance with one floor = one tile,
  and floors do not muffle. Reach is same-floor only.
- **Floors above the player are cut away**: the iso view raises floor `z`
  by `z × BLOCK_H`, hides every floor above the player's (switching at a
  climb's midpoint) and fades the raised blocks just in front of the
  player. Saves become version 2 (every cell gets a `z`); version 1 saves
  still load. See `docs/packs.md#floors` and `docs/iso.md#floors`.

### How does the world scale to a town?

**Decided (spec `m6-chunked-world`, M6):**

- **Composite maps from parts, without nesting**: a `maps` entry with
  `size`, `fill`, `parts` (`{ map, at }`), `player`, `rooms` and
  `populate` is assembled at load from non-composite part maps (ASCII or
  Tiled), placed any number of times; parts may not overlap or be
  composites themselves. No rotation, mirroring or random selection.
- **Seeded `populate`**: zones on any map (applied per placement on a
  part) scatter archetypes on candidate cells, without reuse, with a
  dedicated RNG derived from the seed; counts are checked at load and
  saves store the placed entities.
- **Derived dormancy beyond an active radius**: an NPC farther than
  `start.simulation.active_radius` (Chebyshev, default 64) from the player
  neither thinks nor moves that tick, but still drifts, runs systems and
  statuses and hears. One O(n) pass per tick; never saved or hashed.
- **Budgeted A\* with region labels**: searches stop after a node budget
  (NPC 4 000, player 60 000 by default), and connected-region labels
  (recomputed lazily after `set_tile`) reject unreachable goals without
  searching. A 16×16 entity index per floor serves `entitiesNear` and
  hearing.
- **Lazy, evicted render chunks**: the iso scene builds a 16×16 chunk the
  first time it is near the view, keeps at most 160 in an LRU and destroys
  the rest; entity and pile sprites exist only in built, visible chunks.
  F3 shows a perf line.

## M7 — packs and mods

### Override semantics between packs: full replacement by ID, deep merge, or explicit patch operations?

**Decided (spec `m7-overrides`, M7):** **patch by qualified id.** A pack
restates a **direct dependency's** id with `override: true` and only the
fields it changes (a **shallow** merge: each listed top-level field
replaces the old one whole, lists and mappings included; `field: null`
clears it), or deletes the entry with `remove: true`. `start`, `clock` and
`lighting` take `override: true` too. Each field keeps the **scope and
files of the pack that wrote it**; entries keep their position and indices
stay dense; references to a removed id are load errors naming the remover.
Unrelated packs writing the same field **warn, later wins**. No list
operators or deep merge; `distributions` cannot be patched. `check
--overrides` lists every patch. See `docs/packs.md` (Mods and overrides).
*Revisited narrowly by `pack-ergonomics` (below): numeric terms and a
one-level-deeper merge for `start.defeat` / `victory` / `simulation`.*

## M8 — social layer

### How does the world remember story facts, and what are goals beyond one `victory` expression?

**Decided (spec `m8-flags-quests`, M8):**

- **Vars are world-level declared numbers**: a `vars` domain (`initial`,
  `min`, `max`; booleans stored as `1`/`0`), one value per world, clamped
  on every write by `set_var` / `add_var` effects and read with
  `var("id")`. No string vars, per-entity vars (use measurements) or
  collections.
- **Quests are ordered stages that only move forward**, entered by a
  stage's `when` (a quest phase after statuses and before the outcome
  check takes the last truthy stage, at most one change per quest per
  tick) or by `quest` effects; `end: success` / `end: failure` stages end
  them, and stage `effects` run on entering. No branching objectives,
  markers or timers; rewards are stage effects.
- **Journal entries are one-time domain entries, not free text**: a
  `journal` domain of texts with a category, added once by the `journal`
  effect and tested with `in_journal("id")`; never removed and not
  templated.
- All of it is in snapshots, hashes and saves (version 4; version 3 saves
  load with fresh story state). Shells show `world.journal()` (a `J` panel
  and terminal screen) and toast `world.journalEvents`.

### How does the player talk to NPCs?

**Decided (spec `m8-dialogues`, M8):**

- **Dialogues are declarative trees on archetypes**: a `dialogues` domain
  (conditional `start` entries, named nodes with a speaker, text and
  effects, up to 9 choices gated by `when` with `consume` / `give` /
  `effects` / `to`), attached with archetype `dialogue`. Expressions see
  the NPC as `npc`, and `apply` / `set` take `on: npc`. No templating,
  skill-check fields, barter screens or NPC-to-NPC talk.
- **The world pauses while a conversation is open**, as in most RPGs:
  `step()` is a no-op, and `choose(n)` / `leaveConversation()` are
  synchronous inputs (not activities: nothing ticks). Effects apply at
  once; outcomes, statuses and the quest phase follow on the first tick
  after the conversation ends.
- **`once` choices are world-level**, not per NPC entity, and are saved by
  choice id (version 5, with the open conversation).
- **NPCs are reached like containers and are not followed**: `talk` needs
  Chebyshev 1 on the player's floor with no wall edge between;
  walk-then-talk walks to the NPC's cell at the time of the click, and the
  talk fails with `out_of_reach` if the NPC has moved away.

### How do groups of NPCs remember what the player did?

**Decided (spec `m8-factions`, M8):**

- **Membership is per archetype**: a `factions` domain, joined with
  archetype `faction`. No ranks, disguises or joining in play; a mod
  enlists residents by overriding their archetype's `faction`.
- **The player's standing is world state per faction** (one number in
  [-100, 100] each, in snapshots, hashes and saves version 6), not a
  memory per NPC. `attitude` ignores the player's own faction.
- **Relations are fixed data and can be asymmetric**: how F regards G is
  a number on F, unset is 0, members always regard each other at 100.
  Nothing changes relations at run time.
- **Crimes count when a member sees them**: the `reputation` effect's
  `witnessed` range applies it only if a member other than `self` and the
  player sees `self` (`can_see` within a euclidean range, same floor). No
  witnesses who report later.
- **Spread is one step and opt-in**: with `spread: true` a change of F
  also moves every faction G by `delta × G.relations[F] / 100` (2
  decimals), without chaining.
- **NPC-to-NPC hostility is readable but not yet acted upon**: `attitude`,
  `hostile` and `friendly` work between NPCs, but nothing seeks out
  enemies until a `nearest(...)`-style target and combat are decided.

## Pack ergonomics after M8

A survey of `std`, `std-needs`, `town`, `hardship`, `zombie`, `vampire`
and `garden` after M8 listed the YAML pain points, roughly by weight.
**Nothing in it needed a script hook**: each was a missing primitive or a
verbose form. The ones decided so far, each by its own spec; the rest stay
open in `VISION.md`.

### Perception was copy-pasted five times

`zombie:alert`, the bat's `alert`, the cat's `curious`, the fox's `sly`
and the butterfly's `alert` were each a status entered on `can_see(self,
player, N)` and left beyond a wider range, and every behavior repeated the
same transition in most states (the shambler in 3, the cat in 4; the fox
repeated `world.is_day → den` in 4), keeping "sight beats sound" by
ordering `on` lists by hand.

**Decided (`npc-perception`):** perception is a **sense on the
archetype**, `senses: { sight: { notice, lose, targets } }`, with the
hysteresis (noticed at `notice`, followed out to `lose`) and the
concealment in the engine, which keeps per entity the one target it sees
(`self.sees` / `self.seen`, updated in a senses step at the end of the
status update); `can_see` stays pure geometry. "Sight beats sound" is an
**any-state transition**: `behaviors[].on`, checked before the current
state's own, with an `except` list for the states that ignore it. The five
statuses and the riders' inline pair are gone.

### Concealment was per observer

`curious` and `sly` both appended `not has_status(player, "hidden")` to
`when` and `until`; a new observer that forgot it saw through bushes.

**Decided (`npc-perception`):** a status with `conceals: true` hides its
entity from **every** sense (the garden's `hidden`); `can_see` is
unchanged.

### NPCs could only target `player`

`can_see(self, player)`, `target: player`; the faction games would hit it
first.

**Decided (`npc-perception`):** NPCs find other NPCs through a sense's
`targets` tags and `self.seen`, the behavior `target` being `self.seen`;
**`none`** is the total value for "nothing seen": `0`, `false`, `Infinity`
for distances, and `pursue` waits on it. A `nearest(...)` built-in
independent of senses stays out.

### Footsteps were polled, and tick order leaked into pack data

`crunch` (`every: 0.2`), `creak` (`0.1`) and `hop` (`0.2`) meant "noise on
each step" but fired while standing still, at a period guessed from the
walking speed. The bandage's `interrupt: "heard(self, 0.2)"` carried a
comment explaining that hearing lands after the work step.

**Decided (`pack-event-triggers`):** footsteps, one-shots and noise
interrupts are **events**. A system takes `on: step` (the tick an entity
lands on a cell, player or NPC, one firing per cell) or `on: noise` (the
tick it hears one) instead of `every`, and `once: true` (at most once per
entity, saved as `fired`); an action, item use or recipe takes `interrupt:
{ on: noise, when? }`, checked on the tick the noise lands. Noise systems
and event interrupts run in a sub-phase right after hearing, and a noise
they emit is carried to the next tick, so a tick runs one hear phase and a
scream that startles the neighbours is a chain of ticks. Tile-level
`on_enter` hooks were not added: a step system with a tile `when` covers
them for every tile at once. `crunch`, `creak` and `hop` are `on: step`;
`survival_tip` is `once`; the bandage and the vampire's `rest` use
`interrupt: { on: noise }`.

### Two spellings for changing a measurement

Statuses wrote `rates: { hp: -0.2 }`, effects wrote `{ type: apply,
measurement: hp, delta: -0.2 }` (~25 times, mostly items).

**Decided (`pack-ergonomics`):** an effects entry may be `{ apply: {
hunger: -35, thirst: 3 } }` or `{ set: { liquor: 100 } }`. It is a
**load-time shorthand**: the loader expands it to one typed effect per
key, in mapping order, so the compiled definition's shape, snapshots,
hashes and saves do not change; the long form stays the general one. Every
shipped pack uses it.

### Overrides forced copying upstream values

`hardship` doubled thirst by copying the whole `std_needs` rate expression
(drifting silently if upstream changed), restated all of `kitchen_food`'s
entries to change weights; `zombie` and `vampire` restated `defeat.when`
to change only the message. Candidates were pack parameters read by
expressions, a `scale` for numeric overrides, or a deeper merge for
`start.defeat`.

**Decided (`pack-ergonomics`),** two ways, no pack parameters yet: an
override may give a numeric field a **term**, `rate: { scale: 2 }` / `{
add: n }`, applied to the current value after every earlier patch (terms
stack: ×2 then ×2 is ×4). A number is folded at load; an expression is
**wrapped textually**, `(…) * 2`, and compiled in the scope of the pack
that wrote the original, with provenance recorded as the overriding pack.
And in a `start` override, `defeat`, `victory` and `simulation` merge
**one level deeper**, per field — a deliberate, narrow revisit of
`m7-overrides`' whole-replacement rule; every other nested value keeps it.
`hardship` now writes `rate: { scale: 2 }`, `zombie` and `vampire`
override only `defeat.message`. `kitchen_food` is still restated (terms on
nested values and list operators stay out of scope); pack parameters are a
later spec if a third mod needs a value that is not a scale of an upstream
one.

### `for` was repeated on every rule

`has_tag("living")` 9 times, `undead` 5, `bunny` 4.

**Decided (`pack-ergonomics`):** a content file may carry `defaults: {
for: … }`, applied to the `systems` and `statuses` entries of **that
file** that do not write `for` (an entry that writes `for: "true"` opts
out). Defaults are **per file**, never per pack, and **never touch
overrides or removals**: an override changes only what it lists, and a
defaulted `for` would silently patch the upstream entry. The expression
keeps the `has_tag` fast path and is reported once, at `defaults.for`.

### Spawn grids were hand-computed

`zombie/outbreak.yaml` had 36 `populate` rects over the city's 59×59
blocks. Candidates were density by room or region tag, or a Tiled region
layer.

**Decided (`populate-density`):** spawn density is **per candidate cell
over tagged rooms** (`density: n` per 100 candidate cells, the count
derived at load per placement), with a `where` expression over `tile` as
the cell filter (`tile.in_room("downtown") and not
tile.in_room("center")`, `tile.has_tag("grass")`). No Tiled region layer
was needed: rooms already tag regions on every map kind, so the outbreak's
36 rects became 4 entries over 3 rooms, and `check --populate` shows the
candidates and counts.

### Exposure was tagged tile by tile

The vampire needed `shade` or `sunlit` on every tile, and untagged floors
burned as if outdoors.

**Decided (`tile-exposure`):** exposure is **derived from enclosure and
cover** at load, static: on each floor the cells are grouped into areas by
the enclosing edge tiles, an area touching the map border or an empty cell
is open, and a cell under a non-empty cell of the floor above is covered;
`tile.exposed` is one array read. Two tile overrides keep the exceptions:
`encloses: false` on an edge (the garden's fence) and `exposed:
true|false` on a cell tile (the sunbeams under the mansion's windows). The
`shade`/`sunlit` tags are gone; the mansion's plain floors are shaded like
the carpet beside them.

### Smaller: no count by item tag, no fraction of max

`stocked` added two `count_item` calls; `scorched` hard-coded `hp < 25`.

**Decided (`pack-ergonomics`):** `count_tagged(entity, "tag")` /
`has_tagged` sum every stack carrying an item tag, resolved at load to a
per-item flag (`stocked` counts `food` + `drink`); `fraction(entity,
"measurement")` is `(value − min) / (max − min)` in `[0, 1]`, a load error
on a measurement without `max` (`scorched` reads `fraction(self, "hp") <
0.25`).

## M10 — look and feel, landed so far

M10 is sketched in `VISION.md` (open questions). The pieces that have
landed, each as a task:

### Walk frames (task `walk-cycle`)

The asset schema `animations.walk` (frame lists per drawn facing, mirrored
like `directions`), the pose `(facing, frame)` chosen from the step
progress with a cycle over two steps, and a 4-frame cycle on the shared
humanoid body so every human character walks.

### Gaits (task `gaits`)

Archetype `gaits` (`run` / `sneak` with their own `ticks_per_step` and
footstep `noise`, `walk` implicit), the gait as entity state (save version
9), `self.gait` in expressions, the footstep noise through the existing
noise events, Shift (hold) / `Z` in the browser and `r` / `z` in the
terminal, a HUD chip, and a `std-needs` system that tires a runner; the
walk cycle simply plays at the step's pace. Idle and activity poses,
per-gait frames and spritesheets remain for `m10-anim-gaits`.

### Local lights (task `local-lights`)

Lighting is per cell through the grid **line of sight** rather than
`tile.exposed` (walls, doors, windows and barricades decide where light
goes, so an indoor lamp stays indoors yet shines out of its window),
`light` on tiles (cell and edge) and archetypes, a lightmap per render
chunk and per-sprite tints that lift the ambient toward the light's
colour; shipped as the town's street lamps, the noir gaslight and the
detective's flashlight, the zombie's flickering lamps, the mansion's
candelabras and the garden's fireflies. Sub-cell interpolation for moving
lights, and lights on items or statuses, are later work.

## Milestone history

What each milestone delivered, in order. The roadmap table in `VISION.md`
has the one-line version.

**S0–M3.** Zombie and vampire have a survival and looting loop (houses and
a mansion with rooms, containers with per-room loot, weighted inventory,
eating/drinking/healing with items), all in YAML, playable in the terminal
and in iso.

**M4.** **Sight** (`opaque` tiles, `can_see`), with an `alert` status on
the NPCs of both genres; **behaviors** (declarative state machines):
zombies wander, chase an `alert`-triggering survivor and give up after
losing sight, while bats roost, flee the vampire and fly home; and
**noise** (`noise` effect, hearing, `heard()`, `investigate`). A survivor
crunching over broken glass or winding up an alarm clock draws the nearby
horde to the spot, and creaky floorboards bring bats over to look.
Questions moved to later milestones: how NPCs use containers and items and
act beyond movement, combat, whether NPCs remember a last known position,
and whether `systems` effects start creating or consuming items.

**M5.** **Timed actions** (spec `m5-timed-actions`), the **context menu**
(spec `m5-context-menu`) and **recipes** (spec `m5-recipes`). Survivors
barricade windows while the dead hear the hammering, cook canned beans on
a kitchen stove and tear rags into bandages; the vampire closes shutters
before dawn, rests on a crypt floor, fills empty vials at the blood font
and mixes blood wine. Right-click a window or a stove across the room and
the character walks up and starts.

**M6.** **Floors** (spec `m6-floors`), **Tiled maps** (spec
`m6-tiled-maps`), **save/load** (spec `m6-save-load`) and the **chunked
world** (spec `m6-chunked-world`). The zombie game is a city built from
house, store, garage, park and road parts around the old town block, with
~960 dead (dense downtown, sparse at the edges) that rest while far away;
the vampire's mansion stands in an estate of graveyards and village
cottages with ~150 bats. Task `roomier-maps` made both roomier: 3-wide
rooms, 2-wide halls, 5-wide roads and yards between buildings, on a
343×343 city and a 128×128 estate (256×256 and 96×96 before).

**M7.** **Overrides and removals** by qualified id (spec `m7-overrides`),
**stacks** with a pack catalog, a resolver and a title screen (spec
`m7-stacks`), and **one town, two mods** (spec `m7-town-base`). The
genre-free `town` base game holds the city, its furniture, food, loot,
cooking, bandages, barricading and a needs-driven `resident`; alone it is
a quiet sandbox with no NPCs. `zombie` is a mod that fills the town with
the dead (map `populate` and `spawns` overrides) and adds a way out;
`vampire` is a mod that reuses the town's generic content (its windows,
needs systems that skip non-`living` entities) but plays on its own estate
by overriding `start`, `clock` and `lighting`; `hardship` is a balance mod
that works with either. Mixed stacks load with warnings only for the
fields both mods write.

**M8.** **Vars, quests and the journal** (spec `m8-flags-quests`),
**dialogues** (spec `m8-dialogues`), **factions and reputation** (spec
`m8-factions`) and **two games from pack data** (spec `m8-social-games`).
`noir`, *Death on Elm Street*, is a night-time murder on the old town
block: question the widow, the lodger, a neighbour and a mob fixer, search
the crime scene, mind the patrol, and name the killer to the sergeant
before dawn. `western`, *High Noon*, is a morning of target practice,
favours and Dutch courage before a duel at noon, settled by a dialogue and
a seeded roll, talked down or paid off. Both are mods of `town`, as
`zombie` and `vampire` are, and the only engine change was a generic one
(YAML `rooms` on Tiled maps). What they taught is recorded under the open
questions in `VISION.md` (patterns worth a stdpack, forms that are awkward
in YAML).
