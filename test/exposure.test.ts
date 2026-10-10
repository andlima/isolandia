import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exposureRows, formatExposure } from '../src/cli/exposure.ts';
import { computeExposure, EMPTY_TILE, formatError, isDayAt, loadPacks, loadPacksOrThrow, World, type Definition, type Entity, type LoadError, type MapDef, type PackSource } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, GAMES, genreCell } from './helpers.ts';

// Tile exposure (specs/tile-exposure.md, docs/packs.md#exposure): the derived
// "open to the sky" per cell, its two tile overrides, `tile.exposed`,
// `check --exposure`, and the converted vampire, garden and town packs.

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: table, label: Table, glyph: T, color: brown, walkable: false }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true }
  - { id: door, label: Door, glyph: D, color: brown, walkable: true, edge: true }
  - { id: window, label: Window, glyph: W, color: cyan, walkable: false, opaque: false, edge: true }
  - { id: fence, label: Fence, glyph: f, color: white, walkable: false, opaque: false, edge: true, encloses: false }
  - { id: beam, label: Sunbeam, glyph: "'", color: yellow, walkable: true, exposed: true }
  - { id: awning, label: Awning, glyph: a, color: gray, walkable: true, exposed: false }
`;

const LEGEND = `    legend:
      ".": { tile: floor }
      "@": { tile: floor, player: true }
      "T": { tile: table }
      "#": { tile: wall }
      "D": { tile: door }
      "W": { tile: window }
      "f": { tile: fence }
      "'": { tile: beam }
      "a": { tile: awning }
`;

// 6×5 cells (`edges: true`, double resolution): a 2×3 room at x 1–2, y 1–3,
// walled all round with a door on its east side at (2, 2); open floor around
// it; the player at (0, 0). Vertices (`+`) are ignored.
const ROOM = [
  '+ + + + + + +',
  ' @ . . . . . ',
  '+ +#+#+ + + +',
  ' .#. .#. . . ',
  '+ + + + + + +',
  ' .#. .D. . . ',
  '+ + + + + + +',
  ' .#. .#. . . ',
  '+ +#+#+ + + +',
  ' . . . . . . ',
  '+ + + + + + +',
];
const INSIDE: [number, number][] = [[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]];

/** `ROOM` with row `r` replaced. */
const withRow = (rows: readonly string[], r: number, row: string): string[] => rows.map((x, i) => (i === r ? row : x));

/** One ASCII map entry; `floors` lists each floor's rows. */
function mapEntry(id: string, floors: readonly (readonly string[])[], extra = ''): string {
  const rows = (list: readonly string[], indent: string) => list.map((r) => `${indent}- ${JSON.stringify(r)}`).join('\n');
  const body = floors.length === 1 ? `    rows:\n${rows(floors[0]!, '      ')}` : `    floors:\n${floors.map((f) => `      - rows:\n${rows(f, '          ')}`).join('\n')}`;
  return `  - id: ${id}\n${LEGEND}    edges: true\n${body}\n${extra}`;
}

function files(maps: string, start = 'room', extra: Record<string, string> = {}): Record<string, string> {
  return { 'tiles.yaml': TILES, 'map.yaml': `maps:\n${maps}start:\n  map: ${start}\n  player: hero\n`, ...extra };
}

const def = (floors: readonly (readonly string[])[], extra: Record<string, string> = {}): Definition => loadPacksOrThrow([fixture(files(mapEntry('room', floors), 'room', extra))]);
const mapOf = (d: Definition, id = 't:room'): MapDef => d.maps.find((m) => m.id === id)!;
const at = (m: MapDef, x: number, y: number, z = 0): number => m.exposed[(z * m.height + y) * m.width + x]!;

/** The exposure of a one-floor map as rows of `.`/`#`/space. */
const picture = (m: MapDef): string[] => exposureRows(m).filter((l) => !l.startsWith('floor '));

