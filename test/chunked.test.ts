import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simStatus } from '../src/ascii/terminal.ts';
import {
  EMPTY_TILE,
  formatError,
  INDEX_CHUNK,
  loadPacks,
  loadPacksOrThrow,
  Pathfinder,
  Rng,
  World,
  type Definition,
  type Entity,
  type LoadError,
  type MapDef,
} from '../src/core/index.ts';
import { chunkKeyOf, chunkLayout, chunkOf, chunksInView, ChunkLru, chunkBounds, chunkCount, inShownChunk, MAX_BUILT_CHUNKS, spriteDiff } from '../src/iso/chunks.ts';
import { formatPopulate } from '../src/cli/populate.ts';
import { populateCandidates, populatePlan } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { perfLine, PerfMeter, Samples } from '../src/web/perf.ts';
import { assertRoundTrip, fixture, GAMES, GENRE_AT } from './helpers.ts';

// M6 chunked world: composite maps, populate, the entity index, dormancy,
// bounded A* with region labels, render-chunk bookkeeping and the big maps.

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: grass, label: Grass, glyph: ",", color: green, walkable: true }
  - { id: box, label: Box, glyph: b, color: brown, walkable: true, container: { capacity: 1000 } }
  - { id: up, label: Stairs, glyph: "<", color: brown, walkable: true, climb: up }
  - { id: land, label: Landing, glyph: ">", color: brown, walkable: true }
`;

const HUT = `  - id: hut
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "b": { tile: box }
      "o": { tile: floor, spawn: rock }
      "@": { tile: floor, player: true }
    rows:
      - "####"
      - "#o@#"
      - "#.b#"
    rooms:
      - { rect: [1, 1, 2, 2], tags: [hut] }
  - id: tower
    legend:
      ".": { tile: floor }
      "<": { tile: up }
      ">": { tile: land }
      "o": { tile: floor, spawn: rock }
    floors:
      - rows: ["<."]
      - rows: [">o"]
    rooms:
      - { rect: [0, 0, 2, 1], floor: 1, tags: [top] }
`;

/** A composite `town` (12×6) of two huts and a two-floor tower; `extra` is appended to the town entry. */
function townFiles(town = '', start = 'start: { map: town, player: hero }\n'): Record<string, string> {
  return {
    'tiles.yaml': TILES,
    'map.yaml': `maps:
${HUT}  - id: town
    size: [12, 6]
    fill: grass
    player: [0, 0]
    parts:
      - { map: hut, at: [1, 1] }
      - { map: hut, at: [6, 1] }
      - { map: tower, at: [10, 4] }
    rooms:
      - { rect: [0, 0, 12, 1], tags: [street] }
${town}${start}`,
  };
}

function load(files: Record<string, string>): { def: Definition | null; errors: readonly LoadError[] } {
  const r = loadPacks([fixture(files)]);
  return r.ok ? { def: r.definition, errors: [] } : { def: null, errors: r.errors };
}

function expectError(files: Record<string, string>, message: RegExp): void {
  const { errors } = load(files);
  assert.ok(
    errors.some((e) => message.test(e.message)),
    `no error matching ${message}; got:\n${errors.map(formatError).join('\n')}`,
  );
}

const tileId = (def: Definition, map: MapDef, x: number, y: number, z = 0): string => {
  const t = map.cells[(z * map.height + y) * map.width + x]!;
  return t === EMPTY_TILE ? '' : def.tiles[t]!.id;
};

/** A copy of `def` with other `start.simulation` settings. */
function withSim(def: Definition, sim: Partial<Definition['start']['simulation']>): Definition {
  return { ...def, start: { ...def.start, simulation: { ...def.start.simulation, ...sim } } };
}

function place(e: Entity, x: number, y: number, z = e.z): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
  e.z = e.fromZ = z;
}

// ── Composite loader ────────────────────────────────────────────────────────

test('composite: parts at their offsets, repeated, with their spawns, rooms, fill and floors', () => {
  const { def, errors } = load(townFiles());
  assert.deepEqual(errors.map(formatError), []);
  const m = def!.maps[def!.start.map]!;
  assert.equal(m.composite, true);
  assert.deepEqual([m.width, m.height, m.floors], [12, 6, 2], 'as many floors as the tallest part');
  // Each hut at its `at`, twice.
  for (const ox of [1, 6]) {
    assert.equal(tileId(def!, m, ox, 1), 't:wall');
    assert.equal(tileId(def!, m, ox + 1, 2), 't:floor');
    assert.equal(tileId(def!, m, ox + 2, 3), 't:box');
  }
  // Fill: floor 0 only; uncovered upper cells stay empty.
  assert.equal(tileId(def!, m, 0, 0), 't:grass');
  assert.equal(tileId(def!, m, 5, 5), 't:grass');
  assert.equal(tileId(def!, m, 0, 0, 1), '');
  assert.equal(tileId(def!, m, 2, 2, 1), '');
  // The tower's two floors.
  assert.equal(tileId(def!, m, 10, 4), 't:up');
  assert.equal(tileId(def!, m, 10, 4, 1), 't:land');
  // Spawns by part, then z, then row-major; the parts' player markers are ignored.
  const rock = def!.ids.archetypes['t:rock']!;
  assert.deepEqual(m.spawns, [
    { x: 2, y: 2, z: 0, archetype: rock },
    { x: 7, y: 2, z: 0, archetype: rock },
    { x: 11, y: 4, z: 1, archetype: rock },
  ]);
  assert.deepEqual(m.playerStart, { x: 0, y: 0, z: 0 });
  // Part rooms offset (in part order), then the composite's own.
  const tag = (t: string) => def!.roomTags.indexOf(t);
  assert.deepEqual(
    m.rooms.rects.map((r) => [r.x, r.y, r.z, r.w, r.h, r.tags]),
    [
      [2, 2, 0, 2, 2, [tag('hut')]],
      [7, 2, 0, 2, 2, [tag('hut')]],
      [10, 4, 1, 2, 1, [tag('top')]],
      [0, 0, 0, 12, 1, [tag('street')]],
    ],
  );
  // Links work on the composed map.
  const w = World.create(def!, 1);
  w.queueIntent({ kind: 'goto', x: 11, y: 4, z: 1 });
  for (let i = 0; i < 100 && (w.player.z !== 1 || w.player.x !== 11); i++) w.step();
  assert.deepEqual([w.player.x, w.player.y, w.player.z], [11, 4, 1]);
  assert.deepEqual(
    w.roomTagsAt(3, 3, 0).map((t) => def!.roomTags[t]),
    ['hut'],
  );
});

test('composite: a part map needs no player marker, and a part may be a Tiled map', () => {
  const files = townFiles();
  files['map.yaml'] = files['map.yaml']!.replace('      "@": { tile: floor, player: true }\n', '').replace('"#o@#"', '"#o.#"');
  const { def, errors } = load(files);
  assert.deepEqual(errors.map(formatError), []);
  assert.equal(def!.maps[def!.ids.maps['t:hut']!]!.playerStart, null);
});

test('composite: load errors', () => {
  const swap = (from: string, to: string) => {
    const f = townFiles();
    assert.ok(f['map.yaml']!.includes(from), from);
    f['map.yaml'] = f['map.yaml']!.replace(from, to);
    return f;
  };
  expectError(swap('{ map: tower, at: [10, 4] }', '{ map: tower, at: [11, 4] }'), /part 2 \('t:tower', 2×1\) at \[11, 4\] lies outside the map \(size 12×6\)/);
  expectError(swap('{ map: hut, at: [6, 1] }', '{ map: hut, at: [3, 2] }'), /parts 0 \('t:hut'\) and 1 \('t:hut'\) overlap, first at \(3, 2\)/);
  expectError(swap('{ map: tower, at: [10, 4] }', '{ map: hutt, at: [10, 4] }'), /unknown map 'hutt' \(did you mean 'hut'\?\)/);
  expectError(swap('player: [0, 0]', 'player: [12, 0]'), /player start \[12,0\] is outside the map/);
  expectError(swap('player: [0, 0]', 'player: [1, 1]'), /player start \[1,1\] is on 't:wall' \(not walkable\)/);
  expectError(swap('player: [0, 0]', 'player: [0, 0, 1]'), /player start \[0,0,1\] is on an empty cell/);
  expectError(swap('    fill: grass\n', ''), /missing required field 'fill': 46 floor-0 cells are not covered by any part \(first at \(0, 0\)\)/);
  expectError(swap('    fill: grass\n', '    fill: grass\n    rows: ["..."]\n'), /a composite map \(size, fill, parts, player\) cannot also take ASCII or Tiled fields \(remove 'rows'\)/);
  expectError(swap('    fill: grass\n', '    fill: grass\n    tiled: maps/x.tmj\n'), /cannot also take ASCII or Tiled fields \(remove 'tiled'\)/);
  expectError(swap('size: [12, 6]', 'size: [12, 0]'), /field 'size' must be \[width, height\], two integers ≥ 1/);
  expectError(swap('    player: [0, 0]\n', ''), /start map 't:town' has no player start cell \(a 'player' field on the composite map\)/);
  expectError(swap('{ map: hut, at: [1, 1] }', '{ map: hut, at: [1] }'), /field 'at' must be \[x, y\]/);
  // No nesting.
  const nested = townFiles(`  - id: big
    size: [20, 20]
    fill: grass
    parts:
      - { map: town, at: [0, 0] }
