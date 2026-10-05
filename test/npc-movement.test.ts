import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPacksOrThrow, Rng, World, type Entity, type Intent } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, loadFixture } from './helpers.ts';

/**
 * Hero (1 tick/step) at (1,1), shambler `z` (3 ticks/step) at (1,3),
 * crawler `c` (1 tick/step) at (6,3); (7,1) is a sealed pocket.
 */
const ROWS = ['#########', '#@....#.#', '#.#...###', '#z....c.#', '#########'];

function npcWorld(mapExtra = ''): World {
  const def = loadFixture({
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, ticks_per_step: 1, measurements: [hp, food] }
  - { id: shambler, label: Shambler, glyph: z, color: green, ticks_per_turn: 0, ticks_per_step: 3 }
  - { id: crawler, label: Crawler, glyph: c, color: red, ticks_per_turn: 0, ticks_per_step: 1 }
`,
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "z": { tile: floor, spawn: shambler }
      "c": { tile: floor, spawn: crawler }
    rows: ${JSON.stringify(ROWS)}
start:
  map: room
  player: hero
${mapExtra}`,
  });
  return World.create(def, 1);
}

const pos = (e: Entity) => [e.x, e.y];

test('NPC step: moves, respects walls, corners and its own ticks_per_step', () => {
  const w = npcWorld();
  const z = w.entities[1]!;
  assert.equal(z.archetype.id, 't:shambler');
  w.queueIntent({ kind: 'step', dx: 0, dy: -1 }, z);
  assert.deepEqual(z.intent, { kind: 'step', dx: 0, dy: -1 });
  assert.equal(w.player.intent, null);
  w.step();
  assert.deepEqual(pos(z), [1, 2]);
  assert.equal(z.intent, null);
  // ticks_per_step = 3: the next step persists through the cooldown, then fires once.
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 }, z);
  w.step();
  w.step();
  assert.deepEqual(pos(z), [1, 2]);
  w.step();
  assert.deepEqual(pos(z), [1, 3]);
  // Idle entities still count their cooldown down.
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(z.moveCooldown, 0);
  w.queueIntent({ kind: 'step', dx: 0, dy: -1 }, z);
  for (let i = 0; i < 4; i++) w.step();
  assert.deepEqual(pos(z), [1, 2]);
  // Diagonal to (2,1) would cut the wall corner at (2,2).
  w.queueIntent({ kind: 'step', dx: 1, dy: -1 }, z);
  w.step();
  assert.deepEqual(pos(z), [1, 2]);
  // West is a wall.
  w.queueIntent({ kind: 'step', dx: -1, dy: 0 }, z);
  w.step();
  assert.deepEqual(pos(z), [1, 2]);
  // The player and the other NPC never moved.
  assert.deepEqual(pos(w.player), [1, 1]);
  assert.deepEqual(pos(w.entities[2]!), [6, 3]);
});

test('NPC step: a zero step is ignored and does not clear a pending intent', () => {
  const w = npcWorld();
  const c = w.entities[2]!;
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 }, c);
  w.queueIntent({ kind: 'step', dx: 0, dy: 0 }, c);
  w.step();
  assert.deepEqual(pos(c), [7, 3]);
});

test('NPC goto: walks an A* path; pathGoal and lastGoto are per entity', () => {
  const w = npcWorld();
  const z = w.entities[1]!;
  w.queueIntent({ kind: 'goto', x: 5, y: 1, z: 0 }, z);
  w.step();
  assert.deepEqual(w.pathGoal(z), { x: 5, y: 1, z: 0 });
  assert.equal(w.pathGoal(w.player), null);
  assert.deepEqual(z.lastGoto, { x: 5, y: 1, z: 0, ok: true, tick: 0 });
  assert.equal(w.player.lastGoto, null);
  assert.equal(w.lastGoto, null);
  // First step on tick 0, then one step every 3 ticks.
  let ticks = 1;
  while (z.x !== 5 || z.y !== 1) {
    const [px, py] = pos(z);
    w.step();
    ticks++;
    assert.ok(Math.max(Math.abs(z.x - px!), Math.abs(z.y - py!)) <= 1);
    assert.ok(w.grid.walkable(z.x, z.y));
    assert.ok(ticks < 50, 'never arrived');
  }
  assert.equal(z.path, null);
  assert.equal(w.pathGoal(z), null);
  assert.equal((ticks - 1) % 3, 0);
});

test('NPC goto adjacent: ends next to a blocked goal', () => {
  const w = npcWorld();
  const c = w.entities[2]!;
  w.queueIntent({ kind: 'goto', x: 6, y: 1, z: 0, adjacent: true }, c);
  for (let i = 0; i < 20; i++) w.step();
  assert.ok(c.lastGoto!.ok);
  assert.equal(Math.max(Math.abs(c.x - 6), Math.abs(c.y - 1)), 1);
});

