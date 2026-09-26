import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pathfinder } from '../spike/sim/astar.ts';
import type { Grid } from '../spike/sim/grid.ts';
import { FixedTickLoop } from '../spike/sim/loop.ts';
import { Sim } from '../spike/sim/sim.ts';
import { generateWorld } from '../spike/sim/world.ts';

function gridFromAscii(rows: string[]): Grid {
  const height = rows.length;
  const width = rows[0]!.length;
  const blocked = new Uint8Array(width * height);
  const walk: number[] = [];
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === '#') blocked[y * width + x] = 1;
      else walk.push(y * width + x);
    }),
  );
  return {
    width,
    height,
    chunkSize: width,
    chunksX: 1,
    chunksY: 1,
    blocked,
    walkable: Int32Array.from(walk),
  };
}

function isConnected(grid: Grid): boolean {
  const seen = new Uint8Array(grid.width * grid.height);
  const stack = [grid.walkable[0]!];
  seen[stack[0]!] = 1;
  let n = 0;
  while (stack.length) {
    const i = stack.pop()!;
    n++;
    const x = i % grid.width;
    const y = (i / grid.width) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const j = ny * grid.width + nx;
      if (!grid.blocked[j] && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return n === grid.walkable.length;
}

test('world generation is deterministic for a seed', () => {
  const a = generateWorld({ seed: 42 });
  const b = generateWorld({ seed: 42 });
  const c = generateWorld({ seed: 43 });
  assert.equal(a.width, 128);
  assert.equal(a.height, 128);
  assert.deepEqual(a.blocked, b.blocked);
  assert.notDeepEqual(a.blocked, c.blocked);
});

test('world is ~15% blocked and its walkable area is connected', () => {
  for (const seed of [1, 1337, 99999]) {
    const w = generateWorld({ seed });
    const ratio = 1 - w.walkable.length / (w.width * w.height);
    assert.ok(ratio >= 0.14 && ratio <= 0.2, `seed ${seed}: blocked ratio ${ratio}`);
    assert.ok(isConnected(w), `seed ${seed}: walkable area not connected`);
  }
});

test('A* finds a path around walls', () => {
  const g = gridFromAscii([
    '.....',
    '.###.',
    '.#...',
    '.#.#.',
    '.....',
  ]);
  const pf = new Pathfinder(g);
  const path = pf.findPath(0, 0, 2, 2);
  assert.ok(path);
  assert.equal(path[path.length - 1], 2 * 5 + 2);
  for (const i of path) assert.equal(g.blocked[i], 0, 'path crosses a blocked tile');
  // Consecutive steps are 8-neighbours.
  let prev = 0;
  for (const i of path) {
    const dx = Math.abs((i % 5) - (prev % 5));
    const dy = Math.abs(((i / 5) | 0) - ((prev / 5) | 0));
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0);
    prev = i;
  }
  assert.deepEqual(pf.findPath(2, 3, 2, 3), new Int32Array(0));
});

test('A* takes diagonals in open space', () => {
  const g = gridFromAscii(['....', '....', '....', '....']);
  const path = new Pathfinder(g).findPath(0, 0, 3, 3);
  assert.equal(path?.length, 3);
});

test('A* does not cut corners', () => {
  // Diagonal (0,0)->(1,1) is blocked by the wall at (1,0).
  const g = gridFromAscii([
    '.#',
    '..',
  ]);
  const path = new Pathfinder(g).findPath(0, 0, 1, 1);
  assert.deepEqual(path && [...path], [1 * 2 + 0, 1 * 2 + 1]);
  // Both orthogonals blocked: no diagonal squeeze.
  const g2 = gridFromAscii([
    '.#',
    '#.',
  ]);
  assert.equal(new Pathfinder(g2).findPath(0, 0, 1, 1), null);
});

test('A* returns null for unreachable or blocked targets', () => {
  const g = gridFromAscii([
    '..#..',
    '..#..',
    '..#..',
  ]);
  const pf = new Pathfinder(g);
  assert.equal(pf.findPath(0, 0, 4, 2), null);
  assert.equal(pf.findPath(0, 0, 2, 1), null);
  assert.equal(pf.findPath(0, 0, 9, 9), null);
  // Reusable after a failed search.
  assert.ok(pf.findPath(0, 0, 1, 2));
});

test('A* finds paths across chunk boundaries on the generated world', () => {
  const w = generateWorld({ seed: 7 });
  const pf = new Pathfinder(w);
  const a = w.walkable[0]!;
  const b = w.walkable[w.walkable.length - 1]!;
  const path = pf.findPath(a % w.width, (a / w.width) | 0, b % w.width, (b / w.width) | 0);
  assert.ok(path && path.length > 0, 'connected world must have a path');
});

test('tick accumulator runs the right number of ticks', () => {
  let ticks = 0;
  const loop = new FixedTickLoop(() => ticks++, { ticksPerSecond: 10, maxTicksPerFrame: 5 });
  assert.equal(loop.advance(50), 0);
  assert.equal(loop.advance(50), 1);
  assert.equal(loop.advance(250), 2);
  assert.ok(Math.abs(loop.alpha - 0.5) < 1e-9);
  // 60 fps frames for one second -> 10 ticks.
  const loop2 = new FixedTickLoop(() => ticks++, { ticksPerSecond: 10 });
  let n = 0;
  for (let i = 0; i < 60; i++) n += loop2.advance(1000 / 60);
  assert.ok(n === 10 || n === 9, `got ${n}`); // float rounding at the boundary
  assert.equal(ticks, 3 + n);
});

test('tick accumulator caps catch-up and drops the backlog', () => {
  let ticks = 0;
  const loop = new FixedTickLoop(() => ticks++, { ticksPerSecond: 10, maxTicksPerFrame: 4 });
  assert.equal(loop.advance(5030), 4); // a 5 s stall only runs 4 ticks
  assert.ok(loop.alpha < 1);
  assert.ok(loop.droppedMs > 4000);
  assert.equal(loop.advance(100), 1); // no spiral: back to normal
  assert.equal(loop.advance(-5), 0);
});

test('sim runs headless for 100+ ticks with 500 entities', () => {
  const world = generateWorld({ seed: 1337 });
  const sim = new Sim(world, { entityCount: 500, seed: 1337 });
  assert.equal(sim.count, 501);
  const start = new Float32Array(sim.posX);
  for (let i = 0; i < 150; i++) {
    sim.step();
    assert.ok(sim.pathsThisTick <= sim.pathBudgetPerTick + 1, 'path budget exceeded');
  }
  assert.equal(sim.tick, 150);
  let moved = 0;
  for (let e = 0; e < sim.count; e++) {
    if (sim.posX[e] !== start[e]) moved++;
    const x = Math.floor(sim.posX[e]!);
    const y = Math.floor(sim.posY[e]!);
    // Rendered position is always on or between walkable tiles.
    assert.ok(x >= 0 && y >= 0 && x < world.width && y < world.height);
    assert.equal(world.blocked[sim.toY[e]! * world.width + sim.toX[e]!], 0);
    assert.equal(world.blocked[sim.fromY[e]! * world.width + sim.fromX[e]!], 0);
  }
  assert.ok(moved > 400, `only ${moved} entities moved`);
  assert.ok(sim.pathsTotal >= 500);
});

test('path requests are budgeted per tick', () => {
  const world = generateWorld({ seed: 1 });
  const sim = new Sim(world, { entityCount: 500, seed: 1, pathBudgetPerTick: 20 });
  assert.equal(sim.queueLength, 500);
  sim.step();
  assert.equal(sim.pathsThisTick, 20);
  assert.equal(sim.queueLength, 480);
});

test('player click-to-move walks to the target', () => {
  const world = generateWorld({ seed: 5 });
  const sim = new Sim(world, { entityCount: 0, seed: 5 });
  const target = world.walkable[Math.floor(world.walkable.length / 2)]!;
  const tx = target % world.width;
  const ty = (target / world.width) | 0;
  assert.ok(sim.movePlayerTo(tx, ty));
  for (let i = 0; i < 2000 && !(sim.fromX[0] === tx && sim.fromY[0] === ty); i++) sim.step();
  assert.equal(sim.fromX[0], tx);
  assert.equal(sim.fromY[0], ty);
  // Blocked target is rejected.
  const b = world.blocked.indexOf(1);
  assert.equal(sim.movePlayerTo(b % world.width, (b / world.width) | 0), false);
});

test('sim sources do not import pixi.js or touch DOM globals', () => {
  const dir = join(import.meta.dirname, '../spike/sim');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from ['"]pixi\.js['"]/, f);
    assert.doesNotMatch(src, /\b(window|document|navigator|requestAnimationFrame)\b/, f);
  }
});
