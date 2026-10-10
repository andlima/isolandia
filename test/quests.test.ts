import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleKey, journalMessage, type KeyState } from '../src/ascii/terminal.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { readPack } from '../src/node/read-pack.ts';
import {
  add,
  dayAt,
  formatError,
  isDayAt,
  journalLines,
  journalToast,
  loadPacks,
  loadPacksOrThrow,
  World,
  type Definition,
  type LoadError,
  type PackSource,
  type SaveFile,
} from '../src/core/index.ts';
import { journalView } from '../src/web/panels.ts';
import { assertRoundTrip, fixture, GAMES } from './helpers.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The fixture's map with a `start` that can take extra fields (indented by two spaces). */
const mapWith = (startExtra = '') => `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
    rows:
      - "#####"
      - "#.@o#"
      - "#...#"
      - "#####"
start:
  map: room
  player: hero
${startExtra}`;

/** Systems that run once, on tick `n`, for the player only (the hero is the only `living` entity). */
const at = (n: number, effects: string) => `  - { id: at_${n}_${Math.abs(hashOf(effects))}, for: 'self.has_tag("living")', when: "world.tick == ${n}", effects: [${effects}] }\n`;

function hashOf(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

function load(files: Record<string, string>): Definition {
  return loadPacksOrThrow([fixture(files)]);
}

function world(files: Record<string, string>, seed = 1): World {
  return World.create(load(files), seed);
}

function steps(w: World, n: number): World {
  for (let i = 0; i < n; i++) w.step();
  return w;
}

function errorsOf(files: Record<string, string>, extra: PackSource[] = []): readonly LoadError[] {
  const r = loadPacks([fixture(files), ...extra]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], file: string, path: string, message: RegExp): void {
  const hit = errors.find((e) => e.file === file && e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${file} ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

const stageOf = (w: World, quest: string): string | null => {
  const q = w.def.quests[w.def.ids.quests[quest]!]!;
  const s = w.questStage[q.index]!;
  return s < 0 ? null : q.stages[s]!.name;
};
const varOf = (w: World, id: string) => w.vars[w.def.ids.vars[id]!]!;

// ── Loader: vars ────────────────────────────────────────────────────────────

test('vars: defaults, booleans as 1/0, labels; world values start at initial', () => {
  const def = load({
    'v.yaml': `vars:
  - { id: clues }
  - { id: paid, initial: true, label: Bartender paid }
  - { id: off, initial: false }
  - { id: heat, initial: 3, min: 0, max: 5 }
`,
  });
  assert.deepEqual(
    def.vars.map((v) => [v.id, v.label, v.initial, v.min, v.max]),
    [
      ['t:clues', 't:clues', 0, -Infinity, Infinity],
      ['t:paid', 'Bartender paid', 1, -Infinity, Infinity],
      ['t:off', 't:off', 0, -Infinity, Infinity],
      ['t:heat', 't:heat', 3, 0, 5],
    ],
  );
  assert.deepEqual(def.ids.vars, { 't:clues': 0, 't:paid': 1, 't:off': 2, 't:heat': 3 });
  const w = World.create(def, 1);
  assert.deepEqual([...w.vars], [0, 1, 0, 3]);
});

test('vars: load errors', () => {
  const e = (yaml: string) => errorsOf({ 'v.yaml': `vars:\n${yaml}` });
  expectError(e('  - { id: a, initial: 5, max: 3 }\n'), 'v.yaml', 'vars[0].initial', /initial \(5\) is outside \[-Infinity, 3\]/);
  expectError(e('  - { id: a, min: 2 }\n'), 'v.yaml', 'vars[0]', /initial \(0\) is outside \[2, Infinity\]/);
  expectError(e('  - { id: a, min: 2, max: 1, initial: 1 }\n'), 'v.yaml', 'vars[0].max', /max \(1\) is less than min \(2\)/);
  expectError(e('  - { id: a, initial: lots }\n'), 'v.yaml', 'vars[0].initial', /must be a number or true\/false/);
  expectError(e('  - { id: a, rate: 1 }\n'), 'v.yaml', 'vars[0].rate', /unknown var field 'rate'/);
  expectError(e('  - { id: a }\n  - { id: a }\n'), 'v.yaml', 'vars[1].id', /duplicate var id 't:a'/);
});

// ── Loader: journal ─────────────────────────────────────────────────────────

test('journal: entries with a default category', () => {
  const def = load({ 'j.yaml': 'journal:\n  - { id: letter, text: A torn letter. }\n  - { id: rumour, text: They say..., category: Rumours }\n' });
  assert.deepEqual(
    def.journal.map((j) => [j.id, j.text, j.category]),
    [
      ['t:letter', 'A torn letter.', 'Notes'],
      ['t:rumour', 'They say...', 'Rumours'],
    ],
  );
});

test('journal: load errors', () => {
  const e = (yaml: string) => errorsOf({ 'j.yaml': `journal:\n${yaml}` });
  expectError(e('  - { id: a }\n'), 'j.yaml', 'journal[0]', /missing required field 'text'/);
  expectError(e('  - { id: a, text: "  " }\n'), 'j.yaml', 'journal[0].text', /must not be empty/);
  expectError(e('  - { id: a, text: x, label: y }\n'), 'j.yaml', 'journal[0].label', /unknown journal entry field 'label'/);
  expectError(e('  - { id: a, text: [x] }\n'), 'j.yaml', 'journal[0].text', /must be a string/);
});

// ── Loader: quests ──────────────────────────────────────────────────────────

const QUEST = `quests:
  - id: hunt
    title: The hunt
    stages:
      - { id: start, when: "true", journal: Find the beast. }
      - { id: tracks, journal: You found tracks. }
      - { id: done, end: success, journal: The beast is dead., effects: [{ type: apply, measurement: hp, delta: 1 }] }
`;

test('quests: stages, ends, watched stages and effects', () => {
  const def = load({ 'q.yaml': QUEST });
  const q = def.quests[0]!;
  assert.equal(q.id, 't:hunt');
  assert.equal(q.title, 'The hunt');
  assert.equal(q.hidden, false);
  assert.deepEqual(
    q.stages.map((s) => [s.name, s.index, s.journal, s.end, s.whenFn !== null, s.effects.length]),
    [
      ['start', 0, 'Find the beast.', null, true, 0],
      ['tracks', 1, 'You found tracks.', null, false, 0],
      ['done', 2, 'The beast is dead.', 'success', false, 1],
    ],
  );
  assert.deepEqual(q.watched, [0]);
});

test('quests: load errors (fields, stages, ends, a quest that can never start)', () => {
  const e = (yaml: string) => errorsOf({ 'q.yaml': `quests:\n${yaml}` });
  expectError(e('  - { id: q, stages: [{ id: a, when: "true", journal: x }] }\n'), 'q.yaml', 'quests[0]', /missing required field 'title'/);
  expectError(e('  - { id: q, title: Q }\n'), 'q.yaml', 'quests[0]', /missing required field 'stages'/);
  expectError(e('  - { id: q, title: Q, stages: [] }\n'), 'q.yaml', 'quests[0].stages', /at least one stage/);
  expectError(e('  - { id: q, title: Q, hiden: true, stages: [{ id: a, when: "true", journal: x }] }\n'), 'q.yaml', 'quests[0].hiden', /unknown quest field 'hiden' \(did you mean 'hidden'\?\)/);
  expectError(e('  - { id: q, title: Q, stages: [{ id: a, when: "true", journal: x, text: y }] }\n'), 'q.yaml', 'quests[0].stages[0].text', /unknown stage field 'text'/);
  expectError(
    e('  - { id: q, title: Q, stages: [{ id: a, when: "true", journal: x }, { id: a, journal: y }] }\n'),
    'q.yaml',
    'quests[0].stages[1].id',
    /duplicate stage id 'a' in quest 't:q'/,
  );
  expectError(e('  - { id: q, title: Q, stages: [{ id: Bad, when: "true", journal: x }] }\n'), 'q.yaml', 'quests[0].stages[0].id', /invalid stage id 'Bad'/);
  expectError(e('  - { id: q, title: Q, stages: [{ when: "true", journal: x }] }\n'), 'q.yaml', 'quests[0].stages[0]', /missing required field 'id'/);
  expectError(e('  - { id: q, title: Q, stages: [{ id: a, when: "true" }] }\n'), 'q.yaml', 'quests[0].stages[0]', /missing required field 'journal'/);
  expectError(e('  - { id: q, title: Q, stages: [{ id: a, when: "true", journal: x, end: won }] }\n'), 'q.yaml', 'quests[0].stages[0].end', /'success' or 'failure'/);
  expectError(e('  - { id: q, title: Q, stages: [{ id: a, when: "self", journal: x }] }\n'), 'q.yaml', 'quests[0].stages[0].when', /got entity/);
  expectError(e('  - { id: q, title: Q, stages: ["a"] }\n'), 'q.yaml', 'quests[0].stages[0]', /stages must be mappings/);
  expectError(
    e('  - { id: q, title: Q, stages: [{ id: a, journal: x, effects: [{ type: set_tile, tile: floor }] }] }\n'),
    'q.yaml',
    'quests[0].stages[0].effects[0].type',
    /only allowed in the effects of tile-targeted actions/,
  );
  expectError(e('  - { id: q, title: Q, stages: [{ id: a, journal: x }, { id: b, journal: y }] }\n'), 'q.yaml', 'quests[0].stages', /quest 't:q' can never start/);
  // A `quest` effect anywhere makes it startable.
  const ok = loadPacks([fixture({ 'q.yaml': `quests:\n  - { id: q, title: Q, stages: [{ id: a, journal: x }] }\n`, 's.yaml': `systems:\n${at(3, '{ type: quest, quest: q, stage: a }')}` })]);
  assert.ok(ok.ok);
});

// ── Loader: expressions and effects ────────────────────────────────────────

const STORY = `vars:
  - { id: clues, min: 0, max: 3 }
journal:
  - { id: letter, text: A torn letter. }
${QUEST}`;

test('expressions: the new built-ins compile everywhere; ids resolve at load with did-you-mean', () => {
  const ok = loadPacks([
    fixture({
      's.yaml': `${STORY}systems:
  - { id: s, when: 'var("clues") > 0 and in_journal("letter") and quest_active("hunt") and quest_reached("hunt", "tracks") and not quest_succeeded("t:hunt") and not quest_failed("hunt")', effects: [{ type: apply, measurement: hp, delta: 1 }] }
statuses:
  - { id: lucky, label: Lucky, when: 'var("t:clues") >= 2' }
`,
      'map.yaml': mapWith('  victory: { when: \'quest_succeeded("hunt")\' }\n  defeat: { when: \'quest_failed("hunt") or var("clues") < 0\' }\n'),
    }),
  ]);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.map(formatError).join('\n'));
  const e = (when: string) => errorsOf({ 's.yaml': `${STORY}systems:\n  - { id: s, when: '${when}', effects: [{ type: apply, measurement: hp, delta: 1 }] }\n` });
  const at = 'systems[0].when';
  expectError(e('var("clus") > 0'), 's.yaml', at, /var: unknown var 'clus' \(did you mean 'clues'\?\)/);
  expectError(e('var(clues) > 0'), 's.yaml', at, /var\(\) expects a string literal var id/);
  expectError(e('var("clues", 1) > 0'), 's.yaml', at, /var\(\) takes 1 argument, got 2/);
  expectError(e('in_journal("leter")'), 's.yaml', at, /in_journal: unknown journal entry 'leter' \(did you mean 'letter'\?\)/);
  expectError(e('quest_active("hunts")'), 's.yaml', at, /quest_active: unknown quest 'hunts' \(did you mean 'hunt'\?\)/);
  expectError(e('quest_succeeded("x")'), 's.yaml', at, /quest_succeeded: unknown quest 'x'/);
  expectError(e('quest_failed(1)'), 's.yaml', at, /expects a string literal quest id/);
  expectError(e('quest_reached("hunt", "trcks")'), 's.yaml', at, /unknown stage 'trcks' of quest 't:hunt' \(did you mean 'tracks'\?\)/);
  expectError(e('quest_reached("hunt")'), 's.yaml', at, /quest_reached\(\) takes 2 arguments, got 1/);
});

test('effects: set_var, add_var, quest and journal load; unknown ids and stages are errors', () => {
  const def = load({
    's.yaml': `${STORY}systems:
  - id: s
    effects:
      - { type: set_var, var: clues, value: 2 }
      - { type: add_var, var: clues, delta: "self.hp / 10" }
      - { type: quest, quest: hunt, stage: tracks }
      - { type: journal, entry: letter }
`,
  });
  const effects = def.systems[0]!.effects;
  assert.deepEqual(
    effects.map((x) => x.type),
    ['set_var', 'add_var', 'quest', 'journal'],
  );
  assert.deepEqual(effects[2], { type: 'quest', quest: 0, stage: 1 });
  assert.deepEqual(effects[3], { type: 'journal', entry: 0 });
  const e = (eff: string) => errorsOf({ 's.yaml': `${STORY}systems:\n  - { id: s, effects: [${eff}] }\n` });
  const p = 'systems[0].effects[0]';
  expectError(e('{ type: set_var, var: clue, value: 1 }'), 's.yaml', `${p}.var`, /unknown var 'clue' \(did you mean 'clues'\?\)/);
  expectError(e('{ type: set_var, var: clues }'), 's.yaml', p, /missing required field 'value'/);
  expectError(e('{ type: add_var, var: clues, value: 1 }'), 's.yaml', `${p}.value`, /unknown 'add_var' effect field 'value'/);
  expectError(e('{ type: add_var, var: clues, delta: tile }'), 's.yaml', `${p}.delta`, /got tile/);
  expectError(e('{ type: quest, quest: hnt, stage: start }'), 's.yaml', `${p}.quest`, /unknown quest 'hnt' \(did you mean 'hunt'\?\)/);
  expectError(e('{ type: quest, quest: hunt, stage: trakcs }'), 's.yaml', `${p}.stage`, /unknown stage 'trakcs' of quest 't:hunt' \(did you mean 'tracks'\?\)/);
  expectError(e('{ type: quest, quest: hunt }'), 's.yaml', p, /missing required field 'stage'/);
  expectError(e('{ type: journal, entry: leter }'), 's.yaml', `${p}.entry`, /unknown journal entry 'leter' \(did you mean 'letter'\?\)/);
  expectError(e('{ type: jounral, entry: letter }'), 's.yaml', `${p}.type`, /unknown effect type "jounral" \(did you mean 'journal'\?\)/);
});

test('effects: valid in item uses, actions, recipes and quest stages', () => {
  const ok = loadPacks([
    fixture({
      's.yaml': `${STORY}items:
  - { id: note, label: Note, glyph: n, color: white, weight: 0, use: { effects: [{ type: journal, entry: letter }] } }
  - { id: coin, label: Coin, glyph: c, color: white, weight: 0 }
actions:
  - { id: think, label: Think, target: self, effects: [{ type: add_var, var: clues, delta: 1 }] }
  - { id: read, label: Read, target: { tiles: [floor] }, effects: [{ type: quest, quest: hunt, stage: tracks }] }
recipes:
  - { id: mint, label: Coin, consume: { note: 1 }, produce: { coin: 1 }, effects: [{ type: set_var, var: clues, value: 3 }] }
`,
      'q2.yaml': `quests:
  - id: other
    title: Other
    stages:
      - { id: a, when: "true", journal: x, effects: [{ type: quest, quest: hunt, stage: done }, { type: journal, entry: letter }, { type: set_var, var: clues, value: 1 }] }
`,
    }),
  ]);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.map(formatError).join('\n'));
});

// ── Simulation: vars ────────────────────────────────────────────────────────

test('vars: set_var and add_var clamp to [min, max]; add_var in a system runs once per matching entity', () => {
  const w = world({
    's.yaml': `vars:
  - { id: v, min: -2, max: 5 }
  - { id: count }
systems:
${at(0, '{ type: set_var, var: v, value: 9 }')}${at(1, '{ type: add_var, var: v, delta: -100 }')}${at(2, '{ type: add_var, var: v, delta: "1.5" }')}  - { id: each, when: "world.tick == 3", effects: [{ type: add_var, var: count, delta: 1 }] }
`,
  });
  assert.equal(w.entities.length, 2, 'the hero and the rock');
  w.step();
  assert.equal(varOf(w, 't:v'), 5, 'clamped to max');
  w.step();
  assert.equal(varOf(w, 't:v'), -2, 'clamped to min');
  w.step();
  assert.equal(varOf(w, 't:v'), -0.5);
  w.step();
  assert.equal(varOf(w, 't:count'), 2, 'one add per matching entity (hero and rock)');
});

test('vars: var() reads the current value in the same tick, after earlier effects', () => {
  const w = world({
    's.yaml': `vars:
  - { id: v }
systems:
  - { id: a, for: 'self.has_tag("living")', effects: [{ type: add_var, var: v, delta: 1 }] }
  - { id: b, for: 'self.has_tag("living")', when: 'var("v") >= 3', effects: [{ type: set, measurement: hp, value: 1 }] }
`,
  });
  steps(w, 2);
  assert.equal(w.value(w.player, 't:hp'), 10);
  w.step();
  assert.equal(w.value(w.player, 't:hp'), 1);
});

// ── Simulation: the quest phase ─────────────────────────────────────────────

test('quest phase: enters the last truthy stage after the current one, skipping those in between', () => {
  const w = world({
    'q.yaml': `vars:
  - { id: go }
quests:
  - id: q
    title: Q
    stages:
      - { id: a, when: "true", journal: A }
      - { id: b, when: "true", journal: B }
      - { id: c, journal: C }
      - { id: d, when: 'var("go") >= 1', journal: D }
`,
  });
  assert.equal(stageOf(w, 't:q'), null);
  w.step();
  assert.equal(stageOf(w, 't:q'), 'b', 'skips a');
  assert.deepEqual(w.journalEvents, [{ tick: 0, kind: 'stage', quest: 't:q', stage: 'b' }]);
  steps(w, 3);
  assert.equal(stageOf(w, 't:q'), 'b');
  assert.deepEqual(w.journalEvents, [], 'only the last tick');
  w.vars[w.def.ids.vars['t:go']!] = 1;
  w.step();
  assert.equal(stageOf(w, 't:q'), 'd', 'skips c, which has no when');
  assert.equal(w.questSince[0], 4);
});

test('quest phase: one change per quest per tick, also when an effect moved it first in the phase', () => {
  const w = world({
    'q.yaml': `quests:
  - id: first
    title: First
    stages:
      - { id: a, when: "true", journal: A, effects: [{ type: quest, quest: second, stage: x }] }
      - { id: b, when: 'quest_reached("first", "a")', journal: B }
  - id: second
    title: Second
    stages:
      - { id: x, journal: X }
      - { id: y, when: "true", journal: Y }
`,
  });
  w.step();
  assert.equal(stageOf(w, 't:first'), 'a', 'b waits for the next tick');
  assert.equal(stageOf(w, 't:second'), 'x', 'moved by the effect; its own when waits');
  assert.deepEqual(
    w.journalEvents.map((e) => `${e.quest}:${e.stage}`),
    ['t:first:a', 't:second:x'],
  );
  w.step();
  assert.equal(stageOf(w, 't:first'), 'b');
  assert.equal(stageOf(w, 't:second'), 'y');
});

test('quest phase: stage effects are seen by later quests in the same phase, not by earlier ones', () => {
  const quests = (order: string[]) => {
    const q: Record<string, string> = {
      setter: `  - { id: setter, title: S, stages: [{ id: a, when: "true", journal: A, effects: [{ type: set_var, var: flag, value: 1 }, { type: journal, entry: note }] }] }\n`,
      reader: `  - { id: reader, title: R, stages: [{ id: a, when: 'var("flag") >= 1 and in_journal("note")', journal: A }] }\n`,
    };
    return world({ 'q.yaml': `vars:\n  - { id: flag }\njournal:\n  - { id: note, text: N }\nquests:\n${order.map((k) => q[k]).join('')}` });
  };
  const later = quests(['setter', 'reader']);
  later.step();
  assert.equal(stageOf(later, 't:reader'), 'a', 'same tick');
  const earlier = quests(['reader', 'setter']);
  earlier.step();
  assert.equal(stageOf(earlier, 't:reader'), null);
  earlier.step();
  assert.equal(stageOf(earlier, 't:reader'), 'a', 'next tick');
});

test('quest phase: an end stage freezes the quest; built-ins report the outcome', () => {
  const w = world({
    'q.yaml': `quests:
  - id: q
    title: Q
    stages:
      - { id: a, when: "world.tick == 0", end: failure, journal: Lost }
      - { id: b, when: "world.tick >= 2", journal: Too late }
vars:
  - { id: active }
  - { id: reached_a }
  - { id: reached_b }
  - { id: failed }
  - { id: won }
systems:
  - id: probe
    for: 'self.has_tag("living")'
    effects:
      - { type: set_var, var: active, value: 'quest_active("q")' }
      - { type: set_var, var: reached_a, value: 'quest_reached("q", "a")' }
      - { type: set_var, var: reached_b, value: 'quest_reached("q", "b")' }
      - { type: set_var, var: failed, value: 'quest_failed("q")' }
      - { type: set_var, var: won, value: 'quest_succeeded("q")' }
${at(3, '{ type: quest, quest: q, stage: b }')}`,
  });
  steps(w, 5);
  assert.equal(stageOf(w, 't:q'), 'a', 'neither when nor effects move an ended quest');
  assert.equal(w.questEnd[0], 2);
  assert.deepEqual(
    ['active', 'reached_a', 'reached_b', 'failed', 'won'].map((v) => varOf(w, `t:${v}`)),
    [0, 1, 0, 1, 0],
  );
});

test('quest effects only move forward', () => {
  const w = world({
    'q.yaml': `quests:
  - id: q
    title: Q
    stages:
      - { id: a, journal: A }
      - { id: b, journal: B }
      - { id: c, journal: C }
systems:
${at(1, '{ type: quest, quest: q, stage: b }')}${at(2, '{ type: quest, quest: q, stage: a }')}${at(3, '{ type: quest, quest: q, stage: b }')}${at(4, '{ type: quest, quest: q, stage: c }')}`,
  });
  steps(w, 2);
  assert.equal(stageOf(w, 't:q'), 'b');
  assert.equal(w.questSince[0], 1);
  const v = w.journalVersion;
  steps(w, 2);
  assert.equal(stageOf(w, 't:q'), 'b', 'back and equal are no-ops');
  assert.equal(w.journalVersion, v);
  assert.equal(w.questSince[0], 1);
  w.step();
  assert.equal(stageOf(w, 't:q'), 'c');
  assert.equal(w.journalVersion, v + 1);
});

test('quest effects nested more than 8 deep stop with an error naming the chain', () => {
  const chain = (n: number) => {
    let yaml = 'quests:\n';
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? `, effects: [{ type: quest, quest: q${i + 1}, stage: a }]` : '';
      yaml += `  - { id: q${i}, title: Q${i}, stages: [{ id: a, ${i === 0 ? 'when: "true", ' : ''}journal: x${next} }] }\n`;
    }
    return world({ 'q.yaml': yaml });
  };
  const nine = chain(9); // entered by the phase, then 8 nested
  nine.step();
  assert.equal(stageOf(nine, 't:q8'), 'a');
  const ten = chain(10);
  assert.throws(() => ten.step(), /nest more than 8 deep: t:q0:a → t:q1:a → t:q2:a → .* → t:q9:a/);
});

