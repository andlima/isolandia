import assert from 'node:assert/strict';
import { test } from 'node:test';
import { edgeKey, formatError, loadPacks, loadPacksOrThrow, Pathfinder, World, type Definition, type LoadError } from '../src/core/index.ts';
import { lineOfSight } from '../src/core/sim/sight.ts';
import { convertCells, growRoom } from '../scripts/map-edges.ts';
import { assertRoundTrip, fixture } from './helpers.ts';

// Edge walls (docs/packs.md#edge-walls) on a small fixture: storage, steps,
// paths, regions, sight, reach, edge actions, saves, both map formats and
// the converter.

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true }
  - { id: door, label: Door, glyph: "+", color: brown, walkable: true, edge: true }
  - { id: window, label: Window, glyph: '"', color: cyan, walkable: false, opaque: false, edge: true }
  - { id: boarded, label: Boarded window, glyph: H, color: brown, walkable: false, edge: true }
  - { id: fridge, label: Fridge, glyph: F, color: white, walkable: false, container: { capacity: 10 } }
`;

// 5×4 cells. A thin wall runs down between columns 1 and 2 (the `w` edges of
// x = 2): a window at row 0, wall at rows 1 and 3, a door at row 2. A fridge
// stands at (3, 1).
const MAP = `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "@": { tile: floor, player: true }
      "F": { tile: fridge }
      "-": { tile: wall }
      "|": { tile: wall }
      "D": { tile: door }
      "W": { tile: window }
    edges: true
    rows:
      - "+-+-+-+-+-+"
      - "|. .W. . .|"
      - "+ + + + + +"
      - "|@ .|. F .|"
      - "+ + + + + +"
      - "|. .D. . .|"
      - "+ + + + + +"
      - "|. .|. . .|"
      - "+-+-+-+-+-+"
start:
  map: room
  player: hero
`;

const ACTIONS = `actions:
  - id: board
    label: Board up
    target: { tiles: [window] }
    effects:
      - { type: set_tile, tile: boarded }
