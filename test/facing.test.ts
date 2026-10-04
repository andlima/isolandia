import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FACINGS,
  facingOf,
  facingTable,
  formatError,
  loadPacks,
  MIRROR,
  resolveFacing,
  World,
  type Facing,
  type LoadError,
  type PackSource,
} from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, GAMES, loadFixture } from './helpers.ts';

const ART = ['a/s.svg', 'a/se.svg', 'a/e.svg', 'a/ne.svg', 'a/nw.svg', 'a/n.png', 'a/w.svg', 'a/sw.svg'];

function withAssets(assetsYaml: string, files: Record<string, string> = {}): PackSource {
  return { ...fixture({ 'assets.yaml': assetsYaml, ...files }), otherFiles: ART };
}

function errorsOf(p: PackSource): readonly LoadError[] {
  const r = loadPacks([p]);
  assert.ok(!r.ok, 'expected load errors');
  return r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}; got:\n${errors.map(formatError).join('\n')}`);
}

function assetOf(yaml: string) {
  const r = loadPacks([withAssets(yaml)]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition.assets[0]!;
}

/** `byFacing` as `facing → "file[~]"` (`~` = mirrored), for readable assertions. */
function table(a: ReturnType<typeof assetOf>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  FACINGS.forEach((f, i) => {
    const e = a.byFacing[i];
    out[f] = e ? a.images[e.image]!.file + (e.mirrored ? '~' : '') : null;
  });
  return out;
}

// ── Loader: directional assets ─────────────────────────────────────────────

test('directions: 8-way asset from 5 images, mirrored partners, shared and per-direction anchors', () => {
  const a = assetOf(`assets:
  - id: walker
    anchor: [0.5, 0.92]
    directions:
      s: a/s.svg
      se: a/se.svg
      ne: ./a/ne.svg
      w: a/w.svg
      nw: { file: a/nw.svg, anchor: [0.5, 0.9] }
`);
  assert.equal(a.ways, 8);
  assert.equal(a.images.length, 5);
  assert.deepEqual(table(a), {
    n: 'a/w.svg~',
    ne: 'a/ne.svg',
    e: 'a/s.svg~',
    se: 'a/se.svg',
    s: 'a/s.svg',
    sw: 'a/ne.svg~',
    w: 'a/w.svg',
    nw: 'a/nw.svg',
  });
  const anchorOf = (f: Facing) => a.images[a.byFacing[FACINGS.indexOf(f)]!.image]!.anchor;
  assert.deepEqual(anchorOf('s'), [0.5, 0.92]);
  assert.deepEqual(anchorOf('nw'), [0.5, 0.9]);
});

test('directions: 4-way asset from 2 images; diagonals are left to snapping', () => {
  const a = assetOf('assets:\n  - { id: box, directions: { n: a/n.png, s: a/s.svg } }\n');
  assert.equal(a.ways, 4);
  assert.deepEqual(table(a), { n: 'a/n.png', ne: null, e: 'a/s.svg~', se: null, s: 'a/s.svg', sw: null, w: 'a/n.png~', nw: null });
  assert.deepEqual(a.images[0]!.anchor, [0.5, 1]);
});

test('directions: a listed facing is never mirrored, and identical entries share an image', () => {
  const a = assetOf('assets:\n  - { id: box, directions: { n: a/n.png, w: a/w.svg, e: a/s.svg, s: a/s.svg } }\n');
  assert.deepEqual(table(a), { n: 'a/n.png', ne: null, e: 'a/s.svg', se: null, s: 'a/s.svg', sw: null, w: 'a/w.svg', nw: null });
  assert.equal(a.images.length, 3);
});

test('error: file and directions together', () => {
  const errors = errorsOf(withAssets('assets:\n  - { id: x, file: a/s.svg, directions: { s: a/s.svg, w: a/w.svg } }\n'));
  expectError(errors, 'assets[0]', /both 'file' and 'directions'/);
});

test('error: neither file nor directions', () => {
  expectError(errorsOf(withAssets('assets:\n  - { id: x }\n')), 'assets[0]', /missing required field 'file' \(or 'directions'\)/);
});

test('error: incomplete direction sets name the facings that cannot be produced', () => {
  const four = errorsOf(withAssets('assets:\n  - { id: x, directions: { s: a/s.svg, e: a/e.svg } }\n'));
  expectError(four, 'assets[0].directions', /^incomplete 4-way directions: cannot produce n, w \(/);
  const eight = errorsOf(withAssets('assets:\n  - { id: x, directions: { s: a/s.svg, w: a/w.svg, ne: a/ne.svg } }\n'));
  expectError(eight, 'assets[0].directions', /^incomplete 8-way directions: cannot produce se, nw \(/);
});

test('error: unknown direction keys and empty directions', () => {
  const errors = errorsOf(withAssets('assets:\n  - { id: x, directions: { s: a/s.svg, w: a/w.svg, north: a/n.png } }\n  - { id: y, directions: {} }\n'));
  expectError(errors, 'assets[0].directions.north', /^unknown direction 'north'/);
  expectError(errors, 'assets[1].directions', /must list at least one direction/);
});

test('error: direction files follow the file rules (missing, extension, near miss) and anchors are checked', () => {
  const errors = errorsOf(
    withAssets(`assets:
  - id: x
    directions:
      s: a/ss.svg
      w: { file: a/w.txt }
      n: { file: a/n.png, anchor: [2, 0] }