test('victory on the tick a quest succeeds; the outcome check follows the quest phase', () => {
  const w = world({
    'q.yaml': `quests:
  - { id: q, title: Q, stages: [{ id: a, when: "world.tick >= 3", end: success, journal: Won }] }
`,
    'map.yaml': mapWith('  victory: { when: \'quest_succeeded("q")\', message: Done }\n'),
  });
  steps(w, 10);
  assert.deepEqual(w.victory, { tick: 3, message: 'Done' });
  assert.equal(w.questSince[0], 3);
});

test('stage effects run with self = the player, even when an NPC effect moved the quest', () => {
  const w = world({
    'q.yaml': `quests:
  - id: q
    title: Q
    stages:
      - { id: a, journal: A, effects: [{ type: set, measurement: hp, value: 3 }] }
systems:
  - { id: rockfall, for: 'not self.has_tag("living")', when: "world.tick == 0", effects: [{ type: quest, quest: q, stage: a }] }
`,
  });
  w.step();
  assert.equal(stageOf(w, 't:q'), 'a');
  assert.equal(w.value(w.player, 't:hp'), 3);
});

// ── Journal ─────────────────────────────────────────────────────────────────

test('journal: entries are added once, in order, with their tick; in_journal sees them', () => {
  const w = world({
    'j.yaml': `journal:
  - { id: a, text: Alpha }
  - { id: b, text: Beta, category: Clues }
vars:
  - { id: seen }
systems:
${at(1, '{ type: journal, entry: b }')}${at(2, '{ type: journal, entry: a }')}${at(3, '{ type: journal, entry: b }')}  - { id: probe, for: 'self.has_tag("living")', effects: [{ type: set_var, var: seen, value: 'in_journal("a")' }] }
`,
  });
  steps(w, 2);
  assert.deepEqual(w.journalEvents, [{ tick: 1, kind: 'entry', entry: 't:b' }]);
  assert.equal(varOf(w, 't:seen'), 0);
  w.step();
  assert.equal(varOf(w, 't:seen'), 1);
  const v = w.journalVersion;
  w.step();
  assert.deepEqual(w.journalEvents, [], 'already there: a no-op');
  assert.equal(w.journalVersion, v);
  assert.deepEqual(w.journal().entries, [
    { entry: 't:b', text: 'Beta', category: 'Clues', tick: 1 },
    { entry: 't:a', text: 'Alpha', category: 'Notes', tick: 2 },
  ]);
  assert.deepEqual(w.snapshot().journal, [
    { entry: 't:b', tick: 1 },
    { entry: 't:a', tick: 2 },
  ]);
});

