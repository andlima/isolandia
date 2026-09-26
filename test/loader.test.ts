import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError, loadPacks, type LoadError, type PackSource } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, MANIFEST_T, pack, TILES_T } from './helpers.ts';

const BASE = readPack('packs/base');
const ZOMBIE = readPack('packs/zombie');
const VAMPIRE = readPack('packs/vampire');

function errorsOf(packs: PackSource[]): readonly LoadError[] {
  const r = loadPacks(packs);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

interface Expected {
  pack: string;
  file: string;
  path: string;
  line?: number;
  message: RegExp;
}

/** Assert that some error matches exactly this location and message. */
function expectError(errors: readonly LoadError[], exp: Expected): void {
  const hit = errors.find(
    (e) => e.pack === exp.pack && e.file === exp.file && e.path === exp.path && e.line === exp.line && exp.message.test(e.message),
  );
  assert.ok(hit, `no error matching ${JSON.stringify({ ...exp, message: String(exp.message) })}\ngot:\n${errors.map(formatError).join('\n')}`);
}

// ── Happy paths ─────────────────────────────────────────────────────────────

test('loads base + zombie', () => {
  const r = loadPacks([BASE, ZOMBIE]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const def = r.definition;
  assert.deepEqual(
    def.packs.map((p) => p.namespace),
    ['base', 'zmb'],
  );
  assert.deepEqual(
    def.measurements.map((m) => m.id),
    ['base:hp', 'zmb:hunger', 'zmb:thirst'],
  );
  assert.equal(def.archetypes[def.start.player]!.id, 'zmb:survivor');
  assert.equal(def.maps[def.start.map]!.id, 'zmb:town');
  // Short reference `hp` in zmb resolved through depends to base:hp.
  const shambler = def.archetypes[def.ids.archetypes['zmb:shambler']!]!;
  assert.deepEqual(shambler.measurements, [def.ids.measurements['base:hp']]);
  assert.deepEqual(shambler.initial, [40]);
  // Numeric literal rate skips the expression entirely; expression rate compiles.
  const hunger = def.measurements[def.ids.measurements['zmb:hunger']!]!;
  assert.equal(hunger.rateFn, null);
  assert.equal(hunger.rateConst, 0.5);
  assert.equal(typeof def.measurements[def.ids.measurements['zmb:thirst']!]!.rateFn, 'function');
  assert.ok(def.maps[def.start.map]!.spawns.length >= 3);
});

test('loads base + vampire, with an expression max tied to base:hp', () => {
  const r = loadPacks([BASE, VAMPIRE]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const blood = r.definition.measurements[r.definition.ids.measurements['vamp:blood']!]!;
  assert.equal(typeof blood.maxFn, 'function');
  assert.equal(blood.rateConst, -0.8);
  // A humanoid from base spawned via the vampire map legend.
  const humanoid = r.definition.ids.archetypes['base:humanoid'];
  assert.ok(r.definition.maps[0]!.spawns.some((s) => s.archetype === humanoid));
});

test('the loaded definition is deeply frozen', () => {
  const r = loadPacks([BASE, ZOMBIE]);
  assert.ok(r.ok);
  const def = r.definition;
  assert.ok(Object.isFrozen(def));
  assert.ok(Object.isFrozen(def.measurements));
  assert.ok(Object.isFrozen(def.measurements[0]));
  assert.ok(Object.isFrozen(def.maps[0]!.cells));
  assert.throws(() => {
    (def.tiles as unknown as unknown[]).push({});
  }, TypeError);
});

test('zombie and vampire cannot load together without an explicit start choice', () => {
  // Both define `start`: exactly one is allowed.
  const errors = errorsOf([BASE, ZOMBIE, VAMPIRE]);
  expectError(errors, { pack: 'vamp', file: 'content.yaml', path: 'start', line: 47, message: /duplicate 'start': already defined in pack 'zmb'/ });
});

// ── One failing fixture per validation rule ────────────────────────────────

test('error: YAML syntax', () => {
  const errors = errorsOf([fixture({ 'broken.yaml': 'tiles:\n  - id: x\n    glyph: [oops\n' })]);
  expectError(errors, { pack: 't', file: 'broken.yaml', path: '', line: 4, message: /^YAML syntax error/ });
});

test('error: unknown top-level key (with suggestion)', () => {
  const errors = errorsOf([fixture({ 'extra.yaml': 'measurments: []\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'extra.yaml',
    path: 'measurments',
    line: 1,
    message: /unknown top-level key 'measurments' \(did you mean 'measurements'\?\)/,
  });
});

test('error: missing required field', () => {
  const errors = errorsOf([fixture({ 'tiles.yaml': TILES_T + '  - id: water\n    label: Water\n    glyph: "~"\n    color: blue\n' })]);
  expectError(errors, { pack: 't', file: 'tiles.yaml', path: 'tiles[2]', line: 4, message: /^missing required field 'walkable'$/ });
});

test('error: mistyped field', () => {
  const errors = errorsOf([
    fixture({ 'tiles.yaml': TILES_T + '  - id: water\n    label: Water\n    glyph: "~"\n    color: blue\n    walkable: "no"\n' }),
  ]);
  expectError(errors, {
    pack: 't',
    file: 'tiles.yaml',
    path: 'tiles[2].walkable',
    line: 8,
    message: /field 'walkable' must be a boolean \(true\/false\), got string/,
  });
});

test('error: invalid glyph', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'tiles:\n  - { id: pit, label: Pit, glyph: "~~", color: blue, walkable: false }\n' })]);
  expectError(errors, { pack: 't', file: 'more.yaml', path: 'tiles[0].glyph', line: 2, message: /must be a single character/ });
});