`;

function def(files: Record<string, string> = {}): Definition {
  return loadPacksOrThrow([fixture({ 'tiles.yaml': TILES, 'map.yaml': MAP, 'actions.yaml': ACTIONS, ...files })]);
}

function errorsOf(files: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture({ 'tiles.yaml': TILES, ...files })]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], message: RegExp): void {
  assert.ok(
    errors.some((e) => message.test(e.message)),
    `no error ${message}\ngot:\n${errors.map(formatError).join('\n')}`,
  );
}

const tileIndex = (d: Definition, id: string) => d.ids.tiles[id]!;

test('edges: storage, edgeAt, and setEdge recording changes against the map', () => {
  const d = def();
  const g = World.create(d, 1).grid;
  assert.equal(g.edgeAt(2, 0, 0, 'w')?.id, 't:window');
  assert.equal(g.edgeAt(2, 1, 0, 'w')?.id, 't:wall');
  assert.equal(g.edgeAt(2, 2, 0, 'w')?.id, 't:door');
  assert.equal(g.edgeAt(1, 1, 0, 'w'), undefined);
  assert.equal(g.edgeAt(1, 1, 0, 'n'), undefined);
  // Only edge tiles are on edges: the cells hold floor and the fridge.
  assert.equal(g.tileAt(2, 1)?.id, 't:floor');

  const i = g.index(2, 1, 0);
  const v = g.version;
  g.setEdge(i, 'w', tileIndex(d, 't:door'));
  assert.equal(g.version, v + 1);
  assert.equal(g.edgeAt(2, 1, 0, 'w')?.id, 't:door');
  assert.equal(g.changedEdges.get(edgeKey(i, 'w')), tileIndex(d, 't:door'));
  assert.ok(g.canStep(1, 1, 1, 0), 'the new door is crossable at once');
  g.setEdge(i, 'w', tileIndex(d, 't:wall'));
  assert.equal(g.changedEdges.size, 0, 'back to the map: no change recorded');
  assert.ok(!g.canStep(1, 1, 1, 0));
});

test('edges: steps cross walkable edges only; a diagonal needs both L routes clear', () => {
  const g = World.create(def(), 1).grid;
  assert.ok(!g.canStep(1, 1, 1, 0), 'wall');
  assert.ok(!g.canStep(2, 1, -1, 0), 'wall, from the other side');
  assert.ok(!g.canStep(1, 0, 1, 0), 'window');
  assert.ok(g.canStep(1, 2, 1, 0), 'door');
  assert.ok(g.canStep(2, 2, -1, 0), 'door, from the other side');
  assert.ok(g.canStep(1, 1, 0, 1), 'no edge');
  // (1, 1) → (2, 2): x first crosses the wall, y first the door: blocked.
  assert.ok(!g.canStep(1, 1, 1, 1));
  assert.ok(!g.canStep(2, 2, -1, -1));
  // (1, 2) → (2, 3): x first through the door, y first through the wall at row 3: blocked.
  assert.ok(!g.canStep(1, 2, 1, 1));
  // Open ground.
  assert.ok(g.canStep(3, 2, 1, 1));
});

test('edges: A* and region labels go round a thin wall through its door', () => {
  const d = def();
  const g = World.create(d, 1).grid;
  const pf = new Pathfinder(g);
  const path = pf.findPath(1, 1, 2, 1)!;
  assert.ok(path, 'reachable through the door');
  const cells = [g.index(1, 1), ...path].map((i) => g.cellOf(i));
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1]!;
    const b = cells[k]!;
    assert.ok(g.canStep(a.x, a.y, b.x - a.x, b.y - a.y), `step ${k}`);
  }
  assert.ok(cells.some((c) => c.x === 2 && c.y === 2), 'it goes through the doorway');
  assert.ok(path.length > 1, 'not straight through the wall');
  const regions = g.regions();
  assert.equal(regions[g.index(0, 0)], regions[g.index(4, 3)]);

  // Wall the door up: two regions, and no path.
  g.setEdge(g.index(2, 2), 'w', tileIndex(d, 't:wall'));
  const split = g.regions();
  assert.notEqual(split[g.index(1, 1)], split[g.index(2, 1)]);
  assert.equal(split[g.index(0, 0)], split[g.index(1, 3)]);
  assert.equal(split[g.index(2, 0)], split[g.index(4, 3)]);
  assert.equal(new Pathfinder(g).findPath(1, 1, 2, 1), null);
});

test('edges: sight is blocked by a wall edge, not by a window or a door; symmetric, diagonals by both L routes', () => {
  const d = def();
  const g = World.create(d, 1).grid;
  const sees = (ax: number, ay: number, bx: number, by: number) => {
    const ab = lineOfSight(g, ax, ay, bx, by);
    assert.equal(lineOfSight(g, bx, by, ax, ay), ab, `symmetric (${ax}, ${ay}) ↔ (${bx}, ${by})`);
    return ab;
  };
  assert.ok(!sees(1, 1, 2, 1), 'adjacent across a wall');
  assert.ok(sees(1, 0, 2, 0), 'across a window');
  assert.ok(sees(1, 2, 2, 2), 'across an open door');
  assert.ok(!sees(0, 1, 4, 1), 'along a row through the wall');
  assert.ok(sees(0, 0, 4, 0), 'along the window row');
  // (1, 1) → (2, 0): x first is the wall, y first goes up and through the window: seen.
  assert.ok(sees(1, 1, 2, 0));
  // Board the window: both L routes are blocked.
  g.setEdge(g.index(2, 0), 'w', tileIndex(d, 't:boarded'));
  assert.ok(!sees(1, 1, 2, 0));
  assert.ok(!sees(1, 0, 2, 0));
});

test('edges: reach does not cross a non-walkable edge; across a door it does', () => {
  const g = World.create(def(), 1).grid;
  assert.ok(!g.reaches(1, 1, 0, 2, 1, 0), 'through a wall');
  assert.ok(!g.reaches(1, 0, 0, 2, 0, 0), 'through a window');
  assert.ok(g.reaches(1, 2, 0, 2, 2, 0), 'through a door');
  assert.ok(!g.reaches(1, 2, 0, 2, 1, 0), 'diagonal past the wall');
  assert.ok(g.reaches(2, 1, 0, 3, 1, 0), 'the fridge from beside it (its own tile does not matter)');
  // An edge is in reach from either cell it separates, orthogonally only.
  assert.ok(g.reachesEdge(1, 0, 0, 2, 0, 0, 'w'));
  assert.ok(g.reachesEdge(2, 0, 0, 2, 0, 0, 'w'));
  assert.ok(!g.reachesEdge(1, 1, 0, 2, 0, 0, 'w'));
});

test('edges: a fridge behind a thin wall is out of reach; walk round and it is in reach', () => {
  const d = def();
  const w = World.create(d, 1);
  // Wall off the fridge's west side: the player beside it at (2, 1) cannot reach it.
  w.grid.setEdge(w.grid.index(3, 1), 'w', tileIndex(d, 't:wall'));
  w.queueIntent({ kind: 'goto', x: 2, y: 1, z: 0 });
  for (let i = 0; i < 200 && !(w.player.x === 2 && w.player.y === 1); i++) w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
  assert.deepEqual(w.reachableContainers(), []);
  w.queueIntent({ kind: 'goto', x: 3, y: 2, z: 0 });
  for (let i = 0; i < 200 && !(w.player.x === 3 && w.player.y === 2); i++) w.step();
  assert.equal(w.reachableContainers().length, 1);
});

test('edges: boarding a window edge works from both sides; out of reach otherwise; changed edges round-trip', () => {
  const d = def();
  const w = World.create(d, 1);
  const edge = () => w.grid.edgeAt(2, 0, 0, 'w')?.id;
  const walkTo = (x: number, y: number) => {
    w.queueIntent({ kind: 'goto', x, y, z: 0 });
    for (let i = 0; i < 200 && !(w.player.x === x && w.player.y === y); i++) w.step();
    assert.deepEqual([w.player.x, w.player.y], [x, y]);
  };
  const board = () => {
    w.queueAction({ kind: 'act', action: 't:board', x: 2, y: 0, z: 0, side: 'w' });
    w.step();
    return w.lastAction!;
  };
  // From (1, 1) the window is not on a side of the player's cell.
  const far = board();
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'out_of_reach');
  // From the west side.
  walkTo(1, 0);
  assert.equal(board().ok, true);
  assert.equal(edge(), 't:boarded');
  assert.deepEqual(w.snapshot().edges, [[2, 0, 0, 'w', 't:boarded']]);
  assertRoundTrip(w, () => {}, 5);
  // From the east side, after putting the glass back.
  w.grid.setEdge(w.grid.index(2, 0), 'w', tileIndex(d, 't:window'));
  assert.deepEqual(w.snapshot().edges, []);
  walkTo(2, 0);
  assert.equal(board().ok, true);
  assert.equal(edge(), 't:boarded');
});

test('edges: ASCII notation errors point at the row and column', () => {
  const map = (rows: string[], extra = '') => ({
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "@": { tile: floor, player: true }
      "#": { tile: wall }
      "o": { tile: floor, spawn: rock }
${extra}    rows:
${rows.map((r) => `      - "${r}"`).join('\n')}
start:
  map: room
  player: hero
`,
  });
  // An edge tile in a cell, without the notation: the hint names the converter.
  expectError(errorsOf(map(['###', '#@#', '###'])), /edge tile.*'edges: true'.*npm run map:edges/);
  // With the notation: an edge tile at a cell position, a cell tile at an edge position, a spawn on an edge.
  expectError(errorsOf(map(['+#+#+', '#@ ##', '+#+#+'], '    edges: true\n')), /row 1, column 3: cell \(1, 0\).*an edge tile/);
  expectError(errorsOf(map(['+#+#+', '#@..#', '+#+#+'], '    edges: true\n')), /the west edge of cell \(1, 0\).*not an edge tile/);
  expectError(errorsOf(map(['+#+#+', '#@o.#', '+#+#+'], '    edges: true\n')), /only cell positions .* take them/);
  // The shape: 2·h + 1 rows of 2·w + 1 characters.
  expectError(errorsOf(map(['+#+#', '#@ .', '+#+#'], '    edges: true\n')), /odd number of rows and of columns/);
});

