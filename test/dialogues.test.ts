import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionMenu, conversationLines, handleKey, type KeyState } from '../src/ascii/terminal.ts';
import {
  actionText,
  add,
  facingOfStep,
  formatError,
  LEAVE_REFUSED_TEXT,
  loadPacks,
  loadPacksOrThrow,
  MAX_DIALOGUE_ENTRIES,
  SAVE_VERSION,
  World,
  type Definition,
  type LoadError,
  type PackSource,
  type SaveFile,
} from '../src/core/index.ts';
import { dialogueBox, dialogueKey } from '../src/web/dialogue.ts';
import { clickPlan, contextMenu, hoverInfo } from '../src/web/menu.ts';
import { assertRoundTrip, fixture } from './helpers.ts';

// Dialogues (docs/packs.md#dialogues) on a small fixture: a keeper NPC next
// to the player, one behind a thin wall, one that will not talk, one whose
// `start` list matches nothing, and one without a dialogue.

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true }
`;

// 5×2 cells; a thin wall between (1, 0) and (2, 0).
//   (0,0) player  (1,0) keeper  | (2,0) keeper behind the wall  (3,0) mute
//   (0,1) picky                   (2,1) grump
const MAP = `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "@": { tile: floor, player: true }
      "k": { tile: floor, spawn: keeper }
      "w": { tile: floor, spawn: keeper }
      "m": { tile: floor, spawn: mute }
      "g": { tile: floor, spawn: grump }
      "p": { tile: floor, spawn: picky }
      "|": { tile: wall }
      "-": { tile: wall }
    edges: true
    rows:
      - "+-+-+-+-+-+"
      - "|@ k|w m .|"
      - "+ + + + + +"
      - "|p . g . .|"
      - "+-+-+-+-+-+"
start:
  map: room
  player: hero
  defeat: { when: 'var("doom") >= 1', message: Doomed }
`;

const ARCHETYPES = `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    measurements: [hp, food]
    ticks_per_turn: 0
    inventory: { capacity: 3 }
  - { id: keeper, label: Keeper, glyph: k, color: white, measurements: [hp], ticks_per_turn: 0, dialogue: chat }
  - { id: mute, label: Mute, glyph: m, color: white, ticks_per_turn: 0 }
  - { id: grump, label: Grump, glyph: g, color: white, ticks_per_turn: 0, dialogue: grumpy }
  - { id: picky, label: Picky, glyph: p, color: white, ticks_per_turn: 0, dialogue: picky }
`;

const ITEMS = `items:
  - { id: coin, label: Coin, glyph: "$", color: yellow, weight: 0.1 }
  - { id: brick, label: Brick, glyph: "=", color: red, weight: 2 }
vars:
  - { id: told }
  - { id: roll }
  - { id: doom }
journal:
  - { id: rumor, text: The cellar door sticks. }
quests:
  - id: hunt
    title: The cellar
    stages:
      - { id: asked, journal: Ask around. }
      - { id: done, journal: Done., when: 'var("told") >= 50' }
`;

const DIALOGUES = `dialogues:
  - id: chat
    start:
      - { when: 'var("told") >= 5', node: done }
      - { node: hello }
    nodes:
      hello:
        text: What will it be?
        effects: [{ type: add_var, var: told, delta: 1 }]
        choices:
          - { text: Rumors?, to: rumor }
          - { text: Pay for the information, consume: { coin: 2 }, to: paid }
          - { text: Secret, when: 'var("told") >= 3', to: end }
          - { text: Locked, when: false, unavailable: Not yet, to: end }
          - { id: gift, once: true, text: A gift?, give: { brick: 2 }, to: hello }
          - { text: Hit, effects: [{ type: apply, measurement: hp, delta: -3, on: npc }], to: end }
          - { text: Roll, effects: [{ type: set_var, var: roll, value: "random(1, 1000)" }], to: end }
          - { text: Doom, effects: [{ type: set_var, var: doom, value: 1 }], to: end }
          - { text: Loop, to: loop_a }
      rumor:
        text: The cellar door sticks.
        effects: [{ type: journal, entry: rumor }, { type: quest, quest: hunt, stage: asked }]
        next: hello
      paid:
        speaker: player
        text: Here you go.
        leave: false
        choices: [{ text: Thanks, to: end, when: 'npc.hp > 0' }]
      loop_a: { text: A, next: loop_b }
      loop_b: { text: B, next: loop_a }
      done: { speaker: Narrator, text: Nothing more. }
  - id: grumpy
    when: false
    unavailable: He ignores you
    start: hi
    nodes:
      hi: { text: Hm. }
  - id: picky
    start: [{ when: 'var("told") > 100', node: a }]
    nodes:
      a: { text: A. }
