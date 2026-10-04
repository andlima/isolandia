import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, hudModel, loadPacksOrThrow, reasonText, World, type Action, type ActionFailure, type Definition, type Entity } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { clampMenu, contextMenu, menuTitle, moveSelection, runMenuItem } from '../src/web/menu.ts';
import { clickIntent } from '../src/web/panels.ts';
import { fixture, GAMES } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   ###########      W = pane (not walkable), ~ = mud (walkable, tag soft)
//   #@.....W#W#      B = bin (a container tile); the pane at (9, 1) is walled in
//   #.......###      the hero carries a saw and 1 board (board_up needs 2)
//   #B.o~....##      `o` is a rock
//   ###########

const FILES: Record<string, string> = {
  'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: pane, label: Pane, glyph: "W", color: cyan, walkable: false, opaque: false }
  - { id: boarded, label: Boarded pane, glyph: "H", color: yellow, walkable: false }
  - { id: mud, label: Mud, glyph: "~", color: yellow, walkable: true, tags: [soft] }
  - { id: bin, label: Bin, glyph: B, color: gray, walkable: false, container: { capacity: 5 } }
`,
  'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    measurements: [hp, food]
    ticks_per_turn: 0
    inventory: { capacity: 10, items: { saw: 1, board: 1 } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`,
  'items.yaml': `items:
  - { id: saw, label: Saw, glyph: "/", color: gray, weight: 1 }
  - { id: board, label: Board, glyph: "=", color: yellow, weight: 1 }
  - id: salve
    label: Salve
    glyph: "!"
    color: green
    weight: 0.1
    use: { label: Apply, effects: [{ type: apply, measurement: food, delta: 1 }] }
`,
  'actions.yaml': `actions:
  - id: board_up
    label: Board up
    target: { tiles: [pane] }
    tools: [saw]
    consume: { board: 2 }
    duration: 6
    effects:
      - { type: set_tile, tile: boarded }
  - id: fill
    label: Fill
    target: { tags: [soft] }
    duration: 1
    effects:
      - { type: set_tile, tile: floor }
  - id: sweep
    label: Sweep
    target: { tiles: [floor] }
    effects:
      - { type: apply, measurement: food, delta: 1 }
  - id: nap
    label: Nap
    target: self
    duration: 2
    effects:
      - { type: apply, measurement: food, delta: 5 }
  - id: wait_soft
    label: Wait
    target: self
    when: 'tile.has_tag("soft")'
    unavailable: Only on mud
    effects:
      - { type: apply, measurement: food, delta: 1 }
  - id: lucky
    label: Try luck
    target: self
    when: 'random(0, 1) == 1'
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
      - "###########"
      - "#@.....W#W#"
      - "#.......###"
      - "#B.o~....##"
      - "###########"
start:
  map: room
  player: hero
`,
};

const DEF: Definition = loadPacksOrThrow([fixture(FILES)]);

const world = (seed = 1) => World.create(DEF, seed);

function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

function moveTo(e: Entity, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
}

function give(w: World, item: string, count: number): void {
  const k = w.def.ids.items[item]!;
  add(w.player.inv!, k, count, w.def.items[k]!.weight);
}

const BOARD: Action = { kind: 'act', action: 't:board_up', x: 7, y: 1 };

// ── Walk-then-act ───────────────────────────────────────────────────────────

test('then: queued on arrival and applied in the same tick', () => {
  const w = world();
  give(w, 't:board', 2);
  const intent = w.approachIntent(BOARD);
  assert.deepEqual(intent, { kind: 'goto', x: 7, y: 1, adjacent: true, then: BOARD });
  w.queueIntent(intent!);
  w.step();
  assert.deepEqual(w.player.then, BOARD);
  assert.equal(w.player.activity, null);
  let arrived = -1;
  for (let i = 0; i < 200 && arrived < 0; i++) {
    w.step();
    if (!w.player.path) arrived = w.tick - 1;
  }
  assert.equal(Math.max(Math.abs(w.player.x - 7), Math.abs(w.player.y - 1)), 1);
  assert.equal(w.player.then, null);
  const activity = w.player.activity as Entity['activity'];
  assert.equal(activity?.action, w.def.ids.actions['t:board_up']);
  assert.equal(activity!.startTick, arrived);
  assert.equal(w.lastAction!.stage, 'start');
});

