import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAscii } from '../src/ascii/render.ts';
import { colorize } from '../src/ascii/terminal.ts';
import { formatError, hudLineLevels, hudLines, hudModel, loadPacks, loadPacksOrThrow, World, type LoadError } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { abbreviate, hudView } from '../src/web/hud.ts';
import { fixture, GAMES, loadFixture } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────

const MEASUREMENTS = (hud: { hp?: string; food?: string; extra?: string } = {}) => `measurements:
  - id: hp
    label: HP
    max: 10
    initial: 10
    ${hud.hp ?? ''}
  - id: food
    label: Food
    max: 100
    initial: 50
    rate: -1
    ${hud.food ?? ''}
${hud.extra ?? ''}`;

function worldWith(files: Record<string, string>): World {
  return World.create(loadFixture(files), 1);
}

function setM(w: World, id: string, v: number): void {
  w.player.m[w.def.ids.measurements[id]!] = v;
}

function measurement(w: World, label: string) {
  return hudModel(w).measurements.find((m) => m.label === label)!;
}

function loadErrors(files: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture(files)]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectMessage(errors: readonly LoadError[], path: string, message: RegExp): void {
  assert.ok(
    errors.some((e) => e.path === path && message.test(e.message)),
    `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`,
  );
}

// ── Pack hints ──────────────────────────────────────────────────────────────

test('hud hints: default levels are 50 % / 75 % toward the bad end, for both directions', () => {
  const w = worldWith({ 'measurements.yaml': MEASUREMENTS({ hp: 'hud: { bad: low }', food: 'hud: { bad: high }' }) });
  const hp = w.def.measurements[w.def.ids.measurements['t:hp']!]!;
  const food = w.def.measurements[w.def.ids.measurements['t:food']!]!;
  assert.deepEqual(hp.hud, { bad: 'low', warn: null, danger: null, hide: false });
  const level = (id: string, v: number, label: string) => {
    setM(w, id, v);
    return measurement(w, label).level;
  };
  // hp in [0, 10], bad low: warn at 5, danger at 2.5.
  assert.equal(level('t:hp', 5.1, 'HP'), 'ok');
  assert.equal(level('t:hp', 5, 'HP'), 'warn');
  assert.equal(level('t:hp', 2.6, 'HP'), 'warn');
  assert.equal(level('t:hp', 2.5, 'HP'), 'danger');
  // food in [0, 100], bad high: warn at 50, danger at 75.
  assert.equal(level('t:food', 49.9, 'Food'), 'ok');
  assert.equal(level('t:food', 50, 'Food'), 'warn');
  assert.equal(level('t:food', 75, 'Food'), 'danger');
  assert.equal(food.hud.bad, 'high');
  const m = measurement(w, 'Food');
  assert.equal(m.bad, 'high');
  assert.equal(m.fraction, 0.75);
});

test('hud hints: explicit levels, a min above 0, a neutral measurement and an unbounded one', () => {
  const w = worldWith({
    'measurements.yaml': MEASUREMENTS({
      hp: 'hud: { bad: low, warn: 8, danger: 3 }',
      food: '',
      extra: `  - id: heat
    label: Heat
    min: 20
    max: 60
    initial: 20
    hud: { bad: high }
  - id: score
    label: Score
    initial: 0
    hud: { bad: high, danger: 100 }
`,
    }),
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, measurements: [hp, food, heat, score] }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`,
  });
  setM(w, 't:hp', 8);
  assert.equal(measurement(w, 'HP').level, 'warn');
  setM(w, 't:hp', 3);
  assert.equal(measurement(w, 'HP').level, 'danger');
  setM(w, 't:hp', 8.1);
  assert.equal(measurement(w, 'HP').level, 'ok');
  // Neutral: no levels.
  assert.equal(measurement(w, 'Food').level, null);
  assert.equal(measurement(w, 'Food').bad, null);
  // [20, 60], bad high: warn at 40, danger at 50.
  setM(w, 't:heat', 39);
  assert.equal(measurement(w, 'Heat').level, 'ok');
  setM(w, 't:heat', 40);
  assert.equal(measurement(w, 'Heat').level, 'warn');
  assert.equal(measurement(w, 'Heat').fraction, 0.5);
  setM(w, 't:heat', 50);
  assert.equal(measurement(w, 'Heat').level, 'danger');
  // Unbounded: no fraction, no default warn, the explicit danger still applies.
  const score = () => measurement(w, 'Score');
  assert.equal(score().fraction, null);
  setM(w, 't:score', 99);
  assert.equal(score().level, 'ok');
  setM(w, 't:score', 100);
  assert.equal(score().level, 'danger');
});

test('hud hints: a per-entity max uses the entity current max for the default levels', () => {
  const w = worldWith({
    'measurements.yaml': MEASUREMENTS({
      extra: `  - id: blood
    label: Blood
    max: "self.hp * 10"
    initial: 100
    hud: { bad: low }
`,
    }),
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, measurements: [hp, food, blood] }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`,
  });
  // max 100: warn at 50, danger at 25.
  setM(w, 't:blood', 40);
  assert.equal(measurement(w, 'Blood').level, 'warn');
  // max 40 (hp 4, after a tick re-reads max): warn at 20, danger at 10 — 40 is full.
  setM(w, 't:hp', 4);
  w.step();
  assert.equal(measurement(w, 'Blood').max, 40);
  assert.equal(measurement(w, 'Blood').level, 'ok');
  assert.equal(measurement(w, 'Blood').fraction, 1);
});

