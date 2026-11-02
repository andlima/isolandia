---
id: local-lights
area: iso
priority: 40
depends_on: []
description: "Local lights (M10): tiles (cell and edge) and archetypes declare `light: { radius, color?, flicker? }`; the iso scene lights cells per tile, Zomboid style, from a Pixi-free lightmap per render chunk where a light reaches a cell within its radius with a clear grid line of sight (walls block, windows and doorways pass, floors never leak), lifting the day/night tint toward the light's colour per sprite instead of the two container tints; entity lights move with their entity, flicker is a deterministic wall-clock jitter; the town gets pixel-art street lamps on its roads, noir gaslight and a detective's flashlight, zombie flickering lamps, the vampire's mansion candelabras and the garden fireflies. Visual only: sim, saves, hashes and ASCII untouched."
---

# Local lights

## Goal

At night the whole scene is one colour: `lighting.tint` multiplies the
ground and object containers and nothing in the town pushes back against
it. This task adds **local lights**, the first visual item of M10 in
`VISION.md` §7: a pack puts a `light` on a tile (a street lamp, a
candelabra, a lit window) or on an archetype (a flashlight, a firefly), and
the isometric view lifts the night tint around it. Lamps on the street,
candles in the mansion, fireflies over the flower beds.

Lighting is **per cell**, as in Project Zomboid: a light reaches a cell
when the cell is within its radius and the existing grid line of sight
from the lamp's cell is clear, so a wall throws a hard shadow, a window or
an open doorway lets the light spill out, and an upstairs lamp never
lights the floor below. Each sprite is tinted uniformly with its cell's
light, which suits the 2 px pixel art and keeps the maths in a pure,
headless-tested module next to `chunks.ts`, `pick.ts` and `cutaway.ts`.
Screen-space light blobs were considered and rejected: they ignore walls
and floors, light what is behind an object on screen rather than its cell,
and draw smooth gradients over pixel art.

Engine code stays genre-agnostic (`VISION.md` §3): the engine knows a
light as a radius, a colour and a flicker amount; which tiles and
creatures glow, and how, is pack data. Like `lighting`, lights are
**visual only**: the simulation and expressions never see them, nothing
about them is saved or hashed, and the ASCII shell ignores them.

## Acceptance Criteria

### Pack schema (`docs/packs.md`)

1. **New field `light`** on tiles and archetypes, an optional mapping
   `{ radius, color?, flicker? }`:
   ```yaml
   tiles:
     - id: street_lamp
       label: Street lamp
       glyph: "i"
       color: "#d8d070"
       walkable: false
       opaque: false
       sprite: street_lamp_img
       light: { radius: 5, color: "#ffe6b8" }
   archetypes:
     - id: firefly
       # …
       light: { radius: 1.5, color: "#c8ff80", flicker: 0.5 }
   ```
   - `radius` is **required**, a number in `[0.5, 12]`, in tiles. Below
     `0.5` or above `12` (`MAX_LIGHT_RADIUS`, exported from
     `src/core/definition.ts`) is a load error naming the bound; the cap
     bounds the per-chunk work (criterion 9).
   - `color` is a `#rrggbb` string, default `#ffffff`; the existing
     `HEX_COLOR_RE` check and message apply.
   - `flicker` is a number in `[0, 1]`, default `0`: how much of the
     light's intensity the flicker takes away at its dimmest (criterion 8).
   - Unknown keys inside `light` are load errors with a *did you mean*, as
     elsewhere; a `light` that is not a mapping is an error at the key with
     the path (`tiles[3].light`).
   - `light` is allowed on **cell tiles and edge tiles** alike (a lit
     window is an edge light, criterion 6); it is not allowed on items (an
     item is not in the tile table or the archetype table, so no new check
     is needed).
