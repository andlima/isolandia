import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameToText, renderAscii } from '../src/ascii/render.ts';
import { formatError, hudModel, loadPacks, tintAt, World, type LightingDef, type LoadError, type PackSource } from '../src/core/index.ts';
import { sceneTint } from '../src/iso/tint.ts';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, loadFixture } from './helpers.ts';

// Extra measurements for the fixture: `p` and `q` never drift on their own.
const XY = `measurements:
  - { id: p, label: P, max: 100, initial: 0 }
  - { id: q, label: Q, max: 100, initial: 50 }
`;
const HERO_XY = `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, tags: [living], measurements: [hp, food, p, q] }
  - { id: rock, label: Rock, glyph: o, color: gray, measurements: [p] }
`;

function world(files: Record<string, string>, seed = 1): World {
  return World.create(loadFixture({ 'xy.yaml': XY, 'archetypes.yaml': HERO_XY, ...files }), seed);
}

const val = (w: World, id: string, e = w.player) => w.value(e, `t:${id}`)!;

function errorsOf(files: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture({ 'xy.yaml': XY, 'archetypes.yaml': HERO_XY, ...files })]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], file: string, path: string, message: RegExp): void {
  const hit = errors.find((e) => e.file === file && e.path === path && e.line !== undefined && message.test(e.message));
  assert.ok(hit, `no error at ${file} ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

// ── Systems ─────────────────────────────────────────────────────────────────

test('systems: every → ticks; first fires after `every` seconds, then every period', () => {
  const w = world({ 's.yaml': 'systems:\n  - { id: count, every: 0.5, effects: [{ type: apply, measurement: p, delta: 1 }] }\n' });
  assert.equal(w.def.systems[0]!.period, 5);
  for (let i = 0; i < 4; i++) w.step();
  assert.equal(val(w, 'p'), 0);
  w.step(); // tick 4: (4 + 1) % 5 === 0
  assert.equal(val(w, 'p'), 1);
  for (let i = 0; i < 10; i++) w.step();
  assert.equal(val(w, 'p'), 3);
});

test('systems: default every is one tick; float noise in every is tolerated', () => {
  const w = world({
    's.yaml': `systems:
  - { id: a, effects: [{ type: apply, measurement: p, delta: 1 }] }
  - { id: b, every: 0.30000000000000004, effects: [{ type: apply, measurement: q, delta: 1 }] }
`,
  });
  assert.deepEqual(
    w.def.systems.map((s) => s.period),
    [1, 3],
  );
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(val(w, 'p'), 3);
  assert.equal(val(w, 'q'), 51);
});

test('systems: `for` filters entities before `when` is evaluated', () => {
  // `when` warns (division by zero) every time it is evaluated.
  const sys = (forExpr: string) =>
    `systems:\n  - { id: s, for: '${forExpr}', when: "self.p / (self.q - self.q) >= 0", effects: [{ type: apply, measurement: p, delta: 1 }] }\n`;
  const none = world({ 's.yaml': sys('false') });
  none.step();
  assert.equal(none.warnings.size, 0);

  const living = world({ 's.yaml': sys('self.has_tag("living")') });
  living.step();
  assert.equal(living.warnings.get('Division by zero'), 1); // the hero only, not the rock
  const rock = living.entities.find((e) => e.archetype.id === 't:rock')!;
  assert.equal(val(living, 'p'), 1);
  assert.equal(val(living, 'p', rock), 0);
});

test('systems: effects on measurements the entity lacks are skipped', () => {
  const w = world({ 's.yaml': 'systems:\n  - { id: s, effects: [{ type: apply, measurement: q, delta: 1 }, { type: apply, measurement: p, delta: 2 }] }\n' });
  w.step();
  const rock = w.entities.find((e) => e.archetype.id === 't:rock')!;
  assert.equal(val(w, 'p', rock), 2);
  assert.equal(w.value(rock, 't:q'), undefined);
});

test('systems: apply/set sequencing within and across systems; clamp only at the clamp phase', () => {
  const w = world({
    's.yaml': `systems:
  - id: first
    effects:
      - { type: set, measurement: p, value: 5 }
      - { type: apply, measurement: p, delta: "self.p * 2" }
      - { type: set, measurement: hp, value: 50 }
  - id: second
    effects:
      - { type: set, measurement: q, value: "self.p + self.hp" }
`,
  });
  w.step();
  assert.equal(val(w, 'p'), 15); // 5 + 5 * 2
  assert.equal(val(w, 'q'), 65); // saw the unclamped hp (50) and p from the system before it
  assert.equal(val(w, 'hp'), 10); // clamped to max at the clamp phase
});

test('systems: run after drift, in definition order across packs', () => {
  const second: PackSource = {
    label: 'u',
    files: {
      'pack.yaml': 'namespace: u\nname: U\nversion: 1.0.0\ndepends: [t]\n',
      's.yaml': 'systems:\n  - { id: late, effects: [{ type: set, measurement: p, value: "self.p * 10" }] }\n',
    },
  };
  const def = loadPacks([
    fixture({ 'xy.yaml': XY, 'archetypes.yaml': HERO_XY, 's.yaml': 'systems:\n  - { id: early, effects: [{ type: set, measurement: p, value: "self.food" }] }\n' }),
    second,
  ]);
  assert.ok(def.ok);
  assert.deepEqual(
    def.definition.systems.map((s) => s.id),
    ['t:early', 'u:late'],
  );
  const w = World.create(def.definition, 1);
  w.step();
  // food drifted 50 → 49.9 before the systems ran.
  assert.equal(val(w, 'p'), 100); // 499 clamped to max 100
  assert.ok(Math.abs(val(w, 'food') - 49.9) < 1e-9);
});

test('systems: a system that is not due makes no expression calls', () => {
  const w = world({ 's.yaml': `systems:\n  - { id: s, every: 1, when: "self.p / (self.q - self.q) >= 0", effects: [{ type: apply, measurement: p, delta: 1 }] }\n` });
  for (let i = 0; i < 9; i++) w.step();
  assert.equal(w.warnings.size, 0);
  w.step();
  assert.equal(w.warnings.get('Division by zero'), 2); // hero and rock
});

// ── Statuses ────────────────────────────────────────────────────────────────

const HOT = `statuses:
  - { id: hot, label: Hot, for: 'self.has_tag("living")', when: "self.p >= 50", until: "self.p < 40", rates: { q: -10 } }
`;

test('statuses: enter/exit with hysteresis', () => {
  const w = world({ 's.yaml': HOT });
  const hot = () => w.hasStatus(w.player, 't:hot');
  w.step();
  assert.equal(hot(), false);
  w.player.m[w.def.ids.measurements['t:p']!] = 50;
  w.step();
  assert.equal(hot(), true);
  w.player.m[w.def.ids.measurements['t:p']!] = 45; // below `when`, but `until` is not met yet
  w.step();
  assert.equal(hot(), true);
  w.player.m[w.def.ids.measurements['t:p']!] = 39;
  w.step();
  assert.equal(hot(), false);
});

test('statuses: `until` defaults to `not when`; falsy `for` exits', () => {
  const w = world({
    's.yaml': `statuses:
  - { id: a, label: A, for: "self.q > 0", when: "self.p >= 50" }
`,
  });
  const p = w.def.ids.measurements['t:p']!;
  const q = w.def.ids.measurements['t:q']!;
  w.player.m[p] = 60;
  w.step();
  assert.ok(w.hasStatus(w.player, 't:a'));
  w.player.m[p] = 49;
  w.step();
  assert.ok(!w.hasStatus(w.player, 't:a'));
  w.player.m[p] = 60;
  w.step();
  assert.ok(w.hasStatus(w.player, 't:a'));
  w.player.m[q] = 0;
  w.step();
  assert.ok(!w.hasStatus(w.player, 't:a'));
});

test('statuses: rates apply from the next tick, per sim second', () => {
  const w = world({ 's.yaml': HOT });
  w.player.m[w.def.ids.measurements['t:p']!] = 50;
  w.step(); // enters at the end of this tick
  assert.equal(val(w, 'q'), 50);
  w.step();
  assert.equal(val(w, 'q'), 49);
  const rock = w.entities.find((e) => e.archetype.id === 't:rock')!;
  assert.equal(rock.st[0], 0); // `for` excludes the rock
});

test('statuses: evaluated in the constructor after the initial clamp', () => {
  const w = world({
    's.yaml': HOT,
    'archetypes.yaml': HERO_XY.replace('measurements: [hp, food, p, q] }', 'measurements: [hp, food, p, q], initial: { p: 500 } }'),
  });
  assert.equal(val(w, 'p'), 100);
  assert.ok(w.hasStatus(w.player, 't:hot'));
  assert.deepEqual(w.snapshot().entities[0]!.statuses, ['t:hot']);
});

test('statuses: rate constants are folded; expressions stay closures', () => {
  const w = world({
    's.yaml': `statuses:
  - { id: a, label: A, when: "true", rates: { p: "-1 / 2", q: "self.p" } }
`,
  });
  const [p, q] = w.def.statuses[0]!.rates;
  assert.deepEqual([p!.constant, p!.fn], [-0.5, null]);
  assert.equal(typeof q!.fn, 'function');
});

test('statuses: the update does not depend on definition order', () => {
  const a = `  - { id: a, label: A, when: 'not self.has_status("b")' }\n`;
  const b = `  - { id: b, label: B, when: 'not self.has_status("a")' }\n`;
  const ab = world({ 's.yaml': `statuses:\n${a}${b}` });
  const ba = world({ 's.yaml': `statuses:\n${b}${a}` });
  // Both see "neither active" at the start of the update, so both enter.
  assert.deepEqual(ab.snapshot().entities[0]!.statuses, ['t:a', 't:b']);
  assert.deepEqual(ba.snapshot().entities[0]!.statuses, ['t:b', 't:a']);
  ab.step();
  ba.step();
  // …and both exit together.
  assert.deepEqual(ab.snapshot().entities[0]!.statuses, []);
  assert.deepEqual(ba.snapshot().entities[0]!.statuses, []);
});

test('has_status: runtime checks for self, player and method form', () => {
  const w = world({
    's.yaml': `${HOT}systems:
  - { id: mark, when: 'has_status(player, "hot") and self.has_status("hot")', effects: [{ type: apply, measurement: q, delta: 1 }] }
`,
  });
  w.step();
  assert.equal(val(w, 'q'), 50);
  w.player.m[w.def.ids.measurements['t:p']!] = 60;
  w.step(); // enters at the end of this tick
  w.step(); // system sees it; the status rate also drains y by 1
  assert.equal(val(w, 'q'), 50);
});

// ── Tile tags ───────────────────────────────────────────────────────────────

test('tile tags: tile.has_tag / has_tag(tile, …); entity and tile tags are separate', () => {
  const w = world({
    'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true, tags: [slick] }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
`,
    's.yaml': `systems:
  - id: s
    effects:
      - { type: set, measurement: p, value: 'tile.has_tag("slick") + 2 * has_tag(tile, "slick")' }
      - { type: set, measurement: q, value: 'self.has_tag("slick") + 2 * tile.has_tag("living")' }
`,
  });
  assert.deepEqual(w.def.tiles[0]!.tags, ['slick']);
  assert.deepEqual(w.def.tiles[1]!.tags, []);
  w.step();
  assert.equal(val(w, 'p'), 3);
  assert.equal(val(w, 'q'), 0);
});