test('hud hints: validation errors', () => {
  const m = (food: string) => ({ 'measurements.yaml': MEASUREMENTS({ food }) });
  expectMessage(loadErrors(m('hud: { bad: high, colour: red }')), 'measurements[1].hud.colour', /unknown hud field 'colour'/);
  expectMessage(loadErrors(m('hud: { bad: up }')), 'measurements[1].hud.bad', /'bad' must be 'high' or 'low'/);
  expectMessage(loadErrors(m('hud: { bad: high, warn: 80, danger: 60 }')), 'measurements[1].hud.danger', /contradict 'bad: high'/);
  expectMessage(loadErrors(m('hud: { bad: low, warn: 20, danger: 60 }')), 'measurements[1].hud.danger', /contradict 'bad: low'/);
  // A defaulted level (danger 75 of [0, 100]) checked against an explicit one.
  expectMessage(loadErrors(m('hud: { bad: high, warn: 90 }')), 'measurements[1].hud.warn', /'warn' must be ≤ 'danger'/);
  expectMessage(loadErrors(m('hud: { warn: 50 }')), 'measurements[1].hud.warn', /needs 'bad'/);
  expectMessage(loadErrors(m('hud: { danger: 50 }')), 'measurements[1].hud.danger', /needs 'bad'/);
  expectMessage(loadErrors(m('hud: { hide: maybe }')), 'measurements[1].hud.hide', /must be a boolean/);
  const status = (hud: string) => ({
    'statuses.yaml': `statuses:
  - { id: weak, label: Weak, when: "self.hp < 5", hud: ${hud} }
`,
  });
  expectMessage(loadErrors(status('{ tone: awful }')), 'statuses[0].hud.tone', /'tone' must be 'bad', 'good' or 'neutral'/);
  expectMessage(loadErrors(status('{ tone: bad, text: x }')), 'statuses[0].hud.text', /unknown hud field 'text'/);
  // Equal levels are fine.
  assert.ok(loadPacks([fixture(m('hud: { bad: high, warn: 60, danger: 60 }'))]).ok);
});

test('hud hints: hide keeps a measurement out of both shells', () => {
  const w = worldWith({ 'measurements.yaml': MEASUREMENTS({ hp: 'hud: { hide: true }' }) });
  const m = hudModel(w);
  assert.deepEqual(
    m.measurements.map((x) => x.label),
    ['Food'],
  );
  assert.ok(!hudLines(m).some((l) => l.startsWith('HP')));
  assert.deepEqual(
    hudView(m).bars.map((b) => b.id),
    ['t:food'],
  );
});

test('hud hints: overrides patch them like any other field; they are not saved', () => {
  const base = fixture({ 'measurements.yaml': MEASUREMENTS({ food: 'hud: { bad: low }' }) });
  const mod = {
    label: 'mod',
    files: {
      'pack.yaml': 'namespace: m\nname: Mod\nversion: 1.0.0\nkind: mod\ndepends: [t]\n',
      'tweaks.yaml': `measurements:
  - id: t:food
    override: true
    hud: { bad: high, warn: 10, danger: 20 }
`,
    },
  };
  const def = loadPacksOrThrow([base, mod]);
  assert.deepEqual(def.measurements[def.ids.measurements['t:food']!]!.hud, { bad: 'high', warn: 10, danger: 20, hide: false });
  const plain = World.create(loadPacksOrThrow([base]), 1);
  const modded = World.create(def, 1);
  assert.equal(modded.hash(), plain.hash());
  assert.ok(!JSON.stringify(modded.save()).includes('"hud"'));
});

// ── Model ───────────────────────────────────────────────────────────────────