test('then: an empty path queues it in the same tick', () => {
  const w = world();
  give(w, 't:board', 2);
  moveTo(w.player, 6, 1);
  w.queueIntent({ kind: 'goto', x: 7, y: 1, adjacent: true, then: BOARD });
  w.step();
  assert.equal(w.player.activity?.startTick, 0);
  // A goto to the player's own cell with a self action.
  const v = world();
  v.queueIntent({ kind: 'goto', x: 1, y: 1, then: { kind: 'act', action: 't:nap' } });
  v.step();
  assert.equal(v.player.activity?.action, v.def.ids.actions['t:nap']);
});

test('then: no path drops it and records unreachable', () => {
  const w = world();
  const act: Action = { kind: 'act', action: 't:board_up', x: 9, y: 1 };
  w.queueIntent(w.approachIntent(act)!);
  w.step();
  assert.equal(w.player.then, null);
  assert.equal(w.lastGoto!.ok, false);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:board_up', moved: 0, ok: false, stage: 'complete', reason: 'unreachable', tick: 0 });
  assert.equal(hudModel(w).lastAction, "You can't get there.");
  // A take from afar names its item.
  const bin = w.containersAt(1, 3)[0]!;
  w.queueIntent({ kind: 'goto', x: 9, y: 1, adjacent: true, then: { kind: 'take', container: bin.id, item: 't:saw' } });
  w.step();
  assert.equal(w.lastAction!.item, 't:saw');
  assert.equal(w.lastAction!.reason, 'unreachable');
  assert.equal(hudModel(w).lastAction, "You can't get there.");
});

test('then: a path cut mid-way by set_tile drops it silently', () => {
  const w = world();
  give(w, 't:board', 2);
  w.queueIntent(w.approachIntent(BOARD)!);
  steps(w, 2);
  const p = w.player;
  assert.ok(p.path && p.then);
  w.grid.setTile(p.path[p.pathPos]!, w.def.ids.tiles['t:wall']!);
  for (let i = 0; i < 50 && p.path; i++) w.step();
  assert.equal(p.path, null);
  assert.equal(p.then, null);
  assert.equal(p.activity, null);
  assert.equal(w.lastAction, null);
});

test('then: a new intent or an activity replaces it', () => {
  const w = world();
  give(w, 't:board', 2);
  w.queueIntent(w.approachIntent(BOARD)!);
  w.step();
  w.queueIntent({ kind: 'goto', x: 5, y: 2 });
  w.step();
  assert.equal(w.player.then, null);
  const nap: Action = { kind: 'act', action: 't:nap' };
  w.queueIntent(w.approachIntent(BOARD)!);
  w.step();
  w.queueIntent({ kind: 'goto', x: 5, y: 2, then: nap });
  w.step();
  assert.deepEqual(w.player.then, nap);
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  w.step();
  assert.equal(w.player.then, null);
  // Starting an activity clears the path, and the pending then with it.
  w.queueIntent(w.approachIntent(BOARD)!);
  w.step();
  w.queueAction(nap);
  w.step();
  assert.equal(w.player.path, null);
  assert.equal(w.player.then, null);
  // An instant action does not.
  moveTo(w.player, 1, 2);
  w.queueIntent(w.approachIntent(BOARD)!);
  w.step();
  w.queueAction({ kind: 'act', action: 't:wait_soft' });
  w.step();
  assert.equal(w.lastAction!.reason, 'cannot_act');
  assert.deepEqual(w.player.then, BOARD);
});

test('then: only the player may carry it', () => {
  const w = world();
  assert.throws(() => w.queueIntent({ kind: 'goto', x: 2, y: 2, then: BOARD }, w.entities[1]!), /only the player/);
  w.queueIntent({ kind: 'goto', x: 2, y: 2 }, w.entities[1]!);
});

test('then: part of the snapshot and hash; deterministic', () => {
  const run = (withThen: boolean) => {
    const w = world(7);
    give(w, 't:board', 2);
    w.queueIntent(withThen ? w.approachIntent(BOARD)! : { kind: 'goto', x: 7, y: 1, adjacent: true });
    w.step();
    return w;
  };
  const a = run(true);
  assert.deepEqual(a.snapshot().entities[0]!.then, BOARD);
  assert.equal(run(false).snapshot().entities[0]!.then, null);
  assert.notEqual(a.hash(), run(false).hash());
  const full = () => {
    const w = run(true);
    steps(w, 150);
    return w.hash();
  };
  assert.equal(full(), full());
});

