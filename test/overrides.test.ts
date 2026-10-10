import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError, loadPacks, World, type Definition, type LoadError, type PackSource } from '../src/core/index.ts';
import { formatOverrides, patchSummary } from '../src/cli/overrides.ts';
import { fixture, MANIFEST_T } from './helpers.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** `lib` defines `hunger`; the base pack `t` depends on it. */
const LIB: PackSource = {
  label: 'lib',
  files: {
    'pack.yaml': 'namespace: lib\nname: Lib\nversion: 0.3.0\n',
    'needs.yaml': `measurements:
  - id: hunger
    label: Hunger
    max: 100
    initial: 10
    rate: 1
`,
  },
};

const BASE_FILES = {
  'pack.yaml': `${MANIFEST_T}depends: [lib]\n`,
  'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [hp, food, hunger]
    ticks_per_turn: 0
    sprite: hero_img
    inventory: { capacity: 10, items: { bread: 1 } }
  - id: rock
    label: Rock
    glyph: o
    color: gray
    ticks_per_turn: 0
`,
  'assets.yaml': `assets:
  - id: hero_img
    file: assets/hero.svg
`,
  'more.yaml': `items:
  - id: bread
    label: Bread
    glyph: b
    color: yellow
    weight: 1
  - id: pebble
    label: Pebble
    glyph: ","
    color: gray
    weight: 1
  - id: knife
    label: Knife
    glyph: k
    color: gray
    weight: 1
loot:
  - id: pantry
    entries:
      - { item: bread, weight: 2 }
      - { item: knife }
statuses:
  - id: hungry
    label: Hungry
    when: 'self.hunger > 50'
systems:
  - id: starve
    every: 1
    for: 'self.has_tag("living")'
    when: 'self.hunger > 5'
    effects:
      - { type: apply, measurement: hp, delta: -1 }
  - id: jitter
    every: 0.5
    effects:
      - { type: apply, measurement: food, delta: "random(-2, 2)" }
  - id: mope
    every: 1
    when: 'self.has_status("hungry")'
    effects:
      - { type: apply, measurement: food, delta: -1 }
clock:
  start: "08:00"
`,
};

const ASSET_FILES = ['assets/hero.svg'];

function base(files: Record<string, string> = {}): PackSource {
  return { ...fixture({ ...BASE_FILES, ...files }), otherFiles: ASSET_FILES };
}

/** A mod pack `ns` depending on `depends`, with one content file. */
function mod(ns: string, depends: readonly string[], yaml: string, files: Record<string, string> = {}, otherFiles: string[] = []): PackSource {
  return {
    label: ns,
    files: { 'pack.yaml': `namespace: ${ns}\nname: ${ns}\nversion: 1.0.0\ndepends: [${depends.join(', ')}]\n`, 'mod.yaml': yaml, ...files },
    otherFiles,
  };
}

function load(...mods: PackSource[]): { def: Definition; warnings: readonly LoadError[] } {
  const r = loadPacks([LIB, base(), ...mods]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return { def: r.definition, warnings: r.warnings };
}

function errorsOf(...packs: PackSource[]): readonly LoadError[] {
  const r = loadPacks(packs);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

interface Expected {
  pack: string;
  file: string;
  path: string;
  message: RegExp;
}

function expectIn(list: readonly LoadError[], exp: Expected): void {
  const hit = list.find((e) => e.pack === exp.pack && e.file === exp.file && e.path === exp.path && exp.message.test(e.message));
  assert.ok(hit, `nothing matching ${JSON.stringify({ ...exp, message: String(exp.message) })}\ngot:\n${list.map(formatError).join('\n')}`);
}

const expectError = (packs: PackSource[], exp: Expected) => expectIn(errorsOf(...packs), exp);

// ── Overrides ───────────────────────────────────────────────────────────────

test('overrides: a field replaced, omitted fields kept, a mapping replaced whole, null back to the default', () => {
  const plain = load().def;
  const { def, warnings } = load(
    mod(
      'm',
      ['t'],
      `measurements:
  - id: t:food
    override: true
    rate: 0.2
archetypes:
  - id: t:hero
    override: true
    tags: [living, brave]
    inventory: { capacity: 5 }
    ticks_per_turn: null
    sprite: null
`,
    ),
  );
  assert.deepEqual(warnings, []);
  const food = def.measurements[def.ids.measurements['t:food']!]!;
  assert.equal(food.rateConst, 0.2);
  assert.equal(food.label, 'Food');
  assert.equal(food.initial, 50);
  const hero = def.archetypes[def.ids.archetypes['t:hero']!]!;
  const before = plain.archetypes[plain.ids.archetypes['t:hero']!]!;
  assert.deepEqual(hero.tags, ['living', 'brave']);
  assert.deepEqual(hero.inventory, { capacity: 500, items: [] });
  assert.equal(before.ticksPerTurn, 0);
  assert.equal(hero.ticksPerTurn, 1, 'null clears the field: the default applies');
  assert.equal(before.sprite, def.ids.assets['t:hero_img']);
  assert.equal(hero.sprite, null);
  assert.deepEqual(hero.measurements, before.measurements, 'an omitted field is kept');
});

test('overrides: override: false is a plain definition; other values are errors', () => {
  const { def } = load(mod('m', ['t'], `items:\n  - { id: gem, label: Gem, glyph: "*", color: white, weight: 0, override: false }\n`));
  assert.ok(def.ids.items['m:gem'] !== undefined);
  expectError([LIB, base(), mod('m', ['t'], `items:\n  - { id: t:bread, override: yes, label: Loaf }\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'items[0].override',
    message: /field 'override' must be true or false, got "yes"/,
  });
});