`);
  expectError(nested, /part 0 is 't:town', a composite map: composites cannot be nested/);
});

// ── Populate ────────────────────────────────────────────────────────────────

const FIELD = (populate: string, sim = '') => ({
  'tiles.yaml': TILES,
  'map.yaml': `maps:
  - id: field
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "b": { tile: box }
      "@": { tile: floor, player: true }
    rows:
      - "#########"
      - "#..b....#"
      - "#.......#"
      - "#@......#"
      - "#########"
    rooms:
      - { rect: [1, 1, 3, 2], tags: [den] }
    populate:
${populate}start: { map: field, player: hero${sim} }
loot:
  - id: junk
    rolls: [1, 3]
    entries:
      - { item: pebble, weight: 1, count: [1, 4] }
      - { item: shell, weight: 1 }
distributions:
  - { container: box, table: junk }
items:
  - { id: pebble, label: Pebble, glyph: ".", color: gray, weight: 0.01 }
  - { id: shell, label: Shell, glyph: s, color: white, weight: 0.01 }
`,
});

const rocksOf = (w: World) => w.entities.filter((e) => e.archetype.id === 't:rock');
const cells = (es: readonly Entity[]) => es.map((e) => `${e.x},${e.y},${e.z}`);

test('populate: seeded, without reuse, on candidate cells only; ids follow placement order', () => {
  const def = loadPacksOrThrow([fixture(FIELD('      - { archetype: rock, count: 3, room: den }\n      - { archetype: rock, count: 12 }\n'))]);
  const a = World.create(def, 1);
  const b = World.create(def, 1);
  assert.deepEqual(cells(rocksOf(a)), cells(rocksOf(b)), 'same seed, same cells');
  assert.equal(rocksOf(a).length, 15);
  const seen = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const w = World.create(def, seed);
    const rocks = rocksOf(w);
    assert.equal(rocks.length, 15, 'every seed places the same count');
    assert.equal(new Set(cells(rocks)).size, 15, 'a cell gets at most one populated entity');
    assert.deepEqual(
      rocks.map((e) => e.id),
      rocks.map((_, k) => k + 1),
      'ids follow placement order, after the player',
    );
    for (const e of rocks) {
      assert.ok(w.grid.walkable(e.x, e.y, e.z), 'walkable');
      assert.notEqual(w.grid.tileAt(e.x, e.y)!.id, 't:box', 'no container tile');
      assert.ok(!(e.x === 1 && e.y === 3), 'not the player start');
    }
    // The first entry only uses the den.
    for (const e of rocks.slice(0, 3)) assert.deepEqual(w.roomTagsAt(e.x, e.y).map((t) => def.roomTags[t]), ['den']);
    seen.add(cells(rocks).join(' '));
  }
  assert.ok(seen.size > 1, 'different seeds give different cells');
});

test('populate: rect, floor and room filters; per placement on parts', () => {
  const rect = loadPacksOrThrow([fixture(FIELD('      - { archetype: rock, count: 4, rect: [5, 1, 2, 2] }\n'))]);
  for (const seed of [1, 2, 3]) {
    const rocks = rocksOf(World.create(rect, seed));
    assert.deepEqual(cells(rocks).sort(), ['5,1,0', '5,2,0', '6,1,0', '6,2,0']);
  }
  // On a part: once per placement, offset by `at`; then the composite's own.
  const files = townFiles(`    populate:
      - { archetype: rock, count: 2, rect: [0, 0, 12, 1] }
