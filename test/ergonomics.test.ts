import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSource, type CompileSymbols, type ExprContext, type ExprEntity, NO_FACTIONS } from '../src/core/expr/index.ts';
import { DEFAULT_CLOCK } from '../src/core/clock.ts';
import { formatError, loadPacks, World, type Definition, type LoadError, type PackSource } from '../src/core/index.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, GAMES, MANIFEST_T, pack } from './helpers.ts';

// Pack ergonomics (docs/packs.md): the `apply`/`set` effect shorthand, a
// file's `defaults.for`, `{ scale, add }` terms on numeric overrides, the
// deeper merge of `start.defeat` / `victory` / `simulation`, and the
// `count_tagged` / `has_tagged` / `fraction` built-ins.

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(packs: PackSource[]): { def: Definition; warnings: readonly LoadError[] } {
  const r = loadPacks(packs);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return { def: r.definition, warnings: r.warnings };
}

function errorsOf(packs: PackSource[]): readonly LoadError[] {
  const r = loadPacks(packs);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

interface Expected {
  pack?: string;
  file: string;
  path: string;
  message: RegExp;
}

function expectIn(list: readonly LoadError[], exp: Expected): void {
  const hit = list.find((e) => (exp.pack === undefined || e.pack === exp.pack) && e.file === exp.file && e.path === exp.path && exp.message.test(e.message));
  assert.ok(hit, `nothing matching ${JSON.stringify({ ...exp, message: String(exp.message) })}\ngot:\n${list.map(formatError).join('\n')}`);
}

/** A mod pack `ns` with one content file. */
function mod(ns: string, depends: string[], yaml: string, files: Record<string, string> = {}): PackSource {
  return pack(ns, { 'pack.yaml': `namespace: ${ns}\nname: ${ns}\nversion: 1.0.0\nkind: mod\ndepends: [${depends.join(', ')}]\n`, 'mod.yaml': yaml, ...files });
}

const sys = (def: Definition, id: string) => def.systems[def.ids.systems[id]!]!;
const status = (def: Definition, id: string) => def.statuses[def.ids.statuses[id]!]!;
const measurement = (def: Definition, id: string) => def.measurements[def.ids.measurements[id]!]!;

// ── Effect shorthand ────────────────────────────────────────────────────────

test('effect shorthand: apply/set mappings expand in order to one effect per key, mixed with long entries', () => {
  const { def, warnings } = ok([
    fixture({
      'rules.yaml': `systems:
  - id: eat
    every: 1
    effects:
      - { apply: { hp: -1, food: "2 * self.hp" } }
      - { type: noise, radius: 3 }
      - { set: { food: 10 } }
      - { type: apply, measurement: t:hp, delta: 0.5 }
`,
    }),
  ]);
  assert.deepEqual(warnings, []);
  const hp = def.ids.measurements['t:hp']!;
  const food = def.ids.measurements['t:food']!;
  const effects = sys(def, 't:eat').effects;
  assert.deepEqual(
    effects.map((e) => [e.type, 'measurement' in e ? e.measurement : null, 'constant' in e ? e.constant : null, 'fn' in e ? typeof e.fn : null]),
    [
      ['apply', hp, -1, 'object'],
      ['apply', food, 0, 'function'],
      ['noise', null, 3, 'object'],
      ['set', food, 10, 'object'],
      ['apply', hp, 0.5, 'object'],
    ],
  );
  assert.ok(effects.every((e) => !('on' in e)));
});

test('effect shorthand: accepted in item uses, actions, recipes, quest stages and dialogues; on: npc only in dialogues', () => {
  const { def } = ok([
    fixture({
      'content.yaml': `items:
  - { id: bread, label: Bread, glyph: b, color: white, weight: 1, use: { effects: [{ apply: { food: 20 } }] } }
  - { id: crumb, label: Crumb, glyph: c, color: white, weight: 0.1 }
actions:
  - { id: rest, label: Rest, target: self, effects: [{ apply: { hp: 1 } }] }
recipes:
  - { id: crumble, label: Crumble, consume: { bread: 1 }, produce: { crumb: 3 }, effects: [{ apply: { food: -1 } }] }
quests:
  - id: q
    title: Q
    stages:
      - { id: s, journal: j, when: "true", effects: [{ set: { hp: 3 } }] }
dialogues:
  - id: chat
    start: hello
    nodes:
      hello:
        text: Hi
        effects: [{ apply: { hp: -1 }, on: npc }]
        choices:
          - { text: Bye, to: end, effects: [{ set: { food: 1 }, on: npc }, { apply: { hp: 1 } }] }
`,
    }),
  ]);
  const hp = def.ids.measurements['t:hp']!;
  const food = def.ids.measurements['t:food']!;
  const first = (xs: readonly { type: string }[]) => xs[0] as { type: string; measurement: number; constant: number; on?: string };
  assert.deepEqual([first(def.items[def.ids.items['t:bread']!]!.use!.effects).measurement, first(def.items[def.ids.items['t:bread']!]!.use!.effects).constant], [food, 20]);
  const rest = first(def.actions[def.ids.actions['t:rest']!]!.effects);
  assert.deepEqual([rest.measurement, rest.constant, rest.on], [hp, 1, undefined]);
  assert.equal(first(def.recipes[def.ids.recipes['t:crumble']!]!.effects).constant, -1);
  assert.deepEqual([first(def.quests[0]!.stages[0]!.effects).type, first(def.quests[0]!.stages[0]!.effects).constant], ['set', 3]);
  const node = def.dialogues[0]!.nodes[0]!;
  assert.deepEqual(node.effects, [{ type: 'apply', measurement: hp, constant: -1, fn: null, on: 'npc' }]);
  assert.deepEqual(
    node.choices[0]!.effects.map((e) => ('on' in e ? e.on : null)),
    ['npc', null],
  );
});

test('effect shorthand: every error names the entry or the key inside the mapping', () => {
  const system = (effect: string) => fixture({ 'rules.yaml': `systems:\n  - id: s\n    every: 1\n    effects:\n      - ${effect}\n` });
  const cases: [string, string, string, RegExp][] = [
    ['both', '{ apply: { hp: 1 }, set: { hp: 2 } }', 'systems[0].effects[0]', /either 'apply' or 'set', not both/],
    ['type next to apply', '{ type: apply, apply: { hp: 1 } }', 'systems[0].effects[0].type', /'type' cannot be combined with the 'apply' shorthand/],
    ['empty mapping', '{ set: {} }', 'systems[0].effects[0].set', /'set' must list at least one measurement/],
    ['not a mapping', '{ apply: 5 }', 'systems[0].effects[0].apply', /'apply' must be a mapping of measurement id → delta.*got number/],
    ['a list', '{ apply: [hp] }', 'systems[0].effects[0].apply', /got list/],
    ['unknown measurement', '{ apply: { hpp: 1 } }', 'systems[0].effects[0].apply.hpp', /unknown measurement 'hpp' \(did you mean 'hp'\?\)/],
    ['bad expression', '{ apply: { hp: "self.nope" } }', 'systems[0].effects[0].apply.hp', /expression error in "self.nope"/],
    ['not a number', '{ set: { hp: [1] } }', 'systems[0].effects[0].set.hp', /field 'hp' must be a number or an expression/],
    ['stray field', '{ apply: { hp: 1 }, measurement: hp }', 'systems[0].effects[0].measurement', /unknown 'apply' effect field 'measurement'/],
    ['delta next to the shorthand', '{ apply: { hp: 1 }, delta: 2 }', 'systems[0].effects[0].delta', /unknown 'apply' effect field 'delta'/],
    ['on outside a dialogue', '{ apply: { hp: 1 }, on: npc }', 'systems[0].effects[0].on', /only allowed in the effects of dialogues/],
  ];
  for (const [name, effect, path, message] of cases) {
    const errors = errorsOf([system(effect)]);
    const hit = errors.find((e) => e.file === 'rules.yaml' && e.path === path && message.test(e.message));
    assert.ok(hit, `${name}: nothing at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
  }
  // Both keys of a mapping are checked, and reported where they are written.
  const errors = errorsOf([system('{ apply: { hpp: 1, food: "nope" } }')]);
  expectIn(errors, { file: 'rules.yaml', path: 'systems[0].effects[0].apply.hpp', message: /unknown measurement/ });
  expectIn(errors, { file: 'rules.yaml', path: 'systems[0].effects[0].apply.food', message: /expression error/ });
});

// ── Per-file defaults ───────────────────────────────────────────────────────

const DEFAULTS_FILE = `defaults:
  for: 'self.has_tag("living")'
systems:
  - id: a
    every: 1
    effects: [{ apply: { hp: -1 } }]
  - id: b
    every: 1
    for: "true"
    effects: [{ apply: { hp: -1 } }]
  - id: c
    every: 1
    for: 'self.has_tag("rock")'
    effects: [{ apply: { hp: -1 } }]
statuses:
  - id: d
    label: D
    when: "self.hp < 5"
actions:
  - { id: rest, label: Rest, target: self, effects: [{ apply: { hp: 1 } }] }
`;

test('defaults: for applies to the systems and statuses of the file that do not write it, and to nothing else', () => {
  const { def, warnings } = ok([fixture({ 'rules.yaml': DEFAULTS_FILE, 'other.yaml': `systems:\n  - { id: e, every: 1, effects: [{ apply: { hp: -1 } }] }\n` })]);
  assert.deepEqual(warnings, []);
  assert.equal(sys(def, 't:a').forTag, 'living', 'the fast path survives');
  assert.equal(typeof sys(def, 't:a').forFn, 'function');
  assert.equal(sys(def, 't:b').forTag, null, 'for: "true" opts out');
  assert.equal(sys(def, 't:c').forTag, 'rock');
  assert.equal(status(def, 't:d').forTag, 'living');
  assert.equal(sys(def, 't:e').forFn, null, 'defaults are per file: another file of the pack is untouched');
  assert.ok(def.actions[def.ids.actions['t:rest']!], 'an action in the file has no for and gets none');
  // The world applies the default: after one period, `a` (living), `b` (everyone) and `e` (everyone) each took 1 from the hero; `c` (rocks) did not.
  const w = World.create(def, 1);
  for (let i = 0; i < 10; i++) w.step();
  assert.equal(w.player.m[def.ids.measurements['t:hp']!], 7);
});

test('defaults: never applied to overrides or removals; a mod file with defaults keeps its patches to what it lists', () => {
  const base = fixture({
    'rules.yaml': `systems:\n  - { id: base_sys, every: 1, effects: [{ apply: { hp: -1 } }] }\n  - { id: gone, every: 1, effects: [{ apply: { hp: -1 } }] }\n`,
  });
  const { def, warnings } = ok([
    base,
    mod(
      'm',
      ['t'],
      `defaults:
  for: 'self.has_tag("living")'
systems:
  - { id: own, every: 1, effects: [{ apply: { t:hp: -1 } }] }
  - { id: t:base_sys, override: true, every: 2 }
  - { id: t:gone, remove: true }
`,
    ),
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(sys(def, 'm:own').forTag, 'living');
  assert.equal(sys(def, 't:base_sys').forFn, null, 'an override changes only what it lists');
  assert.equal(sys(def, 't:base_sys').every, 2);
  assert.deepEqual(
    def.patches.map((p) => [p.pack, p.op, p.id, p.fields]),
    [
      ['m', 'override', 't:base_sys', ['every']],
      ['m', 'remove', 't:gone', []],
    ],
  );
});

test('defaults: an unused default warns, an unknown key or a non-mapping is an error', () => {
  const { warnings } = ok([fixture({ 'items.yaml': `defaults: { for: "true" }\nitems:\n  - { id: bread, label: Bread, glyph: b, color: white, weight: 1 }\n` })]);
  expectIn(warnings, { file: 'items.yaml', path: 'defaults', message: /'defaults' is unused: no 'systems' or 'statuses' entry of this file takes it/ });
  // All entries write their own `for`: unused too.
  const own = ok([fixture({ 'rules.yaml': `defaults: { for: "true" }\nsystems:\n  - { id: a, every: 1, for: "true", effects: [{ apply: { hp: -1 } }] }\n` })]);
  expectIn(own.warnings, { file: 'rules.yaml', path: 'defaults', message: /unused/ });
  expectIn(errorsOf([fixture({ 'rules.yaml': `defaults: { fro: "true" }\nsystems:\n  - { id: a, every: 1, effects: [{ apply: { hp: -1 } }] }\n` })]), {
    file: 'rules.yaml',
    path: 'defaults.fro',
    message: /unknown defaults field 'fro' \(did you mean 'for'\?\); 'defaults' supports: for/,
  });
  expectIn(errorsOf([fixture({ 'rules.yaml': `defaults: [for]\nsystems:\n  - { id: a, every: 1, effects: [{ apply: { hp: -1 } }] }\n` })]), {
    file: 'rules.yaml',
    path: 'defaults',
    message: /'defaults' must be a mapping of field defaults \(for\)/,
  });
  // `defaults` is a known top-level key, so a typo of it suggests it.
  expectIn(errorsOf([fixture({ 'rules.yaml': `default: { for: "true" }\n` })]), { file: 'rules.yaml', path: 'default', message: /unknown top-level key 'default' \(did you mean 'defaults'\?\)/ });
});

test('defaults: an error in the expression is reported once, at defaults.for, with the file as provenance', () => {
  const errors = errorsOf([
    fixture({
      'rules.yaml': `defaults:
  for: 'self.has_tag("living") and self.nope > 1'
systems:
  - { id: a, every: 1, effects: [{ apply: { hp: -1 } }] }
  - { id: b, every: 1, effects: [{ apply: { hp: -1 } }] }
statuses:
  - { id: c, label: C, when: "true" }
`,
    }),
  ]);
  const at = errors.filter((e) => e.file === 'rules.yaml');
  assert.deepEqual(
    at.map((e) => [e.path, e.line]),
    [['defaults.for', 2]],
  );
  assert.match(at[0]!.message, /unknown measurement 'nope'/);
});

test('defaults: provenance of a defaulted field is the defaults location, even after a mod overrides another field', () => {
  // The base's `for` (from defaults) must resolve a status the mod cannot see: it resolves in the base's scope.
  const errors = errorsOf([
    fixture({
      'rules.yaml': `defaults:\n  for: 'self.has_status("gone")'\nstatuses:\n  - { id: gone, label: Gone, when: "true" }\nsystems:\n  - { id: a, every: 1, effects: [{ apply: { hp: -1 } }] }\n`,
    }),
    mod('m', ['t'], `statuses:\n  - { id: t:gone, remove: true }\n`),
  ]);
  expectIn(errors, { pack: 't', file: 'rules.yaml', path: 'defaults.for', message: /unknown status 't:gone' \(removed by pack 'm'\)/ });
});

// ── Numeric override terms ──────────────────────────────────────────────────

/** `lib` defines `hunger`; the base `t` depends on it and reads it in an expression rate. */
const LIB: PackSource = pack('lib', {
  'pack.yaml': 'namespace: lib\nname: Lib\nversion: 0.3.0\n',
  'needs.yaml': `measurements:\n  - { id: hunger, label: Hunger, max: 100, initial: 10, rate: 1 }\n`,
});

function termBase(): PackSource {
  return fixture({
    'pack.yaml': `${MANIFEST_T}depends: [lib]\n`,
    'terms.yaml': `measurements:
  - { id: thirst, label: Thirst, max: 100, initial: 0, rate: "0.1 + 0.05 * (self.hunger >= 50)" }
  - { id: cap, label: Cap, max: hp, initial: 5 }
systems:
  - { id: tick, every: 1, effects: [{ apply: { hp: -1 } }] }
vars:
  - { id: score, initial: 10, min: 0, max: 100 }
  - { id: flag, initial: true }
factions:
  - { id: guild, label: Guild, reputation: 10, hostile_below: -50, friendly_from: 50 }
items:
  - { id: bread, label: Bread, glyph: b, color: white, weight: 1 }
  - { id: crumb, label: Crumb, glyph: c, color: white, weight: 0.1 }
actions:
  - { id: rest, label: Rest, target: self, duration: 2, effects: [{ apply: { hp: 1 } }] }
recipes:
  - { id: crumble, label: Crumble, consume: { bread: 1 }, produce: { crumb: 3 }, duration: 4 }
clock:
  day_length: 600
`,
  });
}

test('terms: scale/add on every numeric field, folded for numbers and wrapped for expressions in the original scope', () => {
  const { def, warnings } = ok([
    LIB,
    termBase(),
    // `m` does not depend on `lib`: the wrapped thirst rate still resolves `hunger` through `t`.
    mod(
      'm',
      ['t'],
      `measurements:
  - { id: t:food, override: true, rate: { scale: 2 } }
  - { id: t:thirst, override: true, rate: { scale: 2, add: 0.5 } }
  - { id: t:hp, override: true, max: { add: 10 }, initial: { scale: 0.5 } }
systems:
  - { id: t:tick, override: true, every: { scale: 2 } }
vars:
  - { id: t:score, override: true, initial: { scale: 2, add: 5 }, min: { add: 1 }, max: { scale: 0.5 } }
factions:
  - { id: t:guild, override: true, reputation: { add: 5 }, hostile_below: { scale: 0.5 }, friendly_from: { add: -10 } }
actions:
  - { id: t:rest, override: true, duration: { scale: 2 } }
recipes:
  - { id: t:crumble, override: true, duration: { add: 1 } }
clock:
  override: true
  day_length: { scale: 2 }
`,
    ),
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(measurement(def, 't:food').rateConst, -2);
  const thirst = measurement(def, 't:thirst');
  assert.equal(thirst.rateConst, 0);
  assert.equal(typeof thirst.rateFn, 'function');
  const w = World.create(def, 1);
  const hunger = def.ids.measurements['lib:hunger']!;
  const ctx = { self: { ...w.player, m: Float64Array.from(w.player.m) } } as unknown as Parameters<NonNullable<typeof thirst.rateFn>>[0];
  ctx.self.m[hunger] = 60;
  assert.equal(thirst.rateFn!(ctx), (0.1 + 0.05) * 2 + 0.5);
  assert.deepEqual([measurement(def, 't:hp').maxConst, measurement(def, 't:hp').initial], [20, 5]);
  assert.deepEqual([sys(def, 't:tick').every, sys(def, 't:tick').period], [2, 20]);
  const score = def.vars[def.ids.vars['t:score']!]!;
  assert.deepEqual([score.initial, score.min, score.max], [25, 1, 50]);
  const guild = def.factions[def.ids.factions['t:guild']!]!;
  assert.deepEqual([guild.reputation, guild.hostileBelow, guild.friendlyFrom], [15, -25, 40]);
  assert.equal(def.actions[def.ids.actions['t:rest']!]!.duration.ticks, 40);
  assert.equal(def.recipes[def.ids.recipes['t:crumble']!]!.duration.ticks, 50);
  assert.equal(def.clock.dayLength, 1200);
  // `check --overrides` prints each field with its term.
  const lines = formatOverrides(def).map((l) => l.trim().split(/\s+/).join(' '));
  assert.ok(lines.includes('m override measurement t:food [rate ×2]'), lines.join('\n'));
  assert.ok(lines.includes('m override measurement t:thirst [rate ×2 +0.5]'));
  assert.ok(lines.includes('m override measurement t:hp [max +10, initial ×0.5]'));
  assert.ok(lines.includes('m override faction t:guild [reputation +5, hostile_below ×0.5, friendly_from -10]'));
  assert.ok(lines.includes('m override clock [day_length ×2]'));
});

test('terms: stack across mods (×2 then ×2 is ×4), with the usual warning between unrelated packs', () => {
  const twice = `measurements:\n  - { id: t:food, override: true, rate: { scale: 2 } }\n  - { id: t:thirst, override: true, rate: { scale: 2 } }\n`;
  const related = ok([LIB, termBase(), mod('m', ['t'], twice), mod('n', ['m', 't'], twice)]);
  assert.deepEqual(related.warnings, []);
  assert.equal(measurement(related.def, 't:food').rateConst, -4);
  const w = World.create(related.def, 1);
  assert.equal(measurement(related.def, 't:thirst').rateFn!({ self: w.player } as never), 0.1 * 4);
  const unrelated = ok([LIB, termBase(), mod('m', ['t'], twice), mod('n', ['t'], twice)]);
  assert.equal(measurement(unrelated.def, 't:food').rateConst, -4);
  expectIn(unrelated.warnings, { pack: 'n', file: 'mod.yaml', path: 'measurements[0].rate', message: /also overridden by pack 'm' \(mod\.yaml:2\); 'n' wins/ });
  expectIn(unrelated.warnings, { pack: 'n', file: 'mod.yaml', path: 'measurements[1].rate', message: /also overridden by pack 'm'/ });
  assert.equal(unrelated.warnings.length, 2);
  // A term after a plain replacement scales the replaced value.
  const after = ok([LIB, termBase(), mod('m', ['t'], `measurements:\n  - { id: t:food, override: true, rate: 3 }\n`), mod('n', ['m', 't'], twice)]);
  assert.equal(measurement(after.def, 't:food').rateConst, 6);
});

test('terms: every error names the field', () => {
  const cases: [string, string, string, RegExp][] = [
    ['other field', `measurements:\n  - { id: t:food, override: true, label: { scale: 2 } }\n`, 'measurements[0].label', /a term .* is only allowed on a numeric field \(min, max, initial, rate\), not on 'label'/],
    ['no upstream value', `measurements:\n  - { id: t:hp, override: true, rate: { scale: 2 } }\n`, 'measurements[0].rate', /cannot scale 'rate' of measurement 't:hp': it has no current value/],
    ['unknown term key', `measurements:\n  - { id: t:food, override: true, rate: { scale: 2, mul: 3 } }\n`, 'measurements[0].rate.mul', /a term takes only 'scale' and 'add', got 'mul'/],
    ['non-number', `measurements:\n  - { id: t:food, override: true, rate: { scale: "2" } }\n`, 'measurements[0].rate.scale', /'scale' must be a number, got "2"/],
    ['expression as a term', `measurements:\n  - { id: t:food, override: true, rate: { add: "self.hp" } }\n`, 'measurements[0].rate.add', /'add' must be a number/],
    ['empty term', `measurements:\n  - { id: t:food, override: true, rate: {} }\n`, 'measurements[0].rate', /a term needs 'scale' and\/or 'add'/],
    ['measurement reference max', `measurements:\n  - { id: t:cap, override: true, max: { scale: 2 } }\n`, 'measurements[0].max', /'hp' is a measurement reference, not a number or an expression/],
    ['domain without numeric fields', `items:\n  - { id: t:bread, override: true, weight: { scale: 2 } }\n`, 'items[0].weight', /only allowed on a numeric field \(none for items\)/],
    ['boolean var', `vars:\n  - { id: t:flag, override: true, initial: { add: 1 } }\n`, 'vars[0].initial', /its current value \(true\) is not a number or an expression/],
  ];
  for (const [name, yaml, path, message] of cases) {
    const errors = errorsOf([LIB, termBase(), mod('m', ['t'], yaml)]);
    const hit = errors.find((e) => e.pack === 'm' && e.file === 'mod.yaml' && e.path === path && message.test(e.message));
    assert.ok(hit, `${name}: nothing at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
  }
  // A term on a definition (not an override) has nothing to scale.
  expectIn(errorsOf([fixture({ 'rules.yaml': `measurements:\n  - { id: x, label: X, initial: 0, rate: { scale: 2 } }\n` })]), {
    file: 'rules.yaml',
    path: 'measurements[0].rate',
    message: /only allowed in an override \(override: true\): a definition has no current 'rate' to scale/,
  });
  // The scaled value is validated like a written one: `every` must stay a whole number of ticks.
  expectIn(errorsOf([LIB, termBase(), mod('m', ['t'], `systems:\n  - { id: t:tick, override: true, every: { scale: 0.03 } }\n`)]), {
    pack: 'm',
    file: 'mod.yaml',
    path: 'systems[0].every',
    message: /whole number of ticks/,
  });
});

// ── Deeper merge for start ──────────────────────────────────────────────────

const START_BASE = fixture({
  'map.yaml': `${fixture().files['map.yaml']}  defeat:
    when: "self.hp <= 0"
    message: "You did not make it."
  simulation:
    active_radius: 64
    npc_path_budget: 4000
`,
});

test('deeper merge: start.defeat / victory / simulation merge per field; null clears one key or the whole mapping', () => {
  const { def, warnings } = ok([
    START_BASE,
    mod('m', ['t'], `start:\n  override: true\n  defeat: { message: "Outbreak." }\n  simulation: { active_radius: none }\n`),
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(def.start.defeat!.message, 'Outbreak.');
  assert.equal(typeof def.start.defeat!.when, 'function', "the base's `when` is kept");
  assert.deepEqual(def.start.simulation, { activeRadius: null, npcPathBudget: 4000, playerPathBudget: 60000 });
  assert.deepEqual(def.patches, [{ domain: 'start', id: null, pack: 'm', op: 'override', fields: ['defeat.message', 'simulation.active_radius'] }]);
  assert.ok(formatOverrides(def).some((l) => /m\s+override\s+start\s+\[defeat\.message, simulation\.active_radius\]/.test(l)));
  // `message: null` goes back to the default; `defeat: null` removes the condition.
  const cleared = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: { message: null }\n`)]).def;
  assert.equal(cleared.start.defeat!.message, 'Game over');
  const removed = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: null\n`)]);
  assert.equal(removed.def.start.defeat, null);
  assert.deepEqual(removed.def.patches[0]!.fields, ['defeat']);
  // After `defeat: null`, a later dependent mod's `defeat: { when }` is a fresh definition again.
  const fresh = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: null\n`), mod('n', ['m', 't'], `start:\n  override: true\n  defeat: { when: "self.hp < 1", message: Fresh }\n`)]);
  assert.equal(fresh.def.start.defeat!.message, 'Fresh');
  assert.deepEqual(fresh.warnings, [], 'n depends on m: no conflict');
  // An empty mapping lists no key, so it keeps the upstream mapping whole (and says so).
  const empty = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: {}\n  simulation: { npc_path_budget: 1 }\n`)]);
  assert.equal(empty.def.start.defeat!.message, 'You did not make it.');
  assert.equal(typeof empty.def.start.defeat!.when, 'function');
  assert.equal(empty.def.start.simulation.npcPathBudget, 1);
  assert.deepEqual(empty.def.patches[0]!.fields, ['simulation.npc_path_budget']);
  expectIn(empty.warnings, { pack: 'm', file: 'mod.yaml', path: 'start.defeat', message: /'defeat: \{\}' changes nothing: omitted keys are kept/ });
  assert.equal(empty.warnings.length, 1);
});