const ORDERED = `quests:
  - { id: old, title: Old, stages: [{ id: a, journal: Old A }, { id: b, journal: Old B }] }
  - { id: won, title: Won, stages: [{ id: a, journal: Won A, end: success }] }
  - { id: new, title: New, stages: [{ id: a, journal: New A }] }
  - { id: secret, title: Secret, hidden: true, stages: [{ id: a, journal: S A }, { id: b, journal: S B, end: failure }] }
  - { id: covert, title: Covert, hidden: true, stages: [{ id: a, journal: C A }] }
  - { id: never, title: Never, stages: [{ id: a, journal: N A }] }
systems:
${at(0, '{ type: quest, quest: old, stage: a }')}${at(1, '{ type: quest, quest: won, stage: a }')}${at(2, '{ type: quest, quest: new, stage: a }')}${at(3, '{ type: quest, quest: secret, stage: a }, { type: quest, quest: covert, stage: a }')}${at(4, '{ type: quest, quest: old, stage: b }')}${at(5, '{ type: quest, quest: secret, stage: b }')}${at(9, '{ type: quest, quest: never, stage: a }')}`;

test('journal(): active first, then newest change first; hidden quests only once ended', () => {
  const w = world({ 'q.yaml': ORDERED });
  steps(w, 4);
  assert.deepEqual(
    w.journal().quests.map((q) => [q.quest, q.state, q.since]),
    [
      ['t:new', 'active', 2],
      ['t:old', 'active', 0],
      ['t:won', 'success', 1],
    ],
    'hidden quests that have not ended are left out',
  );
  steps(w, 2);
  const h = w.hash();
  const view = w.journal();
  assert.equal(w.hash(), h, 'pure');
  assert.deepEqual(view.quests, [
    { quest: 't:old', title: 'Old', stage: 'b', text: 'Old B', state: 'active', since: 4 },
    { quest: 't:new', title: 'New', stage: 'a', text: 'New A', state: 'active', since: 2 },
    { quest: 't:secret', title: 'Secret', stage: 'b', text: 'S B', state: 'failure', since: 5 },
    { quest: 't:won', title: 'Won', stage: 'a', text: 'Won A', state: 'success', since: 1 },
  ]);
});

