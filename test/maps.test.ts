import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPacksOrThrow, World, type Definition, type MapDef } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES } from './helpers.ts';

// The roomy town and estate (specs/tasks/roomier-maps.md): map sizes, doors
// joined to the start, rooms you can turn around in, and 5-wide roads.

const STACKS = { town: GAMES.town, vampire: GAMES.vampire } as const;
const DEFS = Object.fromEntries(Object.entries(STACKS).map(([name, dirs]) => [name, loadPacksOrThrow(dirs.map((d) => readPack(d)))])) as Record<keyof typeof STACKS, Definition>;
/** The packs whose maps each stack checks: the town's parts, and the estate's on top of them. */
const NAMESPACES: Record<keyof typeof STACKS, readonly string[]> = { town: ['town'], vampire: ['town', 'vamp'] };
/** Allowed start map size per stack: [min, max] on each side. */
const SIZE: Record<keyof typeof STACKS, readonly [number, number]> = { town: [280, 360], vampire: [128, 128] };

const startMap = (def: Definition): MapDef => def.maps[def.start.map]!;
const walkable = (def: Definition, map: MapDef, x: number, y: number, z: number): boolean =>
  def.tiles[map.cells[(z * map.height + y) * map.width + x]!]?.walkable ?? false;

test('maps: the town and the estate have their sizes', () => {
  for (const [name, def] of Object.entries(DEFS) as [keyof typeof STACKS, Definition][]) {
    const map = startMap(def);
    const [min, max] = SIZE[name];
    for (const side of [map.width, map.height]) assert.ok(side >= min && side <= max, `${name}: ${map.id} is ${map.width}×${map.height}`);
  }
});

test('maps: every door joins the player start', () => {
  for (const [name, def] of Object.entries(DEFS)) {
    const w = World.create(def, 1);
    const g = w.grid;
    const labels = g.regions();
    const home = labels[g.index(w.player.x, w.player.y, w.player.z)]!;
    let doors = 0;
    for (let i = 0; i < g.cells.length; i++) {
      if (def.tiles[g.cells[i]!]?.id !== 'std:door') continue;
      doors++;
      assert.equal(labels[i], home, `${name}: door at ${JSON.stringify(g.cellOf(i))}`);
    }
    assert.ok(doors > 0, `${name}: no doors`);
  }
});

test('maps: every room of the parts holds a 3×3 square of walkable cells (bathrooms 2×2)', () => {
  for (const [name, def] of Object.entries(DEFS) as [keyof typeof STACKS, Definition][]) {
    const parts = def.maps.filter((m) => !m.composite && NAMESPACES[name].includes(m.id.slice(0, m.id.indexOf(':'))));
    let rooms = 0;
    for (const map of parts) {
      for (const r of map.rooms.rects) {
        rooms++;
        const tags = r.tags.map((t) => def.roomTags[t]!);
        // No stairwell is a room of its own here: only bathrooms may be narrow.
        const n = tags.includes('bathroom') ? 2 : 3;
        let found = false;
        for (let y = r.y; y + n <= r.y + r.h && !found; y++)
          for (let x = r.x; x + n <= r.x + r.w && !found; x++) {
            let ok = true;
            for (let j = 0; j < n && ok; j++) for (let i = 0; i < n && ok; i++) ok = walkable(def, map, x + i, y + j, r.z);
            found = ok;
          }
        assert.ok(found, `${name}: ${map.id} room ${tags.join(',')} at [${r.x}, ${r.y}, ${r.w}, ${r.h}] floor ${r.z} has no ${n}×${n} walkable square`);
      }
    }
    assert.ok(rooms > 0, `${name}: no rooms`);
  }
});

test('maps: the town roads are 5 wide everywhere (a wreck on the road does not narrow it)', () => {
  const def = DEFS.town;
  const map = startMap(def);
  const road = def.ids.tiles['town:road']!;
  const car = def.ids.tiles['town:car']!;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= map.width || y >= map.height ? -1 : map.cells[y * map.width + x]!);
  const paved = (x: number, y: number) => at(x, y) === road || at(x, y) === car;
  const run = (x: number, y: number, dx: number, dy: number) => {
    let n = 1;
    for (let k = 1; paved(x + k * dx, y + k * dy); k++) n++;
    for (let k = 1; paved(x - k * dx, y - k * dy); k++) n++;
    return n;
  };
  let cells = 0;
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      if (at(x, y) !== road) continue;
      cells++;
      // The run across the road is the shorter of the two.
      const across = Math.min(run(x, y, 1, 0), run(x, y, 0, 1));
      assert.ok(across >= 5, `road at ${x},${y} is ${across} wide`);
    }
  assert.ok(cells > 0);
});