2. **Definition.** `LightDef { radius: number; color: number /* 0xRRGGBB */;
   flicker: number }` lives in `src/core/definition.ts` next to `SenseDef`
   and `GaitDef`. `TileDef` and `ArchetypeDef` gain `light: LightDef |
   null`. The loader parses it with one `light(f)` helper beside
   `senses(f)`, used by `tile()` and `archetype()` (the field joins both
   `fields` lists).
3. **Overrides.** `light` is an ordinary top-level field: replaced whole
   with `override: true`, `light: null` removes it, and `check --overrides`
   lists it like any other field. `docs/packs.md` says so in the
   overrides paragraph that lists `senses` and `gaits`.

### Lightmap (`src/iso/lights.ts`, Pixi-free, tested headless)

4. **Sources.** A light source is a cell `(x, y, z)` plus a `LightDef` and
   a flicker seed. Tile lights come from the grid: every cell whose tile has
   a `light` is a source at that cell (seed: the cell index); every edge
   with a lit edge tile casts from **both** cells it separates (criterion
   6). Entity lights come from entities whose archetype has a `light`,
   at the cell of their rendered position (the same `floorOf` rounding the
   scene uses for sprites; seed: the entity id). Dormant entities count like
   any other: a sleeping zombie's lamp still shines; what matters is whether
   its cell is near a built chunk.
5. **Reach and falloff.** A source lights a cell `c` on **its own floor**
   when `d = dist(source cell centre, c centre) < radius` and
   `lineOfSight(grid, source, c)` holds (`src/core/sim/sight.ts`: opaque
   cells and opaque edges block, the source's own cell is always lit,
   floors never see each other). Its intensity there is `1 − d / radius`.
   A door tile, open and not opaque, passes light; a barricaded or
   shuttered window (opaque) stops it; a window passes it. `tile.exposed`
   is **not** consulted: the walls, doors and windows themselves decide
   where light goes, which is stricter than the exposure idea in
   `VISION.md` §7 (an indoor lamp stays indoors, yet shines out of its
   window). Light is never blocked by entities.
6. **Edge lights spill both ways.** A lit edge tile casts from each of the
   two cells it separates with the same radius; a cell takes the **stronger**
   of the two casts, not their sum, so the window itself is not twice as
   bright. The casts are then combined with other lights as below.
7. **Combination.** Where several distinct sources light a cell, the
   intensity is `I = 1 − Π(1 − Iₖ)` (two lamps never exceed full) and the
   colour is the intensity-weighted mean of their colours, per channel. A
   cell nobody reaches has `I = 0` and is not stored.
8. **Flicker.** `flickerAt(seed, nowMs, amount)` returns a factor in
   `[1 − amount, 1]`, piecewise constant over 100 ms slots, from an integer
   hash of `(seed, slot)`; it is deterministic (the same inputs give the
   same value on every platform, so tests can assert it) and `amount = 0`
   returns exactly 1 without hashing. A source's intensity is multiplied by
   its factor before combination. A chunk with a flickering source in reach
   is recomputed only when one of those sources' slot changes (at most 10
   times a second), not every frame.
9. **Per-chunk lightmap.** `computeChunkLight(grid, chunk bounds, sources,
   nowMs)` returns the lit cells of one render chunk: for each, the index,
   `I` and the colour. Tile sources are gathered by scanning the cells of
   the chunk grown by `MAX_LIGHT_RADIUS` on the same floor (at most
   `(16 + 24)² = 1600` cells per chunk); entity sources are the frame's
   list (criterion 12) filtered to that range. The whole thing is
   allocation-light (typed arrays or reused arrays) and, for a chunk with a
   handful of sources, well under a millisecond.
10. **Cell tint.** `litTint(ambient, color, I)` is, per channel,
    `ambient + (max(ambient, color) − ambient) × I`, rounded: a light only
    ever **lifts** the ambient tint toward its colour and never past it, so
    a white lamp restores a sprite's own colours at night and is invisible
    at noon (`ambient` white), and a warm lamp never tints a sunny street.
    Without a `lighting` domain the ambient is white and lights show
    nothing; `docs/packs.md` says so.

