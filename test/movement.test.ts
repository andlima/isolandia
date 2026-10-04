import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPacksOrThrow, Pathfinder, renderPosition, World, type Intent } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, loadFixture } from './helpers.ts';

/** A world over an ASCII map: `#` wall, `.` floor, `@` player on floor. */
function worldOf(rows: string[], ticksPerStep = 2): World {
  const def = loadFixture({
    'archetypes.yaml': `archetypes:\n  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, ticks_per_step: ${ticksPerStep} }\n`,
    'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "#": { tile: wall }, "@": { tile: floor, player: true } }
    rows: ${JSON.stringify(rows)}
start: { map: room, player: hero }
`,
  });
  return World.create(def, 1);
}

const cells = (w: World, path: Int32Array | null) => path && [...path].map((i) => [i % w.grid.width, Math.floor(i / w.grid.width)]);

// ── A* ──────────────────────────────────────────────────────────────────────

test('A*: straight line', () => {
  const w = worldOf(['@....']);
  assert.deepEqual(cells(w, new Pathfinder(w.grid).findPath(0, 0, 4, 0)), [[1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.deepEqual(new Pathfinder(w.grid).findPath(2, 0, 2, 0), new Int32Array(0));
});

test('A*: detours around walls, 8-connected, never through walls', () => {
  const w = worldOf(['@....', '.###.', '.#...', '.#.#.', '.....']);
  const path = cells(w, new Pathfinder(w.grid).findPath(0, 0, 2, 2))!;
  assert.deepEqual(path.at(-1), [2, 2]);
  let [px, py] = [0, 0];
  for (const [x, y] of path) {
    assert.ok(w.grid.walkable(x!, y!));
    assert.ok(Math.max(Math.abs(x! - px), Math.abs(y! - py)) === 1);
    [px, py] = [x!, y!];
  }
});

test('A*: takes diagonals in open space', () => {
  const w = worldOf(['@...', '....', '....', '....']);
  assert.deepEqual(cells(w, new Pathfinder(w.grid).findPath(0, 0, 3, 3)), [[1, 1], [2, 2], [3, 3]]);
});

test('A*: no corner cutting', () => {
  const w = worldOf(['@#', '..']);
  assert.deepEqual(cells(w, new Pathfinder(w.grid).findPath(0, 0, 1, 1)), [[0, 1], [1, 1]]);
  const w2 = worldOf(['@#', '#.']);
  assert.equal(new Pathfinder(w2.grid).findPath(0, 0, 1, 1), null);
});

test('A*: unreachable, blocked and out-of-bounds goals return null; buffers are reusable', () => {
  const w = worldOf(['@.#..', '..#..', '..#..']);
  const pf = new Pathfinder(w.grid);
  assert.equal(pf.findPath(0, 0, 4, 2), null);
  assert.equal(pf.findPath(0, 0, 2, 1), null);
  assert.equal(pf.findPath(0, 0, 9, 9), null);
  assert.ok(pf.findPath(0, 0, 1, 2));
});

test('A*: deterministic tie-breaks (same path every time, fresh or reused)', () => {
  // Many equal-cost paths exist from corner to corner of an open room.
  const w = worldOf(['@.....', '......', '......', '......']);
  const pf = new Pathfinder(w.grid);
  const first = cells(w, pf.findPath(0, 0, 5, 3));
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(cells(w, pf.findPath(0, 0, 5, 3)), first);
    assert.deepEqual(cells(w, new Pathfinder(w.grid).findPath(0, 0, 5, 3)), first);
  }
  // Pinned: equal-f nodes pop in insertion order (orthogonals before diagonals).
  assert.deepEqual(first, [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]]);
});

// ── Corner rule for keyboard steps ─────────────────────────────────────────

test('keyboard diagonal steps do not cut corners', () => {
  const w = worldOf(['@#', '..']);
  w.queueIntent({ kind: 'step', dx: 1, dy: 1 });
  w.step();
  assert.deepEqual([w.player.x, w.player.y], [0, 0]);
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 });
  w.step();
  assert.deepEqual([w.player.x, w.player.y], [0, 1]);
});

// ── Goto ────────────────────────────────────────────────────────────────────

test('goto: path computed at the next tick and followed one step per ticks_per_step', () => {
  const w = worldOf(['@....'], 2);
  w.queueIntent({ kind: 'goto', x: 3, y: 0 });
  assert.equal(w.player.path, null);
  const xs: number[] = [];
  for (let i = 0; i < 8; i++) {
    w.step();
    xs.push(w.player.x);
  }
  assert.deepEqual(xs, [1, 1, 2, 2, 3, 3, 3, 3]);
  assert.deepEqual(w.lastGoto, { x: 3, y: 0, ok: true, tick: 0 });
  assert.equal(w.player.path, null);
  assert.equal(w.pathGoal(w.player), null);
});

test('goto: exposes the path goal while active', () => {
  const w = worldOf(['@....'], 2);
  w.queueIntent({ kind: 'goto', x: 4, y: 0 });
  w.step();
  assert.deepEqual(w.pathGoal(w.player), { x: 4, y: 0 });
});

test('goto: a keyboard intent cancels the active path', () => {
  const w = worldOf(['@....', '.....'], 1);
  w.queueIntent({ kind: 'goto', x: 4, y: 0 });
  w.step();
  w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 0]);
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 });
  w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
  assert.equal(w.player.path, null);
  for (let i = 0; i < 5; i++) w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
});

test('goto: a new goto replaces the old path (latest intent wins)', () => {
  const w = worldOf(['@....'], 1);
  w.queueIntent({ kind: 'goto', x: 4, y: 0 });
  w.queueIntent({ kind: 'goto', x: 2, y: 0 });
  for (let i = 0; i < 6; i++) w.step();
  assert.equal(w.player.x, 2);
});

test('goto: unreachable or blocked goals are dropped and recorded', () => {
  const w = worldOf(['@.#..'], 1);
  w.queueIntent({ kind: 'goto', x: 4, y: 0 });
  w.step();
  assert.deepEqual(w.lastGoto, { x: 4, y: 0, ok: false, tick: 0 });
  assert.equal(w.player.path, null);
  assert.equal(w.player.x, 0);
  const prev = w.lastGoto;
  w.queueIntent({ kind: 'goto', x: 2, y: 0 });
  w.step();
  assert.notEqual(w.lastGoto, prev, 'each goto produces a fresh record');
  assert.deepEqual(w.lastGoto, { x: 2, y: 0, ok: false, tick: 1 });
  w.queueIntent({ kind: 'goto', x: 99, y: 0 });
  w.step();
  assert.equal(w.lastGoto?.ok, false);
});

test('goto: path and pending intent are part of the snapshot', () => {
  const w = worldOf(['@....'], 2);
  w.queueIntent({ kind: 'goto', x: 3, y: 0 });
  assert.deepEqual(w.snapshot().entities[0]!.intent, { kind: 'goto', x: 3, y: 0 });
  w.step();
  const snap = w.snapshot();
  assert.equal(snap.entities[0]!.intent, null);
  assert.deepEqual(snap.entities[0]!.path, [[2, 0], [3, 0]]);
  assert.deepEqual(snap.entities[0]!.lastGoto, { x: 3, y: 0, ok: true, tick: 0 });
});

test('determinism: mixed goto and keyboard intents ⇒ same hash', () => {
  for (const dirs of Object.values(GAMES)) {
    const def = loadPacksOrThrow(dirs.map(readPack));
    const run = () => {
      const w = World.create(def, 99);
      const map = def.maps[def.start.map]!;
      const intents: Intent[] = [
        { kind: 'goto', x: map.width - 2, y: map.height - 2 },
        { kind: 'step', dx: -1, dy: 0 },
        { kind: 'goto', x: 1, y: 1 },
        { kind: 'goto', x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) },
        { kind: 'step', dx: 1, dy: 1 },
        { kind: 'goto', x: 0, y: 0 },
      ];
      const hashes: string[] = [];
      for (let t = 0; t < 600; t++) {
        if (t % 23 === 0) w.queueIntent(intents[(t / 23) % intents.length]!);
        w.step();
        if (t % 50 === 0) hashes.push(w.hash());
      }
      return { hashes, snap: w.snapshot() };
    };
    const a = run();
    const b = run();
    assert.deepEqual(a.hashes, b.hashes);
    assert.deepEqual(a.snap, b.snap);
    assert.ok(new Set(a.hashes).size > 1);
  }
});

// ── Render-facing movement ─────────────────────────────────────────────────

test('movement state: from, stepTick', () => {
  const w = worldOf(['@....'], 2);
  assert.deepEqual([w.player.fromX, w.player.fromY, w.player.stepTick], [0, 0, 0]);
  w.step();
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  w.step();
  assert.deepEqual([w.player.fromX, w.player.x, w.player.stepTick], [0, 1, 2]);
});

test('interpolation: continuous and constant-speed across consecutive steps', () => {
  for (const tps of [1, 2, 3]) {
    for (const mode of ['goto', 'key'] as const) {
      const w = worldOf(['@.........'], tps);
      if (mode === 'goto') w.queueIntent({ kind: 'goto', x: 6, y: 0 });
      const samples: number[] = [];
      const FRAMES = 4;
      for (let t = 0; t < 6 * tps + 3; t++) {
        if (mode === 'key' && w.player.x < 6) w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
        w.step();
        for (let f = 0; f < FRAMES; f++) samples.push(renderPosition(w.player, w.tick, f / FRAMES).x);
      }
      // Speed is 1 / tps tiles per tick until arrival, then 0: no pauses between tiles.
      const dv = 1 / tps / FRAMES;
      const deltas = samples.slice(1).map((v, i) => v - samples[i]!);
      const moving = deltas.findIndex((d) => d < 1e-9);
      assert.ok(moving > 0, `${mode}/${tps}: never moved`);
      for (let i = 0; i < moving; i++) assert.ok(Math.abs(deltas[i]! - dv) < 1e-9, `${mode}/${tps}: uneven delta at ${i}: ${deltas[i]}`);
      for (let i = moving; i < deltas.length; i++) assert.ok(Math.abs(deltas[i]!) < 1e-9);
      assert.equal(samples.at(-1), 6);
      // Starts at the start tile (no jump on the first frame).
      assert.ok(samples[0]! >= 0 && samples[0]! <= dv + 1e-9);
    }
  }
});

test('interpolation: diagonal steps lerp both axes', () => {
  const w = worldOf(['@..', '...'], 2);
  w.queueIntent({ kind: 'step', dx: 1, dy: 1 });
  w.step();
  assert.deepEqual(renderPosition(w.player, w.tick, 0), { x: 0, y: 0 });
  assert.deepEqual(renderPosition(w.player, w.tick, 1), { x: 0.5, y: 0.5 });
  w.step();
  assert.deepEqual(renderPosition(w.player, w.tick, 1), { x: 1, y: 1 });
  assert.deepEqual(renderPosition(w.player, w.tick + 10, 0.5), { x: 1, y: 1 });
});
