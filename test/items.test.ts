import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameToText, renderAscii } from '../src/ascii/render.ts';
import { handleKey, type KeyState } from '../src/ascii/terminal.ts';
import {
  add,
  countOf,
  createContainer,
  fits,
  formatError,
  hudLines,
  hudModel,
  load,
  loadPacks,
  remove,
  World,
  type Definition,
  type LoadError,
} from '../src/core/index.ts';
import { clickIntent } from '../src/web/panels.ts';
import { transferView } from '../src/web/transfer.ts';
import { fixture, loadFixture } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   #######      B = box (not walkable, capacity 0.3), C = crate (walkable, capacity 1)
//   #B.@.C#      rooms: kitchen [1,1,2,3]; cellar+damp [1,3,5,1]
//   #.....#      the hero carries up to 0.6, starting with a pebble (0.1)
//   #B...B#      LOOT: apple in the kitchen box, 2 coins in the cellar boxes
//   #######

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: box, label: Box, glyph: B, color: yellow, walkable: false, container: { capacity: 0.3 } }
  - { id: crate, label: Crate, glyph: C, color: yellow, walkable: true, container: { capacity: 1 } }
`;

const ITEMS = `items:
  - { id: pebble, label: Pebble, glyph: "*", color: gray, weight: 0.1 }
  - { id: brick, label: Brick, glyph: "=", color: red, weight: 2 }
  - { id: coin, label: Coin, glyph: "$", color: yellow, weight: 0 }
  - id: apple
    label: Apple
    glyph: a
    color: red
    weight: 0.25
    use:
      label: Eat
      effects:
        - { type: apply, measurement: food, delta: 10 }
        - { type: set, measurement: hp, value: "self.food / 10" }
  - id: charm
    label: Charm
    glyph: "&"
    color: cyan
    weight: 0
    use: { when: "self.hp < 8", consume: 0, effects: [{ type: apply, measurement: hp, delta: 1 }] }
`;

const ARCHETYPES = `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, tags: [living], measurements: [hp, food], inventory: { capacity: 0.6, items: { pebble: 1 } } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`;
const NO_INVENTORY = ', inventory: { capacity: 0.6, items: { pebble: 1 } }';

const MAP = `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "B": { tile: box }
      "C": { tile: crate }
      "@": { tile: floor, player: true }
    rows:
      - "#######"
      - "#B.@.C#"
      - "#.....#"
      - "#B...B#"
      - "#######"
    rooms:
      - { rect: [1, 1, 2, 3], tags: [kitchen] }
      - { rect: [1, 3, 5, 1], tags: [cellar, damp] }
start: { map: room, player: hero }
`;

const LOOT = `loot:
  - { id: pebbles, rolls: 2, entries: [{ item: pebble }] }
  - { id: coins, rolls: 1, entries: [{ item: coin, count: 2 }] }
  - { id: apples, entries: [{ item: apple }] }
distributions:
  - { container: box, table: pebbles }
  - { container: box, room: cellar, table: coins }
  - { container: box, room: kitchen, table: apples }
