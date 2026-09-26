import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameToText, renderAscii } from '../src/ascii/render.ts';
import { colorize } from '../src/ascii/terminal.ts';
import { World } from '../src/core/index.ts';
import { loadFixture } from './helpers.ts';

test('renderAscii: snapshot of a small fixture map', () => {
  const w = World.create(loadFixture(), 1);
  for (let i = 0; i < 25; i++) w.step();
  const frame = renderAscii(w, { width: 7, height: 5 });
  assert.equal(
    frameToText(frame),
    [
      '       ', //
      ' ##### ',
      ' #.@o# ',
      ' #...# ',
      ' ##### ',
      '',
      'Time: 00:00:02 (tick 25)',
      'HP: 10.0/10.0',
      'Food: 47.5/100.0',
    ].join('\n'),
  );
  assert.equal(frame.colors[2]![3], 'yellow');
  assert.equal(frame.colors[2]![4], 'gray');
  assert.equal(frame.colors[0]![0], null);
});

test('renderAscii: centers on the player and clips to the viewport', () => {
  const w = World.create(loadFixture(), 1);
  w.queueIntent({ kind: 'step', dx: -1, dy: 1 });
  w.step();
  const frame = renderAscii(w, { width: 3, height: 3 });
  assert.deepEqual(frame.lines, ['#..', '#@.', '###']);
});

test('renderAscii: pure, no ANSI codes; the shell adds color', () => {
  const w = World.create(loadFixture(), 1);
  const before = w.hash();
  const a = renderAscii(w, { width: 9, height: 6 });
  const b = renderAscii(w, { width: 9, height: 6 });
  assert.deepEqual(a, b);
  assert.equal(w.hash(), before);
  assert.ok(!frameToText(a).includes('\x1b'));
  assert.ok(colorize(a).includes('\x1b['));
});
