# isolandia — Vision and early decisions

> Memory document to support writing the specs.
> It is not a spec: it records the *why*, the principles, the roadmap and
> the open questions. Settled questions move to [`DECISIONS.md`](DECISIONS.md)
> (the decision log and milestone history); `docs/` describes how things
> work today. Update this file when a decision changes.

## 1. Goal

A **data-driven** engine for open-world RPGs in **isometric perspective**,
in the vein of *Project Zomboid*: systemic simulation (needs, time, loot,
AI, crafting) in a persistent world built on a tile grid.

The differentiator we are after: building worlds of **completely different
genres** (zombie, vampire, wild west, noir…) **from scratch**, essentially
with **assets + declarative configuration files**, with little need for
scripts. Switching genre should mean switching *pack*, not code.

Realistic target: **80–90% declarative**, with an escape hatch (sandboxed
script hooks) for the rest. Matching Zomboid's scope is not a goal.

**The power ceiling.** A declarative layer is more *composable* and more
*verifiable* than a scripting layer (packs stack, validate before they
run, keep provenance, stay deterministic and survive engine updates), and
it is never more *expressive*. A mod can only do what the vocabulary
admits, and the vocabulary is closed in engine code. The ceiling of what
this engine can ever express is therefore set by the **hook API** (M9),
not by the YAML vocabulary. The two have different jobs: the vocabulary
makes the common 80–90% short, validated and composable; the hooks make
the rest *possible* without giving up determinism, validation or the
sandbox. See §4 for the rules that follow from this, and §5 for the
reference point.

**Scope today:** single player, in a browser, with the same simulation
runnable headless. Multiplayer is an open question (§9) to settle before
the hook API exists.

## 2. Origin: lessons from `rogue-engine`

Sibling project at `~/code/rogue-engine` — a turn-based ASCII roguelike,
fully defined in YAML. It serves as a proof of concept for the declarative
model.

**Reuse (concepts, and possibly ported code):**

| Concept | Where it lives in rogue-engine | Use here |
|---|---|---|
| Generic measurements (`hp` is just another one) | `docs/schema.md`, `src/runtime/state.js` | Hunger, blood, reputation, suspicion… everything is a measurement |
| Expression language | `src/expressions/`, `docs/expressions.md` | Conditions and formulas across the schema |
| Effects pipeline | `src/runtime/effects.js` | Basis of the effects vocabulary (to be expanded) |
| Interaction flows | `src/runtime/flow.js`, `docs/interaction-flows.md` | Context menu (right click) and targeting |
| Tags + load-time validation | `src/config/loader.js` | Even more critical with stacked mods |
| ASCII renderer | `src/renderer/ascii.js` | Debugging/testing the simulation before isometric |
| Spec-driven agent workflow | `AGENTS.md`, `.spec.toml`, `specs/` | Same workflow in this repo |

**Do not reuse:**

- **Immutable per-turn** `dispatch(state, action)` — does not scale to
  continuous ticks with hundreds/thousands of entities.
- **Maps as ASCII strings** — fine for test fixtures, not for the world.

**Lesson learned:** YAML tends to turn into a bad programming language.
E.g. the shrine in `games/pirate.yaml` repeats `when: 'actor.doubloons >= 5'`
across five effects. Defense: **rich primitives** (systems, behaviors,
recipes, loot tables, dialogues, statuses) instead of ever more powerful
generic control flow; and accept script hooks when YAML gets worse than
code.

## 3. Decisions made

1. **Stack: TypeScript.** Simulation in plain TS; renderer with **PixiJS**
   (WebGL); game servable from an HTML page. Desktop later via **Tauri**
   (or Electron) wrapping the same build, if needed.
   - Main reason: the spec-driven agent workflow works best with
     everything in text, headless tests in Node (`node:test`) and visual
     verification via Playwright.
   - Godot was considered (it also exports to web, has a great editor and
     better performance), but in a data-driven engine the editor would be
     largely bypassed. If we ever migrate, **specs, schema and packs
     survive**; only the code is rewritten.
2. **Decoupled simulation:** the core does not depend on the DOM or Pixi.
   It runs in Node (tests), in a Web Worker (browser) or in a desktop
   shell. The renderer is just a consumer of the state.
3. **Fixed-tick time** (on the order of 10 ticks/s) over a **tile grid**;
   movement interpolated only at render time. Mutable state in the
   simulation (no immutable copy per tick).
4. **Namespaced IDs from day one** (`std_needs:hunger`, `vamp:blood`), even
   before a mod system exists.