test('error: invalid id syntax', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'tiles:\n  - { id: Bad-Id, label: X, glyph: x, color: blue, walkable: true }\n' })]);
  expectError(errors, { pack: 't', file: 'more.yaml', path: 'tiles[0].id', line: 2, message: /invalid id 'Bad-Id'/ });
});

test('error: invalid namespace syntax', () => {
  const errors = errorsOf([pack('p', { 'pack.yaml': 'namespace: My-Pack\nname: X\nversion: 1\n' })]);
  expectError(errors, { pack: 'p', file: 'pack.yaml', path: 'namespace', line: 1, message: /invalid namespace "My-Pack"/ });
});

test('error: qualified id in a foreign namespace', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'tiles:\n  - { id: "other:pit", label: X, glyph: x, color: blue, walkable: true }\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'more.yaml',
    path: 'tiles[0].id',
    line: 2,
    message: /id 'other:pit' uses namespace 'other' but is defined in pack 't'/,
  });
});

test('error: duplicate id (across files, short and qualified forms)', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'tiles:\n  - { id: "t:floor", label: F, glyph: x, color: blue, walkable: true }\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'tiles.yaml',
    path: 'tiles[0].id',
    line: 2,
    message: /duplicate tile id 't:floor' \(first defined at t more\.yaml:2 tiles\[0\]\)/,
  });
});

test('error: duplicate id across packs (no overrides yet)', () => {
  const errors = errorsOf([
    BASE,
    pack('x', {
      'pack.yaml': 'namespace: base2\nname: X\nversion: 1\ndepends: [base]\n',
      't.yaml': 'tiles:\n  - { id: "base:floor", label: F, glyph: x, color: blue, walkable: true }\n',
    }),
  ]);
  expectError(errors, { pack: 'base2', file: 't.yaml', path: 'tiles[0].id', line: 2, message: /uses namespace 'base' but is defined in pack 'base2'/ });
  const errors2 = errorsOf([BASE, pack('b', { 'pack.yaml': 'namespace: base\nname: Again\nversion: 1\n' })]);
  expectError(errors2, { pack: 'base', file: 'pack.yaml', path: 'namespace', line: 1, message: /namespace 'base' is already loaded/ });
});

test('error: unknown reference with did-you-mean', () => {
  const errors = errorsOf([
    fixture({
      'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    measurements: [hp, fod]
  - { id: rock, label: Rock, glyph: o, color: gray }
`,
    }),
  ]);
  expectError(errors, {
    pack: 't',
    file: 'archetypes.yaml',
    path: 'archetypes[0].measurements[1]',
    line: 6,
    message: /^unknown measurement 'fod' \(did you mean 'food'\?\)$/,
  });
});

test('error: unknown reference in a map legend and in start', () => {
  const errors = errorsOf([
    fixture({
      'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: flor }
      "@": { tile: floor, player: true }
    rows: ["@."]
start: { map: rooom, player: hero }
`,
    }),
  ]);
  expectError(errors, { pack: 't', file: 'map.yaml', path: 'maps[0].legend["."].tile', line: 4, message: /unknown tile 'flor' \(did you mean 'floor'\?\)/ });
  expectError(errors, { pack: 't', file: 'map.yaml', path: 'start.map', line: 7, message: /unknown map 'rooom' \(did you mean 'room'\?\)/ });
});

