import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPacksOrThrow, World, type Intent } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { loadFixture } from './helpers.ts';

const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test('world: grid, entities and Float64Array measurements', () => {
  const def = loadFixture();
  const w = World.create(def, 1);
  assert.equal(w.grid.width, 5);
  assert.equal(w.grid.height, 4);
  assert.ok(w.grid.cells instanceof Uint16Array);
  assert.equal(w.entities.length, 2);
  assert.equal(w.player.archetype.id, 't:hero');
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
  assert.ok(w.player.m instanceof Float64Array);
  assert.equal(w.value(w.player, 't:hp'), 10);
  assert.equal(w.value(w.player, 't:food'), 50);
  assert.equal(w.value(w.entities[1]!, 't:hp'), undefined);
  assert.equal(w.seconds, 0);
  w.step();
  assert.equal(w.tick, 1);
  assert.equal(w.seconds, 0.1);
});

test('rate is applied per tick as rate / ticksPerSecond, then clamped to min', () => {
  const w = World.create(loadFixture(), 1);
  for (let i = 0; i < 10; i++) w.step();
  close(w.value(w.player, 't:food'), 49);
  for (let i = 0; i < 1000; i++) w.step();
  assert.equal(w.value(w.player, 't:food'), 0);
});

test('rate clamps to a constant max and to an expression max', () => {
  const def = loadFixture({
    'extra.yaml': `measurements:
  - { id: rage, label: Rage, max: 10, initial: 0, rate: 5 }
  - id: cap
    label: Cap
    max: "self.hp / 2 + world.tick * 0"
    initial: 100
    rate: "1 + self.rage / 10"
archetypes:
  - { id: brute, label: Brute, glyph: B, color: red, measurements: [hp, rage, cap], initial: { hp: 8 } }
`,
    'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows: ["@."]
start: { map: room, player: brute }
`,
  });
  const w = World.create(def, 1);
  // Initial values are clamped too: cap starts at hp / 2 = 4.
  assert.equal(w.value(w.player, 't:cap'), 4);
  for (let i = 0; i < 30; i++) w.step();
  // 5/s for 3 s = 15, clamped to 10.
  assert.equal(w.value(w.player, 't:rage'), 10);
  assert.equal(w.value(w.player, 't:cap'), 4);
  // Lowering hp lowers the resolved max on the next clamp.
  w.player.m[def.ids.measurements['t:hp']!] = 2;
  w.step();
  assert.equal(w.value(w.player, 't:cap'), 1);
  assert.equal(w.player.max[def.ids.measurements['t:cap']!], 1);
});

test('movement: 8 directions, blocked by non-walkable tiles, ticks per step', () => {
  const w = World.create(loadFixture(), 1);
  const pos = () => [w.player.x, w.player.y];
  // North is a wall.
  w.queueIntent({ dx: 0, dy: -1 });
  w.step();
  assert.deepEqual(pos(), [2, 1]);
  // South-west diagonal is floor.
  w.queueIntent({ dx: -1, dy: 1 });
  w.step();
  assert.deepEqual(pos(), [1, 2]);
  // Default ticks_per_step = 2: the next intent waits one tick.
  w.queueIntent({ dx: 1, dy: 0 });
  w.step();
  assert.deepEqual(pos(), [1, 2]);
  w.step();
  assert.deepEqual(pos(), [2, 2]);
  // West twice: second move hits the wall at x = 0.
  w.queueIntent({ dx: -1, dy: 0 });
  w.step();
  w.step();
  w.queueIntent({ dx: -1, dy: 0 });
  w.step();
  w.step();
  assert.deepEqual(pos(), [1, 2]);
  // Non-player entities stand still.
  assert.deepEqual([w.entities[1]!.x, w.entities[1]!.y], [3, 1]);
});

test('movement: ticks_per_step is configurable per archetype', () => {
  const def = loadFixture({
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_step: 1 }
  - { id: rock, label: Rock, glyph: o, color: gray }
`,
  });
  const w = World.create(def, 1);
  w.queueIntent({ dx: -1, dy: 1 });
  w.step();
  w.queueIntent({ dx: 1, dy: 0 });
  w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 2]);
});

function run(defDirs: string[], seed: number, ticks: number): World {
  const def = loadPacksOrThrow(defDirs.map(readPack));
  const w = World.create(def, seed);
  const dirs: Intent[] = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  for (let t = 0; t < ticks; t++) {
    if (t % 7 === 0) w.queueIntent(dirs[(t / 7) % dirs.length]!);
    w.step();
  }
  return w;
}

test('determinism: same definition + seed + intents ⇒ same hash (1000 ticks)', () => {
  for (const genre of ['packs/zombie', 'packs/vampire']) {
    const a = run(['packs/base', genre], 1234, 1000);
    const b = run(['packs/base', genre], 1234, 1000);
    assert.equal(a.tick, 1000);
    assert.equal(a.hash(), b.hash());
    assert.deepEqual(a.snapshot(), b.snapshot());
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(a.snapshot())));
  }
});

test('determinism: the seeded RNG feeds expressions', () => {
  const def = loadFixture({
    'extra.yaml': `measurements:
  - { id: noise, label: Noise, max: 1000, initial: 500, rate: "random(-10, 10)" }
archetypes:
  - { id: walker, label: W, glyph: W, color: red, measurements: [noise] }
`,
    'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows: ["@."]
start: { map: room, player: walker }
`,
  });
  const hashAfter = (seed: number) => {
    const w = World.create(def, seed);
    for (let i = 0; i < 1000; i++) w.step();
    return w.hash();
  };
  assert.equal(hashAfter(7), hashAfter(7));
  assert.notEqual(hashAfter(7), hashAfter(8));
});

test('division by zero in a rate records a warning instead of crashing', () => {
  const def = loadFixture({
    'extra.yaml': `measurements:
  - { id: odd, label: Odd, max: 10, initial: 1, rate: "1 / (self.hp - self.hp)" }
archetypes:
  - { id: walker, label: W, glyph: W, color: red, measurements: [hp, odd] }
`,
    'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows: ["@."]
start: { map: room, player: walker }
`,
  });
  const w = World.create(def, 1);
  for (let i = 0; i < 5; i++) w.step();
  assert.equal(w.value(w.player, 't:odd'), 1);
  assert.equal(w.warnings.get('Division by zero'), 5);
});