5. **Two-genre rule:** every milestone is validated with **two mini-games
   of different genres** (e.g. zombie + vampire), to keep genre
   assumptions from leaking into the engine. (The working rules in §4
   build on this.)
6. **World maps edited in Tiled** (JSON) once the world grows; ASCII stays
   valid for fixtures. **Done (spec `m6-tiled-maps`, M6):** maps take
   `tiled: <file>.tmj`; the zombie town and vampire mansion are Tiled maps.
7. **Minimal dependencies**, in the spirit of rogue-engine (YAML parser,
   PixiJS; anything else justified case by case).
8. **Three tiers, GURPS-style** (a generic core + setting supplements, not
   a system with the genre built in like D&D):
   - **Engine (code, genre-free):** vocabulary only — entities,
     components, measurements, statuses, tags, actions with duration,
     systems, behaviors, containers, grid/space, time, expressions. No
     "hunger", "hp", "combat", not even a special "player": the player is
     an entity controlled by input; life and death are measurements and
     rules declared by a pack.
   - **Stdpack (data, optional, "batteries included"):** pieces that
     several genres reuse — needs (hunger/thirst/sleep), health and
     damage, weighted inventory, day/night, melee combat… Each game picks
     what it uses (a noir game can skip combat) and can tune or replace
     any piece.
   - **Genre packs:** zombie, vampire, wild west… they only compose and
     tune the engine and the stdpack; this is where zombies, coffins and
     shuriken live. Since M7 a genre is usually a **mod of a genre-free
     base game** (`zombie` and `vampire` stack on `town`), so switching
     genre is switching mod.

   The rules that keep the tiers apart are in §4.
