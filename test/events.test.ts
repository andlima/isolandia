import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError, loadPacks, loadPacksOrThrow, World, type Entity, type LoadError, type PackSource } from '../src/core/index.ts';
import { countOf } from '../src/core/sim/containers.ts';
import { assertRoundTrip, fixture, loadFixture } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   floor 0              floor 1
//   ##########           ##########
//   #@..*..e.#           #........#     * glass (tag `glass`); < stairs up to > its landing
//   #....<...#           #....>...#     e ears (no behavior), o a rock without `q`
//   #..o...e.#           #........#
//   ##########           ##########
//
// Entity ids: the hero 0, the north ear 1, the rock 2, the south ear 3.
// Everyone with `vol != 0` shouts a noise of that radius every tick.

const BASE: Record<string, string> = {
  'xy.yaml': `measurements:
  - { id: p, label: P, max: 100, initial: 0 }
  - { id: q, label: Q, max: 100, initial: 0 }
  - { id: vol, label: Volume, min: -100, max: 100, initial: 0 }
`,
  'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: glass, label: Glass, glyph: "*", color: white, walkable: true, tags: [glass] }
  - { id: stairs, label: Stairs, glyph: "<", color: white, walkable: true, raised: true, opaque: false, climb: up }
  - { id: landing, label: Landing, glyph: ">", color: white, walkable: true }
`,
  'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    tags: [living]
    measurements: [p, q, vol]
    ticks_per_step: 1
    ticks_per_turn: 1
    inventory: { capacity: 10, items: { kit: 2 } }
  - { id: ear, label: Ear, glyph: e, color: gray, tags: [ear], measurements: [p, q, vol], ticks_per_step: 1, ticks_per_turn: 0 }
  - { id: rock, label: Rock, glyph: o, color: gray, measurements: [p, vol], ticks_per_turn: 0 }
`,
  'items.yaml': `items:
  - id: kit
    label: Kit
    glyph: "+"
    color: white
    weight: 0.1
    use:
      label: Apply
      when: "self.p < 100"
      duration: 3
      interrupt: { on: noise }
      effects:
        - { type: apply, measurement: p, delta: 20 }
`,
  'base.yaml': `systems:
  - id: shout
    every: 0.1
    for: 'self.vol != 0'
    effects:
      - { type: noise, radius: "self.vol" }
`,
  'map.yaml': `maps:
  - id: house
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "*": { tile: glass }
      "<": { tile: stairs, facing: w }
      ">": { tile: landing }
      "e": { tile: floor, spawn: ear }
      "o": { tile: floor, spawn: rock }
    floors:
      - rows: ["##########", "#@..*..e.#", "#....<...#", "#..o...e.#", "##########"]
      - rows: ["##########", "#........#", "#....>...#", "#........#", "##########"]
start:
  map: house
  player: hero
`,
};

function world(files: Record<string, string> = {}, seed = 1): World {
  return World.create(loadFixture({ ...BASE, ...files }), seed);
}

const val = (w: World, id: string, e: Entity = w.player) => w.value(e, `t:${id}`)!;
const M = (w: World, id: string) => w.def.ids.measurements[`t:${id}`]!;
const ears = (w: World) => w.entities.filter((e) => e.archetype.id === 't:ear');
const ear = (w: World) => ears(w)[0]!;
const rock = (w: World) => w.entities.find((e) => e.archetype.id === 't:rock')!;
const kits = (w: World) => countOf(w.player.inv!, w.def.ids.items['t:kit']!);

/** Step once with each emitter shouting at its radius (then silent again). */
function shout(w: World, emitters: [Entity, number][]): void {
  const k = M(w, 'vol');
  for (const [e, v] of emitters) e.m[k] = v;
  w.step();
  for (const [e] of emitters) e.m[k] = 0;
}

/** Step until `e` has no pending intent and no path; returns how many cells it landed on meanwhile. */
function settle(w: World, e: Entity = w.player): number {
  let landings = 0;
  let last = e.stepTick;
  for (let i = 0; i < 100 && (e.intent || e.path); i++) {
    w.step();
    if (e.stepTick !== last) {
      landings++;
      last = e.stepTick;
    }
  }
  assert.ok(!e.intent && !e.path, 'did not settle');
  return landings;
}

