import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameToText, renderAscii } from '../src/ascii/render.ts';
import { actionMenu, actionMenuText, handleKey, type KeyState } from '../src/ascii/terminal.ts';
import {
  countOf,
  hudLines,
  hudModel,
  lineOfSight,
  loadPacks,
  loadPacksOrThrow,
  Pathfinder,
  progressText,
  World,
  type Definition,
  type Entity,
  type LoadError,
} from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { activityBar } from '../src/web/hud.ts';
import { lootView } from '../src/web/panels.ts';
import { fixture, GAMES } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   #######      W = pane (not walkable, see-through), ~ = mud (walkable, tag soft)
//   #..@.W#      B = bin (a container tile)
//   #.o...#      the hero carries a saw, 3 boards and 2 salves; `o` is a rock
//   #B.~..#      whose `vol` makes a noise of that radius every tick
//   #######

const FILES: Record<string, string> = {
  'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: pane, label: Pane, glyph: "W", color: cyan, walkable: false, opaque: false }
  - { id: boarded, label: Boarded pane, glyph: "H", color: yellow, walkable: false, opaque: true }
  - { id: mud, label: Mud, glyph: "~", color: yellow, walkable: true, tags: [soft] }
  - { id: bin, label: Bin, glyph: B, color: gray, walkable: false, container: { capacity: 5 } }
`,
  'archetypes.yaml': `measurements:
  - { id: vol, label: Volume, min: 0, max: 100, initial: 0 }
archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [hp, food]
    ticks_per_turn: 0
    inventory: { capacity: 10, items: { saw: 1, board: 3, salve: 2 } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0, measurements: [vol] }
systems:
  - id: shout
    every: 0.1
    for: 'self.vol > 0'
    effects:
      - { type: noise, radius: "self.vol" }
statuses:
  - { id: napping, label: Napping, when: 'doing(self, "nap")' }
  - { id: occupied, label: Occupied, when: 'self.busy' }
  - { id: working, label: Working, when: 'busy(player) and not player.doing("nap")' }
`,
  'items.yaml': `items:
  - { id: saw, label: Saw, glyph: "/", color: gray, weight: 1 }
  - { id: board, label: Board, glyph: "=", color: yellow, weight: 1 }
  - id: salve
    label: Salve
    glyph: "!"
    color: green
    weight: 0.1
    use:
      label: Apply
      duration: 3
      interrupt: 'heard(self, 0.2)'
      effects:
        - { type: apply, measurement: food, delta: 10 }
  - id: snack
    label: Snack
    glyph: "%"
    color: red
    weight: 0.1
    use: { label: Eat, effects: [{ type: apply, measurement: food, delta: 1 }] }
`,
  'actions.yaml': `actions:
  - id: board_up
    label: Board up
    progress: Boarding up
    target: { tiles: [pane] }
    tools: [saw]
    consume: { board: 2 }
    duration: 6
    effects:
      - { type: set_tile, tile: boarded }
      - { type: noise, radius: 5 }
      - { type: apply, measurement: food, delta: "tile.x" }
  - id: smash
    label: Smash
    target: { tiles: [pane, boarded] }
    duration: 1
    effects:
      - { type: set_tile, tile: floor }
  - id: fill
    label: Fill
    target: { tags: [soft] }
    duration: 1
    when: 'tile.has_tag("soft") and tile.id == "t:mud"'
    effects:
      - { type: set_tile, tile: wall }
  - id: nap
    label: Nap
    progress: Napping
    target: self
    duration: 2
    interrupt: 'heard(self, 1)'
    effects:
      - { type: apply, measurement: food, delta: 5 }
  - id: hum
    label: Hum
    target: self
    effects:
      - { type: apply, measurement: food, delta: 1 }
  - id: lucky
    label: Try luck
    target: self
    when: 'random(0, 1) == 1'
    duration: "random(1, 3)"
    effects:
      - { type: apply, measurement: food, delta: 1 }
  - id: fidget
    label: Fidget
    target: self
    duration: 1
    interrupt: 'true'
    effects:
      - { type: apply, measurement: food, delta: 1 }
  - id: wait_soft
    label: Wait
    target: self
    when: 'tile.has_tag("soft")'
    effects:
      - { type: apply, measurement: food, delta: 1 }
`,
  'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "W": { tile: pane }
      "~": { tile: mud }
      "B": { tile: bin }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
    rows:
      - "#######"
      - "#..@.W#"
      - "#.o...#"
      - "#B.~..#"
      - "#######"
start:
  map: room
  player: hero
`,
};

const DEF: Definition = loadPacksOrThrow([fixture(FILES)]);

function world(seed = 1): World {
  return World.create(DEF, seed);
}

/** Drop the fixture's food drift so measurement checks are exact. */
function food(w: World): number {
  return w.value(w.player, 't:food')!;
}

function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

function moveTo(e: Entity, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
}

const rock = (w: World) => w.entities[1]!;
const count = (w: World, id: string) => countOf(w.player.inv!, w.def.ids.items[id]!);
const cell = (w: World, x: number, y: number) => w.grid.tileAt(x, y)!.id;

// ── Loader ──────────────────────────────────────────────────────────────────

function load(files: Record<string, string>): { errors: readonly LoadError[]; warnings: readonly LoadError[] } {
  const r = loadPacks([fixture({ ...FILES, ...files })]);
  return r.ok ? { errors: [], warnings: r.warnings } : { errors: r.errors, warnings: r.warnings };
}

