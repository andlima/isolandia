import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError, loadPacks, loadPacksOrThrow, Rng, World, type Entity, type LoadError } from '../src/core/index.ts';
import { compileSource } from '../src/core/expr/index.ts';
import { add } from '../src/core/sim/containers.ts';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, GAMES, genreCell, loadFixture } from './helpers.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Hero (player) and `ear`s emit a noise of radius `self.vol` every tick while
 * `vol != 0`; `npc` investigates what it hears, `eager` starts investigating.
 */
const BASE: Record<string, string> = {
  'noise.yaml': `measurements:
  - { id: vol, label: Volume, min: -100, max: 100, initial: 0 }
systems:
  - id: shout
    every: 0.1
    for: 'self.vol != 0'
    effects:
      - { type: noise, radius: "self.vol" }
statuses:
  - { id: hearing, label: Hearing, when: 'heard(self, 1)' }
items:
  - id: bell
    label: Bell
    glyph: "o"
    color: yellow
    weight: 0.5
    use: { label: Ring, consume: 0, effects: [{ type: noise, radius: 5 }] }
  - id: whistle
    label: Whistle
    glyph: "i"
    color: white
    weight: 0.1
    use:
      when: 'self.hp > 100'
      effects:
        - { type: noise, radius: 5 }
behaviors:
  - id: curious
    initial: rest
    states:
      rest:
        do: idle
        on:
          - { when: 'heard(self, 1)', to: go }
      go:
        do: investigate
        repath: 0.5
        done: back
      back:
        do: idle
  - id: eager
    initial: go
    states:
      go:
        do: investigate
        done: back
      back:
        do: idle
`,
  'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    measurements: [hp, food, vol]
    ticks_per_step: 1
    inventory: { capacity: 10, items: { bell: 1, whistle: 1 } }
  - { id: ear, label: Ear, glyph: e, color: gray, ticks_per_turn: 0, measurements: [vol] }
  - { id: npc, label: Npc, glyph: n, color: red, ticks_per_turn: 0, ticks_per_step: 1, behavior: curious }
  - { id: eager, label: Eager, glyph: m, color: red, ticks_per_turn: 0, ticks_per_step: 1, behavior: eager }
`,
};

/** 13×9; a short wall at x = 4 next to the hero. */
const ROOM = [
  '#############',
  '#...#.......#',
  '#.@.#.......#',
  '#...#.......#',
  '#...........#',
  '#...........#',
  '#.......eee.#',
  '#.......n...#',
  '#############',
];

function files(rows: readonly string[] = ROOM): Record<string, string> {
  const map = `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "e": { tile: floor, spawn: ear }
      "n": { tile: floor, spawn: npc }
      "m": { tile: floor, spawn: eager }
    rows: ${JSON.stringify(rows)}
start:
  map: room
  player: hero
`;
  return { ...BASE, 'map.yaml': map };
}

function world(rows?: readonly string[]): World {
  return World.create(loadFixture(files(rows)), 1);
}

const VOL = (w: World) => w.def.ids.measurements['t:vol']!;
const ears = (w: World) => w.entities.filter((e) => e.archetype.id === 't:ear');
const npcOf = (w: World, id = 't:npc') => w.entities.find((e) => e.archetype.id === id)!;
const stateOf = (e: Entity) => e.behavior!.states[e.state]!.name;
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const heard = (e: Entity) => (e.heardTick >= 0 ? [e.heardX, e.heardY, e.heardTick] : null);

function place(e: Entity, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
}

/** Step once with `e` shouting at `vol` (then silent again). */
function shout(w: World, emitters: [Entity, number][]): void {
  const k = VOL(w);
  for (const [e, v] of emitters) e.m[k] = v;
  w.step();
  for (const [e] of emitters) e.m[k] = 0;
}

function errorsOf(files: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture(files)]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

// ── Loader ──────────────────────────────────────────────────────────────────

test('loader: noise effects load in systems and item use; bad fields are errors', () => {
  const def = loadFixture(files());
  const shoutSys = def.systems[def.ids.systems['t:shout']!]!;
  assert.equal(shoutSys.effects[0]!.type, 'noise');
  assert.equal(typeof shoutSys.effects[0]!.fn, 'function');
  const bell = def.items[def.ids.items['t:bell']!]!;
  assert.deepEqual(bell.use!.effects, [{ type: 'noise', constant: 5, fn: null }]);

  const errors = errorsOf({
    'sys.yaml': `systems:
  - id: a
    effects:
      - { type: noise }
  - id: b
    effects:
      - { type: noise, radius: 3, measurement: hp }
  - id: c
    effects:
      - { type: noise, radius: 3, raduis: 4 }
  - id: d
    effects:
      - { type: noise, radius: '"loud"' }
  - id: e
    effects:
      - { type: nosie, radius: 3 }
items:
  - id: horn
    label: Horn
    glyph: h
    color: white
    weight: 1
    use: { effects: [{ type: noise }] }
`,
  });
  expectError(errors, 'systems[0].effects[0]', /missing required field 'radius'/);
  expectError(errors, 'systems[1].effects[0].measurement', /unknown 'noise' effect field 'measurement'/);
  expectError(errors, 'systems[2].effects[0].raduis', /unknown 'noise' effect field 'raduis' \(did you mean 'radius'\?\)/);
  expectError(errors, 'systems[3].effects[0].radius', /must produce a number, got string/);
  expectError(errors, 'systems[4].effects[0].type', /unknown effect type "nosie" \(did you mean 'noise'\?\); expected one of apply, set, noise/);
  expectError(errors, 'items[0].use.effects[0]', /missing required field 'radius'/);
});

test('loader: investigate takes no target; done only on home/investigate', () => {
  const def = loadFixture(files());
  const b = def.behaviors[def.ids.behaviors['t:curious']!]!;
  const go = b.states[1]!;
  assert.equal(go.activity, 'investigate');
  assert.equal(go.repath, 5);
  assert.equal(go.done, 2);
  assert.equal(go.target, null);

  const errors = errorsOf({
    'b.yaml': `behaviors:
  - id: bad
    initial: a
    states:
      a:
        do: investigate
        target: player
        done: b
      b:
        do: wander
        done: a
`,
  });
  expectError(errors, 'behaviors[0].states.a.target', /field 'target' is only allowed on 'pursue'\/'flee' states, not 'investigate'/);
  expectError(errors, 'behaviors[0].states.b.done', /field 'done' is only allowed on 'home'\/'investigate' states, not 'wander'/);
  assert.ok(!errors.some((e) => e.path === 'behaviors[0].states.a.done'));
});

test('heard(): compile errors and method syntax', () => {
  const symbols = { resolveMeasurement: () => ({ error: 'none' }) };
  const errs = (src: string) => compileSource(src, symbols).errors.map((e) => e.message);
  assert.deepEqual(errs('heard(self)'), ['heard() takes 2 arguments, got 1']);
  assert.deepEqual(errs('heard(self, 1, 2)'), ['heard() takes 2 arguments, got 3']);
  assert.deepEqual(errs('heard(1, 2)'), ['heard(entity, seconds) expects an entity, got number']);
  assert.deepEqual(errs('heard(tile, 2)'), ['heard(entity, seconds) expects an entity, got tile']);
  assert.deepEqual(errs('heard(self, "x")'), ['heard(entity, seconds) expects numeric seconds']);
  assert.deepEqual(errs('self.heard(2) and heard(player, 1)'), []);
  assert.equal(compileSource('self.heard(2)', symbols).expr.type, 'boolean');
});

// ── Hearing ─────────────────────────────────────────────────────────────────

test('hearing: inclusive euclidean radius, walls ignored, the source never hears itself', () => {
  const w = world();
  const [a, b, c] = ears(w);
  place(a!, 7, 2); // dx 5 behind the wall
  place(b!, 5, 6); // 3-4-5
  place(c!, 6, 6); // √32 > 5
  shout(w, [[w.player, 5]]);
  assert.deepEqual(w.noises, [{ x: 2, y: 2, z: 0, radius: 5, source: w.player.id }]);
  assert.deepEqual(heard(a!), [2, 2, 0]);
  assert.deepEqual(heard(b!), [2, 2, 0]);
  assert.equal(heard(c!), null);
  assert.equal(w.player.heardTick, -1);
  assert.deepEqual(w.snapshot().entities[a!.id]!.heard, { x: 2, y: 2, z: 0, tick: 0 });
  assert.equal(w.snapshot().entities[c!.id]!.heard, null);

  // Memory persists across silent ticks; noises are cleared.
  for (let t = 0; t < 30; t++) w.step();
  assert.deepEqual(w.noises, []);
  assert.deepEqual(heard(a!), [2, 2, 0]);
});

test('hearing: the nearest noise of a tick wins; ties go to the earlier emission', () => {
  const w = world();
  const [a, b, c] = ears(w);
  place(a!, 7, 2);
  place(b!, 10, 7);
  place(c!, 6, 6);
  // c: hero √32 away, a √17 away → a; the hero hears a, a hears the hero.
  shout(w, [
    [w.player, 20],
    [a!, 20],
  ]);
  assert.deepEqual(
    w.noises.map((n) => n.source),
    [w.player.id, a!.id],
  );
  assert.deepEqual(heard(c!), [7, 2, 0]);
  assert.deepEqual(heard(w.player), [7, 2, 0]);
  assert.deepEqual(heard(a!), [2, 2, 0]);
  assert.deepEqual(heard(b!), [7, 2, 0]);

  // Tie: c at (6,6) is 4 away from both (2,6) and (10,6); the earlier emitter wins.
  place(a!, 2, 6);
  place(b!, 10, 6);
  shout(w, [
    [a!, 10],
    [b!, 10],
  ]);
  assert.deepEqual(heard(c!), [2, 6, 1]);
  place(a!, 10, 6);
  place(b!, 2, 6);
  shout(w, [
    [a!, 10],
    [b!, 10],
  ]);
  assert.deepEqual(heard(c!), [10, 6, 2]);
});

test('hearing: a negative radius emits nothing; a silent world hears nothing', () => {
  const w = world();
  shout(w, [[w.player, -3]]);
  assert.deepEqual(w.noises, []);
  for (let t = 0; t < 50; t++) w.step();
  assert.deepEqual(w.noises, []);
  assert.ok(w.entities.every((e) => e.heardTick === -1));
  assert.ok(w.snapshot().entities.every((e) => e.heard === null));
});

test('hearing: a radius expression evaluating to 0 emits nothing', () => {
  const def = loadFixture({
    ...files(),
    'zero.yaml': `systems:
  - id: hush
    every: 0.1
    effects:
      - { type: noise, radius: "self.vol * 0" }
`,
  });
  const w = World.create(def, 1);
  for (let t = 0; t < 5; t++) w.step();
  assert.deepEqual(w.noises, []);
  assert.ok(w.entities.every((e) => e.heardTick === -1));
});

// ── Timing ──────────────────────────────────────────────────────────────────

test('timing: heard(self, 1) holds from the emission tick for ticksPerSecond ticks; transitions see it next tick', () => {
  const w = world();
  const [a] = ears(w);
  place(a!, 3, 4);
  const npc = npcOf(w);
  for (let t = 0; t < 3; t++) w.step();
  const t0 = w.tick;
  shout(w, [[w.player, 30]]);
  assert.ok(w.hasStatus(a!, 't:hearing'), 'status on in the emission tick');
  assert.equal(stateOf(npc), 'rest', 'think ran before the noise');
  w.step();
  assert.equal(stateOf(npc), 'go');
  assert.equal(npc.stateTick, t0 + 1);
  // On through tick t0 + 9, off at t0 + 10.
  while (w.tick < t0 + 10) {
    assert.ok(w.hasStatus(a!, 't:hearing'), `on at tick ${w.tick - 1}`);
    w.step();
  }
  assert.equal(w.tick - 1, t0 + 9);
  assert.ok(w.hasStatus(a!, 't:hearing'));
  w.step();
  assert.equal(w.hasStatus(a!, 't:hearing'), false, 'off at t0 + 10');
});

// ── Item use ────────────────────────────────────────────────────────────────

test('item use emits a noise only on success', () => {
  const w = world();
  const [a] = ears(w);
  place(a!, 4, 4);
  w.queueAction({ kind: 'use', item: 't:whistle' });
  w.step();
  assert.equal(w.lastAction!.ok, false);
  assert.deepEqual(w.noises, []);
  w.queueAction({ kind: 'use', item: 't:missing' });
  w.step();
  assert.deepEqual(w.noises, []);
  w.queueAction({ kind: 'use', item: 't:bell' });
  w.step();
  assert.equal(w.lastAction!.ok, true);
  assert.deepEqual(w.noises, [{ x: 2, y: 2, z: 0, radius: 5, source: w.player.id }]);
  assert.deepEqual(heard(a!), [2, 2, 2]);
});

// ── investigate ─────────────────────────────────────────────────────────────

test('investigate: walks up to the heard cell, then fires done', () => {
  const w = world();
  const npc = npcOf(w);
  const [a] = ears(w);
  place(a!, 1, 4);
  shout(w, [[a!, 30]]);
  let doneAt = -1;
  for (let t = 0; t < 60 && doneAt < 0; t++) {
    w.step();
    if (stateOf(npc) === 'back') doneAt = w.tick - 1;
  }
  assert.ok(doneAt > 0, 'done never fired');
  assert.ok(cheb(npc.x, npc.y, 1, 4) <= 1, `ended at ${npc.x},${npc.y}`);
  assert.equal(npc.path, null);
});

test('investigate: a newer noise retargets at most once per repath window', () => {
  const w = world();
  const npc = npcOf(w);
  const [a, b] = ears(w);
  place(a!, 1, 1);
  place(b!, 11, 1);
  shout(w, [[a!, 30]]); // tick 0
  w.step(); // tick 1: rest → go, goto (1,1)
  assert.equal(stateOf(npc), 'go');
  assert.deepEqual([npc.planX, npc.planY, npc.planTick], [1, 1, 1]);
  shout(w, [[b!, 30]]); // tick 2: a newer noise elsewhere
  const plans: [number, number, number][] = [];
  for (let t = 0; t < 12; t++) {
    w.step();
    const p: [number, number, number] = [npc.planX, npc.planY, npc.planTick];
    if (plans.length === 0 || plans[plans.length - 1]![2] !== p[2]) plans.push(p);
  }
  // repath 0.5 s = 5 ticks: the retarget waits for tick 1 + 5 (then it arrives: done resets the plan).
  assert.deepEqual(plans.slice(0, 2), [
    [1, 1, 1],
    [11, 1, 6],
  ]);
});

test('investigate: an unreachable noise fires done through the failed goto', () => {
  const w = world(['#########', '#@..#...#', '#...#.e.#', '#.n.#...#', '#########']);
  const npc = npcOf(w);
  const [a] = ears(w);
  shout(w, [[a!, 30]]); // tick 0
  w.step(); // tick 1: go, goto fails
  assert.equal(stateOf(npc), 'go');
  assert.equal(npc.lastGoto!.ok, false);
  w.step(); // tick 2: done
  assert.equal(stateOf(npc), 'back');
});

test('investigate: an entity that never heard anything fires done', () => {
  const w = world(['#######', '#@..m.#', '#######']);
  const npc = npcOf(w, 't:eager');
  assert.equal(stateOf(npc), 'go');
  w.step();
  assert.equal(stateOf(npc), 'go');
  w.step();
  assert.equal(stateOf(npc), 'back');
  assert.deepEqual([npc.x, npc.y], [4, 1]);
});

// ── Real packs ──────────────────────────────────────────────────────────────

function game(name: keyof typeof GAMES, seed = 1): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), seed);
}

const byHome = (w: World, x: number, y: number) => w.entities.find((e) => e.homeX === x && e.homeY === y)!;
const T = (x: number, y: number) => genreCell('zombie', x, y);
const M = (x: number, y: number) => genreCell('vampire', x, y);

test('zombie: crunching over broken glass draws a shambler to the spot', () => {
  const w = game('zombie');
  const z = byHome(w, ...T(16, 10));
  assert.equal(z.archetype.id, 'zmb:shambler');
  assert.equal(w.grid.tileAt(...T(12, 6))!.id, 'zmb:glass');
  place(w.player, ...T(12, 6)); // the hallway of the north-west house, out of z's sight
  const seen: string[] = [];
  let end = -1;
  for (let t = 0; t < 200 && end < 0; t++) {
    w.step();
    const s = stateOf(z);
    if (seen[seen.length - 1] !== s) seen.push(s);
    if (s === 'chase' || (seen.includes('investigate') && cheb(z.x, z.y, ...T(12, 6)) <= 1)) end = t;
  }
  assert.ok(seen.includes('investigate'), `states: ${seen.join(' → ')}`);
  assert.ok(end >= 0, `never arrived: ${seen.join(' → ')} at ${z.x},${z.y}`);
});

test('zombie: winding up an alarm clock sets shamblers investigating', () => {
  const w = game('zombie');
  const item = w.def.ids.items['zmb:alarm_clock']!;
  add(w.player.inv!, item, 1, w.def.items[item]!.weight);
  place(w.player, ...T(12, 3)); // a bedroom, walled off from everyone
  for (let t = 0; t < 3; t++) w.step();
  assert.ok(w.entities.every((e) => e.heardTick === -1));
  w.queueAction({ kind: 'use', item: 'zmb:alarm_clock' });
  w.step();
  assert.equal(w.lastAction!.ok, true);
  assert.equal(w.noises.length, 1);
  assert.equal(w.noises[0]!.radius, 20);
  w.step();
  const investigating = w.entities.filter((e) => e.behavior && stateOf(e) === 'investigate');
  assert.ok(investigating.length >= 2, `only ${investigating.length} investigating`);
  assert.ok(byHome(w, ...T(16, 10)) && investigating.includes(byHome(w, ...T(16, 10))));
  assert.ok(w.player.inv!.stacks.some((s) => s.item === item), 'the clock is reusable');
});

test('vampire: creaky floorboards bring a bat over; it then returns to roost', () => {
  const w = game('vampire');
  const bat = byHome(w, ...M(3, 6));
  assert.equal(bat.archetype.id, 'vamp:bat');
  assert.equal(w.grid.tileAt(...M(8, 5))!.id, 'vamp:creaky');
  assert.ok(w.grid.tileAt(...M(8, 5))!.tags.includes('shade'));
  place(w.player, ...M(8, 5));
  const states: string[] = [];
  const track = () => {
    const s = stateOf(bat);
    if (states[states.length - 1] !== s) states.push(s);
  };
  for (let t = 0; t < 5; t++) {
    w.step();
    track();
  }
  assert.ok(states.includes('investigate') || states.includes('flee'), states.join(' → '));
  // The vampire leaves for the cellar.
  place(w.player, ...M(18, 11));
  for (let t = 0; t < 300 && !(states.length > 1 && stateOf(bat) === 'roost'); t++) {
    w.step();
    track();
  }
  assert.equal(stateOf(bat), 'roost', states.join(' → '));
  assert.ok(cheb(bat.x, bat.y, ...M(3, 6)) <= 3);
});

test('garden: hopping on the gravel path draws a napping cat over to investigate', () => {
  const w = game('garden');
  const cat = byHome(w, 14, 4);
  assert.equal(cat.archetype.id, 'gdn:cat');
  assert.equal(stateOf(cat), 'nap');
  assert.equal(w.grid.tileAt(8, 7)!.id, 'gdn:gravel');
  assert.ok(w.grid.tileAt(8, 7)!.tags.includes('crunchy'));
  place(w.player, 8, 7); // within earshot (7) but too far to be seen (5)
  const seen: string[] = [];
  let end = -1;
  for (let t = 0; t < 200 && end < 0; t++) {
    w.step();
    if (t === 2) assert.ok(w.noises.length > 0 || cat.heardTick >= 0, 'the gravel crunches');
    const s = stateOf(cat);
    if (seen[seen.length - 1] !== s) seen.push(s);
    if (s === 'chase' || (seen.includes('investigate') && cheb(cat.x, cat.y, 8, 7) <= 1)) end = t;
  }
  assert.equal(seen[0], 'nap');
  assert.ok(seen.includes('investigate'), `states: ${seen.join(' → ')}`);
  assert.ok(end >= 0, `never arrived: ${seen.join(' → ')} at ${cat.x},${cat.y}`);
  // Grass is quiet.
  const q = game('garden');
  place(q.player, 8, 6);
  for (let t = 0; t < 20; t++) {
    q.step();
    assert.equal(q.noises.length, 0);
  }
});

// ── Determinism ─────────────────────────────────────────────────────────────

function run(name: keyof typeof GAMES, seed: number, ticks: number): { w: World; noisy: number } {
  const w = game(name, seed);
  if (name === 'zombie') {
    const item = w.def.ids.items['zmb:alarm_clock']!;
    add(w.player.inv!, item, 1, w.def.items[item]!.weight);
    place(w.player, ...T(8, 8));
  } else if (name === 'garden') place(w.player, 8, 7);
  else place(w.player, ...M(8, 5));
  const input = new Rng(seed ^ 0x5eed);
  let noisy = 0;
  for (let t = 0; t < ticks; t++) {
    const r = input.next();
    if (r < 0.3) {
      const dx = (Math.floor(input.next() * 3) - 1) as -1 | 0 | 1;
      const dy = (Math.floor(input.next() * 3) - 1) as -1 | 0 | 1;
      w.queueIntent({ kind: 'step', dx, dy });
    } else if (name === 'zombie' && r > 0.995) w.queueAction({ kind: 'use', item: 'zmb:alarm_clock' });
    w.step();
    if (w.noises.length > 0) noisy++;
  }
  return { w, noisy };
}

test('determinism: noise and hearing on every genre ⇒ same hash and snapshot (1200 ticks)', () => {
  for (const name of ['zombie', 'vampire', 'garden'] as const) {
    const a = run(name, 7, 1200);
    const b = run(name, 7, 1200);
    assert.ok(a.noisy > 0, `${name}: no noise`);
    assert.equal(a.w.hash(), b.w.hash());
    assert.deepEqual(a.w.snapshot(), b.w.snapshot());
    assert.ok(a.w.entities.some((e) => e.behavior && e.heardTick >= 0), `${name}: nobody heard anything`);
  }
});
