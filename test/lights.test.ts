import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError, loadPacks, MAX_LIGHT_RADIUS, World, type Definition, type LoadError, type PackSource } from '../src/core/index.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { CHUNK, chunkKeyOf, chunkLayout } from '../src/iso/chunks.ts';
import {
  chunksInReach,
  computeChunkLight,
  entitySourceId,
  flickerAt,
  flickerDirty,
  flickerSlot,
  FLICKER_SLOT_MS,
  lightColor,
  lightIntensity,
  litCells,
  litTint,
  newChunkLightmap,
  reachCells,
  syncTileSources,
  tileSources,
  type LightSource,
  type TileLightCache,
} from '../src/iso/lights.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, fixture } from './helpers.ts';

// Local lights (task `local-lights`): `light` on tiles and archetypes, the
// per-chunk lightmap through the grid line of sight, flicker, `litTint`, the
// scene's dirty bookkeeping and the shipped lamps, candelabras and fireflies.

// ── Fixture ─────────────────────────────────────────────────────────────────

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true }
  - { id: door, label: Door, glyph: "+", color: brown, walkable: true, edge: true }
  - { id: window, label: Window, glyph: '"', color: cyan, walkable: false, opaque: false, edge: true }
  - { id: boards, label: Boards, glyph: "H", color: brown, walkable: false, opaque: true, edge: true }
  - { id: lamp, label: Lamp, glyph: "i", color: yellow, walkable: false, opaque: false, light: { radius: 4, color: "#ffe6b8" } }
  - { id: candle, label: Candle, glyph: "c", color: yellow, walkable: false, opaque: false, light: { radius: 2, color: "#ff8000", flicker: 0.5 } }
  - { id: lit_window, label: Lit window, glyph: "w", color: yellow, walkable: false, opaque: false, edge: true, light: { radius: 3 } }
  - { id: rock, label: Rock, glyph: "R", color: gray, walkable: false }
`;

/** An edge placed in `room`: the `n` or `w` side of cell (x, y). */
interface EdgeAt {
  x: number;
  y: number;
  side: 'n' | 'w';
  ch: string;
}

/**
 * Map rows in the `edges: true` notation: `cells` (one char per cell, `@`
 * the player), a wall all round, and `edges` inside (or on the border, where
 * they replace the wall).
 */
function room(cells: string[], edges: EdgeAt[] = []): string[] {
  const w = cells[0]!.length;
  const h = cells.length;
  const rows: string[][] = [];
  for (let r = 0; r <= 2 * h; r++) {
    const row: string[] = new Array<string>(2 * w + 1).fill(' ');
    if (r === 0 || r === 2 * h) row.fill('#');
    else if (r % 2 === 1) {
      row[0] = row[2 * w] = '#';
      for (let x = 0; x < w; x++) row[2 * x + 1] = cells[(r - 1) / 2]![x]!;
    } else row[0] = row[2 * w] = '#';
    rows.push(row);
  }
  for (const e of edges) {
    if (e.side === 'n') rows[2 * e.y]![2 * e.x + 1] = e.ch;
    else rows[2 * e.y + 1]![2 * e.x] = e.ch;
  }
  return rows.map((r) => r.join(''));
}

function files(extra: Record<string, string> = {}, map?: string[]): Record<string, string> {
  const rows = map ?? room(['.....', '..@..', '.....']);
  return {
    'tiles.yaml': TILES,
    'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [hp]
    ticks_per_turn: 0
  - id: firefly
    label: Firefly
    glyph: "'"
    color: green
    ticks_per_turn: 0
    light: { radius: 1.5, color: "#c8ff80", flicker: 0.5 }
`,
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "+": { tile: door }
      '"': { tile: window }
      "H": { tile: boards }
      "i": { tile: lamp }
      "c": { tile: candle }
      "w": { tile: lit_window }
      "R": { tile: rock }
      "@": { tile: floor, player: true }
      "f": { tile: floor, spawn: firefly }
    edges: true
    rows: ${JSON.stringify(rows)}
start:
  map: room
  player: hero