`;

const BASE = { 'tiles.yaml': TILES, 'items.yaml': ITEMS, 'archetypes.yaml': ARCHETYPES, 'map.yaml': MAP, 'loot.yaml': LOOT };

function def(files: Record<string, string> = {}): Definition {
  return loadFixture({ ...BASE, ...files });
}

function world(files: Record<string, string> = {}, seed = 1): World {
  return World.create(def(files), seed);
}

const stacks = (w: World, id: number) => w.snapshot().containers.find((c) => c.id === id)!.stacks;
const inv = (w: World) => w.player.inv!;
const idx = (w: World, id: string) => w.def.ids.items[`t:${id}`]!;

/** Teleport the player (tests only). */
function at(w: World, x: number, y: number): void {
  w.player.x = w.player.fromX = x;
  w.player.y = w.player.fromY = y;
}

// ── Container operations ────────────────────────────────────────────────────

test('containers: stacks merge per item, append new ids, and vanish at 0', () => {
  const c = createContainer(0, 'tile', 1000);
  add(c, 3, 2, 10);
  add(c, 1, 1, 10);
  add(c, 3, 5, 10);
  assert.deepEqual(c.stacks, [
    { item: 3, count: 7 },
    { item: 1, count: 1 },
  ]);
  assert.equal(c.load, 80);
  assert.equal(remove(c, 3, 10, 10), 7);
  assert.deepEqual(c.stacks, [{ item: 1, count: 1 }]);
  assert.equal(remove(c, 9, 1, 10), 0);
  assert.equal(countOf(c, 1), 1);
  assert.equal(countOf(c, 3), 0);
  assert.equal(c.load, load(c, [0, 10]));
});

test('containers: weight arithmetic in hundredths (0.1 × 3 fits 0.3)', () => {
  const d = def();
  assert.equal(d.items[idx({ def: d } as World, 'pebble')]!.weight, 10);
  assert.equal(d.tiles[2]!.container!.capacity, 30);
  const c = createContainer(0, 'tile', 30);
  assert.equal(fits(c, 10, 3), 3); // 0.1 + 0.1 + 0.1 === 0.3 exactly in hundredths
  add(c, 0, 3, 10);
  assert.equal(fits(c, 10, 1), 0);
  assert.equal(fits(c, 0, 99), 99); // weightless items always fit
  assert.equal(fits(createContainer(1, 'ground', Infinity), 200, 50), 50);
  // Loader rounding to 0.01.
  const r = def({ 'items.yaml': ITEMS.replace('weight: 0.25', 'weight: 0.254') });
  assert.equal(r.items[3]!.weight, 25);
});

// ── Container identity ──────────────────────────────────────────────────────

test('container ids: tile containers row-major, then inventories; piles get new ids, never reused', () => {
  const w = world();
  const snap = w.snapshot().containers;
  assert.deepEqual(
    snap.map((c) => [c.id, c.kind, c.cell ?? c.owner]),
    [
      [0, 'tile', [1, 1, 0]],
      [1, 'tile', [5, 1, 0]],
      [2, 'tile', [1, 3, 0]],
      [3, 'tile', [5, 3, 0]],
      [4, 'inventory', 0],
    ],
  );
  assert.equal(w.player.inv!.id, 4);
  assert.equal(w.entities[0]!.inv, w.player.inv);
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  const pile = w.containersAt(3, 1)[0]!;
  assert.deepEqual([pile.id, pile.kind], [5, 'ground']);
  assert.deepEqual(stacks(w, 5), [['t:pebble', 1]]);
  // Picking it up removes the empty pile; the next pile gets a fresh id.
  w.queueAction({ kind: 'take', container: 5, item: 't:pebble' });
  w.step();
  assert.deepEqual(w.containersAt(3, 1), []);
  assert.equal(w.containers.has(5), false);
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  assert.equal(w.containersAt(3, 1)[0]!.id, 6);
});

test('containersAt / reachableContainers: id order, 8-neighbourhood, own inventory excluded', () => {
  const w = world();
  assert.deepEqual(w.containersAt(1, 1).map((c) => c.id), [0]);
  assert.deepEqual(w.containersAt(-1, 0), []);
  assert.deepEqual(w.reachableContainers(), []);
  at(w, 2, 2);
  assert.deepEqual(w.reachableContainers().map((c) => c.id), [0, 2]);
  at(w, 5, 2);
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  assert.deepEqual(w.reachableContainers().map((c) => c.id), [1, 3, 5]);
});

// ── Actions ─────────────────────────────────────────────────────────────────

test('take/put: partial moves up to capacity; moving 0 units fails with too_heavy', () => {
  const w = world({ 'loot.yaml': 'loot:\n  - { id: p, rolls: 9, entries: [{ item: pebble }] }\ndistributions:\n  - { container: crate, table: p }\n' });
  assert.deepEqual(stacks(w, 1), [['t:pebble', 9]]);
  at(w, 4, 1);
  w.queueAction({ kind: 'take', container: 1, item: 't:pebble' }); // all 9, only 5 fit (0.1 carried, cap 0.6)
  w.step();
  assert.deepEqual(w.lastAction, { kind: 'take', item: 't:pebble', moved: 5, ok: true, stage: 'complete', tick: 0 });
  assert.equal(countOf(inv(w), idx(w, 'pebble')), 6);
  assert.deepEqual(stacks(w, 1), [['t:pebble', 4]]);
  w.queueAction({ kind: 'take', container: 1, item: 't:pebble', count: 1 });
  w.step();
  assert.deepEqual(w.lastAction, { kind: 'take', item: 't:pebble', moved: 0, ok: false, stage: 'complete', reason: 'too_heavy', tick: 1 });
  w.queueAction({ kind: 'put', container: 1, item: 't:pebble', count: 2 });
  w.step();
  assert.equal(w.lastAction!.moved, 2);
  assert.deepEqual(stacks(w, 1), [['t:pebble', 6]]);
  // Putting into a full container moves what fits.
  const box = w.containersAt(1, 1)[0]!;
  at(w, 2, 1);
  assert.deepEqual(stacks(w, box.id), []);
  add(box, idx(w, 'pebble'), 2, 10); // box: 0.2 of 0.3
  w.queueAction({ kind: 'put', container: box.id, item: 't:pebble' });
  w.step();
  assert.equal(w.lastAction!.moved, 1);
  assert.equal(countOf(inv(w), idx(w, 'pebble')), 3);
});

test('actions: every failure reason', () => {
  const w = world();
  const last = () => w.lastAction!.reason;
  const act = (a: Parameters<World['queueAction']>[0]) => {
    w.queueAction(a);
    w.step();
    return last();
  };
  assert.equal(act({ kind: 'take', container: 0, item: 't:apple' }), 'out_of_reach');
  assert.equal(act({ kind: 'take', container: 99, item: 't:apple' }), 'unknown_container');
  assert.equal(act({ kind: 'put', container: 4, item: 't:pebble' }), 'unknown_container'); // an inventory
  at(w, 2, 1);
  assert.equal(act({ kind: 'take', container: 0, item: 't:brick' }), 'missing');
  assert.equal(act({ kind: 'drop', item: 't:brick' }), 'missing');
  assert.equal(act({ kind: 'use', item: 't:apple' }), 'missing');
  assert.equal(act({ kind: 'use', item: 't:pebble' }), 'cannot_use'); // no `use`
  assert.equal(act({ kind: 'take', container: 0, item: 't:nope' }), 'missing');
  assert.equal(act({ kind: 'take', container: 0, item: 't:apple', count: 0 }), 'missing');
  add(inv(w), idx(w, 'brick'), 1, 200); // over capacity on purpose
  assert.equal(act({ kind: 'take', container: 0, item: 't:apple' }), 'too_heavy');
  add(inv(w), idx(w, 'charm'), 1, 0);
  assert.equal(act({ kind: 'use', item: 't:charm' }), 'cannot_use'); // `when` is falsy at full hp
  assert.equal(w.lastAction!.ok, false);

  const bare = World.create(loadFixture({ ...BASE, 'archetypes.yaml': ARCHETYPES.replace(NO_INVENTORY, '') }), 1);
  assert.equal(bare.player.inv, null);
  bare.queueAction({ kind: 'drop', item: 't:pebble' });
  bare.step();
  assert.equal(bare.lastAction!.reason, 'no_inventory');
});

test('actions: reach is Chebyshev ≤ 1 after this tick’s movement; records are new objects', () => {
  const w = world();
  at(w, 3, 2);
  w.queueAction({ kind: 'take', container: 0, item: 't:apple' });
  w.step();
  assert.equal(w.lastAction!.reason, 'out_of_reach'); // (1,1) is 2 away
  const first = w.lastAction;
  w.queueIntent({ kind: 'step', dx: -1, dy: 0 });
  w.queueAction({ kind: 'take', container: 0, item: 't:apple' });
  w.step();
  assert.equal(w.player.x, 2);
  assert.equal(w.lastAction!.ok, true); // applied after the move, same tick
  assert.notEqual(w.lastAction, first);
});

test('actions: FIFO within a tick; queue and lastAction are in the snapshot', () => {
  const w = world();
  at(w, 2, 1);
  w.queueAction({ kind: 'take', container: 0, item: 't:apple' });
  w.queueAction({ kind: 'use', item: 't:apple' });
  assert.deepEqual(w.snapshot().actions, [
    { kind: 'take', container: 0, item: 't:apple' },
    { kind: 'use', item: 't:apple' },
  ]);
  w.step();
  assert.deepEqual(w.snapshot().actions, []);
  assert.deepEqual(w.snapshot().lastAction, { kind: 'use', item: 't:apple', moved: 1, ok: true, stage: 'complete', tick: 0 });
  assert.equal(countOf(inv(w), idx(w, 'apple')), 0);
});

test('use: effects run in order on the user and see each other; clamped later; consume: 0 keeps the item', () => {
  const w = world();
  at(w, 2, 1);
  w.queueAction({ kind: 'take', container: 0, item: 't:apple' });
  w.queueAction({ kind: 'use', item: 't:apple' });
  w.step();
  // food 50 → 60 on use, then drift −0.1 in the same tick; hp = 60 / 10 = 6.
  assert.ok(Math.abs(w.value(w.player, 't:food')! - 59.9) < 1e-9);
  assert.equal(w.value(w.player, 't:hp'), 6);
  add(inv(w), idx(w, 'charm'), 1, 0);
  for (let i = 0; i < 3; i++) {
    w.queueAction({ kind: 'use', item: 't:charm' });
    w.step();
  }
  assert.equal(w.value(w.player, 't:hp'), 8); // 6 → 7 → 8, then `when` (hp < 8) is false
  assert.equal(w.lastAction!.reason, 'cannot_use');
  assert.equal(countOf(inv(w), idx(w, 'charm')), 1);

  // Effects beyond the max are clamped at the clamp phase.
  const v = world({ 'items.yaml': ITEMS.replace('delta: 10 }', 'delta: 500 }') });
  at(v, 2, 1);
  v.queueAction({ kind: 'take', container: 0, item: 't:apple' });
  v.queueAction({ kind: 'use', item: 't:apple' });
  v.step();
  assert.equal(v.value(v.player, 't:food'), 100);
});

test('actions: ignored after defeat, like intents', () => {
  const w = world({ 'map.yaml': MAP.replace('start: { map: room, player: hero }', 'start: { map: room, player: hero, defeat: { when: "true" } }') });
  w.step();
  assert.ok(w.defeat);
  const before = w.hash();
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  assert.deepEqual(w.snapshot().actions, []);
  assert.equal(w.hash(), before);
});

test('actions: ignored after victory too; the world reports it has ended (panels read-only)', () => {
  const w = world({ 'map.yaml': MAP.replace('start: { map: room, player: hero }', 'start: { map: room, player: hero, victory: { when: "true" } }') });
  assert.equal(w.ended, false);
  w.step();
  assert.deepEqual(w.victory, { tick: 0, message: 'Victory' });
  assert.equal(w.ended, true);
  const before = w.hash();
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  assert.deepEqual(w.snapshot().actions, []);
  assert.equal(w.hash(), before);
});

test('determinism: same seed, intents and actions ⇒ same hashes; containers are hashed', () => {
  const run = (seed: number) => {
    const w = world({ 'loot.yaml': 'loot:\n  - { id: p, rolls: [0, 9], entries: [{ item: pebble }, { item: coin, count: [1, 5] }] }\ndistributions:\n  - { container: crate, table: p }\n' }, seed);
    const hashes: string[] = [];
    for (let t = 0; t < 60; t++) {
      if (t === 2) w.queueIntent({ kind: 'goto', x: 5, y: 1, z: 0, adjacent: true });
      if (t === 10) for (const c of w.reachableContainers()) for (const s of c.stacks) w.queueAction({ kind: 'take', container: c.id, item: w.def.items[s.item]!.id });
      if (t === 20) w.queueAction({ kind: 'drop', item: 't:coin', count: 1 });
      w.step();
      hashes.push(w.hash());
    }
    return hashes;
  };
  assert.deepEqual(run(3), run(3));
  const seeds = [1, 2, 3, 4, 5, 6].map((s) => run(s)[59]);
  assert.ok(new Set(seeds).size > 1, 'loot should differ across seeds');
  const w = world();
  const h = w.hash();
  add(w.containersAt(1, 1)[0]!, idx(w, 'coin'), 1, 0);
  assert.notEqual(w.hash(), h);
});

// ── Loot and distributions ──────────────────────────────────────────────────

test('distributions: a room match beats no room; ties go to the first entry; no match ⇒ empty', () => {
  const w = world({ 'loot.yaml': LOOT });
  assert.deepEqual(stacks(w, 0), [['t:apple', 1]]); // kitchen
  assert.deepEqual(stacks(w, 1), []); // crate: no distribution
  assert.deepEqual(stacks(w, 2), [['t:coin', 2]]); // kitchen + cellar: `cellar` is listed first
  assert.deepEqual(stacks(w, 3), [['t:coin', 2]]); // cellar
  const noRoom = world({ 'loot.yaml': LOOT.replace(/\n {2}- \{ container: box, room[^\n]*/g, '') });
  assert.deepEqual(stacks(noRoom, 3), [['t:pebble', 2]]);
  assert.equal(noRoom.def.distributions.length, 1);
});

test('loot: determinism per seed; items that do not fit are dropped silently', () => {
  const files = { 'loot.yaml': 'loot:\n  - { id: p, rolls: [2, 6], entries: [{ item: pebble, count: [1, 3] }, { item: brick }, { nothing: true }] }\ndistributions:\n  - { container: box, table: p }\n' };
  const a = world(files, 9).snapshot().containers;
  const b = world(files, 9).snapshot().containers;
  assert.deepEqual(a, b);
  for (let seed = 0; seed < 50; seed++) {
    for (const c of world(files, seed).containers.values()) if (c.kind === 'tile') assert.ok(c.load <= c.capacity);
  }
});

test('loot: the world RNG is untouched', () => {
  const files = { 'loot.yaml': 'loot:\n  - { id: p, rolls: [2, 6], entries: [{ item: pebble }, { nothing: true }] }\ndistributions:\n  - { container: crate, table: p }\n' };
  const withLoot = world(files, 42);
  const without = world({}, 42);
  assert.ok(withLoot.containers.get(1)!.stacks.length > 0);
  assert.equal(withLoot.rng.state, without.rng.state);
  assert.equal(withLoot.rng.state, 42);
  for (let i = 0; i < 5; i++) assert.equal(withLoot.rng.next(), without.rng.next());
});

test('loot: entry weights (statistical, loose bound over many seeds)', () => {
  const d = def({ 'loot.yaml': 'loot:\n  - { id: p, entries: [{ item: pebble, weight: 3 }, { item: coin, weight: 1 }] }\ndistributions:\n  - { container: crate, table: p }\n' });
  let pebbles = 0;
  const N = 2000;
  for (let seed = 0; seed < N; seed++) pebbles += countOf(World.create(d, seed).containers.get(1)!, d.ids.items['t:pebble']!);
  const share = pebbles / N;
  assert.ok(share > 0.7 && share < 0.8, `pebble share ${share}`);
});

test('loot: rolls ranges, count ranges, nothing entries and nested tables', () => {
  const d = def({
    'loot.yaml': `loot:
  - { id: outer, rolls: [1, 3], entries: [{ table: inner, weight: 1 }, { nothing: true, weight: 1 }] }
  - { id: inner, rolls: 2, entries: [{ item: coin, count: [1, 4] }] }
