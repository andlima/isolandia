---
id: npc-movement
area: sim
priority: 30
depends_on: []
description: M4 groundwork — make movement intents per-entity instead of player-only (`queueIntent(intent, entity?)`, per-entity pending intent and `lastGoto`, deterministic id-order application), so any entity can step or walk an A* path; no AI yet
---

# Per-entity movement intents (M4 groundwork)

## Goal

Today `World` holds a single pending `intent` and only ever moves
`world.player`, so the shamblers and crawlers spawned by `town.yaml` never
move. M4 (perception + `behaviors`) needs every entity to be movable the same
way the player is. This task generalizes the movement intent machinery to
**any entity** without adding any AI: something outside the sim (tests, and
later M4 behaviors) decides *which* intents to issue, and the world applies
them deterministically. It also follows VISION decision 8, where the player
is just an entity controlled by input.

The player keeps behaving exactly as it does now. The browser and the
terminal shells need no functional change.

## Acceptance Criteria

### World API (`src/core/sim/world.ts`)

- `Entity` gets a pending **`intent: Intent | null`** (initially `null`) and
  a **`lastGoto: GotoRecord | null`** (initially `null`).
- `queueIntent(intent, entity?)`: `entity` defaults to `world.player`.
  Otherwise the semantics stay as they are: ignored after defeat, a zero step
  is ignored, and the latest intent wins until it is applied. The intent is
  stored on the target entity. An entity that does not belong to this world
  throws.
- `world.lastGoto` keeps working for the shells as a **read-only getter**
  that returns `world.player.lastGoto`. The existing `src/web/main.ts`
  identity check (`world.lastGoto !== lastGoto`) must keep working, so each
  resolution is still a new object.
- The private world-level `intent` field goes away.
- Intent application (the current `applyIntent`) runs **for every entity, in
  ascending id order** (the player is id 0), in the same phase as before
  (phase 1, before the queued actions). Per entity it does what the player
  path does today: resolve `goto` into a path (A*, with `adjacent`), cancel
  the path on `step`, count the cooldown down, then take a step or advance
  the path. The resolved goto goes into that entity's `lastGoto`.
- Entities with no intent and no path keep doing nothing except counting
  their `moveCooldown` down, so idle NPCs behave as they do now. The
  per-entity loop must not allocate or run A* for idle entities.
- Entities still **do not block each other**: `canStep` stays tile-only.
  Whether entities occupy or block cells is an M4 decision.
- Queued **actions** (`take`/`put`/`drop`/`use`) stay player-only; this task
  does not touch them.

### Snapshot / determinism

- `EntitySnapshot` gains `intent` and `lastGoto`. `WorldSnapshot` drops its
  top-level `intent` and `lastGoto`, since they now live on the player's
  entity snapshot. The snapshot must still round-trip through
  `JSON.stringify`.
- Same definition + seed + intents (including NPC intents) ⇒ same hash.
- For a run that only queues player intents, the positions, measurements,
  statuses, containers and tick of every entity match the pre-change
  behavior exactly. The hash string itself may change because the snapshot
  shape changes; no test pins a literal hash today.

### Tests (`test/`)

Update the existing tests that relied on the old shape: `world.test.ts` has
the "Non-player entities stand still" assertion, which still holds when no
intent is queued for them. Add at least:

- NPC `step` intent: a non-player entity moves, respects walls, diagonal
  corner-cutting rules and its own archetype's `ticks_per_step`.
- NPC `goto`: a non-player entity walks an A* path to a goal (and with
  `adjacent: true`), `pathGoal(npc)` reports the goal, and an unreachable
  goal sets `npc.lastGoto.ok === false` without touching
  `world.player.lastGoto`.
- Player and NPC intents queued on the same tick are both applied, in id
  order, and do not overwrite each other.
- `queueIntent` with a foreign entity throws, and after defeat NPC intents
  are ignored too.
- Determinism: a run of 1000+ ticks on both genres (`std,std-needs,zombie`
  and `std,vampire`) that queues intents for the player **and** for every
  spawned NPC (e.g. round-robin steps/gotos from a seeded schedule) produces
  identical `hash()`/`snapshot()` across two runs.

### Docs

- `docs/packs.md`, "Tick order", phase 1: say that it applies **each
  entity's** movement intent in id order, then the queued (player) actions.
  Mention in the intents section that `queueIntent` takes an optional
  entity.
- No VISION.md change is needed beyond, optionally, noting under §8 that
  per-entity movement exists as M4 groundwork.

### Gates

- `npm run typecheck` and `npm test` pass.
- The engine genre-word guard test still passes (no genre or stdpack terms
  in `src/`).

## Out of Scope

- Any AI, `behaviors`, senses, noise, or pack schema changes. No YAML
  changes.
- Entity–entity collision or occupancy.
- NPC actions (take/put/drop/use) or NPC inventories in use.
- Shell changes beyond what compiles against the new API (the web and
  terminal UIs still control only the player, and the renderers already
  interpolate every entity through `renderPosition`).
- A debug wander mode for NPCs in the shells.
- Pathfinding performance work. The existing `Pathfinder` is reused as is.

## Design Notes

- Keep `step`-intent semantics identical to the player's today: a `step`
  intent persists across ticks while the entity is on cooldown, then fires
  once. `goto` resolves immediately on the next tick, even during cooldown.
- The shared lazily-created `Pathfinder` stays a single instance. It is
  called once per resolved `goto`, not once per entity per tick.
- An `Entity`-typed parameter (not an id) is the preferred API. Validate
  membership with `this.entities[e.id] === e`.
- Existing callers (`src/web/input.ts`, `src/web/main.ts`,
  `src/ascii/terminal.ts`, `test/looter.ts`, `test/scenario.test.ts`,
  `test/items.test.ts`) keep working without edits apart from the snapshot
  shape.