test('hudModel: level transitions as a measurement drifts', () => {
  // food drifts -1/s from 50; bad low: warn at 50, danger at 25.
  const w = worldWith({ 'measurements.yaml': MEASUREMENTS({ food: 'hud: { bad: low, warn: 40, danger: 20 }' }) });
  const seen: string[] = [];
  for (let i = 0; i < 600; i++) {
    const level = measurement(w, 'Food').level!;
    if (seen.at(-1) !== level) seen.push(level);
    w.step();
  }
  assert.deepEqual(seen, ['ok', 'warn', 'danger']);
  assert.equal(measurement(w, 'Food').value, 0);
});

test('hudModel: status chips with tone, description and rates (constant and expression)', () => {
  const w = worldWith({
    'statuses.yaml': `statuses:
  - id: starving
    label: Starving
    when: "self.food < 45"
    rates: { hp: -0.2, food: "-0.05 * self.hp" }
    hud: { tone: bad, description: Losing health }
  - id: fed
    label: Fed
    when: "self.food >= 45"
    rates: { food: 0.25, missing_on_hero: 3 }
    hud: { tone: good }
  - id: plain
    label: Plain
    when: "true"
`,
    'measurements.yaml': MEASUREMENTS({
      extra: `  - id: missing_on_hero
    label: Elsewhere
    initial: 0
`,
    }),
  });
  w.step();
  let m = hudModel(w);
  assert.deepEqual(m.statusChips, [
    { id: 't:fed', label: 'Fed', tone: 'good', description: '', rates: 'Food +0.3/s' },
    { id: 't:plain', label: 'Plain', tone: 'neutral', description: '', rates: '' },
  ]);
  for (let i = 0; i < 100 && !hudModel(w).statuses.includes('Starving'); i++) w.step();
  m = hudModel(w);
  assert.equal(m.statusChips[0]!.id, 't:starving');
  // hp 10 → food −0.5/s.
  assert.equal(m.statusChips[0]!.rates, 'HP −0.2/s, Food −0.5/s');
  assert.equal(m.statusChips[0]!.description, 'Losing health');
  setM(w, 't:hp', 2);
  assert.equal(hudModel(w).statusChips[0]!.rates, 'HP −0.2/s, Food −0.1/s');
  // Reading the rates is pure.
  const h = w.hash();
  hudModel(w);
  assert.equal(w.hash(), h);
});

test('hudModel: is_day and the clock parts', () => {
  const w = worldWith({});
  const m = hudModel(w);
  assert.equal(m.isDay, true);
  assert.equal(m.day, 1);
  assert.equal(m.timeOfDay, '08:00');
  assert.equal(hudView(m).clock.text, 'Day 1 · 08:00');
  assert.equal(hudView(m).clock.icon, 'sun');
  const night = worldWith({ 'clock.yaml': 'clock:\n  start: "23:00"\n' });
  assert.equal(hudModel(night).isDay, false);
  assert.equal(hudView(hudModel(night)).clock.icon, 'moon');
});

test('hudModel: inventory fraction and level (warn from 80 %, danger at 100 %)', () => {
  const at = (pebbles: number) => {
    const w = worldWith({
      'items.yaml': 'items:\n  - { id: pebble, label: Pebble, glyph: "*", color: gray, weight: 0.1 }\n',
      'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, measurements: [hp, food], inventory: { capacity: 1${pebbles ? `, items: { pebble: ${pebbles} }` : ''} } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`,
    });
    return hudModel(w).inventory!;
  };
  assert.equal(at(0).level, 'ok');
  assert.equal(at(0).fraction, 0);
  assert.equal(at(7).level, 'ok');
  assert.equal(at(8).level, 'warn');
  assert.equal(at(9).level, 'warn');
  assert.equal(at(10).level, 'danger');
  assert.equal(at(10).fraction, 1);
  // The fixture hero has no inventory: no carrying bar.
  assert.equal(hudView(hudModel(worldWith({}))).carrying, null);
});

// ── Terminal ────────────────────────────────────────────────────────────────