distributions:
  - { container: crate, table: outer }
`,
  });
  const coin = d.ids.items['t:coin']!;
  const seen = new Set<number>();
  for (let seed = 0; seed < 300; seed++) {
    const n = countOf(World.create(d, seed).containers.get(1)!, coin);
    // 0–3 nested rolls, each 2 × [1, 4] coins.
    assert.ok(n === 0 || (n >= 2 && n <= 24), `seed ${seed}: ${n}`);
    seen.add(n);
  }
  assert.ok(seen.has(0), 'nothing entries happen');
  assert.ok([...seen].some((n) => n > 8), 'several nested rolls happen');
  assert.ok(seen.has(2) || seen.has(3), 'small counts happen');
});

test('loot: the loader warns (without failing) when a table can exceed a container’s capacity', () => {
  const r = loadPacks([fixture({ ...BASE, 'loot.yaml': 'loot:\n  - { id: p, rolls: [1, 2], entries: [{ item: brick }] }\ndistributions:\n  - { container: crate, table: p }\n' })]);
  assert.ok(r.ok);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /'t:p' can produce up to 4 weight, over the capacity of 't:crate' \(1\)/);
  assert.equal(r.warnings[0]!.path, 'distributions[0].table');
});

// ── Expressions ─────────────────────────────────────────────────────────────

const PROBE = `measurements:
  - { id: p, label: P, max: 1000, initial: 0 }
  - { id: q, label: Q, max: 1000, initial: 0 }
