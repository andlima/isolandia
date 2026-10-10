import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_TILE, Grid, lineOfSight, loadPacksOrThrow, Rng, World, type MapDef, type TileDef } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, genreCell, loadFixture } from './helpers.ts';

function tileDef(index: number, id: string, walkable: boolean, opaque: boolean): TileDef {
  return { id, index, label: id, glyph: '?', color: 'white', walkable, raised: !walkable, opaque, sprite: null, tags: [], container: null, climb: null, edge: false, encloses: true, exposed: null };
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

test('zombie: an undead NPC sees the survivor in sight, and loses them behind a wall or far away', () => {
  const w = game('zombie');
  const T = (x: number, y: number) => genreCell('zombie', x, y);
  const z = w.entities.find((e) => e.archetype.id === 'zmb:shambler' && e.x === T(20, 13)[0] && e.y === T(20, 13)[1])!;
  assert.ok(z);
  assert.deepEqual(z.archetype.senses, { notice: 8, lose: 12, notice2: 64, lose2: 144, targetTags: ['living'] });
  assert.equal(z.seen, -1);
  // Clear road, 6 tiles away.
  place(w.player, ...T(26, 13));
  w.step();
  assert.equal(z.seen, w.player.id);
  assert.equal(w.player.seen, -1, 'the survivor has no senses');
  // 10 tiles away: out of `notice` range but within `lose` range, so it is kept.
  place(w.player, ...T(30, 13));
  w.step();
  assert.equal(z.seen, w.player.id);
  // Past 12 tiles: lost.
  place(w.player, ...T(33, 13));
  w.step();
  assert.equal(z.seen, -1);
  // Close again, then behind the house wall: lost although only ~6 tiles away.
  place(w.player, ...T(26, 13));
  w.step();
  assert.equal(z.seen, w.player.id);
  place(w.player, ...T(16, 8));
  w.step();
  assert.equal(z.seen, -1);
});

test('vampire: the window is see-through, and a bat spots the vampire through it', () => {
  const w = game('vampire');
  const M = (x: number, y: number) => genreCell('vampire', x, y);
  const window = w.def.tiles.find((t) => t.id === 'town:window')!;
  assert.equal(window.walkable, false);
  assert.equal(window.opaque, false);
  // The window is the edge between (4, 11) and (4, 12): the north edge of (4, 12).
  assert.equal(w.grid.edgeAt(...M(4, 12), 0, 'n')!.id, 'town:window');
  const bat = w.entities.find((e) => e.archetype.id === 'vamp:bat' && e.x === M(4, 9)[0] && e.y === M(4, 9)[1])!;
  assert.ok(bat);
  assert.equal(bat.seen, -1);
  // Between (4,11) and (4,13): the window edge, then the open cell (4,12).
  place(bat, ...M(4, 11));
  place(w.player, ...M(4, 13));
  w.step();
  assert.equal(bat.seen, w.player.id);
  assert.equal(w.player.seen, -1);
  // The same shape through a wall edge is blocked.
  assert.equal(w.grid.edgeAt(...M(2, 12), 0, 'n')!.id, 'std:wall');
  assert.equal(lineOfSight(w.grid, ...M(2, 11), ...M(2, 13)), false);
});

test('garden: the cat sees a bunny in the open, and loses it once it hides in a bush', () => {
  const w = game('garden');
  const cat = w.entities.find((e) => e.archetype.id === 'gdn:cat' && e.x === 14 && e.y === 4)!;
  assert.ok(cat);
  const tile = (id: string) => w.def.tiles.find((t) => t.id === id)!;
  assert.equal(tile('gdn:bush').walkable, true);
  assert.equal(tile('gdn:bush').opaque, false, 'bushes hide through a status, not by blocking sight');
  assert.ok(tile('gdn:bush').tags.includes('hiding'));
  assert.equal(tile('gdn:fence').opaque, false);
  assert.equal(tile('gdn:pond').opaque, false);
  assert.ok(w.def.statuses[w.def.ids.statuses['gdn:hidden']!]!.conceals, 'hiding is a concealing status');
  assert.equal(cat.seen, -1);
  // In the open, 3 tiles away.
  place(w.player, 11, 4);
  w.step();
  assert.equal(cat.seen, w.player.id);
  assert.equal(w.hasStatus(w.player, 'gdn:hidden'), false);
  // Into the bush next door: hidden and lost in the same tick (the senses step runs after the statuses).
  assert.equal(w.grid.tileAt(12, 3)!.id, 'gdn:bush');
  place(w.player, 12, 3);
  w.step();
  assert.equal(w.hasStatus(w.player, 'gdn:hidden'), true);
  assert.equal(cat.seen, -1);
  assert.ok(Math.hypot(cat.x - 12, cat.y - 3) <= 5, 'still close by, yet unseen');
  // Out again, in plain view: seen again.
  place(w.player, 11, 4);
  w.step();
  assert.equal(cat.seen, w.player.id);
  // Far away (past 8 tiles): lost.
  place(w.player, 2, 13);
  w.step();
  assert.equal(cat.seen, -1);
});