test('error: ambiguous short reference across depends', () => {
  const a = pack('a', { 'pack.yaml': 'namespace: a\nname: A\nversion: 1\n', 't.yaml': TILES_T });
  const b = pack('b', { 'pack.yaml': 'namespace: b\nname: B\nversion: 1\n', 't.yaml': TILES_T });
  const c = pack('c', {
    'pack.yaml': 'namespace: c\nname: C\nversion: 1\ndepends: [a, b]\n',
    'm.yaml': `maps:
  - id: m
    legend: { ".": { tile: floor, player: true } }
    rows: ["."]
archetypes:
  - { id: p, label: P, glyph: p, color: red }
start: { map: m, player: p }
`,
  });
  const errors = errorsOf([a, b, c]);
  expectError(errors, {
    pack: 'c',
    file: 'm.yaml',
    path: 'maps[0].legend["."].tile',
    line: 3,
    message: /ambiguous tile reference 'floor': matches a:floor, b:floor/,
  });
  // Qualifying resolves it.
  const c2 = pack('c', { ...c.files, 'm.yaml': c.files['m.yaml']!.replace('tile: floor', 'tile: b:floor') });
  const r = loadPacks([a, b, c2]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
});

test('error: reference to a namespace the pack does not depend on', () => {
  const errors = errorsOf([
    BASE,
    fixture({ 'archetypes.yaml': 'archetypes:\n  - { id: hero, label: H, glyph: "@", color: red, measurements: [base:hp] }\n' }),
  ]);
  expectError(errors, {
    pack: 't',
    file: 'archetypes.yaml',
    path: 'archetypes[0].measurements[0]',
    line: 2,
    message: /namespace 'base', which pack 't' does not depend on/,
  });
});

test('error: expression syntax', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'measurements:\n  - id: m\n    label: M\n    initial: 0\n    rate: "1 +* 2"\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'more.yaml',
    path: 'measurements[0].rate',
    line: 5,
    message: /^expression syntax error in "1 \+\* 2": unexpected '\*' at position 3$/,
  });
});

test('error: unknown identifier inside an expression', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'measurements:\n  - id: m\n    label: M\n    initial: 0\n    max: "slef.hp * 2"\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'more.yaml',
    path: 'measurements[0].max',
    line: 5,
    message: /unknown identifier 'slef' \(did you mean 'self'\?\)/,
  });
});

test('error: unknown measurement inside an expression', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'measurements:\n  - id: m\n    label: M\n    initial: 0\n    rate: "self.fod / 10"\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'more.yaml',
    path: 'measurements[0].rate',
    line: 5,
    message: /self\.fod: unknown measurement 'fod' \(did you mean 'food'\?\)/,
  });
});

test('error: unknown function inside an expression', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'measurements:\n  - id: m\n    label: M\n    initial: 0\n    rate: "maxx(1, self.hp)"\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'more.yaml',
    path: 'measurements[0].rate',
    line: 5,
    message: /unknown function 'maxx' \(did you mean 'max'\?\)/,
  });
});