### Scene (`src/iso/scene.ts`)

11. **Per-sprite tints replace the container tints.** `ground.tint` and
    `objects.tint` stay white. Every tile, block, edge, pile and entity
    sprite in a **visible** built chunk gets `sprite.tint` = its cell's
    `litTint` (the ambient tint itself where the cell is unlit); markers
    stay untinted and `FADE_ALPHA` is unchanged. An edge slab takes the
    **brighter** (higher `I`) of the two cells it separates; a sprite on a
    hidden built chunk is left alone and marked stale, so showing the chunk
    refreshes its tints. A chunk's sprite tints are rewritten only when the
    ambient tint changed since its last refresh, its lightmap changed, or
    it just became visible; a still scene at noon with no lights costs
    nothing, as today. Entities and piles compare-and-set their tint every
    frame from the cell they are rendered in (a few ops per visible
    sprite, no allocation).
12. **Dirty tracking.** A built chunk's lightmap is (re)computed when the
    chunk is built; when `world.tileVersion` changes (every built chunk:
    a barricade or a shutter changes where light goes, and map edits are
    rare); when an entity source's cell or floor changed since last frame
    (the chunks within `MAX_LIGHT_RADIUS` of its old and new cells); or when
    a flickering source in its reach changed slot (criterion 8). The scene
    builds the frame's entity source list in the entity loop it already
    runs (`archetype.light !== null`, a handful of entities); an entity
    source whose cell is **not** in a built chunk still lights the built
    chunks it reaches.
13. **Stats.** `SceneStats` gains `lights` (sources, tile and entity, that
    reached at least one built chunk this frame) and `litChunks`
    (built chunks with a non-empty lightmap). The F3 perf line
    (`src/web/perf.ts`) appends `lights N` and `lit M`; `docs/ui.md`'s F3
    row mentions them. The bench (`src/web/bench.ts`, `scripts/bench.mjs`)
    needs no new field: its frame times now include the lighting cost.
14. **Nothing else moves.** Depth sorting, culling, the chunk LRU, picking,
    the cutaway and the walk cycle are unchanged; `src/iso/tint.ts` keeps
    `sceneTint` as the ambient. The ASCII renderer, `hud.ts`, snapshots,
    hashes and saves are untouched (`SAVE_VERSION` stays 9).

### Packs and art

15. **town: street lamps.** A new raised tile `street_lamp` (label *Street
    lamp*, not walkable, `opaque: false`, `light: { radius: 5, color:
    "#ffe6b8" }`) with pixel art in `art/town.mjs` (a 64×64 raised image:
    a post on a full-cell base, a lamp head whose glow pixels may use
    `fill-opacity`, within the town's 32-colour cap; the palette has 30
    colours today). Placed in the Tiled road parts (`road_h.tmj`,
    `road_v.tmj`: a tileset entry and `ground` cells) on the **outer**
    rows or columns of the 5-wide road, every 15 cells, alternating sides,
    so the roads keep three clear lanes and every road segment of the city
    shows lamps; and on `town_center`'s road (two lamps, within sight of
    the player's start at [171, 171]). `packs/town/maps/README.md` records
    the rule. The city stays connected: `test/town.test.ts` passes (the
    implementer adjusts any assertion that counted road cells, nothing
    else). The `zombie-kenney` skin needs no change (the lamp keeps its
    pixel art).
16. **noir: gaslight and a flashlight.** `noir` overrides `town:street_lamp`
    with `light: { radius: 5, color: "#c8e6a0" }` (gaslight green, the
    rest of the tile unchanged) and the existing `town:resident` override
    (the *Detective*) gains `light: { radius: 3, color: "#fff2c8" }`: the
    shipped **entity light**, moving with the player, blocked by walls.