`;
const PROBE_HERO = ARCHETYPES.replace('measurements: [hp, food]', 'measurements: [hp, food, p, q]');

test('expressions: in_room, count_item, has_item, carry_weight, carry_capacity', () => {
  const w = world({
    'xy.yaml': PROBE,
    'archetypes.yaml': PROBE_HERO,
    's.yaml': `systems:
  - id: probe
    effects:
      - { type: set, measurement: p, value: 'tile.in_room("kitchen") + 2 * in_room(tile, "damp") + 4 * self.has_item("pebble") + 8 * has_item(player, "coin")' }
      - { type: set, measurement: q, value: 'self.count_item("pebble") * 100 + count_item(self, "t:coin") * 10 + self.carry_weight * 1000 + self.carry_capacity' }
`,
  });
  const p = () => w.value(w.player, 't:p');
  const q = () => w.value(w.player, 't:q');
  w.step();
  assert.equal(p(), 4);
  assert.equal(q(), 100 + 100 + 0.6);
  at(w, 1, 2);
  add(inv(w), idx(w, 'coin'), 3, 0);
  w.step();
  assert.equal(p(), 1 + 4 + 8);
  assert.equal(q(), 100 + 30 + 100 + 0.6);
  at(w, 2, 3);
  w.step();
  assert.equal(p(), 1 + 2 + 4 + 8);
  at(w, 4, 3);
  w.step();
  assert.equal(p(), 2 + 4 + 8);
  // Entities without an inventory read 0 / false.
  const rock = w.entities.find((e) => e.archetype.id === 't:rock');
  assert.equal(rock, undefined); // the fixture map has no rock
  const d = w.def;
  const ctxless = World.create(loadFixture({ ...BASE, 'xy.yaml': PROBE, 'archetypes.yaml': PROBE_HERO.replace(NO_INVENTORY, ''), 's.yaml': `systems:\n  - { id: s, effects: [{ type: set, measurement: q, value: 'self.count_item("pebble") + self.carry_weight + self.carry_capacity + self.has_item("pebble") + 1' }] }\n` }), 1);
  ctxless.step();
  assert.equal(ctxless.value(ctxless.player, 't:q'), 1);
  assert.ok(d.roomTags.includes('kitchen'));
});

test('rooms: overlapping rects union their tags into room sets', () => {
  const d = def();
  const rooms = d.maps[0]!.rooms;
  assert.deepEqual(d.roomTags, ['kitchen', 'cellar', 'damp']);
  const tagsAt = (x: number, y: number) => rooms.sets[rooms.cellSet[y * 7 + x]!]!.map((t) => d.roomTags[t]);
  assert.deepEqual(tagsAt(1, 1), ['kitchen']);
  assert.deepEqual(tagsAt(1, 3), ['kitchen', 'cellar', 'damp']);
  assert.deepEqual(tagsAt(4, 3), ['cellar', 'damp']);
  assert.deepEqual(tagsAt(4, 1), []);
  assert.deepEqual(rooms.sets[0], []);
  assert.deepEqual(World.create(d, 1).roomTagsAt(1, 3), [0, 1, 2]);
});

// ── goto adjacent ───────────────────────────────────────────────────────────

test('goto adjacent: ends next to a non-walkable goal; stays put when already adjacent; fails when unreachable', () => {
  const w = world();
  w.queueIntent({ kind: 'goto', x: 1, y: 3, z: 0, adjacent: true });
  w.step();
  assert.ok(w.lastGoto!.ok);
  // One diagonal step: (2,2) is the closest of (1,2), (2,2) and (2,3).
  assert.deepEqual([w.player.x, w.player.y], [2, 2]);
  assert.equal(w.player.path, null);
  for (let i = 0; i < 5; i++) w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 2]);
  assert.deepEqual(w.reachableContainers().map((c) => c.id), [0, 2]);

  w.queueIntent({ kind: 'goto', x: 1, y: 3, z: 0, adjacent: true });
  w.step();
  assert.ok(w.lastGoto!.ok);
  assert.equal(w.player.path, null);

  // Without `adjacent`, a non-walkable goal fails.
  w.queueIntent({ kind: 'goto', x: 1, y: 3, z: 0 });
  w.step();
  assert.equal(w.lastGoto!.ok, false);
  // The closest walkable neighbour wins: from (5,2), the crate (5,1) beats (4,1) for the wall above it.
  at(w, 5, 2);
  w.player.moveCooldown = 0;
  w.queueIntent({ kind: 'goto', x: 5, y: 0, z: 0, adjacent: true });
  w.step();
  assert.ok(w.lastGoto!.ok);
  assert.deepEqual([w.player.x, w.player.y], [5, 1]);
  // Already adjacent to a walkable goal: no path. Otherwise the closest candidate.
  at(w, 2, 3);
  w.player.moveCooldown = 0;
  w.queueIntent({ kind: 'goto', x: 3, y: 2, z: 0, adjacent: true });
  w.step();
  assert.equal(w.player.path, null); // already adjacent: no path
  w.queueIntent({ kind: 'goto', x: 4, y: 2, z: 0, adjacent: true });
  w.step();
  assert.deepEqual(w.pathGoal(w.player) ?? { x: w.player.x, y: w.player.y }, { x: 3, y: 3 });
  // Out of bounds or no walkable neighbour: unreachable.
  w.queueIntent({ kind: 'goto', x: 40, y: 0, z: 0, adjacent: true });
  w.step();
  assert.equal(w.lastGoto!.ok, false);
});

test('goto adjacent: deterministic tie-breaking', () => {
  const run = () => {
    const w = world();
    at(w, 3, 3);
    w.queueIntent({ kind: 'goto', x: 3, y: 0, z: 0, adjacent: true });
    w.step();
    return w.pathGoal(w.player);
  };
  assert.deepEqual(run(), run());
});

// ── HUD and shells ──────────────────────────────────────────────────────────

test('hudModel: inventory, nearby, lastAction; lines only when present', () => {
  const w = world({ 'loot.yaml': LOOT });
  let m = hudModel(w);
  assert.deepEqual(m.inventory, {
    stacks: [{ item: 't:pebble', label: 'Pebble', glyph: '*', color: 'gray', count: 1, weight: 0.1, useLabel: null, text: 'Pebble x1' }],
    weight: 0.1,
    capacity: 0.6,
    carrying: 'Carrying: 0.1/0.6',
    line: 'Inventory: 1) Pebble x1',
  });
  assert.deepEqual(m.nearby, []);
  assert.equal(m.nearbyLine, null);
  assert.equal(m.lastAction, null);
  at(w, 2, 1);
  w.queueAction({ kind: 'take', container: 0, item: 't:apple' });
  w.step();
  m = hudModel(w);
  assert.equal(m.inventory!.line, 'Inventory: 1) Pebble x1  2) Apple x1');
  assert.equal(m.inventory!.stacks[1]!.useLabel, 'Eat');
  assert.equal(m.inventory!.carrying, 'Carrying: 0.35/0.6');
  assert.deepEqual(
    m.nearby.map((c) => [c.id, c.label, c.x, c.y, c.text]),
    [[0, 'Box', 1, 1, 'Box [empty]']],
  );
  assert.equal(m.lastAction, 'Took 1 Apple');
  assert.deepEqual(hudLines(m).slice(-4), ['Carrying: 0.35/0.6', 'Inventory: 1) Pebble x1  2) Apple x1', 'Nearby: Box [empty]', 'Took 1 Apple']);
  at(w, 2, 2);
  assert.equal(hudModel(w).nearbyLine, 'Nearby: Box [empty]; Box [Coin x2]');
  w.queueAction({ kind: 'take', container: 2, item: 't:brick' });
  w.step();
  assert.equal(hudModel(w).lastAction, 'No Brick');
  w.queueAction({ kind: 'use', item: 't:apple' });
  w.step();
  assert.equal(hudModel(w).lastAction, 'Eat: Apple');
  for (let i = 0; i < 31; i++) w.step();
  assert.equal(hudModel(w).lastAction, null); // stale after 3 s
});

test('hudModel/ASCII: packs without items keep the HUD byte-identical; ground piles render as their first item', () => {
  const plain = World.create(loadFixture(), 1);
  const m = hudModel(plain);
  assert.equal(m.inventory, null);
  assert.deepEqual(hudLines(m), [m.time, ...m.measurements.map((x) => x.text)]);

  const w = world();
  at(w, 4, 2);
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  at(w, 3, 2);
  const frame = renderAscii(w, { width: 7, height: 5 });
  const text = frameToText(frame);
  // Viewport origin: (3 - 3, 2 - 2) = (0, 0), so screen = world coordinates.
  assert.equal(frame.lines[2], '#..@*.#');
  assert.equal(frame.colors[2]![4], 'gray');
  at(w, 4, 2);
  assert.equal(renderAscii(w, { width: 7, height: 5 }).lines[2]![3], '@'); // entities draw over piles
  assert.match(text, /Carrying: 0\/0\.6/);
  assert.match(text, /Inventory: empty/);
});

test('terminal keys: g takes all that fits, digits use, d + digit drops; movement otherwise', () => {
  const w = world({ 'loot.yaml': LOOT });
  const keys: KeyState = { dropPending: false };
  at(w, 2, 2);
  handleKey(w, 'g', keys);
  w.step();
  assert.equal(countOf(inv(w), idx(w, 'apple')), 1);
  assert.equal(countOf(inv(w), idx(w, 'coin')), 2);
  handleKey(w, '1', keys); // use pebble: cannot
  w.step();
  assert.equal(w.lastAction!.reason, 'cannot_use');
  handleKey(w, 'd', keys);
  assert.equal(keys.dropPending, true);
  handleKey(w, '3', keys); // stacks: pebble, apple, coin
  w.step();
  assert.equal(countOf(inv(w), idx(w, 'coin')), 0);
  handleKey(w, '2', keys); // eat the apple
  w.step();
  assert.equal(w.lastAction!.kind, 'use');
  assert.equal(countOf(inv(w), idx(w, 'apple')), 0);
  assert.equal(keys.dropPending, false);
  handleKey(w, 'l', keys);
  w.step();
  assert.equal(w.player.x, 3);
  assert.equal(handleKey(w, 'q', keys), 'quit');

  // Without an inventory, digits and `d` still move.
  const plain = World.create(loadFixture(), 1);
  handleKey(plain, '1', { dropPending: false });
  plain.step();
  assert.deepEqual([plain.player.x, plain.player.y], [1, 2]);
});

test('transfer window: views from hudModel, buttons become actions, read-only after defeat', () => {
  const w = world({ 'loot.yaml': LOOT });
  at(w, 2, 2);
  const iv = transferView(w, null, false);
  assert.equal(iv.inventory!.carrying, 'Carrying: 0.1/0.6');
  assert.deepEqual(iv.tabs, []);
  assert.deepEqual(iv.inventory!.stacks.map((s) => [s.use?.label, s.drop!.actions, s.move]), [[undefined, [{ kind: 'drop', item: 't:pebble', count: 1 }], null]]);
  const lv = transferView(w, 2, false);
  assert.deepEqual(lv.tabs.map((t) => [t.label, t.selected]), [['Box', false], ['Box', true]]);
  assert.deepEqual(lv.container!.stacks[0]!.move, { kind: 'take', container: 2, item: 't:coin' });
  assert.deepEqual(lv.takeAll!.actions, [{ kind: 'take', container: 2, item: 't:coin' }]);
  assert.deepEqual(lv.putAll!.actions, [{ kind: 'put', container: 2, item: 't:pebble' }]);
  for (const a of lv.takeAll!.actions) w.queueAction(a);
  w.step();
  assert.equal(countOf(inv(w), idx(w, 'coin')), 2);

  const ro = transferView(w, 0, true);
  assert.ok([...ro.container!.stacks, ...ro.inventory!.stacks].every((s) => s.disabled && (s.drop?.disabled ?? true)));
  assert.equal(transferView(world(), 0, false).container, null);
  assert.equal(transferView(World.create(loadFixture(), 1), null, false).inventory, null);
});

test('clickIntent: non-walkable containers are approached with adjacent: true', () => {
  const w = world();
  assert.deepEqual(clickIntent(w, 1, 1), { kind: 'goto', x: 1, y: 1, z: 0, adjacent: true });
  assert.deepEqual(clickIntent(w, 5, 1), { kind: 'goto', x: 5, y: 1, z: 0 }); // walkable crate
  assert.deepEqual(clickIntent(w, 0, 0), { kind: 'goto', x: 0, y: 0, z: 0 }); // plain wall
});

// ── Loader errors (AC 19) ───────────────────────────────────────────────────

function errorsOf(files: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture({ ...BASE, ...files })]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], file: string, path: string, message: RegExp): void {
  const hit = errors.find((e) => e.file === file && e.path === path && e.line !== undefined && message.test(e.message));
  assert.ok(hit, `no error at ${file} ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

