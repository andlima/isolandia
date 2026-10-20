import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helpLines, TERMINAL_BINDINGS } from '../src/ascii/bindings.ts';
import { handleKey, KEYMAP, type KeyState } from '../src/ascii/terminal.ts';
import { formatError, hudLineLevels, hudLines, hudModel, loadPacks, loadPacksOrThrow, SAVE_VERSION, stepProgress, World, type LoadError, type PackSource, type SaveFile } from '../src/core/index.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { BINDINGS } from '../src/web/bindings.ts';
import { GAIT_CHIP_ID, hudView } from '../src/web/hud.ts';
import { INPUT_BINDINGS } from '../src/web/input.ts';
import { GaitKeys, RUN_KEYS } from '../src/web/keys.ts';
import { readPack } from '../src/node/read-pack.ts';
import { assertRoundTrip, fixture, loadFixture } from './helpers.ts';

// Gaits (task `gaits`): archetype `gaits` (run and sneak), the gait as entity
// state, footstep noise, `self.gait`, save version 9, and the shell controls.

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// A 15×3 corridor: the hero at (1, 1), an ear at (7, 1) (6 tiles from the
// hero's first landing at (2, 1) is 5) and a far ear at (13, 1).

const ROWS = ['###############', '#@.....e.....f#', '###############'];

interface Opts {
  /** The hero's `gaits` block (YAML lines under `gaits:`), or '' for none. */
  gaits?: string;
  /** Extra `ticks_per_step` etc. on the hero. */
  hero?: string;
  /** Extra files. */
  extra?: Record<string, string>;
}

const RUN_SNEAK = `      run: { ticks_per_step: 1, noise: 6, label: Running }
      sneak: { ticks_per_step: 4, label: Sneaking }
`;