test('deeper merge: a sub-mapping with no upstream value is a fresh definition, validated at the override', () => {
  expectIn(errorsOf([START_BASE, mod('m', ['t'], `start:\n  override: true\n  victory: { message: "Won" }\n`)]), {
    pack: 'm',
    file: 'mod.yaml',
    path: 'start.victory',
    message: /missing required field 'when'/,
  });
  // A bad sub-field is reported at the pack that wrote it, resolving in its scope.
  expectIn(errorsOf([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: { when: "self.nope < 1" }\n`)]), {
    pack: 'm',
    file: 'mod.yaml',
    path: 'start.defeat.when',
    message: /unknown measurement 'nope'/,
  });
  expectIn(errorsOf([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: { massage: "x" }\n`)]), {
    pack: 'm',
    file: 'mod.yaml',
    path: 'start.defeat.massage',
    message: /unknown defeat field 'massage' \(did you mean 'message'\?\)/,
  });
  // Other nested values keep the whole-replacement rule: a mod's `lighting.tint` replaces the list.
  const { def } = ok([
    fixture({ 'light.yaml': `lighting:\n  tint:\n    - { at: "06:00", color: "#000000" }\n    - { at: "12:00", color: "#ffffff" }\n` }),
    mod('m', ['t'], `lighting:\n  override: true\n  tint:\n    - { at: "20:00", color: "#101010" }\n`),
  ]);
  assert.deepEqual(def.lighting!.tint, [{ at: 20 * 60, color: 0x101010 }]);
});