9. **Thin walls on cell edges**, as in *Project Zomboid* (task
   `edge-walls`). Walls, doors, windows and fences are edge tiles
   (`edge: true`) on the `n` or `w` side of a cell, not cells: a full-cell
   wall took a whole cell of floor and drew as a 64×64 block, which made
   small rooms cramped and hid the player behind every wall. Each cell
   owns its north and west edge (the south and east sides are the
   neighbours'), so storage is two typed arrays beside the cells and the
   hot paths (steps, A\*, sight) stay array reads. A diagonal step needs
   both L routes clear (no corner cutting); a diagonal line of sight is
   blocked only when both are blocked; reach does not cross a
   non-walkable edge. In iso an edge is a thin slab, one image mirrored
   for the two sides. Maps were converted mechanically (`npm run
   map:edges`, kept for modders), keeping sizes and coordinates; saves
   from before (version ≤ 2) are refused. Floors stay cells, doors stay
   always open, and walls do not muffle noise.

The finer-grained decisions (how systems schedule, how saves work, how
overrides merge…) are recorded one by one in [`DECISIONS.md`](DECISIONS.md).

## 4. Working rules

The principles that keep the engine genre-free and the tiers honest. A
spec that breaks one of these says so and why.

1. **Two genres per milestone.** Every milestone is validated with two
   mini-games of different genres; when possible, a very different third
   one (noir with no combat, a space station with oxygen instead of food)
   exposes the assumptions the first two share.
2. **No genre terms in the engine.** Engine code contains no genre or
   stdpack vocabulary; a test that searches `src/` for words like
   `zombie`, `vampire`, `hunger`, `hp` catches leaks, and another keeps
   `src/core` free of Node, DOM and Pixi.
3. **The stdpack has no shortcuts.** Whatever the stdpack does, a
   third-party pack must be able to do the same way: the stdpack uses no
   engine affordance that is not exposed to everyone.
4. **Repeated YAML moves up, never sideways.** When two genre packs repeat
   the same pattern, it moves into the stdpack or becomes a new engine
   primitive. It never becomes generic control flow in YAML (§2).
5. **Primitives are hooks first.** Once script hooks exist (M9), a new
   engine primitive is first implementable as a hook, and is promoted
   into the engine only after it exists as a hook and two packs want it —
   rule 3 applied one level down. Until then, the stand-in: the engine's
   closed dispatches (effect kinds, activity kinds, expression built-ins,
   the completion steps of actions, item uses and recipes) are the
   registries that hooks will plug into, so a new kind of thing goes into
   one of those, not into a fifth place.
6. **The hook API is a contract, not the `World` class.** Hooks see a
   documented, versioned surface, written like the pack schema, with the
   same error reporting (paths, *did you mean*) and the same version
   policy as saves. Nothing internal leaks through it; a rename of an
   engine field never breaks a mod.
7. **The simulation reads no wall clock and no unseeded RNG** — hooks
   included. Everything the sim does is reproducible from the definition,
   the seed and the inputs, and the 1000-tick determinism hash guards it.
   Render-only code may use the wall clock (animation, flicker).
8. **Visual-only additions never feed back into the sim.** The renderer
   is a consumer of `(world state, alpha, wall clock)`; what it adds
   (`lighting`, lights, frames, weather, sound) is ignored by the ASCII
   shell and is neither saved nor hashed. Something the sim should see
   (a gait, a weather var) is a sim primitive first, with a visual on top.

## 5. Reference point: Project Zomboid

What the engine is measured against, from a reading of the shipped build
(Build 42, late 2026). Recorded so that the design choices below are
legible and are not reopened by accident.

**How it is built.** Three layers: a Java engine (about 5,100 classes), a
Lua gameplay layer (about 1,400 files, 440k lines, split into `shared`,
`client` and `server`) and a declarative scripts DSL (about 1,000 files
and 25k definitions: items, models, sounds, recipes, entities, vehicles).
Its modding power comes from one fact: Lua is Turing-complete and a single
class exposes essentially the whole engine to it, with some 180 named
events as the de facto mod API. A modder can add any mechanic without an
engine release.

**What it pays for that.** No namespaces (every Lua value is a global),
no validation before a game runs, no sandbox, conflicts between mods
resolved by load order, no determinism, almost no tests on the Lua side,
and a brittle contract: the engine's internals *are* the API, so updates
break mods. Fourteen years of accretion show as god classes (the character
class alone is close to half a megabyte of bytecode) and as loot tables
kept in Lua files tens of thousands of lines long.

**What we take.** Thin walls on cell edges (§3.9), loot by room tag,
actions that take time and can be interrupted, named events as the shape
of a hook surface (§4.5), and three candidates not yet adopted: recipe
inputs matched by tag with keep/destroy modes and wear flags, a compact
block DSL for high-volume item data where YAML gets long, and a
client/server command split designed in from the start if multiplayer
ever enters scope (§9).

**What we deliberately do not take.** A global namespace, load-order
conflict resolution, unsandboxed scripts, exposing the engine's object
graph as the mod API, and hand-maintained mega data files. Each of these
has a positive counterpart in §3 and §4.

**What we already do that it does not.** Namespaced ids, stack
validation before run (`check`), override provenance, a deterministic
simulation with a hash test, a headless shell, and a test suite the size
of a small engine.

## 6. Target schema primitives (sketch, not final)

The vocabulary as first sketched. Nearly all of it has landed; the
authoritative reference is `docs/packs.md`, and the decisions behind each
piece are in `DECISIONS.md`.

- **measurements** — numeric values with min/max/initial (inherited).
- **statuses** — states derived from thresholds (`hunger > 70 → Hungry`),
  with ongoing effects (the equivalent of *moodles*).
- **systems** — rules that run on their own over time:
  ```yaml
  systems:
    - id: vamp:sunburn
      every: 10s
      for: "has_tag(self, 'vampire')"
      when: "world.is_day and tile.exposed"
      effects:
        - { type: apply, measurement: hp, delta: -2 }
  ```
- **actions** — with `requires`, `flow`, **`duration`** and interruption
  (almost everything in Zomboid takes time and has a progress bar).
- **behaviors** — declarative AI: senses (sight, hearing) + state machine
  or utility AI:
  ```yaml
  behaviors:
    zmb:shambler:
      senses: { sight: 8, hearing: 15 }
      states:
        wander:      { do: random_walk, on: { sees: player -> chase, hears: noise -> investigate } }
        investigate: { do: goto_last_noise, timeout: 30s -> wander }
        chase:       { do: pursue, on: { adjacent: target -> attack, lost: target -> investigate } }
  ```
- **items / containers** — weight, capacity, categories.
- **loot tables** — distribution by **room tag** (`kitchen`, `saloon`…).
- **recipes** — declarative crafting.
- **factions, dialogues, quest flags, journal** — social layer (noir,
  wild west).
- **assets manifest** — sprites/spritesheets referenced by ID.
- **packs** — base + packs that override/extend, validated together.
- **hooks** (M9) — the escape hatch: sandboxed scripts registered at the
  engine's extension points (§4.5), under the contract of §4.6 and §4.7.

## 7. Incremental roadmap

Every milestone ends **playable** and passes the two-genre rule.

| # | Milestone | Playable result | Status |
|---|---|---|---|
| S0 | **Feasibility spike** (before anything else): 4×4 chunks of 32×32 isometric tiles, ~500 entities wandering with A*, player moves by click; measure fps on a mid-range laptop and a phone | Confirms (or not) TS + Pixi | ✅ done¹ |
| M0 | Simulation core: grid, entities, tick loop, measurements, compiled expressions, namespaced YAML loader; **top-down ASCII** render | Walk around and watch measurements change over time | ✅ done |
| M1 | Isometric renderer: tiles, depth sort, camera, click-to-move (A*), assets manifest, directional sprites² | The same game, in iso | ✅ done |
| M2 | Clock, day/night, `systems`, `statuses` | Survive a day with hunger/thirst/sleep | ✅ done |
| M3 | Items, weight, containers, loot tables by room tag | Loot a house | ✅ done |
| M4 | Perception (sight/noise) + `behaviors` | A horde that hears the window breaking | ✅ done |
| M5 | Actions with duration, context menu, recipes | Bandaging, cooking, barricading | ✅ done |
| M6 | Chunked world, multiple floors, Tiled maps, save/load | An explorable small town | ✅ done |
| M7 | Packs/mods: stacking, overrides, joint validation | Zombie and vampire as mods of the same base | ✅ done |
| M8 | Social layer: factions, dialogues, quests, journal | A short noir mystery / a wild-west duel | ✅ done |
| M9 | **Sandboxed script hooks**: a versioned hook API (§4.6) over the engine's registries — effect kinds, activity kinds, expression built-ins, completion steps (§4.5) — in a sandbox that gets the seeded RNG and no wall clock (§4.7) | A mod that needs state the YAML cannot express; candidates: a power or weather grid the sim reads, procedural quests, NPC memory and planning | |
| M10 | Look and feel: animation frames and gaits, local lights, ambient tiles, weather, sound, camera and transition polish | The same town, alive: a sneaking player, lamps in the night, rain on the street, footsteps you hear | ⏳ lights, walk cycle and gaits landed |

¹ S0: the headless simulation benchmark is measured; the **browser fps**
numbers (mid-range laptop and phone) are still **pending** — the manual
table and `docs/bench/spike.json` still need to be filled in on a real GPU
(`npm run bench`, or `BENCH_CDP` to attach Windows Chrome from WSL; see
`docs/spikes/s0-results.md`, "Browser benchmark", and `docs/perf.md`,
"Browser"). The spike's verdict is only confirmed after that.

² Added after M1 (spec `iso-directional-sprites`): 4/8-way assets with
mirroring, character facing (simulation state since spec `turn-before-move`),
legend `facing` for tiles; see `DECISIONS.md`.

## 8. Risks

- **Isometric art is expensive**, and it is what makes one genre *look*
  like another. Start with placeholders (colored blocks, Kenney packs)
  until ~M4. *Update (M10):* animation multiplies it. A character is 5
  drawings today; three gaits of ~6 frames plus idle is ~100. The
  generator (`art/characters.mjs`, one text grid per drawing) is the
  mitigation: a frame is a grid edit, not a new painting, and every pack
  that shares the humanoid body gets the frames at once.
- **Performance:** compile expressions to closures at load; per-chunk
  depth sorting; NPCs beyond an active radius go dormant (M6). Measured on
  the 343×343 zombie city with 961 entities (`docs/perf.md`): **0.26 ms avg,
  0.46 ms p95 per tick** in Node (0.44 / 0.72 ms without dormancy), far
  under the 10 ms target. Browser fps on the city is still a manual
  follow-up (as in S0). LOD for drift and systems is not needed yet.
- **Scope:** Zomboid has more than a decade of development. The target is
  a small core in which switching genre = switching pack.
- **YAML creep** (see §2): prefer new primitives or script hooks over ever
  more complex generic conditionals.
- **God files.** `src/core/sim/world.ts` and `src/core/load/load.ts` are
  each near 3,000 lines and `definition.ts` past 1,200 — the trajectory
  that produced Zomboid's half-megabyte character class (§5). Mitigation:
  split the loader by domain and the world by phase while it is cheap,
  ideally as part of turning the closed dispatches into registries
  (§4.5), since that work touches the same switches.
- **The hook API as a compatibility surface.** Once mods can script,
  every renamed field or reordered phase breaks someone, and the engine
  loses the freedom it has today to refactor behind the YAML. Mitigation
  is §4.6: a narrow, versioned contract decided *before* the first hook
  ships, with the same deprecation policy as save versions, and a test
  that the shipped packs' hooks still load.
- **Mods in the browser:** installing third-party mods requires a zip
  upload or the File System Access API; with Tauri it becomes a normal
  folder.

## 9. Open questions

Only the open ones; what has been decided is in `DECISIONS.md`.

- **Script hooks (M9).** Three questions, in order:
  - *Evidence.* The M8 games and the pack survey found nothing that needs
    a hook — every awkward form is a missing primitive (below). M9's mod
    has to need real logic, state the YAML cannot express, and the spec
    should name it before picking a language. Candidates: a power or
    weather grid with its own state that systems and expressions read;
    procedural quest generation; NPC memory and planning beyond the
    state machines.
  - *Surface.* Where hooks attach (§4.5): the effect, activity and
    built-in registries and the completion steps, plus named events in
    the shape of the step/noise triggers that already exist. What a hook
    may read and write, and how its errors are reported, is the contract
    of §4.6.
  - *Language.* Sandboxed JS (a Worker, `ShadowRealm`, or QuickJS in
    WASM for memory limits and determinism) or Lua (wasmoon/fengari). The
    arguments already in this file lean to JS: a TypeScript stack, a
    browser target, headless Node tests, and typed hook signatures for
    free. The constraint that shapes the API more than the language is
    §4.7: hooks get the seeded RNG and never see `Math.random` or `Date`.
    To be settled by the M9 spec.
- **Multiplayer: in or out of scope?** The intent and snapshot types
  already lean toward a client/server shape, and Zomboid retrofitted its
  split at a cost (§5). A hook contract designed for one player is hard
  to retrofit for several, so the question should be answered, even as
  "not before M12", before M9 freezes the hook API.
- **Combat:** real time over ticks, or something more tactical?
- **Stdpack candidates left after M7** (`m7-town-base`): patterns the
  `zombie` and `vampire` mods still both define, such as a
  sight-and-sound NPC state machine. Not moved yet; a third genre that
  repeats them should promote them to a stdpack.
- **What the two M8 games taught** (spec `m8-social-games`: `noir` and
  `western`, both mods of `town` written from pack data alone; the one
  engine change was generic: YAML `rooms` on a Tiled map are added to its
  room objects, so a mod can tag a part's cells). **Patterns both
  repeated**, candidates for a stdpack or a shorter form:
  - *A named NPC who waits at home and talks.* Nine of the twelve new
    archetypes have no behavior at all: a `spawns` entry, a `faction` and a
    `dialogue`. That is already minimal; the one worth sharing is "wait,
    then go somewhere on a cue" (Black Jack: `idle` until `heard`, then
    `investigate`, then `idle`), with the cue a `noise` from a system.
  - *A `start` list that dispatches on state*: quest over → `closed`,
    `hostile(npc, player)` → `refuses`, a var for "already talked" →
    `again`. Every dialogue of both packs opens this way.
  - *A favour or a bribe*: one choice with `consume`/`give`, a `set_var`
    that marks it done, a `reputation` with `spread`, and a `to`. The doc,
    the kid, the bartender, Mickey and the widow are all this shape.
  - *The accusation*: choices gated by `in_journal(...)` with one shared
    `unavailable` line, each firing a `quest` effect to an end stage; the
    duel's three ways out are the same shape with `when`s on reputation and
    items.

  **Awkward in YAML** (none needs a script hook; each is a missing
  primitive or a verbose form):
  - *Two choices with the same text and exclusive `when`s* (the duel's
    *Fire!* → `won` or `shot`) read as a trick. An argument for a
    conditional `to` (a list of `{ when, node }`, as `start` already is);
    not added in M8.
  - *A composite map takes no `spawns`*, so Mickey and the bartender are
    placed with a one-cell `populate` rect in city coordinates.
  - *Counting clues* is a sum of seven `in_journal(...)` terms; a count by
    journal category would be one call.
  - *An NPC cannot touch the player's measurements*: the riders count
    themselves into a `crowded` var (`add_var`, one system for riders) and a
    player system drains `nerve` from it, relying on systems running in
    definition order. An effect target would be direct.
  - *Deadlines* are arithmetic on `world.day` and `world.time_of_day`
    (`world.day >= 2 and world.time_of_day >= 6` for dawn); a clock
    comparison would read better.
  - *A measurement as a timer* (`liquor`, `rate: -1`, drives `tipsy`) works
    but has to be hidden from the HUD by hand.
  - The duel's odds (about 90 % prepared, 30 % cold) took a Monte Carlo over
    300 seeds in a test to tune a one-line formula; a tool for that would
    be a nicety, not a hook.
- **YAML pain points still open** from the post-M8 survey (the decided
  ones are in `DECISIONS.md`, *Pack ergonomics after M8*):
  - *One-shot triggers are hand-built*: first quest stages use `when:
    "true"` (systems have `once: true` now). Social games will multiply
    these.
  - *Every item and archetype spells `sprite: <id>_img`*; a default would
    remove a line per entry.
  - *Nested overrides still copy*: `kitchen_food` is restated to change
    weights. Terms on nested values, list operators, or **pack
    parameters** read by expressions are the candidates; a pack parameter
    spec waits for a third mod that needs a value that is not a scale of
    an upstream one.
- How much of the ASCII renderer survives as a permanent debugging tool?
- **How does the iso view get richer without leaving pre-rendered
  sprites?** **Proposed (M10, specs `m10-*`):** six additions, each a
  pack-level schema entry the loader validates, so that a third-party pack
  gets them too. All but the first are **visual only** under §4.8. **No
  real-time 3D, no skeletal animation, no change to the projection or to
  the pixel-art rules** in `docs/art.md`. Landed so far (details in
  `DECISIONS.md`, *M10*): the walk cycle (task `walk-cycle`), gaits (task
  `gaits`) and local lights (task `local-lights`).
  - **Frames and gaits** (spec `m10-anim-gaits`). The one piece that
    touches the sim: a per-entity **`gait`** (`walk`, `run`, `sneak`), now
    landed as simulation state with footstep noise through the existing
    noise events. Remaining: assets gain **`animations`** beyond `walk`
    (`run`, `sneak`, `idle`, plus activity poses) as frame lists per drawn
    facing or a spritesheet with a frame size, normalized by the loader to
    `[facing][frame]` under the same mirroring rules as `directions`; the
    renderer picks a **pose** `(animation, facing, frame)`, locomotion
    frames from the step progress so feet stay locked to the ground, idle
    and activity poses from the wall clock. Smooth turns ride on the same
    pose function.
  - **Local lights** (spec `m10-local-lights`). Landed as task
    `local-lights`: per-cell lighting through the grid line of sight,
    `light` on tiles and archetypes, a lightmap per render chunk.
    Remaining: sub-cell interpolation for moving lights, lights on items
    or statuses.
  - **Ambient tiles** (spec `m10-ambient-tiles`). Tile assets with
    `animations` too: water, neon, a flickering TV, swaying grass, chimney
    smoke, stepped from the wall clock. Chunks keep a short list of their
    animated sprites and swap textures only on that list.
  - **Weather** (spec `m10-weather`). Pack `weather` entries keyed to the
    clock as `lighting.tint` is: rain, snow, leaves, dust, fog as a
    particle layer, drawn only over `exposed` cells, with wind driving the
    sway tiles above. Visual only in this step; a sim-visible `weather`
    var is a later decision — and a candidate for M9's evidence mod.
  - **Sound** (spec `m10-sound`). Not graphics, but the largest perceived
    jump for the cost: the sim already emits positioned **noise events**
    (footsteps, glass, screams). A pack maps noise kinds to clips and names
    ambient loops per time of day; the browser shell plays them with
    distance attenuation. Nothing in the sim changes.
  - **Polish** (spec `m10-polish`, small items that fit one spec): a
    separate shadow sprite under entities and blocks, skewed by the tint
    schedule; eased camera follow, a brief shake on a loud noise nearby;
    fades on load, floor change and the cutaway; a pixel-art rim on the
    hovered target and an animated path marker.
  - Order: frames and gaits (with activity poses), ambient tiles,
    weather, sound, polish anywhere in between. M10 touches the renderer
    and the asset schema, so it can run alongside M9.

## 10. Next step

**M9, sandboxed script hooks**, authored via `spec-orchestrator`. The spec
has to answer the three questions in §9 in order — pick the evidence mod,
define the surface and the contract (§4.5–§4.7), then the language — and
it is the milestone that decides the engine's ceiling (§1). The
registries it needs are the natural moment to split the god files (§8).

In parallel, **M10, look and feel**, continues one `m10-*` spec at a time
(§9): frames and gaits with activity poses next, then ambient tiles,
weather, sound and polish. Visual only except for what has already landed
in the sim, so it needs no decision that M9 waits on.

The milestone history (what S0 through M8 delivered) is in
[`DECISIONS.md`](DECISIONS.md#milestone-history).