`,
    ...extra,
  };
}

function load(extra: Record<string, string> = {}, map?: string[]): Definition {
  const r = loadPacks([fixture(files(extra, map))]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition;
}

function errorsOf(extra: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture(files(extra))]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], file: string, path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
  assert.equal(hit.file, file);
}

/** A mod pack `m` over the fixture with one content file. */
function mod(yaml: string): PackSource {
  return { label: 'm', files: { 'pack.yaml': 'namespace: m\nname: M\nversion: 1.0.0\nkind: mod\ndepends: [t]\n', 'mod.yaml': yaml } };
}

const tile = (def: Definition, id: string) => def.tiles[def.ids.tiles[`t:${id}`]!]!;

// ── Loader ──────────────────────────────────────────────────────────────────

test('light: parsed on a cell tile, an edge tile and an archetype, with the colour as a number and the defaults', () => {
  const def = load();
  assert.deepEqual(tile(def, 'lamp').light, { radius: 4, color: 0xffe6b8, flicker: 0 });
  assert.deepEqual(tile(def, 'candle').light, { radius: 2, color: 0xff8000, flicker: 0.5 });
  assert.deepEqual(tile(def, 'lit_window').light, { radius: 3, color: 0xffffff, flicker: 0 });
  assert.equal(tile(def, 'lit_window').edge, true);
  assert.equal(tile(def, 'floor').light, null);
  const firefly = def.archetypes[def.ids.archetypes['t:firefly']!]!;
  assert.deepEqual(firefly.light, { radius: 1.5, color: 0xc8ff80, flicker: 0.5 });
  assert.equal(def.archetypes[def.ids.archetypes['t:hero']!]!.light, null);
  assert.equal(MAX_LIGHT_RADIUS, 12);
});

test('light: load errors name the file, the path and the bound', () => {
  const tiles = (light: string) => ({ 'tiles.yaml': `${TILES}  - { id: bad, label: Bad, glyph: b, color: red, walkable: false, light: ${light} }\n` });
  expectError(errorsOf(tiles('{ color: "#ffffff" }')), 'tiles.yaml', 'tiles[9].light', /missing required field 'radius'/);
  expectError(errorsOf(tiles('{ radius: 0.25 }')), 'tiles.yaml', 'tiles[9].light.radius', /must be a number of tiles in \[0\.5, 12\] \(MAX_LIGHT_RADIUS\), got 0\.25/);
  expectError(errorsOf(tiles('{ radius: 13 }')), 'tiles.yaml', 'tiles[9].light.radius', new RegExp(`\\[0\\.5, ${MAX_LIGHT_RADIUS}\\].*got 13`));
  expectError(errorsOf(tiles('{ radius: "big" }')), 'tiles.yaml', 'tiles[9].light.radius', /must be a number, got string/);
  expectError(errorsOf(tiles('{ radius: 3, color: "orange" }')), 'tiles.yaml', 'tiles[9].light.color', /must be a '#rrggbb' colour, got "orange"/);
  expectError(errorsOf(tiles('{ radius: 3, flicker: 1.5 }')), 'tiles.yaml', 'tiles[9].light.flicker', /must be a number in \[0, 1\], got 1\.5/);
  expectError(errorsOf(tiles('{ radius: 3, flicker: -0.1 }')), 'tiles.yaml', 'tiles[9].light.flicker', /must be a number in \[0, 1\], got -0\.1/);
  expectError(errorsOf(tiles('{ radius: 3, flickr: 0.5 }')), 'tiles.yaml', 'tiles[9].light.flickr', /unknown light field 'flickr' \(did you mean 'flicker'\?\)/);
  expectError(errorsOf(tiles('[3]')), 'tiles.yaml', 'tiles[9].light', /field 'light' must be a mapping, got list/);
  expectError(errorsOf(tiles('5')), 'tiles.yaml', 'tiles[9].light', /field 'light' must be a mapping, got number/);
  // The same helper on an archetype.
  const arch = errorsOf({
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, measurements: [hp], ticks_per_turn: 0 }
  - { id: glow, label: Glow, glyph: g, color: green, light: { radius: 20, colour: "#ffffff" } }
`,
  });
  expectError(arch, 'archetypes.yaml', 'archetypes[1].light.radius', /\[0\.5, 12\].*got 20/);
  expectError(arch, 'archetypes.yaml', 'archetypes[1].light.colour', /unknown light field 'colour' \(did you mean 'color'\?\)/);
});