const item = (extra: string) => `items:\n  - { id: x, label: X, glyph: x, color: red, weight: 1${extra} }\n`;

test('error: negative weight or capacity', () => {
  expectError(errorsOf({ 'items.yaml': item('').replace('weight: 1', 'weight: -1') }), 'items.yaml', 'items[0].weight', /must be a number ≥ 0/);
  expectError(errorsOf({ 'tiles.yaml': TILES.replace('capacity: 0.3', 'capacity: -2') }), 'tiles.yaml', 'tiles[2].container.capacity', /≥ 0/);
  expectError(errorsOf({ 'archetypes.yaml': ARCHETYPES.replace('capacity: 0.6', 'capacity: -1') }), 'archetypes.yaml', 'archetypes[0].inventory.capacity', /≥ 0/);
});

test('error: unknown item, loot table, tile and room tag references, with suggestions', () => {
  expectError(errorsOf({ 'archetypes.yaml': ARCHETYPES.replace('{ pebble: 1 }', '{ pebbel: 1 }') }), 'archetypes.yaml', 'archetypes[0].inventory.items.pebbel', /unknown item 'pebbel' \(did you mean 'pebble'\?\)/);
  expectError(errorsOf({ 'loot.yaml': 'loot:\n  - { id: p, entries: [{ item: aple }] }\n' }), 'loot.yaml', 'loot[0].entries[0].item', /unknown item 'aple' \(did you mean 'apple'\?\)/);
  expectError(errorsOf({ 'loot.yaml': 'loot:\n  - { id: pp, entries: [{ table: p }] }\n' }), 'loot.yaml', 'loot[0].entries[0].table', /unknown loot 'p' \(did you mean 'pp'\?\)/);
  expectError(errorsOf({ 'loot.yaml': LOOT.replace('table: pebbles }', 'table: pebble }') }), 'loot.yaml', 'distributions[0].table', /unknown loot 'pebble' \(did you mean 'pebbles'\?\)/);
  expectError(errorsOf({ 'loot.yaml': LOOT.replace('container: box, table', 'container: bxo, table') }), 'loot.yaml', 'distributions[0].container', /unknown tile 'bxo' \(did you mean 'box'\?\)/);
  expectError(errorsOf({ 'loot.yaml': LOOT.replace('room: cellar', 'room: celar') }), 'loot.yaml', 'distributions[1].room', /unknown room tag 'celar' \(did you mean 'cellar'\?\)/);
  expectError(
    errorsOf({ 's.yaml': `systems:\n  - { id: s, when: 'tile.in_room("kichen")', effects: [{ type: apply, measurement: hp, delta: 1 }] }\n` }),
    's.yaml',
    'systems[0].when',
    /in_room: unknown room tag 'kichen' \(did you mean 'kitchen'\?\)/,
  );
  expectError(
    errorsOf({ 's.yaml': `systems:\n  - { id: s, when: 'self.count_item("pebbel") > 0', effects: [{ type: apply, measurement: hp, delta: 1 }] }\n` }),
    's.yaml',
    'systems[0].when',
    /count_item: unknown item 'pebbel' \(did you mean 'pebble'\?\)/,
  );
});

