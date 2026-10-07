import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, hudModel, loadPacksOrThrow, reasonText, World, type Action, type ActionFailure, type Definition, type Entity } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { clampMenu, clickPlan, contextMenu, formatDuration, hoverInfo, menuItems, menuRows, menuTitle, moveSelection, runMenuItem, shortcutOf } from '../src/web/menu.ts';
import { clickIntent } from '../src/web/panels.ts';
import { fixture, GAMES, genreCell } from './helpers.ts';

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

const BOARD: Action = { kind: 'act', action: 't:board_up', x: 7, y: 1, z: 0 };

// ── Walk-then-act ───────────────────────────────────────────────────────────

test('then: queued on arrival and applied in the same tick', () => {
  const w = world();
  give(w, 't:board', 2);
  const intent = w.approachIntent(BOARD);
  assert.deepEqual(intent, { kind: 'goto', x: 7, y: 1, z: 0, adjacent: true, then: BOARD });
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
  w.queueIntent({ kind: 'goto', x: 7, y: 1, z: 0, adjacent: true, then: BOARD });
  w.step();
  assert.equal(w.player.activity?.startTick, 0);
  // A goto to the player's own cell with a self action.
  const v = world();
  v.queueIntent({ kind: 'goto', x: 1, y: 1, z: 0, then: { kind: 'act', action: 't:nap' } });
  v.step();
  assert.equal(v.player.activity?.action, v.def.ids.actions['t:nap']);
});

test('then: no path drops it and records unreachable', () => {
  const w = world();
  const act: Action = { kind: 'act', action: 't:board_up', x: 9, y: 1, z: 0 };
  w.queueIntent(w.approachIntent(act)!);
  w.step();
  assert.equal(w.player.then, null);
  assert.equal(w.lastGoto!.ok, false);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:board_up', moved: 0, ok: false, stage: 'complete', reason: 'unreachable', tick: 0 });
  assert.equal(hudModel(w).lastAction, "You can't get there.");
  // A take from afar names its item.
  const bin = w.containersAt(1, 3)[0]!;
  w.queueIntent({ kind: 'goto', x: 9, y: 1, z: 0, adjacent: true, then: { kind: 'take', container: bin.id, item: 't:saw' } });
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
  w.queueIntent({ kind: 'goto', x: 5, y: 2, z: 0 });
  w.step();
  assert.equal(w.player.then, null);
  const nap: Action = { kind: 'act', action: 't:nap' };
  w.queueIntent(w.approachIntent(BOARD)!);
  w.step();
  w.queueIntent({ kind: 'goto', x: 5, y: 2, z: 0, then: nap });
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
  assert.throws(() => w.queueIntent({ kind: 'goto', x: 2, y: 2, z: 0, then: BOARD }, w.entities[1]!), /only the player/);
  w.queueIntent({ kind: 'goto', x: 2, y: 2, z: 0 }, w.entities[1]!);
});