`);
  files['map.yaml'] = files['map.yaml']!.replace(
    '      - { rect: [0, 0, 2, 1], floor: 1, tags: [top] }\n',
    '      - { rect: [0, 0, 2, 1], floor: 1, tags: [top] }\n    populate:\n      - { archetype: rock, count: 1, floor: 1 }\n',
  );
  files['map.yaml'] = files['map.yaml']!.replace('      - { rect: [1, 1, 2, 2], tags: [hut] }\n', '      - { rect: [1, 1, 2, 2], tags: [hut] }\n    populate:\n      - { archetype: rock, count: 1, room: hut }\n');
  const def = loadPacksOrThrow([fixture(files)]);
  const m = def.maps[def.start.map]!;
  assert.deepEqual(
    m.populate.map((p) => [p.x, p.y, p.w, p.h, p.z, p.count]),
    [
      [1, 1, 4, 3, 0, 1],
      [6, 1, 4, 3, 0, 1],
      [10, 4, 2, 1, 1, 1],
      [0, 0, 12, 1, 0, 2],
    ],
  );
  for (const seed of [1, 2, 3, 4]) {
    const w = World.create(def, seed);
    const placed = rocksOf(w).slice(3); // after the 3 explicit spawns
    assert.equal(placed.length, 5);
    const [h1, h2, top, ...street] = placed;
    assert.ok(h1!.x >= 2 && h1!.x <= 3 && h1!.y >= 2 && h1!.y <= 3 && !(h1!.x === 3 && h1!.y === 3), `first hut ${cells([h1!])}`);
    assert.ok(h2!.x >= 7 && h2!.x <= 8 && h2!.y >= 2 && h2!.y <= 3, `second hut ${cells([h2!])}`);
    assert.deepEqual([top!.y, top!.z], [4, 1]);
    for (const e of street) assert.equal(e.y, 0);
    assert.ok(!street.some((e) => e.x === 0), 'not the player start');
  }
});

test('populate: load errors (count over the candidates, also after earlier entries; fields)', () => {
  expectError(FIELD('      - { archetype: rock, count: 20 }\n'), /populate count 20 of 't:rock' in 't:field' is more than its 19 candidate cells/);
  expectError(FIELD('      - { archetype: rock, count: 6, room: den }\n'), /is more than its 5 candidate cells/);
  expectError(FIELD('      - { archetype: rock, count: 15 }\n      - { archetype: rock, count: 5, room: den }\n'), /may not fit: earlier entries can take 5 of its 5 candidate cells/);
  expectError(FIELD('      - { archetype: rok, count: 1 }\n'), /unknown archetype 'rok' \(did you mean 'rock'\?\)/);
  expectError(FIELD('      - { archetype: rock, count: 0 }\n'), /field 'count' must be an integer ≥ 1/);
  expectError(FIELD('      - { archetype: rock }\n'), /missing required field 'count'/);
  expectError(FIELD('      - { archetype: rock, count: 1, rect: [8, 0, 2, 2] }\n'), /populate rect \[8,0,2,2\] is out of bounds/);
  expectError(FIELD('      - { archetype: rock, count: 1, floor: 1 }\n'), /populate 'floor' must be an existing floor/);
  expectError(FIELD('      - { archetype: rock, count: 1, room: dne }\n'), /unknown room tag 'dne' \(did you mean 'den'\?\)/);
  expectError(FIELD('      - { archetype: rock, count: 1, rom: den }\n'), /unknown populate field 'rom' \(did you mean 'room'\?\)/);
  // On a part, the count is checked per placement in the composite too (the composite's player start is excluded).
  const files = townFiles();
  files['map.yaml'] = files['map.yaml']!.replace('      - { rect: [0, 0, 2, 1], floor: 1, tags: [top] }\n', '      - { rect: [0, 0, 2, 1], floor: 1, tags: [top] }\n    populate:\n      - { archetype: rock, count: 2 }\n');
  files['map.yaml'] = files['map.yaml']!.replace('player: [0, 0]', 'player: [11, 4]');
  expectError(files, /populate count 2 of 't:rock' in 't:town' is more than its 1 candidate cell/);
});

test('populate: the world RNG and loot are unchanged; saves keep the placed entities', () => {
  const plain = loadPacksOrThrow([fixture(FIELD('      - { archetype: rock, count: 1, rect: [1, 1, 1, 1] }\n'))]);
  const crowded = loadPacksOrThrow([fixture(FIELD('      - { archetype: rock, count: 14 }\n'))]);
  for (const seed of [1, 7, 42]) {
    const a = World.create(plain, seed);
    const b = World.create(crowded, seed);
    assert.equal(a.rng.state, b.rng.state);
    const box = (w: World) => w.containersAt(3, 1, 0)[0]!.stacks;
    assert.deepEqual(box(a), box(b));
    assert.ok(box(a).length > 0);
  }
  const w = World.create(crowded, 3);
  for (let i = 0; i < 5; i++) w.step();
  const copy = assertRoundTrip(w, () => {}, 20);
  assert.equal(copy.entities.length, w.entities.length, 'restore never re-populates');
});

// ── Populate by density ─────────────────────────────────────────────────────

const DENSE_TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: grass, label: Grass, glyph: ",", color: green, walkable: true, tags: [grass] }
`;

const YARD_ROWS = `    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      ",": { tile: grass }
      "@": { tile: floor, player: true }
    rows:
      - "############"
      - "#....,,,,,.#"
      - "#....,,,,,.#"
      - "#@...,,,,,.#"
      - "#..........#"
      - "############"
    rooms:
      - { rect: [1, 1, 4, 3], tags: [den] }
`;

/** A 12×6 yard: 39 candidate cells (the player start excluded), 15 of them tagged `grass`, 11 in the `den`. */
const YARD = (populate: string) => ({
  'tiles.yaml': DENSE_TILES,
  'map.yaml': `maps:
  - id: yard
${YARD_ROWS}    populate:
${populate}start: { map: yard, player: hero }
`,
});

/** The yard as a part placed twice, its own populate once per placement. */
const PAIR = (populate: string) => ({
  'tiles.yaml': DENSE_TILES,
  'map.yaml': `maps:
  - id: yard
${YARD_ROWS}    populate:
${populate}  - id: pair
    size: [24, 6]
    fill: floor
    player: [1, 3]
    parts:
      - { map: yard, at: [0, 0] }
      - { map: yard, at: [12, 0] }
start: { map: pair, player: hero }
`,
});

const GRASS = `      - { archetype: rock, density: 20, where: 'tile.has_tag("grass")' }\n`;