17. **zombie: failing power.** `zombie` overrides `town:street_lamp` with
    `light: { radius: 5, color: "#ffe6b8", flicker: 0.6 }`: the shipped
    **flicker**.
18. **vampire: candelabras.** A new raised tile `candelabra` (not
    walkable, `opaque: false`, `light: { radius: 3, color: "#ffc890",
    flicker: 0.25 }`) with art in `art/vampire.mjs` **within the existing
    32 colours** (the pack is at the cap; the candle item's colours serve),
    placed in `mansion.tmj` (tileset entry plus cells): two in the great
    hall, one in the library, one in the cellar, against walls, never
    blocking a doorway or a 2-wide passage. `packs/vampire/maps/README.md`
    lists them.
19. **garden: fireflies.** A new archetype `firefly` (glyph `'`, tags
    `[bug]`, `ticks_per_step: 3`, `ticks_per_turn: 0`, no measurements, no
    senses, `light: { radius: 1.5, color: "#c8ff80", flicker: 0.5 }`) with
    behavior `firefly`: `initial: rest` (`idle`); `rest` goes to `drift`
    (`wander`, `radius: 3`) on `not world.is_day`; a behavior-level `on`
    sends `drift` to `return` (`home`, `done: rest`) on `world.is_day`. Art
    in `art/garden.mjs` **within the existing 32 colours**: five drawn
    facings of a 32×48 character image, each a few glowing pixels floating
    above a one-pixel shadow (the art tests require every archetype to be
    8-way and 32×48; `firefly` joins `STILL` in `test/art.test.ts` so no
    walk frames are expected). Six fireflies spawn on flower cells through
    a new legend letter in `maps/garden.yaml`, spread over the beds. By day
    they rest in the flowers, barely visible; the garden's night (clock
    start `07:00`, default dusk) shows them drifting and blinking.
20. **`check`** runs clean on every shipped stack (`npm run check`), and
    `check --overrides` lists `light` for the noir and zombie lamp
    overrides.

### Tests, verification, docs

21. **Tests** (`node:test`, headless), in `test/lights.test.ts`:
    - Loader: the happy path on a tile, an edge tile and an archetype
      (defaults `#ffffff` and `0`, colour parsed to a number), and each
      error of criterion 1 asserting file, path and message; `light: null`
      in an override removes it; `MAX_LIGHT_RADIUS` is the bound in the
      message.
    - Lightmap: falloff values at distances 0, 1 and `radius`; a cell
      beyond `radius` or across an opaque edge or an opaque cell is unlit
      while one behind a window or through a doorway is lit; an edge light
      lights both sides and its own two cells are not doubled; two lamps
      combine to `1 − (1 − a)(1 − b)` with the weighted colour; a source on
      floor 1 lights nothing on floor 0; an entity source outside the chunk
      but within radius lights the chunk; `flickerAt` is deterministic,
      stays in `[1 − amount, 1]`, is constant within a slot and `1` for
      amount `0`; `litTint` lifts toward `max(ambient, color)` and leaves a
      white ambient alone.
    - Scene bookkeeping (pure parts): which chunks an entity source dirties
      when it moves a cell; a flicker slot change dirties only chunks in
      reach.
    - Packs: the town stack has street lamps on every `road_h` and `road_v`
      placement and two on `town_center`; the noir lamp is green and the
      detective lit; the zombie lamp flickers; the mansion has four
      candelabras; the garden spawns six fireflies whose behavior leaves
      `rest` at night (a short scenario run across dusk).
    - `test/art.test.ts` (coverage, 8-way, sizes, palette caps) passes with
      the three new drawings.
22. **`npm test`, `npm run typecheck`, `npm run check` pass.** `npm run
    smoke` and `npm run bench` are reported as not runnable in the sandbox
    if Chromium still cannot start there, not as passing. If they can run,
    report the zombie bench's frame p95 before and after (the sweep passes
    lit roads).
