import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_TILE, Grid, lineOfSight, loadPacksOrThrow, Rng, World, type MapDef, type TileDef } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, genreCell, loadFixture } from './helpers.ts';

function tileDef(index: number, id: string, walkable: boolean, opaque: boolean): TileDef {
  return { id, index, label: id, glyph: '?', color: 'white', walkable, raised: !walkable, opaque, sprite: null, tags: [], container: null, climb: null, edge: false };
}

/** `.` floor, `#` wall, `+` door, `"` window (not walkable, not opaque). */
const TILES = [tileDef(0, 'floor', true, false), tileDef(1, 'wall', false, true), tileDef(2, 'door', true, false), tileDef(3, 'window', false, false)];
const CODES: Record<string, number> = { '.': 0, '#': 1, '+': 2, '"': 3 };

function grid(rows: string[]): Grid {
  const cells = rows.flatMap((r) => [...r].map((ch) => CODES[ch]!));
  const none = cells.map(() => EMPTY_TILE);
  const map = { id: 'm', index: 0, width: rows[0]!.length, height: rows.length, floors: 1, cells, edgeN: none, edgeW: none } as unknown as MapDef;
  return new Grid(map, TILES);
}

test('sight: everything is visible in an open room', () => {
  const g = grid(['......', '......', '......', '......']);
  for (let y0 = 0; y0 < g.height; y0++)
    for (let x0 = 0; x0 < g.width; x0++)
      for (let y1 = 0; y1 < g.height; y1++)
        for (let x1 = 0; x1 < g.width; x1++) assert.ok(lineOfSight(g, x0, y0, x1, y1), `(${x0},${y0})→(${x1},${y1})`);
});

test('sight: a wall blocks, a door in it lets sight through', () => {
  const g = grid(['.....', '.....', '##+##', '.....']);
  assert.equal(lineOfSight(g, 0, 0, 0, 3), false);
  assert.equal(lineOfSight(g, 4, 1, 4, 3), false);
  assert.equal(lineOfSight(g, 2, 0, 2, 3), true);
  assert.equal(lineOfSight(g, 2, 3, 2, 0), true);
});

test('sight: endpoints are ignored', () => {
  const g = grid(['#####', '....#', '.....']);
  // Standing next to a wall, looking along it.
  assert.equal(lineOfSight(g, 0, 1, 3, 1), true);
  // A wall tile itself is visible from the floor in front of it.
  assert.equal(lineOfSight(g, 0, 1, 4, 1), true);
  assert.equal(lineOfSight(g, 4, 1, 0, 1), true);
  assert.equal(lineOfSight(g, 2, 2, 2, 0), true);
  // Same and adjacent cells are always visible, even into walls.
  assert.equal(lineOfSight(g, 1, 1, 1, 1), true);
  assert.equal(lineOfSight(g, 1, 1, 2, 0), true);
});

test('sight: no peeking through diagonal wall corners', () => {
  const both = grid(['.#.', '#..', '...']);
  assert.equal(lineOfSight(both, 0, 0, 2, 2), false);
  assert.equal(lineOfSight(both, 2, 2, 0, 0), false);
  // Adjacent diagonal cells still see each other.
  assert.equal(lineOfSight(both, 0, 0, 1, 1), true);
  const one = grid(['.#.', '...', '...']);
  assert.equal(lineOfSight(one, 0, 0, 2, 2), true);
  assert.equal(lineOfSight(one, 2, 2, 0, 0), true);
});

test('sight: a window blocks movement but not sight', () => {
  const g = grid(['.....', '##"##', '.....']);
  assert.equal(g.walkable(2, 1), false);
  assert.equal(g.opaqueAt(2, 1), false);
  assert.equal(lineOfSight(g, 2, 0, 2, 2), true);
  assert.equal(lineOfSight(g, 0, 0, 0, 2), false);
});

test('sight: out-of-bounds endpoints are never visible; out of bounds is opaque', () => {
  const g = grid(['...', '...', '...']);
  assert.equal(lineOfSight(g, -1, 0, 1, 0), false);
  assert.equal(lineOfSight(g, 1, 1, 3, 1), false);
  assert.equal(lineOfSight(g, 0, 0, 0, 0 + g.height), false);
  assert.equal(g.opaqueAt(-1, 0), true);
  assert.equal(g.opaqueAt(0, 3), true);
});

test('sight: symmetric for every pair of cells on a random map', () => {
  const W = 14;
  const H = 13;
  const rng = new Rng(20260927);
  const rows: string[] = [];
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) r += rng.next() < 0.3 ? '#' : '.';
    rows.push(r);
  }
  const g = grid(rows);
  let visible = 0;
  let blocked = 0;
  for (let a = 0; a < W * H; a++) {
    for (let b = a; b < W * H; b++) {
      const ax = a % W, ay = (a - (a % W)) / W;
      const bx = b % W, by = (b - (b % W)) / W;
      const ab = lineOfSight(g, ax, ay, bx, by);
      assert.equal(ab, lineOfSight(g, bx, by, ax, ay), `(${ax},${ay})↔(${bx},${by})`);
      if (ab) visible++;
      else blocked++;
    }
  }
  // The map is interesting: both outcomes occur.
  assert.ok(visible > 0 && blocked > 0);
});

