import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSeq, parseDocument } from 'yaml';
import { EMPTY_TILE, formatError, loadPacks, loadPacksOrThrow, type Definition, type LoadError, type PackSource } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { exportTiledMap, findMap } from '../scripts/map-export.ts';
import { fixture, GAMES, pack } from './helpers.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

type J = { [k: string]: unknown };

const prop = (name: string, value: string) => ({ name, type: 'string', value });

/** Embedded tileset: 1 floor, 2 wall, 3 wall facing e, 4 (no `tile` property). */
function tileset(extra: J = {}): J {
  return {
    name: 'ts',
    tilecount: 4,
    tiles: [
      { id: 0, properties: [prop('tile', 'floor')] },
      { id: 1, properties: [prop('tile', 't:wall')] },
      { id: 2, properties: [prop('facing', 'e'), prop('tile', 'wall')] },
      { id: 3, properties: [] },
    ],
    ...extra,
  };
}

/** A 3×2 orthogonal map (16 px tiles) with a player at (1, 0). */
function tmj(extra: J = {}): J {
  return {
    orientation: 'orthogonal',
    infinite: false,
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    tilesets: [{ firstgid: 1, ...tileset() }],
    layers: [
      { type: 'tilelayer', name: 'ground', width: 3, height: 2, visible: true, data: [2, 1, 2, 2, 1, 3] },
      { type: 'objectgroup', name: 'objects', visible: true, objects: [{ id: 1, type: 'player', x: 24, y: 8, rotation: 0 }] },
    ],
    ...extra,
  };
}

const MAP_YAML = `maps:
  - id: room
    tiled: maps/room.tmj
start:
  map: room
  player: hero
`;

function tiledPack(map: J | string, files: Record<string, string> = {}, yaml = MAP_YAML): PackSource {
  return fixture({ 'map.yaml': yaml, 'maps/room.tmj': typeof map === 'string' ? map : JSON.stringify(map), ...files });
}