// ── Defeat ──────────────────────────────────────────────────────────────────

test('defeat: freezes the world and ignores intents; default message', () => {
  const w = world({
    'map.yaml': loadFixtureMap().replace('  player: hero\n', '  player: hero\n  defeat: { when: "self.food <= 49.75" }\n'),
  });
  for (let i = 0; i < 10; i++) w.step();
  assert.deepEqual(w.defeat, { tick: 2, message: 'Game over' }); // food 49.7 after tick 2
  assert.equal(w.tick, 3);
  const before = w.hash();
  w.queueIntent({ kind: 'step', dx: 1, dy: 1 });
  w.step();
  assert.equal(w.hash(), before);
  assert.equal(w.snapshot().intent, null);
  assert.deepEqual(w.snapshot().defeat, { tick: 2, message: 'Game over' });
});

test('defeat: without start.defeat the game never ends', () => {
  const w = world({});
  for (let i = 0; i < 1000; i++) w.step();
  assert.equal(w.defeat, null);
  assert.equal(w.def.start.defeat, null);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test('determinism: statuses and random systems give equal hashes for equal seeds', () => {
  const files = {
    's.yaml': `${HOT}systems:
  - { id: r, every: 0.2, effects: [{ type: apply, measurement: p, delta: "random(-3, 4)" }] }
`,
  };
  const run = (seed: number) => {
    const w = world(files, seed);
    const hashes: string[] = [];
    for (let i = 0; i < 2000; i++) {
      w.step();
      if (i % 100 === 0) hashes.push(w.hash());
    }
    return { hashes, snapshot: w.snapshot() };
  };
  assert.deepEqual(run(7), run(7));
  assert.notDeepEqual(run(7).hashes, run(8).hashes);
});

// ── Lighting ────────────────────────────────────────────────────────────────

const LIGHT: LightingDef = {
  tint: [
    { at: 5 * 60, color: 0x000000 },
    { at: 7 * 60, color: 0xffffff },
    { at: 21 * 60, color: 0x0000ff },
  ],
};

test('tintAt: keyframe hits, midpoints, midnight wrap, single keyframe, null', () => {
  assert.equal(tintAt(LIGHT, 5), 0x000000);
  assert.equal(tintAt(LIGHT, 7), 0xffffff);
  assert.equal(tintAt(LIGHT, 12), 0xa4a4ff); // 5/14 of the way to blue: 255 × 9/14 ≈ 164
  assert.equal(tintAt(LIGHT, 6), 0x808080); // 127.5 rounds up
  assert.equal(tintAt(LIGHT, 21), 0x0000ff);
  // Wrap: 21:00 → 05:00 is 8 hours; 01:00 is halfway.
  assert.equal(tintAt(LIGHT, 1), 0x000080);
  assert.equal(tintAt(LIGHT, 23), 0x0000bf); // a quarter of the way: 255 × 3/4 ≈ 191
  assert.equal(tintAt(LIGHT, 24 + 1), tintAt(LIGHT, 1));
  assert.equal(tintAt({ tint: [{ at: 600, color: 0x123456 }] }, 3), 0x123456);
  assert.equal(tintAt(null, 3), 0xffffff);
});

test('lighting: loads sorted keyframes; sceneTint uses tick + alpha; null without lighting', () => {
  const def = loadFixture({
    'l.yaml': `lighting:
  tint:
    - { at: "20:00", color: "#000000" }
    - { at: "08:00", color: "#ffffff" }
`,
  });
  assert.deepEqual(def.lighting, {
    tint: [
      { at: 480, color: 0xffffff },
      { at: 1200, color: 0x000000 },
    ],
  });
  // Default clock starts at 08:00; 1 sim second = 1 game minute (10 ticks).
  assert.equal(sceneTint(def, 0, 0), 0xffffff);
  // 14:00, halfway from white to black; alpha moves it on smoothly.
  const a = sceneTint(def, 3600, 0)!;
  const b = sceneTint(def, 3600, 0.5)!;
  const c = sceneTint(def, 3601, 0)!;
  assert.equal(a, 0x808080);
  assert.ok((a & 0xff) >= (b & 0xff) && (b & 0xff) >= (c & 0xff) && a !== c);
  assert.equal(loadFixture().lighting, null);
  assert.equal(sceneTint(loadFixture(), 100, 0.5), null);
});

// ── HUD ─────────────────────────────────────────────────────────────────────

test('hudModel: statuses in definition order and the defeat line', () => {
  const w = world({
    's.yaml': `statuses:
  - { id: b, label: Bee, when: "self.p >= 0" }
  - { id: a, label: Ay, when: "true" }
  - { id: c, label: Sea, when: "false" }
`,
    'map.yaml': loadFixtureMap().replace('  player: hero\n', '  player: hero\n  defeat: { when: "self.food <= 48.95", message: "Starved." }\n'),
  });
  let m = hudModel(w);
  assert.deepEqual(m.statuses, ['Bee', 'Ay']);
  assert.equal(m.statusLine, 'Status: Bee, Ay');
  assert.equal(m.defeat, null);
  for (let i = 0; i < 20; i++) w.step();
  m = hudModel(w);
  assert.deepEqual(m.defeat, { message: 'Starved.', clock: 'Day 1 08:01', text: 'Starved. (Day 1 08:01)' });
  const hud = renderAscii(w, { width: 5, height: 3 }).hud;
  assert.deepEqual(hud.slice(-2), ['Status: Bee, Ay', 'Starved. (Day 1 08:01)']);
});

test('ASCII HUD has no status or defeat lines when there are none', () => {
  const w = world({});
  const text = frameToText(renderAscii(w, { width: 5, height: 3 }));
  assert.ok(!text.includes('Status:'));
  assert.equal(hudModel(w).statusLine, null);
});

// ── Loader errors (AC 9) ─────────────────────────────────────────────────────

test('error: every must be positive and a whole number of ticks', () => {
  const e = (every: string) => errorsOf({ 's.yaml': `systems:\n  - id: s\n    every: ${every}\n    effects: [{ type: apply, measurement: p, delta: 1 }]\n` });
  expectError(e('0'), 's.yaml', 'systems[0].every', /must be a number of sim seconds > 0, got 0/);
  expectError(e('-1'), 's.yaml', 'systems[0].every', /> 0/);
  expectError(e('0.25'), 's.yaml', 'systems[0].every', /whole number of ticks/);
});

test('error: empty effects, unknown effect type, unknown effect field', () => {
  expectError(errorsOf({ 's.yaml': 'systems:\n  - id: s\n    effects: []\n' }), 's.yaml', 'systems[0].effects', /at least one effect/);
  expectError(errorsOf({ 's.yaml': 'systems:\n  - id: s\n' }), 's.yaml', 'systems[0]', /missing required field 'effects'/);
  expectError(
    errorsOf({ 's.yaml': 'systems:\n  - id: s\n    effects:\n      - { type: aply, measurement: p, delta: 1 }\n' }),
    's.yaml',
    'systems[0].effects[0].type',
    /unknown effect type "aply" \(did you mean 'apply'\?\)/,
  );
  expectError(
    errorsOf({ 's.yaml': 'systems:\n  - id: s\n    effects:\n      - { type: set, measurement: p, delta: 1 }\n' }),
    's.yaml',
    'systems[0].effects[0].delta',
    /unknown 'set' effect field 'delta'/,
  );
  expectError(errorsOf({ 's.yaml': 'systems:\n  - { id: s, effects: [{ type: apply, measurement: p, delta: 1 }], evry: 1 }\n' }), 's.yaml', 'systems[0].evry', /did you mean 'every'/);
});

test('error: effect missing measurement / delta / value; unknown measurement', () => {
  const eff = (e: string) => errorsOf({ 's.yaml': `systems:\n  - id: s\n    effects:\n      - ${e}\n` });
  expectError(eff('{ type: apply, delta: 1 }'), 's.yaml', 'systems[0].effects[0]', /missing required field 'measurement'/);
  expectError(eff('{ type: apply, measurement: p }'), 's.yaml', 'systems[0].effects[0]', /missing required field 'delta'/);
  expectError(eff('{ type: set, measurement: p }'), 's.yaml', 'systems[0].effects[0]', /missing required field 'value'/);
  expectError(eff('{ type: set, measurement: fod, value: 1 }'), 's.yaml', 'systems[0].effects[0].measurement', /unknown measurement 'fod' \(did you mean 'food'\?\)/);
});

test('error: unknown measurement in rates; non-numeric delta/value/rates', () => {
  expectError(
    errorsOf({ 's.yaml': 'statuses:\n  - { id: a, label: A, when: "true", rates: { fod: 1 } }\n' }),
    's.yaml',
    'statuses[0].rates.fod',
    /unknown measurement 'fod' \(did you mean 'food'\?\)/,
  );
  expectError(
    errorsOf({ 's.yaml': 'statuses:\n  - { id: a, label: A, when: "true", rates: { p: "tile.id" } }\n' }),
    's.yaml',
    'statuses[0].rates.p',
    /must produce a number, got string/,
  );
  expectError(
    errorsOf({ 's.yaml': 'systems:\n  - { id: s, effects: [{ type: apply, measurement: p, delta: self }] }\n' }),
    's.yaml',
    'systems[0].effects[0].delta',
    /must produce a number, got entity/,
  );
  expectError(
    errorsOf({ 's.yaml': 'systems:\n  - { id: s, effects: [{ type: set, measurement: p, value: [1] }] }\n' }),
    's.yaml',
    'systems[0].effects[0].value',
    /must be a number or an expression/,
  );
});

test('error: for/when/until/defeat.when evaluating to an entity or tile', () => {
  expectError(errorsOf({ 's.yaml': 'systems:\n  - { id: s, for: self, effects: [{ type: apply, measurement: p, delta: 1 }] }\n' }), 's.yaml', 'systems[0].for', /got entity/);
  expectError(errorsOf({ 's.yaml': 'systems:\n  - { id: s, when: tile, effects: [{ type: apply, measurement: p, delta: 1 }] }\n' }), 's.yaml', 'systems[0].when', /got tile/);
  expectError(errorsOf({ 's.yaml': 'statuses:\n  - { id: a, label: A, when: player }\n' }), 's.yaml', 'statuses[0].when', /got entity/);
  expectError(errorsOf({ 's.yaml': 'statuses:\n  - { id: a, label: A, when: "true", until: tile }\n' }), 's.yaml', 'statuses[0].until', /got tile/);
  expectError(errorsOf({ 's.yaml': 'statuses:\n  - { id: a, label: A }\n' }), 's.yaml', 'statuses[0]', /missing required field 'when'/);
  expectError(
    errorsOf({ 'map.yaml': loadFixtureMap().replace('  player: hero\n', '  player: hero\n  defeat: { when: self }\n') }),
    'map.yaml',
    'start.defeat.when',
    /got entity/,
  );
});

test('error: has_status with a non-literal or unknown id', () => {
  expectError(
    errorsOf({ 's.yaml': `${HOT}systems:\n  - { id: s, when: 'self.has_status(tile.id)', effects: [{ type: apply, measurement: p, delta: 1 }] }\n` }),
    's.yaml',
    'systems[0].when',
    /string literal status id/,
  );
  expectError(
    errorsOf({ 's.yaml': `${HOT}systems:\n  - { id: s, when: 'has_status(self, "hto")', effects: [{ type: apply, measurement: p, delta: 1 }] }\n` }),
    's.yaml',
    'systems[0].when',
    /unknown status 'hto' \(did you mean 'hot'\?\)/,
  );
  expectError(
    errorsOf({ 's.yaml': `${HOT}systems:\n  - { id: s, when: 'has_status(tile, "hot")', effects: [{ type: apply, measurement: p, delta: 1 }] }\n` }),
    's.yaml',
    'systems[0].when',
    /expects an entity, got tile/,
  );
});

test('error: malformed tile tags', () => {
  const tiles = (tags: string) => errorsOf({ 'tiles.yaml': `tiles:\n  - { id: floor, label: F, glyph: ".", color: white, walkable: true, tags: ${tags} }\n  - { id: wall, label: W, glyph: "#", color: gray, walkable: false }\n` });
  expectError(tiles('[Bad-Tag]'), 'tiles.yaml', 'tiles[0].tags[0]', /invalid tag 'Bad-Tag'/);
  expectError(tiles('[1]'), 'tiles.yaml', 'tiles[0].tags[0]', /must be strings/);
  expectError(tiles('slick'), 'tiles.yaml', 'tiles[0].tags', /must be a list/);
});

test('error: lighting — empty tint, malformed time or colour, duplicate at, second pack', () => {
  const light = (body: string) => errorsOf({ 'l.yaml': `lighting:\n  tint:${body}\n` });
  expectError(light(' []'), 'l.yaml', 'lighting.tint', /at least one keyframe/);
  expectError(light('\n    - { at: "25:00", color: "#ffffff" }'), 'l.yaml', 'lighting.tint[0].at', /"HH:MM"/);
  expectError(light('\n    - { at: "07:00", color: "white" }'), 'l.yaml', 'lighting.tint[0].color', /'#rrggbb'/);
  expectError(light('\n    - { at: "07:00", color: "#ffffff" }\n    - { at: "07:00", color: "#000000" }'), 'l.yaml', 'lighting.tint[1].at', /duplicate tint keyframe time '07:00'/);

  const other: PackSource = {
    label: 'u',
    files: { 'pack.yaml': 'namespace: u\nname: U\nversion: 1.0.0\n', 'l.yaml': 'lighting:\n  tint: [{ at: "07:00", color: "#ffffff" }]\n' },
  };
  const r = loadPacks([fixture({ 'l.yaml': 'lighting:\n  tint: [{ at: "07:00", color: "#ffffff" }]\n' }), other]);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.pack === 'u' && e.path === 'lighting' && /duplicate 'lighting': already defined in pack 't'/.test(e.message)));
});