function errorsOf(sources: PackSource[]): readonly LoadError[] {
  const r = loadPacks(sources);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], message: RegExp): void {
  assert.ok(
    errors.some((e) => message.test(e.message)),
    `no error ${message}\ngot:\n${errors.map(formatError).join('\n')}`,
  );
}

function place(e: Entity, x: number, y: number, z = e.z): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
  e.z = e.fromZ = z;
}

// ── The rule ────────────────────────────────────────────────────────────────

test('exposure: a walled room with a door is enclosed; everything around it is exposed', () => {
  const m = mapOf(def([ROOM]));
  assert.deepEqual(picture(m), ['......', '.##...', '.##...', '.##...', '......']);
  for (const [x, y] of INSIDE) assert.equal(at(m, x, y), 0, `(${x}, ${y})`);
  assert.equal(at(m, 3, 2), 1, 'outside the door');
  assert.equal(m.exposed.length, m.cells.length);
});

test('exposure: a room with one wall missing is open', () => {
  const m = mapOf(def([withRow(ROOM, 8, '+ + + + + + +')]));
  assert.deepEqual(picture(m), ['......', '......', '......', '......', '......']);
});

test('exposure: an area touching the map border is open, however sealed', () => {
  // The 2×2 block at x 0–1, y 0–1 is walled off from the rest, but lies on the border.
  const rows = ['+ + + + +', ' @ . . . ', '+ + + + +', ' . .#. . ', '+#+#+ + +', ' . . . . ', '+ + + + +'];
  const m = mapOf(def([withRow(rows, 1, ' @ .#. . ')]));
  assert.deepEqual(picture(m), ['....', '....', '....']);
});