test('populate density: exactly one of count/density, a density > 0, and a boolean where over tile only', () => {
  expectError(YARD('      - { archetype: rock, count: 1, density: 1 }\n'), /populate entries take exactly one of 'count' and 'density', not both/);
  expectError(YARD('      - { archetype: rock }\n'), /missing required field 'count' or 'density' \(populate entries take exactly one\)/);
  for (const bad of ['0', '-1', '"2"', 'true', '[1]']) expectError(YARD(`      - { archetype: rock, density: ${bad} }\n`), /field 'density' must be a number > 0 \(entities per 100 candidate cells\)/);
  expectError(YARD('      - { archetype: rock, density: 300 }\n'), /populate count 117 \(density 300\) of 't:rock' in 't:yard' is more than its 39 candidate cells/);
  // `where` sees only `tile`: every other scope name and the RNG/world built-ins are errors naming the field.
  for (const src of ['self.hp > 1', 'player.x > 1', 'npc.x > 1', 'world.is_day', 'self == player', 'random(1, 2) > 1', 'roll(1, 6) > 3', 'has_status(self, "x")', 'var("x") > 0', 'can_see(tile, tile)']) {
    const name = /^[a-z_]+/.exec(src)![0];
    expectError(YARD(`      - { archetype: rock, density: 10, where: '${src}' }\n`), new RegExp(`populate 'where' sees only 'tile': '${name}' is not available at load`));
  }
  expectError(YARD("      - { archetype: rock, density: 10, where: 'tile.x' }\n"), /populate 'where' "tile.x" must produce a boolean, got number/);
  expectError(YARD("      - { archetype: rock, density: 10, where: 'tile.id' }\n"), /must produce a boolean, got string/);
  expectError(YARD('      - { archetype: rock, density: 10, where: 5 }\n'), /field 'where' must be a string/);
  expectError(YARD("      - { archetype: rock, density: 10, where: 'tile.x >' }\n"), /expression syntax error in "tile.x >"/);
  expectError(YARD("      - { archetype: rock, density: 10, where: 'tile.in_room(\"dne\")' }\n"), /unknown room tag 'dne' \(did you mean 'den'\?\)/);
  // `where` composes with rect, floor and room: the expression filters what the fields left.
  expectError(YARD("      - { archetype: rock, count: 2, room: den, where: 'tile.x == 4 and tile.y == 2' }\n"), /populate count 2 of 't:rock' in 't:yard' is more than its 1 candidate cell \(/);
  expectError(YARD("      - { archetype: rock, count: 6, rect: [5, 1, 5, 3], where: 'tile.y == 1' }\n"), /populate count 6 of 't:rock' in 't:yard' is more than its 5 candidate cells/);
  expectError(YARD("      - { archetype: rock, count: 1, where: 'tile.z == 1' }\n"), /populate count 1 of 't:rock' in 't:yard' is more than its 0 candidate cells/);
  assert.equal(rocksOf(World.create(loadPacksOrThrow([fixture(YARD("      - { archetype: rock, density: 100, where: 'tile.z == 0' }\n"))]), 1)).length, 39);
});

test('populate density: where sees the cell as tile; room: den and tile.in_room("den") agree', () => {
  const cands = (populate: string) => {
    const def = loadPacksOrThrow([fixture(YARD(populate))]);
    const m = def.maps[def.start.map]!;
    return m.populate.map((p) => populateCandidates(m, def.tiles, p));
  };
  const [byRoom] = cands('      - { archetype: rock, count: 1, room: den }\n');
  const [byWhere] = cands("      - { archetype: rock, count: 1, where: 'tile.in_room(\"den\")' }\n");
  assert.deepEqual(byWhere, byRoom);
  assert.equal(byRoom!.length, 11);
  const [grass, row, all, none] = cands(
    "      - { archetype: rock, count: 1, where: 'tile.has_tag(\"grass\")' }\n" +
      "      - { archetype: rock, count: 1, where: 'tile.id == \"t:grass\" and tile.y == 1' }\n" +
      "      - { archetype: rock, count: 1, where: 'tile.z == 0 and not tile.has_tag(\"wall\")' }\n" +
      "      - { archetype: rock, density: 50, where: 'tile.in_room(\"den\") and tile.has_tag(\"grass\")' }\n",
  );
  assert.deepEqual([grass!.length, row!.length, all!.length, none!.length], [15, 5, 39, 0]);
});

test('populate density: round(d × candidates / 100), 0 places nothing, the overlap check, per placement on a part', () => {
  const rocks = (populate: string, seed = 1) => rocksOf(World.create(loadPacksOrThrow([fixture(YARD(populate))]), seed));
  assert.equal(rocks('      - { archetype: rock, density: 10 }\n').length, 4); // round(3.9)
  assert.equal(rocks('      - { archetype: rock, density: 1 }\n').length, 0); // round(0.39): nothing, and no error
  const onGrass = rocks(GRASS);
  assert.equal(onGrass.length, 3); // round(20 × 15 / 100)
  for (const e of onGrass) assert.ok(e.x >= 5 && e.x <= 9 && e.y >= 1 && e.y <= 3, cells([e]).join());
  assert.equal(rocks("      - { archetype: rock, density: 40, where: 'tile.has_tag(\"grass\") and tile.y == 1' }\n").length, 2);
  // A density entry before a count entry: the overlap check uses the derived count.
  const grassAll = "      - { archetype: rock, density: 100, where: 'tile.has_tag(\"grass\")' }\n";
  expectError(YARD(`${grassAll}      - { archetype: rock, count: 25 }\n`), /populate count 25 of 't:rock' in 't:yard' may not fit: earlier entries can take 15 of its 39 candidate cells/);
  const full = rocks(`${grassAll}      - { archetype: rock, count: 24 }\n`);
  assert.equal(full.length, 39);
  assert.equal(new Set(cells(full)).size, 39);
  // On a part placed twice: one draw per placement, each sized by its own candidates on the composed map.
  const def = loadPacksOrThrow([fixture(PAIR(GRASS))]);
  const m = def.maps[def.start.map]!;
  assert.deepEqual(
    m.populate.map((p) => [p.x, p.count, p.density, p.where !== null]),
    [
      [0, null, 20, true],
      [12, null, 20, true],
    ],
  );
  assert.deepEqual(populatePlan(m, def.tiles).map((p) => [p.candidates.length, p.count, p.taken]), [
    [15, 3, 0],
    [15, 3, 0],
  ]);
  for (const seed of [1, 2, 3]) {
    const placed = rocksOf(World.create(def, seed));
    assert.equal(placed.length, 6);
    assert.ok(placed.slice(0, 3).every((e) => e.x >= 5 && e.x <= 9) && placed.slice(3).every((e) => e.x >= 17 && e.x <= 21), cells(placed).join(' '));
  }
});

test('populate density: the same seed gives the same cells; count entries, the world RNG and loot are as before this spec', () => {
  const dense = loadPacksOrThrow([fixture(YARD(GRASS))]);
  const plain = loadPacksOrThrow([fixture(YARD('      - { archetype: rock, count: 1 }\n'))]);
  for (const seed of [1, 5, 9]) {
    assert.deepEqual(cells(rocksOf(World.create(dense, seed))), cells(rocksOf(World.create(dense, seed))));
    assert.equal(World.create(dense, seed).rng.state, World.create(plain, seed).rng.state, 'the world RNG never sees populate');
  }
  // Worlds whose populate uses `count` hash as they did before densities existed (recorded at 192e453).
  const field = loadPacksOrThrow([fixture(FIELD('      - { archetype: rock, count: 3, room: den }\n      - { archetype: rock, count: 12 }\n'))]);
  assert.deepEqual(
    [1, 7, 42].map((seed) => World.create(field, seed).hash()),
    ['ae90ca61', '3385aa6e', '1b6da8fe'],
  );
  assert.deepEqual(
    [1, 7].map((seed) => World.create(ESTATE, seed).hash()),
    ['2fe549a0', 'eeaa3060'],
  );
});

test('check --populate: one line per entry (count or density → N, candidates, free cells), then the total; byte-stable', () => {
  const def = loadPacksOrThrow([fixture(YARD(`${GRASS}      - { archetype: rock, count: 24 }\n      - { archetype: rock, density: 1 }\n`))]);
  assert.deepEqual(formatPopulate(def), [
    'populate:',
    '  t:yard',
    '    t:rock  density 20 → 3  15 candidates, 15 free',
    '    t:rock  count 24        39 candidates, 36 free',
    '    t:rock  density 1 → 0   39 candidates, 12 free',
    '    total 27',
  ]);
  // A part's entries are listed on the part and, per placement, on the composite.
  assert.deepEqual(formatPopulate(loadPacksOrThrow([fixture(PAIR(GRASS))])), [
    'populate:',
    '  t:yard',
    '    t:rock  density 20 → 3  15 candidates, 15 free',
    '    total 3',
    '  t:pair',
    '    t:rock  density 20 → 3  15 candidates, 15 free',
    '    t:rock  density 20 → 3  15 candidates, 15 free',
    '    total 6',
  ]);
  assert.deepEqual(formatPopulate(loadPacksOrThrow([fixture()])), ['populate:', '  none']);
});

test('zombie: the city is populated by density over three rooms: ~896 in all, the centre block left to its spawns, downtown denser', () => {
  const city = CITY.maps[CITY.start.map]!;
  const plans = populatePlan(city, CITY.tiles);
  const own = city.populate.map((p, k) => [p, plans[k]!] as const).filter(([p]) => p.density !== null);
  assert.equal(own.length, 4, 'four density entries (the rest are house_c placements)');
  const total = own.reduce((a, [, plan]) => a + plan.count, 0);
  assert.ok(total >= 806 && total <= 986, `${total} populated by the city's own entries (896 ± 10 %)`);
  const w = World.create(CITY, 1);
  assert.equal(w.entities.length, 1 + city.spawns.length + plans.reduce((a, p) => a + p.count, 0));
  type Rect = readonly [number, number, number, number];
  const CENTER: Rect = [137, 137, 69, 69];
  const DOWNTOWN: Rect = [73, 73, 197, 197];
  const TOWN: Rect = [9, 9, 325, 325];
  const inRect = (e: Entity, [x, y, wd, h]: Rect) => e.x >= x && e.x < x + wd && e.y >= y && e.y < y + h;
  const npcs = w.entities.filter((e) => e !== w.player);
  assert.equal(city.spawns.length, 6);
  // The centre block holds town_center's six spawns (and house_c's own crawlers upstairs): the density entries place nothing there.
  const firstOwn = city.spawns.length + city.populate.filter((p) => p.density === null).length; // ids above this come from the density entries
  const centre = npcs.filter((e) => inRect(e, CENTER));
  assert.deepEqual(centre.filter((e) => e.id <= city.spawns.length).map((e) => e.id), [1, 2, 3, 4, 5, 6]);
  assert.ok(centre.every((e) => e.id <= firstOwn && (e.id <= city.spawns.length || e.z === 1)), `${centre.length} in the centre block`);
  const populated = npcs.filter((e) => e.id > city.spawns.length && e.z === 0);
  const downtown = populated.filter((e) => inRect(e, DOWNTOWN) && !inRect(e, CENTER)).length / 8;
  const suburbs = populated.filter((e) => inRect(e, TOWN) && !inRect(e, DOWNTOWN)).length / 16;
  const fields = populated.filter((e) => !inRect(e, TOWN)).length;
  assert.ok(downtown > 1.5 * suburbs, `${downtown} per downtown block vs ${suburbs} per suburban block`);
  assert.ok(fields >= 40 && fields <= 56, `${fields} in the fields`);
  const crawlers = npcs.filter((e) => e.archetype.id === 'zmb:crawler' && inRect(e, DOWNTOWN) && e.z === 0 && e.id > 6).length;
  assert.ok(crawlers >= 40 && crawlers <= 60, `${crawlers} crawlers downtown`);
});

// ── Simulation settings ────────────────────────────────────────────────────

test('start.simulation: defaults, values and errors', () => {
  const def = loadPacksOrThrow([fixture()]);
  assert.deepEqual(def.start.simulation, { activeRadius: 64, npcPathBudget: 4000, playerPathBudget: 60000 });
  const set = (sim: string) => FIELD('      - { archetype: rock, count: 1 }\n', `, simulation: ${sim}`);
  assert.deepEqual(loadPacksOrThrow([fixture(set('{ active_radius: none, npc_path_budget: 10, player_path_budget: 20 }'))]).start.simulation, {
    activeRadius: null,
    npcPathBudget: 10,
    playerPathBudget: 20,
  });
  expectError(set('{ active_radius: -1 }'), /field 'active_radius' must be an integer ≥ 0 or 'none', got -1/);
  expectError(set('{ npc_path_budget: 0 }'), /field 'npc_path_budget' must be an integer ≥ 1, got 0/);
  expectError(set('{ player_path_budget: none }'), /field 'player_path_budget' must be an integer ≥ 1, got "none"/);
  expectError(set('{ radius: 3 }'), /unknown simulation field 'radius'/);
});

// ── Entity index and hearing ────────────────────────────────────────────────

/** A 40×36 two-floor open field (stairs in the middle), with `n` wandering, sometimes shouting NPCs. */
function crowd(n: number, sim = ''): Definition {
  const row = (z: number, y: number) =>
    Array.from({ length: 40 }, (_, x) => (x === 0 || y === 0 || x === 39 || y === 35 ? '#' : x === 20 && y === 18 ? (z === 0 ? '<' : '>') : '.')).join('');
  const floor = (z: number) => `      - rows:\n${Array.from({ length: 36 }, (_, y) => `          - "${y === 1 && z === 0 ? row(z, y).replace('#.', '#@') : row(z, y)}"`).join('\n')}\n`;
  return loadPacksOrThrow([
    fixture({
      'tiles.yaml': TILES,
      'map.yaml': `maps:
  - id: field
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "<": { tile: up }
      ">": { tile: land }
      "@": { tile: floor, player: true }
    floors:
${floor(0)}${floor(1)}    populate:
      - { archetype: loud, count: ${Math.ceil(n / 2)} }
      - { archetype: loud, count: ${Math.floor(n / 2)}, floor: 1 }
start: { map: field, player: hero${sim} }
`,
      'loud.yaml': `archetypes:
  - { id: loud, label: Loud, glyph: L, color: red, tags: [loud], behavior: roam, ticks_per_step: 1, ticks_per_turn: 0 }
behaviors:
  - id: roam
    initial: go
    states:
      go: { do: wander }
systems:
  - id: shout
    every: 0.1
    for: 'self.has_tag("loud")'
    when: 'random(0, 1) < 0.2'
    effects: [{ type: noise, radius: "random(1, 14)" }]
`,
    }),
  ]);
}

test('entity index: entitiesNear matches a brute-force scan, in id order, on any or one floor', () => {
  const w = World.create(crowd(80), 5);
  const rng = new Rng(77);
  for (let t = 0; t < 60; t++) {
    w.step();
    for (let q = 0; q < 10; q++) {
      const x = Math.floor(rng.next() * 44) - 2;
      const y = Math.floor(rng.next() * 40) - 2;
      const r = Math.floor(rng.next() * 24);
      const z = rng.next() < 0.5 ? undefined : Math.floor(rng.next() * 2);
      const want = w.entities.filter((e) => (z === undefined || e.z === z) && Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) <= r);
      assert.deepEqual(
        w.entitiesNear(x, y, z, r).map((e) => e.id),
        want.map((e) => e.id),
        `near ${x},${y},${z} r ${r}`,
      );
    }
  }
  assert.ok(INDEX_CHUNK === 16);
  // Positions set from outside the simulation are picked up too.
  place(w.entities[5]!, 2, 2, 0);
  assert.ok(w.entitiesNear(2, 2, 0, 0).includes(w.entities[5]!));
});