test('light: an override replaces it whole, `light: null` removes it, and `check --overrides` lists it', () => {
  const base = fixture(files());
  const r = loadPacks([
    base,
    mod(`tiles:
  - { id: t:lamp, override: true, light: { radius: 6, color: "#c8e6a0" } }
  - { id: t:candle, override: true, light: null }
archetypes:
  - { id: t:hero, override: true, light: { radius: 3, color: "#fff2c8" } }
`),
  ]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const def = r.definition;
  assert.deepEqual(tile(def, 'lamp').light, { radius: 6, color: 0xc8e6a0, flicker: 0 });
  assert.equal(tile(def, 'candle').light, null);
  assert.deepEqual(def.archetypes[def.ids.archetypes['t:hero']!]!.light, { radius: 3, color: 0xfff2c8, flicker: 0 });
  const lines = formatOverrides(def).map((l) => l.trim().split(/\s+/).join(' '));
  assert.ok(lines.includes('m override tile t:lamp [light]'), lines.join('\n'));
  assert.ok(lines.includes('m override tile t:candle [light]'));
  assert.ok(lines.includes('m override archetype t:hero [light]'));
});

// ── Lightmap ────────────────────────────────────────────────────────────────

/** A world from a map in the `edges: true` notation; returns its grid and definition. */
function world(rows: string[]): World {
  return World.create(load({}, rows), 1);
}

const at = (w: World, x: number, y: number, z = 0) => w.grid.index(x, y, z);

/** The lightmap of chunk (0, 0) on floor z from the grid's tile sources plus `extra`, at `now`. */
function light(w: World, extra: LightSource[] = [], now = 0, z = 0) {
  const sources = [...tileSources(w.grid, w.def.tiles, 0, 0, z), ...extra];
  return computeChunkLight(w.grid, 0, 0, z, sources, now);
}

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-5, msg ?? `${a} != ${b}`);

test('lightmap: falloff is 1 − d / radius with a clear line of sight; the radius itself is dark', () => {
  // A lamp (radius 4) at (1, 1) in an open 11×3 room.
  const w = world(room(['...........', '.i.........', '..........@']));
  const m = light(w);
  close(lightIntensity(m, 1, 1), 1, 'd = 0');
  close(lightIntensity(m, 2, 1), 0.75, 'd = 1');
  close(lightIntensity(m, 4, 1), 0.25, 'd = 3');
  assert.equal(lightIntensity(m, 5, 1), 0, 'd = radius');
  assert.equal(lightIntensity(m, 9, 1), 0, 'beyond');
  close(lightIntensity(m, 2, 2), 1 - Math.SQRT2 / 4, 'diagonal');
  assert.equal(lightColor(m, 2, 1), 0xffe6b8);
  // Lit cells as records, and the chunk's bookkeeping.
  const cells = litCells(m, w.grid);
  assert.ok(cells.every((c) => c.i > 0 && c.color === 0xffe6b8));
  assert.equal(cells.length, m.lit);
  assert.ok(cells.some((c) => c.index === at(w, 1, 1) && c.i === 1));
  assert.deepEqual(m.reached, [at(w, 1, 1) * 3]);
  assert.equal(m.flickering, false);
});

test('lightmap: walls, boards and opaque cells block; a window or a doorway lets the light out', () => {
  // The lamp at (1, 2) west of a wall between x = 3 and x = 4 with a window
  // at y = 0, boards at y = 2 and a door at y = 4; beyond it an open hall.
  const wall = (y: number, ch: string): EdgeAt => ({ x: 4, y, side: 'w', ch });
  const w = world(room(['.........', '.........', '.i.......', '.........', '........@'], [wall(0, '"'), wall(1, '#'), wall(2, 'H'), wall(3, '#'), wall(4, '+')]));
  const m = light(w);
  assert.ok(lightIntensity(m, 2, 2) > 0, 'inside');
  assert.ok(lightIntensity(m, 3, 2) > 0, 'right in front of the boards');
  assert.ok(lightIntensity(m, 4, 0) > 0, 'through the window');
  assert.ok(lightIntensity(m, 4, 4) > 0, 'through the doorway');
  assert.equal(lightIntensity(m, 4, 2), 0, 'the boards stop it');
  assert.equal(lightIntensity(m, 4, 1), 0, 'the wall stops it');
  assert.equal(lightIntensity(m, 4, 3), 0, 'the wall stops it');
  // An opaque cell blocks too; sight goes around it where the geometry allows.
  const b = light(world(room(['..R.i', '....@'])));
  assert.equal(lightIntensity(b, 1, 0), 0, 'behind the rock');
  assert.ok(lightIntensity(b, 3, 0) > 0, 'in front of it');
  assert.ok(lightIntensity(b, 1, 1) > 0, 'around it, along the open row');
  assert.ok(lightIntensity(b, 2, 0) > 0, 'the rock itself is lit from the front');
});