test('journalEvents and journalVersion are not state: not saved or hashed', () => {
  const w = world({ 'q.yaml': ORDERED });
  steps(w, 1);
  const a = w.hash();
  const snap = JSON.stringify(w.snapshot());
  w.journalEvents = [];
  w.journalVersion += 10;
  assert.equal(w.hash(), a);
  assert.equal(JSON.stringify(w.snapshot()), snap);
  assert.ok(!snap.includes('journalEvents') && !snap.includes('journalVersion'));
});

test('quests are deterministic and hashed: same seed and packs, same hashes', () => {
  const files = { 'q.yaml': ORDERED };
  const a = world(files);
  const b = world(files);
  const plain = world({});
  for (let i = 0; i < 12; i++) {
    a.step();
    b.step();
    assert.equal(a.hash(), b.hash());
  }
  assert.deepEqual(a.snapshot().quests.map((q) => q.quest), ['t:old', 't:won', 't:new', 't:secret', 't:covert', 't:never']);
  assert.deepEqual(plain.snapshot().quests, []);
  assert.deepEqual(plain.snapshot().vars, {});
});

// ── Saves ───────────────────────────────────────────────────────────────────

const SAVED = `vars:
  - { id: clues, max: 9 }
  - { id: paid, initial: true }
journal:
  - { id: letter, text: A torn letter. }
  - { id: rumour, text: A rumour., category: Rumours }
quests:
  - { id: main, title: Main, stages: [{ id: a, when: "true", journal: A }, { id: b, journal: B }, { id: c, when: 'var("clues") >= 3', journal: C }] }
  - { id: side, title: Side, stages: [{ id: a, when: "world.tick >= 2", journal: A }, { id: done, when: "world.tick >= 4", end: success, journal: Done }] }
  - { id: later, title: Later, stages: [{ id: a, when: 'var("clues") >= 5', journal: A }] }
systems:
  - { id: think, every: 0.3, for: 'self.has_tag("living")', effects: [{ type: add_var, var: clues, delta: 1 }] }
${at(1, '{ type: journal, entry: rumour }')}${at(5, '{ type: journal, entry: letter }, { type: quest, quest: main, stage: b }')}`;

