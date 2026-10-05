import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAscii } from '../src/ascii/render.ts';
import { actionMenu, handleKey, type KeyState } from '../src/ascii/terminal.ts';
import {
  EMPTY_TILE,
  formatError,
  hudLines,
  hudModel,
  lineOfSight,
  loadPacks,
  loadPacksOrThrow,
  Pathfinder,
  renderPosition,
  World,
  type Definition,
  type Entity,
  type LoadError,
  type MapDef,
} from '../src/core/index.ts';
import { FADE_ALPHA, fadeCells, fades, floorVisible, viewFloor } from '../src/iso/cutaway.ts';
import { BLOCK_H, cameraAt, FLOOR_H, floorCamera, groundCentreIso, pickCell, pickTile } from '../src/iso/projection.ts';
import { readPack } from '../src/node/read-pack.ts';
import { climbKey, suppressesDefault } from '../src/web/keys.ts';
import { contextMenu, menuTitle, runMenuItem } from '../src/web/menu.ts';
import { clickIntent } from '../src/web/panels.ts';
import { assertRoundTrip, fixture, GAMES } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   floor 0          floor 1
//   #######          #######
//   #@..<.#          #.B.>.#      < stairs (climb: up) at (4, 1, 0), > its landing
//   #..B..#          #.....#      B crates (containers)
//   #.....#          #   ..#      spaces: empty cells
//   #######          #######

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: stairs, label: Stairs, glyph: "<", color: white, walkable: true, raised: true, opaque: false, climb: up }
  - { id: landing, label: Landing, glyph: ">", color: white, walkable: true }
  - { id: crate, label: Crate, glyph: B, color: gray, walkable: false, container: { capacity: 5 } }
  - { id: hatch, label: Hatch, glyph: v, color: gray, walkable: true, climb: down }
`;

const FLOOR0 = ['#######', '#@..<.#', '#..B..#', '#.....#', '#######'];
const FLOOR1 = ['#######', '#.B.>.#', '#.....#', '#   ..#', '#######'];

function files(floors: readonly (readonly string[])[] = [FLOOR0, FLOOR1], extra: Record<string, string> = {}): Record<string, string> {
  return {
    'tiles.yaml': TILES,
    'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    measurements: [hp, food]
    ticks_per_step: 2
    ticks_per_turn: 1
    inventory: { capacity: 10, items: { pebble: 2, bell: 1 } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
  - { id: chaser, label: Chaser, glyph: c, color: red, ticks_per_step: 2, ticks_per_turn: 0, behavior: chase }
  - { id: listener, label: Listener, glyph: l, color: red, ticks_per_step: 1, ticks_per_turn: 0, behavior: listen }
`,
    'items.yaml': `items:
  - { id: pebble, label: Pebble, glyph: ",", color: gray, weight: 0.1 }
  - id: bell
    label: Bell
    glyph: b
    color: yellow
    weight: 0.1
    use: { label: Ring, consume: 0, effects: [{ type: noise, radius: 1.5 }] }
`,
    'actions.yaml': `actions:
  - id: kick
    label: Kick
    target: { tiles: [crate] }
    effects:
      - { type: apply, measurement: food, delta: 1 }
`,
    'behaviors.yaml': `behaviors:
  - id: chase
    initial: go
    states:
      go: { do: pursue, target: player, repath: 0.1 }
  - id: listen
    initial: wait
    states:
      wait:
        do: idle
        on: [{ when: 'heard(self, 1)', to: go }]
      go:
        do: investigate
        repath: 0.1
        done: wait
`,
    'map.yaml': `maps:
  - id: house
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "<": { tile: stairs, facing: w }
      ">": { tile: landing }
      "B": { tile: crate }
      "v": { tile: hatch }
      "o": { tile: floor, spawn: rock }
      "c": { tile: floor, spawn: chaser }
      "l": { tile: floor, spawn: listener }
    floors:
${floors.map((rows) => `      - rows: ${JSON.stringify(rows)}`).join('\n')}
    rooms:
      - { rect: [1, 1, 5, 3], tags: [den] }
      - { rect: [1, 1, 5, 2], tags: [attic], floor: 1 }
start:
  map: house
  player: hero
`,
    ...extra,
  };
}

function def(floors?: readonly (readonly string[])[], extra?: Record<string, string>): Definition {
  return loadPacksOrThrow([fixture(files(floors, extra))]);
}

function world(floors?: readonly (readonly string[])[], seed = 1): World {
  return World.create(def(floors), seed);
}

function errorsOf(fs: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture(fs)]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

/** Put an entity on a cell at rest (no step, no cooldown). */
function place(e: Entity, x: number, y: number, z = 0): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
  e.z = e.fromZ = z;
  e.moveCooldown = 0;
  e.path = null;
}

function stepUntil(w: World, done: () => boolean, max = 500): void {
  for (let i = 0; i < max && !done(); i++) w.step();
  assert.ok(done(), `not done after ${max} ticks (tick ${w.tick})`);
}