test('overrides: a required field cleared with null is missing at the override', () => {
  expectError([LIB, base(), mod('m', ['t'], `items:\n  - id: t:bread\n    override: true\n    label: null\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'items[0]',
    message: /missing required field 'label'/,
  });
});

test('overrides: the merged entry is validated like a fresh one, reported at the writer', () => {
  expectError([LIB, base(), mod('m', ['t'], `items:\n  - id: t:bread\n    override: true\n    weigth: 2\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'items[0].weigth',
    message: /unknown item field 'weigth' \(did you mean 'weight'\?\)/,
  });
  expectError([LIB, base(), mod('m', ['t'], `measurements:\n  - id: t:food\n    override: true\n    rate: "self.nope"\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'measurements[0].rate',
    message: /expression error/,
  });
  // ASCII + Tiled fields after a merge.
  expectError([LIB, base(), mod('m', ['t'], `maps:\n  - id: t:room\n    override: true\n    tiled: maps/x.tmj\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'maps[0].tiled',
    message: /either the ASCII fields .* or 'tiled', not both/,
  });
});

test('overrides: an override listing only id and override warns that it changes nothing', () => {
  const { warnings } = load(mod('m', ['t'], `items:\n  - id: t:bread\n    override: true\n`));
  expectIn(warnings, { pack: 'm', file: 'mod.yaml', path: 'items[0]', message: /override of item 't:bread' changes nothing/ });
});

// ── Provenance ──────────────────────────────────────────────────────────────

test('provenance: an inherited field resolves in the original pack, an overriding one in the mod', () => {
  // `m` does not depend on `lib`, yet `t:starve`'s `when` (self.hunger) and `t:hero`'s measurements keep resolving.
  const { def } = load(
    mod(
      'm',
      ['t'],
      `measurements:
  - { id: mood, label: Mood, max: 10, initial: 5 }
systems:
  - id: t:starve
    override: true
    effects:
      - { type: apply, measurement: mood, delta: "0 - self.mood" }
archetypes:
  - id: t:hero
    override: true
    label: Brave hero
`,
    ),
  );
  const starve = def.systems[def.ids.systems['t:starve']!]!;
  const effect = starve.effects[0]!;
  assert.equal(effect.type, 'apply');
  assert.equal(effect.type === 'apply' && effect.measurement, def.ids.measurements['m:mood']);
  assert.ok(starve.whenFn, 'the inherited expression still compiles');
  const hero = def.archetypes[def.ids.archetypes['t:hero']!]!;
  assert.ok(hero.measurements.includes(def.ids.measurements['lib:hunger']!));

  // The mod's own expression resolves through the mod's depends: `hunger` is not visible to `m`.
  expectError([LIB, base(), mod('m', ['t'], `systems:\n  - id: t:starve\n    override: true\n    when: 'self.hunger > 1'\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'systems[0].when',
    message: /unknown measurement 'hunger'/,
  });
  // … and resolves once the mod depends on `lib`.
  load(mod('m', ['lib', 't'], `systems:\n  - id: t:starve\n    override: true\n    when: 'self.hunger > 1'\n`));
});

test('provenance: an asset file override loads from the mod, and so does a Tiled map', () => {
  const tset = {
    name: 'ts',
    tilecount: 2,
    tiles: [
      { id: 0, properties: [{ name: 'tile', type: 'string', value: 'floor' }] },
      { id: 1, properties: [{ name: 'tile', type: 'string', value: 'wall' }] },
    ],
  };
  const tmj = {
    orientation: 'orthogonal',
    infinite: false,
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    tilesets: [{ firstgid: 1, ...tset }],
    layers: [
      { type: 'tilelayer', name: 'ground', width: 3, height: 2, visible: true, data: [1, 1, 2, 1, 1, 2] },
      { type: 'objectgroup', name: 'objects', visible: true, objects: [{ id: 1, type: 'player', x: 8, y: 8, rotation: 0 }] },
    ],
  };
  const { def } = load(
    mod(
      'm',
      ['t'],
      `assets:
  - id: t:hero_img
    override: true
    file: art/hero.png
maps:
  - id: t:room
    override: true
    legend: null
    rows: null
    tiled: maps/alt.tmj
`,
      { 'maps/alt.tmj': JSON.stringify(tmj) },
      ['art/hero.png'],
    ),
  );
  const asset = def.assets[def.ids.assets['t:hero_img']!]!;
  assert.equal(asset.pack, 'm');
  assert.equal(asset.images[0]!.file, 'art/hero.png');
  const room = def.maps[def.ids.maps['t:room']!]!;
  assert.equal(room.width, 3);
  assert.equal(room.cells[2], def.ids.tiles['t:wall']);
  assert.deepEqual(room.playerStart, { x: 0, y: 0, z: 0 });

  // The path is looked up in the writer's files: the base pack has no `art/hero.png`.
  expectError([LIB, base(), mod('m', ['t'], `assets:\n  - id: t:hero_img\n    override: true\n    anchor: [0.5, 0.5]\n    file: art/hero.png\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'assets[0].file',
    message: /asset file 'art\/hero.png' not found in pack 'm'/,
  });
});

// ── Removals ────────────────────────────────────────────────────────────────

test('removal: the entry is gone and indices stay dense', () => {
  const plain = load().def;
  const { def } = load(
    mod(
      'm',
      ['t'],
      `items:
  - id: t:pebble
    remove: true
systems:
  - id: t:jitter
    remove: true
`,
    ),
  );
  assert.deepEqual(Object.keys(plain.ids.items), ['t:bread', 't:pebble', 't:knife']);
  assert.deepEqual(def.ids.items, { 't:bread': 0, 't:knife': 1 });
  assert.deepEqual(
    def.items.map((i) => [i.id, i.index]),
    [
      ['t:bread', 0],
      ['t:knife', 1],
    ],
  );
  assert.deepEqual(def.ids.systems, { 't:starve': 0, 't:mope': 1 });
  assert.deepEqual(
    def.systems.map((s) => s.index),
    [0, 1],
  );
  // Resolved indices agree: the loot table points at the knife's new index.
  const pantry = def.loot[def.ids.loot['t:pantry']!]!;
  assert.deepEqual(
    pantry.entries.map((e) => e.kind === 'item' && def.items[e.item]!.id),
    ['t:bread', 't:knife'],
  );
  // The hero's starting bread too.
  assert.equal(def.archetypes[def.ids.archetypes['t:hero']!]!.inventory!.items[0]!.item, def.ids.items['t:bread']);
});

test('removal: a remaining reference is an error naming the remover (legend, expression, loot entry)', () => {
  expectError([LIB, base(), mod('hardmode', ['t'], `tiles:\n  - id: t:wall\n    remove: true\n`)], {
    pack: 't',
    file: 'map.yaml',
    path: 'maps[0].legend["#"].tile',
    message: /unknown tile 'wall' \(removed by pack 'hardmode'\)|unknown tile 't:wall' \(removed by pack 'hardmode'\)/,
  });
  expectError([LIB, base(), mod('hardmode', ['t'], `statuses:\n  - id: t:hungry\n    remove: true\n`)], {
    pack: 't',
    file: 'more.yaml',
    path: 'systems[2].when',
    message: /has_status.*unknown status 't:hungry' \(removed by pack 'hardmode'\)/,
  });
  expectError([LIB, base(), mod('hardmode', ['t'], `items:\n  - id: t:knife\n    remove: true\n`)], {
    pack: 't',
    file: 'more.yaml',
    path: 'loot[0].entries[1].item',
    message: /unknown item 't:knife' \(removed by pack 'hardmode'\)/,
  });
  // From another pack, qualified.
  expectError([LIB, base(), mod('hardmode', ['t'], `items:\n  - id: t:knife\n    remove: true\n`), mod('n', ['t'], `loot:\n  - { id: box, entries: [{ item: t:knife }] }\n`)], {
    pack: 'n',
    file: 'mod.yaml',
    path: 'loot[0].entries[0].item',
    message: /unknown item 't:knife' \(removed by pack 'hardmode'\)/,
  });
});

test('removal: a second removal warns', () => {
  const { warnings, def } = load(mod('m', ['t'], `items:\n  - { id: t:pebble, remove: true }\n`), mod('n', ['t'], `items:\n  - { id: t:pebble, remove: true }\n`));
  expectIn(warnings, { pack: 'n', file: 'mod.yaml', path: 'items[0].id', message: /item 't:pebble' is already removed by pack 'm'/ });
  assert.equal(def.patches.length, 1);
});

// ── Error cases ─────────────────────────────────────────────────────────────

test('errors: the target id must be qualified, of a direct dependency, and exist', () => {
  const cases: [string, PackSource, string, RegExp][] = [
    ['short id', mod('m', ['t'], `items:\n  - { id: bread, override: true, label: Loaf }\n`), 'items[0].id', /'override' takes the qualified id .* \(e\.g\. 't:bread'\)/],
    ['own namespace', mod('m', ['t'], `items:\n  - { id: m:bread, override: true, label: Loaf }\n`), 'items[0].id', /pack 'm''s own item; edit its definition directly/],
    ['not a dependency', mod('m', ['lib'], `items:\n  - { id: t:bread, override: true, label: Loaf }\n`), 'items[0].id', /does not depend on 't' \(add 't' to its depends\)/],
    ['unknown id', mod('m', ['t'], `items:\n  - { id: t:braed, override: true, label: Loaf }\n`), 'items[0].id', /unknown item 't:braed' \(did you mean 't:bread'\?\)/],
    ['override and remove', mod('m', ['t'], `items:\n  - { id: t:bread, override: true, remove: true }\n`), 'items[0].remove', /either 'override: true' or 'remove: true', not both/],
    ['extra field on a removal', mod('m', ['t'], `items:\n  - { id: t:pebble, remove: true, label: x }\n`), 'items[0].label', /a removal lists only 'id' and 'remove: true', got 'label'/],
    ['removal of a short id', mod('m', ['t'], `systems:\n  - { id: jitter, remove: true }\n`), 'systems[0].id', /cannot remove 'jitter'/],
  ];
  for (const [name, m, path, message] of cases) {
    const errors = errorsOf(LIB, base(), m);
    const hit = errors.find((e) => e.pack === 'm' && e.file === 'mod.yaml' && e.path === path && message.test(e.message));
    assert.ok(hit, `${name}: nothing at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
  }
});

test('errors: an override after a removal names the remover', () => {
  expectError([LIB, base(), mod('m', ['t'], `items:\n  - { id: t:pebble, remove: true }\n`), mod('n', ['t'], `items:\n  - { id: t:pebble, override: true, label: Rock }\n`)], {
    pack: 'n',
    file: 'mod.yaml',
    path: 'items[0].id',
    message: /cannot override item 't:pebble': removed by pack 'm'/,
  });
});

test('errors: singleton overrides need a base definition and a dependency on its definer', () => {
  expectError([LIB, base(), mod('m', ['lib'], `clock:\n  override: true\n  start: "20:00"\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'clock.override',
    message: /cannot override 'clock': pack 'm' does not depend on 't', which defines it/,
  });
  expectError([LIB, base(), mod('m', ['t'], `lighting:\n  override: true\n  tint: []\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'lighting.override',
    message: /nothing to override: no earlier pack defines 'lighting'/,
  });
  // A second base definition is still an error, now suggesting `override: true`.
  expectError([LIB, base(), mod('m', ['t'], `clock:\n  start: "20:00"\n`)], {
    pack: 'm',
    file: 'mod.yaml',
    path: 'clock',
    message: /duplicate 'clock': already defined in pack 't' \(more\.yaml\); add 'override: true' to patch it/,
  });
});

// ── Singletons ──────────────────────────────────────────────────────────────

test('singletons: clock and start are shallow-merged; defeat: null removes the defeat condition', () => {
  const r = loadPacks([
    LIB,
    base(),
    mod(
      'm',
      ['t'],
      `clock:
  override: true
  start: "20:00"
start:
  override: true
  defeat: { when: "self.hp <= 0" }
`,
    ),
    mod(
      'n',
      ['m', 't'],
      `start:
  override: true
  defeat: null
  victory: { when: "self.food >= 100", message: Fed }
`,
    ),
  ]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const def = r.definition;
  assert.equal(def.clock.start, 20 * 60);
  assert.equal(def.clock.dawn, 6 * 60, 'omitted clock fields keep their values');
  assert.equal(def.start.defeat, null);
  assert.equal(def.start.victory?.message, 'Fed');
  assert.equal(def.start.map, def.ids.maps['t:room']);
  assert.deepEqual(
    def.patches.filter((p) => p.id === null).map((p) => [p.pack, p.domain, p.fields]),
    [
      ['m', 'start', ['defeat.when']],
      ['m', 'clock', ['start']],
      ['n', 'start', ['defeat', 'victory.when', 'victory.message']],
    ],
  );
  assert.deepEqual(r.warnings, [], 'n depends on m: no conflict');
});

// ── Conflicts ───────────────────────────────────────────────────────────────

test('conflicts: unrelated packs overriding the same field warn and the later wins', () => {
  const { def, warnings } = load(
    mod('zmb', ['t'], `measurements:\n  - { id: t:food, override: true, rate: 2 }\nclock:\n  override: true\n  start: "06:00"\n`),
    mod('vamp', ['t'], `measurements:\n  - { id: t:food, override: true, rate: 3 }\nclock:\n  override: true\n  start: "20:00"\n`),
  );
  assert.equal(def.measurements[def.ids.measurements['t:food']!]!.rateConst, 3);
  assert.equal(def.clock.start, 20 * 60);
  expectIn(warnings, {
    pack: 'vamp',
    file: 'mod.yaml',
    path: 'measurements[0].rate',
    message: /^also overridden by pack 'zmb' \(mod\.yaml:2\); 'vamp' wins \(later in load order\)$/,
  });
  expectIn(warnings, { pack: 'vamp', file: 'mod.yaml', path: 'clock.start', message: /also overridden by pack 'zmb' \(mod\.yaml:5\); 'vamp' wins/ });
  assert.equal(warnings.length, 2);
});

test('conflicts: a removal of an entry an unrelated pack overrode warns', () => {
  const { warnings } = load(mod('a', ['t'], `items:\n  - { id: t:pebble, override: true, label: Rock }\n`), mod('b', ['t'], `items:\n  - { id: t:pebble, remove: true }\n`));
  expectIn(warnings, { pack: 'b', file: 'mod.yaml', path: 'items[0].remove', message: /also overridden by pack 'a' .*'b' removes it/ });
});

test('conflicts: no warning when the later pack depends on the earlier one, or the fields differ', () => {
  const dependent = load(
    mod('zmb', ['t'], `measurements:\n  - { id: t:food, override: true, rate: 2 }\n`),
    mod('hard', ['zmb', 't'], `measurements:\n  - { id: t:food, override: true, rate: 3 }\n`),
  );
  assert.deepEqual(dependent.warnings, []);
  assert.equal(dependent.def.measurements[dependent.def.ids.measurements['t:food']!]!.rateConst, 3);
  // Transitively too.
  const transitive = load(
    mod('zmb', ['t'], `measurements:\n  - { id: t:food, override: true, rate: 2 }\n`),
    mod('mid', ['zmb'], ``),
    mod('hard', ['mid', 't'], `measurements:\n  - { id: t:food, override: true, rate: 3 }\n`),
  );
  assert.deepEqual(transitive.warnings, []);
  const different = load(
    mod('zmb', ['t'], `measurements:\n  - { id: t:food, override: true, rate: 2 }\n`),
    mod('vamp', ['t'], `measurements:\n  - { id: t:food, override: true, label: Blood }\n`),
  );
  assert.deepEqual(different.warnings, []);
  const food = different.def.measurements[different.def.ids.measurements['t:food']!]!;
  assert.equal(food.rateConst, 2);
  assert.equal(food.label, 'Blood');
});

// ── Order ───────────────────────────────────────────────────────────────────

test('order: overriding a system keeps its index and the world hashes (100 ticks)', () => {
  const noop = load(mod('m', ['t'], `systems:\n  - id: t:jitter\n    override: true\n`));
  expectIn(noop.warnings, { pack: 'm', file: 'mod.yaml', path: 'systems[0]', message: /changes nothing/ });
  const tuned = load(mod('m', ['t'], `systems:\n  - id: t:jitter\n    override: true\n    every: 0.5\n    effects:\n      - { type: apply, measurement: food, delta: "random(-2, 2)" }\n`));
  assert.deepEqual(tuned.warnings, []);
  assert.deepEqual(tuned.def.ids.systems, noop.def.ids.systems);
  assert.equal(tuned.def.ids.systems['t:jitter'], 1);
  const a = World.create(noop.def, 7);
  const b = World.create(tuned.def, 7);
  for (let i = 0; i < 100; i++) {
    a.step();
    b.step();
    assert.equal(b.hash(), a.hash(), `hash at tick ${a.tick}`);
  }
});

// ── Definition and tools ────────────────────────────────────────────────────

test('def.patches lists every patch in application order; check formats them', () => {
  const { def } = load(
    mod(
      'hardmode',
      ['lib', 't'],
      `measurements:
  - { id: lib:hunger, override: true, rate: 0.2 }
systems:
  - { id: t:jitter, remove: true }
archetypes:
  - { id: t:hero, override: true, tags: [living], label: Hero }
`,
    ),
    mod('vamp', ['t'], `clock:\n  override: true\n  start: "20:00"\n`),
  );
  assert.deepEqual(def.patches, [
    { domain: 'measurements', id: 'lib:hunger', pack: 'hardmode', op: 'override', fields: ['rate'] },
    { domain: 'archetypes', id: 't:hero', pack: 'hardmode', op: 'override', fields: ['tags', 'label'] },
    { domain: 'systems', id: 't:jitter', pack: 'hardmode', op: 'remove', fields: [] },
    { domain: 'clock', id: null, pack: 'vamp', op: 'override', fields: ['start'] },
  ]);
  assert.ok(Object.isFrozen(def.patches));
  assert.deepEqual(formatOverrides(def), [
    'stack:',
    '  lib       0.3.0',
    '  t         1.0.0',
    '  hardmode  1.0.0',
    '  vamp      1.0.0',
    'patches:',
    '  hardmode  override  measurement lib:hunger  [rate]',
    '  hardmode  override  archetype   t:hero      [tags, label]',
    '  hardmode  remove    system      t:jitter',
    '  vamp      override  clock                   [start]',
  ]);
  assert.deepEqual(patchSummary(def), ['hardmode: 2 overrides, 1 removal', 'vamp: 1 override']);
  const plain = load().def;
  assert.deepEqual(plain.patches, []);
  assert.deepEqual(patchSummary(plain), []);
  assert.equal(formatOverrides(plain).at(-1), 'patches: none');
});

test('def.patches is not part of the world state: a no-op override hashes like no mod', () => {
  const plain = load().def;
  const { def } = load(mod('m', ['t'], `items:\n  - id: t:bread\n    override: true\n`));
  const a = World.create(plain, 3);
  const b = World.create(def, 3);
  for (let i = 0; i < 20; i++) {
    a.step();
    b.step();
  }
  assert.equal(b.hash(), a.hash());
  assert.deepEqual(b.snapshot(), a.snapshot());
});

// ── Map spawns (a mod places NPCs exactly) ─────────────────────────────────

test('map spawns: a mod adds spawns to a base map, merged with its own in floor and row-major order', () => {
  // `t:room` has a rock spawn at (3, 1) from its legend.
  const { def } = load(mod('m', ['t'], `maps:\n  - id: t:room\n    override: true\n    spawns:\n      - { archetype: rock, at: [3, 2] }\n      - { archetype: t:rock, at: [1, 1, 0] }\n`));
  const room = def.maps[def.ids.maps['t:room']!]!;
  assert.deepEqual(
    room.spawns.map((s) => [s.x, s.y, s.z, def.archetypes[s.archetype]!.id]),
    [
      [1, 1, 0, 't:rock'],
      [3, 1, 0, 't:rock'],
      [3, 2, 0, 't:rock'],
    ],
  );
  const w = World.create(def, 1);
  assert.deepEqual(
    w.entities.slice(1).map((e) => [e.x, e.y]),
    [
      [1, 1],
      [3, 1],
      [3, 2],
    ],
  );
  assert.deepEqual(patchSummary(def), ['m: 1 override']);
});

test('map spawns: errors name the entry', () => {
  const r = loadPacks([
    fixture({
      'more.yaml': `maps:
  - id: other
    legend: { ".": { tile: floor }, " ": { tile: floor } }
    rows: ["..", ".."]
    spawns:
      - { archetype: rok, at: [0, 0] }
      - { archetype: rock, at: [2, 0] }
      - { archetype: rock, at: [0, 0, 1] }
      - { archetype: rock, at: [0] }
      - { archetype: rock }
      - rock
  - id: big
    size: [4, 4]
    fill: floor
    parts: [{ map: other, at: [0, 0] }]
    spawns: [{ archetype: rock, at: [3, 3] }]
`,
    }),
  ]);
  assert.ok(!r.ok);
  const got = r.errors.filter((e) => e.file === 'more.yaml').map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(got, [
    "maps[0].spawns[0].archetype: unknown archetype 'rok' (did you mean 'rock'?)",
    'maps[0].spawns[1].at: spawn [2,0] is outside the map (2×2, 1 floor)',
    'maps[0].spawns[2].at: spawn [0,0,1] is outside the map (2×2, 1 floor)',
    'maps[0].spawns[3].at: field \'at\' must be [x, y] or [x, y, z], integers, got [0]',
    "maps[0].spawns[4]: missing required field 'at'",
    'maps[0].spawns[5]: spawns entries must be mappings like { archetype: guard, at: [x, y] }',
    "maps[1].spawns: a composite map cannot take 'spawns': add them to a part map, or use 'populate' with a one-cell rect",
  ]);
});