test('deeper merge: unrelated mods warn per sub-field, not per mapping', () => {
  const both = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: { message: "M" }\n`), mod('n', ['t'], `start:\n  override: true\n  defeat: { message: "N" }\n`)]);
  assert.equal(both.def.start.defeat!.message, 'N');
  assert.deepEqual(
    both.warnings.map((w) => [w.pack, w.path]),
    [['n', 'start.defeat.message']],
  );
  assert.match(both.warnings[0]!.message, /also overridden by pack 'm' \(mod\.yaml:3\); 'n' wins/);
  const different = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: { message: "M" }\n`), mod('n', ['t'], `start:\n  override: true\n  defeat: { when: "self.hp < 1" }\n`)]);
  assert.deepEqual(different.warnings, [], 'different sub-fields do not conflict');
  assert.equal(different.def.start.defeat!.message, 'M');
  // Clearing the mapping an unrelated mod patched warns once, at the mapping.
  const cleared = ok([START_BASE, mod('m', ['t'], `start:\n  override: true\n  defeat: { message: "M" }\n`), mod('n', ['t'], `start:\n  override: true\n  defeat: null\n`)]);
  assert.deepEqual(
    cleared.warnings.map((w) => [w.pack, w.path]),
    [['n', 'start.defeat']],
  );
  // Re-adding a mapping an unrelated mod cleared warns at the mapping too: the fresh definition is a conflicting write.
  const readded = ok([
    START_BASE,
    mod('m', ['t'], `start:\n  override: true\n  defeat: null\n`),
    mod('n', ['t'], `start:\n  override: true\n  defeat: { when: "self.hp < 1", message: "N" }\n`),
  ]);
  assert.equal(readded.def.start.defeat!.message, 'N');
  assert.deepEqual(
    readded.warnings.map((w) => [w.pack, w.path]),
    [['n', 'start.defeat']],
  );
  assert.match(readded.warnings[0]!.message, /also overridden by pack 'm' \(mod\.yaml:3\); 'n' wins/);
});