test('save v4: a round trip with set vars, quests at several stages (one ended) and journal entries', () => {
  const w = world({ 'q.yaml': SAVED });
  steps(w, 7);
  const snap = w.snapshot();
  assert.deepEqual(snap.vars, { 't:clues': 2, 't:paid': 1 });
  assert.deepEqual(snap.quests, [
    { quest: 't:main', stage: 'b', since: 5, ended: false },
    { quest: 't:side', stage: 'done', since: 4, ended: true },
  ]);
  assert.deepEqual(snap.journal, [
    { entry: 't:rumour', tick: 1 },
    { entry: 't:letter', tick: 5 },
  ]);
  assert.equal(w.save().version, 7);
  const copy = assertRoundTrip(w, () => {}, 30);
  assert.equal(stageOf(copy, 't:main'), 'c');
  assert.equal(stageOf(copy, 't:later'), 'a');
  assert.deepEqual(copy.journal(), w.journal());
});

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test('save v3: loads with every var at its initial, no quest started and an empty journal; the first tick runs the quest phase', () => {
  const w = world({ 'q.yaml': SAVED });
  steps(w, 7);
  const save = json(w.save()) as unknown as Record<string, unknown> & { state: Record<string, unknown> };
  save['version'] = 3;
  delete save.state['vars'];
  delete save.state['quests'];
  delete save.state['journal'];
  const r = World.restore(w.def, save);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  const old = r.world;
  assert.equal(old.tick, 7);
  assert.deepEqual(old.snapshot().vars, { 't:clues': 0, 't:paid': 1 });
  assert.deepEqual(old.snapshot().quests, []);
  assert.deepEqual(old.snapshot().journal, []);
  old.step();
  assert.equal(stageOf(old, 't:main'), 'a');
  assert.equal(stageOf(old, 't:side'), 'done');
  assert.equal(old.save().version, 7);
});