// ── Two genres (AC 12) ──────────────────────────────────────────────────────

const DAY_TICKS = 14400; // default day length: 1440 s × 10 ticks/s

function genre(name: string): World['def'] {
  const r = loadPacks([readPack('packs/base'), readPack(`packs/${name}`)]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition;
}

function tileWith(w: World, tag: string): { x: number; y: number } {
  for (let y = 0; y < w.grid.height; y++) for (let x = 0; x < w.grid.width; x++) if (w.grid.tileAt(x, y)!.tags.includes(tag)) return { x, y };
  throw new Error(`no tile tagged ${tag}`);
}

/** A need: when `measurement` crosses `start`, walk to a `tag` tile and stay until it crosses `stop`. */
interface Need {
  readonly measurement: string;
  readonly tag: string;
  readonly start: number;
  readonly stop: number;
}

function crossed(v: number, from: number, to: number): boolean {
  return from < to ? v >= to : v <= to;
}

/** Run up to two days; a scripted player tends its needs with goto intents. */
function play(def: World['def'], seed: number, needs: readonly Need[] = []): { w: World; firstStatus: number } {
  const w = World.create(def, seed);
  let current: Need | null = null;
  let firstStatus = -1;
  while (!w.defeat && w.tick < 2 * DAY_TICKS) {
    if (needs.length && w.tick % 10 === 0) {
      const v = (n: Need) => w.value(w.player, n.measurement)!;
      if (current && crossed(v(current), current.start, current.stop)) current = null;
      if (!current) {
        current = needs.find((n) => crossed(v(n), n.stop, n.start)) ?? null;
        if (current) w.queueIntent({ kind: 'goto', ...tileWith(w, current.tag) });
      }
    }
    w.step();
    if (firstStatus < 0 && w.player.st.includes(1)) firstStatus = w.tick;
  }
  return { w, firstStatus };
}

const SCRIPTS: Record<string, readonly Need[]> = {
  zombie: [
    { measurement: 'zmb:thirst', tag: 'water', start: 45, stop: 5 },
    { measurement: 'zmb:hunger', tag: 'food', start: 45, stop: 5 },
    { measurement: 'zmb:fatigue', tag: 'bed', start: 50, stop: 5 },
  ],
  vampire: [
    { measurement: 'vamp:blood', tag: 'blood', start: 30, stop: 48 },
    { measurement: 'vamp:blood', tag: 'crypt', start: 48, stop: 30 },
  ],
};

for (const name of ['zombie', 'vampire']) {
  test(`scenario (${name}): an idle player gains a status on day 1 and is defeated within 2 days`, () => {
    const def = genre(name);
    for (const seed of [1, 2, 3]) {
      const { w, firstStatus } = play(def, seed);
      assert.ok(firstStatus >= 0 && firstStatus <= DAY_TICKS, `seed ${seed}: first status at tick ${firstStatus}`);
      assert.ok(w.defeat && w.defeat.tick < 2 * DAY_TICKS, `seed ${seed}: not defeated`);
    }
  });

  test(`scenario (${name}): a player using the restoring tiles survives 2 days`, () => {
    const def = genre(name);
    for (const seed of [1, 2, 3]) {
      const { w } = play(def, seed, SCRIPTS[name]);
      assert.equal(w.defeat, null, `seed ${seed}: defeated at tick ${w.defeat?.tick}`);
      assert.equal(w.tick, 2 * DAY_TICKS);
      assert.ok(w.value(w.player, 'base:hp')! > 0);
    }
  });
}

test('genre packs use every M2 primitive', () => {
  for (const name of ['zombie', 'vampire']) {
    const def = genre(name);
    assert.ok(def.tiles.some((t) => t.tags.length > 0), `${name}: tile tags`);
    assert.ok(def.statuses.some((s) => s.rates.length > 0), `${name}: status rates`);
    assert.ok(def.systems.length >= 2, `${name}: systems`);
    assert.ok(def.start.defeat, `${name}: defeat`);
    assert.ok(def.lighting, `${name}: lighting`);
  }
});

function loadFixtureMap(): string {
  return fixture().files['map.yaml']!;
}
