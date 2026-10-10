# Saves

A running world can be saved to a JSON **save file** and restored later,
with the same packs loaded. Restoring is **exact**: the restored world has
the same snapshot and, given the same input, the same `hash()` on every
later tick.

```ts
const save = world.save();                 // plain JSON-serializable object
const r = World.restore(def, JSON.parse(text));
if (r.ok) play(r.world, r.warnings);
else show(r.errors);
```

## File format

```ts
interface SaveFile {
  format: 'isolandia-save';
  version: 8;
  /** Loaded packs, in load order. */
  packs: { namespace: string; version: string }[];
  /** Qualified id of the start map, and its size. */
  map: { id: string; width: number; height: number; floors: number };
  state: WorldSnapshot;
}
```

`state` is `world.snapshot()`, the same object `hash()` is computed from:
`tick`, the RNG state, the world `seed`, the player's entity id,
`nextContainer` (ids are never reused, so it cannot be derived once a
ground pile has gone), the action queue, `lastAction`, `defeat` /
`victory`, every entity, every container in id order, the cells whose
tile differs from the map as `[x, y, z, tileId]`, in cell order (floor by
floor, row-major), and the edges whose tile differs from the map as
`[x, y, z, side, tileId | null]` (`side` is `n` or `w`, null for a removed
edge), in cell order with `n` before `w` (see
[edge walls](packs.md#edge-walls)), and the story state: `vars` (`{ "ns:id":
value }` for every [var](packs.md#vars)), `quests` (`[{ quest, stage, since,
ended }]` for the started [quests](packs.md#quests), in definition order, by
qualified quest id and stage id) and `journal` (`[{ entry, tick }]`, the
added [entries](packs.md#journal) in the order added), and the
[dialogue](packs.md#dialogues) state: `conversation` (null, or `{ npc,
dialogue, node, entries }` for the open conversation, by entity id,
qualified dialogue id and node name; `entries` is the loop guard's
counter) and `dialogueOnce` (the chosen `once` choices as `[dialogue id,
choice id]`, sorted), and `reputation` (`{ "ns:id": value }`, the player's
standing with every [faction](packs.md#factions)). Each entity lists the
`once` [systems](packs.md#systems) that have fired for it as `fired`
(qualified ids, sorted; omitted when none), and the id of the entity it
currently sees through its [senses](packs.md#senses) as `seen` (omitted
when none or without senses). A save made
mid-conversation restores into the same open conversation. An activity on an edge (barricading a
window) records its `side` next to its target cell. Every cell carries its floor `z`: entity `z` and
`fromZ`, `home` and path cells as `[x, y, z]`, the behavior plan as
`[x, y, z, tick]`, `heard` and the activity target with `z`, `lastGoto.z`,
and container cells as `[x, y, z]` (see [floors](packs.md#floors)). Every reference
is a qualified id (`town:hammer`), never an index, so a save does not depend
on load order details.

`save()` is pure: it does not change `hash()`, draw RNG or record
warnings, and it works on an ended world. It contains no wall-clock time.

### Shell wrapper

Shells store and export a wrapper with metadata next to the save, never
inside `state`:

```json
{ "meta": { "savedAt": "2026-10-04T12:34:00.000Z", "day": 2, "time": "14:05", "tick": 21900, "packs": ["std", "std_needs", "town", "zmb"] },
  "save": { "format": "isolandia-save", "version": 8, "...": "..." } }
```

Every reader (browser import, `--load`, `check --save`) accepts both the
wrapper and a bare `SaveFile` (`unwrapSave`).

### Version policy

`version` is bumped on any **breaking change to `state`** (a field removed,
renamed or reinterpreted). Adding state that a restore needs is breaking
too, since older files lack it. `World.restore` keeps reading every
version listed in `SUPPORTED_SAVE_VERSIONS`, migrating older ones on read
where that is possible; an unlisted version is an error that names the
supported ones. Later M6
work (`m6-chunked-world`) extends the format under this policy and must
keep the round-trip invariant.

| Version | Change | Read as |
|---------|--------|---------|
| 1 | first format | refused (see below) |
| 2 | floors (`m6-floors`): `map.floors` and a `z` on every cell | refused (see below) |
| 3 | edge walls (`edge-walls`): `state.edges` and the activity `side` | upgraded (see below) |
| 4 | vars, quests and journal (`m8-flags-quests`): `state.vars`, `state.quests`, `state.journal` | upgraded (see below) |
| 5 | dialogues (`m8-dialogues`): `state.conversation`, `state.dialogueOnce`, the `talk` action | upgraded (see below) |
| 6 | factions (`m8-factions`): `state.reputation` | upgraded (see below) |
| 7 | `once` systems (`pack-event-triggers`): `fired` on every entity | upgraded (see below) |
| 8 | senses (`npc-perception`): `seen` on every entity with senses | current |

Versions 1 and 2 are refused with an error that says why: their maps had
walls in cells, and the edge-wall conversion turned those cells into
floor and ground, so their changed tiles (a barricaded window cell) and
plans would point at cells that are no longer what they were. Start a new
game.

Version 3 saves still load: every var takes its `initial`, no quest is
started and the journal is empty (no warnings). The first tick's quest
phase then runs as usual, so quests whose `when` holds start at once.

Version 3 and 4 saves load with no open conversation and no `once` choice
chosen (no warnings).

Version 3 to 5 saves load with every faction at its starting `reputation`
(no warnings).

Version 3 to 6 saves load with no `once` system counted as fired for any
entity (no warnings), so a `once` system whose `for` and `when` hold may
fire again after the upgrade.

Version 3 to 7 saves load with no entity seeing anything (no warnings; a
`seen` field in such a save is ignored): the first tick's senses step
notices again whatever is in sight, so a chase resumes one tick late.
Saving an upgraded world writes version 8.

A version 8 `seen` that is not an existing entity id, is the entity
itself, or is set on an entity whose archetype has no senses is a restore
error with the JSON path (`state.entities[12].seen`).

## Validation

`World.restore(def, save)` never throws (not on `null`, arrays, wrong
types or truncated data the caller already parsed) and reports **every**
error it finds, each prefixed with its JSON path
(`state.entities[12].archetype: unknown archetype 'zmb:shamblr' (did you
mean 'zmb:shambler'?)`).

**Errors** (nothing is restored):

- `format` is not `isolandia-save`, or `version` is unsupported.
- The pack **namespaces** differ from the loaded packs, in order (both
  lists are shown), or the map id or size (width, height, floors) differs
  from the start map.
  These stop the check: the state's ids and cells would only add noise.
- A qualified id does not resolve: archetype, measurement, status, item,
  tile, action, recipe, var, quest, journal entry, dialogue, faction (a key
  of `reputation`), a system in an entity's `fired`, the stage id of a saved
  quest, the node of the open conversation, a `once` choice id of a
  dialogue, or the behavior state name of the entity's archetype behavior. Each has a *did you mean* suggestion when one is
  close.
- An entity's `fired` names a system that is not `once`, or lists one
  twice.
- Entity ids are not exactly `0..n-1` in order, or `player` is not one of
  them.
- An inventory has no `owner`, its owner's archetype has no `inventory`,
  or an entity whose archetype has an inventory has no inventory container.
- A container id is duplicated or `≥ nextContainer`.
- A cell is out of bounds (on any axis, floors included): entity
  position, `from`, `home`, path cell, container cell, changed tile,
  activity target, heard noise, or a behavior plan (`[-1, -1, -1]` is
  allowed: `investigate` plans without a goto).
- A changed tile is on an empty cell of the map.
- A changed edge has a side other than `n` or `w`, or a tile that is not
  an edge tile.
- A tile container's cell does not hold a container tile in the restored
  grid (changed tiles are applied first).
- A quest, journal entry or `once` choice is listed twice.
- The open conversation's `npc` is not an entity, or is the player.
- A field has the wrong type or range (e.g. a negative tick, an RNG state
  outside 32 bits, a stack count below 1, an activity that ends before it
  starts, a `use` activity on an item without `use`).

**Warnings** (the restore succeeds):

- A pack's **version** differs from the save.
- A measurement the archetype now has is missing: it gets the archetype's
  initial value.
- A saved measurement the archetype no longer has is dropped.
- A saved behavior state on an archetype that no longer has a behavior is
  dropped; an archetype that gained one starts in its initial state.
- A var the packs define is missing: it takes its `initial`. A saved value
  outside the var's (new) range is clamped.
- A faction the packs define is missing from `reputation`: it takes its
  starting `reputation`. A saved standing outside [-100, 100] is clamped.
- A saved quest's `ended` disagrees with whether its stage now has an
  `end`: the packs decide.

Changes to rules inside a pack (new effects, different durations, item
weights) are not detected: a save stores state, not rules.

Saves made before M7's `town` base (zombie and vampire as games) do not load
in the new stacks: their pack list lacks `town`, so restore stops at the
namespace mismatch.

## Restore

A restored world is built through an internal constructor path that skips
spawning, container creation and loot, then gets its state from the save:

- **Nothing is rolled**: containers, stacks, their order and contents come
  from the save; loads are recomputed from the item weights.
- `tick`, the RNG state, the action queue, `lastAction`, `defeat` /
  `victory`, every entity field in the snapshot (the remaining path starts
  at `pathPos = 0`), and the changed tiles and edges (through
  `Grid.setTile` and `Grid.setEdge`, so walkability and opacity follow).
- Activities are rebuilt from their source ids, target, `startTick` and
  `endTick`, with the same object shape `ActivityRunner` creates; their
  start checks are not run again.
- Each entity's resolved `max` is recomputed (with a throwaway RNG copy)
  **without** clamping, and statuses are not updated: the saved values and
  flags stay as they are.
- No pending noises, no expression warnings, and the pathfinder is built
  lazily, as in `World.create`.

## Round-trip invariant

For any world `w`:

1. `World.restore(def, JSON.parse(JSON.stringify(w.save())))` gives a world
   whose `snapshot()` deep-equals `w.snapshot()`;
2. stepping both `N` more ticks with the same intents and actions gives
   equal `hash()` on every tick;
3. saving the restored world gives the same `SaveFile`.

`assertRoundTrip(world, script, ticks)` in `test/helpers.ts` checks all
three; `test/save.test.ts` runs it at tick 0, mid-path with a `goto.then`,
mid-activity (actions, timed uses, recipes), after a ground pile came and
went, after `set_tile`, with NPCs in every behavior activity, after defeat,
and in a seeded fuzz over 600 ticks on every genre.

## Size

Saves are plain JSON, without compression. The 343×343 zombie city at
creation (961 entities, about 1100 filled tile containers) saves to about
**0.43 M characters**; the older 256×256 city with 1025 entities, each
with an inventory, and about 2100 filled containers saved to about 0.6 M.
Either way the quicksave and three slots together stay well under the
usual ~5 M-character `localStorage` quota.
The map itself is not saved, only the cells that changed.

## Shells

**Browser** (see [ui](ui.md#saving-and-loading)): `F5` quicksaves, `F9`
quickloads, `O` opens the Game panel with the quicksave, three slots, and
Export / Import. Slots live in `localStorage` under
`isolandia:save:<packs>:<slot>` (e.g.
`isolandia:save:std,std-needs,town,zombie:slot1`, with the resolved
[stack](packs.md#stacks) of `?packs=`), so each game has its own slots and
`?packs=zombie` shares them with `?packs=std,std-needs,town,zombie`.

**Terminal**:

```bash
npm run play -- <packs…> --load <file>        # start from a save
npm run play -- <packs…> --save-file <path>   # the file S and L use
```

`--load` prints errors and exits with code 1, or prints warnings and
starts. `--seed` with `--load` is an error (the save carries its seed). In
game, `S` writes `--save-file` (default `isolandia-save.json` in the
current directory) in the wrapper format and `L` loads it, showing
`Loaded <path>.` or the first error with `(+N more)`.

**Check**:

```bash
npm run check -- <packs…> --save <file>
```

validates a save against the packs and prints its errors and warnings in
the usual `check` style; the exit code is 1 on errors.