// ── Built-ins ───────────────────────────────────────────────────────────────

type Bounds = { min: number; maxConst: number; maxFn: ((c: ExprContext) => number) | null };

/** Compile symbols with two measurements (`a:hp` index 0 with max 100, `a:mp` index 1 unbounded) and three item tags. */
function symbolsWith(bounds: Record<string, Bounds>): CompileSymbols & { warnings: string[] } {
  const ids: Record<string, number> = { 'a:hp': 0, 'a:mp': 1 };
  const tags: Record<string, number[]> = { food: [0, 1], drink: [2], tool: [] };
  const warnings: string[] = [];
  const qualify = (ref: string) => (ref.includes(':') ? ref : `a:${ref}`);
  return {
    warnings,
    resolveMeasurement: (ref) => (ids[qualify(ref)] === undefined ? { error: `unknown measurement '${ref}'` } : { index: ids[qualify(ref)]! }),
    resolveItemTag: (tag) => {
      const items = tags[tag];
      if (!items) warnings.push(`no item carries '${tag}'`);
      const flags = new Uint8Array(3);
      for (const i of items ?? []) flags[i] = 1;
      return { flags };
    },
    resolveBounds: (ref) => {
      const index = ids[qualify(ref)];
      if (index === undefined) return { error: `unknown measurement '${ref}'` };
      const b = bounds[qualify(ref)];
      if (!b) return { error: `measurement '${ref}' has no 'max': no maximum to take a fraction of` };
      return { index, bounds: () => b };
    },
  };
}