test('hearing: the chunk index gives exactly the brute-force result (nearest noise, ties to the earlier emission)', () => {
  for (const seed of [1, 2, 3]) {
    const w = World.create(crowd(120), seed);
    let heard = 0;
    for (let t = 0; t < 150; t++) {
      w.step();
      const tick = w.tick - 1;
      const noises = w.noises;
      for (const e of w.entities) {
        let best = Infinity;
        let pick = -1;
        noises.forEach((n, i) => {
          if (n.source === e.id) return;
          const d = (n.x - e.x) ** 2 + (n.y - e.y) ** 2 + (n.z - e.z) ** 2;
          if (d <= n.radius * n.radius && d < best) {
            best = d;
            pick = i;
          }
        });
        if (pick < 0) {
          assert.notEqual(e.heardTick, tick, `entity ${e.id} heard nothing at tick ${tick}`);
          continue;
        }
        heard++;
        const n = noises[pick]!;
        assert.deepEqual([e.heardX, e.heardY, e.heardZ, e.heardTick], [n.x, n.y, n.z, tick], `entity ${e.id} at tick ${tick}`);
      }
    }
    assert.ok(heard > 100, `only ${heard} hearings`);
  }
});

// ── Dormancy ────────────────────────────────────────────────────────────────

/** A 30×5 corridor; the player at x = 1; walkers (`n`) at the `npcs` x positions on row 2, carts (`c`, no behavior) at `carts`. */
function corridor(sim: string, npcs: number[], carts: number[] = []): Definition {
  const rows = Array.from({ length: 5 }, (_, y) =>
    Array.from({ length: 30 }, (_, x) =>
      y === 0 || y === 4 || x === 0 || x === 29 ? '#' : y === 2 && x === 1 ? '@' : y === 2 && npcs.includes(x) ? 'n' : y === 2 && carts.includes(x) ? 'c' : '.',
    ).join(''),
  );
  return loadPacksOrThrow([
    fixture({
      'map.yaml': `maps:
  - id: hall
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "n": { tile: floor, spawn: walker }
      "c": { tile: floor, spawn: cart }
    rows:
${rows.map((r) => `      - "${r}"`).join('\n')}
start: { map: hall, player: hero${sim} }
`,
      'walker.yaml': `archetypes:
  - { id: walker, label: Walker, glyph: w, color: red, tags: [walker], measurements: [food], behavior: pace, ticks_per_step: 3, ticks_per_turn: 0 }
  - { id: cart, label: Cart, glyph: c, color: brown, tags: [walker], measurements: [food], ticks_per_step: 3, ticks_per_turn: 0 }
behaviors:
  - id: pace
    initial: go
    states:
      go: { do: wander, radius: 2 }
systems:
  - id: snack
    every: 1
    for: 'self.has_tag("walker")'
    effects: [{ type: apply, measurement: food, delta: 5 }]
`,
    }),
  ]);
}