/** Walk the player to (x, y, z); returns how many cells it landed on. */
function walk(w: World, x: number, y: number, z = 0): number {
  w.queueIntent({ kind: 'goto', x, y, z });
  const landings = settle(w);
  assert.deepEqual([w.player.x, w.player.y, w.player.z], [x, y, z]);
  return landings;
}

function errorsOf(files: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture({ ...BASE, ...files })]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

const SYS = (fields: string) => ({ 's.yaml': `systems:\n  - { id: s, ${fields}, effects: [{ type: apply, measurement: p, delta: 1 }] }\n` });
const ACT = (interrupt: string) => ({
  'a.yaml': `actions:\n  - { id: nap, label: Nap, target: self, duration: 1, interrupt: ${interrupt}, effects: [{ type: apply, measurement: p, delta: 1 }] }\n`,
});

// ── Loader ──────────────────────────────────────────────────────────────────

test('loader: `on` with `every`, an unknown `on` and a bad `once` are errors; `once: false` is the default', () => {
  expectError(errorsOf(SYS('on: step, every: 1')), 'systems[0].on', /cannot be combined with 'every': an event system has no period/);
  expectError(errorsOf(SYS('on: stomp')), 'systems[0].on', /must be 'step' or 'noise', got "stomp" \(did you mean 'step'\?\)/);
  expectError(errorsOf(SYS('on: 3')), 'systems[0].on', /must be 'step' or 'noise', got 3$/);
  expectError(errorsOf(SYS('once: 1')), 'systems[0].once', /must be true or false, got 1/);
  expectError(errorsOf(SYS('once: "true"')), 'systems[0].once', /must be true or false, got "true"/);
  expectError(errorsOf(SYS('once: true, on: noise, after: 1')), 'systems[0].after', /unknown system field 'after'/);

  const def = loadFixture({ ...BASE, ...SYS('on: noise, once: false') });
  const s = def.systems[def.ids.systems['t:s']!]!;
  assert.equal(s.on, 'noise');
  assert.equal(s.once, false);
  assert.equal(s.onceIndex, -1);
  assert.equal(s.every, 0);
  assert.equal(s.period, 0);
  const shout = def.systems[def.ids.systems['t:shout']!]!;
  assert.equal(shout.on, null);
  assert.equal(shout.period, 1);
});

test('loader: the interrupt mapping needs `on: noise` and takes only `when`; the expression form still loads', () => {
  expectError(errorsOf(ACT('{ on: step }')), 'actions[0].interrupt.on', /must be 'noise', got "step"/);
  expectError(errorsOf(ACT('{ on: nosie }')), 'actions[0].interrupt.on', /did you mean 'noise'/);
  expectError(errorsOf(ACT('{ when: "true" }')), 'actions[0].interrupt', /missing required field 'on'/);
  expectError(errorsOf(ACT('{ on: noise, after: 1 }')), 'actions[0].interrupt.after', /unknown interrupt field 'after'/);
  expectError(errorsOf(ACT('{ on: noise, whne: "true" }')), 'actions[0].interrupt.whne', /unknown interrupt field 'whne' \(did you mean 'when'\?\)/);
  expectError(errorsOf(ACT('{ on: noise, when: "self.nope > 1" }')), 'actions[0].interrupt.when', /unknown measurement 'nope'/);
  expectError(errorsOf(ACT('5')), 'actions[0].interrupt', /must be an expression or a mapping like \{ on: noise \}, got 5/);
  expectError(errorsOf(ACT('[noise]')), 'actions[0].interrupt', /must be an expression or a mapping/);
  // The same parser serves item uses and recipes.
  expectError(
    errorsOf({ 'k.yaml': `items:\n  - { id: tool, label: Tool, glyph: t, color: white, use: { duration: 1, interrupt: { on: step }, effects: [{ type: apply, measurement: p, delta: 1 }] } }\n` }),
    'items[0].use.interrupt.on',
    /must be 'noise'/,
  );
  expectError(
    errorsOf({ 'r.yaml': `recipes:\n  - { id: fold, label: Fold, consume: { kit: 1 }, produce: { kit: 2 }, duration: 1, interrupt: { on: noise, now: true } }\n` }),
    'recipes[0].interrupt.now',
    /unknown interrupt field 'now'/,
  );

  const expr = loadFixture({ ...BASE, ...ACT("'self.p > 1'") }).actions[0]!.interrupt!;
  assert.equal(expr.kind, 'expr');
  const bool = loadFixture({ ...BASE, ...ACT('true') }).actions[0]!.interrupt!;
  assert.equal(bool.kind, 'expr');
  const gated = loadFixture({ ...BASE, ...ACT('{ on: noise, when: "self.p > 1" }') }).actions[0]!.interrupt!;
  assert.equal(gated.kind, 'event');
  assert.ok(gated.kind === 'event' && gated.whenFn, 'when compiled');
  const plain = loadFixture({ ...BASE, ...ACT('{ on: noise }') });
  const nap = plain.actions[0]!.interrupt!;
  assert.deepEqual(nap, { kind: 'event', on: 'noise', whenFn: null });
  assert.deepEqual(plain.items[plain.ids.items['t:kit']!]!.use!.interrupt, { kind: 'event', on: 'noise', whenFn: null });
});