test('sight: opaque defaults to !walkable; an explicit value wins', () => {
  const def = loadFixture({
    'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: window, label: Window, glyph: "w", color: blue, walkable: false, opaque: false }
  - { id: fog, label: Fog, glyph: "f", color: gray, walkable: true, opaque: true }
`,
  });
  const tile = (id: string) => def.tiles.find((t) => t.id === id)!;
  assert.equal(tile('t:floor').opaque, false);
  assert.equal(tile('t:wall').opaque, true);
  assert.equal(tile('t:window').opaque, false);
  assert.equal(tile('t:fog').opaque, true);
});

// ── Two-genre scenarios ────────────────────────────────────────────────────

function game(name: keyof typeof GAMES): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), 1);
}

function place(e: { x: number; y: number; fromX: number; fromY: number }, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
}

test('zombie: an undead NPC in sight gets alert, and loses it behind a wall or far away', () => {
  const w = game('zombie');
  const T = (x: number, y: number) => genreCell('zombie', x, y);
  const z = w.entities.find((e) => e.archetype.id === 'zmb:shambler' && e.x === T(20, 13)[0] && e.y === T(20, 13)[1])!;
  assert.ok(z);
  assert.equal(w.hasStatus(z, 'zmb:alert'), false);
  // Clear road, 6 tiles away.
  place(w.player, ...T(26, 13));
  w.step();
  assert.equal(w.hasStatus(z, 'zmb:alert'), true);
  assert.equal(w.hasStatus(w.player, 'zmb:alert'), false);
  // 10 tiles away: out of `when` range but within `until` range, so it stays alert.
  place(w.player, ...T(30, 13));
  w.step();
  assert.equal(w.hasStatus(z, 'zmb:alert'), true);
  // Past 12 tiles: cleared.
  place(w.player, ...T(33, 13));
  w.step();
  assert.equal(w.hasStatus(z, 'zmb:alert'), false);
  // Close again, then behind the house wall: cleared although only ~6 tiles away.
  place(w.player, ...T(26, 13));
  w.step();
  assert.equal(w.hasStatus(z, 'zmb:alert'), true);
  place(w.player, ...T(16, 8));
  w.step();
  assert.equal(w.hasStatus(z, 'zmb:alert'), false);
});

test('vampire: the window is see-through, and a bat spots the vampire through it', () => {
  const w = game('vampire');
  const M = (x: number, y: number) => genreCell('vampire', x, y);
  const window = w.def.tiles.find((t) => t.id === 'town:window')!;
  assert.equal(window.walkable, false);
  assert.equal(window.opaque, false);
  assert.equal(w.grid.tileAt(...M(4, 12))!.id, 'town:window');
  const bat = w.entities.find((e) => e.archetype.id === 'vamp:bat' && e.x === M(4, 9)[0] && e.y === M(4, 9)[1])!;
  assert.ok(bat);
  assert.equal(w.hasStatus(bat, 'vamp:alert'), false);
  // The only cell between (4,11) and (4,13) is the window.
  place(bat, ...M(4, 11));
  place(w.player, ...M(4, 13));
  w.step();
  assert.equal(w.hasStatus(bat, 'vamp:alert'), true);
  assert.equal(w.hasStatus(w.player, 'vamp:alert'), false);
  // The same shape through a wall is blocked.
  assert.equal(w.grid.tileAt(...M(2, 12))!.id, 'std:wall');
  assert.equal(lineOfSight(w.grid, ...M(2, 11), ...M(2, 13)), false);
});

test('garden: the cat gets curious about a bunny in the open, and loses interest once it hides in a bush', () => {
  const w = game('garden');
  const cat = w.entities.find((e) => e.archetype.id === 'gdn:cat' && e.x === 14 && e.y === 4)!;
  assert.ok(cat);
  const tile = (id: string) => w.def.tiles.find((t) => t.id === id)!;
  assert.equal(tile('gdn:bush').walkable, true);
  assert.equal(tile('gdn:bush').opaque, false, 'bushes hide through a status, not by blocking sight');
  assert.ok(tile('gdn:bush').tags.includes('hiding'));
  assert.equal(tile('gdn:fence').opaque, false);
  assert.equal(tile('gdn:pond').opaque, false);
  assert.equal(w.hasStatus(cat, 'gdn:curious'), false);
  // In the open, 3 tiles away.
  place(w.player, 11, 4);
  w.step();
  assert.equal(w.hasStatus(cat, 'gdn:curious'), true);
  assert.equal(w.hasStatus(w.player, 'gdn:hidden'), false);
  // Into the bush next door: hidden at once, and the cat notices one tick later.
  assert.equal(w.grid.tileAt(12, 3)!.id, 'gdn:bush');
  place(w.player, 12, 3);
  w.step();
  assert.equal(w.hasStatus(w.player, 'gdn:hidden'), true);
  w.step();
  assert.equal(w.hasStatus(cat, 'gdn:curious'), false);
  assert.ok(Math.hypot(cat.x - 12, cat.y - 3) <= 5, 'still close by, yet not curious');
  // Out again, in plain view: curious again.
  place(w.player, 11, 4);
  w.step();
  w.step();
  assert.equal(w.hasStatus(cat, 'gdn:curious'), true);
  // Far away (past 8 tiles): it loses interest.
  place(w.player, 2, 13);
  w.step();
  assert.equal(w.hasStatus(cat, 'gdn:curious'), false);
});