/** Extra actions in their own file (the fixture's statuses refer to its `nap`). */
function actionsYaml(body: string): Record<string, string> {
  return { 'extra.yaml': `actions:\n${body}` };
}

function expectLoadError(files: Record<string, string>, message: RegExp, path?: string): void {
  const { errors } = load(files);
  const hit = errors.find((e) => message.test(e.message));
  assert.ok(hit, `expected ${message}, got:\n${errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
  if (path !== undefined) assert.equal(hit.path, path);
}

test('actions: the fixture and both genre stacks load', () => {
  assert.equal(DEF.actions.length, 8);
  const board = DEF.actions[DEF.ids.actions['t:board_up']!]!;
  assert.equal(board.duration.ticks, 60);
  assert.deepEqual(board.consume, [{ item: DEF.ids.items['t:board'], count: 2 }]);
  assert.deepEqual(board.target!.match, DEF.tiles.map((t) => (t.id === 't:pane' ? 1 : 0)));
  assert.equal(DEF.actions[DEF.ids.actions['t:nap']!]!.target, null);
  const fill = DEF.actions[DEF.ids.actions['t:fill']!]!;
  assert.deepEqual(fill.target!.tags, ['soft']);
  for (const dirs of Object.values(GAMES)) assert.ok(loadPacks(dirs.map((d) => readPack(d))).ok, dirs.join(','));
});

test('actions load errors: shape, target, references, set_tile, duration', () => {
  const act = (extra: string) => actionsYaml(`  - id: a\n    label: A\n${extra}`);
  expectLoadError(act('    target: self\n'), /does nothing: it needs 'effects' or 'consume'/);
  expectLoadError(act('    target: self\n    effects: []\n'), /does nothing/);
  expectLoadError(act('    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /missing required field 'target'/);
  expectLoadError(act('    target: everyone\n    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /must be 'self' or a tile filter/, 'actions[0].target');
  expectLoadError(act('    target: {}\n    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /needs a non-empty 'tiles' or 'tags' list/);
  expectLoadError(act('    target: { tiles: [] }\n    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /needs a non-empty/);
  expectLoadError(act('    target: { tile: [pane] }\n    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /unknown tile filter field 'tile' \(did you mean 'tiles'\?\)/);
  expectLoadError(act('    target: { tiles: [pain] }\n    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /unknown tile 'pain' \(did you mean 'pane'\?\)/, 'actions[0].target.tiles[0]');
  expectLoadError(act('    target: self\n    tools: [sawe]\n    effects: [{ type: apply, measurement: food, delta: 1 }]\n'), /unknown item 'sawe' \(did you mean 'saw'\?\)/);
  expectLoadError(act('    target: self\n    consume: { bord: 1 }\n'), /unknown item 'bord' \(did you mean 'board'\?\)/);
  expectLoadError(act('    target: self\n    consume: { board: 0 }\n'), /consumed count must be an integer ≥ 1/);
  expectLoadError(act('    target: self\n    tools: [saw, saw]\n    consume: { board: 1 }\n'), /tool 't:saw' is listed twice/);
  // set_tile: only in tile-targeted actions, never placing a container tile.
  expectLoadError(act('    target: self\n    effects: [{ type: set_tile, tile: wall }]\n'), /'set_tile' effects are only allowed in the effects of tile-targeted actions/);
  expectLoadError(
    { 'sys.yaml': 'systems:\n  - { id: s, every: 1, effects: [{ type: set_tile, tile: wall }] }\n' },
    /only allowed in the effects of tile-targeted actions/,
  );
  expectLoadError(
    { 'more.yaml': 'items:\n  - { id: x, label: X, glyph: x, color: red, weight: 0, use: { effects: [{ type: set_tile, tile: wall }] } }\n' },
    /only allowed in the effects of tile-targeted actions/,
  );
  expectLoadError(act('    target: { tiles: [pane] }\n    effects: [{ type: set_tile, tile: bin }]\n'), /set_tile cannot place tile 't:bin': it has a 'container'/);
  expectLoadError(act('    target: { tiles: [pane] }\n    effects: [{ type: set_tile, tile: flor }]\n'), /unknown tile 'flor' \(did you mean 'floor'\?\)/);
  expectLoadError(act('    target: { tiles: [pane] }\n    effects: [{ type: set_tile }]\n'), /missing required field 'tile'/);
  // Duration: sim seconds, a whole number of ticks, ≥ 0.
  expectLoadError(act('    target: self\n    duration: 0.25\n    consume: { board: 1 }\n'), /field 'duration' must be a whole number of ticks/);
  expectLoadError(act('    target: self\n    duration: -1\n    consume: { board: 1 }\n'), /field 'duration' must be a number of sim seconds ≥ 0/);
  expectLoadError(act('    target: self\n    duration: [1]\n    consume: { board: 1 }\n'), /field 'duration' must be a number or an expression/);
  expectLoadError(act('    target: self\n    duration: "self.nope"\n    consume: { board: 1 }\n'), /expression error/);
  expectLoadError(act('    target: self\n    interrupt: "self.nope"\n    consume: { board: 1 }\n'), /expression error/);
  expectLoadError(act('    target: self\n    colour: red\n    consume: { board: 1 }\n'), /unknown action field 'colour'/);
  // Item use additions.
  expectLoadError(
    { 'more.yaml': 'items:\n  - { id: x, label: X, glyph: x, color: red, weight: 0, use: { duration: 0.05, effects: [{ type: apply, measurement: food, delta: 1 }] } }\n' },
    /field 'duration' must be a whole number of ticks/,
  );
  // doing(): the action id is resolved at load time.
  expectLoadError({ 'st.yaml': 'statuses:\n  - { id: s, label: S, when: \'doing(self, "napp")\' }\n' }, /unknown action 'napp' \(did you mean 'nap'\?\)/);
  expectLoadError({ 'st.yaml': 'statuses:\n  - { id: s, label: S, when: \'doing(self, 3)\' }\n' }, /doing\(\) expects a string literal action id/);
  expectLoadError({ 'st.yaml': "statuses:\n  - { id: s, label: S, when: 'busy(self, 1)' }\n" }, /busy\(\) takes 1 argument/);
});

test('actions load warning: a filter tag no tile carries', () => {
  const { errors, warnings } = load(actionsYaml('  - { id: a, label: A, target: { tags: [sofft] }, effects: [{ type: set_tile, tile: wall }] }\n'));
  assert.deepEqual(errors, []);
  const w = warnings.find((x) => /no tile carries the tag 'sofft' \(did you mean 'soft'\?\)/.test(x.message));
  assert.ok(w, warnings.map((x) => x.message).join('\n'));
  assert.equal(w.path, 'actions[0].target.tags[0]');
});

test('actions: expression durations round up once at start; negative is instant', () => {
  const d = loadPacksOrThrow([
    fixture({
      ...FILES,
      'extra.yaml': `actions:
  - { id: a, label: A, target: self, duration: "0.31 + self.food * 0", effects: [{ type: apply, measurement: food, delta: 1 }] }
  - { id: b, label: B, target: self, duration: "-2", effects: [{ type: apply, measurement: food, delta: 1 }] }
  - { id: c, label: C, target: self, duration: "0.3", effects: [{ type: apply, measurement: food, delta: 1 }] }
`,
    }),
  ]);
  assert.equal(d.actions[d.ids.actions['t:b']!]!.duration.ticks, 0);
  assert.equal(d.actions[d.ids.actions['t:c']!]!.duration.ticks, 3);
  const w = World.create(d, 1);
  w.queueAction({ kind: 'act', action: 't:a' });
  w.step();
  assert.equal(w.player.activity!.endTick - w.player.activity!.startTick, 4); // 3.1 ticks → 4
  w.queueAction({ kind: 'act', action: 't:b' });
  w.step();
  assert.equal(w.player.activity, null);
  assert.equal(w.lastAction!.stage, 'complete');
  assert.equal(w.lastAction!.ok, true);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test('actions: a 6 s action completes exactly 60 ticks after it starts', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  steps(w, 100);
  const before = food(w);
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  w.step(); // tick 100
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:board_up', moved: 0, ok: true, stage: 'start', tick: 100 });
  assert.deepEqual(w.snapshot().entities[0]!.activity, { kind: 'act', action: 't:board_up', x: 5, y: 1, startTick: 100, endTick: 160 });
  assert.equal(hudModel(w).activity!.text, progressText('Boarding up', 1 / 60));
  steps(w, 59); // ticks 101..159
  assert.equal(cell(w, 5, 1), 't:pane');
  assert.equal(count(w, 't:board'), 3, 'nothing consumed before completion');
  assert.equal(w.activityProgress()!.fraction, 1, '60 ticks of work done; it completes in the next step');
  w.step(); // tick 160
  assert.equal(w.player.activity, null);
  assert.equal(w.activityProgress(), null);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:board_up', moved: 2, ok: true, stage: 'complete', tick: 160 });
  assert.equal(cell(w, 5, 1), 't:boarded');
  assert.equal(count(w, 't:board'), 1);
  assert.equal(count(w, 't:saw'), 1, 'tools are never consumed');
  // `tile` is the target cell in effects: food += tile.x (5), plus drift.
  assert.ok(Math.abs(food(w) - (before + 5 - 61 / 10)) < 1e-9, `${food(w)}`);
  assert.deepEqual(
    w.noises.map((n) => [n.x, n.y, n.radius]),
    [[4, 1, 5]],
    'the noise is emitted at the actor, in the completion tick',
  );
});

test('actions: a 0 s action completes in the phase it starts, with a single complete record', () => {
  const w = world();
  w.queueAction({ kind: 'act', action: 't:hum' });
  w.step();
  assert.equal(w.player.activity, null);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:hum', moved: 0, ok: true, stage: 'complete', tick: 0 });
  // Instant item uses are unchanged.
  add(w, 't:snack');
  w.queueAction({ kind: 'use', item: 't:snack' });
  w.step();
  assert.deepEqual(w.lastAction, { kind: 'use', item: 't:snack', moved: 1, ok: true, stage: 'complete', tick: 1 });
});

function add(w: World, id: string): void {
  const inv = w.player.inv!;
  const item = w.def.ids.items[id]!;
  inv.stacks.push({ item, count: 1 });
  inv.load += w.def.items[item]!.weight;
}

test('actions: start checks in order', () => {
  const w = world();
  const reason = (a: Parameters<World['queueAction']>[0]) => {
    w.queueAction(a);
    w.step();
    return w.lastAction!.reason ?? 'ok';
  };
  assert.equal(reason({ kind: 'act', action: 't:nope' }), 'unknown_action');
  assert.equal(reason({ kind: 'act', action: 't:board_up', x: 5, y: 1 }), 'out_of_reach'); // (3,1) → (5,1)
  assert.equal(reason({ kind: 'act', action: 't:board_up' }), 'invalid_target'); // x/y required
  assert.equal(reason({ kind: 'act', action: 't:nap', x: 3, y: 1 }), 'invalid_target'); // forbidden for self
  assert.equal(reason({ kind: 'act', action: 't:board_up', x: 4, y: 1 }), 'invalid_target'); // floor
  moveTo(w.player, 4, 1);
  assert.equal(reason({ kind: 'act', action: 't:board_up', x: 5, y: 2 }), 'invalid_target'); // wall
  assert.equal(reason({ kind: 'act', action: 't:wait_soft' }), 'cannot_act');
  const inv = w.player.inv!;
  inv.stacks.splice(0, inv.stacks.length);
  assert.equal(reason({ kind: 'act', action: 't:board_up', x: 5, y: 1 }), 'missing');
  assert.equal(w.lastAction!.stage, 'start');
  assert.equal(reason({ kind: 'act', action: 't:hum' }), 'ok');

  const bare = World.create(loadPacksOrThrow([fixture({ ...FILES, 'archetypes.yaml': FILES['archetypes.yaml']!.replace(/    inventory: .*\n/, '') })]), 1);
  moveTo(bare.player, 4, 1);
  bare.queueAction({ kind: 'act', action: 't:board_up', x: 9, y: 9 });
  bare.step();
  assert.equal(bare.lastAction!.reason, 'no_inventory', 'inventory is checked before reach');
  bare.queueAction({ kind: 'act', action: 't:smash', x: 5, y: 1 });
  bare.step();
  assert.equal(bare.lastAction!.ok, true, 'an action without items needs no inventory');
});

test('actions: starting clears the path and pending intent', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  w.queueIntent({ kind: 'goto', x: 4, y: 3 });
  w.step();
  assert.ok(w.player.path);
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  w.step();
  assert.ok(w.player.activity);
  assert.equal(w.player.path, null);
  assert.equal(w.player.intent, null);
  const at = [w.player.x, w.player.y];
  steps(w, 10);
  assert.deepEqual([w.player.x, w.player.y], at, 'the player stops walking');
});

test('actions: a step, a goto or a new action cancels the activity; nothing is consumed', () => {
  for (const cancel of ['step', 'goto', 'action'] as const) {
    const w = world();
    moveTo(w.player, 4, 1);
    w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
    steps(w, 10);
    if (cancel === 'step') w.queueIntent({ kind: 'step', dx: -1, dy: 0 });
    if (cancel === 'goto') w.queueIntent({ kind: 'goto', x: 1, y: 1 });
    if (cancel === 'action') w.queueAction({ kind: 'drop', item: 't:saw' });
    w.step(); // tick 10
    assert.equal(w.player.activity, null, cancel);
    if (cancel !== 'action') assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:board_up', moved: 0, ok: false, stage: 'complete', reason: 'cancelled', tick: 10 });
    else assert.equal(w.lastAction!.kind, 'drop', 'the new action is applied after the cancel');
    steps(w, 70);
    assert.equal(cell(w, 5, 1), 't:pane', cancel);
    assert.equal(count(w, 't:board'), 3, cancel);
  }
});

test('actions: the last activity started in a tick wins; a queued intent then action in one frame is shell-independent', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  w.queueAction({ kind: 'act', action: 't:nap' });
  w.step();
  assert.equal(w.player.activity!.action, w.def.ids.actions['t:nap']);
  // Intent and action queued in the same frame: the intent is applied first (cancelling), then the action starts.
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 });
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  w.step();
  assert.equal(w.player.activity!.action, w.def.ids.actions['t:board_up']);
});

test('actions: interrupt is checked from the tick after the start, before completion', () => {
  const w = world();
  w.queueAction({ kind: 'act', action: 't:fidget' }); // interrupt: true, duration 1 s
  w.step(); // tick 0: start, no check
  assert.ok(w.player.activity);
  w.step(); // tick 1
  assert.equal(w.player.activity, null);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:fidget', moved: 0, ok: false, stage: 'complete', reason: 'interrupted', tick: 1 });
});

test('actions: a noise interrupts a nap; the activity snapshot survives defeat', () => {
  const w = world();
  w.queueAction({ kind: 'act', action: 't:nap' });
  steps(w, 5);
  const before = food(w);
  rock(w).m[w.def.ids.measurements['t:vol']!] = 3; // shouts from tick 5
  w.step(); // tick 5: heard in phase 4
  assert.ok(w.player.activity, 'not yet: hearing comes after the work step');
  w.step(); // tick 6
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(w.lastAction!.tick, 6);
  assert.ok(food(w) < before, 'no effects');
  assert.equal(hudModel(w).lastAction, 'Nap interrupted.');
});

test("actions: the player's own completion noise never interrupts the next timed action", () => {
  const w = world();
  moveTo(w.player, 4, 1);
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(w, 61);
  assert.equal(w.noises.length, 1);
  assert.equal(w.player.heardTick, -1);
  w.queueAction({ kind: 'act', action: 't:nap' });
  steps(w, 21);
  assert.equal(w.lastAction!.action, 't:nap');
  assert.equal(w.lastAction!.ok, true);
  assert.equal(w.lastAction!.stage, 'complete');
});

test('actions: completion re-checks items and the target', () => {
  // An item dropped mid-way.
  const w = world();
  moveTo(w.player, 4, 1);
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(w, 10);
  w.player.inv!.stacks.splice(
    w.player.inv!.stacks.findIndex((s) => s.item === w.def.ids.items['t:board']),
    1,
  ); // e.g. stolen: no action queued, so no cancel
  steps(w, 51);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:board_up', moved: 0, ok: false, stage: 'complete', reason: 'missing', tick: 60 });
  assert.equal(cell(w, 5, 1), 't:pane');

  // The tile already changed (someone else boarded it).
  const v = world();
  moveTo(v.player, 4, 1);
  v.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(v, 10);
  v.grid.setTile(1 * v.grid.width + 5, v.def.ids.tiles['t:boarded']!);
  steps(v, 51);
  assert.equal(v.lastAction!.reason, 'invalid_target');
  assert.equal(count(v, 't:board'), 3);

  // Out of reach by the end (moved without an intent, e.g. pushed).
  const u = world();
  moveTo(u.player, 4, 1);
  u.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(u, 10);
  moveTo(u.player, 2, 1);
  steps(u, 51);
  assert.equal(u.lastAction!.reason, 'out_of_reach');
});

test('actions: set_tile onto an occupied cell fails with occupied; nothing runs or is consumed', () => {
  const w = world();
  moveTo(w.player, 2, 3);
  moveTo(rock(w), 3, 3); // on the mud
  w.queueAction({ kind: 'act', action: 't:fill', x: 3, y: 3 });
  steps(w, 11);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:fill', moved: 0, ok: false, stage: 'complete', reason: 'occupied', tick: 10 });
  assert.equal(cell(w, 3, 3), 't:mud');
  assert.equal(w.tileVersion, 0);
  // The actor counts too.
  moveTo(rock(w), 2, 2);
  moveTo(w.player, 3, 3);
  w.queueAction({ kind: 'act', action: 't:fill', x: 3, y: 3 });
  steps(w, 11);
  assert.equal(w.lastAction!.reason, 'occupied');
  moveTo(w.player, 3, 2);
  w.queueAction({ kind: 'act', action: 't:fill', x: 3, y: 3 });
  steps(w, 11);
  assert.equal(w.lastAction!.ok, true);
  assert.equal(cell(w, 3, 3), 't:wall');
});

test('actions: set_tile on a container cell fails with invalid_target at run time', () => {
  const d = loadPacksOrThrow([
    fixture({
      ...FILES,
      'extra.yaml': 'actions:\n  - { id: paint, label: Paint, target: { tiles: [bin, floor] }, effects: [{ type: set_tile, tile: mud }] }\n',
    }),
  ]);
  const w = World.create(d, 1);
  moveTo(w.player, 2, 2);
  w.queueAction({ kind: 'act', action: 't:paint', x: 1, y: 3 });
  w.step();
  assert.equal(w.lastAction!.reason, 'invalid_target');
  assert.ok(!w.availableActions().some((a) => a.x === 1 && a.y === 3), 'not offered either');
  w.queueAction({ kind: 'act', action: 't:paint', x: 2, y: 1 });
  w.step();
  assert.equal(cell(w, 2, 1), 't:mud');
});

test('actions: set_tile updates walkability, opacity, A* and can_see at once', () => {
  const w = world();
  const pf = new Pathfinder(w.grid);
  moveTo(w.player, 4, 1);
  assert.equal(pf.findPath(4, 1, 5, 1), null);
  assert.ok(lineOfSight(w.grid, 3, 1, 6, 1), 'through the pane');
  // Board up: opaque.
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(w, 61);
  assert.equal(w.grid.opaque[1 * w.grid.width + 5], 1);
  assert.ok(!lineOfSight(w.grid, 3, 1, 6, 1));
  assert.equal(w.tileVersion, 1);
  // Smash it: walkable floor; the same Pathfinder sees it.
  w.queueAction({ kind: 'act', action: 't:smash', x: 5, y: 1 });
  steps(w, 11);
  assert.equal(cell(w, 5, 1), 't:floor');
  assert.equal(w.grid.walk[1 * w.grid.width + 5], 1);
  assert.deepEqual([...pf.findPath(3, 1, 5, 1)!], [1 * w.grid.width + 4, 1 * w.grid.width + 5]);
  assert.equal(w.tileVersion, 2);
});

test('actions: can_see follows set_tile (expressions read the live grid)', () => {
  const d = loadPacksOrThrow([
    fixture({
      ...FILES,
      'see.yaml': "statuses:\n  - { id: spots, label: Spots, for: 'not self.has_tag(\"living\")', when: 'can_see(self, player, 9)' }\n",
      'map.yaml': FILES['map.yaml']!.replace(/    rows:[\s\S]*?start:/, '    rows:\n      - "########"\n      - "#@..W.o#"\n      - "########"\nstart:'),
    }),
  ]);
  const w = World.create(d, 1);
  const spots = () => w.hasStatus(rock(w), 't:spots');
  w.step();
  assert.ok(spots(), 'through the pane');
  moveTo(w.player, 3, 1);
  w.queueAction({ kind: 'act', action: 't:board_up', x: 4, y: 1 });
  steps(w, 60);
  assert.ok(spots());
  w.step();
  assert.equal(cell(w, 4, 1), 't:boarded');
  assert.ok(!spots(), 'the boards block the view in the completion tick');
});

test('actions: snapshot and hash cover the activity and changed tiles', () => {
  const a = world();
  const b = world();
  for (const w of [a, b]) moveTo(w.player, 4, 1);
  a.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  a.step();
  b.step();
  assert.notEqual(a.hash(), b.hash(), 'the activity is hashed');
  assert.deepEqual(a.snapshot().tiles, []);
  steps(a, 60);
  const boarded = a.snapshot();
  assert.deepEqual(boarded.tiles, [[5, 1, 't:boarded']]);
  assert.equal(boarded.entities[0]!.activity, null);
  // Same history ⇒ same hash; a changed cell alone changes it.
  const c = world();
  moveTo(c.player, 4, 1);
  c.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(c, 61);
  assert.equal(c.hash(), a.hash());
  c.grid.setTile(1 * c.grid.width + 5, c.def.ids.tiles['t:pane']!);
  assert.deepEqual(c.snapshot().tiles, [], 'back to the map tile: no longer listed');
  assert.notEqual(c.hash(), a.hash());
});

test('actions: timed item use consumes at completion; cancelled uses keep the item', () => {
  const w = world();
  const before = food(w);
  w.queueAction({ kind: 'use', item: 't:salve' });
  w.step();
  assert.deepEqual(w.lastAction, { kind: 'use', item: 't:salve', moved: 0, ok: true, stage: 'start', tick: 0 });
  assert.equal(hudModel(w).activity!.label, 'Apply');
  steps(w, 29);
  assert.equal(count(w, 't:salve'), 2);
  w.step(); // tick 30
  assert.deepEqual(w.lastAction, { kind: 'use', item: 't:salve', moved: 1, ok: true, stage: 'complete', tick: 30 });
  assert.equal(count(w, 't:salve'), 1);
  assert.ok(Math.abs(food(w) - (before + 10 - 3.1)) < 1e-9);

  w.queueAction({ kind: 'use', item: 't:salve' });
  steps(w, 5);
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  w.step();
  assert.equal(w.lastAction!.reason, 'cancelled');
  assert.equal(hudModel(w).lastAction, 'Apply cancelled.');
  steps(w, 40);
  assert.equal(count(w, 't:salve'), 1);

  // interrupt: heard(self, 0.2) — a noise heard on tick t interrupts on t + 1.
  w.queueAction({ kind: 'use', item: 't:salve' });
  w.step();
  rock(w).m[w.def.ids.measurements['t:vol']!] = 9;
  w.step();
  w.step();
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(count(w, 't:salve'), 1);
});

test('actions: busy and doing in statuses', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  const st = (id: string) => w.hasStatus(w.player, id);
  w.queueAction({ kind: 'act', action: 't:nap' });
  w.step();
  assert.ok(st('t:napping') && st('t:occupied') && !st('t:working'));
  steps(w, 20);
  assert.ok(!st('t:napping') && !st('t:occupied'));
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  w.step();
  assert.ok(!st('t:napping') && st('t:occupied') && st('t:working'));
});

test('availableActions: self actions, tile actions × cells in reach, item uses; pure', () => {
  const w = world();
  moveTo(w.player, 4, 2);
  const hash = w.hash();
  const rng = w.rng.state;
  const list = w.availableActions();
  assert.equal(w.hash(), hash);
  assert.equal(w.rng.state, rng, 'random() in `when` draws from a throwaway RNG');
  assert.deepEqual(
    list.map((a) => [a.kind, a.action ?? a.item, a.x ?? null, a.y ?? null, a.ok, a.reason ?? null]),
    [
      ['act', 't:nap', null, null, true, null],
      ['act', 't:hum', null, null, true, null],
      ['act', 't:lucky', null, null, list[2]!.ok, list[2]!.reason ?? null],
      ['act', 't:fidget', null, null, true, null],
      ['act', 't:wait_soft', null, null, false, 'cannot_act'],
      ['act', 't:board_up', 5, 1, true, null],
      ['act', 't:smash', 5, 1, true, null],
      ['act', 't:fill', 3, 3, true, null],
      ['use', 't:salve', null, null, true, null],
    ],
  );
  // Not ok: missing items are listed with the reason; out-of-reach cells are omitted.
  w.player.inv!.stacks.splice(0, w.player.inv!.stacks.length);
  const after = w.availableActions();
  assert.deepEqual(after.find((a) => a.action === 't:board_up'), {
    kind: 'act',
    action: 't:board_up',
    x: 5,
    y: 1,
    label: 'Board up',
    ok: false,
    reason: 'missing',
    missing: [
      { item: 't:saw', label: 'Saw', count: 1 },
      { item: 't:board', label: 'Board', count: 2 },
    ],
  });
  moveTo(w.player, 1, 1);
  assert.ok(!w.availableActions().some((a) => a.x !== undefined));
});

// ── Shells ──────────────────────────────────────────────────────────────────

test('hud: progress text and the ascii/browser activity views', () => {
  assert.equal(progressText('Barricading', 0.6), 'Barricading [######----] 60%');
  assert.equal(progressText('X', 0), 'X [----------] 0%');
  const w = world();
  assert.equal(hudModel(w).activity, null);
  assert.equal(activityBar(hudModel(w)), null);
  w.queueAction({ kind: 'act', action: 't:nap' });
  steps(w, 11);
  const m = hudModel(w);
  assert.equal(m.activity!.text, 'Napping [#####-----] 55%');
  assert.ok(hudLines(m).includes('Napping [#####-----] 55%'));
  assert.deepEqual(activityBar(m), { label: 'Napping', percent: 55 });
  assert.equal(hudModel(world()).lastAction, null);
});

test('hud: action texts', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  const text = (a: Parameters<World['queueAction']>[0]) => {
    w.queueAction(a);
    w.step();
    return hudModel(w).lastAction;
  };
  assert.equal(text({ kind: 'act', action: 't:board_up', x: 5, y: 1 }), 'You start boarding up.');
  steps(w, 60);
  assert.equal(hudModel(w).lastAction, 'You finish boarding up.');
  w.grid.setTile(1 * w.grid.width + 5, w.def.ids.tiles['t:pane']!);
  assert.equal(text({ kind: 'act', action: 't:board_up', x: 5, y: 3 }), "You can't reach that.");
  assert.equal(text({ kind: 'act', action: 't:board_up', x: 5, y: 2 }), "You can't board up that.");
  assert.equal(text({ kind: 'act', action: 't:wait_soft' }), "You can't wait now.");
  assert.equal(text({ kind: 'act', action: 't:nap' }), 'You start napping.');
  assert.equal(text({ kind: 'act', action: 't:hum' }), 'You finish hum.');
  assert.equal(text({ kind: 'act', action: 't:nope' }), 'Unknown action t:nope');
  w.player.inv!.stacks.splice(0, w.player.inv!.stacks.length);
  assert.equal(text({ kind: 'act', action: 't:board_up', x: 5, y: 1 }), 'You need Saw, Board x2.');
});

test('ascii: x opens the action list, 1-9 start one, any other key closes it', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'x', keys);
  assert.ok(keys.actions);
  assert.deepEqual(keys.actions, actionMenu(w));
  assert.ok(keys.actions.every((a) => a.actions.every((x) => x.kind === 'act')), 'no container in reach: no take all');
  assert.match(actionMenuText(keys.actions), /^act: 1\) Nap {2}2\) Hum/);
  assert.match(actionMenuText(keys.actions), /\d\) Board up \(5,1\)/);
  assert.match(actionMenuText(keys.actions), /\d\) Wait \[Not now\]/);
  const k = keys.actions.findIndex((a) => a.label === 'Board up') + 1;
  handleKey(w, String(k), keys);
  assert.equal(keys.actions, null);
  w.step();
  assert.equal(w.player.activity!.action, w.def.ids.actions['t:board_up']);
  // Any other key closes the list (and still does its job: moving cancels).
  handleKey(w, 'x', keys);
  handleKey(w, 'h', keys);
  assert.equal(keys.actions, null);
  w.step();
  assert.equal(w.player.activity, null);
  assert.equal(w.lastAction!.reason, 'cancelled');
  assert.equal(actionMenuText([]), 'no actions here (any key)');
});

test('ascii: the renderer shows a changed tile', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  const row = () => frameToText(renderAscii(w, { width: 9, height: 3 })).split('\n')[1]!;
  assert.equal(row(), '#...@W#  ');
  w.queueAction({ kind: 'act', action: 't:board_up', x: 5, y: 1 });
  steps(w, 61);
  assert.equal(row(), '#...@H#  ');
});

test('ascii: the x list adds take all for reachable non-empty containers, after the actions', () => {
  const w = world();
  const bin = w.containersAt(1, 3)[0]!;
  bin.stacks.push({ item: w.def.ids.items['t:salve']!, count: 1 });
  moveTo(w.player, 2, 2);
  const list = actionMenu(w);
  const last = list[list.length - 1]!;
  assert.equal(last.label, 'Take all from Bin');
  assert.deepEqual([last.x, last.y], [1, 3]);
  assert.deepEqual(last.actions, [{ kind: 'take', container: bin.id, item: 't:salve' }]);
  assert.ok(list.slice(0, -1).every((a) => a.actions[0]!.kind === 'act'));
  const keys: KeyState = { dropPending: false, actions: list };
  handleKey(w, String(list.length), keys);
  w.step();
  assert.equal(count(w, 't:salve'), 3);
});

test('panels: the loot panel has no Actions section; it shows only with containers in reach', () => {
  const w = world();
  moveTo(w.player, 4, 1);
  assert.equal(lootView(hudModel(w), false), null);
  moveTo(w.player, 2, 2);
  const lv = lootView(hudModel(w), false)!;
  assert.deepEqual(Object.keys(lv).sort(), ['put', 'sections']);
  assert.equal(lv.sections[0]!.title, 'Bin');
});

// ── Two-genre scenarios ─────────────────────────────────────────────────────

function game(name: keyof typeof GAMES, seed: number): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), seed);
}

/** Walk the player to (x, y) (or next to it), stepping until the path ends. */
function walk(w: World, x: number, y: number, adjacent = false): void {
  w.queueIntent({ kind: 'goto', x, y, adjacent });
  w.step();
  assert.ok(w.lastGoto?.ok, `no path to ${x},${y}`);
  for (let i = 0; i < 2000 && w.player.path; i++) w.step();
  assert.equal(w.player.path, null);
}

test('zombie: loot a hammer, planks and nails (seed 1), then barricade a window while the shamblers hear it', () => {
  const w = game('zombie', 1);
  const id = (s: string) => w.def.ids.items[s]!;
  const kit = { 'zmb:hammer': 1, 'zmb:plank': 2, 'zmb:nails': 4 };
  const total = (item: string) => [...w.containers.values()].filter((c) => c.kind === 'tile').reduce((n, c) => n + countOf(c, id(item)), 0);
  for (const [item, n] of Object.entries(kit)) assert.ok(total(item) >= n, `seed 1 has ${total(item)} ${item}`);

  // Loot: visit the containers that hold kit items, nearest first, until the kit is complete.
  const have = (item: string) => countOf(w.player.inv!, id(item));
  const needed = () => Object.entries(kit).filter(([item, n]) => have(item) < n);
  for (let guard = 0; needed().length && guard < 10; guard++) {
    const want = needed().map(([item]) => id(item));
    const p = w.player;
    const c = [...w.containers.values()]
      .filter((c) => c.kind === 'tile' && c.stacks.some((s) => want.includes(s.item)))
      .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0]!;
    walk(w, c.x, c.y, true);
    for (const s of [...c.stacks]) if (want.includes(s.item)) w.queueAction({ kind: 'take', container: c.id, item: w.def.items[s.item]!.id });
    w.step();
  }
  assert.deepEqual(needed(), []);

  // The bedroom window of the north-west house, from inside.
  const [wx, wy] = [16, 3];
  assert.equal(cell(w, wx, wy), 'zmb:window');
  walk(w, 15, 3);
  const offered = w.availableActions().find((a) => a.action === 'zmb:barricade' && a.x === wx && a.y === wy);
  assert.equal(offered?.ok, true);
  const planks = have('zmb:plank');
  const nails = have('zmb:nails');
  const shambler = w.entities.find((e) => e.archetype.id === 'zmb:shambler' && Math.hypot(e.x - 15, e.y - 3) <= 14);
  w.queueAction({ kind: 'act', action: 'zmb:barricade', x: wx, y: wy });
  w.step();
  const start = w.lastAction!;
  assert.equal(start.stage, 'start');
  assert.equal(hudModel(w).activity!.label, 'Barricading');
  assert.equal(hudModel(w).lastAction, 'You start barricading.');
  steps(w, 59);
  assert.equal(cell(w, wx, wy), 'zmb:window');
  w.step();
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(w.lastAction!.tick, start.tick + 60);
  assert.equal(cell(w, wx, wy), 'zmb:barricaded_window');
  assert.equal(have('zmb:plank'), planks - 2);
  assert.equal(have('zmb:nails'), nails - 4);
  assert.equal(have('zmb:hammer'), 1);
  assert.ok(w.noises.some((n) => n.x === 15 && n.y === 3 && n.radius >= 12), 'the hammering is heard at completion');
  if (shambler) assert.equal(shambler.heardTick, start.tick + 60);
  assert.ok(!lineOfSight(w.grid, 19, 3, 14, 3), 'the barricade blocks the view in');
  assert.ok(!w.availableActions().some((a) => a.action === 'zmb:barricade' && a.x === wx));
});

test('zombie: a bandage takes 3 s and a nearby noise wastes the attempt', () => {
  const w = game('zombie', 1);
  const inv = w.player.inv!;
  const bandage = w.def.ids.items['zmb:bandage']!;
  inv.stacks.push({ item: bandage, count: 1 });
  w.player.m[w.def.ids.measurements['std:hp']!] = 50;
  w.queueAction({ kind: 'use', item: 'zmb:bandage' });
  w.step();
  assert.equal(w.lastAction!.stage, 'start');
  // A noise heard on the start tick (hearing runs after the work step).
  w.player.heardTick = w.tick - 1;
  w.step();
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(countOf(inv, bandage), 1);
  w.player.heardTick = -1;
  w.queueAction({ kind: 'use', item: 'zmb:bandage' });
  steps(w, 31);
  assert.equal(w.lastAction!.ok, true);
  assert.equal(w.lastAction!.stage, 'complete');
  assert.equal(countOf(inv, bandage), 0);
});

test('vampire: shutter a window, then rest by a coffin until a bat screech wakes you', () => {
  const w = game('vampire', 1);
  const hp = () => w.value(w.player, 'std:hp')!;
  // Shutters on the west room's north window.
  walk(w, 3, 1);
  assert.equal(cell(w, 3, 0), 'vamp:window');
  w.queueAction({ kind: 'act', action: 'vamp:shutter', x: 3, y: 0 });
  steps(w, 21);
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(cell(w, 3, 0), 'vamp:shuttered_window');
  assert.equal(w.grid.opaque[3], 1);

  // Rest is only offered on the crypt floor.
  assert.equal(w.availableActions().find((a) => a.action === 'vamp:rest')!.reason, 'cannot_act');
  walk(w, 10, 2);
  assert.equal(w.grid.tileAt(10, 2)!.id, 'vamp:crypt');
  assert.equal(w.availableActions().find((a) => a.action === 'vamp:rest')!.ok, true);

  // By the coffin, the hall's bat spots the vampire and screeches: the rest is
  // interrupted and restores nothing.
  w.player.m[w.def.ids.measurements['std:hp']!] = 40;
  w.queueAction({ kind: 'act', action: 'vamp:rest' });
  w.step();
  assert.equal(hudModel(w).activity!.label, 'Resting');
  for (let i = 0; i < 100 && w.player.activity; i++) w.step();
  assert.equal(w.lastAction!.action, 'vamp:rest');
  assert.equal(w.lastAction!.reason, 'interrupted', JSON.stringify(w.lastAction));
  assert.ok(w.player.heardTick >= 0, 'woken by a noise');
  assert.ok(hp() < 45, `${hp()}`);

  // Down in the wine cellar's crypt floor, out of the bats' sight, a rest completes.
  walk(w, 20, 11);
  assert.equal(w.grid.tileAt(20, 11)!.id, 'vamp:crypt');
  const before = hp();
  let rested = false;
  for (let attempt = 0; attempt < 10 && !rested; attempt++) {
    w.queueAction({ kind: 'act', action: 'vamp:rest' });
    for (let i = 0; i < 120 && !rested; i++) {
      w.step();
      rested = w.lastAction!.action === 'vamp:rest' && w.lastAction!.ok && w.lastAction!.stage === 'complete';
      if (!w.player.activity) break;
    }
  }
  assert.ok(rested, JSON.stringify(w.lastAction));
  assert.ok(hp() >= before + 25, `${before} → ${hp()}`);
});