test('lightmap: an edge light spills to both sides without doubling its own two cells', () => {
  // A lit window (radius 3) on the wall between x = 2 and x = 3 of row 1.
  const w = world(room(['......', '......', '.....@'], [{ x: 3, y: 1, side: 'w', ch: 'w' }]));
  const m = light(w);
  // Both cells the window separates are its own cells: intensity 1, not 1 − (1 − 1)(1 − 0.67).
  close(lightIntensity(m, 2, 1), 1);
  close(lightIntensity(m, 3, 1), 1);
  // A cell two to the east: d = 1 from (3, 1) and 2 from (2, 1): the stronger cast, not the sum.
  close(lightIntensity(m, 4, 1), 1 - 1 / 3);
  close(lightIntensity(m, 1, 1), 1 - 1 / 3);
  assert.equal(m.reached.length, 1, 'one source');
  // A lit edge on the map border casts from its single inside cell.
  const border = world(room(['...', '..@'], [{ x: 0, y: 0, side: 'w', ch: 'w' }]));
  const bm = light(border);
  close(lightIntensity(bm, 0, 0), 1);
  close(lightIntensity(bm, 1, 0), 1 - 1 / 3);
});

test('lightmap: two lamps combine as 1 − (1 − a)(1 − b) with the intensity-weighted colour', () => {
  // A warm lamp at (1, 1) and an orange candle (radius 2, flicker 0.5) at (3, 1).
  const w = world(room(['......', '.i.c..', '.....@']));
  // At `now`, the candle's factor is what `flickerAt` says for its seed.
  const now = 12345;
  const f = flickerAt(at(w, 3, 1), now, 0.5);
  const m = light(w, [], now);
  const a = 0.75; // lamp at d = 1
  const b = 0.5 * f; // candle at d = 1
  close(lightIntensity(m, 2, 1), 1 - (1 - a) * (1 - b));
  const col = lightColor(m, 2, 1);
  const mix = (ca: number, cb: number) => Math.round((a * ca + b * cb) / (a + b));
  assert.equal(col, (mix(0xff, 0xff) << 16) | (mix(0xe6, 0x80) << 8) | mix(0xb8, 0x00));
  // The candle's own cell is lit by the lamp (d = 2, 0.5) and itself (f): never above 1.
  assert.ok(lightIntensity(m, 3, 1) <= 1 && lightIntensity(m, 3, 1) > 0.5);
  assert.equal(m.flickering, true);
  assert.deepEqual([...m.reached].sort((p, q) => p - q), [at(w, 1, 1) * 3, at(w, 3, 1) * 3].sort((p, q) => p - q));
});