test('save v4: unknown ids are restore errors with JSON paths and did-you-mean; missing vars warn', () => {
  const w = world({ 'q.yaml': SAVED });
  steps(w, 7);
  const base = json(w.save());
  const restoreWith = (edit: (s: SaveFile) => void) => {
    const s = json(base);
    edit(s);
    return World.restore(w.def, s);
  };
  const errorAt = (edit: (s: SaveFile) => void, path: string, re: RegExp) => {
    const r = restoreWith(edit);
    assert.equal(r.ok, false, `expected an error at ${path}`);
    if (r.ok) return;
    assert.ok(
      r.errors.some((e) => e.startsWith(`${path}: `) && re.test(e)),
      `expected ${path}: ${re}, got:\n${r.errors.join('\n')}`,
    );
  };
  errorAt((s) => (s.state.vars = { 't:clus': 1, 't:paid': 1 }), 'state.vars["t:clus"]', /unknown var 't:clus' \(did you mean 't:clues'\?\)/);
  errorAt((s) => (s.state.vars['t:clues'] = 'x' as unknown as number), 'state.vars["t:clues"]', /expected a finite number/);
  errorAt((s) => (s.state.quests[0]!.quest = 't:mian'), 'state.quests[0].quest', /unknown quest 't:mian' \(did you mean 't:main'\?\)/);
  errorAt((s) => (s.state.quests[0]!.stage = 'bb'), 'state.quests[0].stage', /quest 't:main' has no stage 'bb' \(did you mean 'b'\?\)/);
  errorAt((s) => s.state.quests.push(json(s.state.quests[0]!)), 'state.quests[2].quest', /listed twice/);
  errorAt((s) => (s.state.quests[1]!.since = -1), 'state.quests[1].since', /must be ≥ 0/);
  errorAt((s) => (s.state.journal[0]!.entry = 't:rumor'), 'state.journal[0].entry', /unknown journal entry 't:rumor' \(did you mean 't:rumour'\?\)/);
  errorAt((s) => delete (s.state as Partial<SaveFile['state']>).quests, 'state.quests', /expected an array/);
  const r = restoreWith((s) => delete s.state.vars['t:paid']);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.ok(r.warnings.includes(`state.vars: var 't:paid' is missing; it starts at 1`), r.warnings.join('\n'));
  assert.equal(varOf(r.world, 't:paid'), 1);
});

// ── Overrides ───────────────────────────────────────────────────────────────

/** `t` (the fixture) with the story; `mod` patches it. */
function withMod(modFiles: Record<string, string>): ReturnType<typeof loadPacks> {
  const mod: PackSource = { label: 'mod', files: { 'pack.yaml': 'namespace: mod\nname: Mod\nversion: 1.0.0\nkind: mod\ndepends: [t]\n', ...modFiles } };
  return loadPacks([fixture({ 'q.yaml': `${STORY}systems:\n  - { id: s, when: 'var("clues") > 0', effects: [{ type: journal, entry: letter }] }\n` }), mod]);
}