test('error: use with empty effects or a bad consume', () => {
  expectError(errorsOf({ 'items.yaml': item(', use: { effects: [] }') }), 'items.yaml', 'items[0].use.effects', /at least one effect/);
  expectError(errorsOf({ 'items.yaml': item(', use: { label: Eat }') }), 'items.yaml', 'items[0].use', /missing required field 'effects'/);
  const eff = 'effects: [{ type: apply, measurement: hp, delta: 1 }]';
  expectError(errorsOf({ 'items.yaml': item(`, use: { consume: -1, ${eff} }`) }), 'items.yaml', 'items[0].use.consume', /non-negative integer/);
  expectError(errorsOf({ 'items.yaml': item(`, use: { consume: 1.5, ${eff} }`) }), 'items.yaml', 'items[0].use.consume', /non-negative integer/);
});

test('error: starting inventory over capacity', () => {
  expectError(errorsOf({ 'archetypes.yaml': ARCHETYPES.replace('{ pebble: 1 }', '{ pebble: 5, apple: 1 }') }), 'archetypes.yaml', 'archetypes[0].inventory.items', /weighs 0.75, over its capacity of 0.6/);
  expectError(errorsOf({ 'archetypes.yaml': ARCHETYPES.replace('{ pebble: 1 }', '{ pebble: 0 }') }), 'archetypes.yaml', 'archetypes[0].inventory.items.pebble', /positive integer/);
});