23. **Docs.**
    - `docs/packs.md`: the `light` row in the tile table (§ `tiles`) and
      the archetype table (§ `archetypes`), a `#### Local lights`
      subsection under `### lighting` (the fields and bounds, the
      line-of-sight rule with the window and barricade examples, edge
      spill, combination, flicker, the "lifts toward the colour" rule and
      its consequence that lights show nothing without a tint, the
      override rule, the examples above), and the two tables of §
      *Shipped packs* mentioning lamps, gaslight, flashlight, candelabras
      and fireflies.
    - `docs/iso.md`: the *Day/night tint* section becomes *Lighting*: the
      ambient tint as today, then local lights (per-cell, per-sprite tints,
      what triggers a refresh, the cost model, the F3 numbers).
    - `docs/art.md`: a line in *Light and shading* on drawing light sources
      (the glow is in the art, the light is in the data; `fill-opacity` for
      glow pixels), and the palette sections for town, vampire and garden
      updated with any new colour names.
    - `docs/ui.md`: the F3 row.
    - `VISION.md` §7, the *Local lights* bullet: a note that it landed as
      task `local-lights` (per-cell lighting through the grid line of sight
      rather than `tile.exposed`, `light` on tiles and archetypes, the
      shipped lamps, flashlight, candelabras and fireflies) and that
      sub-cell interpolation for moving lights and lights on items or
      statuses are later work; §5's M10 row stays open.

## Out of Scope

- Lights on items or statuses (a flashlight you switch on, a dropped
  candle on a ground pile), and any sim-visible light level (`tile.lit`,
  NPCs that avoid the light). The data model allows both later.
- Smooth, sub-cell light for moving entities (interpolating between the
  four nearest cells); light stepping cell by cell is accepted.
- Shadows, light blocked by entities, coloured ambient changes by room,
  windows glowing from inside at night (a pack can do it with `light` on a
  window tile; none ships it).
- Ambient tiles, weather, sound, the rest of M10 (`VISION.md` §7).
- Touch or keyboard controls, HUD changes, the ASCII shell.
- Lights in the `zombie-kenney` skin beyond inheriting the town's lamps.

## Design Notes

- **Why per cell and line of sight.** `lineOfSight` already encodes what
  blocks sight: opaque cells, opaque edges, no corner peeking, floors
  isolated. Light is the same geometry, so reusing it gives walls, doors,
  windows, barricades and shutters the right behaviour with no new tile
  fields, and keeps the lamp inside the house, which is what the exposure
  idea in `VISION.md` was for. `tile.exposed` would light a street lamp's
  whole radius through a house wall as long as both cells were outdoors or
  both indoors; it is the wrong primitive here.
- **Why "lift toward the colour".** Pixi's tint is a multiply with a white
  ceiling, so a light cannot make a sprite brighter than its own colours;
  `ambient + (max(ambient, color) − ambient) × I` is the strongest lift
  that stays within that ceiling and makes a lamp vanish in daylight
  without a special case. A pack that wants a visible glow in a bright
  scene draws it in the art.
- **Why per-sprite tints, and the refresh rule.** Pixi multiplies a child's
  tint by its parent's, but the lifted tint of a lit cell is brighter than
  the ambient, so it cannot be expressed as a child tint under a tinted
  container (a channel ratio above 1 is not a tint). Hence the containers
  go white and each sprite carries its cell's colour. The cost is a tint
  write per sprite in visible chunks whenever the ambient changes, which
  during dawn and dusk is most frames: a few thousand writes at zoom 1,
  tens of thousands fully zoomed out. Refreshing only visible chunks, and
  only when something changed, keeps a still noon scene free; the bench's
  dusk numbers are the check. Do not refresh hidden built chunks eagerly.
- **Lightmap storage.** Keep it per built chunk, next to the `Chunk`
  record (`lit: Map<cellIndex, { i, color }>` or two typed arrays of 256
  entries), not per grid cell: the LRU already bounds built chunks, and an
  unbuilt chunk needs no light.