test('overrides: vars, quests and journal take override and remove; a quest override replaces its stages', () => {
  const r = withMod({
    'm.yaml': `vars:
  - { id: t:clues, override: true, max: 10 }
journal:
  - { id: t:letter, override: true, text: A sealed letter. }
quests:
  - id: t:hunt
    override: true
    stages:
      - { id: begin, when: "true", journal: Go. }
`,
  });
  if (!r.ok) assert.fail(r.errors.map(formatError).join('\n'));
  const def = r.definition;
  assert.equal(def.vars[0]!.max, 10);
  assert.equal(def.journal[0]!.text, 'A sealed letter.');
  assert.deepEqual(
    def.quests[0]!.stages.map((s) => s.name),
    ['begin'],
  );
  assert.deepEqual(formatOverrides(def).slice(-3).map((l) => l.trim().split(/\s+/).join(' ')), [
    'mod override var t:clues [max]',
    'mod override quest t:hunt [stages]',
    'mod override journal entry t:letter [text]',
  ]);
  const removed = withMod({ 'm.yaml': 'quests:\n  - { id: t:hunt, remove: true }\n' });
  assert.ok(removed.ok);
  assert.deepEqual(removed.ok ? removed.definition.quests : null, []);
});

test('overrides: removing a var or journal entry that is still referenced names the remover', () => {
  const r = withMod({ 'm.yaml': 'vars:\n  - { id: t:clues, remove: true }\njournal:\n  - { id: t:letter, remove: true }\n' });
  assert.equal(r.ok, false);
  const errors = r.ok ? [] : r.errors;
  expectError(errors, 'q.yaml', 'systems[0].when', /unknown var 't:clues' \(removed by pack 'mod'\)/);
  expectError(errors, 'q.yaml', 'systems[0].effects[0].entry', /unknown journal entry 't:letter' \(removed by pack 'mod'\)/);
  const q = loadPacks([
    fixture({ 'q.yaml': `${QUEST}systems:\n  - { id: s, when: 'quest_active("hunt")', effects: [{ type: quest, quest: hunt, stage: done }] }\n` }),
    { label: 'mod', files: { 'pack.yaml': 'namespace: mod\nname: Mod\nversion: 1.0.0\ndepends: [t]\n', 'm.yaml': 'quests:\n  - { id: t:hunt, remove: true }\n' } },
  ]);
  assert.equal(q.ok, false);
  expectError(q.ok ? [] : q.errors, 'q.yaml', 'systems[0].when', /unknown quest 't:hunt' \(removed by pack 'mod'\)/);
  expectError(q.ok ? [] : q.errors, 'q.yaml', 'systems[0].effects[0].quest', /unknown quest 't:hunt' \(removed by pack 'mod'\)/);
});

// ── UI models ───────────────────────────────────────────────────────────────

const UI = `journal:
  - { id: tip, text: Drink water. }
  - { id: clue1, text: A muddy boot print., category: Clues }
  - { id: clue2, text: "A long, rambling note that goes on and on about the weather, the harvest, the neighbours and finally, at the very end, the culprit.", category: Clues }
quests:
  - { id: main, title: The case, stages: [{ id: a, when: "true", journal: Find the culprit. }, { id: b, journal: Name the culprit., end: success }] }
  - { id: side, title: Errand, stages: [{ id: a, journal: Fetch a pail. }, { id: lost, journal: The pail is gone., end: failure }] }
  - { id: sneaky, title: Sneaky, hidden: true, stages: [{ id: a, journal: Hush. }, { id: b, journal: Revealed., end: success }] }
systems:
${at(1, '{ type: journal, entry: clue1 }, { type: journal, entry: tip }, { type: journal, entry: clue2 }')}${at(2, '{ type: quest, quest: sneaky, stage: a }')}${at(3, '{ type: quest, quest: side, stage: lost }')}${at(4, '{ type: quest, quest: sneaky, stage: b }')}`;

test('journal panel view: Active, Done (✓/✗), then categories in order of first use', () => {
  const w = world({ 'q.yaml': UI });
  assert.deepEqual(journalView(w), { sections: [], standingTitle: 'Standing', standing: [], empty: 'Nothing yet.' });
  steps(w, 5);
  assert.deepEqual(journalView(w), {
    sections: [
      { title: 'Active', rows: ['The case: Find the culprit.'] },
      { title: 'Done', rows: ['✓ Sneaky: Revealed.', '✗ Errand: The pail is gone.'] },
      { title: 'Clues', rows: ['A muddy boot print.', w.def.journal[2]!.text] },
      { title: 'Notes', rows: ['Drink water.'] },
    ],
    standingTitle: 'Standing',
    standing: [],
    empty: null,
  });
  assert.deepEqual(journalLines(w.journal()).slice(0, 6), ['Journal', '', 'Active', '  The case: Find the culprit.', '', 'Done']);
});

test('journal toast: last event, (+N) for more, one line cut with …; a hidden quest stays secret until it ends', () => {
  const w = world({ 'q.yaml': UI });
  w.step();
  assert.equal(journalToast(w.journalEvents, w), 'Journal: The case: Find the culprit.');
  w.step();
  const toast = journalToast(w.journalEvents, w)!;
  assert.ok(toast.endsWith('… (+2)'), toast);
  assert.ok(toast.startsWith('Journal: A long, rambling note'), toast);
  assert.ok([...toast].length <= 80, toast);
  w.step();
  assert.equal(w.journalEvents.length, 1, 'the hidden quest started');
  assert.equal(journalToast(w.journalEvents, w), null);
  w.step();
  assert.equal(journalToast(w.journalEvents, w), 'Journal: Errand: The pail is gone.');
  w.step();
  assert.equal(journalToast(w.journalEvents, w), 'Journal: Sneaky: Revealed.');
  assert.equal(journalToast([], w), null);
  assert.equal(journalToast([{ tick: 0, kind: 'entry', entry: 't:tip' }], w), 'Journal: Drink water.');
});