function entity(m: number[], stacks: { item: number; count: number }[] | null, hasM?: number[]): ExprEntity {
  return {
    x: 0,
    y: 0,
    z: 0,
    m: Float64Array.from(m),
    tags: new Set(),
    st: new Uint8Array(0),
    inv: stacks ? ({ stacks } as unknown as ExprEntity['inv']) : null,
    heardTick: -1,
    ...(hasM ? { hasM: Uint8Array.from(hasM) } : {}),
  };
}

function ctxWith(self: ExprEntity, player: ExprEntity): ExprContext {
  return {
    self,
    player,
    tick: 0,
    ticksPerSecond: 10,
    clock: DEFAULT_CLOCK,
    random: () => 0.5,
    tileIdAt: () => '',
    tileTagsAt: () => new Set(),
    inRoom: () => false,
    los: () => true,
    warn: () => {},
    vars: new Float64Array(0),
    questStage: new Int32Array(0),
    questEnd: new Uint8Array(0),
    journalHas: new Uint8Array(0),
    factions: NO_FACTIONS,
  };
}

test('built-ins: count_tagged / has_tagged sum the stacks carrying the tag; no inventory is 0 / false', () => {
  const symbols = symbolsWith({});
  const self = entity([50, 0], [
    { item: 0, count: 2 },
    { item: 2, count: 5 },
    { item: 1, count: 3 },
  ]);
  const ctx = ctxWith(self, entity([0, 0], null));
  const run = (src: string) => {
    const r = compileSource(src, symbols);
    assert.deepEqual(r.errors, [], src);
    return r.expr.fn(ctx);
  };
  assert.equal(run('count_tagged(self, "food")'), 5);
  assert.equal(run('self.count_tagged("drink")'), 5);
  assert.equal(run('self.count_tagged("food") + self.count_tagged("drink") >= 10'), true);
  assert.equal(run('count_tagged(self, "tool")'), 0);
  assert.equal(run('has_tagged(self, "food")'), true);
  assert.equal(run('self.has_tagged("tool")'), false);
  assert.equal(run('count_tagged(player, "food")'), 0, 'no inventory');
  assert.equal(run('player.has_tagged("food")'), false);
  assert.deepEqual(symbols.warnings, []);
  run('has_tagged(self, "weapon")');
  assert.deepEqual(symbols.warnings, [`no item carries 'weapon'`]);
  const errors = (src: string) => compileSource(src, symbols).errors.map((e) => e.message);
  assert.match(errors('count_tagged(self)')[0]!, /takes 2 arguments/);
  assert.match(errors('count_tagged(self, tool)')[0]!, /string literal item tag/);
  assert.match(errors('has_tagged(1, "food")')[0]!, /expects an entity, got number/);
  assert.match(compileSource('count_tagged(self, "food")', { resolveMeasurement: symbols.resolveMeasurement }).errors[0]!.message, /not available here/);
});