// ── Step systems ────────────────────────────────────────────────────────────

test('step systems: one firing per cell landed on (steps, path cells, a climb; player and NPC); none while idle, blocked or turning', () => {
  const w = world(SYS('on: step'));
  const P = M(w, 'p');
  for (let i = 0; i < 5; i++) w.step();
  assert.equal(val(w, 'p'), 0, 'idle');

  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  assert.equal(settle(w), 1);
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
  assert.equal(val(w, 'p'), 1, 'one step, one firing');
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(val(w, 'p'), 1, 'nothing more while standing on the cell');

  w.queueIntent({ kind: 'step', dx: 0, dy: -1 }); // into the wall
  assert.equal(settle(w), 0);
  assert.equal(val(w, 'p'), 1, 'a blocked step is no landing');
  w.queueIntent({ kind: 'step', dx: 0, dy: 1, turnInPlace: true });
  assert.equal(settle(w), 0);
  assert.deepEqual([w.player.x, w.player.y], [2, 1]);
  assert.equal(val(w, 'p'), 1, 'a turn in place is no landing');

  const cells = walk(w, 2, 3);
  assert.equal(cells, 2);
  assert.equal(val(w, 'p'), 3, 'one firing per path cell');

  const toStairs = walk(w, 5, 2);
  assert.equal(val(w, 'p'), 3 + toStairs);
  assert.equal(walk(w, 5, 2, 1), 1, 'the climb is one landing');
  assert.equal(val(w, 'p'), 4 + toStairs, 'a climb fires once');

  // An NPC's step fires too.
  const e = ear(w);
  w.queueIntent({ kind: 'step', dx: 0, dy: 1 }, e);
  assert.equal(settle(w, e), 1);
  assert.equal(e.m[P], 1);
  assert.equal(rock(w).m[P], 0, 'the rock never moved');
});

test('step systems: `tile` is the cell arrived at; a noise emitted by a step system is heard on the same tick', () => {
  const w = world({
    's.yaml': `systems:
  - { id: crunch, on: step, for: 'self.has_tag("living")', when: 'tile.has_tag("glass")', effects: [{ type: noise, radius: 4 }] }
`,
  });
  const e = ear(w); // (7, 1): 3 cells east of the glass at (4, 1)
  walk(w, 3, 1);
  assert.equal(e.heardTick, -1, 'the floor is quiet');
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  assert.equal(settle(w), 1);
  assert.deepEqual([w.player.x, w.player.y], [4, 1]);
  assert.equal(e.heardTick, w.tick - 1, 'heard on the tick of the step');
  assert.deepEqual([e.heardX, e.heardY], [4, 1]);
  assert.equal(w.noises.length, 1);
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(w.noises.length, 0, 'standing on the glass is silent');
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 }); // off the glass
  settle(w);
  assert.equal(w.noises.length, 0, '`tile` is the cell arrived at, not the one left');

  // The ear is not `living`: its step onto the glass is silent for the hero (who is in range).
  w.queueIntent({ kind: 'goto', x: 4, y: 1 }, e);
  settle(w, e);
  assert.deepEqual([e.x, e.y], [4, 1]);
  assert.equal(w.player.heardTick, -1);
});