test('dormancy: beyond the active radius (Chebyshev, exclusive) an NPC neither thinks nor moves', () => {
  const def = corridor(', simulation: { active_radius: 5 }', [6, 7], [8]);
  const w = World.create(def, 1);
  const [at5, at6, cart] = [w.entities[1]!, w.entities[2]!, w.entities[3]!];
  assert.deepEqual([at5.x - w.player.x, at6.x - w.player.x], [5, 6]);
  assert.equal(w.isDormant(at5), false, 'exactly at the radius: active');
  assert.equal(w.isDormant(at6), true);
  assert.equal(w.isDormant(w.player), false);
  assert.equal(w.activeCount, 2);
  // Chebyshev on (x, y), on any floor.
  place(at5, 6, 3);
  assert.equal(w.isDormant(at5), false);
  place(at5, 7, 3);
  assert.equal(w.isDormant(at5), true);
  place(at5, 6, 2);
  // Dormant walkers do not think: only the active one does.
  const thinks = w.thinkCalls;
  const state = [at6.x, at6.y, at6.state, at6.stateTick, at6.moveCooldown];
  for (let t = 0; t < 12; t++) w.step();
  assert.equal(w.thinkCalls - thinks, 12, 'only the active NPC thought');
  assert.deepEqual([at6.x, at6.y, at6.state, at6.stateTick, at6.moveCooldown], state);
  // A dormant NPC keeps its intent and its move cooldown; drift and systems still run on it.
  const intent = { kind: 'goto', x: 20, y: 2 } as const;
  w.queueIntent(intent, cart);
  cart.moveCooldown = 2;
  const food = w.value(cart, 't:food')!;
  for (let t = 0; t < 10; t++) w.step();
  assert.equal(cart.intent, intent, 'the intent is kept');
  assert.deepEqual([cart.x, cart.y, cart.moveCooldown, cart.path], [8, 2, 2, null]);
  assert.ok(Math.abs(w.value(cart, 't:food')! - (food - 10 * 0.1 + 5)) < 1e-9, 'drift (-1/s) and the 1 s system (+5) ran');
  // In range again, the kept intent is applied.
  place(w.player, 3, 2);
  w.step();
  assert.equal(cart.intent, null);
  assert.ok(cart.path, 'the goto ran once active');
});

test('dormancy: a dormant NPC keeps its path; `none` disables dormancy', () => {
  const def = corridor(', simulation: { active_radius: 5 }', [], [4]);
  const w = World.create(def, 1);
  const npc = w.entities[1]!;
  w.queueIntent({ kind: 'goto', x: 25, y: 2 }, npc);
  w.step();
  assert.ok(npc.path);
  // Run until it walks out of the radius; then it freezes mid-path.
  for (let t = 0; t < 200 && !w.isDormant(npc); t++) w.step();
  assert.equal(w.isDormant(npc), true);
  const path = npc.path;
  const pos = [npc.x, npc.y, npc.pathPos, npc.moveCooldown];
  for (let t = 0; t < 10; t++) w.step();
  assert.equal(npc.path, path);
  assert.deepEqual([npc.x, npc.y, npc.pathPos, npc.moveCooldown], pos);
  // Without dormancy it keeps walking.
  const free = World.create(corridor(', simulation: { active_radius: none }', [], [4]), 1);
  const f = free.entities[1]!;
  free.queueIntent({ kind: 'goto', x: 25, y: 2 }, f);
  for (let t = 0; t < 200 && (f.path || f.intent); t++) free.step();
  assert.deepEqual([f.x, f.y], [25, 2]);
  assert.equal(free.activeCount, free.entities.length);
});

test('dormancy: maps smaller than the radius (the garden, fixtures) never have a dormant entity, and play out the same', () => {
  const games: [string, Definition][] = [
    ['garden', loadPacksOrThrow(GAMES.garden.map((d) => readPack(d)))],
    ['fixture', loadPacksOrThrow([fixture()])],
    ['crowd', crowd(40)],
  ];
  for (const [name, def] of games) {
    const a = World.create(def, 9);
    const b = World.create(withSim(def, { activeRadius: null }), 9);
    const input = new Rng(4);
    for (let t = 0; t < 300; t++) {
      if (input.next() < 0.3) {
        const dx = (Math.floor(input.next() * 3) - 1) as -1 | 0 | 1;
        const dy = (Math.floor(input.next() * 3) - 1) as -1 | 0 | 1;
        a.queueIntent({ kind: 'step', dx, dy });
        b.queueIntent({ kind: 'step', dx, dy });
      }
      a.step();
      b.step();
      assert.equal(a.activeCount, a.entities.length, `${name}: dormant entity at tick ${a.tick}`);
    }
    assert.equal(a.hash(), b.hash(), name);
  }
});

