import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleKey, historyLines, type KeyState } from '../src/ascii/terminal.ts';
import { readPack } from '../src/node/read-pack.ts';
import { add, entryText, loadedNote, loadPacksOrThrow, logLines, MessageLog, noteLine, LOG_MAX, World, type Definition, type LogLine } from '../src/core/index.ts';
import { historyRow, stripEntries, STRIP_LINES } from '../src/web/log-dom.ts';
import { fixture, GAMES } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   #####      C = crate (walkable container) with 2 beans, 1 water and a brick
//   #@C.#      the hero (living, hero) carries up to 0.6; the rock is living too
//   #..o#      hungry ≤ 40 food until ≥ 60; full ≥ 90 (silent exit); calm ≥ 95 (silent enter)
//   #####      a system adds the `tip` entry once food ≤ 40; food ≤ 0 is a defeat

const FILES = {
  'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: crate, label: Crate, glyph: C, color: yellow, walkable: true, container: { capacity: 10 } }
`,
  'measurements.yaml': `measurements:
  - { id: hp, label: HP, max: 10, initial: 10 }
  - { id: food, label: Food, max: 100, initial: 50 }
`,
  'items.yaml': `items:
  - { id: bean, label: Bean, glyph: b, color: red, weight: 0.1 }
  - { id: water, label: Water, glyph: w, color: blue, weight: 0.2 }
  - { id: brick, label: Brick, glyph: "=", color: red, weight: 2 }
`,
  'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, tags: [living, hero], measurements: [hp, food], inventory: { capacity: 0.6 } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0, tags: [living], measurements: [food] }
`,
  'statuses.yaml': `statuses:
  - id: hungry
    label: Hungry
    for: 'self.has_tag("living")'
    when: "self.food <= 40"
    until: "self.food >= 60"
    hud: { tone: bad }
  - id: full
    label: Full
    for: 'self.has_tag("living")'
    when: "self.food >= 90"
    hud: { tone: good, enter: You are stuffed., exit: "" }
  - id: calm
    label: Calm
    for: 'self.has_tag("living")'
    when: "self.food >= 95"
    hud: { enter: "" }
`,
  'journal.yaml': `journal:
  - { id: tip, text: Eat something. }
systems:
  - id: tip
    every: 0.1
    for: 'self.has_tag("hero")'
    when: 'self.food <= 40 and not in_journal("tip")'
    effects: [{ type: journal, entry: tip }]
`,
  'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "C": { tile: crate }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
    rows:
      - "#####"
      - "#@C.#"
      - "#..o#"
      - "#####"
start:
  map: room
  player: hero
  defeat: { when: "self.food <= 0", message: You starved. }
`,
};

function world(): World {
  const w = World.create(loadPacksOrThrow([fixture(FILES)]), 1);
  const crate = [...w.containers.values()].find((c) => c.kind === 'tile')!;
  const { items } = w.def;
  for (const [id, n] of [['t:bean', 2], ['t:water', 1], ['t:brick', 1]] as const) {
    const k = w.def.ids.items[id]!;
    add(crate, k, n, items[k]!.weight);
  }
  return w;
}

const crateOf = (w: World) => [...w.containers.values()].find((c) => c.kind === 'tile')!.id;
const food = (w: World) => w.def.ids.measurements['t:food']!;
const setFood = (w: World, v: number, e = w.player) => (e.m[food(w)] = v);
const rock = (w: World) => w.entities.find((e) => e !== w.player)!;
const texts = (lines: readonly LogLine[]) => lines.map((l) => l.text);
const toned = (lines: readonly LogLine[]) => lines.map((l) => [l.text, l.tone]);

// ── Core events ─────────────────────────────────────────────────────────────

test('actionEvents: every player record of a tick, in order; cleared on the next step', () => {
  const w = world();
  const c = crateOf(w);
  w.queueAction({ kind: 'take', container: c, item: 't:bean' });
  w.queueAction({ kind: 'take', container: c, item: 't:water' });
  w.step();
  assert.deepEqual(
    w.actionEvents.map((a) => [a.kind, a.item, a.moved, a.ok]),
    [
      ['take', 't:bean', 2, true],
      ['take', 't:water', 1, true],
    ],
  );
  assert.equal(w.lastAction, w.actionEvents[1], 'lastAction is the latest record');
  assert.deepEqual(texts(logLines(w)), ['Took 2 Bean', 'Took 1 Water']);
  w.step();
  assert.deepEqual(w.actionEvents, []);
  assert.deepEqual(logLines(w), []);
  assert.equal(w.lastAction!.item, 't:water', 'lastAction keeps its meaning');
  assert.equal('actionEvents' in w.snapshot(), false, 'not saved');
});

test('statusEvents: enter and exit with hysteresis, definition order, NPC statuses excluded', () => {
  const w = world();
  setFood(w, 40);
  setFood(w, 40, rock(w));
  w.step();
  assert.deepEqual(w.statusEvents, [{ tick: 0, status: 't:hungry', entered: true }]);
  assert.equal(w.hasStatus(rock(w), 't:hungry'), true, 'the rock is hungry too, unreported');
  setFood(w, 50);
  w.step();
  assert.equal(w.statusEvents.length, 0, 'still hungry until food >= 60');
  setFood(w, 60);
  w.step();
  assert.deepEqual(w.statusEvents, [{ tick: 2, status: 't:hungry', entered: false }]);
  setFood(w, 96);
  w.step();
  assert.deepEqual(
    w.statusEvents.map((e) => [e.status, e.entered]),
    [
      ['t:full', true],
      ['t:calm', true],
    ],
  );
  w.step();
  assert.deepEqual(w.statusEvents, [], 'cleared on the next step');
});

// ── Formatter ───────────────────────────────────────────────────────────────

test('logLines: actions, journal, statuses, then defeat; tones', () => {
  const w = world();
  const c = crateOf(w);
  w.step();
  setFood(w, 0);
  w.queueAction({ kind: 'take', container: c, item: 't:brick' });
  w.queueAction({ kind: 'take', container: c, item: 't:bean' });
  w.step();
  assert.ok(w.defeat);
  const lines = logLines(w);
  assert.deepEqual(toned(lines), [
    ['Too heavy', 'bad'],
    ['Took 2 Bean', 'info'],
    ['Journal: Eat something.', 'info'],
    ['You are now Hungry.', 'bad'],
    ['You starved.', 'bad'],
  ]);
  assert.ok(lines.every((l) => l.tick === 1 && l.clock === lines[0]!.clock && /^Day \d+ \d\d:\d\d$/.test(l.clock)));
});

test('logLines: default and custom texts, silence via an empty text, a bad status ending is good', () => {
  const w = world();
  setFood(w, 40);
  w.step();
  assert.deepEqual(toned(logLines(w)).at(-1), ['You are now Hungry.', 'bad']);
  setFood(w, 96);
  w.step();
  assert.deepEqual(toned(logLines(w)), [
    ['You are no longer Hungry.', 'good'],
    ['You are stuffed.', 'good'],
  ]);
  assert.deepEqual(w.statusEvents.length, 3, 'calm entered silently');
  setFood(w, 50);
  w.step();
  assert.deepEqual(toned(logLines(w)), [['You are no longer Calm.', 'info']], 'full leaves silently');
});

test('logLines: activity starts are not logged; failed starts are', () => {
  const w = world();
  w.queueAction({ kind: 'take', container: 999, item: 't:bean' });
  w.step();
  assert.deepEqual(toned(logLines(w)), [['No such container', 'bad']]);
});

test('logLines: an unreachable goto is logged once while it repeats', () => {
  const w = world();
  const log = new MessageLog();
  for (let i = 0; i < 3; i++) {
    w.queueIntent({ kind: 'goto', x: 0, y: 0, z: 0, then: { kind: 'take', container: crateOf(w), item: 't:bean' } });
    w.step();
    log.push(logLines(w), i);
  }
  assert.deepEqual(
    log.entries.map((e) => [entryText(e), e.tone]),
    [["You can't get there.", 'bad']],
  );
});

// ── Log buffer ──────────────────────────────────────────────────────────────

test('MessageLog: consecutive duplicates collapse with a count; 100-line cap; clear', () => {
  const w = world();
  const log = new MessageLog();
  const line = (text: string): LogLine => noteLine(w, text);
  log.push([line('Too heavy'), line('Too heavy')], 1);
  log.push([line('Too heavy')], 2);
  log.push([line('Took 1 Bean'), line('Too heavy')], 3);
  assert.deepEqual(
    log.entries.map((e) => [entryText(e), e.count, e.at]),
    [
      ['Too heavy (×3)', 3, 2],
      ['Took 1 Bean', 1, 3],
      ['Too heavy', 1, 3],
    ],
  );
  const v = log.version;
  for (let i = 0; i < 150; i++) log.push([line(`line ${i}`)], 4);
  assert.equal(log.entries.length, LOG_MAX);
  assert.equal(log.entries[0]!.text, 'line 50');
  assert.equal(log.newest!.text, 'line 149');
  assert.ok(log.version > v);
  log.clear();
  assert.deepEqual(log.entries, []);
  log.push([loadedNote(w)], 5);
  assert.match(log.newest!.text, /^Loaded Day \d+ \d\d:\d\d$/);
  assert.equal(log.newest!.tone, 'info');
});

// ── Shell views ─────────────────────────────────────────────────────────────

test('shell views: the browser strip and history rows; the terminal M screen', () => {
  const w = world();
  const log = new MessageLog();
  for (let i = 0; i < 8; i++) log.push([noteLine(w, `n${i}`, i === 7 ? 'bad' : 'info')], i);
  assert.deepEqual(
    stripEntries(log.entries).map((e) => e.text),
    ['n3', 'n4', 'n5', 'n6', 'n7'],
  );
  assert.equal(STRIP_LINES, 5);
  assert.match(historyRow(log.newest!), /^Day \d+ \d\d:\d\d {2}n7$/);
  const screen = historyLines(log.entries, 6);
  assert.equal(screen[0], 'Messages');
  assert.deepEqual(
    screen.slice(2).map((l) => l.replace(/^\d\d:\d\d /, '')),
    ['n5', 'n6', 'n7'],
  );
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'M', keys);
  assert.equal(keys.history, true);
  handleKey(w, 'x', keys);
  assert.equal(keys.history, false, 'any key closes it');
  assert.equal(keys.actions ?? null, null, 'the closing key does nothing else');
  handleKey(w, 'm', keys);
  assert.equal(keys.history ?? false, false, 'lowercase m stays free');
});

// ── Shipped games ───────────────────────────────────────────────────────────

const shipped = new Map<string, Definition>();
function game(name: keyof typeof GAMES): Definition {
  if (!shipped.has(name)) shipped.set(name, loadPacksOrThrow(GAMES[name].map((d) => readPack(d))));
  return shipped.get(name)!;
}

/** Step `w` once, logging its lines. */
function stepLog(w: World, log: MessageLog): void {
  w.step();
  log.push(logLines(w), w.tick);
}

/** Give the player one `item` and drop it next tick. */
function dropOne(w: World, item: string): void {
  const k = w.def.ids.items[item]!;
  add(w.player.inv!, k, 1, w.def.items[k]!.weight);
  w.queueAction({ kind: 'drop', item });
}

test('zombie: a quest event, a status event and an action land in the log', () => {
  const def = game('zombie');
  const w = World.create(def, 1);
  const log = new MessageLog();
  stepLog(w, log);
  w.player.m[def.ids.measurements['std_needs:hunger']!] = 80;
  dropOne(w, 'town:car_battery');
  for (let i = 0; i < 15; i++) stepLog(w, log);
  const all = log.entries.map((e) => [e.text, e.tone]);
  assert.deepEqual(all[0], ['Journal: Get out of town: The wrecks on the road might run with a fresh battery.', 'info']);
  assert.ok(all.some(([t]) => t === 'Dropped 1 Car battery'), JSON.stringify(all));
  assert.ok(all.some(([t, tone]) => t === 'Your stomach growls.' && tone === 'bad'), JSON.stringify(all));
  assert.ok(all.some(([t]) => t!.startsWith('Journal: Eat before hunger bites')), JSON.stringify(all));
});

test('vampire: a quest event, a status event and an action land in the log', () => {
  const def = game('vampire');
  const w = World.create(def, 3);
  const log = new MessageLog();
  stepLog(w, log);
  w.player.m[def.ids.measurements['vamp:blood']!] = 5;
  dropOne(w, 'vamp:blood_vial');
  for (let i = 0; i < 3; i++) stepLog(w, log);
  const all = log.entries.map((e) => [e.text, e.tone]);
  assert.ok(all[0]![0]!.startsWith('Journal: The first dawn: '), JSON.stringify(all));
  assert.ok(all.some(([t]) => /^Dropped \d+ Blood vial$/.test(t!)), JSON.stringify(all));
  assert.ok(all.some(([t, tone]) => t === 'The thirst for blood claws at you.' && tone === 'bad'), JSON.stringify(all));
});