// ── Noise systems ───────────────────────────────────────────────────────────

test('noise systems: fire on the hearing tick only, once per entity for two noises, never for the source; statuses see them the same tick', () => {
  const w = world({
    's.yaml': `systems:
  - { id: flinch, on: noise, effects: [{ type: apply, measurement: q, delta: 1 }] }
statuses:
  - { id: jumpy, label: Jumpy, when: 'self.q >= 1' }
`,
  });
  const [a, b] = ears(w) as [Entity, Entity];
  shout(w, [[w.player, 6]]); // reaches the north ear (6 away), not the south one (6.3)
  assert.equal(a.heardTick, w.tick - 1);
  assert.equal(val(w, 'q', a), 1);
  assert.equal(val(w, 'q', b), 0);
  assert.equal(val(w, 'q'), 0, 'the source never hears its own noise');
  assert.ok(w.hasStatus(a, 't:jumpy'), 'statuses see the effect on the same tick');
  w.step();
  assert.equal(val(w, 'q', a), 1, 'nothing on a silent tick');

  // Two noises in one tick: the north ear fires once; the rock lacks `q` (a skipped effect) but hears.
  shout(w, [[w.player, 6], [rock(w), 5]]);
  assert.equal(val(w, 'q', a), 2);
  assert.equal(val(w, 'q', b), 1, 'the rock is 4.5 from the south ear');
  assert.equal(rock(w).heardTick, w.tick - 1);
});

test('noise systems: a noise they emit is heard on the next tick; a two-ear echo advances one hop per tick and never hangs', () => {
  const w = world({ 's.yaml': `systems:\n  - { id: echo, on: noise, for: 'self.has_tag("ear")', effects: [{ type: noise, radius: 20 }] }\n` });
  const [a, b] = ears(w) as [Entity, Entity];
  const t0 = w.tick;
  shout(w, [[w.player, 20]]); // tick t0: both ears hear the hero and echo
  assert.equal(a.heardTick, t0);
  assert.equal(b.heardTick, t0);
  assert.equal(w.player.heardTick, -1, 'the echoes are not heard on the tick they are emitted');
  assert.equal(w.noises.length, 3, 'the shout and the two echoes, pending for the next tick');
  w.step(); // t0 + 1: each ear hears the other's echo (never its own) and echoes again
  assert.equal(w.player.heardTick, t0 + 1);
  assert.equal(a.heardTick, t0 + 1);
  assert.equal(b.heardTick, t0 + 1);
  assert.equal(w.noises.length, 4, 'two carried echoes heard, two new ones pending');
  for (let i = 2; i < 12; i++) {
    w.step();
    assert.equal(a.heardTick, t0 + i);
    assert.equal(b.heardTick, t0 + i);
    assert.equal(w.noises.length, 4);
  }
});

test('noise systems: `for` and `when` filter hearers; `once` combines with `on: noise`', () => {
  const w = world({
    's.yaml': `systems:
  - { id: startle, on: noise, once: true, for: 'self.has_tag("ear")', when: 'self.q < 50', effects: [{ type: apply, measurement: q, delta: 10 }] }
`,
  });
  const [a, b] = ears(w) as [Entity, Entity];
  b.m[M(w, 'q')] = 60;
  for (let i = 0; i < 3; i++) shout(w, [[rock(w), 20]]);
  assert.equal(val(w, 'q', a), 10, 'once: fired on the first noise only');
  assert.equal(val(w, 'q', b), 60, 'when is falsy for the south ear');
  assert.equal(val(w, 'q'), 0, 'the hero is not an ear');
  b.m[M(w, 'q')] = 0;
  shout(w, [[rock(w), 20]]);
  assert.equal(val(w, 'q', b), 10, 'a once system that never fired still can');
  assert.deepEqual(
    w.snapshot().entities.map((e) => e.fired ?? null),
    [null, ['t:startle'], null, ['t:startle']],
  );
});

// ── Event interrupts ────────────────────────────────────────────────────────