test('dormancy round trip: a player walks away from a horde and back again', () => {
  const def = corridor(', simulation: { active_radius: 8 }', [3, 4, 5, 6]);
  const w = World.create(def, 2);
  const walk = (dx: -1 | 1) => (x: World) => x.queueIntent({ kind: 'step', dx, dy: 0 });
  for (let t = 0; t < 40; t++) {
    walk(1)(w);
    w.step();
  }
  assert.ok(w.activeCount < w.entities.length, 'the horde is dormant');
  const copy = assertRoundTrip(w, walk(-1), 60);
  assert.equal(copy.activeCount, copy.entities.length, 'back with the horde');
  assertRoundTrip(copy, walk(1), 40);
});

// ── Bounded A* and region labels ────────────────────────────────────────────

/** Two 10×8 rooms side by side, split by a wall with one door cell at (10, 4) ('+' open, '#' closed). */
function rooms(door: '+' | '#'): World {
  const rows = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 21 }, (_, x) => (y === 0 || y === 9 || x === 0 || x === 20 ? '#' : x === 10 ? (y === 4 ? door : '#') : x === 1 && y === 1 ? '@' : '.')).join(''),
  );
  return World.create(
    loadPacksOrThrow([
      fixture({
        'map.yaml': `maps:
  - id: two
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "+": { tile: floor }
      "@": { tile: floor, player: true }
    rows:
${rows.map((r) => `      - "${r}"`).join('\n')}
start: { map: two, player: hero, simulation: { player_path_budget: 30 } }
`,
      }),
    ]),
    1,
  );
}

test('A*: the node budget cuts a search off (null, like an unreachable goal); counts are deterministic', () => {
  const w = rooms('+');
  const pf = new Pathfinder(w.grid);
  const full = pf.findPath(1, 1, 18, 8)!;
  const need = pf.lastExpanded;
  assert.ok(full.length > 0 && need > 20);
  assert.equal(pf.findPath(1, 1, 18, 8, 0, 0, need - 1), null);
  assert.deepEqual([pf.lastExpanded, pf.lastBudgetHit, pf.lastRegionReject], [need - 1, true, false]);
  assert.deepEqual(pf.findPath(1, 1, 18, 8, 0, 0, need), full, 'the goal popped right at the budget still counts');
  assert.equal(pf.lastExpanded, need);
  // In the world: the player's budget (30 here) applies to its gotos.
  w.queueIntent({ kind: 'goto', x: 18, y: 8 });
  w.step();
  assert.equal(w.lastGoto!.ok, false);
  assert.deepEqual([w.pathStats.budgetHits, w.pathStats.maxPlayerExpanded], [1, 30]);
  w.queueIntent({ kind: 'goto', x: 5, y: 3 });
  w.step();
  assert.equal(w.lastGoto!.ok, true);
});

test('A*: region labels reject a goal in another region without searching; refreshed after set_tile', () => {
  const w = rooms('#');
  const pf = new Pathfinder(w.grid);
  assert.equal(w.grid.regionCount, 2);
  assert.equal(pf.findPath(1, 1, 18, 8), null);
  assert.deepEqual([pf.lastRegionReject, pf.lastExpanded], [true, 0]);
  // adjacent: the wall's walkable neighbours are all in the other room…
  assert.equal(pf.findPathAdjacent(1, 1, 19, 9), null);
  assert.equal(pf.lastRegionReject, true);
  // …but a wall cell between the rooms has neighbours on this side.
  assert.ok(pf.findPathAdjacent(1, 1, 10, 4));
  assert.equal(pf.lastRegionReject, false);
  // Open the door: labels are recomputed on the next query.
  const labels = w.grid.regions();
  w.grid.setTile(w.grid.index(10, 4), w.def.ids.tiles['t:floor']!);
  assert.equal(w.grid.regionCount, 1);
  assert.equal(labels[w.grid.index(1, 1)], labels[w.grid.index(18, 8)]);
  assert.ok(pf.findPath(1, 1, 18, 8));
  w.grid.setTile(w.grid.index(10, 4), w.def.ids.tiles['t:wall']!);
  assert.equal(pf.findPath(1, 1, 18, 8), null);
  assert.equal(pf.lastRegionReject, true);
  // Links join regions across floors.
  const two = World.create(crowd(2), 1);
  assert.equal(two.grid.regionCount, 1);
});

// ── Render-chunk bookkeeping (pure, no Pixi) ────────────────────────────────

test('render chunks: keys, bounds, view and margin', () => {
  const l = chunkLayout(40, 20, 2);
  assert.deepEqual([l.cols, l.rows, chunkCount(l)], [3, 2, 12]);
  assert.equal(chunkKeyOf(l, 17, 3, 1), 7);
  assert.deepEqual(chunkOf(l, 7), { cx: 1, cy: 0, z: 1 });
  assert.equal(chunkKeyOf(l, -5, 99, 7), chunkKeyOf(l, 0, 19, 1), 'clamped into the map');
  const bounds = Array.from({ length: chunkCount(l) }, (_, k) => chunkBounds(l, k));
  // A view inside chunk (1, 0) of floor 0 only.
  const b = bounds[1]!;
  const cx = (b.minX + b.maxX) / 2;
  const cy = b.maxY - 40;
  const { visible, near } = chunksInView(l, bounds, { minX: cx - 1, minY: cy - 1, maxX: cx + 1, maxY: cy + 1 });
  assert.ok(visible.includes(1));
  for (const k of visible) for (const n of [k - 1, k + 1].filter((n) => n >= 0 && chunkOf(l, n).z === chunkOf(l, k).z && chunkOf(l, n).cy === chunkOf(l, k).cy)) assert.ok(near.includes(n), `margin ${n} around ${k}`);
  assert.ok(near.length > visible.length);
});

test('render chunks: the LRU builds what is needed and evicts the least recently needed', () => {
  assert.equal(MAX_BUILT_CHUNKS, 160);
  const lru = new ChunkLru(3);
  assert.deepEqual(lru.update([1, 2, 3]), { build: [1, 2, 3], evict: [] });
  assert.deepEqual(lru.update([2, 3]), { build: [], evict: [] });
  assert.deepEqual(lru.update([4]), { build: [4], evict: [1] });
  assert.deepEqual(lru.update([2, 5]), { build: [5], evict: [3] });
  assert.deepEqual(lru.keys(), [4, 2, 5]);
  // Needing more than the cap keeps every needed chunk.
  assert.deepEqual(lru.update([6, 7, 8, 9]), { build: [6, 7, 8, 9], evict: [4, 2, 5] });
  assert.equal(lru.size, 4);
  assert.ok(lru.has(9) && !lru.has(2));
});