test('error: room rect out of bounds or empty; empty room tags', () => {
  const rooms = (r: string) => errorsOf({ 'map.yaml': MAP.replace('      - { rect: [1, 1, 2, 3], tags: [kitchen] }', `      - ${r}`) });
  expectError(rooms('{ rect: [5, 1, 3, 1], tags: [a] }'), 'map.yaml', 'maps[0].rooms[0].rect', /out of bounds: the map is 7×5/);
  expectError(rooms('{ rect: [-1, 0, 1, 1], tags: [a] }'), 'map.yaml', 'maps[0].rooms[0].rect', /out of bounds/);
  expectError(rooms('{ rect: [1, 1, 0, 2], tags: [a] }'), 'map.yaml', 'maps[0].rooms[0].rect', /empty: w and h must be ≥ 1/);
  expectError(rooms('{ rect: [1, 1, 2], tags: [a] }'), 'map.yaml', 'maps[0].rooms[0].rect', /four integers/);
  expectError(rooms('{ rect: [1, 1, 1, 1], tags: [] }'), 'map.yaml', 'maps[0].rooms[0].tags', /at least one tag/);
  expectError(rooms('{ rect: [1, 1, 1, 1] }'), 'map.yaml', 'maps[0].rooms[0]', /at least one tag/);
});