test('event interrupts: an action ends on the tick the noise lands, not on its start tick; `when` gates it; the expression form is unchanged', () => {
  const w = world({
    'a.yaml': `actions:
  - { id: nap, label: Nap, target: self, duration: 2, interrupt: { on: noise }, effects: [{ type: apply, measurement: p, delta: 1 }] }
  - { id: doze, label: Doze, target: self, duration: 2, interrupt: { on: noise, when: 'self.q >= 50' }, effects: [{ type: apply, measurement: p, delta: 1 }] }
  - { id: rest, label: Rest, target: self, duration: 2, interrupt: 'heard(self, 0.2)', effects: [{ type: apply, measurement: p, delta: 1 }] }
`,
  });
  const e = ear(w);
  // A noise that lands on the start tick (after the start) does not interrupt.
  w.queueAction({ kind: 'act', action: 't:nap' });
  shout(w, [[e, 10]]); // tick 0
  assert.equal(w.player.heardTick, 0);
  assert.ok(w.player.activity, 'not on the start tick');
  for (let i = 0; i < 4; i++) w.step();
  assert.ok(w.player.activity, 'silent ticks leave it running');
  shout(w, [[e, 10]]); // tick 5
  assert.equal(w.player.activity, null);
  assert.deepEqual(w.lastAction, { kind: 'act', item: '', action: 't:nap', moved: 0, ok: false, stage: 'complete', reason: 'interrupted', tick: 5 });
  assert.equal(val(w, 'p'), 0, 'no effects');

  // `when` falsy leaves it running; truthy ends it.
  w.queueAction({ kind: 'act', action: 't:doze' });
  w.step();
  w.step();
  shout(w, [[e, 10]]);
  assert.ok(w.player.activity, 'when is falsy');
  w.player.m[M(w, 'q')] = 60;
  const t = w.tick;
  shout(w, [[e, 10]]);
  assert.equal(w.player.activity, null);
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(w.lastAction!.tick, t);

  // The expression form is checked in the next tick's work step, as before.
  w.queueAction({ kind: 'act', action: 't:rest' });
  w.step();
  w.step();
  const u = w.tick;
  shout(w, [[e, 10]]);
  assert.ok(w.player.activity, 'hearing lands after the work step');
  w.step();
  assert.equal(w.player.activity, null);
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(w.lastAction!.tick, u + 1);

  // Without a noise, every form completes.
  w.queueAction({ kind: 'act', action: 't:nap' });
  for (let i = 0; i < 21; i++) w.step();
  assert.equal(w.lastAction!.ok, true);
  assert.equal(val(w, 'p'), 1);
});

test('event interrupts: a timed use is spoiled by a noise 0.1 s before completion; a recipe takes the mapping too', () => {
  const w = world({
    'r.yaml': `items:
  - { id: widget, label: Widget, glyph: w, color: white, weight: 0.1 }
recipes:
  - { id: fold, label: Widget, consume: { kit: 1 }, produce: { widget: 1 }, duration: 2, interrupt: { on: noise } }
`,
  });
  const e = ear(w);
  w.queueAction({ kind: 'use', item: 't:kit' });
  w.step(); // tick 0: start; completes in the work step of tick 30
  assert.equal(w.player.activity!.endTick, 30);
  while (w.tick < 29) w.step();
  shout(w, [[e, 10]]); // tick 29: the noise lands 0.1 s before completion
  assert.equal(w.player.activity, null);
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(w.lastAction!.tick, 29);
  assert.equal(val(w, 'p'), 0);
  assert.equal(kits(w), 2, 'the kit is kept');

  w.queueAction({ kind: 'use', item: 't:kit' });
  for (let i = 0; i < 31; i++) w.step();
  assert.equal(w.lastAction!.ok, true);
  assert.equal(val(w, 'p'), 20);
  assert.equal(kits(w), 1);

  w.queueAction({ kind: 'craft', recipe: 't:fold' });
  w.step();
  w.step();
  shout(w, [[e, 10]]);
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(w.lastAction!.recipe, 't:fold');
  assert.equal(kits(w), 1, 'nothing consumed');
});

// ── once ────────────────────────────────────────────────────────────────────

const TIP = { 's.yaml': `systems:\n  - { id: tip, once: true, every: 0.1, for: 'self.p >= 1', effects: [{ type: apply, measurement: q, delta: 10 }] }\n` };