test('lightmap: floors never see each other; an entity source outside the chunk still lights it', () => {
  const w = world(room(['....', '...@']));
  const { grid } = w;
  // A source on floor 1 (the fixture has one floor; the lightmap of floor 0 ignores it either way).
  const up: LightSource = { id: entitySourceId(7), x: 1, y: 1, z: 1, x2: -1, y2: -1, light: { radius: 4, color: 0xffffff, flicker: 0 }, seed: 7 };
  assert.equal(light(w, [up]).lit, 0);
  // A two-floor room: a lamp upstairs lights nothing downstairs and vice versa.
  const two = World.create(
    load(
      {
        'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "i": { tile: lamp }
      "@": { tile: floor, player: true }
    floors:
      - { rows: ["....", "..@.", "...."] }
      - { rows: ["....", ".i..", "...."] }
start:
  map: room
  player: hero
`,
      },
    ),
    1,
  );
  assert.equal(two.grid.floors, 2);
  assert.equal(light(two).lit, 0, 'floor 0 sees no light');
  const upstairs = light(two, [], 0, 1);
  assert.ok(upstairs.lit > 0 && lightIntensity(upstairs, 1, 1) === 1, 'floor 1 is lit');
  // A wide map: an entity lamp at (18, 0) (chunk 1) reaches cells of chunk 0 within its radius.
  const wide = world(room(['.'.repeat(20) + '@']));
  const lamp: LightSource = { id: entitySourceId(3), x: 18, y: 0, z: 0, x2: -1, y2: -1, light: { radius: 5, color: 0xffffff, flicker: 0 }, seed: 3 };
  const m = computeChunkLight(wide.grid, 0, 0, 0, [lamp], 0);
  assert.equal(m.lit, 2, 'cells 14 and 15 of the chunk');
  close(lightIntensity(m, 15, 0), 1 - 3 / 5);
  close(lightIntensity(m, 14, 0), 1 - 4 / 5);
  assert.equal(lightIntensity(m, 13, 0), 0);
  assert.deepEqual(m.reached, [entitySourceId(3)]);
  assert.ok(grid.width === 4 && wide.grid.width === 21);
  // A fresh lightmap can be reused: the next computation resets it.
  const out = newChunkLightmap(0, 0, 0);
  computeChunkLight(wide.grid, 0, 0, 0, [lamp], 0, out);
  computeChunkLight(wide.grid, 0, 0, 0, [], 0, out);
  assert.equal(out.lit, 0);
  assert.equal(lightIntensity(out, 15, 0), 0);
});

test('flickerAt: deterministic, within [1 − amount, 1], constant within a slot, exactly 1 for amount 0', () => {
  assert.equal(flickerAt(42, 123456, 0), 1);
  assert.equal(FLICKER_SLOT_MS, 100);
  const values = new Set<number>();
  for (let seed = 0; seed < 50; seed++) {
    for (let t = 0; t < 5000; t += 37) {
      const f = flickerAt(seed, t, 0.6);
      assert.equal(f, flickerAt(seed, t, 0.6));
      assert.ok(f >= 0.4 && f <= 1, `${f}`);
      assert.equal(f, flickerAt(seed, flickerSlot(t) * 100, 0.6), 'constant within the slot');
      values.add(f);
    }
  }
  assert.ok(values.size > 100, 'it does vary');
  // The amount scales one hash value: f(1) = 1 − u, f(0.5) = 1 − u / 2.
  close(flickerAt(1, 0, 1), 1 - 2 * (1 - flickerAt(1, 0, 0.5)));
  assert.equal(flickerAt(5, 250, 0.5), flickerAt(5, 299, 0.5));
  assert.notEqual(flickerAt(5, 250, 0.5), flickerAt(5, 300, 0.5));
  assert.equal(flickerSlot(999), 9);
  assert.equal(flickerSlot(1000), 10);
});

test('litTint: lifts the ambient toward max(ambient, colour) by the intensity and leaves a white ambient alone', () => {
  assert.equal(litTint(0xffffff, 0xffe6b8, 1), 0xffffff, 'noon: invisible');
  assert.equal(litTint(0x3a4a80, 0xffffff, 1), 0xffffff, 'a white lamp restores the colours');
  assert.equal(litTint(0x3a4a80, 0xffffff, 0), 0x3a4a80);
  assert.equal(litTint(0x3a4a80, 0xffffff, 0.5), (Math.round(0x3a + (0xff - 0x3a) * 0.5) << 16) | (Math.round(0x4a + (0xff - 0x4a) * 0.5) << 8) | Math.round(0x80 + (0xff - 0x80) * 0.5));
  // A warm lamp never pulls a channel below the ambient (blue stays at the ambient's 0x80 when the light has 0x40).
  assert.equal(litTint(0x3a4a80, 0xff8040, 1), 0xff8080);
  assert.equal(litTint(0x3a4a80, 0xff8040, 0.25), (Math.round(0x3a + (0xff - 0x3a) * 0.25) << 16) | (Math.round(0x4a + (0x80 - 0x4a) * 0.25) << 8) | 0x80);
});

// ── Scene bookkeeping (pure parts) ──────────────────────────────────────────

test('chunksInReach: the chunks an entity light dirties when it enters or leaves a cell', () => {
  const l = chunkLayout(64, 64, 2);
  assert.equal(reachCells(5), 4);
  assert.equal(reachCells(1.5), 1);
  assert.equal(reachCells(0.5), 0);
  // In the middle of chunk (1, 1) with radius 5: only its own chunk.
  assert.deepEqual(chunksInReach(l, 24, 24, 0, 5), [chunkKeyOf(l, 24, 24, 0)]);
  // Two cells from the chunk's left edge: the chunk to the left too.
  assert.deepEqual(chunksInReach(l, 17, 24, 0, 5), [chunkKeyOf(l, 0, 24, 0), chunkKeyOf(l, 24, 24, 0)]);
  // At a corner, on floor 1: four chunks of floor 1.
  assert.deepEqual(chunksInReach(l, 16, 16, 1, 3), [chunkKeyOf(l, 0, 0, 1), chunkKeyOf(l, 16, 0, 1), chunkKeyOf(l, 0, 16, 1), chunkKeyOf(l, 16, 16, 1)]);
  // A tiny light at the map corner: one chunk; off the floors: none.
  assert.deepEqual(chunksInReach(l, 0, 0, 0, 0.5), [0]);
  assert.deepEqual(chunksInReach(l, 0, 0, 2, 5), []);
  // The default reach is MAX_LIGHT_RADIUS: 11 cells either way.
  assert.deepEqual(chunksInReach(l, 32, 32, 0), [chunkKeyOf(l, 21, 21, 0), chunkKeyOf(l, 32, 21, 0), chunkKeyOf(l, 21, 32, 0), chunkKeyOf(l, 32, 32, 0)]);
  // Moving one cell: the union of the old and new reach is what the scene dirties.
  const moved = new Set([...chunksInReach(l, 15, 24, 0, 5), ...chunksInReach(l, 16, 24, 0, 5)]);
  assert.deepEqual([...moved].sort((a, b) => a - b), [chunkKeyOf(l, 0, 24, 0), chunkKeyOf(l, 16, 24, 0)]);
});

test('flicker slot change: only the chunks a flickering source reached are stale', () => {
  const w = world(room(['......', '.i..c.', '.....@']));
  const steady = computeChunkLight(w.grid, 0, 0, 0, tileSources(w.grid, w.def.tiles, 0, 0, 0).filter((s) => s.x === 1), 0);
  const candle = computeChunkLight(w.grid, 0, 0, 0, tileSources(w.grid, w.def.tiles, 0, 0, 0), 0);
  const far = newChunkLightmap(CHUNK, 0, 0);
  assert.deepEqual(flickerDirty([[0, steady], [1, candle], [2, far]]), [1]);
  // The candle alone changes between slots; the lamp's cells do not.
  const a = computeChunkLight(w.grid, 0, 0, 0, tileSources(w.grid, w.def.tiles, 0, 0, 0), 100);
  const b = computeChunkLight(w.grid, 0, 0, 0, tileSources(w.grid, w.def.tiles, 0, 0, 0), 200);
  assert.equal(lightIntensity(a, 1, 1), lightIntensity(b, 1, 1));
  let differs = false;
  for (let t = 0; t < 2000 && !differs; t += 100) differs = lightIntensity(computeChunkLight(w.grid, 0, 0, 0, tileSources(w.grid, w.def.tiles, 0, 0, 0), t), 4, 1) !== lightIntensity(a, 4, 1);
  assert.ok(differs, 'the candle flickers');
});

test('syncTileSources: a chunk built after the first frame still gathers its lamps; a map edit regathers every chunk', () => {
  // A 20-cell-wide room (two chunks across) with a lamp at (13, 1): in chunk (0, 0) and within reach of chunk (1, 0).
  const w = world(room(['.'.repeat(20), '.'.repeat(13) + 'i......', '.'.repeat(19) + '@']));
  const { grid, def } = w;
  const lamp = at(w, 13, 1);
  const cache = (): TileLightCache => ({ tileLights: [], lightVersion: -1 });
  // Frame 1: chunk (0, 0) is built and synced.
  const first = cache();
  assert.equal(syncTileSources(first, grid, def.tiles, 0, 0, 0, grid.version), true);
  assert.deepEqual(first.tileLights.map((s) => [s.x, s.y]), [[13, 1]]);
  assert.equal(first.lightVersion, grid.version);
  // Frame 2 (nothing changed): the chunk keeps its list, by identity.
  const kept = first.tileLights;
  assert.equal(syncTileSources(first, grid, def.tiles, 0, 0, 0, grid.version), false);
  assert.equal(first.tileLights, kept);
  // Frame 2: the camera scrolled and the chunk to the right is built now, with the same map version: it gathers the lamp in reach too.
  const later = cache();
  assert.equal(syncTileSources(later, grid, def.tiles, CHUNK, 0, 0, grid.version), true);
  assert.deepEqual(later.tileLights.map((s) => [s.x, s.y]), [[13, 1]]);
  // A map edit (the lamp is replaced by floor) bumps the version: both chunks regather and the lamp is gone.
  grid.setTile(lamp, def.ids.tiles['t:floor']!);
  assert.equal(syncTileSources(first, grid, def.tiles, 0, 0, 0, grid.version), true);
  assert.equal(syncTileSources(later, grid, def.tiles, CHUNK, 0, 0, grid.version), true);
  assert.deepEqual(first.tileLights, []);
  assert.deepEqual(later.tileLights, []);
  assert.equal(first.lightVersion, grid.version);
  // And a chunk built after the edit sees the edited map.
  const after = cache();
  assert.equal(syncTileSources(after, grid, def.tiles, 0, 0, 0, grid.version), true);
  assert.deepEqual(after.tileLights, []);
});

// ── Shipped packs ───────────────────────────────────────────────────────────

const shipped = (name: keyof typeof GAMES): Definition => {
  const r = loadPacks(GAMES[name].map((d) => readPack(d)));
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition;
};

test('town: street lamps on every road_h and road_v placement and two on town_center; lit, warm, steady', () => {
  const def = shipped('town');
  const lamp = def.tiles[def.ids.tiles['town:street_lamp']!]!;
  assert.deepEqual([lamp.label, lamp.walkable, lamp.opaque, lamp.raised, lamp.edge], ['Street lamp', false, false, true, false]);
  assert.deepEqual(lamp.light, { radius: 5, color: 0xffe6b8, flicker: 0 });
  const count = (id: string) => {
    const m = def.maps[def.ids.maps[id]!]!;
    let n = 0;
    for (const t of m.cells) if (t === lamp.index) n++;
    return n;
  };
  assert.equal(count('town:road_h'), 4);
  assert.equal(count('town:road_v'), 4);
  assert.equal(count('town:town_center'), 2);
  // Every placement of a road part carries its lamps: 4 per part on the 30 + 30 road segments of a 5×5 grid of blocks.
  const city = def.maps[def.start.map]!;
  assert.equal(count('town:city'), 4 * 30 + 4 * 30 + 2);
  // The lamps stand on the outer rows of a 5-wide road, leaving three clear lanes.
  const road = def.ids.tiles['town:road']!;
  const at = (x: number, y: number) => city.cells[y * city.width + x]!;
  let lamps = 0;
  for (let y = 0; y < city.height; y++)
    for (let x = 0; x < city.width; x++) {
      if (at(x, y) !== lamp.index) continue;
      lamps++;
      const across = (dx: number, dy: number) => {
        let n = 0;
        for (let k = 1; k <= 4 && at(x + k * dx, y + k * dy) === road; k++) n++;
        return n;
      };
      assert.ok(across(0, 1) === 4 || across(0, -1) === 4 || across(1, 0) === 4 || across(-1, 0) === 4, `lamp at ${x},${y} is on a road's outer row`);
    }
  assert.equal(lamps, count('town:city'));
  // The town_center lamps are within sight of the player's start.
  const w = World.create(def, 1);
  const p = w.player;
  const near = [];
  for (let y = p.y - 12; y <= p.y + 12; y++) for (let x = p.x - 12; x <= p.x + 12; x++) if (at(x, y) === lamp.index) near.push([x, y]);
  assert.equal(near.length, 2, `two lamps near the start, found ${JSON.stringify(near)}`);
});

test('noir: the lamp is gaslight green and the detective carries a light; zombie: the lamp flickers', () => {
  const noir = shipped('noir');
  assert.deepEqual(noir.tiles[noir.ids.tiles['town:street_lamp']!]!.light, { radius: 5, color: 0xc8e6a0, flicker: 0 });
  assert.equal(noir.tiles[noir.ids.tiles['town:street_lamp']!]!.label, 'Street lamp');
  const detective = noir.archetypes[noir.start.player]!;
  assert.equal(detective.label, 'Detective');
  assert.deepEqual(detective.light, { radius: 3, color: 0xfff2c8, flicker: 0 });
  const zombie = shipped('zombie');
  assert.deepEqual(zombie.tiles[zombie.ids.tiles['town:street_lamp']!]!.light, { radius: 5, color: 0xffe6b8, flicker: 0.6 });
  assert.equal(zombie.archetypes[zombie.start.player]!.light, null);
  const lines = (def: Definition) => formatOverrides(def).map((l) => l.trim().split(/\s+/).join(' '));
  assert.ok(lines(noir).includes('noir override tile town:street_lamp [light]'), lines(noir).join('\n'));
  assert.ok(lines(noir).includes('noir override archetype town:resident [label, light]'), lines(noir).join('\n'));
  assert.ok(lines(zombie).includes('zmb override tile town:street_lamp [light]'), lines(zombie).join('\n'));
});

test('vampire: four candelabras in the mansion, against walls', () => {
  const def = shipped('vampire');
  const c = def.tiles[def.ids.tiles['vamp:candelabra']!]!;
  assert.deepEqual([c.walkable, c.opaque, c.raised], [false, false, true]);
  assert.deepEqual(c.light, { radius: 3, color: 0xffc890, flicker: 0.25 });
  const mansion = def.maps[def.ids.maps['vamp:mansion']!]!;
  const cells: [number, number][] = [];
  for (let y = 0; y < mansion.height; y++) for (let x = 0; x < mansion.width; x++) if (mansion.cells[y * mansion.width + x] === c.index) cells.push([x, y]);
  assert.equal(cells.length, 4, JSON.stringify(cells));
  const inRoom = (tag: string, x: number, y: number) => mansion.rooms.sets[mansion.rooms.cellSet[y * mansion.width + x]!]!.map((t) => def.roomTags[t]).includes(tag);
  assert.equal(cells.filter(([x, y]) => inRoom('hall', x, y)).length, 2);
  assert.equal(cells.filter(([x, y]) => inRoom('library', x, y)).length, 1);
  assert.equal(cells.filter(([x, y]) => inRoom('cellar', x, y)).length, 1);
  // Against a wall: an edge wall on one of its sides.
  const w = World.create(def, 1);
  const { grid } = w;
  const estate = def.maps[def.start.map]!;
  assert.equal(estate.cells.filter((t) => t === c.index).length, 4);
  const walled = (x: number, y: number) => {
    const wall = (t: { id: string } | undefined) => t !== undefined && t.id === 'std:wall';
    return wall(grid.edgeAt(x, y, 0, 'n')) || wall(grid.edgeAt(x, y, 0, 'w')) || wall(grid.edgeAt(x + 1, y, 0, 'w')) || wall(grid.edgeAt(x, y + 1, 0, 'n'));
  };
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) if (grid.cells[grid.index(x, y, 0)] === c.index) assert.ok(walled(x, y), `candelabra at ${x},${y}`);
});

test('garden: six fireflies on flower cells; they rest by day and drift once night falls', () => {
  const def = shipped('garden');
  const firefly = def.archetypes[def.ids.archetypes['gdn:firefly']!]!;
  assert.deepEqual([firefly.glyph, firefly.tags, firefly.ticksPerStep, firefly.ticksPerTurn, firefly.measurements, firefly.senses], ["'", ['bug'], 3, 0, [], null]);
  assert.deepEqual(firefly.light, { radius: 1.5, color: 0xc8ff80, flicker: 0.5 });
  const garden = def.maps[def.start.map]!;
  const spawns = garden.spawns.filter((s) => s.archetype === firefly.index);
  assert.equal(spawns.length, 6);
  const flowers = def.ids.tiles['gdn:flowers']!;
  for (const s of spawns) assert.equal(garden.cells[(s.z * garden.height + s.y) * garden.width + s.x], flowers, `firefly at ${s.x},${s.y} on flowers`);
  // Spread over the beds: not all on one row.
  assert.ok(new Set(spawns.map((s) => s.y)).size >= 3);
  const behavior = def.behaviors[firefly.behavior!]!;
  assert.equal(behavior.id, 'gdn:firefly');
  const names = behavior.states.map((s) => s.name);
  assert.deepEqual(names, ['rest', 'drift', 'return']);
  assert.equal(behavior.states[behavior.initial]!.name, 'rest');
  assert.deepEqual(behavior.states.map((s) => s.activity), ['idle', 'wander', 'home']);
  assert.equal(behavior.states[1]!.radius, 3);
  assert.equal(behavior.states[2]!.done, 0);
  assert.equal(behavior.on.length, 1);
  assert.equal(behavior.on[0]!.to, 2);
  // By day they rest where they spawned; a run across dusk sees them leave `rest`.
  const w = World.create(def, 3);
  const flies = w.entities.filter((e) => e.archetype === firefly);
  assert.equal(flies.length, 6);
  const home = flies.map((e) => [e.x, e.y]);
  for (let i = 0; i < 600; i++) w.step();
  assert.deepEqual(flies.map((e) => [e.x, e.y]), home, 'resting by day');
  // The garden clock starts at 07:00 with the default dusk at 20:00: jump to night by stepping (1 s = 1 game minute, 10 ticks per second).
  const ticksPerMinute = def.ticksPerSecond * (def.clock.dayLength / (24 * 60));
  for (let i = 0; i < Math.ceil(13.5 * 60 * ticksPerMinute); i++) w.step();
  assert.ok(flies.some((e, k) => e.x !== home[k]![0] || e.y !== home[k]![1]), 'drifting at night');
});