// ── approachIntent ──────────────────────────────────────────────────────────

test('approachIntent: in reach, no reach needed, out of reach, walkable and container targets', () => {
  const w = world();
  assert.equal(w.approachIntent({ kind: 'act', action: 't:nap' }), null);
  assert.equal(w.approachIntent({ kind: 'use', item: 't:salve' }), null);
  assert.equal(w.approachIntent({ kind: 'drop', item: 't:saw' }), null);
  assert.equal(w.approachIntent({ kind: 'act', action: 't:sweep', x: 2, y: 2 }), null);
  const fill: Action = { kind: 'act', action: 't:fill', x: 4, y: 3 };
  assert.deepEqual(w.approachIntent(fill), { kind: 'goto', x: 4, y: 3, adjacent: false, then: fill });
  const bin = w.containersAt(1, 3)[0]!;
  const take: Action = { kind: 'take', container: bin.id, item: 't:saw' };
  assert.deepEqual(w.approachIntent(take), { kind: 'goto', x: 1, y: 3, adjacent: true, then: take });
  moveTo(w.player, 2, 2);
  assert.equal(w.approachIntent(take), null);
  assert.equal(w.approachIntent({ kind: 'act', action: 't:nope', x: 9, y: 9 }), null);
});

// ── interactionsAt ──────────────────────────────────────────────────────────

test('interactionsAt: tile actions with missing items, ignoring reach; pure', () => {
  const w = world();
  const hash = w.hash();
  const rng = w.rng.state;
  const list = w.interactionsAt(7, 1);
  assert.equal(w.hash(), hash);
  assert.equal(w.rng.state, rng);
  assert.deepEqual(list, [
    {
      id: 'act:t:board_up',
      label: 'Board up',
      kind: 'act',
      ok: false,
      reason: 'missing',
      missing: [{ item: 't:board', label: 'Board', count: 1 }],
      action: BOARD,
      inReach: false,
    },
  ]);
  assert.equal(reasonText(list[0]!), 'Needs: Board');
  w.player.inv!.stacks.length = 0;
  assert.equal(reasonText(w.interactionsAt(7, 1)[0]!), 'Needs: Saw, 2× Board');
  give(w, 't:saw', 1);
  give(w, 't:board', 2);
  moveTo(w.player, 6, 2);
  assert.deepEqual(
    w.interactionsAt(7, 1).map((e) => [e.ok, e.inReach]),
    [[true, true]],
  );
});

test('interactionsAt: order on the own cell and on another cell; containers', () => {
  const w = world();
  w.queueAction({ kind: 'drop', item: 't:board' });
  w.step();
  const own = w.interactionsAt(1, 1);
  assert.deepEqual(
    own.map((e) => [e.id, e.ok, e.reason ?? null, e.inReach]),
    [
      ['act:t:sweep', true, null, true],
      [`open:${own[1]!.container}`, true, null, true],
      [`take_all:${own[1]!.container}`, true, null, true],
      ['act:t:nap', true, null, true],
      ['act:t:wait_soft', false, 'cannot_act', true],
      ['act:t:lucky', own[5]!.ok, own[5]!.reason ?? null, true],
    ],
  );
  assert.equal(own[1]!.label, 'Open Ground');
  assert.equal(own[2]!.label, 'Take all from Ground');
  assert.deepEqual(own[2]!.actions, [{ kind: 'take', container: own[1]!.container, item: 't:board' }]);
  assert.deepEqual(own[3]!.action, { kind: 'act', action: 't:nap' });
  assert.equal(reasonText(own[4]!), 'Only on mud');
  // Another walkable cell: tile actions, then walk.
  assert.deepEqual(
    w.interactionsAt(5, 2).map((e) => [e.kind, e.label, e.inReach]),
    [
      ['act', 'Sweep', false],
      ['walk', 'Walk here', false],
    ],
  );
  // The bin: open, and take all only when it holds something.
  const bin = w.containersAt(1, 3)[0]!;
  assert.deepEqual(
    w.interactionsAt(1, 3).map((e) => e.id),
    [`open:${bin.id}`],
  );
  bin.stacks.push({ item: w.def.ids.items['t:salve']!, count: 2 });
  assert.deepEqual(
    w.interactionsAt(1, 3).map((e) => [e.id, e.inReach]),
    [
      [`open:${bin.id}`, false],
      [`take_all:${bin.id}`, false],
    ],
  );
  // A wall offers nothing; out of bounds and after defeat, nothing at all.
  assert.deepEqual(w.interactionsAt(0, 0), []);
  assert.deepEqual(w.interactionsAt(-1, 2), []);
  assert.deepEqual(w.interactionsAt(11, 2), []);
  w.defeat = { tick: w.tick, message: 'x' };
  assert.deepEqual(w.interactionsAt(1, 1), []);
});