test('render chunks: entity and pile sprites exist only in built, visible chunks', () => {
  const l = chunkLayout(64, 64, 1);
  const built = new Set([0, 1, 5]);
  const visible = new Set([1, 5, 6]);
  assert.equal(inShownChunk(l, built, visible, 20, 3, 0), true); // chunk 1
  assert.equal(inShownChunk(l, built, visible, 3, 3, 0), false); // built, not visible
  assert.equal(inShownChunk(l, built, visible, 40, 20, 0), false); // visible, not built
  // Created when they enter, destroyed when they leave; the rest are kept.
  assert.deepEqual(spriteDiff([1, 2, 3], [2, 3, 4, 0]), { create: [0, 4], destroy: [1] });
  assert.deepEqual(spriteDiff([], []), { create: [], destroy: [] });
});

// ── Perf line and terminal status ───────────────────────────────────────────

test('perf HUD: samples over the last 100, fps and the F3 line', () => {
  const s = new Samples(100);
  for (let i = 1; i <= 150; i++) s.push(i);
  assert.equal(s.length, 100);
  assert.equal(s.avg(), 100.5); // 51..150
  assert.equal(s.percentile(95), 145);
  const m = new PerfMeter();
  for (let t = 0; t <= 1000; t += 20) m.frame(t);
  assert.equal(Math.round(m.fps), 50);
  assert.equal(
    perfLine({ tickAvg: 0.234, tickP95: 0.5, fps: 59.6, active: 300, dormant: 661, builtChunks: 40, visibleChunks: 18 }),
    'tick 0.23/0.50 ms (avg/p95)  60 fps  entities 300 active, 661 dormant  chunks 40 built, 18 visible',
  );
});

// ── The big maps ────────────────────────────────────────────────────────────

const CITY = loadPacksOrThrow(GAMES.zombie.map((d) => readPack(d)));
const ESTATE = loadPacksOrThrow(GAMES.vampire.map((d) => readPack(d)));

test('genre maps: the zombie city and the vampire estate are composites of their old maps and parts', () => {
  const city = CITY.maps[CITY.start.map]!;
  assert.equal(city.id, 'town:city');
  assert.ok(city.composite && city.width >= 240 && city.height >= 240, `${city.width}×${city.height}`);
  const estate = ESTATE.maps[ESTATE.start.map]!;
  assert.equal(estate.id, 'vamp:estate');
  assert.ok(estate.composite && estate.width >= 96 && estate.height >= 96);
  // GENRE_AT is where the old maps sit: their cells match, floor by floor.
  for (const [def, map, part, at] of [
    [CITY, city, 'town:town_center', GENRE_AT.zombie],
    [ESTATE, estate, 'vamp:mansion', GENRE_AT.vampire],
  ] as const) {
    const p = def.maps[def.ids.maps[part]!]!;
    for (let z = 0; z < p.floors; z++)
      for (let y = 0; y < p.height; y++)
        for (let x = 0; x < p.width; x++) assert.equal(map.cells[(z * map.height + y + at.y) * map.width + x + at.x], p.cells[(z * p.height + y) * p.width + x], `${part} ${x},${y},${z}`);
  }
  const zw = World.create(CITY, 1);
  assert.ok(zw.entities.length >= 900 && zw.entities.length <= 1100, `${zw.entities.length} entities`);
  const kinds = new Map<string, number>();
  for (const e of zw.entities) kinds.set(e.archetype.id, (kinds.get(e.archetype.id) ?? 0) + 1);
  assert.ok(kinds.get('zmb:shambler')! > kinds.get('zmb:crawler')! && kinds.get('zmb:crawler')! > 0);
  // The start stays clear for a while: nothing populated near the player.
  const p = zw.player;
  assert.ok(zw.entitiesNear(p.x, p.y, 0, 12).every((e) => e === p || e.id < 1 + city.spawns.length), 'only town_center spawns near the start');
  assert.ok(ESTATE.maps[ESTATE.start.map]!.spawns.length >= 1);
  assert.ok(World.create(ESTATE, 1).entities.length >= 150);
});

/** Walkable cells off the player's region that are allowed (decorative, no container); none so far. */
const ISOLATED: Record<string, readonly string[]> = { zombie: [], vampire: [] };

test('genre maps: every walkable cell and container is reachable from the player start (region labels)', () => {
  for (const [name, def] of [
    ['zombie', CITY],
    ['vampire', ESTATE],
  ] as const) {
    const w = World.create(def, 1);
    const g = w.grid;
    const labels = g.regions();
    const home = labels[g.index(w.player.x, w.player.y, w.player.z)]!;
    const off: string[] = [];
    for (let i = 0; i < g.cells.length; i++) {
      if (g.walk[i] !== 1 || labels[i] === home) continue;
      const { x, y, z } = g.cellOf(i);
      off.push(`${x},${y},${z}`);
    }
    assert.deepEqual(off, ISOLATED[name], `${name}: walkable cells off the start region`);
    for (const c of w.containers.values()) {
      if (c.kind !== 'tile') continue;
      let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) ok = g.walkable(c.x + dx, c.y + dy, c.z) && labels[g.index(c.x + dx, c.y + dy, c.z)] === home;
      assert.ok(ok, `${name}: container at ${c.x},${c.y},${c.z} is unreachable`);
    }
    // Every door joins the start region (in the city: the roads too).
    for (let i = 0; i < g.cells.length; i++) {
      const id = def.tiles[g.cells[i]!]?.id;
      if (id === 'std:door' || id === 'town:road') assert.equal(labels[i], home, `${name}: ${id} at ${JSON.stringify(g.cellOf(i))}`);
    }
  }
});

test('perf guard (city): only active NPCs think, no A* search exceeds its budget', () => {
  const w = World.create(CITY, 1);
  const sim = CITY.start.simulation;
  let expected = 0;
  const thinks = w.thinkCalls;
  for (let t = 0; t < 100; t++) {
    if (t % 10 === 0) w.queueIntent({ kind: 'goto', x: w.player.x + 30, y: w.player.y - 20 });
    for (const e of w.entities) if (e.behavior && !w.isDormant(e)) expected++;
    w.step();
  }
  assert.equal(w.thinkCalls - thinks, expected);
  assert.ok(expected < 100 * (w.entities.length - 1), 'some NPCs are dormant');
  assert.ok(w.pathStats.maxNpcExpanded <= sim.npcPathBudget && w.pathStats.maxPlayerExpanded <= sim.playerPathBudget, JSON.stringify(w.pathStats));
  assert.ok(simStatus(w).startsWith('active '), 'the terminal shows the counts');
  assert.equal(simStatus(World.create(loadPacksOrThrow([fixture()]), 1)), '');
});

test('saves (city): round trip with dormant NPCs, continuing 300 ticks', () => {
  const w = World.create(CITY, 3);
  const route = (x: World) => {
    if (x.tick % 40 === 0) x.queueIntent({ kind: 'goto', x: x.player.x - 20, y: x.player.y + 25 });
  };
  for (let t = 0; t < 30; t++) {
    route(w);
    w.step();
  }
  assert.ok(w.activeCount < w.entities.length, 'dormant NPCs present');
  assertRoundTrip(w, route, 300);
});