- **Entity sources near chunk edges.** A flashlight carrier standing just
  outside a built chunk still lights it; gather entity sources for a chunk
  by distance to the chunk's cell bounds, not by the chunk they stand in.
  The entity loop in `update` already visits every entity to decide
  sprites; collect the few lit ones there.
- **Edge sprite tint.** An edge belongs to cell `(x, y)` but separates it
  from `(x, y − 1)` or `(x − 1, y)`; taking the brighter cell avoids a dark
  wall between two lit rooms and a lit wall seen from a dark one looks like
  light falling on it.
- **Flicker hash.** Any small integer mix (e.g. a 32-bit xorshift of
  `seed * 73856093 ^ slot * 19349663`) mapped to `[0, 1)` works; the
  requirement is determinism and cheapness, not quality. The slot is
  `floor(nowMs / 100)`; the scene passes the same `now` it gets from
  `update`.
- **Lamps on roads.** Placing lamps on the road's outer rows keeps every
  part's size and coordinates and needs no change to `city.yaml`; the
  road parts are plain JSON, so a short script or hand edit adds the
  tileset entry (`image` `../../assets/street_lamp.svg`, property `tile`
  `street_lamp`) and the cells. `town_center.tmj` already has a tileset
  with several tiles; add the lamp the same way.
- **Palette caps.** `vampire` and `garden` are at 32 colours (tested); the
  candelabra and the firefly must be drawn from existing names (the
  candle's `#f0e8c0`-like tones, the garden's flower yellows and greens).
  `town` has two free slots for a lamp glow.
- **Art test lists.** `firefly` goes in `STILL`; `street_lamp` and
  `candelabra` are not furniture (single image, no `facing`), so
  `FURNITURE` is unchanged.

## Agent Notes

- Read first: `AGENTS.md`, this spec, `specs/tasks/gaits.md` and
  `specs/npc-perception.md` (the loader, override and docs pattern for a
  new optional mapping field), `specs/tile-exposure.md` (how edges and
  exposure were threaded through the loader and docs), `src/iso/scene.ts`
  (chunks, `fillChunk`, `syncTiles`, the tint block in `update`, the
  entity loop), `src/iso/chunks.ts` (the Pixi-free bookkeeping style to
  copy for `lights.ts`), `src/core/sim/sight.ts`, `src/core/lighting.ts`,
  `src/iso/tint.ts`, `src/core/load/load.ts` (`tile()`, `archetype()`,
  `senses()`, `lighting()` for `HEX_COLOR_RE`), `src/web/perf.ts`,
  `test/art.test.ts`, `docs/art.md` (the generator), `art/town.mjs`,
  `art/vampire.mjs`, `art/garden.mjs`, `packs/town/maps/README.md`,
  `packs/vampire/maps/README.md`, `docs/packs.md` (`tiles`, `archetypes`,
  `lighting`, overrides, Tiled maps).
- Order: `LightDef` + loader + tests → `lights.ts` (sources, reach,
  combination, flicker, `litTint`) + tests → scene (lightmap per chunk,
  dirty tracking, per-sprite tints, stats) → F3 line → town lamp art +
  tile + road parts → noir and zombie overrides → vampire candelabra art +
  tile + mansion → garden firefly art + archetype + behavior + spawns →
  pack tests → `npm run check` on every stack → docs and VISION.
- Regenerate art with `node scripts/pixel-art.mjs <pack>`; never edit the
  SVGs by hand. A `--preview` contact sheet helps judge the lamp head.
- The `zombie` and `noir` lamp overrides restate `radius` and `color`
  because `light` is replaced whole.
- Chromium cannot start in the sandboxed shell, so `npm run smoke` and
  `npm run bench` fail for that reason; say so in the report instead of
  retrying.
- Frontmatter note: the `description` is quoted because it contains `: `.
