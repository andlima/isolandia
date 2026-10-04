import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatError, loadPacks, loadPacksOrThrow, Rng, World, type Entity, type GotoRecord, type LoadError } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { fixture, GAMES, loadFixture } from './helpers.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Opts {
  behaviors: string;
  /** Extra archetype lines (YAML list items). */
  npcs: string;
  rows: readonly string[];
  /** Extra legend lines. */
  legend?: string;
  /** Hero archetype extras (default `, ticks_per_step: 1`). */
  hero?: string;
  /** Extra lines under `start:`. */
  start?: string;
  extra?: Record<string, string>;
}

function files(o: Opts): Record<string, string> {
  return {
    'behaviors.yaml': `behaviors:\n${o.behaviors}`,
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, measurements: [hp, food]${o.hero ?? ', ticks_per_step: 1'} }
${o.npcs}`,
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
${o.legend ?? ''}    rows: ${JSON.stringify(o.rows)}
start:
  map: room
  player: hero
${o.start ?? ''}`,
    ...o.extra,
  };
}

function world(o: Opts, seed = 1): World {
  return World.create(loadFixture(files(o)), seed);
}

function errorsOf(extra: Record<string, string>): readonly LoadError[] {
  const r = loadPacks([fixture(extra)]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const pos = (e: Entity) => [e.x, e.y];
const stateOf = (e: Entity) => e.behavior!.states[e.state]!.name;

function place(e: Entity, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
}

/** 13×13 room, NPC `n` in the middle. */
const OPEN = ['#############', ...Array.from({ length: 11 }, (_, i) => (i === 5 ? '#@....n.....#' : '#...........#')), '#############'];
const NPC_LEGEND = '      "n": { tile: floor, spawn: npc }\n';

// ── Loader ──────────────────────────────────────────────────────────────────

test('loader: a valid behavior resolves states, targets and ticks; short and qualified references', () => {
  const def = loadFixture(
    files({
      behaviors: `  - id: hunter
    initial: roam
    states:
      roam:
        do: wander
        radius: 4
        on:
          - { when: "world.tick > 10", to: chase }
      chase:
        do: pursue
        target: player
        repath: 0.5
        on:
          - { when: false, to: back }
        timeout: { after: 2, to: back }
      back:
        do: home
        done: roam
      scared:
        do: flee
        target: "player"
      rest:
        do: idle
`,
      npcs: `  - { id: npc, label: N, glyph: n, color: red, behavior: hunter }
  - { id: npc2, label: N2, glyph: m, color: red, behavior: "t:hunter" }
  - { id: plain, label: P, glyph: p, color: red }
`,
      rows: ['#####', '#@..#', '#####'],
    }),
  );
  assert.equal(def.behaviors.length, 1);
  assert.deepEqual(def.ids.behaviors, { 't:hunter': 0 });
  const b = def.behaviors[0]!;
  assert.equal(b.id, 't:hunter');
  assert.equal(b.initial, 0);
  assert.deepEqual(
    b.states.map((s) => [s.name, s.index, s.activity]),
    [
      ['roam', 0, 'wander'],
      ['chase', 1, 'pursue'],
      ['back', 2, 'home'],
      ['scared', 3, 'flee'],
      ['rest', 4, 'idle'],
    ],
  );
  const [roam, chase, back, scared, rest] = b.states;
  assert.equal(roam!.radius, 4);
  assert.equal(roam!.on[0]!.to, 1);
  assert.equal(typeof roam!.on[0]!.when, 'function');
  assert.equal(roam!.target, null);
  assert.equal(chase!.repath, 5);
  assert.equal(typeof chase!.target, 'function');
  assert.deepEqual(chase!.timeout, { afterTicks: 20, to: 2 });
  assert.equal(chase!.on[0]!.to, 2);
  assert.equal(back!.done, 0);
  assert.equal(typeof scared!.target, 'function');
  assert.equal(rest!.radius, null);
  assert.equal(rest!.repath, 10);
  assert.equal(rest!.timeout, null);
  const arch = (id: string) => def.archetypes[def.ids.archetypes[id]!]!;
  assert.equal(arch('t:npc').behavior, 0);
  assert.equal(arch('t:npc2').behavior, 0);
  assert.equal(arch('t:plain').behavior, null);
  assert.equal(arch('t:hero').behavior, null);
});

test('loader: behaviors reports every error class with its path', () => {
  const errors = errorsOf({
    'behaviors.yaml': `behaviors:
  - id: bad
    initial: nowhere
    colour: red
    states:
      a:
        do: pursue
      b:
        do: wander
        target: player
        radius: -1
        done: a
      c:
        do: flee
        target: "self.hp"
      d:
        do: sprint
      e:
        do: pursue
        target: player
        repath: 0.05
        wat: 1
      f:
        do: idle
        timeout: { after: 0, to: a }
        on:
          - { when: "true", to: zz }
          - { to: a }
      g:
        do: wander
        radius: 1.5
        repath: 1
      Bad-Name:
        do: idle
  - id: empty
    initial: x
    states: {}
  - id: noinit
    states:
      a: { do: idle }
`,
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, measurements: [hp, food] }
  - { id: rock, label: Rock, glyph: o, color: gray, behavior: missing }
`,
  });
  const B = 'behaviors[0]';
  expectError(errors, `${B}.initial`, /unknown state 'nowhere' in behavior 't:bad'/);
  expectError(errors, `${B}.colour`, /unknown behavior field 'colour'/);
  expectError(errors, `${B}.states.a`, /missing required field 'target'/);
  expectError(errors, `${B}.states.b.target`, /'target' is only allowed on 'pursue'\/'flee' states, not 'wander'/);
  expectError(errors, `${B}.states.b.radius`, /'radius' must be an integer ≥ 0, got -1/);
  expectError(errors, `${B}.states.b.done`, /'done' is only allowed on 'home'\/'investigate' states/);
  expectError(errors, `${B}.states.c.target`, /must be an entity or a tile, got number/);
  expectError(errors, `${B}.states.d.do`, /unknown activity 'sprint'.*expected one of idle, wander, pursue, flee, home/);
  expectError(errors, `${B}.states.e.repath`, /'repath' must be a whole number of ticks/);
  expectError(errors, `${B}.states.e.wat`, /unknown state field 'wat'/);
  expectError(errors, `${B}.states.f.timeout.after`, /'after' must be a number of sim seconds > 0, got 0/);
  expectError(errors, `${B}.states.f.on[0].to`, /unknown state 'zz'/);
  expectError(errors, `${B}.states.f.on[1]`, /missing required field 'when'/);
  expectError(errors, `${B}.states.g.radius`, /'radius' must be an integer ≥ 0, got 1.5/);
  expectError(errors, `${B}.states.g.repath`, /'repath' is only allowed on 'pursue'\/'investigate' states/);
  expectError(errors, `${B}.states["Bad-Name"]`, /invalid state name 'Bad-Name'/);
  expectError(errors, 'behaviors[1].states', /at least one state/);
  expectError(errors, 'behaviors[2]', /missing required field 'initial'/);
  expectError(errors, 'archetypes[1].behavior', /unknown behavior 'missing'/);
  // Errors carry a source line.
  assert.ok(errors.every((e) => e.file !== 'behaviors.yaml' || typeof e.line === 'number'));
});

// ── Activities ──────────────────────────────────────────────────────────────

test('idle never moves; a world without behavior-driven entities draws no RNG while thinking', () => {
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: idle } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    rows: OPEN,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  const rng = w.rng.state;
  for (let i = 0; i < 200; i++) w.step();
  assert.deepEqual(pos(n), [6, 6]);
  assert.equal(w.rng.state, rng);

  const plain = World.create(loadFixture(), 3);
  const before = plain.rng.state;
  assert.ok(plain.entities.length > 1 && plain.entities.every((e) => e.state === -1 && e.behavior === null));
  for (let i = 0; i < 200; i++) plain.step();
  assert.equal(plain.rng.state, before);
});

test('wander: stays within radius, respects walls and moves at ticks_per_step', () => {
  // A wall block inside the radius.
  const rows = OPEN.map((r, y) => (y === 5 ? '#....##.....#' : r));
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: wander, radius: 2 } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 3, behavior: b }\n',
    rows,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  assert.deepEqual([n.homeX, n.homeY], [6, 6]);
  let last = pos(n);
  let lastMove = -Infinity;
  let moves = 0;
  let far = 0;
  for (let t = 0; t < 1500; t++) {
    w.step();
    const p = pos(n);
    assert.ok(cheb(n.x, n.y, 6, 6) <= 2, `left radius at tick ${t}: ${p}`);
    assert.ok(w.grid.walkable(n.x, n.y));
    if (p[0] !== last[0] || p[1] !== last[1]) {
      assert.ok(cheb(p[0]!, p[1]!, last[0]!, last[1]!) === 1);
      assert.ok(t - lastMove >= 3, `moved again after ${t - lastMove} ticks`);
      lastMove = t;
      moves++;
      last = p;
    }
    if (cheb(n.x, n.y, 6, 6) === 2) far++;
  }
  assert.ok(moves > 150, `only ${moves} moves`);
  assert.ok(far > 0);
  // The walls at (5,5)/(6,5) were never entered.
  assert.ok(!w.grid.walkable(5, 5) && !w.grid.walkable(6, 5));
  assert.equal(w.player.x, 1);
});

test('transitions: first matching `on` wins, one transition per tick, timeout after exactly N ticks', () => {
  const w = world({
    behaviors: `  - id: b
    initial: a
    states:
      a:
        do: idle
        on:
          - { when: "world.tick >= 2", to: b }
          - { when: "world.tick >= 2", to: c }
      b:
        do: idle
        on:
          - { when: true, to: c }
      c:
        do: idle
        timeout: { after: 0.5, to: a }
        on:
          - { when: false, to: b }
`,
    npcs: '  - { id: npc, label: N, glyph: n, color: red, behavior: b }\n',
    rows: OPEN,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  const seen: [number, string, number][] = [];
  for (let t = 0; t < 12; t++) {
    w.step();
    seen.push([t, stateOf(n), n.stateTick]);
  }
  assert.deepEqual(seen, [
    [0, 'a', 0],
    [1, 'a', 0],
    [2, 'b', 2], // first match (b), not c
    [3, 'c', 3], // b → c on the next tick only
    [4, 'c', 3],
    [5, 'c', 3],
    [6, 'c', 3],
    [7, 'c', 3],
    [8, 'a', 8], // 5 ticks in c
    [9, 'b', 9],
    [10, 'c', 10],
    [11, 'c', 10],
  ]);
  assert.deepEqual(w.snapshot().entities[1]!.behavior, { state: 'c', since: 10, plan: null });
});

test('transitions: switching state clears the path and the pending intent', () => {
  const w = world({
    behaviors: `  - id: b
    initial: a
    states:
      a: { do: idle, on: [{ when: "world.tick >= 1", to: b }] }
      b: { do: idle }
`,
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    rows: OPEN,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  // Idle keeps an external goto.
  w.queueIntent({ kind: 'goto', x: 11, y: 11 }, n);
  w.step();
  assert.deepEqual(pos(n), [7, 7]);
  assert.ok(n.path);
  // Tick 1: a → b clears the path and this step intent before they apply.
  w.queueIntent({ kind: 'step', dx: -1, dy: 0 }, n);
  w.step();
  assert.equal(stateOf(n), 'b');
  assert.equal(n.path, null);
  assert.equal(n.intent, null);
  assert.deepEqual(pos(n), [7, 7]);
  for (let i = 0; i < 5; i++) w.step();
  assert.deepEqual(pos(n), [7, 7]);
});

test('pursue: reaches a moving target and re-plans at most once per repath window', () => {
  const rows = ['####################', '#@.................#', '#..................#', '#..................#', '#.................n#', '####################'];
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: pursue, target: player, repath: 0.5 } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    hero: ', ticks_per_step: 3',
    rows,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  const gotos: GotoRecord[] = [];
  let caught = -1;
  for (let t = 0; t < 80; t++) {
    // The player keeps walking east along row 1 (one tile per 3 ticks).
    w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
    w.step();
    if (n.lastGoto && gotos[gotos.length - 1] !== n.lastGoto) gotos.push(n.lastGoto);
    if (caught < 0 && cheb(n.x, n.y, w.player.x, w.player.y) <= 1) caught = t;
  }
  assert.ok(caught >= 0, 'never caught up');
  assert.ok(cheb(n.x, n.y, w.player.x, w.player.y) <= 1);
  assert.ok(gotos.length >= 2, 'never re-planned for the moving target');
  for (let i = 1; i < gotos.length; i++) assert.ok(gotos[i]!.tick - gotos[i - 1]!.tick >= 5, `re-planned after ${gotos[i]!.tick - gotos[i - 1]!.tick} ticks`);
  assert.ok(gotos.every((g) => g.ok));
  assert.deepEqual(w.snapshot().entities[1]!.behavior!.plan, [n.planX, n.planY, n.planTick]);
});

test('pursue: an unreachable target fails cleanly and waits for the next window', () => {
  // The player is sealed in the right pocket.
  const rows = ['########', '#n..#@.#', '#...#..#', '########'];
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: pursue, target: player } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    rows,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  const gotos = new Set<GotoRecord>();
  for (let t = 0; t < 30; t++) {
    w.step();
    if (n.lastGoto) gotos.add(n.lastGoto);
  }
  assert.deepEqual(pos(n), [1, 1]);
  assert.deepEqual(
    [...gotos].map((g) => [g.ok, g.tick]),
    [
      [false, 0],
      [false, 10],
      [false, 20],
    ],
  );
});

test('flee: every step strictly increases the distance, and it stops when cornered', () => {
  const rows = ['#########', '#.......#', '#.......#', '#@.n....#', '#.......#', '#.......#', '#########'];
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: flee, target: player } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    rows,
    legend: NPC_LEGEND,
  });
  const n = w.entities[1]!;
  const rng = w.rng.state;
  const d2 = () => (n.x - w.player.x) ** 2 + (n.y - w.player.y) ** 2;
  let d = d2();
  let moves = 0;
  let last = pos(n);
  for (let t = 0; t < 40; t++) {
    w.step();
    const p = pos(n);
    if (p[0] !== last[0] || p[1] !== last[1]) {
      assert.ok(d2() > d, `step at tick ${t} did not increase the distance`);
      moves++;
    }
    d = d2();
    last = p;
  }
  assert.ok(moves >= 4);
  // Cornered: the NE corner (ties break towards the earlier direction), and no neighbour is farther.
  assert.deepEqual(pos(n), [7, 1]);
  for (const [dx, dy] of [[-1, 0], [0, 1], [-1, 1]] as const) {
    assert.ok((n.x + dx - 1) ** 2 + (n.y + dy - 3) ** 2 <= d);
  }
  assert.equal(n.intent, null);
  assert.equal(w.rng.state, rng, 'flee draws no RNG');
});

test('home: walks back to the spawn cell, then fires done; a failed home path also fires done', () => {
  const opts: Opts = {
    behaviors: `  - id: b
    initial: back
    states:
      back: { do: home, done: rest }
      rest: { do: idle }
`,
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 2, behavior: b }\n',
    rows: ['###########', '#@...n....#', '#.........#', '#.........#', '########.##', '#.......#.#', '###########'],
    legend: NPC_LEGEND,
  };
  const w = world(opts);
  const n = w.entities[1]!;
  place(n, 9, 3);
  let arrived = -1;
  for (let t = 0; t < 60 && stateOf(n) === 'back'; t++) {
    w.step();
    if (arrived < 0 && n.x === 5 && n.y === 1) arrived = t;
  }
  assert.equal(stateOf(n), 'rest');
  assert.deepEqual(pos(n), [5, 1]);
  assert.ok(arrived >= 0 && n.stateTick === arrived + 1, `arrived ${arrived}, done at ${n.stateTick}`);
  assert.equal(n.lastGoto!.ok, true);
  assert.equal(n.lastGoto!.tick, 0);

  // (2,5) is walled off from home.
  const f = world(opts);
  const m = f.entities[1]!;
  place(m, 2, 5);
  f.step();
  assert.equal(stateOf(m), 'back');
  assert.equal(m.lastGoto!.ok, false);
  f.step();
  assert.equal(stateOf(m), 'rest');
  assert.equal(m.stateTick, 1);
  assert.deepEqual(pos(m), [2, 5]);
});

test('the player ignores a behavior on its archetype', () => {
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: wander } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    hero: ', ticks_per_step: 1, behavior: b',
    rows: OPEN,
    legend: NPC_LEGEND,
  });
  assert.equal(w.player.archetype.behavior, 0);
  assert.equal(w.player.behavior, null);
  assert.equal(w.player.state, -1);
  const n = w.entities[1]!;
  for (let i = 0; i < 100; i++) w.step();
  assert.deepEqual(pos(w.player), [1, 6]);
  assert.notDeepEqual(pos(n), [6, 6]);
  const snap = w.snapshot();
  assert.equal(snap.entities[0]!.behavior, null);
  assert.deepEqual(snap.entities[0]!.home, [1, 6]);
  assert.equal(snap.entities[1]!.behavior!.state, 's');
});

test('the think phase is skipped after defeat', () => {
  const w = world({
    behaviors: '  - { id: b, initial: s, states: { s: { do: wander, timeout: { after: 0.2, to: s } } } }\n',
    npcs: '  - { id: npc, label: N, glyph: n, color: red, ticks_per_step: 1, behavior: b }\n',
    rows: OPEN,
    legend: NPC_LEGEND,
    start: '  defeat: { when: "self.food < 50" }\n',
  });
  w.step();
  assert.ok(w.defeat);
  const n = w.entities[1]!;
  const before = JSON.stringify(w.snapshot());
  const rng = w.rng.state;
  for (let i = 0; i < 20; i++) w.step();
  assert.equal(w.rng.state, rng);
  assert.equal(n.stateTick, 0);
  assert.equal(JSON.stringify(w.snapshot()), before);
});

// ── Two-genre scenarios ─────────────────────────────────────────────────────

function game(name: keyof typeof GAMES, seed = 1): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), seed);
}

test('zombie: a shambler spots the survivor, chases them down, then searches and wanders again', () => {
  const w = game('zombie');
  const z = w.entities.find((e) => e.archetype.id === 'zmb:shambler' && e.x === 16 && e.y === 10)!;
  assert.ok(z);
  assert.equal(stateOf(z), 'wander');
  assert.ok(w.entities.filter((e) => e.archetype.id === 'zmb:crawler').every((e) => e.behavior?.id === 'zmb:shambler'));
  place(w.player, 22, 10);
  let adjacent = -1;
  for (let t = 0; t < 100 && adjacent < 0; t++) {
    w.step();
    if (stateOf(z) === 'chase' && cheb(z.x, z.y, w.player.x, w.player.y) <= 1) adjacent = t;
  }
  assert.ok(adjacent >= 0, 'never reached the survivor');
  assert.ok(w.hasStatus(z, 'zmb:alert'));
  assert.equal(w.value(w.player, 'std:hp'), 100, 'zombies do no damage yet');

  // Out of sight in a far house: chase → search → (5 s) → wander.
  place(w.player, 2, 18);
  const states: string[] = [];
  for (let t = 0; t < 80; t++) {
    w.step();
    if (states[states.length - 1] !== stateOf(z)) states.push(stateOf(z));
  }
  assert.deepEqual(states, ['chase', 'search', 'wander']);
  assert.equal(w.hasStatus(z, 'zmb:alert'), false);
});

test('vampire: a bat flees the vampire, then flies home and roosts', () => {
  const w = game('vampire');
  const bat = w.entities.find((e) => e.archetype.id === 'vamp:bat' && e.x === 3 && e.y === 6)!;
  assert.ok(bat);
  assert.equal(stateOf(bat), 'roost');
  assert.ok(w.entities.filter((e) => e.archetype.id === 'std:humanoid').every((e) => e.state === -1));
  place(w.player, 1, 6);
  const dist = () => Math.hypot(bat.x - w.player.x, bat.y - w.player.y);
  for (let t = 0; t < 5 && stateOf(bat) !== 'flee'; t++) w.step();
  assert.equal(stateOf(bat), 'flee');
  const start = dist();
  for (let t = 0; t < 20; t++) w.step();
  assert.ok(dist() > start, `distance ${dist()} did not grow from ${start}`);

  // The vampire leaves for the cellar, out of range.
  place(w.player, 18, 11);
  const states: string[] = [];
  for (let t = 0; t < 150; t++) {
    w.step();
    if (states[states.length - 1] !== stateOf(bat)) states.push(stateOf(bat));
  }
  assert.deepEqual(states, ['flee', 'return', 'roost']);
  assert.ok(cheb(bat.x, bat.y, 3, 6) <= 3);
});

test('garden: the cat chases a visible bunny and startles it, then gives up when it hides in a bush', () => {
  const w = game('garden');
  const cat = w.entities.find((e) => e.archetype.id === 'gdn:cat' && e.x === 14 && e.y === 4)!;
  assert.ok(cat);
  assert.equal(stateOf(cat), 'nap');
  place(w.player, 11, 4);
  let adjacent = -1;
  for (let t = 0; t < 60 && adjacent < 0; t++) {
    w.step();
    if (stateOf(cat) === 'chase' && cheb(cat.x, cat.y, w.player.x, w.player.y) <= 1) adjacent = t;
  }
  assert.ok(adjacent >= 0, 'never reached the bunny');
  let startled = false;
  for (let t = 0; t < 15; t++) {
    w.step();
    startled ||= w.hasStatus(w.player, 'gdn:startled');
  }
  assert.ok(startled, 'a meow right next to the bunny startles it');
  assert.equal(w.value(w.player, 'std:hp'), undefined, 'nothing to hurt');

  // Into the bush: the cat loses interest, walks home and naps.
  place(w.player, 12, 3);
  const states: string[] = [];
  for (let t = 0; t < 100; t++) {
    w.step();
    if (states[states.length - 1] !== stateOf(cat)) states.push(stateOf(cat));
  }
  assert.deepEqual(states, ['chase', 'home', 'nap']);
  assert.deepEqual([cat.x, cat.y], [14, 4]);
  assert.equal(w.hasStatus(w.player, 'gdn:startled'), false);
});

test('garden: a chase ends in boredom after a while, even with the bunny in plain view', () => {
  const w = game('garden');
  const cat = w.entities.find((e) => e.archetype.id === 'gdn:cat' && e.x === 14 && e.y === 4)!;
  place(w.player, 11, 4);
  const states: string[] = [];
  for (let t = 0; t < 200; t++) {
    w.step();
    if (states[states.length - 1] !== stateOf(cat)) states.push(stateOf(cat));
  }
  assert.deepEqual(states.slice(0, 4), ['nap', 'chase', 'bored', 'nap']);
});

test('garden: a butterfly flits away from the bunny, then drifts home to its flowers', () => {
  const w = game('garden');
  const fly = w.entities.find((e) => e.archetype.id === 'gdn:butterfly' && e.x === 7 && e.y === 1)!;
  assert.ok(fly);
  assert.equal(stateOf(fly), 'flutter');
  place(w.player, 5, 2);
  const dist = () => Math.hypot(fly.x - w.player.x, fly.y - w.player.y);
  for (let t = 0; t < 5 && stateOf(fly) !== 'flit'; t++) w.step();
  assert.equal(stateOf(fly), 'flit');
  const start = dist();
  for (let t = 0; t < 10; t++) w.step();
  assert.ok(dist() > start, `distance ${dist()} did not grow from ${start}`);
  place(w.player, 3, 13);
  const states: string[] = [];
  for (let t = 0; t < 150; t++) {
    w.step();
    if (states[states.length - 1] !== stateOf(fly)) states.push(stateOf(fly));
  }
  assert.equal(states[states.length - 1], 'flutter', states.join(' → '));
  assert.ok(states.includes('return'), states.join(' → '));
  assert.ok(cheb(fly.x, fly.y, 7, 1) <= 2);
});

// ── Determinism ─────────────────────────────────────────────────────────────

function run(name: keyof typeof GAMES, seed: number, ticks: number): { w: World; visited: Set<string> } {
  const w = game(name, seed);
  // Start next to the NPCs so chases and flights happen.
  if (name === 'zombie') place(w.player, 22, 10);
  else if (name === 'garden') place(w.player, 11, 5);
  else place(w.player, 4, 6);
  const input = new Rng(seed ^ 0xbe4a);
  const visited = new Set<string>();
  for (let t = 0; t < ticks; t++) {
    const r = input.next();
    if (r < 0.3) {
      const dx = (Math.floor(input.next() * 3) - 1) as -1 | 0 | 1;
      const dy = (Math.floor(input.next() * 3) - 1) as -1 | 0 | 1;
      w.queueIntent({ kind: 'step', dx, dy });
    }
    w.step();
    for (const e of w.entities) if (e.behavior) visited.add(stateOf(e));
  }
  return { w, visited };
}

test('determinism: behaviors on every genre ⇒ same hash and snapshot (1200 ticks)', () => {
  for (const name of ['zombie', 'vampire', 'garden'] as const) {
    const a = run(name, 99, 1200);
    const b = run(name, 99, 1200);
    assert.equal(a.w.hash(), b.w.hash());
    assert.deepEqual(a.w.snapshot(), b.w.snapshot());
    assert.deepEqual(JSON.parse(JSON.stringify(a.w.snapshot())), a.w.snapshot());
    assert.ok(a.visited.size >= 2, `${name}: only visited ${[...a.visited].join(', ')}`);
    assert.notEqual(run(name, 100, 300).w.hash(), run(name, 99, 300).w.hash());
  }
});