test('terminal: J shows the journal until any key (j still moves); events go to the message line', () => {
  const w = world({ 'q.yaml': UI });
  w.step();
  assert.equal(journalMessage(w), 'Journal: The case: Find the culprit.');
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'J', keys);
  assert.deepEqual(keys.journal, ['Journal', '', 'Active', '  The case: Find the culprit.']);
  assert.equal(w.player.intent, null);
  handleKey(w, 'x', keys);
  assert.equal(keys.journal, null);
  assert.equal(keys.actions ?? null, null, 'the closing key does nothing else');
  handleKey(w, 'j', keys);
  assert.deepEqual(w.player.intent, { kind: 'step', dx: 0, dy: 1 });
  w.step();
  assert.match(journalMessage(w)!, /^Journal: A long, rambling note.*… \(\+2\)$/);
  w.step();
  assert.equal(journalMessage(w), null, 'a hidden quest started');
});

// ── Scenarios ───────────────────────────────────────────────────────────────

const shipped = new Map<string, Definition>();
function game(name: keyof typeof GAMES): Definition {
  if (!shipped.has(name)) shipped.set(name, loadPacksOrThrow(GAMES[name].map((d) => readPack(d))));
  return shipped.get(name)!;
}

test('scenario (zombie): the escape quest from start to success, won on the same tick; the survival tip', () => {
  const def = game('zombie');
  assert.equal(def.start.victory!.message, 'You got the car running!');
  const w = World.create(def, 1);
  w.step();
  assert.equal(stageOf(w, 'zmb:escape'), 'find_battery');
  assert.equal(journalToast(w.journalEvents, w), 'Journal: Get out of town: The wrecks on the road might run with a fresh battery.');
  // A battery in hand.
  const battery = def.ids.items['town:car_battery']!;
  add(w.player.inv!, battery, 1, def.items[battery]!.weight);
  w.step();
  assert.equal(stageOf(w, 'zmb:escape'), 'battery');
  assert.equal(w.victory, null);
  // A garage on the player's floor.
  const garage = def.roomTags.indexOf('garage');
  const { grid } = w;
  let cell: [number, number] | null = null;
  for (let y = 0; y < grid.height && !cell; y++) {
    for (let x = 0; x < grid.width && !cell; x++) {
      if (grid.walkable(x, y, 0) && w.roomTagsAt(x, y, 0).includes(garage)) cell = [x, y];
    }
  }
  assert.ok(cell, 'the town has a garage');
  [w.player.x, w.player.y] = cell;
  w.player.z = 0;
  w.step();
  assert.equal(stageOf(w, 'zmb:escape'), 'escaped');
  assert.deepEqual(w.journal().quests.map((q) => [q.title, q.state]), [['Get out of town', 'success']]);
  const won = w.victory as { tick: number; message: string } | null;
  assert.deepEqual(won, { tick: w.tick - 1, message: 'You got the car running!' });
  assert.equal(w.questSince[def.ids.quests['zmb:escape']!], won.tick);

  // The tip: the first time the survivor is hungry (or burdened).
  const t = World.create(def, 1);
  t.player.m[def.ids.measurements['std_needs:hunger']!] = 80;
  steps(t, 25);
  assert.deepEqual(t.journal().entries.map((e) => [e.entry, e.category]), [['zmb:travel_light', 'Notes']]);
});

test('scenario (vampire): the first dawn succeeds resting in the crypt and, in a second run, fails in the sun', () => {
  const def = game('vampire');
  assert.equal(def.start.victory, null, 'still open-ended');
  const tps = def.ticksPerSecond;
  let dawn = 0;
  while (!(dayAt(def.clock, dawn, tps) >= 2 && isDayAt(def.clock, dawn, tps))) dawn++;
  const w = World.create(def, 3);
  w.step();
  assert.equal(stageOf(w, 'vamp:first_dawn'), 'night');
  steps(w, dawn - 40 - w.tick);
  const before = World.restore(def, json(w.save()));
  if (!before.ok) assert.fail(before.errors.join('\n'));

  // Run 1: to the crypt, and rest through the dawn.
  const tagged = (world: World, tag: string): [number, number, number] => {
    const g = world.grid;
    for (let z = 0; z < g.floors; z++) {
      for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width; x++) {
          if (g.walkable(x, y, z) && g.tileAt(x, y, z)!.tags.includes(tag)) return [x, y, z];
        }
      }
    }
    throw new Error(`no '${tag}' tile`);
  };
  [w.player.x, w.player.y, w.player.z] = tagged(w, 'crypt');
  w.queueAction({ kind: 'act', action: 'vamp:rest' });
  while (w.tick <= dawn) w.step();
  assert.equal(stageOf(w, 'vamp:first_dawn'), 'survived');
  assert.equal(w.questEnd[0], 1);
  assert.equal(w.questSince[0], dawn);
  assert.equal(w.victory, null);
  assert.equal(w.defeat, null);

  // Run 2: caught in a sunbeam, badly hurt, as the sun rises.
  const v = before.world;
  [v.player.x, v.player.y, v.player.z] = tagged(v, 'sunlit');
  v.player.m[def.ids.measurements['std:hp']!] = 20;
  while (v.tick <= dawn) v.step();
  assert.equal(stageOf(v, 'vamp:first_dawn'), 'scorched');
  assert.deepEqual(v.journal().quests.map((q) => [q.title, q.state]), [['The first dawn', 'failure']]);
  assert.equal(v.questSince[0], dawn);
});

test('mixed stacks: zombie + vampire still load; the town defines no quests', () => {
  const town = game('town');
  assert.deepEqual([town.quests.length, town.vars.length, town.journal.length], [0, 0, 0]);
  const both = loadPacks(['packs/std', 'packs/std-needs', 'packs/town', 'packs/zombie', 'packs/vampire'].map((d) => readPack(d)));
  assert.ok(both.ok);
  assert.deepEqual(both.ok ? both.definition.quests.map((q) => q.id) : null, ['zmb:escape', 'vamp:first_dawn']);
});