test('NPC goto: unreachable goal fails on the NPC only', () => {
  const w = npcWorld();
  const z = w.entities[1]!;
  w.queueIntent({ kind: 'goto', x: 7, y: 1, z: 0 }, z);
  w.step();
  assert.deepEqual(z.lastGoto, { x: 7, y: 1, z: 0, ok: false, tick: 0 });
  assert.equal(z.path, null);
  assert.deepEqual(pos(z), [1, 3]);
  assert.equal(w.player.lastGoto, null);
  assert.equal(w.lastGoto, null);
  // The player's own goto is still tracked separately.
  w.queueIntent({ kind: 'goto', x: 3, y: 1, z: 0 });
  w.step();
  assert.deepEqual(w.lastGoto, { x: 3, y: 1, z: 0, ok: true, tick: 1 });
  assert.equal(z.lastGoto!.ok, false);
});

test('player and NPC intents on the same tick are all applied', () => {
  const w = npcWorld();
  const [p, z, c] = w.entities as [Entity, Entity, Entity];
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  w.queueIntent({ kind: 'goto', x: 3, y: 3, z: 0 }, z);
  w.queueIntent({ kind: 'goto', x: 7, y: 1, z: 0 }, c);
  const snap = w.snapshot();
  assert.deepEqual(
    snap.entities.map((e) => e.intent),
    [{ kind: 'step', dx: 1, dy: 0 }, { kind: 'goto', x: 3, y: 3, z: 0 }, { kind: 'goto', x: 7, y: 1, z: 0 }],
  );
  w.step();
  assert.deepEqual(pos(p), [2, 1]);
  assert.deepEqual(pos(z), [2, 3]);
  assert.deepEqual(pos(c), [6, 3]);
  assert.deepEqual(z.lastGoto, { x: 3, y: 3, z: 0, ok: true, tick: 0 });
  assert.equal(c.lastGoto!.ok, false);
  assert.equal(p.lastGoto, null);
  assert.deepEqual(
    w.snapshot().entities.map((e) => [e.intent, e.lastGoto?.ok ?? null]),
    [
      [null, null],
      [null, true],
      [null, false],
    ],
  );
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(w.snapshot())));
});

test('queueIntent: foreign entities throw; NPC intents are ignored after defeat', () => {
  const w = npcWorld();
  const other = npcWorld();
  assert.throws(() => w.queueIntent({ kind: 'step', dx: 1, dy: 0 }, other.entities[1]!));
  assert.throws(() => w.queueIntent({ kind: 'step', dx: 1, dy: 0 }, { ...w.entities[1]! }));

  const d = npcWorld('  defeat: { when: "self.food < 50" }\n');
  d.step();
  assert.ok(d.defeat);
  const z = d.entities[1]!;
  d.queueIntent({ kind: 'step', dx: 1, dy: 0 }, z);
  assert.equal(z.intent, null);
  d.step();
  assert.deepEqual(pos(z), [1, 3]);
});

function runWithNpcs(dirs: readonly string[], seed: number, ticks: number): World {
  const def = loadPacksOrThrow(dirs.map(readPack));
  const w = World.create(def, seed);
  const map = def.maps[def.start.map]!;
  const schedule = new Rng(seed ^ 0x5eed);
  const steps: Intent[] = [
    { kind: 'step', dx: 1, dy: 0 },
    { kind: 'step', dx: 0, dy: 1 },
    { kind: 'step', dx: -1, dy: -1 },
    { kind: 'step', dx: -1, dy: 0 },
    { kind: 'step', dx: 1, dy: 1 },
    { kind: 'step', dx: 0, dy: -1 },
  ];
  const n = w.entities.length;
  for (let t = 0; t < ticks; t++) {
    // Round-robin: two entities get an intent every tick.
    for (let k = 0; k < 2; k++) {
      const e = w.entities[(2 * t + k) % n]!;
      const r = schedule.next();
      if (r < 0.1) {
        const x = Math.floor(schedule.next() * map.width);
        const y = Math.floor(schedule.next() * map.height);
        w.queueIntent({ kind: 'goto', x, y, adjacent: r < 0.03 }, e);
      } else if (r < 0.6) w.queueIntent(steps[Math.floor(schedule.next() * steps.length)]!, e);
    }
    w.step();
  }
  return w;
}

test('determinism: player and NPC intents ⇒ same hash (1200 ticks, both genres)', () => {
  for (const dirs of Object.values(GAMES)) {
    const a = runWithNpcs(dirs, 4321, 1200);
    const b = runWithNpcs(dirs, 4321, 1200);
    assert.equal(a.tick, 1200);
    assert.ok(a.entities.length > 1, `${dirs.join(',')}: no NPCs spawned`);
    assert.equal(a.hash(), b.hash());
    assert.deepEqual(a.snapshot(), b.snapshot());
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(a.snapshot())));
    const start = World.create(a.def, 4321);
    const moved = a.entities.filter((e, i) => i > 0 && (e.x !== start.entities[i]!.x || e.y !== start.entities[i]!.y));
    assert.ok(moved.length > 0, `${dirs.join(',')}: no NPC moved`);
    assert.ok(a.entities.some((e) => e.id > 0 && e.lastGoto !== null));
  }
});