test('then: part of the snapshot and hash; deterministic', () => {
  const run = (withThen: boolean) => {
    const w = world(7);
    give(w, 't:board', 2);
    w.queueIntent(withThen ? w.approachIntent(BOARD)! : { kind: 'goto', x: 7, y: 1, z: 0, adjacent: true });
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
  assert.equal(w.approachIntent({ kind: 'act', action: 't:sweep', x: 2, y: 2, z: 0 }), null);
  const fill: Action = { kind: 'act', action: 't:fill', x: 4, y: 3, z: 0 };
  assert.deepEqual(w.approachIntent(fill), { kind: 'goto', x: 4, y: 3, z: 0, adjacent: false, then: fill });
  const bin = w.containersAt(1, 3)[0]!;
  const take: Action = { kind: 'take', container: bin.id, item: 't:saw' };
  assert.deepEqual(w.approachIntent(take), { kind: 'goto', x: 1, y: 3, z: 0, adjacent: true, then: take });
  moveTo(w.player, 2, 2);
  assert.equal(w.approachIntent(take), null);
  assert.equal(w.approachIntent({ kind: 'act', action: 't:nope', x: 9, y: 9, z: 0 }), null);
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
      duration: 6,
      uses: [{ item: 't:board', label: 'Board', count: 2 }],
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
  assert.deepEqual(contextMenu(w, 7, 1), {
    items: [{ label: 'Board up', disabled: false, detail: '6s · uses 2× Board', run: { intent: { kind: 'goto', x: 7, y: 1, z: 0, adjacent: true, then: BOARD } } }],
    disabled: [],
    expanded: false,
  });
  const far = contextMenu(w, 1, 3).items;
  assert.deepEqual(far[0], { label: 'Open Bin', disabled: false, default: true, run: { intent: clickIntent(w, 1, 3), openLoot: true, container: bin.id } });
  assert.deepEqual(far[1]!.run, {
    intent: { kind: 'goto', x: 1, y: 3, z: 0, adjacent: true, then: { kind: 'take', container: bin.id, item: 't:salve' } },
    openLoot: true,
    container: bin.id,
  });
  assert.deepEqual(contextMenu(w, 5, 2).items[1], { label: 'Walk here', disabled: false, run: { intent: { kind: 'goto', x: 5, y: 2, z: 0 } } });
  moveTo(w.player, 2, 2);
  const near = contextMenu(w, 1, 3).items;
  assert.deepEqual(near[0]!.run, { openLoot: true, container: bin.id });
  assert.deepEqual(near[1]!.run, { actions: [{ kind: 'take', container: bin.id, item: 't:salve' }] });
  // Running: intents and actions are queued; disabled items do nothing.
  const own = contextMenu(w, 2, 2);
  const wait = own.disabled.find((i) => i.label === 'Wait')!;
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
  const [wx, wy] = genreCell('zombie', 22, 3);
  assert.equal(w.grid.tileAt(wx, wy)!.id, 'town:window');
  assert.ok(Math.max(Math.abs(w.player.x - wx), Math.abs(w.player.y - wy)) > 1);
  const ids = w.def.ids.items;
  const inv = w.player.inv!;
  for (const id of ['town:hammer', 'town:plank', 'town:nails']) {
    const k = inv.stacks.findIndex((s) => s.item === ids[id]);
    if (k >= 0) inv.stacks.splice(k, 1);
  }
  const without = contextMenu(w, wx, wy).disabled.find((i) => i.label === 'Barricade')!;
  assert.equal(without.disabled, true);
  assert.equal(without.hint, 'Needs: Hammer, 2× Plank, 4× Nails');
  inv.stacks.push({ item: ids['town:hammer']!, count: 1 }, { item: ids['town:plank']!, count: 2 }, { item: ids['town:nails']!, count: 4 });
  const item = contextMenu(w, wx, wy).items.find((i) => i.label === 'Barricade')!;
  const act: Action = { kind: 'act', action: 'town:barricade', x: wx, y: wy, z: 0 };
  assert.deepEqual(item, { label: 'Barricade', disabled: false, detail: item.detail, run: { intent: { kind: 'goto', x: wx, y: wy, z: 0, adjacent: true, then: act } } });
  // The survivor walks up and starts hammering.
  runMenuItem(w, item);
  for (let i = 0; i < 2000 && !w.player.activity; i++) w.step();
  assert.equal(w.player.activity?.action, w.def.ids.actions['town:barricade'], JSON.stringify(w.lastAction));
  assert.equal(hudModel(w).activity!.label, 'Barricading');
});

test('menu: vampire shutters from afar, and rest on your own cell', () => {
  const w = game('vampire');
  const [sx, sy] = genreCell('vampire', 4, 0);
  const shutter = contextMenu(w, sx, sy).items.find((i) => i.label === 'Close shutters')!;
  assert.deepEqual(shutter.run, { intent: { kind: 'goto', x: sx, y: sy, z: 0, adjacent: true, then: { kind: 'act', action: 'vamp:shutter', x: sx, y: sy, z: 0 } } });
  assert.equal(shutter.disabled, false);
  const { x, y } = w.player;
  const rest = contextMenu(w, x, y).disabled.find((i) => i.label === 'Rest')!;
  assert.deepEqual([rest.disabled, rest.hint], [true, 'Only in the crypt']);
  assert.ok(!menuItems(contextMenu(w, x, y)).some((i) => i.label === 'Walk here'));
  // Over in the crypt.
  const [cx, cy] = genreCell('vampire', 11, 5);
  w.queueIntent({ kind: 'goto', x: cx, y: cy, z: 0 });
  for (let i = 0; i < 200 && (w.player.x !== cx || w.player.y !== cy); i++) w.step();
  const ok = contextMenu(w, cx, cy).items.find((i) => i.label === 'Rest')!;
  assert.deepEqual(ok, { label: 'Rest', disabled: false, detail: '10s', run: { actions: [{ kind: 'act', action: 'vamp:rest' }] } });
  assert.equal(menuTitle(w, cx, cy), `${w.grid.tileAt(cx, cy)!.label} · hall`);
  assert.equal(menuTitle(w, sx, sy), w.grid.tileAt(sx, sy)!.label);
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

// ── Smart click, menu layout and hover ──────────────────────────────────────

/** A walkable cell next to (x, y) on the player's floor. */
function besideOf(w: World, x: number, y: number): [number, number] {
  for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    if (w.grid.walkable(x + dx, y + dy, w.player.z)) return [x + dx, y + dy];
  }
  throw new Error(`nothing walkable next to (${x}, ${y})`);
}

test('clickPlan: zombie fridge opens from afar and near; window always menus; wall walks; pile opens; own cell', () => {
  const w = game('zombie');
  const fridge = [...w.containers.values()].find((c) => c.kind === 'tile' && w.def.tiles[c.tile]!.id === 'town:fridge')!;
  const far = clickPlan(w, fridge);
  assert.equal(far.kind, 'run');
  assert.ok(far.kind === 'run');
  assert.equal(far.entry.kind, 'open');
  assert.deepEqual(far.item.run, { intent: clickIntent(w, fridge.x, fridge.y), openLoot: true, container: fridge.id });
  const hash = w.hash();
  const rng = w.rng.state;
  // The window: Barricade needs a hammer (disabled), nothing safe → menu; with materials too.
  const [wx, wy] = genreCell('zombie', 22, 3);
  assert.equal(clickPlan(w, { x: wx, y: wy, z: 0 }).kind, 'menu');
  const ids = w.def.ids.items;
  const inv = w.player.inv!;
  inv.stacks.push({ item: ids['town:hammer']!, count: 1 }, { item: ids['town:plank']!, count: 2 }, { item: ids['town:nails']!, count: 4 });
  assert.equal(clickPlan(w, { x: wx, y: wy, z: 0 }).kind, 'menu');
  inv.stacks.splice(-3, 3);
  // A plain wall (between the north-west house's bathroom and bedroom): walk (today's clickIntent).
  const wall = genreCell('zombie', 13, 3);
  assert.equal(w.grid.tileAt(wall[0], wall[1])!.id, 'std:wall');
  assert.deepEqual(clickPlan(w, { x: wall[0], y: wall[1], z: 0 }), { kind: 'walk', intent: clickIntent(w, wall[0], wall[1]) });
  // The player's own road cell: nothing to do.
  const { x: px, y: py } = w.player;
  assert.deepEqual(clickPlan(w, { x: px, y: py, z: 0 }), { kind: 'none' });
  assert.equal(w.hash(), hash);
  assert.equal(w.rng.state, rng);
  // Next to the fridge, the open is immediate.
  const [bx, by] = besideOf(w, fridge.x, fridge.y);
  moveTo(w.player, bx, by);
  const near = clickPlan(w, fridge);
  assert.ok(near.kind === 'run');
  assert.deepEqual(near.item.run, { openLoot: true, container: fridge.id });
  // A pile on the own cell: open it.
  w.queueAction({ kind: 'drop', item: 'town:crackers' });
  w.step();
  const pile = clickPlan(w, { x: bx, y: by, z: 0 });
  assert.ok(pile.kind === 'run');
  assert.equal(pile.entry.kind, 'open');
  assert.deepEqual(pile.item.run, { openLoot: true, container: w.containersAt(bx, by)[0]!.id });
});

test('clickPlan: vampire shutters menu; own cell with only Rest menus', () => {
  const w = game('vampire');
  const [sx, sy] = genreCell('vampire', 4, 0);
  assert.equal(clickPlan(w, { x: sx, y: sy, z: 0 }).kind, 'menu');
  const { x, y } = w.player;
  assert.equal(clickPlan(w, { x, y, z: 0 }).kind, 'menu');
  const own = contextMenu(w, x, y, 0, 'click');
  assert.deepEqual(own.items, []);
  assert.ok(own.disabled.some((i) => i.label === 'Rest'));
  assert.equal(own.expanded, true);
});

test('contextMenu: default first, enabled next, Walk here only on right-click, disabled folded', () => {
  const w = world();
  give(w, 't:board', 2);
  w.queueAction({ kind: 'drop', item: 't:board' });
  w.step();
  // Own cell: Sweep, Open Ground (default), Take all, Nap, Wait (disabled), Try luck.
  const own = contextMenu(w, 1, 1);
  assert.equal(own.items[0]!.label, 'Open Ground');
  assert.equal(own.items[0]!.default, true);
  assert.deepEqual(
    own.items.slice(1, 4).map((i) => i.label),
    ['Sweep', 'Take all from Ground', 'Nap'],
  );
  assert.ok(own.items.every((i) => !i.disabled && (i === own.items[0] || !i.default)));
  assert.ok(own.disabled.every((i) => i.disabled));
  assert.ok(own.disabled.some((i) => i.label === 'Wait'));
  assert.equal(own.expanded, false);
  assert.equal(clickPlan(w, { x: 1, y: 1, z: 0 }).kind, 'menu', 'Sweep and Nap are real actions');
  // Another floor cell: Sweep, then Walk here on right-click only; walk is never the default.
  const ctx = contextMenu(w, 5, 2);
  assert.deepEqual(
    ctx.items.map((i) => [i.label, i.default ?? false]),
    [
      ['Sweep', false],
      ['Walk here', false],
    ],
  );
  assert.deepEqual(
    contextMenu(w, 5, 2, 0, 'click').items.map((i) => i.label),
    ['Sweep'],
  );
  // The pane with too few boards: only disabled → expanded fold, nothing numbered.
  w.player.inv!.stacks.length = 0;
  const pane = contextMenu(w, 7, 1);
  assert.deepEqual([pane.items.length, pane.disabled.length, pane.expanded], [0, 1, true]);
  assert.equal(clickPlan(w, { x: 7, y: 1, z: 0 }).kind, 'menu');
  assert.deepEqual(menuRows(pane, true), [
    { kind: 'fold', label: "Can't do now (1) ▾", expanded: true },
    { kind: 'item', item: pane.disabled[0]! },
  ]);
});

test('menu rows: enabled entries numbered 1–9, then the fold; disabled never numbered or chosen', () => {
  const w = world();
  const own = contextMenu(w, 1, 1);
  const rows = menuRows(own, false);
  const keys = rows.flatMap((r) => (r.kind === 'item' ? [r.key ?? 0] : []));
  assert.deepEqual(
    keys,
    own.items.map((_, k) => k + 1),
  );
  assert.deepEqual(rows.at(-1), { kind: 'fold', label: `Can't do now (${own.disabled.length}) ▸`, expanded: false });
  const open = menuRows(own, true);
  const tail = open.slice(rows.length);
  assert.deepEqual(
    tail.map((r) => (r.kind === 'item' ? [r.item.disabled, r.key ?? 0] : null)),
    own.disabled.map(() => [true, 0]),
  );
  assert.equal(runMenuItem(w, own.disabled[0]!), false);
  // Ten enabled items: only the first nine get a digit.
  const many = { items: Array.from({ length: 10 }, (_, k) => ({ label: `a${k}`, disabled: false, run: {} })), disabled: [], expanded: false };
  assert.deepEqual(
    menuRows(many, false).map((r) => (r.kind === 'item' ? r.key : -1)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, undefined],
  );
  assert.equal(shortcutOf('Digit1'), 1);
  assert.equal(shortcutOf('Numpad9'), 9);
  assert.equal(shortcutOf('Digit0'), 0);
  assert.equal(shortcutOf('KeyE'), 0);
});

test('menu details: duration and uses on interactionsAt; formatted on enabled actions only', () => {
  const w = game('zombie');
  const [wx, wy] = genreCell('zombie', 22, 3);
  const hash = w.hash();
  const rng = w.rng.state;
  const e = w.interactionsAt(wx, wy).find((i) => i.id === 'act:town:barricade')!;
  assert.equal(w.hash(), hash);
  assert.equal(w.rng.state, rng);
  const action = w.def.actions[w.def.ids.actions['town:barricade']!]!;
  assert.equal(e.duration, action.duration.ticks / w.def.ticksPerSecond);
  assert.deepEqual(
    e.uses,
    action.consume.map((c) => ({ item: w.def.items[c.item]!.id, label: w.def.items[c.item]!.label, count: c.count })),
  );
  // Disabled: no detail, only the reason.
  assert.equal(contextMenu(w, wx, wy).disabled[0]!.detail, undefined);
  const ids = w.def.ids.items;
  w.player.inv!.stacks.push({ item: ids['town:hammer']!, count: 1 }, { item: ids['town:plank']!, count: 2 }, { item: ids['town:nails']!, count: 4 });
  const item = contextMenu(w, wx, wy, 0, 'click').items[0]!;
  assert.equal(item.label, 'Barricade');
  assert.equal(item.detail, `${formatDuration(e.duration!)} · uses 2× Plank, 4× Nails`);
  // Open and climb entries carry neither.
  const fridge = [...w.containers.values()].find((c) => c.kind === 'tile' && w.def.tiles[c.tile]!.id === 'town:fridge')!;
  assert.ok(w.interactionsAt(fridge.x, fridge.y).every((i) => i.duration === undefined && i.uses === undefined));
  assert.deepEqual([formatDuration(8), formatDuration(80), formatDuration(60), formatDuration(0.3)], ['8s', '1m 20s', '1m', '1s']);
});

test('interactionsAt: duration of an expression, evaluated purely; uses absent without consume', () => {
  const def = loadPacksOrThrow([
    fixture({
      ...FILES,
      'actions.yaml': `actions:
  - id: slow
    label: Slow
    target: self
    duration: 'self.food / 10'
    effects: [{ type: apply, measurement: food, delta: 1 }]
  - id: odd
    label: Odd
    target: self
    duration: 'random(1, 3)'
    effects: [{ type: apply, measurement: food, delta: 1 }]
`,
    }),
  ]);
  const w = World.create(def, 1);
  const hash = w.hash();
  const rng = w.rng.state;
  const own = w.interactionsAt(w.player.x, w.player.y);
  assert.equal(own.find((e) => e.id === 'act:t:slow')!.duration, 5);
  const odd = own.find((e) => e.id === 'act:t:odd')!;
  assert.ok(odd.duration! >= 1 && odd.duration! <= 3);
  assert.ok(own.every((e) => e.uses === undefined));
  assert.equal(w.hash(), hash);
  assert.equal(w.rng.state, rng);
});

test('hoverInfo: titles, hints and cursors', () => {
  const w = game('zombie');
  const fridge = [...w.containers.values()].find((c) => c.kind === 'tile' && w.def.tiles[c.tile]!.id === 'town:fridge')!;
  assert.deepEqual(hoverInfo(w, { kind: 'tile', x: fridge.x, y: fridge.y, z: 0 }), { title: 'Fridge · kitchen', hint: 'Click: Open', cursor: 'pointer' });
  const [wx, wy] = genreCell('zombie', 22, 3);
  assert.deepEqual(hoverInfo(w, { kind: 'tile', x: wx, y: wy, z: 0 }), { title: 'Window', hint: "Click: Can't do now", cursor: 'pointer' });
  const ids = w.def.ids.items;
  w.player.inv!.stacks.push({ item: ids['town:hammer']!, count: 1 }, { item: ids['town:plank']!, count: 2 }, { item: ids['town:nails']!, count: 4 });
  assert.equal(hoverInfo(w, { kind: 'tile', x: wx, y: wy, z: 0 }).hint, 'Click: 1 action');
  assert.deepEqual(hoverInfo(w, { kind: 'ground', x: genreCell('zombie', 13, 3)[0], y: genreCell('zombie', 13, 3)[1], z: 0 }), { title: 'Wall', hint: '', cursor: 'default' });
  const stairs = w.def.ids.tiles['std:stairs']!;
  const i = w.grid.cells.findIndex((t, k) => t === stairs && w.grid.link(k, 1) >= 0);
  const s = w.grid.cellOf(i);
  assert.deepEqual(hoverInfo(w, { kind: 'tile', ...s }), { title: menuTitle(w, s.x, s.y, s.z), hint: 'Click: Go up', cursor: 'pointer' });
  const p = w.player;
  assert.deepEqual(hoverInfo(w, { kind: 'entity', x: p.x, y: p.y, z: p.z, entity: p }), { title: p.archetype.label, hint: '', cursor: 'not-allowed' });
  // A pile: Ground plus its first items; a floor cell just walks.
  w.queueAction({ kind: 'drop', item: 'town:crackers' });
  w.queueAction({ kind: 'drop', item: 'town:water_bottle' });
  w.step();
  const pile = w.containersAt(p.x, p.y)[0]!;
  const labels = pile.stacks.map((st) => w.def.items[st.item]!.label).join(', ');
  assert.deepEqual(hoverInfo(w, { kind: 'pile', x: p.x, y: p.y, z: p.z, container: pile }), { title: `Ground · ${labels}`, hint: 'Click: Open', cursor: 'pointer' });
});
