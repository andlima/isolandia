import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPacksOrThrow, Pace, World, type Definition, type Intent } from '../src/core/index.ts';
import { handleKey, paceStatus, type KeyState } from '../src/ascii/terminal.ts';
import { hudTimeView } from '../src/web/hud.ts';
import { PAUSE_KEYS, speedKey } from '../src/web/keys.ts';
import { FixedTickLoop } from '../src/web/loop.ts';
import { AUTO_PAUSE_KEY, MemoryStore, readAutoPause, writeAutoPause } from '../src/web/saves.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES } from './helpers.ts';

const DEF: Definition = loadPacksOrThrow(GAMES.zombie.map((d) => readPack(d)));

// ── Pacing module ───────────────────────────────────────────────────────────

test('pace: pause toggles, speeds step 1/2/4/8 and clamp at both ends, labels', () => {
  const p = new Pace();
  assert.equal(p.paused, false);
  assert.equal(p.speed, 1);
  assert.equal(p.label, '1×');
  p.slower();
  assert.equal(p.speed, 1, 'clamps at 1×');
  p.faster();
  assert.equal(p.label, '2×');
  p.faster();
  p.faster();
  assert.equal(p.label, '8×');
  p.faster();
  assert.equal(p.speed, 8, 'clamps at 8×');
  p.slower();
  assert.equal(p.speed, 4);
  p.togglePause();
  assert.equal(p.paused, true);
  assert.equal(p.label, 'Paused');
  assert.equal(p.speed, 4, 'pausing keeps the speed');
  p.togglePause();
  assert.equal(p.label, '4×');
  p.setSpeed(2);
  assert.equal(p.speed, 2);
  p.setSpeed(3);
  assert.equal(p.speed, 2, 'not one of the speeds: ignored');
});

test('pace: the clock-card speed button cycles 1× → 2× → 4× → 8× → 1×', () => {
  const p = new Pace();
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    p.cycleSpeed();
    seen.push(p.speed);
  }
  assert.deepEqual(seen, [2, 4, 8, 1, 2]);
});

test('pace: auto-pause holds while a window is open and only with the option on', () => {
  const p = new Pace();
  p.windows(true, false);
  assert.equal(p.paused, false, 'option off');
  p.windows(true, true);
  assert.equal(p.paused, true);
  assert.equal(p.label, 'Paused');
  assert.equal(p.manualPause, false);
  p.windows(false, true);
  assert.equal(p.paused, false, 'closing the window resumes');
  p.windows(true, true);
  p.windows(true, false);
  assert.equal(p.paused, false, 'turning the option off resumes');
});

test('pace: P during a window pause resumes, and closing the window does not pause again', () => {
  const p = new Pace();
  p.windows(true, true);
  p.togglePause();
  assert.equal(p.paused, false);
  p.windows(true, true);
  assert.equal(p.paused, false, 'stays running while the window stays open');
  p.windows(false, true);
  assert.equal(p.paused, false);
  p.windows(true, true);
  assert.equal(p.paused, true, 'a new window pauses again');
});

test('pace: a manual pause survives opening and closing a window; P in between keeps it paused', () => {
  const p = new Pace();
  p.togglePause();
  p.windows(true, true);
  p.windows(false, true);
  assert.equal(p.paused, true, 'closing the window does not undo the manual pause');
  p.togglePause();
  assert.equal(p.paused, false);
  // Window pause, then P twice (resume, then a manual pause): closing keeps the manual pause.
  p.windows(true, true);
  p.togglePause();
  p.togglePause();
  assert.equal(p.manualPause, true);
  p.windows(false, true);
  assert.equal(p.paused, true);
});

test('hud: the clock card shows Paused or the speed, and neither once the game has ended', () => {
  const p = new Pace();
  assert.deepEqual(hudTimeView(p, false), { paused: false, speed: '1×' });
  p.faster();
  p.togglePause();
  assert.deepEqual(hudTimeView(p, false), { paused: true, speed: '2×' });
  assert.deepEqual(hudTimeView(p, true), { paused: false, speed: null });
});

test('browser keys: P / Pause toggle; + = numpad + faster; - numpad - slower', () => {
  assert.ok(PAUSE_KEYS.has('KeyP') && PAUSE_KEYS.has('Pause'));
  assert.equal(speedKey('Equal'), 1);
  assert.equal(speedKey('NumpadAdd'), 1);
  assert.equal(speedKey('Minus'), -1);
  assert.equal(speedKey('NumpadSubtract'), -1);
  assert.equal(speedKey('KeyW'), 0);
});

test('auto-pause option: stored under one key, default off, storage errors ignored', () => {
  const store = new MemoryStore();
  assert.equal(readAutoPause(store), false);
  writeAutoPause(store, true);
  assert.equal(store.read(AUTO_PAUSE_KEY), '1');
  assert.equal(readAutoPause(store), true);
  const broken = {
    list: () => [],
    read: (): string | null => {
      throw new Error('blocked');
    },
    write: () => {
      throw new Error('blocked');
    },
    remove: () => {},
  };
  assert.equal(readAutoPause(broken), false);
  assert.doesNotThrow(() => writeAutoPause(broken, true));
});