`;

const FILES = { 'tiles.yaml': TILES, 'map.yaml': MAP, 'archetypes.yaml': ARCHETYPES, 'items.yaml': ITEMS, 'dialogues.yaml': DIALOGUES };

function def(files: Record<string, string> = {}): Definition {
  return loadPacksOrThrow([fixture({ ...FILES, ...files })]);
}

function world(seed = 1): World {
  return World.create(def(), seed);
}

/** Entity ids of the fixture. */
const PLAYER = 0;
const KEEPER = 1;
const WALLED = 2;
const MUTE = 3;
const PICKY = 4;
const GRUMP = 5;

function errorsOf(files: Record<string, string>, extra: PackSource[] = []): readonly LoadError[] {
  const r = loadPacks([fixture({ ...FILES, ...files }), ...extra]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], message: RegExp, path?: string): void {
  const hit = errors.find((e) => message.test(e.message) && (path === undefined || e.path === path));
  assert.ok(hit, `no error ${message}${path ? ` at ${path}` : ''}\ngot:\n${errors.map(formatError).join('\n')}`);
}

/** A dialogue file with one dialogue `d` (YAML indented under `dialogues:`). */
const oneDialogue = (body: string) => `dialogues:\n${body}  - id: grumpy\n    start: hi\n    nodes: { hi: { text: Hm. } }\n  - id: picky\n    start: a\n    nodes: { a: { text: A. } }\n`;

/** Open the keeper's conversation (one tick). */
function talk(w: World, entity = KEEPER): World {
  w.queueAction({ kind: 'talk', entity });
  w.step();
  return w;
}

/** Index of the visible choice with `text`. */
function pick(w: World, text: string): number {
  const k = w.conversationView()!.choices.findIndex((c) => c.text === text);
  assert.ok(k >= 0, `no visible choice '${text}' in ${JSON.stringify(w.conversationView()!.choices.map((c) => c.text))}`);
  return k;
}

const varOf = (w: World, id: string) => w.vars[w.def.ids.vars[`t:${id}`]!]!;
const nodeOf = (w: World) => (w.conversation ? w.conversation.dialogue.nodes[w.conversation.node]!.name : null);
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── Loader ──────────────────────────────────────────────────────────────────

test('dialogues: compiled nodes, start list, synthesized Continue and Leave, speakers, archetype dialogue', () => {
  const d = def();
  assert.deepEqual(d.ids.dialogues, { 't:chat': 0, 't:grumpy': 1, 't:picky': 2 });
  const chat = d.dialogues[0]!;
  assert.deepEqual(
    chat.nodes.map((n) => n.name),
    ['hello', 'rumor', 'paid', 'loop_a', 'loop_b', 'done'],
  );
  assert.deepEqual(
    chat.start.map((s) => [s.whenFn !== null, s.node]),
    [
      [true, 5],
      [false, 0],
    ],
  );
  const [hello, rumor, paid, , , done] = chat.nodes;
  assert.equal(hello!.choices.length, 9);
  assert.deepEqual(
    rumor!.choices.map((c) => [c.text, c.to, c.auto]),
    [['Continue', 0, true]],
  );
  assert.deepEqual(
    done!.choices.map((c) => [c.text, c.to, c.auto]),
    [['Leave', -1, false]],
  );
  assert.deepEqual(hello!.speaker, { kind: 'npc' });
  assert.deepEqual(paid!.speaker, { kind: 'player' });
  assert.deepEqual(done!.speaker, { kind: 'name', name: 'Narrator' });
  assert.equal(paid!.leave, false);
  assert.equal(hello!.leave, true);
  const gift = hello!.choices[4]!;
  assert.deepEqual([gift.id, gift.once, gift.give], ['gift', true, [{ item: d.ids.items['t:brick'], count: 2 }]]);
  assert.deepEqual(hello!.choices[1]!.consume, [{ item: d.ids.items['t:coin'], count: 2 }]);
  assert.equal(hello!.choices[5]!.effects[0]!.type === 'apply' && hello!.choices[5]!.effects[0]!.on, 'npc');
  assert.equal(d.archetypes[d.ids.archetypes['t:keeper']!]!.dialogue, 0);
  assert.equal(d.archetypes[d.ids.archetypes['t:mute']!]!.dialogue, null);
});

test('dialogues: load errors', () => {
  const e = (body: string) => errorsOf({ 'dialogues.yaml': oneDialogue(body) });
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A } }, talk: true }\n'), /unknown dialogue field 'talk'/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, txt: B } } }\n'), /unknown dialogue node field 'txt' \(did you mean 'text'\?\)/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: X, to: end, gives: {} }] } } }\n'), /unknown choice field 'gives' \(did you mean 'give'\?\)/);
  expectError(e('  - { id: chat, start: b, nodes: { a: { text: A }, bb: { text: B } } }\n'), /unknown node 'b' of dialogue 't:chat' \(did you mean 'a'\?\)/, 'dialogues[0].start');
  expectError(e('  - { id: chat, start: [{ node: hello }], nodes: { hallo: { text: A } } }\n'), /unknown node 'hello' of dialogue 't:chat' \(did you mean 'hallo'\?\)/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, next: bb } , b: { text: B } } }\n'), /unknown node 'bb' of dialogue 't:chat' \(did you mean 'b'\?\)/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: X, to: ned }] } } }\n'), /unknown node 'ned' of dialogue 't:chat' \(did you mean 'end'\?\)/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: X, to: end, consume: { coins: 1 } }] } } }\n'), /unknown item 'coins'.*did you mean 't:coin'|unknown item 'coins'.*did you mean 'coin'/);
  expectError(
    e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: X, to: end, consume: { coin: 1 }, give: { coin: 2 } }] } } }\n'),
    /item 't:coin' is both consumed and given/,
  );
  const ten = Array.from({ length: 10 }, (_, i) => `{ text: C${i}, to: end }`).join(', ');
  expectError(e(`  - { id: chat, start: a, nodes: { a: { text: A, choices: [${ten}] } } }\n`), /node 'a' has 10 choices; at most 9 are allowed/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, next: end, choices: [{ text: X, to: end }] } } }\n'), /node 'a' has both 'choices' and 'next'/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: X, to: end, once: true }] } } }\n'), /a 'once' choice needs an 'id'/);
  expectError(
    e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ id: x, text: X, to: end }, { id: x, text: Y, to: end }] } } }\n'),
    /duplicate choice id 'x' in this dialogue/,
  );
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: "  " } } }\n'), /field 'text' must not be empty/);
  expectError(e('  - { id: chat, start: a, nodes: {} }\n'), /field 'nodes' must define at least one node/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A }, Bad: { text: B } } }\n'), /invalid node name 'Bad'/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: X, to: end, effects: [{ type: set_tile, tile: floor }] }] } } }\n'), /'set_tile' effects are only allowed/);
  expectError(e('  - { id: chat, start: a, nodes: { a: { text: A, effects: [{ type: apply, measurement: hp, delta: 1, on: them }] } } }\n'), /field 'on' must be 'self' or 'npc'/);
  // Archetype references.
  expectError(errorsOf({ 'archetypes.yaml': ARCHETYPES.replace('dialogue: grumpy', 'dialogue: grumpi') }), /unknown dialogue 'grumpi'.*did you mean/);
});

test('dialogues: `npc` and `on` outside dialogues are load errors; a node nobody reaches is a warning', () => {
  expectError(
    errorsOf({ 'systems.yaml': 'systems:\n  - { id: s, when: "npc.hp > 0", effects: [{ type: apply, measurement: hp, delta: 1 }] }\n' }),
    /'npc' is only available in dialogues/,
  );
  expectError(errorsOf({ 'systems.yaml': 'systems:\n  - { id: s, when: "can_see(self, npc)", effects: [{ type: apply, measurement: hp, delta: 1 }] }\n' }), /'npc' is only available in dialogues/);
  expectError(
    errorsOf({ 'systems.yaml': 'systems:\n  - { id: s, effects: [{ type: apply, measurement: hp, delta: 1, on: npc }] }\n' }),
    /field 'on' is only allowed in the effects of dialogues/,
    'systems[0].effects[0].on',
  );
  const r = loadPacks([fixture({ ...FILES, 'dialogues.yaml': oneDialogue('  - { id: chat, start: a, nodes: { a: { text: A }, lost: { text: L } } }\n') })]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  assert.ok(
    r.warnings.some((w) => /node 'lost' of dialogue 't:chat' is never reached/.test(w.message)),
    r.warnings.map((w) => w.message).join('\n'),
  );
  // `npc` works in every dialogue expression.
  const ok = loadPacks([fixture({ ...FILES, 'dialogues.yaml': oneDialogue('  - { id: chat, when: "npc.hp > 0 and npc.x >= 0", start: [{ when: "has_tag(npc, \\"x\\") == false", node: a }, { node: a }], nodes: { a: { text: A } } }\n') })]);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.map(formatError).join('\n'));
});

// ── Talk checks ─────────────────────────────────────────────────────────────

test('talk: each failure reason in order, reach across a wall edge, and no conversation on failure', () => {
  const reason = (w: World, entity: number) => {
    w.queueAction({ kind: 'talk', entity });
    w.step();
    assert.equal(w.conversation, null);
    return [w.lastAction!.kind, w.lastAction!.entity, w.lastAction!.ok, w.lastAction!.reason];
  };
  const w = world();
  assert.deepEqual(reason(w, 99), ['talk', 99, false, 'unknown_entity']);
  assert.deepEqual(reason(w, PLAYER), ['talk', PLAYER, false, 'unknown_entity']);
  assert.deepEqual(reason(w, MUTE), ['talk', MUTE, false, 'no_dialogue']);
  assert.deepEqual(reason(w, GRUMP), ['talk', GRUMP, false, 'out_of_reach']);
  // Next to the walled keeper, across the thin wall: out of reach; the grump in reach will not talk.
  w.player.x = 1;
  w.player.y = 0;
  assert.deepEqual(reason(w, WALLED), ['talk', WALLED, false, 'out_of_reach']);
  w.player.y = 1;
  assert.deepEqual(reason(w, GRUMP), ['talk', GRUMP, false, 'cannot_act']);
  assert.equal(actionText(w, w.lastAction!), 'He ignores you');
  // The picky NPC's `start` list matches nothing.
  assert.deepEqual(reason(w, PICKY), ['talk', PICKY, false, 'cannot_act']);
  // The walled keeper is in reach once the wall is on the other side.
  w.player.x = 2;
  w.player.y = 1;
  w.queueAction({ kind: 'talk', entity: WALLED });
  w.step();
  assert.deepEqual([w.lastAction!.ok, w.conversation?.npc.id], [true, WALLED]);
});

test('talk: opens the conversation, runs the opening node, turns the NPC at once, cancels the player', () => {
  const w = world();
  const keeper = w.entities[KEEPER]!;
  assert.equal(keeper.facing, 's');
  // A walk that has not stepped yet (cooling down) is cancelled.
  w.player.path = Int32Array.from([w.grid.index(0, 1, 0)]);
  w.player.moveCooldown = 5;
  w.queueAction({ kind: 'talk', entity: KEEPER });
  w.step();
  assert.deepEqual(w.lastAction, { kind: 'talk', item: '', entity: KEEPER, moved: 0, ok: true, stage: 'complete', tick: 0 });
  assert.equal(w.tick, 1, 'the rest of that tick runs normally');
  assert.equal(nodeOf(w), 'hello');
  assert.equal(varOf(w, 'told'), 1, 'the opening node ran its effects');
  assert.equal(keeper.facing, facingOfStep(-1, 0));
  assert.equal(w.player.path, null);
  assert.equal(actionText(w, w.lastAction!), 'You talk to Keeper.');
});

// ── Pause, choose and leave ─────────────────────────────────────────────────

test('pause: step() is a no-op while open; queued intents and actions are ignored', () => {
  const w = talk(world());
  const tick = w.tick;
  const hash = w.hash();
  const where = w.entities.map((e) => [e.x, e.y]);
  w.queueIntent({ kind: 'step', dx: 1, dy: 1 });
  w.queueAction({ kind: 'drop', item: 't:coin' });
  for (let i = 0; i < 20; i++) w.step();
  assert.equal(w.tick, tick);
  assert.equal(w.hash(), hash);
  assert.deepEqual(
    w.entities.map((e) => [e.x, e.y]),
    where,
  );
  assert.equal(w.player.intent, null);
  // The view is pure.
  w.conversationView();
  assert.equal(w.hash(), hash);
});

test('choose and leave: records, conversationVersion, invalid and disabled choices, leave: false', () => {
  const w = talk(world());
  const v0 = w.conversationVersion;
  const view = w.conversationView()!;
  assert.deepEqual(
    [view.npc, view.speaker, view.text, view.leave],
    [KEEPER, 'Keeper', 'What will it be?', true],
  );
  assert.deepEqual(w.choose(99), { ok: false, reason: 'invalid_choice' });
  assert.deepEqual(w.choose(-1), { ok: false, reason: 'invalid_choice' });
  assert.deepEqual(w.choose(pick(w, 'Locked')), { ok: false, reason: 'cannot_act' });
  const hash = w.hash();
  assert.deepEqual(w.choose(pick(w, 'Pay for the information')), { ok: false, reason: 'missing' });
  assert.equal(w.hash(), hash, 'a failed choice changes nothing');
  assert.equal(w.conversationVersion, v0 + 4);
  // Pay with coins: the `paid` node cannot be left.
  add(w.player.inv!, w.def.ids.items['t:coin']!, 3, 10);
  assert.deepEqual(w.choose(pick(w, 'Pay for the information')), { ok: true });
  assert.equal(nodeOf(w), 'paid');
  assert.equal(w.conversationView()!.speaker, 'Hero');
  assert.equal(w.player.inv!.stacks[0]!.count, 1);
  assert.deepEqual(w.leaveConversation(), { ok: false, reason: 'cannot_leave' });
  assert.equal(nodeOf(w), 'paid');
  assert.deepEqual(w.choose(0), { ok: true });
  assert.equal(w.conversation, null);
  assert.deepEqual(w.choose(0), { ok: false, reason: 'no_conversation' });
  assert.deepEqual(w.leaveConversation(), { ok: false, reason: 'no_conversation' });
  // Leaving where allowed.
  talk(w);
  assert.deepEqual(w.leaveConversation(), { ok: true });
  assert.equal(w.conversation, null);
  const t = w.tick;
  w.step();
  assert.equal(w.tick, t + 1, 'the world runs again');
});

// ── Choices ─────────────────────────────────────────────────────────────────

test('choices: hidden and disabled ones, view entries, `once`', () => {
  const w = talk(world());
  assert.deepEqual(w.conversationView()!.choices, [
    { text: 'Rumors?', ok: true },
    { text: 'Pay for the information', ok: false, reason: 'missing', missing: [{ item: 't:coin', label: 'Coin', count: 2 }] },
    { text: 'Locked', ok: false, reason: 'cannot_act', unavailable: 'Not yet' },
    { text: 'A gift?', ok: true },
    { text: 'Hit', ok: true },
    { text: 'Roll', ok: true },
    { text: 'Doom', ok: true },
    { text: 'Loop', ok: true },
  ]);
  // `A gift?` is once: chosen, it is gone for good (and `hello` re-entered bumps `told`).
  w.choose(pick(w, 'A gift?'));
  assert.equal(nodeOf(w), 'hello');
  assert.ok(!w.conversationView()!.choices.some((c) => c.text === 'A gift?'));
  assert.deepEqual([...w.dialogueOnce[0]!], ['gift']);
  // `Secret` shows once `told` ≥ 3, in definition order.
  w.choose(pick(w, 'Rumors?'));
  w.choose(0);
  assert.equal(varOf(w, 'told'), 3);
  assert.deepEqual(
    w.conversationView()!.choices.map((c) => c.text).slice(0, 4),
    ['Rumors?', 'Pay for the information', 'Secret', 'Locked'],
  );
  w.leaveConversation();
  talk(w);
  assert.ok(!w.conversationView()!.choices.some((c) => c.text === 'A gift?'), 'once is world-level');
});

test('choices: give overflows to the ground pile at the player cell; consume removes', () => {
  const w = talk(world());
  const brick = w.def.ids.items['t:brick']!;
  w.choose(pick(w, 'A gift?'));
  const inv = w.player.inv!;
  assert.deepEqual(
    inv.stacks.map((s) => [s.item, s.count]),
    [[brick, 1]],
  );
  const pile = w.containersAt(0, 0, 0).find((c) => c.kind === 'ground')!;
  assert.deepEqual(
    pile.stacks.map((s) => [s.item, s.count]),
    [[brick, 1]],
  );
});

test('choices: `on: npc` changes the NPC; `npc` in a choice `when`', () => {
  const w = talk(world());
  const hp = w.def.ids.measurements['t:hp']!;
  const keeper = w.entities[KEEPER]!;
  const before = w.player.m[hp]!;
  w.choose(pick(w, 'Hit'));
  assert.equal(keeper.m[hp], 7);
  assert.equal(w.player.m[hp], before);
  // The `paid` node's Thanks needs `npc.hp > 0`: hidden once the keeper is at 0.
  keeper.m[hp] = 0;
  add(w.player.inv!, w.def.ids.items['t:coin']!, 2, 10);
  talk(w);
  w.choose(pick(w, 'Pay for the information'));
  assert.deepEqual(w.conversationView()!.choices, []);
  assert.deepEqual(w.choose(0), { ok: false, reason: 'invalid_choice' });
});

test('choices: RNG draws happen in choice order; the view and `when` checks draw nothing', () => {
  const run = () => {
    const w = talk(world(7));
    const rng = w.rng.state;
    w.conversationView();
    assert.equal(w.rng.state, rng);
    w.choose(pick(w, 'Roll'));
    assert.notEqual(w.rng.state, rng, 'the effect drew from the world RNG');
    return [varOf(w, 'roll'), w.hash()];
  };
  assert.deepEqual(run(), run());
});

test('choices: the `next` loop guard ends the conversation with a runtime error', () => {
  const w = talk(world());
  w.choose(pick(w, 'Loop'));
  assert.equal(nodeOf(w), 'loop_a');
  for (let i = 1; i < MAX_DIALOGUE_ENTRIES; i++) assert.deepEqual(w.choose(0), { ok: true }, `continue ${i}`);
  assert.ok(w.conversation);
  const r = w.choose(0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'runtime_error');
  assert.match(r.error!, /dialogue 't:chat' entered more than 32 nodes without a player choice/);
  assert.equal(w.conversation, null);
});

test('start: the first entry whose `when` holds picks the opening node', () => {
  const w = world();
  w.vars[w.def.ids.vars['t:told']!] = 5;
  talk(w);
  assert.equal(nodeOf(w), 'done');
  const view = w.conversationView()!;
  assert.deepEqual([view.speaker, view.text, view.choices], ['Narrator', 'Nothing more.', [{ text: 'Leave', ok: true }]]);
  assert.deepEqual(w.choose(0), { ok: true });
  assert.equal(w.conversation, null);
});

// ── Integration ─────────────────────────────────────────────────────────────

test('integration: a choice adds a journal entry and moves a quest at once; a defeat takes effect on the next tick', () => {
  const w = talk(world());
  w.choose(pick(w, 'Rumors?'));
  assert.deepEqual(
    w.journal().entries.map((e) => e.entry),
    ['t:rumor'],
  );
  assert.deepEqual(
    w.journal().quests.map((q) => [q.quest, q.stage]),
    [['t:hunt', 'asked']],
  );
  assert.deepEqual(
    w.journalEvents.map((e) => e.kind),
    ['entry', 'stage'],
  );
  w.choose(0);
  w.choose(pick(w, 'Doom'));
  assert.equal(w.conversation, null);
  assert.equal(w.defeat, null, 'outcomes are checked in step()');
  const t = w.tick;
  w.step();
  assert.deepEqual(w.defeat, { tick: t, message: 'Doomed' });
});

test('integration: noise from a choice is heard on the next tick', () => {
  const w = World.create(
    def({
      'dialogues.yaml': oneDialogue('  - { id: chat, start: a, nodes: { a: { text: A, choices: [{ text: Shout, to: end, effects: [{ type: noise, radius: 5 }] }] } } }\n'),
    }),
    1,
  );
  talk(w);
  w.choose(0);
  const t = w.tick;
  w.step();
  assert.equal(w.entities[KEEPER]!.heardTick, t);
});

// ── Walk-then-talk ──────────────────────────────────────────────────────────

test('walk-then-talk: arrive and talk; an NPC that moved away is not followed', () => {
  const w = world();
  w.player.x = 4;
  w.player.y = 1;
  const action = { kind: 'talk', entity: KEEPER } as const;
  const intent = w.approachIntent(action)!;
  assert.deepEqual(intent, { kind: 'goto', x: 1, y: 0, z: 0, adjacent: true, then: action });
  w.queueIntent(intent);
  for (let i = 0; i < 40 && !w.conversation; i++) w.step();
  assert.equal(w.conversation?.npc.id, KEEPER);
  assert.ok(w.grid.reaches(w.player.x, w.player.y, 0, 1, 0, 0));
  assert.equal(w.approachIntent(action), null, 'in reach: no walk needed');

  const v = world();
  v.player.x = 4;
  v.player.y = 1;
  v.queueIntent(v.approachIntent(action)!);
  v.step();
  // The keeper walks off to the far corner while the player is on the way.
  v.entities[KEEPER]!.x = 4;
  v.entities[KEEPER]!.y = 0;
  for (let i = 0; i < 40 && v.lastAction === null; i++) v.step();
  assert.equal(v.conversation, null);
  assert.deepEqual([v.lastAction!.kind, v.lastAction!.reason], ['talk', 'out_of_reach']);
  assert.equal(actionText(v, v.lastAction!), 'Keeper is not close enough.');
});

// ── Interactions and the UI models ──────────────────────────────────────────

test('interactionsAt: talk entries first, in id order, with ok, unavailable and reach', () => {
  const w = world();
  const keeper = w.interactionsAt(1, 0, 0);
  assert.deepEqual(keeper[0], {
    id: `talk:${KEEPER}`,
    label: 'Talk to Keeper',
    kind: 'talk',
    action: { kind: 'talk', entity: KEEPER },
    entity: KEEPER,
    inReach: true,
    ok: true,
  });
  assert.equal(keeper[1]!.kind, 'walk');
  assert.deepEqual(w.interactionsAt(2, 1, 0)[0], {
    id: `talk:${GRUMP}`,
    label: 'Talk to Grump',
    kind: 'talk',
    action: { kind: 'talk', entity: GRUMP },
    entity: GRUMP,
    inReach: false,
    ok: false,
    reason: 'cannot_act',
    unavailable: 'He ignores you',
  });
  assert.ok(!w.interactionsAt(3, 0, 0).some((e) => e.kind === 'talk'), 'no dialogue, no talk');
  assert.equal(w.interactionsAt(2, 0, 0)[0]!.inReach, false, 'behind the wall');
});

test('clickPlan and hover: an enabled Talk is the click default; a disabled one opens the menu with its reason', () => {
  const w = world();
  const keeper = w.entities[KEEPER]!;
  const plan = clickPlan(w, { x: 1, y: 0, z: 0 });
  assert.equal(plan.kind, 'run');
  assert.deepEqual(plan.kind === 'run' && plan.item.run, { actions: [{ kind: 'talk', entity: KEEPER }] });
  assert.deepEqual(hoverInfo(w, { kind: 'entity', x: 1, y: 0, z: 0, entity: keeper }), { title: 'Keeper', hint: 'Click: Talk to Keeper', cursor: 'pointer' });
  // From afar, the click walks up first.
  w.player.x = 4;
  w.player.y = 1;
  const far = clickPlan(w, { x: 1, y: 0, z: 0 });
  assert.deepEqual(far.kind === 'run' && far.item.run, { intent: { kind: 'goto', x: 1, y: 0, z: 0, adjacent: true, then: { kind: 'talk', entity: KEEPER } } });
  // The grump will not talk: the click opens the menu, the tooltip says why.
  const grump = w.entities[GRUMP]!;
  assert.deepEqual(clickPlan(w, { x: 2, y: 1, z: 0 }), { kind: 'menu' });
  assert.deepEqual(hoverInfo(w, { kind: 'entity', x: 2, y: 1, z: 0, entity: grump }), { title: 'Grump', hint: 'He ignores you', cursor: 'pointer' });
  const menu = contextMenu(w, 2, 1, 0);
  assert.deepEqual(
    menu.disabled.map((i) => [i.label, i.hint]),
    [['Talk to Grump', 'He ignores you']],
  );
});

test('dialogue box: rows, hints and keys', () => {
  const w = talk(world());
  const box = dialogueBox(w.conversationView()!);
  assert.equal(box.speaker, 'Keeper');
  assert.equal(box.text, 'What will it be?');
  assert.deepEqual(box.rows.slice(0, 3), [
    { key: 1, text: 'Rumors?', disabled: false },
    { key: 2, text: 'Pay for the information', disabled: true, hint: 'Needs: 2× Coin' },
    { key: 3, text: 'Locked', disabled: true, hint: 'Not yet' },
  ]);
  assert.equal(box.help, '1–8 choose · Esc leave');
  assert.deepEqual(dialogueKey(box, -1, 'Digit1'), { kind: 'choose', index: 0 });
  assert.deepEqual(dialogueKey(box, -1, 'Numpad4'), { kind: 'choose', index: 3 });
  assert.deepEqual(dialogueKey(box, -1, 'Digit2'), { kind: 'none' }, 'disabled');
  assert.deepEqual(dialogueKey(box, -1, 'Digit9'), { kind: 'none' }, 'no such row');
  assert.deepEqual(dialogueKey(box, -1, 'ArrowDown'), { kind: 'select', index: 0 });
  assert.deepEqual(dialogueKey(box, 0, 'ArrowDown'), { kind: 'select', index: 3 }, 'disabled rows are skipped');
  assert.deepEqual(dialogueKey(box, 0, 'ArrowUp'), { kind: 'select', index: 7 }, 'wraps');
  assert.deepEqual(dialogueKey(box, 3, 'Enter'), { kind: 'choose', index: 3 });
  assert.deepEqual(dialogueKey(box, -1, 'Enter'), { kind: 'none' }, 'several enabled and none selected');
  assert.deepEqual(dialogueKey(box, -1, 'Escape'), { kind: 'leave' });
  assert.deepEqual(dialogueKey(box, -1, 'KeyW'), { kind: 'none' }, 'movement is off');
  assert.deepEqual(dialogueKey(box, -1, 'KeyE'), { kind: 'none' }, 'the menu is off');
  assert.deepEqual(dialogueKey(box, -1, 'KeyJ'), { kind: 'pass' }, 'the journal still opens');
  assert.deepEqual(dialogueKey(box, -1, 'KeyO'), { kind: 'pass' }, 'the game panel still opens');
  // `Enter` alone picks a single enabled choice; Escape is refused at `leave: false`.
  add(w.player.inv!, w.def.ids.items['t:coin']!, 2, 10);
  w.choose(pick(w, 'Pay for the information'));
  const paid = dialogueBox(w.conversationView()!);
  assert.deepEqual([paid.speaker, paid.leave, paid.help], ['Hero', false, '1 choose']);
  assert.deepEqual(dialogueKey(paid, -1, 'Enter'), { kind: 'choose', index: 0 });
  assert.deepEqual(dialogueKey(paid, -1, 'Escape'), { kind: 'refuse' });
});

test('terminal: talk in the x list, the conversation screen, digits and Escape', () => {
  const w = world();
  const list = actionMenu(w);
  assert.deepEqual(list[0], { label: 'Talk to Keeper', x: 1, y: 0, ok: true, hint: '', actions: [{ kind: 'talk', entity: KEEPER }] });
  assert.ok(!list.some((e) => e.label === 'Talk to Grump'), 'out of reach');
  assert.equal(conversationLines(w), null);
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'x', keys);
  handleKey(w, '1', keys);
  w.step();
  assert.ok(w.conversation);
  assert.deepEqual(conversationLines(w)!.slice(0, 5), ['Keeper:', '  What will it be?', '1) Rumors?', '2) Pay for the information [Needs: 2× Coin]', '3) Locked [Not yet]']);
  assert.equal(conversationLines(w)!.at(-1), '(1-8: choose  Esc: leave)');
  const where = [w.player.x, w.player.y];
  handleKey(w, 'l', keys);
  handleKey(w, '\x1b[B', keys);
  assert.deepEqual([w.player.x, w.player.y, w.player.intent], [...where, null], 'movement keys do nothing');
  handleKey(w, '1', keys);
  assert.equal(nodeOf(w), 'rumor');
  assert.match(keys.message ?? '', /cellar/i, 'the journal toast');
  handleKey(w, '1', keys);
  handleKey(w, '\x1b', keys);
  assert.equal(w.conversation, null);
  // Refused at `leave: false`.
  add(w.player.inv!, w.def.ids.items['t:coin']!, 2, 10);
  handleKey(w, 'x', keys);
  handleKey(w, '1', keys);
  w.step();
  handleKey(w, String(pick(w, 'Pay for the information') + 1), keys);
  handleKey(w, '\x1b', keys);
  assert.equal(keys.message, LEAVE_REFUSED_TEXT);
  assert.equal(nodeOf(w), 'paid');
});

// ── Saves ───────────────────────────────────────────────────────────────────

test('saves: a world saved mid-conversation restores into the same conversation', () => {
  const w = talk(world());
  w.choose(pick(w, 'A gift?'));
  w.choose(pick(w, 'Rumors?'));
  const save = w.save();
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(SAVE_VERSION, 5);
  assert.deepEqual(save.state.conversation, { npc: KEEPER, dialogue: 't:chat', node: 'rumor', entries: 1 });
  assert.deepEqual(save.state.dialogueOnce, [['t:chat', 'gift']]);
  // Leave on the first tick, then both worlds run on identically.
  const copy = assertRoundTrip(w, (x) => {
    if (x.conversation) x.choose(0);
    if (x.conversation) x.leaveConversation();
  });
  assert.equal(copy.conversation, null);
  // A restored conversation is the same conversation.
  const v = talk(world());
  v.choose(pick(v, 'Loop'));
  const r = World.restore(v.def, viaJson(v.save()));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.world.conversationView(), v.conversationView());
  assert.equal(r.world.conversation!.entries, 1);
  assert.deepEqual(r.world.choose(0), v.choose(0));
  assert.equal(r.world.hash(), v.hash());
});

test('saves: version 4 loads with no conversation and no once records; restore errors', () => {
  const w = talk(world());
  w.choose(pick(w, 'A gift?'));
  const old = viaJson(w.save()) as unknown as Record<string, unknown> & { state: Record<string, unknown> };
  old['version'] = 4;
  delete old.state['conversation'];
  delete old.state['dialogueOnce'];
  const r = World.restore(w.def, old);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  if (r.ok) {
    assert.equal(r.world.conversation, null);
    assert.deepEqual(r.world.snapshot().dialogueOnce, []);
  }

  const bad = (edit: (s: SaveFile) => void): string[] => {
    const s = viaJson(w.save());
    edit(s);
    const x = World.restore(w.def, s);
    assert.equal(x.ok, false);
    return x.ok ? [] : x.errors;
  };
  const has = (errors: string[], re: RegExp) => assert.ok(errors.some((e) => re.test(e)), errors.join('\n'));
  has(
    bad((s) => (s.state.conversation!.dialogue = 't:chatt')),
    /state\.conversation\.dialogue: unknown dialogue 't:chatt' \(did you mean 't:chat'\?\)/,
  );
  has(
    bad((s) => (s.state.conversation!.node = 'helo')),
    /state\.conversation\.node: dialogue 't:chat' has no node 'helo' \(did you mean 'hello'\?\)/,
  );
  has(
    bad((s) => (s.state.conversation!.npc = PLAYER)),
    /the player cannot be the NPC/,
  );
  has(
    bad((s) => (s.state.dialogueOnce = [['t:chat', 'gfit']])),
    /state\.dialogueOnce\[0\]\[1\]: dialogue 't:chat' has no 'once' choice 'gfit' \(did you mean 'gift'\?\)/,
  );
  has(
    bad((s) => (s.state.dialogueOnce = [['t:chap', 'gift']])),
    /unknown dialogue 't:chap'/,
  );
  has(
    bad((s) => (s.state.actions = [{ kind: 'talk', entity: -1 }])),
    /state\.actions\[0\]\.entity/,
  );
});

// ── Overrides ───────────────────────────────────────────────────────────────

test('overrides: patch when alone, replace the whole node tree, remove, and patch archetype dialogue', () => {
  const mod = (yaml: string): PackSource => ({ label: 'mod', files: { 'pack.yaml': 'namespace: m\nname: m\nversion: 1.0.0\ndepends: [t]\n', 'mod.yaml': yaml } });
  const load = (yaml: string) => loadPacksOrThrow([fixture(FILES), mod(yaml)]);
  const a = load('dialogues:\n  - { id: t:grumpy, override: true, when: true }\n');
  const grumpy = a.dialogues[a.ids.dialogues['t:grumpy']!]!;
  assert.equal(grumpy.whenFn!({} as never), true);
  assert.equal(grumpy.unavailable, 'He ignores you');
  assert.deepEqual(
    grumpy.nodes.map((n) => n.name),
    ['hi'],
  );
  const b = load('dialogues:\n  - { id: t:grumpy, override: true, start: bye, nodes: { bye: { text: Go away. } } }\n');
  assert.deepEqual(
    b.dialogues[b.ids.dialogues['t:grumpy']!]!.nodes.map((n) => [n.name, n.text]),
    [['bye', 'Go away.']],
  );
  const c = load('archetypes:\n  - { id: t:grump, override: true, dialogue: null }\ndialogues:\n  - { id: t:grumpy, remove: true }\n');
  assert.equal(c.ids.dialogues['t:grumpy'], undefined);
  assert.equal(c.archetypes[c.ids.archetypes['t:grump']!]!.dialogue, null);
  const d = load('archetypes:\n  - { id: t:mute, override: true, dialogue: t:grumpy }\n');
  assert.equal(d.archetypes[d.ids.archetypes['t:mute']!]!.dialogue, d.ids.dialogues['t:grumpy']);
});

// ── Guards ──────────────────────────────────────────────────────────────────

test('determinism: the same talks and choices give the same hashes', () => {
  const run = () => {
    const w = world(3);
    const hashes: string[] = [];
    for (let i = 0; i < 30; i++) {
      if (i === 2) w.queueAction({ kind: 'talk', entity: KEEPER });
      if (w.conversation) {
        w.choose(pick(w, i % 2 ? 'Roll' : 'Rumors?'));
        if (w.conversation) w.choose(0);
      }
      w.step();
      hashes.push(w.hash());
    }
    return hashes;
  };
  assert.deepEqual(run(), run());
});