test('terminal: measurement lines yellow at warn, red at danger; Status red with a bad status', () => {
  const w = worldWith({
    'measurements.yaml': MEASUREMENTS({ food: 'hud: { bad: low, warn: 40, danger: 20 }' }),
    'statuses.yaml': `statuses:
  - { id: low, label: Low, when: "self.food < 30", hud: { tone: bad } }
  - { id: ok, label: Ok, when: "true" }
`,
  });
  const frameText = () => colorize(renderAscii(w, { width: 5, height: 4 }));
  const line = (prefix: string) => frameText().split('\n').find((l) => l.replace(/\x1b\[[0-9;]*m/g, '').startsWith(prefix))!;
  w.step();
  assert.equal(line('Food:'), 'Food: 49.9/100.0');
  assert.equal(line('Status:'), 'Status: Ok');
  setM(w, 't:food', 40.1);
  w.step();
  assert.equal(line('Food:'), '\x1b[33mFood: 40.0/100.0\x1b[0m');
  setM(w, 't:food', 20);
  w.step();
  assert.equal(line('Food:'), '\x1b[31mFood: 19.9/100.0\x1b[0m');
  assert.equal(line('Status:'), '\x1b[31mStatus: Low, Ok\x1b[0m');
  const m = hudModel(w);
  assert.equal(hudLineLevels(m).length, hudLines(m).length);
});

// ── Browser view ────────────────────────────────────────────────────────────

test('hudView: abbreviations, rounding and bar colours', () => {
  assert.equal(abbreviate('Hunger'), 'Hun');
  assert.equal(abbreviate('HP'), 'HP');
  assert.equal(abbreviate('Max health points'), 'MHP');
  const w = worldWith({ 'measurements.yaml': MEASUREMENTS({ hp: 'hud: { bad: low }' }) });
  setM(w, 't:hp', 2.4);
  setM(w, 't:food', 23.456);
  const v = hudView(hudModel(w));
  assert.deepEqual(v.bars, [
    { id: 't:hp', label: 'HP', abbr: 'HP', percent: 24, value: '2/10', color: 'danger', pulse: true },
    { id: 't:food', label: 'Food', abbr: 'Foo', percent: 23, value: '23/100', color: 'neutral', pulse: false },
  ]);
  // A small drift does not change the view.
  setM(w, 't:food', 23.41);
  assert.deepEqual(hudView(hudModel(w)), v);
});

const ZOMBIE = loadPacksOrThrow(GAMES.zombie.map((d) => readPack(d)));
const VAMPIRE = loadPacksOrThrow(GAMES.vampire.map((d) => readPack(d)));

test('hudView: zombie world', () => {
  const w = World.create(ZOMBIE, 1);
  const v = hudView(hudModel(w));
  assert.deepEqual(v.clock, { text: 'Day 1 · 08:00', icon: 'sun', floor: v.clock.floor });
  assert.deepEqual(
    v.bars.map((b) => [b.label, b.abbr, b.percent, b.value, b.color]),
    [
      ['Health', 'Hea', 100, '100/100', 'ok'],
      ['Hunger', 'Hun', 20, '20/100', 'ok'],
      ['Thirst', 'Thi', 10, '10/100', 'ok'],
      ['Fatigue', 'Fat', 0, '0/100', 'ok'],
    ],
  );
  assert.deepEqual(v.chips, []);
  assert.equal(v.carrying?.color, 'ok');
  // Hungry: the bar turns red and a bad chip with its description and rate appears.
  setM(w, 'std_needs:hunger', 80);
  w.step();
  const hungry = hudView(hudModel(w));
  assert.equal(hungry.bars[1]!.color, 'danger');
  assert.equal(hungry.bars[1]!.pulse, true);
  assert.deepEqual(hungry.chips[0], {
    id: 'std_needs:hungry',
    label: 'Hungry',
    tone: 'bad',
    tooltip: ['Hungry', 'Losing health while hungry', 'Health −0.2/s'],
  });
});

test('hudView: vampire world', () => {
  const w = World.create(VAMPIRE, 1);
  const v = hudView(hudModel(w));
  const blood = v.bars.find((b) => b.label === 'Blood')!;
  assert.equal(blood.abbr, 'Blo');
  assert.equal(blood.color, 'ok');
  setM(w, 'vamp:blood', 5);
  w.step();
  const starving = hudView(hudModel(w));
  assert.equal(starving.bars.find((b) => b.label === 'Blood')!.color, 'danger');
  const chip = starving.chips.find((c) => c.label === 'Starving')!;
  assert.equal(chip.tone, 'bad');
  assert.deepEqual(chip.tooltip, ['Starving', 'Out of blood; losing health', 'Health −0.3/s']);
});

test('bundled packs: the need statuses are bad with a description; the needs have bad directions', () => {
  for (const id of ['hungry', 'thirsty', 'exhausted', 'burdened']) {
    const s = ZOMBIE.statuses.find((x) => x.id === `std_needs:${id}`)!;
    assert.equal(s.hud.tone, 'bad', id);
    assert.ok(s.hud.description.length > 0, id);
  }
  const bad = (id: string) => ZOMBIE.measurements[ZOMBIE.ids.measurements[id]!]!.hud.bad;
  assert.equal(bad('std:hp'), 'low');
  assert.equal(bad('std_needs:hunger'), 'high');
  assert.equal(bad('std_needs:thirst'), 'high');
  assert.equal(bad('std_needs:fatigue'), 'high');
});