const at = (e: Entity) => [e.x, e.y, e.z];

// ── Loader ──────────────────────────────────────────────────────────────────

test('floors: ASCII floors, spaces as empty cells, rooms per floor, spawns by z then row-major', () => {
  const d = def([
    ['#######', '#@..<o#', '#..B..#', '#.o...#', '#######'],
    ['#######', '#oB.>.#', '#.....#', '#   ..#', '#######'],
  ]);
  const m = d.maps[0]!;
  assert.equal(m.floors, 2);
  assert.equal(m.cells.length, 2 * 7 * 5);
  const t = (id: string) => d.ids.tiles[`t:${id}`]!;
  const cell = (x: number, y: number, z: number) => m.cells[(z * m.height + y) * m.width + x];
  assert.equal(cell(4, 1, 0), t('stairs'));
  assert.equal(cell(4, 1, 1), t('landing'));
  assert.equal(cell(1, 3, 1), EMPTY_TILE);
  assert.equal(cell(3, 3, 1), EMPTY_TILE);
  assert.equal(cell(4, 3, 1), t('floor'));
  assert.deepEqual(m.playerStart, { x: 1, y: 1, z: 0 });
  assert.deepEqual(
    m.spawns.map((s) => [s.x, s.y, s.z]),
    [
      [5, 1, 0],
      [2, 3, 0],
      [1, 1, 1],
    ],
  );
  assert.deepEqual(m.rooms.rects.map((r) => r.z), [0, 1]);
  const w = World.create(d, 1);
  const tags = (x: number, y: number, z?: number) => w.roomTagsAt(x, y, z).map((k) => d.roomTags[k]);
  assert.deepEqual(tags(1, 3), ['den'], 'defaults to the player floor');
  assert.deepEqual(tags(1, 1, 1), ['attic']);
  assert.deepEqual(tags(1, 3, 1), []);
  // A legend entry for ' ' wins over the empty default; `rows` maps keep working.
  const solid = loadPacksOrThrow([
    fixture({
      'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, " ": { tile: floor }, "@": { tile: floor, player: true } }
    rows: ["@. ", " .."]
start: { map: room, player: hero }
`,
    }),
  ]);
  assert.equal(solid.maps[0]!.floors, 1);
  assert.ok(solid.maps[0]!.cells.every((c) => c === solid.ids.tiles['t:floor']));
});

test('floors: load errors name the floor and both cells of a bad link', () => {
  const tiles = (extra: string) => ({ 'tiles.yaml': TILES + extra });
  let e = errorsOf(files([FLOOR0, ['#######', '#.B.>.#', '#..X..#', '#   ..#']]));
  expectError(e, 'maps[0].floors[1].rows', /floor 1 has 4 rows, expected 5 \(the rows of floor 0\)/);
  e = errorsOf(files([FLOOR0, ['#######', '#.B.>.#', '#..X..#', '#   ..#', '#######']]));
  expectError(e, 'maps[0].floors[1].rows[2]', /map character 'X' \(floor 1, row 2, column 3\) is not in the legend/);
  e = errorsOf(files([FLOOR0, ['#######', '#.B.>.##', '#.....#', '#   ..#', '#######']]));
  expectError(e, 'maps[0].floors[1].rows[1]', /ragged map rows: row 1 has length 8, expected 7 \(the length of row 0 of floor 0\)/);
  // Links: stairs under a wall, under an empty cell, on the top floor; a hatch on floor 0.
  e = errorsOf(files([FLOOR0, ['#######', '#.B.#.#', '#.....#', '#   ..#', '#######']]));
  expectError(e, 'maps[0].floors[0].rows[1]', /'t:stairs' at \(4, 1, floor 0\) climbs up to \(4, 1, floor 1\), which is 't:wall' \(not walkable\)/);
  e = errorsOf(files([FLOOR0, ['#######', '#.B. .#', '#.....#', '#   ..#', '#######']]));
  expectError(e, 'maps[0].floors[0].rows[1]', /climbs up to \(4, 1, floor 1\), which is an empty cell/);
  e = errorsOf(files([FLOOR0]));
  expectError(e, 'maps[0].floors[0].rows[1]', /climbs up to \(4, 1, floor 1\), which is outside the map \(it has 1 floor\)/);
  e = errorsOf(files([['#######', '#@.v..#', '#.....#', '#.....#', '#######']]));
  expectError(e, 'maps[0].floors[0].rows[1]', /'t:hatch' at \(3, 1, floor 0\) climbs down to \(3, 1, floor -1\), which is outside the map/);
  // Tile fields: climb must be up/down, on a walkable tile.
  e = errorsOf({ ...files(), ...tiles('  - { id: ramp, label: Ramp, glyph: r, color: gray, walkable: true, climb: sideways }\n') });
  expectError(e, 'tiles[6].climb', /field 'climb' must be 'up' or 'down', got "sideways"/);
  e = errorsOf({ ...files(), ...tiles('  - { id: pole, label: Pole, glyph: p, color: gray, walkable: false, climb: up }\n') });
  expectError(e, 'tiles[6].climb', /a 'climb' tile must be walkable/);
  // rows and floors together; a room on a floor that does not exist.
  e = errorsOf({ ...files(), 'map.yaml': files()['map.yaml']!.replace('    floors:', '    rows: ["@"]\n    floors:') });
  expectError(e, 'maps[0].floors', /either 'rows' \(one floor\) or 'floors', not both/);
  e = errorsOf({ ...files(), 'map.yaml': files()['map.yaml']!.replace('floor: 1 }', 'floor: 2 }') });
  expectError(e, 'maps[0].rooms[1].floor', /room 'floor' must be an existing floor \(0–1\), got 2/);
});

// ── Grid ────────────────────────────────────────────────────────────────────

test('grid: cell index (z * height + y) * width + x; one-floor maps keep y * width + x', () => {
  const w = world();
  const g = w.grid;
  assert.equal(g.floors, 2);
  assert.equal(g.index(3, 2, 1), (1 * 5 + 2) * 7 + 3);
  assert.equal(g.index(3, 2), 2 * 7 + 3);
  assert.deepEqual(g.cellOf(g.index(5, 3, 1)), { x: 5, y: 3, z: 1 });
  assert.ok(g.inBounds(6, 4, 1) && !g.inBounds(6, 4, 2) && !g.inBounds(0, 0, -1));
  // Empty cells: no tile, not walkable, not opaque.
  assert.equal(g.tileAt(2, 3, 1), undefined);
  assert.ok(g.isEmpty(2, 3, 1) && !g.isEmpty(2, 3, 0));
  assert.ok(!g.walkable(2, 3, 1) && !g.opaqueAt(2, 3, 1));
  assert.equal(g.tileAt(4, 1, 1)!.id, 't:landing');
  assert.equal(g.tileAt(4, 1)!.id, 't:stairs', 'z defaults to 0');
  // Links are live both ways while both ends are walkable.
  assert.equal(g.link(g.index(4, 1, 0), 1), g.index(4, 1, 1));
  assert.equal(g.link(g.index(4, 1, 1), -1), g.index(4, 1, 0));
  assert.equal(g.link(g.index(4, 1, 0), -1), -1);
  assert.equal(g.link(g.index(3, 1, 0), 1), -1);
  // One floor: identical indices to the row-major layout.
  const one = World.create(loadPacksOrThrow([fixture()]), 1).grid;
  assert.equal(one.floors, 1);
  for (let y = 0; y < one.height; y++) for (let x = 0; x < one.width; x++) assert.equal(one.index(x, y), y * one.width + x);
});

// ── A* ──────────────────────────────────────────────────────────────────────

const TOWER = [
  ['#######', '#@....#', '#....<#', '#######'],
  ['#######', '#<...>#', '#.....#', '#######'],
  ['#######', '#>....#', '#.....#', '#######'],
];

test('A*: crosses one and two links (cost 1 each); a set_tile on either end blocks the link', () => {
  const w = world(TOWER);
  const g = w.grid;
  const pf = new Pathfinder(g);
  const cells = (p: Int32Array | null) => (p ? [...p].map((i) => Object.values(g.cellOf(i))) : null);
  // Up one floor: walk to the stairs, climb, step off.
  assert.deepEqual(cells(pf.findPath(1, 1, 4, 2, 0, 1)), [
    [2, 1, 0],
    [3, 1, 0],
    [4, 2, 0],
    [5, 2, 0],
    [5, 2, 1],
    [4, 2, 1],
  ]);
  // Two floors: through both links; and back down.
  const up = cells(pf.findPath(1, 1, 3, 2, 0, 2))!;
  assert.deepEqual(up.filter((c, i) => i > 0 && c[2] !== up[i - 1]![2]), [
    [5, 2, 1],
    [1, 1, 2],
  ]);
  assert.deepEqual(up.at(-1), [3, 2, 2]);
  const down = cells(pf.findPath(3, 2, 1, 1, 2, 0))!;
  assert.deepEqual(down.at(-1), [1, 1, 0]);
  assert.equal(down.length, up.length, 'the same route back');
  // Adjacent goals only count on the goal's floor.
  const adj = cells(pf.findPathAdjacent(1, 1, 5, 2, 0, 1))!;
  assert.deepEqual(adj.at(-1), [5, 2, 1]);
  // Blocked: a wall on the landing closes the link both ways.
  g.setTile(g.index(5, 2, 1), w.def.ids.tiles['t:wall']!);
  assert.equal(pf.findPath(1, 1, 4, 2, 0, 1), null);
  assert.equal(g.link(g.index(5, 2, 0), 1), -1);
  g.setTile(g.index(5, 2, 1), w.def.ids.tiles['t:landing']!);
  assert.notEqual(pf.findPath(1, 1, 4, 2, 0, 1), null, 'open again');
});

test('A*: deterministic, links tried after the 8 directions', () => {
  // Two stairs at the same distance from the start: the tie goes the same way every time.
  const twin = [
    ['#######', '#<.@.<#', '#.....#', '#######'],
    ['#######', '#>...>#', '#.....#', '#######'],
  ];
  const run = () => {
    const w = world(twin);
    return [...new Pathfinder(w.grid).findPath(3, 1, 3, 2, 0, 1)!];
  };
  const a = run();
  assert.deepEqual(a, run());
  const w0 = world(twin);
  const cells = a.map((i) => Object.values(w0.grid.cellOf(i)));
  assert.equal(cells.length, 5, 'two steps, the link, two steps');
  assert.deepEqual(cells.slice(1, 3), [
    [5, 1, 0],
    [5, 1, 1],
  ], 'the tie goes to the east stairs (orthogonal +x is tried first)');
  // From a cell with a link, the same-floor goal is reached without climbing even when climbing ties.
  const w = world(TOWER);
  const p = new Pathfinder(w.grid).findPath(5, 2, 5, 1, 0, 0)!;
  assert.deepEqual([...p].map((i) => w.grid.cellOf(i).z), [0]);
});

// ── Movement ────────────────────────────────────────────────────────────────

test('movement: a link step takes ticks_per_step, keeps the facing and sets fromZ; renderPosition lerps z', () => {
  const w = world();
  const p = w.player;
  place(p, 4, 1);
  p.facing = 'e';
  const intent = w.climbIntent(1)!;
  assert.deepEqual(intent, { kind: 'goto', x: 4, y: 1, z: 1 });
  w.queueIntent(intent);
  w.step(); // tick 0: the climb (no turn beat)
  assert.deepEqual(at(p), [4, 1, 1]);
  assert.deepEqual([p.fromX, p.fromY, p.fromZ], [4, 1, 0]);
  assert.equal(p.facing, 'e');
  assert.equal(p.moveCooldown, 2);
  assert.deepEqual(renderPosition(p, w.tick, 0), { x: 4, y: 1, z: 0 });
  assert.deepEqual(renderPosition(p, w.tick, 1), { x: 4, y: 1, z: 0.5 });
  w.step();
  assert.deepEqual(renderPosition(p, w.tick, 1), { x: 4, y: 1, z: 1 });
  // Down again: a goto to the cell below.
  w.queueIntent(w.climbIntent(-1)!);
  w.step();
  assert.equal(p.z, 0);
  assert.equal(w.climbIntent(-1), null);
  place(p, 3, 1);
  assert.equal(w.climbIntent(1), null, 'no link here');
});

test('movement: a step intent stays on its floor and never takes a link', () => {
  const w = world();
  const p = w.player;
  place(p, 3, 1);
  p.facing = 'e';
  for (const dx of [1, 1, 0] as const) {
    w.queueIntent({ kind: 'step', dx, dy: 0 });
    for (let i = 0; i < 3; i++) w.step();
    assert.equal(p.z, 0);
  }
  assert.deepEqual(at(p), [5, 1, 0], 'walked over the stairs');
  // A goto defaults to the entity's floor.
  place(p, 4, 1, 1);
  w.queueIntent({ kind: 'goto', x: 5, y: 3 });
  w.step();
  assert.deepEqual(w.lastGoto, { x: 5, y: 3, z: 1, ok: true, tick: w.tick - 1 });
  assert.deepEqual(w.pathGoal(p), { x: 5, y: 3, z: 1 });
});

// ── Reach ───────────────────────────────────────────────────────────────────

test('reach: containers and tile actions on another floor are out of reach; drop goes to the player floor', () => {
  const w = world();
  const p = w.player;
  const down = w.containersAt(3, 2, 0)[0]!;
  const up = w.containersAt(2, 1, 1)[0]!;
  assert.equal(up.z, 1);
  assert.deepEqual(w.containersAt(2, 1), [], 'defaults to the player floor');
  // The player stands right below the upstairs crate.
  place(p, 2, 2, 0);
  assert.deepEqual(w.reachableContainers().map((c) => c.id), [down.id]);
  w.queueAction({ kind: 'put', container: up.id, item: 't:pebble', count: 1 });
  w.step();
  assert.equal(w.lastAction!.reason, 'out_of_reach');
  w.queueAction({ kind: 'act', action: 't:kick', x: 2, y: 1, z: 1 });
  w.step();
  assert.equal(w.lastAction!.reason, 'out_of_reach');
  w.queueAction({ kind: 'act', action: 't:kick', x: 3, y: 2 });
  w.step();
  assert.equal(w.lastAction!.ok, true, 'z defaults to the player floor');
  // Upstairs: in reach, and the pile lands on floor 1.
  place(p, 2, 2, 1);
  assert.deepEqual(w.reachableContainers().map((c) => c.id), [up.id]);
  w.queueAction({ kind: 'put', container: up.id, item: 't:pebble', count: 1 });
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  assert.equal(w.lastAction!.ok, true);
  const pile = w.containersAt(2, 2, 1).find((c) => c.kind === 'ground')!;
  assert.equal(pile.z, 1);
  assert.deepEqual(w.containersAt(2, 2, 0), []);
  assert.deepEqual(w.availableActions().filter((a) => a.x !== undefined).map((a) => [a.x, a.y, a.z]), [[2, 1, 1]]);
  // approachIntent walks to the other floor.
  place(p, 1, 1, 0);
  assert.deepEqual(w.approachIntent({ kind: 'take', container: up.id, item: 't:pebble' }), {
    kind: 'goto',
    x: 2,
    y: 1,
    z: 1,
    adjacent: true,
    then: { kind: 'take', container: up.id, item: 't:pebble' },
  });
});

// ── Sight and hearing ───────────────────────────────────────────────────────

test('sight: false across floors; hearing is 3D euclidean, one floor = one tile', () => {
  const w = world([
    ['#######', '#@..<.#', '#.....#', '#.....#', '#######'],
    ['#######', '#.l.>.#', '#.l...#', '#.....#', '#######'],
  ]);
  const g = w.grid;
  assert.equal(lineOfSight(g, 1, 1, 2, 1, 0, 0), true);
  assert.equal(lineOfSight(g, 1, 1, 1, 1, 0, 1), false, 'not even straight up');
  assert.equal(lineOfSight(g, 1, 1, 3, 2, 1), true, 'z1 defaults to z0');
  const [a, b] = w.entities.filter((e) => e.archetype.id === 't:listener') as [Entity, Entity];
  // The bell (radius 1.5) rung at (2, 1, 0): `a` right above (distance 1), `b` at distance √2.
  place(w.player, 2, 1, 0);
  place(a, 2, 1, 1);
  place(b, 3, 2, 1);
  w.queueAction({ kind: 'use', item: 't:bell' });
  w.step();
  assert.deepEqual(w.noises, [{ x: 2, y: 1, z: 0, radius: 1.5, source: w.player.id }]);
  assert.deepEqual([a.heardX, a.heardY, a.heardZ, a.heardTick], [2, 1, 0, 0]);
  assert.equal(b.heardTick, -1, '√(1 + 1 + 1) > 1.5');
});

// ── Behaviors ───────────────────────────────────────────────────────────────

test('behaviors: a pursuer follows the player up the stairs; a listener goes down to a noise', () => {
  const w = world([
    ['#######', '#@..<.#', '#.....#', '#....c#', '#######'],
    ['#######', '#....>#', '#.....#', '#l....#', '#######'],
  ]);
  const p = w.player;
  const c = w.entities.find((e) => e.archetype.id === 't:chaser')!;
  w.queueIntent({ kind: 'goto', x: 1, y: 2, z: 1 });
  stepUntil(w, () => p.z === 1 && !p.path);
  stepUntil(w, () => c.z === 1 && Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) <= 1);
  assert.deepEqual(w.snapshot().entities[c.id]!.behavior!.plan!.slice(0, 3), [p.x, p.y, 1]);
  // The listener upstairs hears the bell rung downstairs and walks down to it.
  const l = w.entities.find((e) => e.archetype.id === 't:listener')!;
  place(c, 5, 3, 1);
  place(p, 4, 2, 0);
  place(l, 4, 2, 1);
  w.queueAction({ kind: 'use', item: 't:bell' });
  w.step(); // heard at the end of this tick
  w.step();
  assert.equal(l.state, 1, 'investigating');
  stepUntil(w, () => l.z === 0);
  assert.equal(w.entities[l.id]!.heardZ, 0);
});

test('behaviors: wander and flee stay on their floor, even from the stairs', () => {
  const d = def(
    [
      ['#######', '#@..c.#', '#.....#', '#..l..#', '#######'],
      ['#######', '#....>#', '#.....#', '#.....#', '#######'],
    ].map((f, z) => (z === 0 ? f.map((r) => r.replace('c.#', '.<#').replace('#@..', '#@.c')) : f)),
    {
      'behaviors.yaml': `behaviors:
  - id: chase
    initial: go
    states: { go: { do: wander } }
  - id: listen
    initial: go
    states: { go: { do: flee, target: player } }
`,
    },
  );
  const w = World.create(d, 3);
  const [c, l] = [w.entities.find((e) => e.archetype.id === 't:chaser')!, w.entities.find((e) => e.archetype.id === 't:listener')!];
  place(c, 5, 1, 0); // on the stairs
  place(l, 5, 1, 0);
  place(w.player, 4, 1, 0);
  for (let i = 0; i < 300; i++) {
    w.step();
    assert.equal(c.z, 0);
    assert.equal(l.z, 0);
  }
});

// ── Save ────────────────────────────────────────────────────────────────────

test('save: round trip on a multi-floor world, including mid-climb and upstairs piles and tiles', () => {
  const w = world([
    ['#######', '#@..<.#', '#..B..#', '#....c#', '#######'],
    ['#######', '#.B.>.#', '#.....#', '#l  ..#', '#######'],
  ]);
  assert.equal(w.save().map.floors, 2);
  assertRoundTrip(w, undefined, 5);
  w.queueIntent({ kind: 'goto', x: 4, y: 2, z: 1 });
  stepUntil(w, () => w.player.z === 1); // the tick the climb was taken: mid-climb
  assert.equal(w.player.fromZ, 0);
  assertRoundTrip(w, undefined, 3);
  w.grid.setTile(w.grid.index(5, 3, 1), w.def.ids.tiles['t:wall']!);
  w.queueAction({ kind: 'drop', item: 't:pebble' });
  w.step();
  const snap = w.snapshot();
  assert.deepEqual(snap.tiles, [[5, 3, 1, 't:wall']]);
  assert.ok(snap.containers.some((c) => c.kind === 'ground' && c.cell![2] === 1));
  assert.equal(snap.entities[0]!.z, 1);
  assertRoundTrip(w, undefined, 60);
});

test('save: a changed tile on an empty cell is rejected', () => {
  const w = world();
  const s = JSON.parse(JSON.stringify(w.save()));
  s.state.tiles.push([1, 3, 1, 't:floor']);
  const r = World.restore(w.def, s);
  assert.ok(!r.ok && r.errors.some((e) => /cell \(1, 3, 1\) is empty in the map/.test(e)), JSON.stringify(r));
});

// ── Interactions and shells ─────────────────────────────────────────────────

test('interactionsAt: Go up / Go down on link cells, before walk; the context menu walks through the link', () => {
  const w = world();
  const p = w.player;
  const kinds = (x: number, y: number, z?: number) => w.interactionsAt(x, y, z).map((e) => e.id);
  assert.deepEqual(kinds(4, 1), ['climb:up', 'walk']);
  assert.deepEqual(kinds(4, 1, 1), ['climb:down', 'walk']);
  assert.deepEqual(kinds(3, 1), ['walk']);
  assert.deepEqual(kinds(2, 3, 1), [], 'an empty cell offers nothing');
  assert.equal(menuTitle(w, 2, 3, 1), '');
  assert.equal(menuTitle(w, 2, 2, 1), 'Floor · attic');
  const up = w.interactionsAt(4, 1)[0]!;
  assert.deepEqual(up, { id: 'climb:up', label: 'Go up', kind: 'climb', ok: true, intent: { kind: 'goto', x: 4, y: 1, z: 1 }, inReach: false });
  // From afar, "Go up" walks to the stairs and climbs.
  const menu = contextMenu(w, 4, 1);
  assert.deepEqual(menu.map((m) => m.label), ['Go up', 'Walk here']);
  runMenuItem(w, menu[0]!);
  stepUntil(w, () => !p.path && p.z === 1);
  assert.deepEqual(at(p), [4, 1, 1]);
  // On the landing: Go down, then the self actions (none here).
  assert.deepEqual(contextMenu(w, 4, 1).map((m) => m.label), ['Go down']);
  // Blocked by a set_tile: no entry.
  w.grid.setTile(w.grid.index(4, 1, 0), w.def.ids.tiles['t:wall']!);
  assert.deepEqual(kinds(4, 1), []);
  // Click-to-move picks the clicked floor.
  assert.deepEqual(clickIntent(w, 2, 1, 1), { kind: 'goto', x: 2, y: 1, z: 1, adjacent: true });
  assert.deepEqual(clickIntent(w, 3, 3, 0), { kind: 'goto', x: 3, y: 3, z: 0 });
});

test('browser: PageUp/PageDown and < / > (by key) climb; PageUp/PageDown do not scroll', () => {
  assert.equal(climbKey('PageUp'), 1);
  assert.equal(climbKey('<'), 1);
  assert.equal(climbKey('PageDown'), -1);
  assert.equal(climbKey('>'), -1);
  assert.equal(climbKey('w'), 0);
  assert.equal(climbKey('ArrowUp'), 0);
  assert.ok(suppressesDefault('PageUp') && suppressesDefault('PageDown'));
});

test('terminal: < / > climb or say there is no way; the x list offers Go up; the view shows the player floor', () => {
  const w = world([
    ['#######', '#@..<.#', '#..B..#', '#....c#', '#######'],
    ['#######', '#.B.>.#', '#.....#', '#l  ..#', '#######'],
  ]);
  const p = w.player;
  const keys: KeyState = { dropPending: false };
  handleKey(w, '<', keys);
  assert.equal(keys.message, 'No way up here.');
  handleKey(w, '>', keys);
  assert.equal(keys.message, 'No way down here.');
  place(p, 4, 1, 0);
  assert.deepEqual(actionMenu(w).map((e) => e.label), ['Go up', 'Kick']);
  handleKey(w, 'x', keys);
  handleKey(w, '1', keys);
  w.step();
  assert.equal(p.z, 1);
  assert.equal(keys.message, null);
  handleKey(w, '>', keys);
  assert.deepEqual(p.intent, { kind: 'goto', x: 4, y: 1, z: 0 });
  p.intent = null;
  // The view shows floor 1 only: the crate upstairs, the empty cells as spaces, the listener; not the chaser below.
  const frame = renderAscii(w, { width: 7, height: 5 });
  // Centred on the player at (4, 1): the view starts at (1, -1).
  assert.deepEqual(frame.lines, ['       ', '###### ', '.B.@.# ', '.....# ', 'l  ..# ']);
  assert.equal(frame.colors[4]![1], null, 'an empty cell has no colour');
  const hud = hudLines(hudModel(w));
  assert.equal(hud[1], 'Floor 1');
  assert.equal(hudModel(World.create(loadPacksOrThrow([fixture()]), 1)).floor, null);
});

// ── Renderer rules ──────────────────────────────────────────────────────────

test('cutaway: the view floor switches at the midpoint; floors above it are hidden', () => {
  assert.equal(viewFloor(0, 2), 0);
  assert.equal(viewFloor(0.49, 2), 0);
  assert.equal(viewFloor(0.5, 2), 1);
  assert.equal(viewFloor(1, 2), 1);
  assert.equal(viewFloor(3, 2), 1, 'clamped');
  assert.ok(floorVisible(0, 1) && floorVisible(1, 1) && !floorVisible(2, 1));
});

test('fade: blocks just in front of the player and close on screen', () => {
  // Diagonal x + y in (px + py, px + py + 3], |(x − y) − (px − py)| ≤ 2.
  assert.ok(fades(6, 5, 5, 5));
  assert.ok(fades(6, 6, 5, 5));
  assert.ok(fades(7, 5, 5, 5));
  assert.ok(fades(6, 7, 5, 5));
  assert.ok(!fades(5, 5, 5, 5), 'the player cell');
  assert.ok(!fades(4, 5, 5, 5), 'behind');
  assert.ok(!fades(7, 7, 5, 5), 'four diagonals ahead');
  assert.ok(!fades(8, 5, 5, 5) && !fades(5, 8, 5, 5), 'too far to the side');
  const cells = fadeCells(5, 5);
  assert.equal(cells.length, new Set(cells.map((c) => `${c.x},${c.y}`)).size);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) assert.equal(cells.some((c) => c.x === x && c.y === y), fades(x, y, 5, 5), `${x},${y}`);
  assert.equal(FADE_ALPHA, 0.35);
});

test('picking: floor offset FLOOR_H; empty cells fall through to the floors below', () => {
  assert.equal(FLOOR_H, BLOCK_H);
  const cam = cameraAt(0, 0, 400, 300, 2);
  // Floor z is drawn FLOOR_H iso px higher: its ground centre on screen.
  const g = groundCentreIso(3, 2);
  const screen = (z: number) => ({ x: g.x * cam.zoom + cam.offsetX, y: (g.y - z * FLOOR_H) * cam.zoom + cam.offsetY });
  assert.deepEqual(floorCamera(cam, 0), cam);
  assert.equal(floorCamera(cam, 1).offsetY, cam.offsetY - FLOOR_H * 2);
  assert.deepEqual(pickTile(screen(1).x, screen(1).y, floorCamera(cam, 1), () => false), { x: 3, y: 2 });
  const filled = new Set(['3,2,1', '3,2,0', '2,1,0']);
  const isFilled = (x: number, y: number, z: number) => filled.has(`${x},${y},${z}`);
  const flat = () => false;
  assert.deepEqual(pickCell(screen(1).x, screen(1).y, cam, 1, flat, isFilled), { x: 3, y: 2, z: 1 });
  // The same screen point on floor 1 over an empty cell: floor 0 below it is picked (the cell one diagonal back).
  filled.delete('3,2,1');
  const below = pickCell(screen(1).x, screen(1).y, cam, 1, flat, isFilled);
  assert.deepEqual(below, { x: 2, y: 1, z: 0 });
  // Seen from floor 0, floor 1 is not considered.
  assert.deepEqual(pickCell(screen(0).x, screen(0).y, cam, 0, flat, isFilled), { x: 3, y: 2, z: 0 });
  // Nothing anywhere: the view floor's cell.
  assert.deepEqual(pickCell(screen(1).x, screen(1).y, cam, 1, flat, () => false), { x: 3, y: 2, z: 1 });
});

// ── Genre packs ─────────────────────────────────────────────────────────────

function genre(name: keyof typeof GAMES): Definition {
  return loadPacksOrThrow(GAMES[name].map(readPack));
}

/** Keep the player alive (and unhurried) whatever the pack's needs do. */
function sustain(w: World): void {
  const p = w.player;
  for (const idx of p.archetype.measurements) p.m[idx] = Number.isFinite(p.max[idx]!) ? p.max[idx]! : p.m[idx]!;
}

for (const name of ['zombie', 'vampire'] as const) {
  test(`reachability (${name}): every walkable cell and every container on every floor is reachable from the player start`, () => {
    const d = genre(name);
    const m: MapDef = d.maps[d.start.map]!;
    assert.equal(m.floors, 2);
    const w = World.create(d, 1);
    const g = w.grid;
    const pf = new Pathfinder(g);
    const s = m.playerStart!;
    const unreachable: string[] = [];
    for (let z = 0; z < g.floors; z++) {
      for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width; x++) if (g.walkable(x, y, z) && !pf.findPath(s.x, s.y, x, y, s.z, z)) unreachable.push(`(${x}, ${y}, ${z})`);
      }
    }
    assert.deepEqual(unreachable, []);
    for (const c of w.containers.values()) {
      if (c.kind !== 'tile') continue;
      assert.ok(pf.findPathAdjacent(s.x, s.y, c.x, c.y, s.z, c.z), `container at (${c.x}, ${c.y}, ${c.z})`);
    }
    assert.ok([...w.containers.values()].some((c) => c.kind === 'tile' && c.z === 1), 'a container upstairs');
  });
}

test('scenario (zombie): the player climbs, loots the upstairs dresser, and a shambler follows after a noise', () => {
  const d = genre('zombie');
  const room = d.roomTags.indexOf('bedroom');
  const upstairs = (w: World) => [...w.containers.values()].find((c) => c.kind === 'tile' && c.z === 1)!;
  // Bedroom loot may roll nothing: the first three seeds with something to take.
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1)
    .filter((s) => upstairs(World.create(d, s)).stacks.length > 0)
    .slice(0, 3);
  assert.equal(seeds.length, 3);
  for (const seed of seeds) {
    const w = World.create(d, seed);
    const p = w.player;
    const dresser = upstairs(w);
    assert.equal(w.def.tiles[dresser.tile]!.id, 'zmb:dresser');
    assert.ok(w.roomTagsAt(dresser.x, dresser.y, 1).includes(room), 'the dresser is in a bedroom');
    const below = w.entities.filter((e) => e.archetype.id === 'zmb:shambler' && e.z === 0);
    assert.ok(w.entities.some((e) => e.archetype.id === 'zmb:shambler' && e.z === 1), 'one shambler starts upstairs');
    // Walk up and take the first stack (walk-then-act).
    const item = w.def.items[dresser.stacks[0]!.item]!.id;
    w.queueIntent(w.approachIntent({ kind: 'take', container: dresser.id, item })!);
    for (let i = 0; i < 2000 && !(w.lastAction?.kind === 'take' && w.lastAction.ok); i++) {
      sustain(w);
      w.step();
    }
    assert.equal(w.lastAction?.ok, true, `seed ${seed}: ${JSON.stringify(w.lastAction)}`);
    assert.equal(p.z, 1);
    // Wind an alarm clock upstairs: a shambler from the street comes up.
    const clock = w.def.ids.items['zmb:alarm_clock']!;
    p.inv!.stacks.push({ item: clock, count: 1 });
    w.queueAction({ kind: 'use', item: 'zmb:alarm_clock' });
    let up: Entity | undefined;
    for (let i = 0; i < 3000 && !up; i++) {
      sustain(w);
      w.step();
      up = below.find((e) => e.z === 1);
    }
    assert.ok(up, `seed ${seed}: no shambler from floor 0 came upstairs`);
  }
});

test('scenario (vampire): the player reaches the attic and opens the chest', () => {
  const d = genre('vampire');
  const study = d.roomTags.indexOf('study');
  const w = World.create(d, 1);
  const p = w.player;
  const chest = [...w.containers.values()].find((c) => c.kind === 'tile' && c.z === 1)!;
  assert.equal(w.def.tiles[chest.tile]!.id, 'vamp:chest');
  assert.ok(w.roomTagsAt(chest.x, chest.y, 1).includes(study));
  assert.ok(chest.stacks.length > 0, 'the study chest rolled loot');
  assert.ok(w.entities.some((e) => e.archetype.id === 'vamp:bat' && e.z === 1), 'a bat in the attic');
  // The context menu's Open walks up the ladder to the chest.
  const open = contextMenu(w, chest.x, chest.y, 1).find((m) => m.label === 'Open Oak chest')!;
  assert.ok(open.run.intent && open.run.openLoot);
  runMenuItem(w, open);
  for (let i = 0; i < 2000 && (p.path || p.intent); i++) {
    sustain(w);
    w.step();
  }
  assert.equal(p.z, 1);
  assert.ok(w.reachableContainers().some((c) => c.id === chest.id), 'the chest is in reach');
  const takeAll = w.interactionsAt(chest.x, chest.y, 1).find((e) => e.kind === 'take_all')!;
  assert.ok(takeAll.inReach && takeAll.ok);
  const before = chest.stacks.length;
  for (const a of takeAll.actions!) w.queueAction(a);
  w.step();
  assert.ok(chest.stacks.length < before, 'took from the chest');
});