test('once: fires at most once per entity, independently; a no-op effect still counts; the state is in the snapshot and the hash', () => {
  const w = world(TIP);
  const P = M(w, 'p');
  const sys = w.def.systems[w.def.ids.systems['t:tip']!]!;
  assert.equal(sys.once, true);
  assert.equal(sys.onceIndex, 0);
  assert.equal(w.def.systems[w.def.ids.systems['t:shout']!]!.onceIndex, -1);
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(val(w, 'q'), 0, 'for never held: not fired');
  assert.equal(w.snapshot().entities[0]!.fired, undefined);
  const h0 = w.hash();

  w.player.m[P] = 1;
  w.step();
  assert.equal(val(w, 'q'), 10);
  assert.deepEqual(w.snapshot().entities[0]!.fired, ['t:tip']);
  assert.equal(w.snapshot().entities[1]!.fired, undefined);
  assert.notEqual(w.hash(), h0);
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(val(w, 'q'), 10, 'never again for the hero');

  const e = ear(w);
  e.m[P] = 1;
  w.step();
  w.step();
  assert.equal(val(w, 'q', e), 10, 'the ear fires on its own, once');
  assert.equal(val(w, 'q'), 10);

  // The rock lacks `q`: its effect is a no-op, but the system still counts as fired for it.
  const r = rock(w);
  r.m[P] = 1;
  w.step();
  assert.deepEqual(
    w.snapshot().entities.map((x) => x.fired ?? null),
    [['t:tip'], ['t:tip'], ['t:tip'], null],
  );
});

test('once: with `on: step`, the first landing fires and later ones do not', () => {
  const w = world({ 's.yaml': `systems:\n  - { id: first_step, once: true, on: step, effects: [{ type: apply, measurement: p, delta: 1 }] }\n` });
  walk(w, 3, 1);
  assert.equal(val(w, 'p'), 1);
  walk(w, 1, 1);
  assert.equal(val(w, 'p'), 1);
  assert.deepEqual(w.snapshot().entities[0]!.fired, ['t:first_step']);
});

test('once: the state survives a save round trip; a version 6 save loads with nothing fired; bad ids are restore errors', () => {
  const w = world(TIP);
  const P = M(w, 'p');
  w.player.m[P] = 1;
  w.step(); // fired for the hero only
  assert.equal(w.save().version, 7);
  const at = w.tick + 3;
  const copy = assertRoundTrip(w, (x) => x.tick === at && void (ear(x).m[P] = 1), 10);
  assert.deepEqual(
    copy.snapshot().entities.map((x) => x.fired ?? null),
    [['t:tip'], ['t:tip'], null, null],
  );
  assert.equal(val(copy, 'q'), 10, 'the restored hero does not fire again');

  type Loose = { version: number; state: { entities: { fired?: unknown }[] } };
  const json = () => JSON.parse(JSON.stringify(w.save())) as Loose;
  const old = json();
  old.version = 6;
  for (const e of old.state.entities) delete e.fired;
  const r = World.restore(w.def, old);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.world.snapshot().entities[0]!.fired, undefined);
  r.world.step();
  assert.equal(val(r.world, 'q'), 20, 'after the upgrade the once system may fire again');
  assert.equal(r.world.save().version, 7);

  const bad = (edit: (s: Loose) => void): string[] => {
    const s = json();
    edit(s);
    const x = World.restore(w.def, s);
    assert.equal(x.ok, false);
    return x.ok ? [] : x.errors;
  };
  const has = (errors: string[], re: RegExp) => assert.ok(errors.some((e) => re.test(e)), errors.join('\n'));
  has(bad((s) => (s.state.entities[0]!.fired = ['t:tipp'])), /^state\.entities\[0\]\.fired\[0\]: unknown system 't:tipp' \(did you mean 't:tip'\?\)$/);
  has(bad((s) => (s.state.entities[1]!.fired = ['t:shout'])), /^state\.entities\[1\]\.fired\[0\]: system 't:shout' is not a 'once' system$/);
  has(bad((s) => (s.state.entities[0]!.fired = ['t:tip', 't:tip'])), /^state\.entities\[0\]\.fired\[1\]: system 't:tip' is listed twice$/);
  has(bad((s) => (s.state.entities[0]!.fired = 'tip')), /^state\.entities\[0\]\.fired: expected an array/);
  has(bad((s) => (s.state.entities[0]!.fired = [3])), /^state\.entities\[0\]\.fired\[0\]: expected a string/);
});