test('built-ins: fraction is (value − min) / (max − min) in [0, 1], 0 without a usable max or the measurement', () => {
  const symbols = symbolsWith({
    'a:hp': { min: 0, maxConst: 100, maxFn: null },
    'a:mp': { min: 10, maxConst: Infinity, maxFn: (c) => c.self.m[0]! / 2 }, // a per-entity max: half of hp
  });
  const self = entity([50, 20], null);
  const player = entity([80, 60], null, [1, 1]);
  const ctx = ctxWith(self, player);
  const run = (src: string) => {
    const r = compileSource(src, symbols);
    assert.deepEqual(r.errors, [], src);
    return r.expr.fn(ctx);
  };
  assert.equal(run('fraction(self, "hp")'), 0.5);
  assert.equal(run('self.fraction("a:hp") < 0.25'), false);
  assert.equal(run('fraction(player, "hp")'), 0.8);
  // The per-entity max is evaluated for the entity asked about: mp ∈ [10, hp / 2].
  assert.equal(run('fraction(self, "mp")'), (20 - 10) / (25 - 10));
  assert.equal(run('fraction(player, "mp")'), (60 - 10) / (40 - 10) > 1 ? 1 : (60 - 10) / (40 - 10));
  assert.equal(ctx.self, self, '`self` is restored after evaluating another entity');
  // Clamped to [0, 1].
  self.m[0] = 130;
  assert.equal(run('fraction(self, "hp")'), 1);
  self.m[0] = -3;
  assert.equal(run('fraction(self, "hp")'), 0);
  // An expression max that resolves to Infinity (or not above min) gives 0.
  self.m[0] = Infinity;
  assert.equal(run('fraction(self, "mp")'), 0);
  self.m[0] = 10;
  assert.equal(run('fraction(self, "mp")'), 0, 'max (5) not above min (10)');
  // An entity without the measurement.
  const without = entity([50, 20], null, [0, 1]);
  assert.equal(compileSource('fraction(self, "hp")', symbols).expr.fn(ctxWith(without, player)), 0);
  const errors = (src: string) => compileSource(src, symbols).errors.map((e) => e.message);
  assert.match(errors('fraction(self, "nope")')[0]!, /unknown measurement 'nope'/);
  assert.match(errors('fraction(self, hp)')[0]!, /string literal measurement id/);
  assert.match(errors('fraction(self)')[0]!, /takes 2 arguments/);
});