// ── FixedTickLoop ───────────────────────────────────────────────────────────

/** Ticks run over `ms` of wall time in 16 ms frames. */
function run(loop: FixedTickLoop, ms: number, frame = 16): number {
  let n = 0;
  for (let t = 0; t < ms; t += frame) n += loop.advance(frame);
  return n;
}

test('loop: speed s runs s times as many ticks per wall second', () => {
  for (const s of [1, 2, 4, 8]) {
    const loop = new FixedTickLoop(() => {}, { ticksPerSecond: 10 });
    loop.setPace(false, s);
    const n = run(loop, 10_000);
    assert.ok(Math.abs(n - 100 * s) <= 1, `${s}×: ${n} ticks in 10 s`);
  }
});

test('loop: the per-frame cap scales to 5 × speed', () => {
  for (const s of [1, 2, 4, 8]) {
    const loop = new FixedTickLoop(() => {}, { ticksPerSecond: 10 });
    loop.setPace(false, s);
    assert.equal(loop.frameCap, 5 * s);
    assert.equal(loop.advance(1000), 5 * s);
    assert.ok(loop.alpha < 1);
  }
});

test('loop: paused runs no ticks and freezes alpha; unpausing gives no burst', () => {
  let ticks = 0;
  const loop = new FixedTickLoop(() => ticks++, { ticksPerSecond: 10 });
  loop.advance(150);
  const alpha = loop.alpha;
  assert.ok(alpha > 0.4);
  loop.setPace(true, 1);
  assert.equal(run(loop, 5000), 0);
  assert.equal(loop.alpha, alpha, 'alpha frozen while paused');
  loop.setPace(false, 1);
  assert.equal(loop.advance(16), 0, 'no catch-up after a long pause');
  assert.equal(ticks, 1);
});

test('loop: a speed change gives no burst of catch-up ticks', () => {
  const loop = new FixedTickLoop(() => {}, { ticksPerSecond: 10 });
  loop.advance(90);
  loop.setPace(false, 8);
  // 16 ms at 8× is 128 ms of sim time: at most two ticks from the 90 ms carried over.
  assert.ok(loop.advance(16) <= 2);
  loop.setPace(false, 1);
  assert.ok(loop.advance(16) <= 1);
  assert.ok(loop.alpha >= 0 && loop.alpha < 1);
});

test('determinism: the same actions at the same ticks give the same world at 1× and 8×', () => {
  const schedule = new Map<number, Intent>([
    [3, { kind: 'step', dx: 1, dy: 0 }],
    [20, { kind: 'step', dx: 0, dy: 1 }],
    [45, { kind: 'step', dx: -1, dy: 0 }],
    [90, { kind: 'step', dx: 0, dy: -1 }],
  ]);
  const END = 400;
  const play = (speed: number) => {
    const w = World.create(DEF, 7);
    const loop = new FixedTickLoop(
      () => {
        if (w.tick >= END) return;
        const i = schedule.get(w.tick);
        if (i) w.queueIntent(i);
        w.step();
      },
      { ticksPerSecond: DEF.ticksPerSecond },
    );
    loop.setPace(false, speed);
    let frames = 0;
    while (w.tick < END) {
      loop.advance(16);
      frames++;
    }
    return { hash: w.hash(), frames };
  };
  const a = play(1);
  const b = play(8);
  assert.equal(a.hash, b.hash);
  assert.ok(b.frames < a.frames / 4, '8× took fewer frames');
});

// ── Terminal ────────────────────────────────────────────────────────────────

test('terminal: p pauses, + / = / - change speed, the help tag shows PAUSED or the speed', () => {
  const w = World.create(DEF, 1);
  const pace = new Pace();
  const keys: KeyState = { dropPending: false, actions: null, crafting: null, pace };
  assert.equal(paceStatus(pace, w), '');
  assert.equal(handleKey(w, '+', keys), 'pace');
  assert.equal(pace.speed, 2);
  assert.equal(paceStatus(pace, w), '2×');
  handleKey(w, '=', keys);
  assert.equal(pace.speed, 4);
  handleKey(w, '-', keys);
  assert.equal(pace.speed, 2);
  assert.equal(handleKey(w, 'p', keys), 'pace');
  assert.equal(pace.paused, true);
  assert.equal(paceStatus(pace, w), 'PAUSED');
  assert.equal(w.player.intent, null, 'pace keys never move');
  handleKey(w, 'd', keys);
  assert.equal(w.player.intent, null, 'movement keys do nothing while paused');
  handleKey(w, 'p', keys);
  assert.equal(pace.paused, false);
  handleKey(w, 'w', keys);
  assert.deepEqual(w.player.intent, { kind: 'step', dx: 0, dy: -1 });
});

test('terminal: without a pace, p and the speed keys do nothing', () => {
  const w = World.create(DEF, 1);
  const keys: KeyState = { dropPending: false, actions: null, crafting: null };
  assert.equal(handleKey(w, 'p', keys), undefined);
  assert.equal(w.player.intent, null);
});