`),
  );
  expectError(errors, 'assets[0].directions.s', /^asset file 'a\/ss\.svg' not found in pack 't' \(did you mean 'a\/s\.svg'\?\)$/);
  expectError(errors, 'assets[0].directions.w.file', /unsupported asset file 'a\/w\.txt'/);
  expectError(errors, 'assets[0].directions.n.anchor', /out of range/);
});

// ── Loader: legend facing ───────────────────────────────────────────────────

const mapWith = (legendExtra: string) => `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
${legendExtra}
    rows:
      - "#####"
      - "#.@E#"
      - "#NWS#"
start: { map: room, player: hero }
`;

test('legend facing: stored per cell, null where unset; spawns and player ignore it', () => {
  const def = loadFixture({
    'map.yaml': mapWith(`      "E": { tile: wall, facing: e }
      "N": { tile: floor, facing: n, spawn: rock }
      "W": { tile: wall, facing: w }
      "S": { tile: wall, facing: s }`),
  });
  const map = def.maps[0]!;
  assert.equal(map.facings.length, map.cells.length);
  const at = (x: number, y: number) => map.facings[y * map.width + x];
  assert.equal(at(0, 0), null);
  assert.equal(at(2, 1), null);
  assert.deepEqual([at(3, 1), at(1, 2), at(2, 2), at(3, 2)], ['e', 'n', 'w', 's']);
  const w = World.create(def, 1);
  const rock = w.entities.find((e) => e.x === 1 && e.y === 2)!;
  assert.equal(facingOf(rock), 's');
  assert.equal(facingOf(w.player), 's');
});

test('error: legend facing must be n/e/s/w', () => {
  const r = loadPacks([
    fixture({ 'map.yaml': mapWith(`      "E": { tile: wall, facing: ne }
      "N": { tile: floor, facing: up }
      "W": { tile: wall, facing: 3 }
      "S": { tile: wall }`) }),
  ]);
  assert.ok(!r.ok);
  expectError(r.errors, 'maps[0].legend.E.facing', /must be one of n, e, s, w, got "ne" \(.*diagonals are not allowed\)/);
  expectError(r.errors, 'maps[0].legend.N.facing', /must be one of n, e, s, w, got "up"$/);
  expectError(r.errors, 'maps[0].legend.W.facing', /got 3/);
});

test('legend facing does not change walkability, sight or the world hash', () => {
  const plain = loadFixture({ 'map.yaml': mapWith(`      "E": { tile: wall }
      "N": { tile: floor }
      "W": { tile: wall }
      "S": { tile: wall }`) });
  const faced = loadFixture({
    'map.yaml': mapWith(`      "E": { tile: wall, facing: e }
      "N": { tile: floor, facing: n }
      "W": { tile: wall, facing: w }
      "S": { tile: wall, facing: s }`),
  });
  const a = World.create(plain, 7);
  const b = World.create(faced, 7);
  for (let i = 0; i < 20; i++) {
    a.step();
    b.step();
  }
  assert.deepEqual([...a.grid.walk], [...b.grid.walk]);
  assert.deepEqual([...a.grid.opaque], [...b.grid.opaque]);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('the genre packs load with directional assets and legend facings', () => {
  for (const dirs of Object.values(GAMES)) {
    const r = loadPacks(dirs.map((d) => readPack(d)));
    assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
    const def = r.definition;
    assert.ok(def.assets.some((a) => a.ways === 8), 'an 8-way asset');
    assert.ok(def.assets.some((a) => a.ways === 4), 'a 4-way asset');
    const facings = new Set(def.maps[def.start.map]!.facings.filter((f) => f !== null));
    assert.ok(facings.size >= 2, 'at least two different tile facings');
  }
});

// ── facingOf ────────────────────────────────────────────────────────────────

test('facingOf: all 8 step directions (ticks_per_turn 0), the never-moved case, persistence after the step', () => {
  type D = -1 | 0 | 1;
  const steps: [D, D, Facing][] = [
    [0, -1, 'n'],
    [1, -1, 'ne'],
    [1, 0, 'e'],
    [1, 1, 'se'],
    [0, 1, 's'],
    [-1, 1, 'sw'],
    [-1, 0, 'w'],
    [-1, -1, 'nw'],
  ];
  for (const [dx, dy, f] of steps) {
    const def = loadFixture({ 'map.yaml': `maps:
  - id: m
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows: ["...", ".@.", "..."]
start: { map: m, player: hero }
` });
    const w = World.create(def, 1);
    assert.equal(facingOf(w.player), 's', 'never moved');
    w.queueIntent({ kind: 'step', dx, dy });
    w.step();
    assert.deepEqual([w.player.x - 1, w.player.y - 1], [dx, dy]);
    assert.equal(facingOf(w.player), f);
    for (let i = 0; i < 10; i++) w.step();
    assert.equal(facingOf(w.player), f, 'keeps facing after stopping');
    w.queueIntent({ kind: 'step', dx, dy }); // blocked by the map edge
    for (let i = 0; i < 3; i++) w.step();
    assert.equal(facingOf(w.player), f, 'a blocked step changes nothing');
  }
});

test('facingOf reads the simulation facing', () => {
  assert.equal(facingOf({ facing: 'nw' }), 'nw');
  const w = World.create(loadFixture(), 1);
  assert.equal(w.player.facing, 's');
  w.player.facing = 'e';
  assert.equal(facingOf(w.player), 'e');
});

// ── resolveFacing (AC 5) ───────────────────────────────────────────────────

const byFacing = (listed: Partial<Record<Facing, number>>) => facingTable(new Map(Object.entries(listed) as [Facing, number][])).byFacing;

test('resolveFacing: 8-way asset shows every facing directly, mirroring partners', () => {
  const t = byFacing({ s: 0, se: 1, ne: 2, w: 3, nw: 4 });
  const listed: Record<string, number> = { s: 0, se: 1, ne: 2, w: 3, nw: 4 };
  for (const f of FACINGS) {
    for (const prev of [null, ...FACINGS]) {
      const r = resolveFacing(t, f, prev);
      assert.equal(r.facing, f);
      if (listed[f] !== undefined) assert.deepEqual([r.image, r.mirrored], [listed[f], false]);
      else assert.deepEqual([r.image, r.mirrored], [listed[MIRROR[f]], true]);
    }
  }
});

test('resolveFacing: 4-way asset snaps diagonals clockwise, sticking to the previous neighbour', () => {
  const t = byFacing({ n: 0, s: 1 });
  const want: Record<Facing, [number, boolean]> = { n: [0, false], e: [1, true], s: [1, false], w: [0, true] } as Record<Facing, [number, boolean]>;
  for (const f of ['n', 'e', 's', 'w'] as Facing[]) {
    const r = resolveFacing(t, f, 'se');
    assert.deepEqual([r.facing, r.image, r.mirrored], [f, ...want[f]]);
  }
  const cw: Record<string, Facing> = { ne: 'e', se: 's', sw: 'w', nw: 'n' };
  const ccw: Record<string, Facing> = { ne: 'n', se: 'e', sw: 's', nw: 'w' };
  for (const d of ['ne', 'se', 'sw', 'nw'] as Facing[]) {
    for (const prev of [null, ...FACINGS]) {
      const r = resolveFacing(t, d, prev);
      const shown = prev === ccw[d] ? ccw[d]! : cw[d]!;
      assert.equal(r.facing, shown, `${d} after ${prev}`);
      assert.deepEqual([r.image, r.mirrored], want[shown]);
    }
  }
});

test('resolveFacing: a single-file asset shows image 0 unmirrored for every facing', () => {
  const t = FACINGS.map(() => ({ image: 0, mirrored: false }));
  for (const f of FACINGS) assert.deepEqual(resolveFacing(t, f, null), { facing: f, image: 0, mirrored: false });
});

test('tiles: an 8-way asset on a tile only shows cardinals (legend facings are cardinal)', () => {
  const t = byFacing({ s: 0, se: 1, ne: 2, w: 3, nw: 4 });
  for (const f of ['n', 'e', 's', 'w'] as Facing[]) assert.equal(resolveFacing(t, f, null).facing, f);
});