test('built-ins: in packs, tags resolve against the loaded items (unknown tag warns), fraction needs a max, no forTag fast path', () => {
  const { def, warnings } = ok([
    fixture({
      'items.yaml': `items:
  - { id: bread, label: Bread, glyph: b, color: white, weight: 0.1, tags: [food] }
  - { id: apple, label: Apple, glyph: a, color: red, weight: 0.1, tags: [food, fresh] }
  - { id: cup, label: Cup, glyph: c, color: white, weight: 0.1, tags: [drink] }
statuses:
  - { id: stocked, label: Stocked, when: 'self.count_tagged("food") + self.count_tagged("drink") >= 5' }
  - { id: dry, label: Dry, when: 'not self.has_tagged("drink")' }
  - { id: low, label: Low, when: 'fraction(self, "food") < 0.3' }
  - { id: empty, label: Empty, when: 'self.fraction("food") <= 0' }
  - { id: carrier, label: Carrier, for: 'self.has_tagged("food")', when: "true" }
  - { id: armed, label: Armed, when: 'self.has_tagged("weapon")' }
`,
      'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [hp, food]
    ticks_per_turn: 0
    inventory: { capacity: 10, items: { bread: 2, apple: 3 } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`,
    }),
  ]);
  assert.deepEqual(
    warnings.map((w) => [w.path, w.message]),
    [['statuses[5].when', `no item carries the tag 'weapon', so it never matches`]],
  );
  assert.equal(status(def, 't:carrier').forTag, null, 'has_tagged is not the has_tag fast path');
  assert.equal(typeof status(def, 't:carrier').forFn, 'function');
  const w = World.create(def, 1);
  w.step();
  const active = (e: { st: Uint8Array }) => def.statuses.filter((s) => e.st[s.index] === 1).map((s) => s.id);
  assert.deepEqual(active(w.player), ['t:stocked', 't:dry', 't:carrier']);
  const rock = w.entities.find((e) => e.archetype.id === 't:rock')!;
  assert.deepEqual(active(rock), ['t:dry', 't:low', 't:empty'], 'an entity without the measurement has fraction 0 (and no inventory)');
  // Food drifts at -1/s from 50: below 30 % of [0, 100] after 21 s.
  for (let i = 0; i < 220; i++) w.step();
  assert.ok(active(w.player).includes('t:low'));
  // Tag typos get a suggestion; `fraction` on a measurement without `max` is an error.
  const typo = ok([fixture({ 'items.yaml': `items:\n  - { id: bread, label: Bread, glyph: b, color: white, weight: 0.1, tags: [food] }\nstatuses:\n  - { id: s, label: S, when: 'self.has_tagged("fod")' }\n` })]);
  expectIn(typo.warnings, { file: 'items.yaml', path: 'statuses[0].when', message: /no item carries the tag 'fod' \(did you mean 'food'\?\)/ });
  expectIn(errorsOf([fixture({ 'rules.yaml': `measurements:\n  - { id: mood, label: Mood, initial: 0 }\nstatuses:\n  - { id: s, label: S, when: 'fraction(self, "mood") > 0.5' }\n` })]), {
    file: 'rules.yaml',
    path: 'statuses[0].when',
    message: /fraction: measurement 't:mood' has no 'max': no maximum to take a fraction of/,
  });
  // A measurement-id max is evaluated at call time: cap ∈ [0, hp].
  const ref = ok([
    fixture({
      'rules.yaml': `measurements:\n  - { id: cap, label: Cap, max: hp, initial: 5 }\nstatuses:\n  - { id: half, label: Half, when: 'fraction(self, "cap") == 0.5' }\n`,
      'archetypes.yaml': `archetypes:\n  - { id: hero, label: Hero, glyph: "@", color: yellow, tags: [living], measurements: [hp, food, cap], ticks_per_turn: 0 }\n  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }\n`,
    }),
  ]);
  const v = World.create(ref.def, 1);
  v.step();
  assert.equal(v.player.st[ref.def.ids.statuses['t:half']!], 1);
});

// ── Equivalence of the converted packs ──────────────────────────────────────

/** Where the pre-conversion copies of the pack files the conversion touched live (`<pack dir name>/<path>`). */
const PRE_DIR = 'test/fixtures/pre-ergonomics';

/** The shipped pack with its converted files swapped back for the pre-conversion copies. */
function before(dir: string): PackSource {
  const src = readPack(dir);
  const name = dir.replace(/^packs\//, '');
  const files = { ...src.files };
  const root = join(PRE_DIR, name);
  if (!existsSync(root)) return src;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return { ...src, files };
}

/** The serialisable shape of a definition (closures dropped), minus the diagnostic `patches`. */
function shape(def: Definition): unknown {
  const { patches: _patches, ...rest } = JSON.parse(JSON.stringify(def)) as Definition;
  return rest;
}

const STACKS: Record<string, readonly string[]> = {
  ...GAMES,
  hardship: ['packs/std', 'packs/std-needs', 'packs/town', 'packs/hardship'],
  'zombie+hardship': ['packs/std', 'packs/std-needs', 'packs/town', 'packs/zombie', 'packs/hardship'],
};
const HASHED = ['town', 'garden', 'zombie', 'vampire', 'noir', 'western'];

test('equivalence: every fixture is a pre-conversion copy that differs from the shipped file', () => {
  const fixtures: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else fixtures.push(relative(PRE_DIR, full).split(sep).join('/'));
    }
  };
  walk(PRE_DIR);
  assert.ok(fixtures.length >= 10, fixtures.join(', '));
  for (const f of fixtures) {
    const shipped = join('packs', f);
    assert.ok(existsSync(shipped), `${f} has no shipped counterpart`);
    assert.notEqual(readFileSync(shipped, 'utf8'), readFileSync(join(PRE_DIR, f), 'utf8'), `${f} was not converted`);
  }
});

test('equivalence: each shipped stack loads to the same definition before and after the conversion, and runs to the same hash', () => {
  for (const [name, dirs] of Object.entries(STACKS)) {
    const after = loadPacks(dirs.map(readPack));
    const pre = loadPacks(dirs.map(before));
    assert.ok(after.ok, after.ok ? '' : after.errors.map(formatError).join('\n'));
    assert.ok(pre.ok, pre.ok ? '' : pre.errors.map(formatError).join('\n'));
    assert.deepEqual(after.warnings, [], `${name}: warnings after the conversion`);
    assert.deepEqual(shape(after.definition), shape(pre.definition), `${name}: definition shape`);
    // Only the provenance of a few patches changed: hardship writes terms, the genres write defeat.message alone.
    assert.deepEqual(
      after.definition.patches.map((p) => [p.pack, p.op, p.domain, p.id]),
      pre.definition.patches.map((p) => [p.pack, p.op, p.domain, p.id]),
      `${name}: patches`,
    );
    if (!HASHED.includes(name)) continue;
    const a = World.create(after.definition, 11);
    const b = World.create(pre.definition, 11);
    for (let i = 0; i < 300; i++) {
      a.step();
      b.step();
    }
    assert.equal(a.hash(), b.hash(), `${name}: hash after 300 ticks`);
    assert.deepEqual(a.snapshot(), b.snapshot(), `${name}: snapshot after 300 ticks`);
  }
});
