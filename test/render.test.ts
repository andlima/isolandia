import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameToText, renderAscii } from '../src/ascii/render.ts';
import { colorize } from '../src/ascii/terminal.ts';
import { World } from '../src/core/index.ts';
import { loadFixture } from './helpers.ts';

test('renderAscii: snapshot of a small fixture map (double resolution: cells at odd lines and columns)', () => {
  const w = World.create(loadFixture(), 1);
  for (let i = 0; i < 25; i++) w.step();
  const frame = renderAscii(w, { width: 7, height: 5 });
  assert.equal(
    frameToText(frame),
    [
      '               ', //
      '               ',
      '               ',
      '   # # # # #   ',
      '               ',
      '   # . @ o #   ',
      '               ',
      '   # . . . #   ',
      '               ',
      '   # # # # #   ',
      '               ',
      '',
      'Time: Day 1 08:02 (tick 25)',
      'HP: 10.0/10.0',
      'Food: 47.5/100.0',
    ].join('\n'),
  );
  assert.equal(frame.colors[5]![7], 'yellow');
  assert.equal(frame.colors[5]![9], 'gray');
  assert.equal(frame.colors[0]![0], null);
});

test('renderAscii: centers on the player and clips to the viewport', () => {
  const w = World.create(loadFixture(), 1);
  w.queueIntent({ kind: 'step', dx: -1, dy: 1 });
  w.step();
  const frame = renderAscii(w, { width: 3, height: 3 });
  assert.deepEqual(frame.lines, ['       ', ' # . . ', '       ', ' # @ . ', '       ', ' # # # ', '       ']);
});

test('renderAscii: edges between the cells, vertices from an adjacent edge, the shape 2w + 1 by 2h + 1', () => {
  const def = loadFixture({
    'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true }
  - { id: door, label: Door, glyph: "+", color: brown, walkable: true, edge: true }
`,
    // A 4×3 map: a 3×2 room with walls on the edges, a door in the wall across it, the outside column x = 3 and row
    // y = 2 (the map's south and east borders need no edges). Vertices (even row and column) are ignored: '*'.
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "+": { tile: door }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
    edges: true
    rows:
      - "*#*#*#*  "
      - "#. . .#. "
      - "*#*+* *  "
      - "#. o @#. "
      - "*#*#*#*  "
      - " . . . . "
      - "*********"
start:
  map: room
  player: hero
`,
  });
  const w = World.create(def, 1);
  const frame = renderAscii(w, { width: 4, height: 3 });
  assert.equal(frame.lines.length, 7);
  assert.ok(frame.lines.every((l) => l.length === 9));
  assert.deepEqual(frame.lines, ['#######  ', '#. . .#. ', '###++ #  ', '#. o @#. ', '#######  ', ' . . . . ', '         ']);
  // The door edge and its colour; a vertex shows a wall next to it before the door, the door when alone.
  assert.equal(frame.colors[2]![3], 'brown');
  assert.equal(frame.colors[2]![2], 'gray');
  assert.equal(frame.colors[2]![4], 'brown');
  // No edge: a space without colour.
  assert.equal(frame.lines[2]![5], ' ');
  assert.equal(frame.colors[2]![5], null);
  // The player at (2, 1): line 3, column 5.
  assert.equal(frame.colors[3]![5], 'yellow');
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