// ── Overrides ───────────────────────────────────────────────────────────────

test('overrides: `on` and `once` are top-level fields validated afresh on the merged entry; the interrupt mapping is replaced whole', () => {
  const mod = (yaml: string): PackSource => ({ label: 'mod', files: { 'pack.yaml': 'namespace: m\nname: m\nversion: 1.0.0\ndepends: [t]\n', 'mod.yaml': yaml } });
  const base = fixture({
    ...BASE,
    's.yaml': `systems:
  - { id: tick, every: 1, effects: [{ type: apply, measurement: p, delta: 1 }] }
  - { id: land, on: step, effects: [{ type: apply, measurement: q, delta: 1 }] }
actions:
  - { id: nap, label: Nap, target: self, duration: 2, interrupt: { on: noise, when: 'false' }, effects: [{ type: apply, measurement: p, delta: 1 }] }
`,
  });
  // `every` left in place next to an added `on` is an error at the override.
  const r = loadPacks([base, mod(`systems:\n  - { id: t:tick, override: true, on: step }\n`)]);
  assert.equal(r.ok, false);
  const hit = r.ok ? undefined : r.errors.find((e) => /an event system has no period/.test(e.message));
  assert.ok(hit, r.ok ? '' : r.errors.map(formatError).join('\n'));
  assert.equal(hit.pack, 'm');
  assert.equal(hit.file, 'mod.yaml');
  assert.equal(hit.path, 'systems[0].on');

  const def = loadPacksOrThrow([
    base,
    mod(`systems:
  - { id: t:tick, override: true, on: step, every: null, once: true }
  - { id: t:land, override: true, on: null }
actions:
  - { id: t:nap, override: true, interrupt: { on: noise } }
`),
  ]);
  const tick = def.systems[def.ids.systems['t:tick']!]!;
  assert.equal(tick.on, 'step');
  assert.equal(tick.once, true);
  assert.equal(tick.period, 0);
  const land = def.systems[def.ids.systems['t:land']!]!;
  assert.equal(land.on, null);
  assert.equal(land.period, 1, '`on: null` goes back to a periodic system with the default period');
  assert.deepEqual(def.actions[def.ids.actions['t:nap']!]!.interrupt, { kind: 'event', on: 'noise', whenFn: null });

  const w = World.create(def, 1);
  walk(w, 2, 1);
  walk(w, 3, 1);
  assert.equal(val(w, 'p'), 1, 'tick is now a once step system');
  assert.ok(val(w, 'q') >= 2, 'land is periodic now');
});

// ── Determinism ─────────────────────────────────────────────────────────────

test('determinism: step and noise systems, event interrupts and once state replay to the same hash', () => {
  const files = {
    's.yaml': `systems:
  - { id: crunch, on: step, when: 'tile.has_tag("glass")', effects: [{ type: noise, radius: 6 }] }
  - { id: echo, on: noise, for: 'self.has_tag("ear")', effects: [{ type: noise, radius: 3 }] }
  - { id: tip, once: true, on: noise, effects: [{ type: apply, measurement: q, delta: 10 }] }
actions:
  - { id: nap, label: Nap, target: self, duration: 1, interrupt: { on: noise }, effects: [{ type: apply, measurement: p, delta: 1 }] }
`,
  };
  const run = (): World => {
    const w = world(files, 3);
    for (let t = 0; t < 60; t++) {
      if (t % 10 === 0) w.queueIntent({ kind: 'goto', x: t % 20 === 0 ? 4 : 1, y: 1 });
      if (t % 7 === 3) w.queueAction({ kind: 'act', action: 't:nap' });
      w.step();
    }
    return w;
  };
  const a = run();
  const b = run();
  assert.equal(a.hash(), b.hash());
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.ok(a.entities.some((e) => (a.snapshot().entities[e.id]!.fired ?? []).length > 0), 'something fired');
});