function load(map: J | string, files: Record<string, string> = {}, yaml = MAP_YAML): Definition {
  const r = loadPacks([tiledPack(map, files, yaml)]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition;
}

function errorsOf(map: J | string, files: Record<string, string> = {}, yaml = MAP_YAML): readonly LoadError[] {
  const r = loadPacks([tiledPack(map, files, yaml)]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], file: string, path: string, message: RegExp): void {
  const hit = errors.find((e) => e.pack === 't' && e.file === file && e.path === path && message.test(e.message));
  assert.ok(hit, `no error ${file} ${path}: ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

const tile = (def: Definition, id: string) => def.ids.tiles[id]!;
const ground = (data: unknown, extra: J = {}) => ({ type: 'tilelayer', name: 'ground', width: 3, height: 2, visible: true, data, ...extra });
const objects = (objs: J[], extra: J = {}) => ({ type: 'objectgroup', name: 'objects', visible: true, objects: objs, ...extra });
const PLAYER = { id: 1, type: 'player', x: 24, y: 8 };

// ── Loader: accepted variants ───────────────────────────────────────────────

test('tiled: orthogonal map with an embedded tileset', () => {
  const def = load(tmj());
  const m = def.maps[def.start.map]!;
  const [f, w] = [tile(def, 't:floor'), tile(def, 't:wall')];
  assert.equal(m.width, 3);
  assert.equal(m.height, 2);
  assert.equal(m.floors, 1);
  assert.deepEqual(m.cells, [w, f, w, w, f, w]);
  assert.deepEqual(m.facings, [null, null, null, null, null, 'e']);
  assert.deepEqual(m.playerStart, { x: 1, y: 0, z: 0 });
  assert.deepEqual(m.spawns, []);
  assert.deepEqual(m.rooms.rects, []);
});

test('tiled: isometric object positions are in tile-height units on both axes', () => {
  const def = load(
    tmj({
      orientation: 'isometric',
      tilewidth: 64,
      tileheight: 32,
      layers: [ground([1, 1, 1, 1, 1, 1]), objects([{ id: 1, type: 'player', x: 80, y: 40 }, { id: 2, type: 'room', x: 32, y: 0, width: 64, height: 64, properties: [prop('tags', 'den')] }])],
    }),
  );
  const m = def.maps[0]!;
  assert.deepEqual(m.playerStart, { x: 2, y: 1, z: 0 });
  assert.deepEqual(m.rooms.rects, [{ x: 1, y: 0, z: 0, w: 2, h: 2, tags: [0] }]);
  assert.deepEqual(def.roomTags, ['den']);
});

test('tiled: YAML `rooms` are added to the Tiled room objects (a mod can tag a part)', () => {
  const yaml = `maps:
  - id: room
    tiled: maps/room.tmj
    rooms:
      - { rect: [0, 1, 3, 1], tags: [den, lab] }
start:
  map: room
  player: hero
`;
  const def = load(tmj({ layers: [ground([1, 1, 1, 1, 1, 1]), objects([PLAYER, { id: 2, type: 'room', x: 16, y: 0, width: 32, height: 16, properties: [prop('tags', 'den')] }])] }), {}, yaml);
  const m = def.maps[0]!;
  assert.deepEqual(def.roomTags, ['den', 'lab']);
  assert.deepEqual(m.rooms.rects, [
    { x: 1, y: 0, z: 0, w: 2, h: 1, tags: [0] },
    { x: 0, y: 1, z: 0, w: 3, h: 1, tags: [0, 1] },
  ]);
  // A room out of the Tiled map's bounds is still an error, naming the YAML field.
  const e = errorsOf(tmj({ layers: [ground([1, 1, 1, 1, 1, 1]), objects([PLAYER])] }), {}, yaml.replace('[0, 1, 3, 1]', '[0, 1, 4, 1]'));
  assert.ok(e.some((x) => x.path === 'maps[0].rooms[0].rect'), e.map(formatError).join('\n'));
});

test('tiled: external .tsj tileset resolved relative to the map', () => {
  const map = tmj({ tilesets: [{ firstgid: 1, source: '../tilesets/t.tsj' }] });
  const def = load(map, { 'tilesets/t.tsj': JSON.stringify({ type: 'tileset', ...tileset() }) });
  assert.deepEqual(def.maps[0]!.facings[5], 'e');
  assert.equal(def.maps[0]!.cells[1], tile(def, 't:floor'));
});

test('tiled: base64 (uncompressed) layer data', () => {
  const gids = [2, 1, 2, 2, 1, 3];
  const bytes = gids.flatMap((g) => [g & 255, (g >> 8) & 255, (g >> 16) & 255, (g >>> 24) & 255]);
  const data = btoa(String.fromCharCode(...bytes));
  const def = load(tmj({ layers: [ground(data, { encoding: 'base64', compression: '' }), objects([PLAYER])] }));
  assert.deepEqual(def.maps[0]!.cells, load(tmj()).maps[0]!.cells);
});

test('tiled: top-most non-empty gid wins; hidden layers are ignored; groups are flattened', () => {
  const [f, w] = [1, 2];
  const def = load(
    tmj({
      layers: [
        ground([f, f, f, f, f, f]),
        { type: 'group', name: 'g', layers: [ground([0, w, 0, 0, 0, 0]), { type: 'group', name: 'inner', layers: [ground([0, 0, 0, 0, 0, 3])] }] },
        ground([w, w, w, w, w, w], { visible: false }),
        { type: 'group', name: 'hidden', visible: false, layers: [ground([w, w, w, w, w, w])] },
        objects([PLAYER]),
      ],
    }),
  );
  const [F, W] = [tile(def, 't:floor'), tile(def, 't:wall')];
  assert.deepEqual(def.maps[0]!.cells, [F, W, F, F, F, W]);
  assert.deepEqual(def.maps[0]!.facings, [null, null, null, null, null, 'e']);
});

test('tiled: objects match by type or class; untyped objects and hidden object layers are ignored', () => {
  const def = load(
    tmj({
      layers: [
        ground([1, 1, 1, 1, 1, 1]),
        objects([
          { id: 1, class: 'player', x: 24, y: 8 },
          { id: 2, type: '', class: 'spawn', x: 8, y: 24, properties: [prop('archetype', 'rock')] },
          { id: 3, name: 'a note', x: 0, y: 0 },
        ]),
        objects([{ id: 4, type: 'bogus', x: 0, y: 0 }], { visible: false }),
      ],
    }),
  );
  assert.deepEqual(def.maps[0]!.playerStart, { x: 1, y: 0, z: 0 });
  assert.deepEqual(def.maps[0]!.spawns, [{ x: 0, y: 1, z: 0, archetype: def.ids.archetypes['t:rock'] }]);
});

test('tiled: spawn order is row-major then object id, whatever the file order', () => {
  const rock = (id: number, x: number, y: number) => ({ id, type: 'spawn', x: x * 16 + 8, y: y * 16 + 8, properties: [prop('archetype', 't:rock')] });
  const objs = [rock(5, 2, 1), rock(4, 0, 1), rock(9, 1, 0), rock(3, 1, 0), PLAYER];
  const a = load(tmj({ layers: [ground([1, 1, 1, 1, 1, 1]), objects(objs)] }));
  const b = load(tmj({ layers: [ground([1, 1, 1, 1, 1, 1]), objects([...objs].reverse())] }));
  const cells = (d: Definition) => d.maps[0]!.spawns.map((s) => [s.x, s.y]);
  assert.deepEqual(cells(a), [[1, 0], [1, 0], [0, 1], [2, 1]]);
  assert.deepEqual(a.maps[0]!.spawns, b.maps[0]!.spawns);
});

test('tiled: rooms take comma- or space-separated tags', () => {
  const room = (id: number, tags: string, x: number) => ({ id, type: 'room', x: x * 16, y: 0, width: 16, height: 32, properties: [prop('tags', tags)] });
  const def = load(tmj({ layers: [ground([1, 1, 1, 1, 1, 1]), objects([PLAYER, room(2, 'kitchen, den', 0), room(3, 'den  attic', 2)])] }));
  assert.deepEqual(def.roomTags, ['kitchen', 'den', 'attic']);
  assert.deepEqual(def.maps[0]!.rooms.rects, [
    { x: 0, y: 0, z: 0, w: 1, h: 2, tags: [0, 1] },
    { x: 2, y: 0, z: 0, w: 1, h: 2, tags: [1, 2] },
  ]);
});

test('tiled: unreferenced .tmj/.tsj files are ignored', () => {
  const def = loadPacksOrThrow([fixture({ 'stray.tmj': '{ not json', 'x/stray.tsj': '' })]);
  assert.equal(def.maps.length, 1);
});

// ── Loader: errors ──────────────────────────────────────────────────────────

const T = 'maps/room.tmj';

test('tiled errors: the YAML map entry', () => {
  let e = errorsOf(tmj(), {}, MAP_YAML.replace('    tiled:', '    rows: ["."]\n    tiled:'));
  assert.ok(e.some((x) => x.file === 'map.yaml' && x.path === 'maps[0].tiled' && /either the ASCII fields .* or 'tiled', not both \(remove 'rows'\)/.test(x.message)), e.map(formatError).join('\n'));
  e = errorsOf(tmj(), {}, MAP_YAML.replace('maps/room.tmj', 'maps/rom.tmj'));
  assert.ok(e.some((x) => x.path === 'maps[0].tiled' && /Tiled map 'maps\/rom.tmj' not found .*did you mean 'maps\/room.tmj'/.test(x.message)));
  e = errorsOf(tmj(), {}, MAP_YAML.replace('maps/room.tmj', 'maps/room.tmx'));
  assert.ok(e.some((x) => x.path === 'maps[0].tiled' && /TMX \(XML\).*File → Export As… → JSON map files/.test(x.message)));
});

test('tiled errors: map settings', () => {
  const e = errorsOf(tmj({ infinite: true, orientation: 'staggered' }));
  expectError(e, T, 'infinite', /disable 'Infinite' in Map Properties/);
  expectError(e, T, 'orientation', /staggered maps are not supported/);
  expectError(errorsOf(tmj({ orientation: 'hexagonal' })), T, 'orientation', /hexagonal maps are not supported/);
  expectError(errorsOf('{ nope'), T, '', /invalid JSON/);
});

test('tiled errors: name the YAML map entry', () => {
  const e = errorsOf(tmj({ infinite: true }));
  expectError(e, T, 'infinite', /\[in map 't:room', from map\.yaml:3 maps\[0\]\.tiled\]$/);
});

test('tiled errors: tilesets', () => {
  expectError(errorsOf(tmj({ tilesets: [{ firstgid: 1, source: 't.tsx' }] })), T, 'tilesets[0].source', /TSX \(XML\).*Export As/);
  expectError(
    errorsOf(tmj({ tilesets: [{ firstgid: 1, source: 'tt.tsj' }] }), { 'maps/t.tsj': JSON.stringify(tileset()) }),
    T,
    'tilesets[0].source',
    /'tt.tsj' not found .*did you mean 'maps\/t.tsj'/,
  );
  // A used tile with no `tile` property, in an external tileset.
  let e = errorsOf(tmj({ tilesets: [{ firstgid: 1, source: 't.tsj' }], layers: [ground([1, 1, 4, 1, 1, 1]), objects([PLAYER])] }), { 'maps/t.tsj': JSON.stringify(tileset()) });
  expectError(e, 'maps/t.tsj', 'tiles[3]', /tileset 'ts' tile 3 has no string property 'tile'.*first used at maps\/room.tmj layers\[0\]\.data\[2\] \(cell 2, 0\)/);
  // Unknown tile id with a suggestion; bad and diagonal facings.
  const bad = tileset({
    tiles: [
      { id: 0, properties: [prop('tile', 'flor')] },
      { id: 1, properties: [prop('facing', 'up'), prop('tile', 'wall')] },
      { id: 2, properties: [prop('facing', 'ne'), prop('tile', 'wall')] },
    ],
  });
  e = errorsOf(tmj({ tilesets: [{ firstgid: 1, ...bad }] }));
  expectError(e, T, 'tilesets[0].tiles[0].properties[0].value', /unknown tile 'flor' \(did you mean 'floor'\?\)/);
  expectError(e, T, 'tilesets[0].tiles[1].properties[0].value', /'facing' must be one of n, e, s, w, got "up"/);
  expectError(e, T, 'tilesets[0].tiles[2].properties[0].value', /diagonals are not allowed/);
});

test('tiled errors: tile layers', () => {
  expectError(errorsOf(tmj({ layers: [ground('AAAA', { encoding: 'base64', compression: 'zlib' }), objects([PLAYER])] })), T, 'layers[0].compression', /'zlib'.*Tile Layer Format/);
  expectError(errorsOf(tmj({ layers: [ground([1, 1, 1, 1, 0x80000002, 1]), objects([PLAYER])] })), T, 'layers[0].data[4]', /flipped or rotated tile .*\(cell 1, 1\).*'facing'/);
  expectError(errorsOf(tmj({ layers: [ground([1, 1, 1, 1, 1, 9]), objects([PLAYER])] })), T, 'layers[0].data[5]', /gid 9 is outside every tileset \(cell 2, 1\)/);
  expectError(errorsOf(tmj({ layers: [ground([1, 1, 1]), objects([PLAYER])] })), T, 'layers[0].data', /3 cells, expected 6/);
});

test('tiled errors: objects', () => {
  const layers = (objs: J[]) => tmj({ layers: [ground([1, 1, 1, 1, 1, 1]), objects(objs)] });
  expectError(errorsOf(layers([PLAYER, { id: 2, type: 'spwan', x: 0, y: 0 }])), T, 'layers[1].objects[1].type', /unknown object class 'spwan' \(did you mean 'spawn'\?\)/);
  expectError(errorsOf(layers([PLAYER, { id: 2, class: 'rooom', x: 0, y: 0 }])), T, 'layers[1].objects[1].class', /did you mean 'room'/);
  expectError(errorsOf(layers([{ ...PLAYER, rotation: 45 }])), T, 'layers[1].objects[0].rotation', /rotated objects are not supported/);
  expectError(errorsOf(layers([PLAYER, { id: 2, type: 'player', x: 0, y: 0 }])), T, 'layers[1].objects[1]', /more than one player object \(cell 0, 0\)/);
  expectError(errorsOf(layers([PLAYER, { id: 2, type: 'spawn', x: 60, y: 8, properties: [prop('archetype', 'rock')] }])), T, 'layers[1].objects[1]', /spawn object is outside the map \(cell 3, 0\)/);
  expectError(errorsOf(layers([{ ...PLAYER, x: -1 }])), T, 'layers[1].objects[0]', /player object is outside the map/);
  expectError(errorsOf(layers([PLAYER, { id: 2, type: 'spawn', x: 8, y: 8 }])), T, 'layers[1].objects[1]', /spawn needs a string property 'archetype' \(cell 0, 0\)/);
  expectError(errorsOf(layers([PLAYER, { id: 2, type: 'spawn', x: 8, y: 8, properties: [prop('archetype', 'rok')] }])), T, 'layers[1].objects[1].properties[0].value', /unknown archetype 'rok' \(did you mean 'rock'\?\) \(cell 0, 0\)/);
  const room = (x: number, w: number, tags = 'den') => ({ id: 2, type: 'room', x, y: 0, width: w, height: 16, properties: [prop('tags', tags)] });
  expectError(errorsOf(layers([PLAYER, room(32, 32)])), T, 'layers[1].objects[1]', /room rect \[2, 0, 2, 1\] is out of bounds: the map is 3×2/);
  expectError(errorsOf(layers([PLAYER, room(0, 4)])), T, 'layers[1].objects[1]', /room rect \[0, 0, 0, 1\] is empty/);
  expectError(errorsOf(layers([PLAYER, room(0, 16, 'Den')])), T, 'layers[1].objects[1].properties[0].value', /invalid tag 'Den'/);
  expectError(errorsOf(layers([PLAYER, room(0, 16, ' , ')])), T, 'layers[1].objects[1].properties[0].value', /at least one tag/);
  expectError(errorsOf(layers([PLAYER, { id: 2, type: 'room', x: 0, y: 0, width: 16, height: 16 }])), T, 'layers[1].objects[1]', /room needs a string property 'tags'/);
});

test('tiled errors: the start map needs a player object', () => {
  const e = errorsOf(tmj({ layers: [ground([1, 1, 1, 1, 1, 1])] }));
  assert.ok(e.some((x) => x.file === 'map.yaml' && /has no player start cell \(a 'player' object/.test(x.message)));
});

// ── Floors ──────────────────────────────────────────────────────────────────

const STAIRS_TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: stairs, label: Stairs, glyph: "<", color: white, walkable: true, raised: true, opaque: false, climb: up }
`;
/** Tileset gid 5 = stairs (after the 4 of `tileset()`). */
const STAIRS_TS = { firstgid: 5, name: 'more', tilecount: 1, tiles: [{ id: 0, properties: [prop('tile', 'stairs')] }] };
const floorGroup = (z: unknown, layers: J[], extra: J = {}) => ({ type: 'group', name: `floor ${String(z)}`, visible: true, layers, properties: [{ name: 'floor', type: 'int', value: z }], ...extra });
const floorsMap = (layers: J[]) => tmj({ tilesets: [{ firstgid: 1, ...tileset() }, STAIRS_TS], layers });

test('tiled floors: floor groups hold their tile and object layers; empty cells; outside layers are floor 0', () => {
  const def = load(
    floorsMap([
      ground([2, 1, 2, 2, 5, 2]),
      objects([PLAYER]),
      floorGroup(1, [
        ground([0, 1, 0, 0, 1, 0]),
        objects([
          { id: 2, type: 'spawn', x: 24, y: 24, properties: [prop('archetype', 'rock')] },
          { id: 3, type: 'room', x: 16, y: 0, width: 16, height: 32, properties: [prop('tags', 'attic')] },
        ]),
      ]),
    ]),
    { 'tiles.yaml': STAIRS_TILES },
  );
  const m = def.maps[0]!;
  const [f, w, st] = [tile(def, 't:floor'), tile(def, 't:wall'), tile(def, 't:stairs')];
  assert.equal(m.floors, 2);
  assert.deepEqual(m.cells, [w, f, w, w, st, w, EMPTY_TILE, f, EMPTY_TILE, EMPTY_TILE, f, EMPTY_TILE]);
  assert.deepEqual(m.playerStart, { x: 1, y: 0, z: 0 });
  assert.deepEqual(m.spawns, [{ x: 1, y: 1, z: 1, archetype: def.ids.archetypes['t:rock'] }]);
  assert.deepEqual(m.rooms.rects, [{ x: 1, y: 0, z: 1, w: 1, h: 2, tags: [0] }]);
  // A floor-0 group and layers outside any group merge (the top-most layer wins).
  const merged = load(floorsMap([floorGroup(0, [ground([1, 1, 1, 1, 1, 1])]), ground([0, 2, 0, 0, 0, 0]), objects([PLAYER])]));
  assert.equal(merged.maps[0]!.floors, 1);
  assert.deepEqual(merged.maps[0]!.cells, [1, 2, 1, 1, 1, 1].map((g) => (g === 1 ? tile(merged, 't:floor') : tile(merged, 't:wall'))));
});

test('tiled floors errors: numbering, nesting and links', () => {
  const T = 'maps/room.tmj';
  const files = { 'tiles.yaml': STAIRS_TILES };
  const g = (z: unknown) => floorGroup(z, [ground([1, 1, 1, 1, 1, 1])]);
  expectError(errorsOf(floorsMap([g(0), g(2), objects([PLAYER])]), files), T, 'layers', /numbered 0, 1, 2, … without gaps: floor 1 is missing/);
  expectError(errorsOf(floorsMap([g(0), g(1), g(1), objects([PLAYER])]), files), T, 'layers[2].properties[0].value', /duplicate floor group 1 \(already at layers\[1\]\)/);
  expectError(errorsOf(floorsMap([floorGroup(0, [g(1)]), objects([PLAYER])]), files), T, 'layers[0].layers[0].properties[0].value', /floor group 1 is nested inside another floor group/);
  expectError(errorsOf(floorsMap([g(-1), objects([PLAYER])]), files), T, 'layers[0].properties[0].value', /'floor' must be an integer ≥ 0, got -1/);
  expectError(errorsOf(floorsMap([g('one'), objects([PLAYER])]), files), T, 'layers[0].properties[0].value', /got "one"/);
  // Stairs on the top floor, or under a wall or an empty cell: errors at the YAML map entry.
  expectError(errorsOf(floorsMap([ground([1, 5, 1, 1, 1, 1]), objects([PLAYER])]), files), 'map.yaml', 'maps[0].tiled', /'t:stairs' at \(1, 0, floor 0\) climbs up to \(1, 0, floor 1\), which is outside the map \(it has 1 floor\)/);
  expectError(errorsOf(floorsMap([ground([1, 5, 1, 1, 1, 1]), objects([PLAYER]), floorGroup(1, [ground([1, 2, 1, 1, 1, 1])])]), files), 'map.yaml', 'maps[0].tiled', /which is 't:wall' \(not walkable\)/);
  expectError(errorsOf(floorsMap([ground([1, 5, 1, 1, 1, 1]), objects([PLAYER]), floorGroup(1, [ground([1, 0, 1, 1, 1, 1])])]), files), 'map.yaml', 'maps[0].tiled', /which is an empty cell/);
});

test('exporter: round trip of a multi-floor ASCII map; one floor N group per floor', () => {
  const files = {
    'tiles.yaml': STAIRS_TILES,
    'map.yaml': `maps:
  - id: house
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "<": { tile: stairs, facing: w }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
    floors:
      - rows: ["###", "#@<", "#.."]
      - rows: [" o ", "##.", "  ."]
    rooms:
      - { rect: [1, 1, 2, 2], tags: [den] }
      - { rect: [2, 1, 1, 2], tags: [attic], floor: 1 }
start: { map: house, player: hero }
`,
  };
  roundTrip([fixture(files)]);
  const def = loadPacksOrThrow([fixture(files)]);
  const m = JSON.parse(exportTiledMap(def, def.maps[0]!, { name: 'house', image: () => null }).tmj) as J;
  const layers = m['layers'] as J[];
  assert.deepEqual(layers.map((l) => [l['name'], l['type'], l['properties']]), [
    ['floor 0', 'group', [{ name: 'floor', type: 'int', value: 0 }]],
    ['floor 1', 'group', [{ name: 'floor', type: 'int', value: 1 }]],
  ]);
  assert.deepEqual((layers[1]!['layers'] as J[]).map((l) => l['name']), ['ground', 'objects']);
  assert.equal(((layers[1]!['layers'] as J[])[0]!['data'] as number[])[0], 0, 'empty cells are gid 0');
});

// ── Exporter ────────────────────────────────────────────────────────────────

const RT_DIR = '__rt';

/** Replace map `local`'s YAML entry with `{ id, tiled }` in whichever file defines it. */
function rewriteEntry(files: Record<string, string>, local: string, tiled: string): Record<string, string> {
  const out = { ...files };
  for (const [f, text] of Object.entries(files)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const doc = parseDocument(text);
    const maps = doc.get('maps', true);
    if (!isSeq(maps)) continue;
    const i = maps.items.findIndex((m) => (m as { get?: (k: string) => unknown }).get?.('id') === local);
    if (i < 0) continue;
    // A plain map keeps its own populate; a composite is flattened (see `roundTrip`).
    const entry = maps.items[i] as { get?: (k: string) => unknown; toJSON?: () => Record<string, unknown> };
    const populate = entry.get?.('size') === undefined ? (entry.toJSON?.()['populate'] as unknown) : undefined;
    doc.setIn(['maps', i], doc.createNode(populate === undefined ? { id: local, tiled } : { id: local, tiled, populate }));
    out[f] = doc.toString();
    return out;
  }
  throw new Error(`no YAML entry for map '${local}'`);
}

/** Export every map, load each back through `tiled`, and compare the MapDefs. */
function roundTrip(sources: PackSource[]): void {
  const def = loadPacksOrThrow(sources);
  // A map a mod patched is exported with the mod's fields, which do not belong in its own pack's file.
  const patched = new Set(def.patches.filter((p) => p.domain === 'maps').map((p) => p.id));
  for (const map of def.maps) {
    if (patched.has(map.id)) continue;
    const [ns, local] = map.id.split(':') as [string, string];
    const at = def.packs.findIndex((p) => p.namespace === ns);
    const name = `rt_${local}`;
    const first = exportTiledMap(def, map, { name, image: (_a, file) => `img/${file}` });
    const files = rewriteEntry(sources[at]!.files, local, `${RT_DIR}/${name}.tmj`);
    files[`${RT_DIR}/${name}.tmj`] = first.tmj;
    files[`${RT_DIR}/${name}.tsj`] = first.tsj;
    const replaced = sources.map((s, i) => (i === at ? { ...s, files } : s));
    const r = loadPacks(replaced);
    assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
    const back = r.definition;
    if (map.composite) {
      // A composite exports as the plain map it composes: the same cells, but spawns and rooms come back
      // per floor (a plain map's order), and its populate entries (resolved from its parts) live in YAML only.
      const b = back.maps[map.index]!;
      const sorted = (xs: readonly unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
      assert.deepEqual([b.width, b.height, b.floors, b.playerStart, b.composite], [map.width, map.height, map.floors, map.playerStart, false]);
      assert.ok(JSON.stringify(b.cells) === JSON.stringify(map.cells) && JSON.stringify(b.facings) === JSON.stringify(map.facings), `cells of ${map.id}`);
      assert.deepEqual(sorted(b.spawns), sorted(map.spawns), `spawns of ${map.id}`);
      assert.deepEqual(sorted(b.rooms.rects), sorted(map.rooms.rects), `rooms of ${map.id}`);
      continue;
    }
    assert.deepEqual(back.maps[map.index], map, `round trip of ${map.id}`);
    assert.deepEqual(back.roomTags, def.roomTags);
    // Byte-stable: the same map exports to the same files, also after the round trip.
    assert.equal(exportTiledMap(def, map, { name, image: (_a, file) => `img/${file}` }).tmj, first.tmj);
    const again = exportTiledMap(back, back.maps[map.index]!, { name, image: (_a, file) => `img/${file}` });
    assert.equal(again.tmj, first.tmj);
    assert.equal(again.tsj, first.tsj);
  }
}

test('exporter: round trip of every shipped map', () => {
  for (const dirs of Object.values(GAMES)) roundTrip(dirs.map(readPack));
});

test('exporter: round trip of fixture maps (facings, rooms, spawns, other namespaces)', () => {
  roundTrip([fixture()]);
  const base = pack('base', {
    'pack.yaml': 'namespace: base\nname: Base\nversion: 1\n',
    'tiles.yaml': `tiles:
  - { id: floor, label: F, glyph: ".", color: white, walkable: true }
  - { id: crate, label: C, glyph: x, color: brown, walkable: false }
`,
  });
  const game = pack('game', {
    'pack.yaml': 'namespace: game\nname: Game\nversion: 1\ndepends: [base]\n',
    'game.yaml': `tiles:
  - { id: wall, label: W, glyph: "#", color: gray, walkable: false }
archetypes:
  - { id: hero, label: H, glyph: "@", color: yellow, ticks_per_turn: 0 }
  - { id: rat, label: R, glyph: r, color: gray, ticks_per_turn: 0 }
maps:
  - id: one
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "e": { tile: wall, facing: e }
      "s": { tile: wall, facing: s }
      "x": { tile: base:crate, facing: n }
      "@": { tile: floor, player: true }
      "r": { tile: floor, spawn: rat }
    rows:
      - "#e#s#"
      - "#r@x#"
      - "#.rr#"
    rooms:
      - { rect: [1, 1, 3, 2], tags: [cellar, dark] }
      - { rect: [1, 1, 1, 1], tags: [dark] }
  - id: two
    legend: { ".": { tile: floor }, "r": { tile: floor, spawn: rat } }
    rows: ["r.", ".r"]
    rooms:
      - { rect: [0, 0, 2, 2], tags: [attic] }
start: { map: one, player: hero }
`,
  });
  roundTrip([base, game]);
});

test('exporter: writes an isometric 64×32 map with a relative external tileset', () => {
  const def = loadPacksOrThrow([fixture()]);
  const map = findMap(def, 'room');
  assert.ok(typeof map !== 'string');
  const { tmj: text, tsj } = exportTiledMap(def, map, { name: 'room', image: () => null });
  const m = JSON.parse(text) as J;
  assert.equal(m['orientation'], 'isometric');
  assert.equal(m['tilewidth'], 64);
  assert.equal(m['tileheight'], 32);
  assert.deepEqual(m['tilesets'], [{ firstgid: 1, source: 'room.tsj' }]);
  assert.deepEqual(Object.keys(m).slice(0, 4), ['compressionlevel', 'height', 'infinite', 'layers']);
  const layers = m['layers'] as J[];
  assert.deepEqual(layers.map((l) => [l['name'], l['type']]), [['ground', 'tilelayer'], ['objects', 'objectgroup']]);
  // Player at (2, 1) and a spawn at (3, 1): points at the cell centre, in tile-height units.
  const objs = layers[1]!['objects'] as J[];
  assert.deepEqual(objs.map((o) => [o['type'], o['x'], o['y'], o['point']]), [['player', 80, 48, true], ['spawn', 112, 48, true]]);
  assert.ok(text.endsWith('}\n') && tsj.endsWith('}\n'));
  const ts = JSON.parse(tsj) as J;
  assert.deepEqual(
    (ts['tiles'] as J[]).map((t) => t['properties']),
    [[prop('tile', 'floor')], [prop('tile', 'wall')]],
  );
  assert.equal(findMap(def, 'nope'), "unknown map 'nope'; available: t:room");
});