test('interactionsAt: take all with no room is too heavy', () => {
  const w = world();
  const bin = w.containersAt(1, 3)[0]!;
  bin.stacks.push({ item: w.def.ids.items['t:saw']!, count: 1 });
  w.player.inv!.load = w.player.inv!.capacity;
  const e = w.interactionsAt(1, 3).find((x) => x.kind === 'take_all')!;
  assert.equal(e.ok, false);
  assert.equal(reasonText(e), 'Too heavy');
});

// ── reasonText ──────────────────────────────────────────────────────────────

test('reasonText: every reason', () => {
  const expected: Record<ActionFailure, string> = {
    out_of_reach: 'Too far',
    too_heavy: 'Too heavy',
    missing: 'Missing items',
    cannot_use: 'Not now',
    no_inventory: 'No inventory',
    unknown_container: 'Not here',
    unknown_action: 'Unknown action',
    unknown_recipe: 'Unknown recipe',
    invalid_target: "Can't do that here",
    cannot_act: 'Not now',
    occupied: 'Something is in the way',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    unreachable: "Can't get there",
  };
  for (const [reason, text] of Object.entries(expected)) assert.equal(reasonText({ reason: reason as ActionFailure }), text, reason);
  assert.equal(reasonText({}), '');
  assert.equal(reasonText({ reason: 'cannot_act', unavailable: 'Only in the crypt' }), 'Only in the crypt');
  assert.equal(
    reasonText({
      reason: 'missing',
      missing: [
        { item: 'a:hammer', label: 'Hammer', count: 1 },
        { item: 'a:plank', label: 'Plank', count: 2 },
      ],
    }),
    'Needs: Hammer, 2× Plank',
  );
  // availableActions entries carry the same fields.
  const w = world();
  moveTo(w.player, 6, 1);
  const a = w.availableActions().find((x) => x.action === 't:board_up')!;
  assert.equal(reasonText(a), 'Needs: Board');
  assert.equal(reasonText(w.availableActions().find((x) => x.action === 't:wait_soft')!), 'Only on mud');
});

// ── Menu model ──────────────────────────────────────────────────────────────

test('menu: fixture mappings for tile actions, open, take all and walk', () => {
  const w = world();
  give(w, 't:board', 2);
  const bin = w.containersAt(1, 3)[0]!;
  bin.stacks.push({ item: w.def.ids.items['t:salve']!, count: 2 });
  assert.deepEqual(contextMenu(w, 7, 1), [{ label: 'Board up', disabled: false, run: { intent: { kind: 'goto', x: 7, y: 1, adjacent: true, then: BOARD } } }]);
  const far = contextMenu(w, 1, 3);
  assert.deepEqual(far[0], { label: 'Open Bin', disabled: false, run: { intent: clickIntent(w, 1, 3), openLoot: true, container: bin.id } });
  assert.deepEqual(far[1]!.run, {
    intent: { kind: 'goto', x: 1, y: 3, adjacent: true, then: { kind: 'take', container: bin.id, item: 't:salve' } },
    openLoot: true,
    container: bin.id,
  });
  assert.deepEqual(contextMenu(w, 5, 2)[1], { label: 'Walk here', disabled: false, run: { intent: { kind: 'goto', x: 5, y: 2 } } });
  moveTo(w.player, 2, 2);
  const near = contextMenu(w, 1, 3);
  assert.deepEqual(near[0]!.run, { openLoot: true, container: bin.id });
  assert.deepEqual(near[1]!.run, { actions: [{ kind: 'take', container: bin.id, item: 't:salve' }] });
  // Running: intents and actions are queued; disabled items do nothing.
  const own = contextMenu(w, 2, 2);
  const wait = own.find((i) => i.label === 'Wait')!;
  assert.deepEqual([wait.disabled, wait.hint], [true, 'Only on mud']);
  assert.equal(runMenuItem(w, wait), false);
  assert.equal(w.snapshot().actions.length, 0);
  assert.equal(runMenuItem(w, near[1]!), false);
  assert.equal(runMenuItem(w, near[0]!), true);
  w.step();
  assert.equal(w.lastAction!.item, 't:salve');
  assert.equal(w.lastAction!.ok, true);
});