test('exposure: a fence (encloses: false) encloses nothing; a window (opaque: false) does', () => {
  const fenced = mapOf(def([ROOM.map((r) => r.replace(/#/g, 'f').replace('D', 'f'))]));
  assert.deepEqual(picture(fenced), ['......', '......', '......', '......', '......']);
  const windowed = mapOf(def([withRow(ROOM, 5, ' .#. .W. . . ')]));
  assert.deepEqual(picture(windowed), ['......', '.##...', '.##...', '.##...', '......']);
});

test('exposure: furniture inside a room is inside the room', () => {
  const d = def([withRow(ROOM, 5, ' .#T .D. . . ')]);
  const m = mapOf(d);
  assert.equal(d.tiles[m.cells[2 * m.width + 1]!]!.id, 't:table', 'a table at (1, 2)');
  assert.deepEqual(picture(m), ['......', '.##...', '.##...', '.##...', '......']);
});

test('exposure: an upper-floor room among empty cells is enclosed, the cells under it and under a balcony are covered, empty cells are never exposed', () => {
  const GROUND = ['+ + + + + + +', ' @ . . . . . ', '+ + + + + + +', ' . . . . . . ', '+ + + + + + +', ' . . . . . . ', '+ + + + + + +', ' . . . . . . ', '+ + + + + + +', ' . . . . . . ', '+ + + + + + +'];
  // The room's walls on floor 1, its interior, and a lone balcony cell at (4, 1); everything else empty.
  const UPPER = ['+ + + + + + +', '             ', '+ +#+#+ + + +', '  #. .#  .   ', '+ + + + + + +', '  #. .#      ', '+ + + + + + +', '  #. .#      ', '+ +#+#+ + + +', '             ', '+ + + + + + +'];
  const m = mapOf(def([GROUND, UPPER]));
  assert.equal(m.floors, 2);
  assert.deepEqual(exposureRows(m), [
    'floor 0',
    '......',
    '.##.#.',
    '.##...',
    '.##...',
    '......',
    'floor 1',
    '      ',
    ' ## . ',
    ' ##   ',
    ' ##   ',
    '      ',
  ]);
  for (const [x, y] of INSIDE) {
    assert.equal(at(m, x, y, 1), 0, `floor 1 (${x}, ${y}) enclosed`);
    assert.equal(at(m, x, y, 0), 0, `floor 0 (${x}, ${y}) covered`);
  }
  assert.equal(at(m, 4, 1, 1), 1, 'the balcony is open');
  assert.equal(at(m, 4, 1, 0), 0, 'under the balcony is covered');
  assert.equal(m.cells[m.width * m.height], EMPTY_TILE);
  assert.equal(at(m, 0, 0, 1), 0, 'an empty cell');
});

test('exposure: `exposed: true` / `false` on a tile win over the rule', () => {
  const m = mapOf(def([withRow(withRow(ROOM, 3, " .#' .#. . . "), 9, ' . a . . . . ')]));
  assert.deepEqual(picture(m), ['......', '..#...', '.##...', '.##...', '.#....']);
  assert.equal(at(m, 1, 1), 1, 'a sunbeam inside the room');
  assert.equal(at(m, 1, 4), 0, 'an awning outside');
});

test('exposure: a composite is judged on the composed map', () => {
  // A 3×3 part: a 2×2 walled interior whose cells touch the part's own border.
  const CABIN = ['+#+#+ +', '#. .#. ', '+ + + +', '#. .#. ', '+#+#+ +', ' . . . ', '+ + + +'];
  const yard = `  - id: yard
    size: [5, 5]
    fill: floor
    player: [0, 0]
    parts:
      - { map: cabin, at: [1, 1] }
`;
  const d = loadPacksOrThrow([fixture(files(mapEntry('cabin', [CABIN]) + yard, 'yard'))]);
  assert.deepEqual(picture(mapOf(d, 't:cabin')), ['...', '...', '...'], 'alone, the interior is on the border: open');
  assert.deepEqual(picture(mapOf(d, 't:yard')), ['.....', '.##..', '.##..', '.....', '.....'], 'placed inside the yard: enclosed');
});

test('exposure: computeExposure is pure over the map arrays (unresolved tiles count as plain cells and walls)', () => {
  const d = def([ROOM]);
  const m = mapOf(d);
  const again = computeExposure(m, d.tiles);
  assert.deepEqual([...again], [...m.exposed]);
  const unknown = computeExposure({ ...m, cells: m.cells.map((t) => (t === EMPTY_TILE ? t : 9999)) }, d.tiles);
  assert.deepEqual([...unknown], [...m.exposed]);
});

// ── Loader ──────────────────────────────────────────────────────────────────

const PLAIN_MAP = `maps:
  - id: room
    legend:
      "@": { tile: floor, player: true }
      ".": { tile: floor }
    rows: ["@."]
start:
  map: room
  player: hero
`;

test('exposure: loader errors — `encloses` on a cell tile, `exposed` on an edge tile, non-boolean values', () => {
  const tiles = (extra: string) => fixture({ 'map.yaml': PLAIN_MAP, 'tiles.yaml': `tiles:\n  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }\n${extra}` });
  expectError(errorsOf([tiles(`  - { id: rug, label: Rug, glyph: r, color: red, walkable: true, encloses: false }\n`)]), /'encloses' is only allowed on an edge tile/);
  expectError(errorsOf([tiles(`  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true, exposed: true }\n`)]), /an edge tile \('edge: true'\) cannot take 'exposed'/);
  expectError(errorsOf([tiles(`  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true, encloses: 1 }\n`)]), /field 'encloses' must be a boolean/);
  expectError(errorsOf([tiles(`  - { id: rug, label: Rug, glyph: r, color: red, walkable: true, exposed: "yes" }\n`)]), /field 'exposed' must be a boolean/);
  // Defaults: an edge encloses, a cell tile is derived.
  const d = def([ROOM]);
  const tile = (id: string) => d.tiles[d.ids.tiles[`t:${id}`]!]!;
  assert.deepEqual([tile('wall').encloses, tile('wall').exposed, tile('fence').encloses, tile('floor').encloses, tile('floor').exposed, tile('beam').exposed, tile('awning').exposed], [true, null, false, true, null, true, false]);
});

test('exposure: overrides set and clear `encloses` and `exposed`; the rule runs on the final stack', () => {
  const base = fixture(files(mapEntry('room', [withRow(ROOM, 3, " .#' .#. . . ")])));
  const mod = (yaml: string): PackSource => ({ label: 'm', files: { 'pack.yaml': 'namespace: m\nname: m\nversion: 1.0.0\ndepends: [t]\n', 'mod.yaml': yaml } });
  const load = (yaml: string): MapDef => {
    const r = loadPacks([base, mod(yaml)]);
    assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
    return mapOf(r.definition);
  };
  assert.deepEqual(picture(load('tiles:\n  - { id: t:wall, override: true, encloses: false }\n')), ['......', '......', '......', '......', '......'], 'walls stop enclosing');
  assert.deepEqual(picture(load('tiles:\n  - { id: t:floor, override: true, exposed: false }\n')), ['######', '#.####', '######', '######', '######'], 'every floor cell forced covered; the sunbeam still forced open');
  assert.deepEqual(picture(load('tiles:\n  - { id: t:beam, override: true, exposed: null }\n')), ['......', '.##...', '.##...', '.##...', '......'], 'the sunbeam back to derived: enclosed');
  assert.deepEqual(picture(load('tiles:\n  - { id: t:fence, override: true, encloses: null }\n  - { id: t:door, override: true, edge: true, encloses: false }\n')), ['......', '......', '......', '......', '......'], 'the door stops enclosing');
  const r = loadPacks([base, mod('tiles:\n  - { id: t:floor, override: true, encloses: false }\n')]);
  assert.equal(r.ok, false);
  if (!r.ok) expectError(r.errors, /'encloses' is only allowed on an edge tile/);
});

// ── Expressions ─────────────────────────────────────────────────────────────

const RULES = {
  'rules.yaml': `statuses:
  - id: lit
    label: Lit
    when: 'tile.exposed'
    until: 'not tile.exposed'
systems:
  - id: burn
    every: 0.1
    when: 'exposed(tile)'
    effects:
      - { type: apply, measurement: hp, delta: -1 }
actions:
  - id: bask
    label: Bask
    target: { tiles: [floor] }
    when: 'tile.exposed'
    effects:
      - { type: apply, measurement: food, delta: 1 }
`,
};

test('exposure: `tile.exposed` in a status, `exposed(tile)` in a system, and the target cell of a tile action; false on an empty cell', () => {
  const d = def([ROOM], RULES);
  const w = World.create(d, 1);
  const lit = d.ids.statuses['t:lit']!;
  const hp = d.ids.measurements['t:hp']!;
  // At (0, 0), in the open.
  w.step();
  assert.equal(w.player.st[lit], 1);
  assert.equal(w.player.m[hp], 9);
  // Inside the room.
  place(w.player, 1, 2);
  w.step();
  w.step();
  assert.equal(w.player.st[lit], 0);
  assert.equal(w.player.m[hp], 9);
  // Outside the door: the cell across the door is a target in reach, but not exposed.
  place(w.player, 3, 2);
  const bask = w.availableActions().filter((a) => a.action === 't:bask');
  const by = (x: number, y: number) => bask.find((a) => a.x === x && a.y === y);
  assert.equal(by(2, 2)?.ok, false, 'the room cell across the door');
  assert.equal(by(2, 2)?.reason, 'cannot_act');
  assert.equal(by(4, 2)?.ok, true, 'an open cell');
  assert.equal(by(3, 2)?.ok, true, 'the actor cell');
  w.step();
  assert.equal(w.player.st[lit], 1);
  // An empty cell (the one-floor map has none, so a two-floor variant): never exposed.
  const UPPER = ['+ + + + + + +', '             ', '+ + + + + + +', '  #. .#      ', '+ + + + + + +', '  #. .#      ', '+ + + + + + +', '  #. .#      ', '+ +#+#+ + + +', '             ', '+ + + + + + +'];
  const two = World.create(def([ROOM, withRow(UPPER, 2, '+ +#+#+ + + +')], RULES), 1);
  place(two.player, 0, 0, 1);
  assert.equal(two.grid.cells[two.grid.index(0, 0, 1)], EMPTY_TILE);
  two.step();
  assert.equal(two.player.st[lit], 0);
  assert.equal(two.player.m[hp], 10);
});

test('exposure: `tile.exposed` in a populate `where`', () => {
  const populate = `    populate:\n      - { archetype: rock, count: 2, where: 'not tile.exposed' }\n`;
  const d = loadPacksOrThrow([fixture(files(mapEntry('room', [ROOM], populate)))]);
  const w = World.create(d, 1);
  const rocks = w.entities.filter((e) => e.archetype.id === 't:rock');
  assert.equal(rocks.length, 2);
  for (const r of rocks) assert.ok(INSIDE.some(([x, y]) => x === r.x && y === r.y), `rock at (${r.x}, ${r.y}) is inside the room`);
});

// ── Check ───────────────────────────────────────────────────────────────────

test('exposure: `check --exposure` output is byte-stable; an unknown map suggests one', () => {
  const d = def([ROOM]);
  const r = formatExposure(d, 't:room');
  assert.ok(r.ok);
  assert.deepEqual(r.lines, ['t:room: 6×5, 1 floor', 'floor 0', '......', '.##...', '.##...', '.##...', '......']);
  const short = formatExposure(d, 'room');
  assert.ok(short.ok && short.lines[0] === 't:room: 6×5, 1 floor', 'a short id that names one map');
  const bad = formatExposure(d, 't:rooom');
  assert.ok(!bad.ok);
  if (!bad.ok) assert.equal(bad.error, "unknown map 't:rooom' (did you mean 't:room'?)");
});

// ── Shipped packs ───────────────────────────────────────────────────────────

const VAMPIRE = loadPacksOrThrow(GAMES.vampire.map((d) => readPack(d)));
const M = (x: number, y: number): [number, number] => genreCell('vampire', x, y);

/** The vampire's estate at the first daylight tick, as a save to restore per scenario. */
function dayOnTheEstate(): ReturnType<World['save']> {
  const w = World.create(VAMPIRE, 1);
  while (!isDayAt(VAMPIRE.clock, w.tick, VAMPIRE.ticksPerSecond)) w.step();
  return JSON.parse(JSON.stringify(w.save())) as ReturnType<World['save']>;
}

test('vampire: by day the vampire is safe on the great hall carpet, the plain floors and the graveyard, and burns on a sunbeam and the open ground', () => {
  const save = dayOnTheEstate();
  const hp = VAMPIRE.ids.measurements['std:hp']!;
  const sunburnt = VAMPIRE.ids.statuses['vamp:sunburnt']!;
  const estate = VAMPIRE.maps[VAMPIRE.start.map]!;
  const tileAt = (x: number, y: number) => VAMPIRE.tiles[estate.cells[y * estate.width + x]!]!.id;
  const run = (x: number, y: number): { burnt: boolean; lost: number } => {
    const r = World.restore(VAMPIRE, save);
    if (!r.ok) assert.fail(r.errors.join('\n'));
    const w = r.world;
    assert.ok(!w.player.inv!.stacks.some((s) => VAMPIRE.items[s.item]!.id === 'vamp:cloak'));
    place(w.player, x, y, 0);
    const before = w.player.m[hp]!;
    for (let i = 0; i < 15; i++) w.step();
    return { burnt: w.player.st[sunburnt] === 1, lost: before - w.player.m[hp]! };
  };
  const safe: [string, [number, number]][] = [
    ['vamp:carpet', M(14, 6)],
    ['std:floor', M(2, 2)],
    ['vamp:creaky', M(9, 9)],
    ['vamp:crypt', [9, 9]],
  ];
  for (const [id, [x, y]] of safe) {
    assert.equal(tileAt(x, y), id);
    assert.deepEqual(run(x, y), { burnt: false, lost: 0 }, `${id} at (${x}, ${y})`);
  }
  const burning: [string, [number, number]][] = [
    ['vamp:sunbeam', M(4, 0)],
    ['vamp:sunbeam', M(27, 10)],
    ['vamp:sunbeam', [64, 40]],
  ];
  for (const [id, [x, y]] of burning) {
    assert.equal(tileAt(x, y), id);
    const { burnt, lost } = run(x, y);
    assert.ok(burnt && lost > 0, `${id} at (${x}, ${y}): burnt ${burnt}, lost ${lost}`);
  }
});

test('vampire: the mansion plain floors are not exposed, every sunbeam is, the tags are gone', () => {
  const estate = VAMPIRE.maps[VAMPIRE.start.map]!;
  const counts = new Map<string, [number, number]>();
  for (let i = 0; i < estate.cells.length; i++) {
    const t = estate.cells[i]!;
    if (t === EMPTY_TILE) continue;
    const id = VAMPIRE.tiles[t]!.id;
    const c = counts.get(id) ?? [0, 0];
    c[0]++;
    c[1] += estate.exposed[i]!;
    counts.set(id, c);
  }
  assert.deepEqual(counts.get('std:floor'), [184, 0]);
  const [beams, lit] = counts.get('vamp:sunbeam')!;
  assert.equal(lit, beams, 'every sunbeam, the ones under the windows included');
  assert.ok(beams > 10000);
  for (const id of ['vamp:carpet', 'vamp:creaky', 'vamp:crypt', 'vamp:font']) assert.equal(counts.get(id)![1], 0, `${id} is in the shade`);
  for (const t of VAMPIRE.tiles) assert.ok(!t.tags.includes('shade') && !t.tags.includes('sunlit'), t.id);
  const tile = (id: string) => VAMPIRE.tiles[VAMPIRE.ids.tiles[id]!]!;
  assert.equal(tile('vamp:sunbeam').exposed, true);
  assert.ok(tile('vamp:crypt').tags.includes('crypt') && tile('vamp:font').tags.includes('blood'));
  // The attic study is enclosed too.
  assert.equal(estate.exposed[(1 * estate.height + 54 + 15) * estate.width + 49 + 5], 0);
});

test('garden: the fence does not enclose and the garden is exposed everywhere', () => {
  const d = loadPacksOrThrow(GAMES.garden.map((p) => readPack(p)));
  assert.equal(d.tiles[d.ids.tiles['gdn:fence']!]!.encloses, false);
  const m = d.maps[d.start.map]!;
  let cells = 0;
  for (let i = 0; i < m.cells.length; i++) {
    if (m.cells[i] === EMPTY_TILE) continue;
    cells++;
    assert.equal(m.exposed[i], 1, `cell ${i}`);
  }
  assert.ok(cells > 100);
});

test('town: house and store interiors are not exposed; roads, yards and the park are', () => {
  const d = loadPacksOrThrow(GAMES.town.map((p) => readPack(p)));
  const city = d.maps[d.start.map]!;
  const at = (x: number, y: number) => {
    const [cx, cy] = genreCell('town', x, y);
    return city.exposed[cy * city.width + cx];
  };
  for (const [x, y] of [[2, 2], [10, 5], [40, 20], [50, 25], [13, 2]]) assert.equal(at(x, y), 0, `inside at (${x}, ${y})`);
  for (const [x, y] of [[0, 0], [30, 14], [8, 10], [25, 5], [58, 28]]) assert.equal(at(x, y), 1, `outside at (${x}, ${y})`);
  // The whole city: most of it is open ground, every interior enclosed.
  let n = 0;
  let e = 0;
  for (let i = 0; i < city.cells.length; i++) if (city.cells[i] !== EMPTY_TILE) (n++, (e += city.exposed[i]!));
  assert.ok(e / n > 0.7 && e / n < 0.85, `${((100 * e) / n).toFixed(1)}% exposed`);
});
