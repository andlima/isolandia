import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turnToward, World, type Entity } from '../src/core/index.ts';
import { loadFixture } from './helpers.ts';

const OPEN = ['#######', '#.....#', '#.....#', '#..@..#', '#.....#', '#.....#', '#######'];

/** A world over an ASCII map: `#` wall, `.` floor, `@` player, `n` an NPC without behavior. */
function worldOf(rows: string[], ticksPerTurn: number, ticksPerStep = 2): World {
  const def = loadFixture({
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_step: ${ticksPerStep}, ticks_per_turn: ${ticksPerTurn} }
  - { id: npc, label: Npc, glyph: n, color: red, ticks_per_step: ${ticksPerStep}, ticks_per_turn: ${ticksPerTurn} }
`,
    'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "#": { tile: wall }, "@": { tile: floor, player: true }, "n": { tile: floor, spawn: npc } }
    rows: ${JSON.stringify(rows)}
start: { map: room, player: hero }
`,
  });
  return World.create(def, 1);
}

/** Step `n` ticks, recording `facing x,y` of `e` after each. */
function trace(w: World, e: Entity, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    w.step();
    out.push(`${e.facing} ${e.x},${e.y}`);
  }
  return out;
}

test('turnToward: one point the short way, clockwise on a reversal', () => {
  assert.equal(turnToward('n', 'e'), 'ne');
  assert.equal(turnToward('n', 'w'), 'nw');
  assert.equal(turnToward('n', 's'), 'ne');
  assert.equal(turnToward('e', 'w'), 'se');
  assert.equal(turnToward('nw', 'ne'), 'n');
  assert.equal(turnToward('ne', 'sw'), 'e');
  assert.equal(turnToward('s', 's'), 's');
});

test('facing starts at s and is entity state', () => {
  const w = worldOf(OPEN, 1);
  assert.equal(w.player.facing, 's');
  assert.equal(w.snapshot().entities[0]!.facing, 's');
});

test('example: facing n, turn 1, step 2, stepping south turns 4 points then steps on the 5th tick', () => {
  const w = worldOf(OPEN, 1, 2);
  w.player.facing = 'n';
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 });
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    w.step();
    out.push(`${w.player.facing} ${w.player.x},${w.player.y}`);
    assert.deepEqual(w.player.intent, { kind: 'step', dx: 0, dy: 1 }, 'the intent stays pending while turning');
    assert.deepEqual([w.player.fromX, w.player.fromY, w.player.stepTick], [3, 3, 0], 'turning leaves the step state alone');
  }
  out.push(...trace(w, w.player, 3));
  assert.deepEqual(out, ['ne 3,3', 'e 3,3', 'se 3,3', 's 3,3', 's 3,4', 's 3,4', 's 3,4']);
  assert.equal(w.player.intent, null);
});

test('example: facing n, turn 1, stepping east turns ne, e then steps on the 3rd tick', () => {
  const w = worldOf(OPEN, 1, 2);
  w.player.facing = 'n';
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  assert.deepEqual(trace(w, w.player, 3), ['ne 3,3', 'e 3,3', 'e 4,3']);
});

test('90° turns go the short way, clockwise and counter-clockwise', () => {
  const cw = worldOf(OPEN, 1, 1);
  cw.player.facing = 'w';
  cw.queueIntent({ kind: 'step', dx: 0, dy: -1 });
  assert.deepEqual(trace(cw, cw.player, 3), ['nw 3,3', 'n 3,3', 'n 3,2']);

  const ccw = worldOf(OPEN, 1, 1);
  ccw.player.facing = 'n';
  ccw.queueIntent({ kind: 'step', dx: -1, dy: 0 });
  assert.deepEqual(trace(ccw, ccw.player, 3), ['nw 3,3', 'w 3,3', 'w 2,3']);
});

test('a 180° turn goes clockwise', () => {
  const w = worldOf(OPEN, 1, 1);
  w.player.facing = 'e';
  w.queueIntent({ kind: 'step', dx: -1, dy: 0 });
  assert.deepEqual(trace(w, w.player, 5), ['se 3,3', 's 3,3', 'sw 3,3', 'w 3,3', 'w 2,3']);
});

test('ticks_per_turn 0 turns and steps on the first tick, as before', () => {
  const w = worldOf(OPEN, 0, 2);
  w.player.facing = 'n';
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 });
  assert.deepEqual(trace(w, w.player, 1), ['s 3,4']);
  assert.equal(w.player.moveCooldown, 2);
});

test('ticks_per_turn 3 takes 3 ticks per 45°', () => {
  const w = worldOf(OPEN, 3, 2);
  w.player.facing = 'n';
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  assert.deepEqual(trace(w, w.player, 7), ['ne 3,3', 'ne 3,3', 'ne 3,3', 'e 3,3', 'e 3,3', 'e 3,3', 'e 4,3']);
});

test('a blocked step still turns to face the wall, without moving', () => {
  const w = worldOf(['#####', '#.@.#', '#...#', '#####'], 1, 1);
  w.queueIntent({ kind: 'step', dx: 0, dy: -1 });
  assert.deepEqual(trace(w, w.player, 6), ['sw 2,1', 'w 2,1', 'nw 2,1', 'n 2,1', 'n 2,1', 'n 2,1']);
  assert.equal(w.player.intent, null, 'the rejected step is consumed');
  assert.deepEqual([w.player.fromX, w.player.fromY, w.player.stepTick], [2, 1, 0]);
});

test('a goto path turns before its first step and at each bend', () => {
  const w = worldOf(['#####', '#@..#', '###.#', '###.#', '#####'], 1, 1);
  w.queueIntent({ kind: 'goto', x: 3, y: 3, z: 0 });
  const out = trace(w, w.player, 9);
  assert.deepEqual(out, ['se 1,1', 'e 1,1', 'e 2,1', 'e 3,1', 'se 3,1', 's 3,1', 's 3,2', 's 3,3', 's 3,3']);
  assert.equal(w.player.path, null);
});

test('a path stays pending while turning', () => {
  const w = worldOf(OPEN, 1, 1);
  w.player.facing = 'n';
  w.queueIntent({ kind: 'goto', x: 3, y: 5, z: 0 });
  w.step();
  assert.deepEqual(w.snapshot().entities[0]!.path, [
    [3, 4, 0],
    [3, 5, 0],
  ]);
});

test('an intent-driven NPC turns too', () => {
  const w = worldOf(['#######', '#@....#', '#..n..#', '#######'], 1, 1);
  const npc = w.entities.find((e) => e.archetype.id === 't:npc')!;
  assert.equal(npc.facing, 's');
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 }, npc);
  assert.deepEqual(trace(w, npc, 3), ['se 3,2', 'e 3,2', 'e 4,2']);
});

test('the snapshot and hash change when only facing differs', () => {
  const a = worldOf(OPEN, 1);
  const b = worldOf(OPEN, 1);
  assert.equal(a.hash(), b.hash());
  b.player.facing = 'e';
  assert.notEqual(a.hash(), b.hash());
  assert.equal(b.snapshot().entities[0]!.facing, 'e');
});