test('error: ragged map rows', () => {
  const errors = errorsOf([
    fixture({
      'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows:
      - "@.."
      - ".."
start: { map: room, player: hero }
`,
    }),
  ]);
  expectError(errors, { pack: 't', file: 'map.yaml', path: 'maps[0].rows[1]', line: 6, message: /ragged map rows: row 1 has length 2, expected 3/ });
});

test('error: map character missing from the legend', () => {
  const errors = errorsOf([
    fixture({
      'map.yaml': `maps:
  - id: room
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows:
      - "@.."
      - ".X."
start: { map: room, player: hero }
`,
    }),
  ]);
  expectError(errors, { pack: 't', file: 'map.yaml', path: 'maps[0].rows[1]', line: 6, message: /map character 'X' \(row 1, column 1\) is not in the legend/ });
});

test('error: unmet depends', () => {
  const errors = errorsOf([ZOMBIE, BASE]);
  expectError(errors, {
    pack: 'zmb',
    file: 'pack.yaml',
    path: 'depends[0]',
    line: 4,
    message: /unmet dependency: pack 'zmb' depends on 'base', which must be loaded before it/,
  });
});

test('error: missing start', () => {
  const errors = errorsOf([BASE]);
  expectError(errors, { pack: 'base', file: 'pack.yaml', path: '', line: 1, message: /no 'start' defined/ });
});

test('error: duplicate start', () => {
  const errors = errorsOf([fixture({ 'start2.yaml': 'start:\n  map: room\n  player: hero\n' })]);
  expectError(errors, { pack: 't', file: 'start2.yaml', path: 'start', line: 2, message: /duplicate 'start': already defined in pack 't' \(map\.yaml\)/ });
});

test('error: missing manifest', () => {
  const errors = errorsOf([pack('packs/nowhere', { 'x.yaml': 'tiles: []\n' })]);
  expectError(errors, { pack: 'packs/nowhere', file: 'pack.yaml', path: '', message: /missing pack manifest/ });
});

test('collects all errors before failing, across files and packs', () => {
  const errors = errorsOf([
    pack('m', { 'pack.yaml': MANIFEST_T.replace('namespace: t', 'namespace: t') }),
    pack('n', {
      'pack.yaml': 'namespace: u\nname: U\nversion: 1\ndepends: [t, zz]\n',
      'a.yaml': 'tiles:\n  - { id: A, label: X, glyph: x, color: red, walkable: true }\n',
      'b.yaml': 'bogus: 1\n',
      'c.yaml': 'measurements:\n  - { id: m, label: M, initial: 0, rate: "nope" }\n',
    }),
  ]);
  const messages = errors.map((e) => e.message).join('\n');
  assert.match(messages, /unmet dependency: pack 'u' depends on 'zz'/);
  assert.match(messages, /invalid id 'A'/);
  assert.match(messages, /unknown top-level key 'bogus'/);
  assert.match(messages, /unknown identifier 'nope'/);
  assert.ok(errors.length >= 4);
});

test('formatError includes pack, file:line and key path', () => {
  const errors = errorsOf([fixture({ 'more.yaml': 'tiles:\n  - { id: pit, label: Pit, glyph: "~~", color: blue, walkable: false }\n' })]);
  assert.ok(errors.map(formatError).includes('t more.yaml:2 tiles[0].glyph: field \'glyph\' must be a single character, got "~~"'));
});

// ── Assets, sprites, raised ────────────────────────────────────────────────

const ASSETS_T = `assets:
  - { id: floor_img, file: art/floor.svg }
  - { id: hero_img, file: art/hero.png, anchor: [0.5, 0.9] }
`;

function withArt(files: Record<string, string>, otherFiles = ['art/floor.svg', 'art/hero.png', 'README.md']): PackSource {
  return { ...fixture(files), otherFiles };
}

test('assets: happy path with sprites, anchors, namespaces and raised defaults', () => {
  const r = loadPacks([
    withArt({
      'assets.yaml': ASSETS_T,
      'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true, sprite: floor_img }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: rug, label: Rug, glyph: "~", color: red, walkable: false, raised: false }
`,
      'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, sprite: "t:hero_img" }
  - { id: rock, label: Rock, glyph: o, color: gray }
`,
    }),
  ]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const def = r.definition;
  assert.deepEqual(def.assets, [
    { id: 't:floor_img', index: 0, pack: 't', file: 'art/floor.svg', anchor: [0.5, 1] },
    { id: 't:hero_img', index: 1, pack: 't', file: 'art/hero.png', anchor: [0.5, 0.9] },
  ]);
  assert.deepEqual(def.ids.assets, { 't:floor_img': 0, 't:hero_img': 1 });
  const tile = (id: string) => def.tiles[def.ids.tiles[id]!]!;
  assert.equal(tile('t:floor').sprite, 0);
  assert.equal(tile('t:floor').raised, false);
  assert.equal(tile('t:wall').sprite, null);
  assert.equal(tile('t:wall').raised, true);
  assert.equal(tile('t:rug').raised, false);
  assert.equal(def.archetypes[def.ids.archetypes['t:hero']!]!.sprite, 1);
  assert.equal(def.archetypes[def.ids.archetypes['t:rock']!]!.sprite, null);
});

test('assets: a sprite can reference an asset of a dependency by short id', () => {
  const lib: PackSource = {
    label: 'lib',
    files: { 'pack.yaml': 'namespace: lib\nname: L\nversion: 1\n', 'a.yaml': 'assets:\n  - { id: img, file: img.svg }\n' },
    otherFiles: ['img.svg'],
  };
  const game = fixture({
    'pack.yaml': MANIFEST_T + 'depends: [lib]\n',
    'tiles.yaml': TILES_T.replace('walkable: true }', 'walkable: true, sprite: img }'),
  });
  const r = loadPacks([lib, game]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  assert.equal(r.definition.assets[0]!.pack, 'lib');
  assert.equal(r.definition.tiles[0]!.sprite, 0);
});

test('assets: the real genre packs load with their assets', () => {
  for (const genre of [ZOMBIE, VAMPIRE]) {
    const r = loadPacks([BASE, genre]);
    assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
    const def = r.definition;
    assert.ok(def.assets.length >= 2);
    assert.ok(def.tiles.some((t) => t.sprite !== null) && def.tiles.some((t) => t.sprite === null));
    assert.ok(def.archetypes.some((a) => a.sprite !== null) && def.archetypes.some((a) => a.sprite === null));
  }
});

test('error: asset file missing (with suggestion)', () => {
  const errors = errorsOf([withArt({ 'assets.yaml': 'assets:\n  - { id: a, file: art/flor.svg }\n  - { id: b, file: floor.svg }\n' })]);
  expectError(errors, {
    pack: 't',
    file: 'assets.yaml',
    path: 'assets[0].file',
    line: 2,
    message: /^asset file 'art\/flor\.svg' not found in pack 't' \(did you mean 'art\/floor\.svg'\?\)$/,
  });
  expectError(errors, { pack: 't', file: 'assets.yaml', path: 'assets[1].file', line: 3, message: /did you mean 'art\/floor\.svg'/ });
});

test('error: asset with an unsupported extension', () => {
  const errors = errorsOf([withArt({ 'assets.yaml': 'assets:\n  - { id: a, file: README.md }\n' })]);
  expectError(errors, { pack: 't', file: 'assets.yaml', path: 'assets[0].file', line: 2, message: /unsupported asset file 'README\.md': must end in \.svg or \.png/ });
});

test('error: asset anchor out of range', () => {
  const errors = errorsOf([withArt({ 'assets.yaml': 'assets:\n  - { id: a, file: art/floor.svg, anchor: [0.5, 1.5] }\n' })]);
  expectError(errors, { pack: 't', file: 'assets.yaml', path: 'assets[0].anchor', line: 2, message: /anchor \[0\.5,1\.5\] is out of range/ });
});

test('error: asset anchor malformed', () => {
  const errors = errorsOf([
    withArt({ 'assets.yaml': 'assets:\n  - { id: a, file: art/floor.svg, anchor: [0.5] }\n  - { id: b, file: art/hero.png, anchor: "top" }\n' }),
  ]);
  expectError(errors, { pack: 't', file: 'assets.yaml', path: 'assets[0].anchor', line: 2, message: /must be a pair of numbers \[ax, ay\], got \[0\.5\]/ });
  expectError(errors, { pack: 't', file: 'assets.yaml', path: 'assets[1].anchor', line: 3, message: /must be a pair of numbers/ });
});

test('error: unknown sprite reference', () => {
  const errors = errorsOf([
    withArt({
      'assets.yaml': ASSETS_T,
      'archetypes.yaml': 'archetypes:\n  - { id: hero, label: H, glyph: "@", color: red, sprite: hero_imgg }\n',
      'tiles.yaml': TILES_T.replace('walkable: false }', 'walkable: false, sprite: wall_img }'),
    }),
  ]);
  expectError(errors, {
    pack: 't',
    file: 'archetypes.yaml',
    path: 'archetypes[0].sprite',
    line: 2,
    message: /^unknown asset 'hero_imgg' \(did you mean 'hero_img'\?\)$/,
  });
  expectError(errors, { pack: 't', file: 'tiles.yaml', path: 'tiles[1].sprite', line: 3, message: /^unknown asset 'wall_img'/ });
});

test('readPack lists non-YAML files', () => {
  assert.ok(ZOMBIE.otherFiles?.some((f) => f.endsWith('.svg')));
  assert.ok(!ZOMBIE.otherFiles?.some((f) => f.endsWith('.yaml')));
});