function game(name: keyof typeof GAMES, seed = 1): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), seed);
}

test('menu: zombie window from afar, without and with materials', () => {
  const w = game('zombie');
  const [wx, wy] = [16, 3];
  assert.equal(w.grid.tileAt(wx, wy)!.id, 'zmb:window');
  assert.ok(Math.max(Math.abs(w.player.x - wx), Math.abs(w.player.y - wy)) > 1);
  const ids = w.def.ids.items;
  const inv = w.player.inv!;
  for (const id of ['zmb:hammer', 'zmb:plank', 'zmb:nails']) {
    const k = inv.stacks.findIndex((s) => s.item === ids[id]);
    if (k >= 0) inv.stacks.splice(k, 1);
  }
  const without = contextMenu(w, wx, wy).find((i) => i.label === 'Barricade')!;
  assert.equal(without.disabled, true);
  assert.equal(without.hint, 'Needs: Hammer, 2× Plank, 4× Nails');
  inv.stacks.push({ item: ids['zmb:hammer']!, count: 1 }, { item: ids['zmb:plank']!, count: 2 }, { item: ids['zmb:nails']!, count: 4 });
  const item = contextMenu(w, wx, wy).find((i) => i.label === 'Barricade')!;
  const act: Action = { kind: 'act', action: 'zmb:barricade', x: wx, y: wy };
  assert.deepEqual(item, { label: 'Barricade', disabled: false, run: { intent: { kind: 'goto', x: wx, y: wy, adjacent: true, then: act } } });
  // The survivor walks up and starts hammering.
  runMenuItem(w, item);
  for (let i = 0; i < 2000 && !w.player.activity; i++) w.step();
  assert.equal(w.player.activity?.action, w.def.ids.actions['zmb:barricade'], JSON.stringify(w.lastAction));
  assert.equal(hudModel(w).activity!.label, 'Barricading');
});

test('menu: vampire shutters from afar, and rest on your own cell', () => {
  const w = game('vampire');
  const shutter = contextMenu(w, 3, 0).find((i) => i.label === 'Close shutters')!;
  assert.deepEqual(shutter.run, { intent: { kind: 'goto', x: 3, y: 0, adjacent: true, then: { kind: 'act', action: 'vamp:shutter', x: 3, y: 0 } } });
  assert.equal(shutter.disabled, false);
  const { x, y } = w.player;
  const rest = contextMenu(w, x, y).find((i) => i.label === 'Rest')!;
  assert.deepEqual([rest.disabled, rest.hint], [true, 'Only in the crypt']);
  assert.ok(!contextMenu(w, x, y).some((i) => i.label === 'Walk here'));
  // Over in the crypt.
  w.queueIntent({ kind: 'goto', x: 10, y: 2 });
  for (let i = 0; i < 200 && (w.player.x !== 10 || w.player.y !== 2); i++) w.step();
  const ok = contextMenu(w, 10, 2).find((i) => i.label === 'Rest')!;
  assert.deepEqual(ok, { label: 'Rest', disabled: false, run: { actions: [{ kind: 'act', action: 'vamp:rest' }] } });
  assert.equal(menuTitle(w, 10, 2), `${w.grid.tileAt(10, 2)!.label} · hall`);
  assert.equal(menuTitle(w, 3, 0), w.grid.tileAt(3, 0)!.label);
  assert.equal(menuTitle(w, -1, 0), '');
});

test('menu: clamping inside the viewport and arrow selection', () => {
  assert.deepEqual(clampMenu(100, 100, 160, 120, 360, 640), { x: 100, y: 100 });
  assert.deepEqual(clampMenu(300, 600, 160, 120, 360, 640), { x: 196, y: 516 });
  assert.deepEqual(clampMenu(-5, -5, 400, 120, 360, 640), { x: 4, y: 4 });
  assert.equal(moveSelection(3, -1, 1), 0);
  assert.equal(moveSelection(3, -1, -1), 2);
  assert.equal(moveSelection(3, 2, 1), 0);
  assert.equal(moveSelection(3, 0, -1), 2);
  assert.equal(moveSelection(0, -1, 1), -1);
});