function files(o: Opts = {}): Record<string, string> {
  const gaits = o.gaits === '' ? '' : `    gaits:\n${o.gaits ?? RUN_SNEAK}`;
  return {
    'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [hp, food]
    ticks_per_turn: 0
${o.hero ?? ''}${gaits}  - { id: ear, label: Ear, glyph: e, color: gray, ticks_per_turn: 0 }
`,
    'map.yaml': `maps:
  - id: hall
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "e": { tile: floor, spawn: ear }
      "f": { tile: floor, spawn: ear }
    rows: ${JSON.stringify(ROWS)}
start:
  map: hall
  player: hero
`,
    ...o.extra,
  };
}

const world = (o: Opts = {}, seed = 1): World => World.create(loadFixture(files(o)), seed);

function errorsOf(o: Opts): readonly LoadError[] {
  const r = loadPacks([fixture(files(o))]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
  assert.equal(hit.file, 'archetypes.yaml');
}

/** A mod pack `m` over the fixture with one content file. */
function mod(yaml: string): PackSource {
  return { label: 'm', files: { 'pack.yaml': 'namespace: m\nname: M\nversion: 1.0.0\nkind: mod\ndepends: [t]\n', 'mod.yaml': yaml } };
}

const gaitOf = (w: World) => w.player.archetype.gaits[w.player.gait]!.name;
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const step = (w: World) => w.queueIntent({ kind: 'step', dx: 1, dy: 0 });

// ── Loader ──────────────────────────────────────────────────────────────────

test('gaits: walk is implicit at index 0 with the archetype ticks; declared gaits follow in order with defaulted noise and label', () => {
  const def = loadFixture(files({ gaits: `      run: { ticks_per_step: 1, noise: 6, label: Running }\n      sneak: { ticks_per_step: 4 }\n` }));
  const hero = def.archetypes[def.ids.archetypes['t:hero']!]!;
  assert.equal(hero.ticksPerStep, 2, 'the walk value for every existing caller');
  assert.deepEqual(hero.gaits, [
    { name: 'walk', ticksPerStep: 2, noise: 0, label: 'Walking' },
    { name: 'run', ticksPerStep: 1, noise: 6, label: 'Running' },
    { name: 'sneak', ticksPerStep: 4, noise: 0, label: 'Sneak' },
  ]);
  // Without `gaits`: only walk.
  const ear = def.archetypes[def.ids.archetypes['t:ear']!]!;
  assert.deepEqual(ear.gaits, [{ name: 'walk', ticksPerStep: 2, noise: 0, label: 'Walking' }]);
  // The archetype's ticks_per_step is the walk gait's.
  const fast = loadFixture(files({ hero: '    ticks_per_step: 1\n', gaits: `      sneak: { ticks_per_step: 2 }\n` }));
  assert.deepEqual(
    fast.archetypes[fast.ids.archetypes['t:hero']!]!.gaits.map((g) => [g.name, g.ticksPerStep]),
    [
      ['walk', 1],
      ['sneak', 2],
    ],
  );
});

test('gaits: walk may be restated to change its noise or label, not its ticks', () => {
  const def = loadFixture(files({ gaits: `      walk: { noise: 2, label: Strolling }\n      run: { ticks_per_step: 1 }\n` }));
  const hero = def.archetypes[def.ids.archetypes['t:hero']!]!;
  assert.deepEqual(hero.gaits, [
    { name: 'walk', ticksPerStep: 2, noise: 2, label: 'Strolling' },
    { name: 'run', ticksPerStep: 1, noise: 0, label: 'Run' },
  ]);
  expectError(errorsOf({ gaits: `      walk: { ticks_per_step: 3 }\n` }), 'archetypes[0].gaits.walk.ticks_per_step', /set the archetype's 'ticks_per_step'/);
});

test('gaits: load errors with file, path and message for each rule', () => {
  expectError(errorsOf({ gaits: `      Run: { ticks_per_step: 1 }\n` }), 'archetypes[0].gaits.Run', /invalid gait name 'Run': gait names must match \[a-z\]\[a-z0-9_\]\*/);
  expectError(errorsOf({ gaits: `      run: { noise: 6 }\n` }), 'archetypes[0].gaits.run', /missing required field 'ticks_per_step'/);
  expectError(errorsOf({ gaits: `      run: { ticks_per_step: 0 }\n` }), 'archetypes[0].gaits.run.ticks_per_step', /must be a positive integer, got 0/);
  expectError(errorsOf({ gaits: `      run: { ticks_per_step: 1.5 }\n` }), 'archetypes[0].gaits.run.ticks_per_step', /must be a positive integer, got 1.5/);
  expectError(errorsOf({ gaits: `      run: { ticks_per_step: two }\n` }), 'archetypes[0].gaits.run.ticks_per_step', /must be a number, got string/);
  expectError(errorsOf({ gaits: `      run: { ticks_per_step: 1, noise: -1 }\n` }), 'archetypes[0].gaits.run.noise', /must be a number ≥ 0, got -1/);
  expectError(errorsOf({ gaits: `      run: { ticks_per_step: 1, nois: 3 }\n` }), 'archetypes[0].gaits.run.nois', /unknown gait field 'nois' \(did you mean 'noise'\?\)/);
  expectError(errorsOf({ gaits: `      run: { ticks_per_step: 1, label: 3 }\n` }), 'archetypes[0].gaits.run.label', /must be a string/);
  expectError(errorsOf({ gaits: `      run: 3\n` }), 'archetypes[0].gaits.run', /gait 'run' must be a mapping, got number/);
  expectError(errorsOf({ gaits: '', hero: '    gaits: [run]\n' }), 'archetypes[0].gaits', /field 'gaits' must be a mapping, got list/);
  // The archetype's own ticks_per_step is still checked on its own.
  expectError(errorsOf({ hero: '    ticks_per_step: 0\n' }), 'archetypes[0].ticks_per_step', /must be a positive integer/);
});

test('gaits: an ordinary top-level field for overrides (replaced whole; null leaves only walk; check --overrides lists it)', () => {
  const base = fixture(files());
  const replaced = loadPacksOrThrow([base, mod(`archetypes:\n  - { id: t:hero, override: true, gaits: { creep: { ticks_per_step: 6, label: Creeping } } }\n`)]);
  assert.deepEqual(
    replaced.archetypes[replaced.ids.archetypes['t:hero']!]!.gaits.map((g) => g.name),
    ['walk', 'creep'],
  );
  const cleared = loadPacksOrThrow([base, mod(`archetypes:\n  - { id: t:hero, override: true, gaits: null }\n`)]);
  assert.deepEqual(
    cleared.archetypes[cleared.ids.archetypes['t:hero']!]!.gaits.map((g) => g.name),
    ['walk'],
  );
  const patch = cleared.patches.find((p) => p.domain === 'archetypes' && p.id === 't:hero');
  assert.deepEqual(patch?.fields, ['gaits'], 'the override lists gaits like any other field');
  assert.ok(formatOverrides(cleared).some((l) => /override\s+archetype\s+t:hero\s+\[gaits\]/.test(l)), formatOverrides(cleared).join('\n'));
  // An error inside an overriding gaits block points at the mod.
  const r = loadPacks([base, mod(`archetypes:\n  - { id: t:hero, override: true, gaits: { run: { ticks_per_step: 1, noize: 2 } } }\n`)]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    const e = r.errors.find((x) => x.path === 'archetypes[0].gaits.run.noize');
    assert.ok(e, r.errors.map(formatError).join('\n'));
    assert.equal(e.pack, 'm');
  }
});

// ── Simulation ──────────────────────────────────────────────────────────────

test('gaits: every entity starts walking with stepTicks = the walk ticks; setGait returns false for an unknown gait and changes nothing', () => {
  const w = world();
  for (const e of w.entities) {
    assert.equal(e.gait, 0);
    assert.equal(e.stepTicks, e.archetype.ticksPerStep);
  }
  const h = w.hash();
  assert.equal(w.setGait('fly'), false);
  assert.equal(w.player.gait, 0);
  assert.equal(w.hash(), h);
  // An archetype without `run` (the vampire's case).
  const slow = world({ gaits: `      sneak: { ticks_per_step: 4 }\n` });
  assert.equal(slow.setGait('run'), false);
  assert.equal(slow.setGait('sneak'), true);
  assert.equal(gaitOf(slow), 'sneak');
  assert.equal(slow.setGait('walk'), true);
  assert.equal(gaitOf(slow), 'walk');
});

test('gaits: a run step takes 1 tick and emits the footstep noise at the landing cell, heard in range and never by the runner', () => {
  const w = world();
  const [near, far] = w.entities.filter((e) => e.archetype.id === 't:ear');
  assert.ok(near && far);
  assert.equal(w.setGait('run'), true);
  assert.equal(gaitOf(w), 'run');
  step(w);
  w.step();
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
  assert.equal(w.player.moveCooldown, 1);
  assert.equal(w.player.stepTicks, 1);
  assert.deepEqual(w.noises, [{ x: 2, y: 1, z: 0, radius: 6, source: w.player.id }]);
  assert.equal(near.heardTick, 0, 'heard in the same tick');
  assert.deepEqual([near.heardX, near.heardY], [2, 1]);
  assert.equal(far.heardTick, -1, 'out of range');
  assert.equal(w.player.heardTick, -1, 'a noise never reaches its own source');
  // Held key: one tile per tick.
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) {
    step(w);
    w.step();
    xs.push(w.player.x);
  }
  assert.deepEqual(xs, [3, 4, 5]);
  assert.equal(w.noises.length, 1);
  // A blocked step makes no noise; standing still makes none.
  w.queueIntent({ kind: 'step', dx: 0, dy: -1 });
  w.step();
  assert.deepEqual(w.noises, []);
  w.step();
  assert.deepEqual(w.noises, []);
});

test('gaits: a sneak step takes 4 ticks and is silent; walking again is 2', () => {
  const w = world();
  assert.equal(w.setGait('sneak'), true);
  const xs: number[] = [];
  for (let i = 0; i < 8; i++) {
    step(w);
    w.step();
    xs.push(w.player.x);
    assert.deepEqual(w.noises, []);
  }
  assert.deepEqual(xs, [2, 2, 2, 2, 3, 3, 3, 3]);
  assert.equal(w.player.stepTicks, 4);
  assert.equal(w.setGait('walk'), true);
  const ys: number[] = [];
  for (let i = 0; i < 8; i++) {
    step(w);
    w.step();
    ys.push(w.player.x);
  }
  // The sneak step's cooldown has already run down, so walk steps come every 2 ticks from here.
  assert.deepEqual(ys, [4, 4, 5, 5, 6, 6, 7, 7]);
  assert.equal(w.player.stepTicks, 2);
});

test('gaits: setGait mid-step leaves stepProgress continuous; the next step uses the new ticks', () => {
  const w = world();
  step(w);
  w.step();
  const p = w.player;
  assert.equal(p.stepTicks, 2);
  assert.equal(w.tick, 1);
  const before = [0, 0.25, 0.5, 0.75].map((a) => stepProgress(p, w.tick, a));
  assert.deepEqual(before, [0, 0.125, 0.25, 0.375]);
  assert.equal(w.setGait('run'), true);
  assert.deepEqual(
    [0, 0.25, 0.5, 0.75].map((a) => stepProgress(p, w.tick, a)),
    before,
    'the step in flight keeps its duration',
  );
  assert.equal(p.stepTicks, 2);
  assert.equal(p.moveCooldown, 2, 'the cooldown of the step in flight is untouched');
  step(w);
  w.step();
  assert.equal(p.x, 2, 'still the first step');
  step(w);
  w.step();
  assert.equal(p.x, 3);
  assert.equal(p.stepTicks, 1);
  assert.equal(p.moveCooldown, 1);
  assert.equal(stepProgress(p, w.tick, 0.5), 0.5);
});

test('gaits: setGait is not an intent: a pending step, a goto path and an activity survive it', () => {
  const w = world();
  step(w);
  assert.equal(w.setGait('run'), true);
  assert.deepEqual(w.player.intent, { kind: 'step', dx: 1, dy: 0 });
  w.step();
  assert.equal(w.player.x, 2);
  w.queueIntent({ kind: 'goto', x: 8, y: 1, z: 0 });
  w.step();
  assert.ok(w.player.path);
  assert.equal(w.setGait('walk'), true);
  assert.ok(w.player.path, 'the path is untouched');
  assert.equal(w.pathGoal(w.player)?.x, 8);
});

test('gaits: a goto path switches pace between steps when the gait changes', () => {
  const w = world();
  w.queueIntent({ kind: 'goto', x: 12, y: 1, z: 0 });
  const xs: number[] = [];
  for (let i = 0; i < 4; i++) {
    w.step();
    xs.push(w.player.x);
  }
  assert.deepEqual(xs, [2, 2, 3, 3], 'walking: a tile every 2 ticks');
  assert.equal(w.setGait('run'), true);
  for (let i = 0; i < 4; i++) {
    w.step();
    xs.push(w.player.x);
  }
  assert.deepEqual(xs.slice(4), [4, 5, 6, 7], 'running: a tile per tick, the path kept');
  assert.equal(w.noises.length, 1, 'each landing makes the footstep noise');
  assert.equal(w.setGait('sneak'), true);
  for (let i = 0; i < 8; i++) {
    w.step();
    xs.push(w.player.x);
  }
  assert.deepEqual(xs.slice(8), [8, 8, 8, 8, 9, 9, 9, 9], 'sneaking: a tile every 4 ticks');
  assert.deepEqual(w.noises, []);
});

test('gaits: self.gait is the gait name (a string) and a system when fires only while running; player.gait and npc.gait compile too', () => {
  const w = world({
    extra: {
      'rules.yaml': `systems:
  - id: tire
    every: 0.1
    for: 'self.has_tag("living")'
    when: 'self.gait == "run"'
    effects: [{ apply: { hp: -1 } }]
statuses:
  - { id: sneaky, label: Sneaky, for: 'self.has_tag("living")', when: 'player.gait == "sneak" and self.gait != "walk"' }
dialogues:
  - id: chat
    start: hi
    nodes:
      hi:
        text: Hm?
        choices:
          - { text: Shh, when: 'npc.gait == "walk"', to: end }
`,
    },
  });
  const hp = w.def.ids.measurements['t:hp']!;
  const sneaky = w.def.ids.statuses['t:sneaky']!;
  w.step();
  w.step();
  assert.equal(w.player.m[hp], 10, 'walking: nothing');
  assert.equal(w.setGait('run'), true);
  w.step();
  assert.equal(w.player.m[hp], 9, 'running (even standing still): the system fires');
  w.step();
  assert.equal(w.player.m[hp], 8);
  assert.equal(w.player.st[sneaky], 0);
  assert.equal(w.setGait('sneak'), true);
  w.step();
  assert.equal(w.player.m[hp], 8, 'sneaking: not running');
  assert.equal(w.player.st[sneaky], 1);
  assert.equal(w.setGait('walk'), true);
  w.step();
  assert.equal(w.player.st[sneaky], 0);
  // `gait` shadows a measurement of the same short name, like `sees`: the field reads the gait name, not the measurement
  // (which this hero lacks, so its qualified id reads 0).
  const shadow = World.create(
    loadFixture({
      ...files(),
      'measurements.yaml': `measurements:\n  - { id: hp, label: HP, max: 10, initial: 10 }\n  - { id: food, label: Food, max: 100, initial: 50 }\n  - { id: gait, label: Gait, max: 10, initial: 3 }\n`,
      'rules.yaml': `statuses:\n  - { id: s, label: S, when: 'self.gait == "walk" and self.t:gait == 0' }\n`,
    }),
    1,
  );
  shadow.step();
  assert.equal(shadow.player.st[shadow.def.ids.statuses['t:s']!], 1);
});

test('gaits: hash() changes when the gait changes; NPCs never change gait', () => {
  const w = world();
  const h = w.hash();
  assert.equal(w.setGait('sneak'), true);
  assert.notEqual(w.hash(), h);
  assert.equal(w.setGait('walk'), true);
  assert.equal(w.hash(), h);
  for (let i = 0; i < 50; i++) w.step();
  assert.ok(w.entities.filter((e) => e !== w.player).every((e) => e.gait === 0));
});

// ── Saves ───────────────────────────────────────────────────────────────────

test('gaits: snapshots write gait only when not walk and stepTicks always; the round trip holds with a gait set mid-step', () => {
  const w = world();
  step(w);
  w.step();
  assert.equal(w.setGait('run'), true);
  const s = w.save();
  assert.equal(s.version, 9);
  assert.equal(SAVE_VERSION, 9);
  const me = s.state.entities[w.player.id]!;
  assert.equal(me.gait, 'run');
  assert.equal(me.stepTicks, 2, 'the walk step in flight');
  const ear = s.state.entities.find((e) => e.archetype === 't:ear')!;
  assert.equal('gait' in ear, false, 'omitted when walk');
  assert.equal(ear.stepTicks, 2);
  // Mid-step with the new gait pending: every later tick hashes alike on both sides.
  let n = 0;
  const copy = assertRoundTrip(
    w,
    (x) => {
      step(x);
      if (x.tick === 6) assert.equal(x.setGait('sneak'), true);
      if (x.tick === 12) assert.equal(x.setGait('walk'), true);
      n++;
    },
    20,
  );
  assert.ok(n > 0);
  assert.equal(copy.player.gait, w.player.gait);
  assert.equal(copy.player.stepTicks, w.player.stepTicks);
  assert.equal(copy.player.x, w.player.x);
});

test('gaits: a version 8 save loads with every entity walking and stepTicks = the walk ticks, without warnings', () => {
  const w = world();
  step(w);
  w.step();
  assert.equal(w.setGait('sneak'), true);
  step(w);
  w.step();
  const old = viaJson(w.save()) as unknown as { version: number; state: { entities: Record<string, unknown>[] } };
  old.version = 8;
  for (const e of old.state.entities) {
    delete e['gait'];
    delete e['stepTicks'];
  }
  const r = World.restore(w.def, old);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.world.player.gait, 0);
  for (const e of r.world.entities) assert.equal(e.stepTicks, e.archetype.ticksPerStep);
  assert.equal(r.world.save().version, 9);
  // A version 8 save that (wrongly) carries them ignores them.
  const stale = viaJson(w.save()) as unknown as { version: number };
  stale.version = 8;
  const r2 = World.restore(w.def, stale);
  assert.ok(r2.ok && r2.world.player.gait === 0 && r2.world.player.stepTicks === 2);
});

test('gaits: a version 9 gait the archetype lacks, or a bad stepTicks, is a restore error with the path', () => {
  const w = world();
  const tweak = (f: (s: SaveFile) => void): string[] => {
    const s = viaJson(w.save());
    f(s);
    const r = World.restore(w.def, s);
    assert.equal(r.ok, false, 'expected a restore error');
    return r.ok ? [] : r.errors;
  };
  const me = w.player.id;
  assert.deepEqual(tweak((s) => (s.state.entities[me]!.gait = 'fly')), [`state.entities[${me}].gait: archetype 't:hero' has no gait 'fly' (its gaits: walk, run, sneak)`]);
  const ear = w.entities.find((e) => e.archetype.id === 't:ear')!.id;
  assert.deepEqual(tweak((s) => (s.state.entities[ear]!.gait = 'run')), [`state.entities[${ear}].gait: archetype 't:ear' has no gait 'run' (its gaits: walk)`]);
  assert.deepEqual(tweak((s) => (s.state.entities[me]!.stepTicks = 0)), [`state.entities[${me}].stepTicks: 0 must be ≥ 1`]);
  assert.deepEqual(tweak((s) => (s.state.entities[me]!.stepTicks = 1.5)), [`state.entities[${me}].stepTicks: expected an integer, got 1.5`]);
  assert.deepEqual(tweak((s) => delete (s.state.entities[me]! as { stepTicks?: number }).stepTicks), [`state.entities[${me}].stepTicks: expected an integer, got nothing`]);
  assert.match(tweak((s) => ((s.state.entities[me]! as { gait: unknown }).gait = 3))[0]!, new RegExp(`^state\\.entities\\[${me}\\]\\.gait: expected a string`));
  // `walk` written explicitly is accepted.
  const s = viaJson(w.save());
  s.state.entities[me]!.gait = 'walk';
  const r = World.restore(w.def, s);
  assert.ok(r.ok && r.world.player.gait === 0);
});

// ── Shells ──────────────────────────────────────────────────────────────────

test('gaits: GaitKeys wants run while Shift is held, sneak while toggled, walk otherwise; clear drops Shift but keeps the toggle', () => {
  const k = new GaitKeys();
  assert.equal(k.want(), 'walk');
  k.down();
  assert.equal(k.want(), 'run');
  k.toggleSneak();
  assert.equal(k.want(), 'run', 'Shift wins while held');
  assert.equal(k.sneaking, true);
  k.up();
  assert.equal(k.want(), 'sneak', 'release returns to sneak when toggled');
  k.toggleSneak();
  assert.equal(k.want(), 'walk');
  k.toggleSneak();
  k.down();
  k.clear();
  assert.equal(k.want(), 'sneak', 'blur or pause forget the held Shift, not the toggle');
  k.up();
  assert.equal(k.want(), 'sneak');
  k.toggleSneak();
  assert.equal(k.want(), 'walk');
});

test('gaits: the browser bindings have run (Shift, hold) and sneak (Z) under Moving, handled by Input', () => {
  const by = (id: string) => BINDINGS.find((b) => b.id === id)!;
  assert.deepEqual(by('run'), { id: 'run', keys: ['Shift'], label: 'Run (hold)', section: 'Moving', codes: ['ShiftLeft', 'ShiftRight'] });
  assert.deepEqual(by('sneak'), { id: 'sneak', keys: ['Z'], label: 'Sneak (toggle)', section: 'Moving', codes: ['KeyZ'] });
  assert.deepEqual([...RUN_KEYS], ['ShiftLeft', 'ShiftRight']);
  assert.ok(INPUT_BINDINGS.has('run') && INPUT_BINDINGS.has('sneak'));
});

test('gaits: the terminal toggles run with r and sneak with z, says why when the archetype lacks one, and lists both under Moving', () => {
  const w = world();
  const state: KeyState = { dropPending: false };
  assert.equal(KEYMAP['r'], undefined);
  assert.equal(KEYMAP['z'], undefined);
  handleKey(w, 'r', state);
  assert.equal(gaitOf(w), 'run');
  assert.equal(state.message, null);
  handleKey(w, 'r', state);
  assert.equal(gaitOf(w), 'walk', 'the active one goes back to walk');
  handleKey(w, 'z', state);
  assert.equal(gaitOf(w), 'sneak');
  handleKey(w, 'r', state);
  assert.equal(gaitOf(w), 'run', 'the other replaces it');
  handleKey(w, 'z', state);
  assert.equal(gaitOf(w), 'sneak');
  handleKey(w, 'z', state);
  assert.equal(gaitOf(w), 'walk');
  // No run on this archetype.
  const slow = world({ gaits: `      sneak: { ticks_per_step: 4 }\n` });
  handleKey(slow, 'r', state);
  assert.equal(state.message, "You can't run.");
  assert.equal(gaitOf(slow), 'walk');
  handleKey(slow, 'z', state);
  assert.equal(state.message, null);
  assert.equal(gaitOf(slow), 'sneak');
  const none = world({ gaits: '' });
  handleKey(none, 'z', state);
  assert.equal(state.message, "You can't sneak.");
  assert.equal(gaitOf(none), 'walk');
  const rows = TERMINAL_BINDINGS.filter((b) => b.id === 'run' || b.id === 'sneak');
  assert.deepEqual(
    rows.map((b) => [b.keys, b.label, b.section]),
    [
      [['r'], 'Run (toggle)', 'Moving'],
      [['z'], 'Sneak (toggle)', 'Moving'],
    ],
  );
  const help = helpLines();
  assert.ok(help.some((l) => /^ {2}r\s+Run \(toggle\)$/.test(l)), help.join('\n'));
  assert.ok(help.some((l) => /^ {2}z\s+Sneak \(toggle\)$/.test(l)));
});

test('gaits: the HUD model carries the gait label when not walking; hudLines adds it after the measurements; the browser shows a neutral chip first', () => {
  const w = world();
  let m = hudModel(w);
  assert.equal(m.gait, null);
  const plain = hudLines(m);
  assert.ok(!plain.includes('Running'));
  assert.equal(hudView(m).chips.length, 0);
  assert.equal(w.setGait('run'), true);
  m = hudModel(w);
  assert.equal(m.gait, 'Running');
  const lines = hudLines(m);
  assert.equal(lines.length, plain.length + 1);
  assert.equal(lines[1 + m.measurements.length], 'Running', 'right after the measurements');
  assert.equal(hudLineLevels(m).length, lines.length);
  assert.equal(hudLineLevels(m)[1 + m.measurements.length], null);
  assert.deepEqual(hudView(m).chips, [{ id: GAIT_CHIP_ID, label: 'Running', tone: 'neutral', tooltip: [] }]);
  assert.equal(w.setGait('sneak'), true);
  assert.equal(hudModel(w).gait, 'Sneaking');
  assert.equal(w.setGait('walk'), true);
  assert.equal(hudModel(w).gait, null);
});

// ── Shipped packs ───────────────────────────────────────────────────────────

test('gaits: the shipped archetypes carry the documented gaits', () => {
  const load = (...dirs: string[]) => loadPacksOrThrow(dirs.map((d) => readPack(`packs/${d}`)));
  const gaitsOf = (def: ReturnType<typeof load>, id: string) => def.archetypes[def.ids.archetypes[id]!]!.gaits.map((g) => [g.name, g.ticksPerStep, g.noise, g.label]);
  const town = load('std', 'std-needs', 'town', 'zombie');
  assert.deepEqual(gaitsOf(town, 'std:humanoid'), [
    ['walk', 2, 0, 'Walking'],
    ['run', 1, 6, 'Running'],
    ['sneak', 4, 0, 'Sneaking'],
  ]);
  assert.deepEqual(gaitsOf(town, 'town:resident'), [
    ['walk', 2, 0, 'Walking'],
    ['run', 1, 6, 'Running'],
    ['sneak', 4, 0, 'Sneaking'],
  ]);
  assert.deepEqual(gaitsOf(town, 'zmb:shambler'), [['walk', 2, 0, 'Walking']]);
  const garden = load('std', 'garden');
  assert.deepEqual(gaitsOf(garden, 'gdn:bunny'), [
    ['walk', 2, 0, 'Walking'],
    ['run', 1, 3, 'Running'],
    ['sneak', 4, 0, 'Sneaking'],
  ]);
  const vamp = load('std', 'std-needs', 'town', 'vampire');
  assert.deepEqual(gaitsOf(vamp, 'vamp:vampire'), [
    ['walk', 1, 0, 'Walking'],
    ['sneak', 2, 0, 'Sneaking'],
  ]);
  // The vampire cannot run: the shipped case for setGait's false.
  const v = World.create(vamp, 1);
  assert.equal(v.setGait('run'), false);
  assert.equal(v.setGait('sneak'), true);
  // std-needs tires a runner: fatigue climbs faster while running.
  const t = World.create(town, 1);
  const fatigue = t.def.ids.measurements['std_needs:fatigue']!;
  const running = t.def.systems[t.def.ids.systems['std_needs:running']!]!;
  assert.ok(running);
  for (let i = 0; i < 100; i++) t.step();
  const walked = t.player.m[fatigue]!;
  const before = t.player.m[fatigue]!;
  assert.equal(t.setGait('run'), true);
  for (let i = 0; i < 100; i++) t.step();
  const ran = t.player.m[fatigue]! - before;
  assert.ok(ran > walked * 2 && ran < walked * 10, `walked ${walked}, ran ${ran}`);
});