test('error: loot entries, weights, ranges, count placement and cycles', () => {
  const loot = (entries: string, extra = '') => errorsOf({ 'loot.yaml': `loot:\n  - { id: p${extra}, entries: [${entries}] }\n` });
  expectError(loot('{ weight: 1 }'), 'loot.yaml', 'loot[0].entries[0]', /exactly one of 'item', 'table' or 'nothing: true'/);
  expectError(loot('{ item: coin, nothing: true }'), 'loot.yaml', 'loot[0].entries[0]', /exactly one of .*got item and nothing/);
  expectError(loot('{ item: coin, weight: 0 }'), 'loot.yaml', 'loot[0].entries[0].weight', /positive integer/);
  expectError(loot('{ item: coin, weight: 1.5 }'), 'loot.yaml', 'loot[0].entries[0].weight', /positive integer/);
  expectError(loot('{ item: coin }', ', rolls: [3, 1]'), 'loot.yaml', 'loot[0].rolls', /range \[min, max\]/);
  expectError(loot('{ item: coin }', ', rolls: -1'), 'loot.yaml', 'loot[0].rolls', /integer ≥ 0/);
  expectError(loot('{ item: coin, count: 0 }'), 'loot.yaml', 'loot[0].entries[0].count', /integer ≥ 1/);
  expectError(loot('{ item: coin, count: [2, 1] }'), 'loot.yaml', 'loot[0].entries[0].count', /range/);
  expectError(loot('{ nothing: true, count: 2 }'), 'loot.yaml', 'loot[0].entries[0].count', /only allowed on 'item' entries/);
  expectError(loot('{ nothing: false }'), 'loot.yaml', 'loot[0].entries[0].nothing', /must be true/);
  expectError(loot(''), 'loot.yaml', 'loot[0].entries', /at least one entry/);
  const cycle = errorsOf({
    'loot.yaml': `loot:
  - { id: a, entries: [{ item: coin }, { table: b }] }
  - { id: b, entries: [{ table: c }] }
  - { id: c, entries: [{ table: a }] }
  - { id: self, entries: [{ table: self }] }
`,
  });
  expectError(cycle, 'loot.yaml', 'loot[2].entries[0]', /loot table cycle: t:a → t:b → t:c → t:a/);
  expectError(cycle, 'loot.yaml', 'loot[3].entries[0]', /loot table cycle: t:self → t:self/);
});

test('error: distribution to a tile without a container', () => {
  expectError(errorsOf({ 'loot.yaml': LOOT.replace('container: box, table: pebbles', 'container: floor, table: pebbles') }), 'loot.yaml', 'distributions[0].container', /tile 't:floor' has no 'container'/);
});

test('error: non-literal ids in count_item / has_item / in_room', () => {
  const when = (w: string) => errorsOf({ 's.yaml': `systems:\n  - { id: s, when: '${w}', effects: [{ type: apply, measurement: hp, delta: 1 }] }\n` });
  expectError(when('self.count_item(tile.id) > 0'), 's.yaml', 'systems[0].when', /count_item\(\) expects a string literal item id/);
  expectError(when('has_item(self, tile.id)'), 's.yaml', 'systems[0].when', /has_item\(\) expects a string literal item id/);
  expectError(when('tile.in_room(tile.id)'), 's.yaml', 'systems[0].when', /in_room\(\) expects a string literal room tag/);
  expectError(when('in_room(self, "kitchen")'), 's.yaml', 'systems[0].when', /expects `tile`/);
  expectError(when('has_item(tile, "pebble")'), 's.yaml', 'systems[0].when', /expects an entity, got tile/);
});

test('definition: items, loot, distributions, ids and resolved container/inventory/rooms', () => {
  const d = def({ 'loot.yaml': LOOT });
  assert.deepEqual(Object.keys(d.ids.items), ['t:pebble', 't:brick', 't:coin', 't:apple', 't:charm']);
  assert.deepEqual(Object.keys(d.ids.loot), ['t:pebbles', 't:coins', 't:apples']);
  assert.equal(d.items[3]!.use!.label, 'Eat');
  assert.equal(d.items[3]!.use!.consume, 1);
  assert.equal(d.items[4]!.use!.label, 'Use');
  assert.equal(d.items[4]!.use!.consume, 0);
  assert.equal(d.items[0]!.use, null);
  assert.deepEqual(d.tiles[0]!.container, null);
  assert.deepEqual(d.archetypes[0]!.inventory, { capacity: 60, items: [{ item: 0, count: 1 }] });
  assert.equal(d.archetypes[1]!.inventory, null);
  assert.deepEqual(d.distributions[1], { container: 2, room: 1, table: 1 });
  assert.deepEqual(d.loot[1]!.entries, [{ kind: 'item', item: 2, weight: 1, countMin: 2, countMax: 2 }]);
  assert.ok(Object.isFrozen(d.items));
});