test('edges: Tiled edge layers hold edge tiles only, ordinary layers cell tiles only', () => {
  const prop = (name: string, value: string) => ({ name, type: 'string', value });
  const tmj = (layers: unknown[]) =>
    JSON.stringify({
      orientation: 'orthogonal',
      infinite: false,
      width: 3,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      tilesets: [
        {
          firstgid: 1,
          name: 'ts',
          tilecount: 3,
          tiles: [
            { id: 0, properties: [prop('tile', 'floor')] },
            { id: 1, properties: [prop('tile', 'wall')] },
            { id: 2, properties: [prop('tile', 'door')] },
          ],
        },
      ],
      layers: [...layers, { type: 'objectgroup', name: 'objects', visible: true, objects: [{ id: 1, type: 'player', x: 8, y: 8, rotation: 0 }] }],
    });
  const layer = (name: string, data: number[], edge?: string) => ({
    type: 'tilelayer',
    name,
    width: 3,
    height: 2,
    visible: true,
    data,
    ...(edge ? { properties: [prop('edge', edge)] } : {}),
  });
  const files = (layers: unknown[]) => ({
    'map.yaml': 'maps:\n  - id: room\n    tiled: maps/room.tmj\nstart:\n  map: room\n  player: hero\n',
    'maps/room.tmj': tmj(layers),
  });
  const ground = layer('ground', [1, 1, 1, 1, 1, 1]);
  const r = loadPacks([fixture({ 'tiles.yaml': TILES, ...files([ground, layer('edges n', [0, 0, 0, 2, 3, 0], 'n'), layer('edges w', [0, 2, 0, 0, 0, 0], 'w')]) })]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const m = r.definition.maps[r.definition.start.map]!;
  const id = (t: number) => (t === 0xffff ? null : r.definition.tiles[t]!.id);
  assert.deepEqual(m.edgeN.map(id), [null, null, null, 't:wall', 't:door', null]);
  assert.deepEqual(m.edgeW.map(id), [null, 't:wall', null, null, null, null]);
  // Two layers of a side merge, top-most wins.
  const merged = loadPacksOrThrow([fixture({ 'tiles.yaml': TILES, ...files([ground, layer('a', [0, 0, 0, 2, 2, 0], 'n'), layer('b', [0, 0, 0, 0, 3, 0], 'n')]) })]);
  assert.deepEqual(merged.maps[merged.start.map]!.edgeN.map((t) => (t === 0xffff ? null : merged.tiles[t]!.id)), [null, null, null, 't:wall', 't:door', null]);

  expectError(errorsOf(files([layer('ground', [1, 2, 1, 1, 1, 1])])), /holds edge tile 'wall'.*'edge' = 'n' or 'w'/);
  expectError(errorsOf(files([ground, layer('edges n', [1, 0, 0, 0, 0, 0], 'n')])), /edge layer \('edge: n'\) but holds tile 'floor'/);
  expectError(errorsOf(files([ground, layer('edges', [0, 0, 0, 0, 0, 0], 'x')])), /'edge' must be 'n' \(north edges\) or 'w'/);
});

test('edges: the converter on a corner, a T-junction, a door, a window run, a pillar, and room growth', () => {
  // `#` wall, `+` door, `W` window, `.` floor.
  const rows = [
    '######.', //
    '#..#...',
    '#..+...',
    '#WW##.#',
    '.......',
  ];
  const width = rows[0]!.length;
  const height = rows.length;
  const cells = rows.join('').split('');
  const c = convertCells({ width, height, floors: 1, cells }, { wallLike: (t) => '#+W'.includes(t), plain: (t) => t === '.' });
  const at = (a: readonly (string | null)[], x: number, y: number) => a[y * width + x];
  // Corner (0, 0): the top run's `n` edges and the west run's `w` edges meet there.
  assert.equal(at(c.edgeN, 0, 0), '#');
  assert.equal(at(c.edgeW, 0, 0), '#');
  for (let x = 0; x < 5; x++) assert.equal(at(c.edgeN, x, 0), '#', `top wall at ${x}`);
  assert.equal(at(c.edgeN, 5, 0), null, 'the run ends at (5, 0)');
  // T-junction at (3, 0): the top run goes on, and a wall runs down from it.
  assert.equal(at(c.edgeW, 3, 0), '#');
  assert.equal(at(c.edgeW, 3, 1), '#');
  // Exactly one door edge for the door cell.
  assert.equal(at(c.edgeW, 3, 2), '+');
  assert.equal(c.edgeN.filter((t) => t === '+').length + c.edgeW.filter((t) => t === '+').length, 1);
  // A run of two windows gives two window edges.
  assert.deepEqual([at(c.edgeN, 1, 3), at(c.edgeN, 2, 3)], ['W', 'W']);
  assert.equal(c.edgeN.filter((t) => t === 'W').length + c.edgeW.filter((t) => t === 'W').length, 2);
  // The isolated pillar is reported, not guessed.
  assert.deepEqual(
    c.reports.map((r) => [r.x, r.y]),
    [[6, 3]],
  );
  assert.match(c.reports[0]!.message, /isolated/);
  // Former wall cells become ground: the door cell takes its east neighbour (its south one is a wall).
  assert.equal(at(c.cells, 3, 2), '.');
  assert.ok(c.cells.every((t) => t === '.'));
  // The room [1, 1, 2, 2] grows north and west into the former wall cells.
  assert.deepEqual(growRoom({ x: 1, y: 1, w: 2, h: 2, z: 0 }, c.wall, width, height), { x: 0, y: 0, w: 3, h: 3 });
  // East of the T: open ground at (6, 0) stops it growing north; the wall and door column to its west joins it.
  assert.deepEqual(growRoom({ x: 4, y: 1, w: 3, h: 2, z: 0 }, c.wall, width, height), { x: 3, y: 1, w: 4, h: 2 });
});
