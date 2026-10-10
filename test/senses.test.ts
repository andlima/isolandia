import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSource, type ExprContext, type Value } from '../src/core/expr/index.ts';
import { formatError, lineOfSight, loadPacks, loadPacksOrThrow, SAVE_VERSION, World, type Definition, type Entity, type LoadError, type PackSource, type SaveFile } from '../src/core/index.ts';
import { hoverInfo } from '../src/web/menu.ts';
import { assertRoundTrip, fixture, loadFixture } from './helpers.ts';

// NPC perception (spec `npc-perception`): `senses.sight` on archetypes, the
// senses step, `self.sees` / `self.seen` with `none`, `conceals` statuses,
// behavior-level any-state transitions, save version 8 and the hover line.

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// A 30×9 open room. Entities are placed by the tests (`place`), so the map
// only needs spawns: w = watcher (sees `living`/`prey`, notice 8, lose 12),
// p = prey, r = rock, k = talker (a dialogue reading `npc.sees`).

interface Opts {
  /** Extra archetype entries. */
  npcs?: string;
  behaviors?: string;
  /** Extra lines under `start:`. */
  start?: string;
  rows?: readonly string[];
  /** Extra legend lines. */
  legend?: string;
  /** Second floor rows (then the map has two floors). */
  floor1?: readonly string[];
  extra?: Record<string, string>;
}

/** A 30-wide room row with the given characters at the given columns (1–28). */
const row = (cells: Record<number, string> = {}): string => `#${Array.from({ length: 28 }, (_, i) => cells[i + 1] ?? '.').join('')}#`;
const WALL = '#'.repeat(30);
/** Player at (1, 4), watcher at (13, 4), prey at (23, 4), rock at (27, 1). */
const ROWS = [WALL, row({ 27: 'r' }), row(), row(), row({ 1: '@', 13: 'w', 23: 'p' }), row(), row(), row(), WALL];
/** `ROWS` with row `y` replaced. */
const rowsWith = (...rows: [number, string][]): string[] => ROWS.map((r, i) => rows.find(([y]) => y === i)?.[1] ?? r);

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: fence, label: Fence, glyph: "|", color: gray, walkable: false, edge: true }
  - { id: pane, label: Pane, glyph: "=", color: cyan, walkable: false, opaque: false, edge: true }
  - { id: curtain, label: Curtain, glyph: "~", color: red, walkable: true, opaque: true, edge: true }
`;

function files(o: Opts = {}): Record<string, string> {
  const rows = o.rows ?? ROWS;
  const map = o.floor1
    ? `    floors:\n      - rows: ${JSON.stringify(rows)}\n      - rows: ${JSON.stringify(o.floor1)}\n`
    : `    rows: ${JSON.stringify(rows)}\n`;
  return {
    'tiles.yaml': TILES,
    'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, tags: [living], measurements: [hp, food], ticks_per_turn: 0, ticks_per_step: 1 }
  - { id: watcher, label: Watcher, glyph: w, color: red, tags: [npc], ticks_per_turn: 0, senses: { sight: { notice: 8, lose: 12, targets: [living, prey] } } }
  - { id: prey, label: Prey, glyph: p, color: green, tags: [prey], ticks_per_turn: 0 }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
  - { id: talker, label: Talker, glyph: k, color: white, tags: [npc], ticks_per_turn: 0, dialogue: chat, senses: { sight: { notice: 4, lose: 6, targets: [living] } } }
${o.npcs ?? ''}`,
    'things.yaml': `items:
  - { id: coin, label: Coin, glyph: "$", color: yellow, weight: 0.1, tags: [shiny] }
statuses:
  - { id: calm, label: Calm, when: false }
  - { id: cloaked, label: Cloaked, for: 'self.has_tag("living")', when: 'self.food < 10', conceals: true, hud: { tone: good } }
actions:
  - { id: rest, label: Rest, target: self, duration: 2, effects: [{ apply: { hp: 1 } }] }
factions:
  - { id: guild, label: Guild, reputation: -80 }
dialogues:
  - id: chat
    start: hi
    nodes:
      hi:
        text: Hm?
        choices:
          - { text: You saw me, when: 'npc.sees', to: end }
          - { text: Bye, to: end }
`,
    'behaviors.yaml': `behaviors:\n${o.behaviors ?? '  - { id: none, initial: a, states: { a: { do: idle } } }\n'}`,
    'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "@": { tile: floor, player: true }
      "w": { tile: floor, spawn: watcher }
      "p": { tile: floor, spawn: prey }
      "r": { tile: floor, spawn: rock }
${o.legend ?? ''}${map}start:
  map: room
  player: hero
${o.start ?? ''}`,
    ...o.extra,
  };
}

function world(o: Opts = {}, seed = 1): World {
  return World.create(loadFixture(files(o)), seed);
}

function errorsOf(o: Opts): readonly LoadError[] {
  const r = loadPacks([fixture(files(o))]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}\ngot:\n${errors.map(formatError).join('\n')}`);
}

/** A mod pack `m` over the fixture with one content file. */
function mod(yaml: string): PackSource {
  return { label: 'm', files: { 'pack.yaml': 'namespace: m\nname: M\nversion: 1.0.0\nkind: mod\ndepends: [t]\n', 'mod.yaml': yaml } };
}

function place(e: Entity, x: number, y: number, z = 0): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
  e.z = e.fromZ = z;
}

const byId = (w: World, id: string): Entity => w.entities.find((e) => e.archetype.id === `t:${id}`)!;
const stateOf = (e: Entity) => e.behavior!.states[e.state]!.name;
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Evaluate an expression as the world would, with `self` (and an optional `npc`). */
function evaluate(w: World, source: string, self: Entity, npc: Entity | null = null): Value {
  const d = w.def;
  const ids = (table: Readonly<Record<string, number>>, what: string) => (ref: string) => {
    const k = table[ref.includes(':') ? ref : `t:${ref}`];
    return k === undefined ? { error: `unknown ${what} '${ref}'` } : { index: k };
  };
  const r = compileSource(source, {
    resolveMeasurement: ids(d.ids.measurements, 'measurement'),
    resolveStatus: ids(d.ids.statuses, 'status'),
    resolveItem: ids(d.ids.items, 'item'),
    resolveItemTag: () => ({ flags: Uint8Array.from(d.items, () => 1) }),
    resolveBounds: (ref) => {
      const k = d.ids.measurements[ref.includes(':') ? ref : `t:${ref}`];
      return k === undefined ? { error: `unknown measurement '${ref}'` } : { index: k, bounds: () => d.measurements[k]! };
    },
    resolveAction: ids(d.ids.actions, 'action'),
    resolveFaction: ids(d.ids.factions, 'faction'),
    npc: npc !== null,
  });
  assert.deepEqual(r.errors, [], source);
  const ctx: ExprContext = {
    self,
    player: w.player,
    npc,
    tick: w.tick,
    ticksPerSecond: d.ticksPerSecond,
    clock: d.clock,
    random: () => 0,
    tileIdAt: () => '',
    tileTagsAt: () => new Set(),
    exposed: () => false,
    inRoom: () => false,
    los: (x0, y0, x1, y1, z0, z1) => lineOfSight(w.grid, x0, y0, x1, y1, z0, z1),
    warn: () => {},
    entities: w.entities,
    vars: w.vars,
    questStage: w.questStage,
    questEnd: w.questEnd,
    journalHas: w.journalHas,
    factions: w.factionTable,
  };
  return r.expr.fn(ctx);
}

/** Compile errors of an expression in the fixture's scope. */
function compileErrors(w: World, source: string, npc = false): string[] {
  const d = w.def;
  const r = compileSource(source, {
    resolveMeasurement: (ref) => {
      const k = d.ids.measurements[`t:${ref}`];
      return k === undefined ? { error: `unknown measurement '${ref}'` } : { index: k };
    },
    npc,
  });
  return r.errors.map((e) => e.message);
}

// ── Loader ──────────────────────────────────────────────────────────────────

test('loader: senses, conceals and the behavior on list parse; without them the fields are null, false and empty', () => {
  const def = loadFixture(
    files({
      behaviors: `  - id: b
    initial: a
    on:
      - { when: 'self.sees', to: c }
      - { when: 'world.is_day', to: a, except: [b, c] }
    states:
      a: { do: idle }
      b: { do: idle }
      c: { do: idle }
`,
    }),
  );
  const arch = (id: string) => def.archetypes[def.ids.archetypes[`t:${id}`]!]!;
  assert.deepEqual(arch('watcher').senses, { notice: 8, lose: 12, notice2: 64, lose2: 144, targetTags: ['living', 'prey'] });
  assert.equal(arch('hero').senses, null);
  assert.equal(arch('rock').senses, null);
  const status = (id: string) => def.statuses[def.ids.statuses[`t:${id}`]!]!;
  assert.equal(status('cloaked').conceals, true);
  assert.equal(status('calm').conceals, false);
  const b = def.behaviors[def.ids.behaviors['t:b']!]!;
  assert.equal(b.on.length, 2);
  assert.equal(b.on[0]!.to, 2);
  assert.deepEqual([...b.on[0]!.except], [0, 0, 0]);
  assert.equal(b.on[1]!.to, 0);
  assert.deepEqual([...b.on[1]!.except], [0, 1, 1]);
  assert.equal(typeof b.on[0]!.when, 'function');
  // Entities keep `seen` at creation: the watcher is 12 cells from the player, out of `notice`.
  const w = World.create(def, 1);
  assert.equal(byId(w, 'watcher').seen, -1);
  assert.equal(w.player.seen, -1);
});

test('loader: every senses error has its path; lose < notice, ranges, targets, unknown keys, not a mapping', () => {
  const npc = (senses: string, id = 'bad') => `  - { id: ${id}, label: B, glyph: b, color: red, ticks_per_turn: 0, senses: ${senses} }\n`;
  const A = 'archetypes[5]';
  let errors = errorsOf({ npcs: npc('{ sight: { notice: 8, lose: 6, targets: [living] } }') });
  expectError(errors, `${A}.senses.sight.lose`, /'lose' \(6\) must be at least 'notice' \(8\)/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 0, lose: 6, targets: [living] } }') });
  expectError(errors, `${A}.senses.sight.notice`, /'notice' must be a number > 0, got 0/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: -2, lose: 6, targets: [living] } }') });
  expectError(errors, `${A}.senses.sight.notice`, /must be a number > 0, got -2/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 2, lose: 6, targets: [] } }') });
  expectError(errors, `${A}.senses.sight.targets`, /must list at least one archetype tag/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 2, lose: 6 } }') });
  expectError(errors, `${A}.senses.sight`, /missing required field 'targets'/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 2, lose: 6, targets: [Living] } }') });
  expectError(errors, `${A}.senses.sight.targets[0]`, /invalid tag 'Living': tags must match/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 2, lose: 6, targets: [livin, prey] } }') });
  expectError(errors, `${A}.senses.sight.targets[0]`, /no archetype carries the tag 'livin' \(did you mean 'living'\?\)/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 2, lose: 6, targets: [living], cone: 90 } }') });
  expectError(errors, `${A}.senses.sight.cone`, /unknown sight field 'cone'/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: 2, lose: 6, targets: [living] }, smell: 3 }') });
  expectError(errors, `${A}.senses.smell`, /unknown senses field 'smell'/);
  errors = errorsOf({ npcs: npc('{}') });
  expectError(errors, `${A}.senses`, /missing required field 'sight'/);
  errors = errorsOf({ npcs: npc('8') });
  expectError(errors, `${A}.senses`, /field 'senses' must be a mapping, got number/);
  errors = errorsOf({ npcs: npc('{ sight: { notice: two, lose: 6, targets: [living] } }') });
  expectError(errors, `${A}.senses.sight.notice`, /must be a number, got string/);
});

test('loader: conceals must be a boolean; the behavior on list checks to, except and keys', () => {
  let errors = errorsOf({ extra: { 'bad.yaml': `statuses:\n  - { id: x, label: X, when: false, conceals: yes }\n` } });
  expectError(errors, 'statuses[0].conceals', /'conceals' must be a boolean/);
  errors = errorsOf({
    behaviors: `  - id: b
    initial: a
    on:
      - { when: 'self.sees', to: cc }
      - { when: 'self.sees', to: c, except: [bb] }
      - { when: 'self.sees', to: c, except: [c] }
      - { when: 'self.sees', to: c, unless: a }
      - { to: c }
      - 5
    states:
      a: { do: idle }
      b: { do: idle }
      c: { do: idle }
`,
  });
  const B = 'behaviors[0].on';
  expectError(errors, `${B}[0].to`, /unknown state 'cc' in behavior 't:b' \(did you mean 'c'\?\)/);
  expectError(errors, `${B}[1].except[0]`, /unknown state 'bb' in behavior 't:b' \(did you mean 'b'\?\)/);
  expectError(errors, `${B}[2].except[0]`, /'except' lists the transition's own 'to' state 'c'/);
  expectError(errors, `${B}[3].unless`, /unknown transition field 'unless'/);
  expectError(errors, `${B}[4]`, /missing required field 'when'/);
  expectError(errors, `${B}[5]`, /transitions must be mappings/);
});

test('loader: senses, conceals and on are ordinary fields for overrides: replaced whole, cleared with null; on: [] is the same as none', () => {
  const base = fixture(
    files({
      behaviors: `  - id: b
    initial: a
    on: [{ when: 'self.sees', to: c }]
    states: { a: { do: idle }, c: { do: idle } }
  - id: e
    initial: a
    on: []
    states: { a: { do: idle } }
`,
    }),
  );
  const plain = loadPacksOrThrow([base]);
  assert.deepEqual(plain.behaviors[plain.ids.behaviors['t:e']!]!.on, []);
  const r = loadPacks([
    base,
    mod(`archetypes:
  - { id: t:watcher, override: true, senses: { sight: { notice: 3, lose: 3, targets: [prey] } } }
  - { id: t:talker, override: true, senses: null }
  - { id: t:rock, override: true, senses: { sight: { notice: 1, lose: 2, targets: [npc] } } }
statuses:
  - { id: t:cloaked, override: true, conceals: null }
  - { id: t:calm, override: true, conceals: true }
behaviors:
  - { id: t:b, override: true, on: [] }
  - { id: t:e, override: true, on: [{ when: 'world.is_day', to: a, except: [] }] }
`),
  ]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const def = r.definition;
  const arch = (id: string) => def.archetypes[def.ids.archetypes[`t:${id}`]!]!;
  assert.deepEqual(arch('watcher').senses, { notice: 3, lose: 3, notice2: 9, lose2: 9, targetTags: ['prey'] });
  assert.equal(arch('talker').senses, null);
  assert.deepEqual(arch('rock').senses?.targetTags, ['npc']);
  assert.equal(def.statuses[def.ids.statuses['t:cloaked']!]!.conceals, false);
  assert.equal(def.statuses[def.ids.statuses['t:calm']!]!.conceals, true);
  assert.deepEqual(def.behaviors[def.ids.behaviors['t:b']!]!.on, []);
  // `except: []` is skipped nowhere but in `to` itself: the entry is in but its flags are all 0.
  const e = def.behaviors[def.ids.behaviors['t:e']!]!;
  assert.equal(e.on.length, 1);
  assert.deepEqual([...e.on[0]!.except], [0]);
  assert.deepEqual(
    def.patches.map((p) => [p.domain, p.id, p.fields.join(',')]),
    [
      ['archetypes', 't:watcher', 'senses'],
      ['archetypes', 't:talker', 'senses'],
      ['archetypes', 't:rock', 'senses'],
      ['statuses', 't:cloaked', 'conceals'],
      ['statuses', 't:calm', 'conceals'],
      ['behaviors', 't:b', 'on'],
      ['behaviors', 't:e', 'on'],
    ],
  );
});

test('loader: the player archetype may have senses, and a targets tag the player alone carries counts', () => {
  const def = loadFixture(
    files({
      extra: {
        'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, tags: [living, me], measurements: [hp, food], ticks_per_turn: 0, senses: { sight: { notice: 5, lose: 5, targets: [prey] } } }
  - { id: fan, label: Fan, glyph: f, color: red, ticks_per_turn: 0, senses: { sight: { notice: 5, lose: 5, targets: [me] } } }
  - { id: watcher, label: Watcher, glyph: w, color: red, tags: [npc], ticks_per_turn: 0, senses: { sight: { notice: 8, lose: 12, targets: [living, prey] } } }
  - { id: prey, label: Prey, glyph: p, color: green, tags: [prey], ticks_per_turn: 0 }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
  - { id: talker, label: Talker, glyph: k, color: white, tags: [npc], ticks_per_turn: 0, dialogue: chat }
`,
      },
    }),
  );
  assert.deepEqual(def.archetypes[def.start.player]!.senses?.targetTags, ['prey']);
  const w = World.create(def, 1);
  const prey = byId(w, 'prey');
  place(prey, w.player.x + 3, w.player.y);
  w.step();
  assert.equal(w.player.seen, prey.id, 'the engine has no special player');
});

// ── Sense update ────────────────────────────────────────────────────────────

test('senses: noticed at notice (inclusive), kept out to lose, lost beyond it; re-noticed when back in range', () => {
  const w = world();
  const v = byId(w, 'watcher');
  const p = w.player;
  const at = (dx: number, dy = 0) => {
    place(p, v.x + dx, v.y + dy);
    w.step();
    return v.seen;
  };
  assert.equal(at(9), -1, '9 tiles: out of notice');
  assert.equal(at(8), p.id, 'exactly notice: euclidean range is inclusive');
  assert.equal(at(12), p.id, 'kept out to lose');
  assert.equal(at(13), -1, 'lost past lose');
  assert.equal(at(10), -1, 'within lose but not notice: not re-noticed');
  assert.equal(at(5, -3), p.id, 'euclidean 5.83');
  assert.equal(at(11, -3), p.id, 'euclidean 11.4: kept');
  assert.equal(at(12, -3), -1, 'euclidean 12.4: lost');
  // Nothing is ever seen by an entity without senses, and nothing sees a rock.
  assert.equal(p.seen, -1);
  place(byId(w, 'rock'), v.x + 1, v.y);
  w.step();
  assert.equal(v.seen, -1, 'a rock carries no targets tag');
});

test('senses: an opaque cell or edge between them loses the target at once; a see-through edge does not', () => {
  const w = world();
  const v = byId(w, 'watcher');
  const p = w.player;
  place(p, v.x + 4, v.y);
  w.step();
  assert.equal(v.seen, p.id);
  // A wall cell between them (2 cells off the watcher, on the line).
  const wall = w.def.ids.tiles['t:wall']!;
  const floor = w.def.ids.tiles['t:floor']!;
  w.grid.setTile(w.grid.index(v.x + 2, v.y, 0), wall);
  w.step();
  assert.equal(v.seen, -1, 'behind an opaque cell');
  w.step();
  assert.equal(v.seen, -1, 'not re-noticed through it either');
  w.grid.setTile(w.grid.index(v.x + 2, v.y, 0), floor);
  w.step();
  assert.equal(v.seen, p.id, 'noticed again once the wall is gone');
  // An opaque edge (a fence) on the west side of the cell next to the watcher.
  const fence = w.def.ids.tiles['t:fence']!;
  const pane = w.def.ids.tiles['t:pane']!;
  w.grid.setEdge(w.grid.index(v.x + 1, v.y, 0), 'w', fence);
  w.step();
  assert.equal(v.seen, -1, 'behind an opaque edge');
  w.grid.setEdge(w.grid.index(v.x + 1, v.y, 0), 'w', pane);
  w.step();
  assert.equal(v.seen, p.id, 'a see-through edge does not block');
});

test('senses: a conceals status hides the target from every sense the tick it enters, and it is re-noticed once it exits', () => {
  const w = world();
  const v = byId(w, 'watcher');
  const p = w.player;
  const cloaked = w.def.ids.statuses['t:cloaked']!;
  const food = w.def.ids.measurements['t:food']!;
  place(p, v.x + 3, v.y);
  w.step();
  assert.equal(v.seen, p.id);
  // Starving cloaks the hero: the status and the loss land in the same tick (senses run after statuses).
  p.m[food] = 5;
  w.step();
  assert.equal(p.st[cloaked], 1);
  assert.equal(v.seen, -1);
  w.step();
  assert.equal(v.seen, -1, 'not noticed while concealed');
  p.m[food] = 50;
  w.step();
  assert.equal(p.st[cloaked], 0);
  assert.equal(v.seen, p.id, 're-noticed the tick the status exits');
  // Concealment is not per observer: a second watcher archetype loses the hero too.
  const def2 = loadFixture(files({ legend: '      "x": { tile: floor, spawn: other }\n', rows: rowsWith([2, row({ 6: 'x' })]), npcs: `  - { id: other, label: Other, glyph: x, color: red, tags: [npc], ticks_per_turn: 0, senses: { sight: { notice: 8, lose: 12, targets: [living] } } }\n` }));
  const w2 = World.create(def2, 1);
  const o2 = byId(w2, 'other');
  const v2 = byId(w2, 'watcher');
  place(w2.player, v2.x - 3, v2.y - 1);
  w2.step();
  assert.equal(v2.seen, w2.player.id);
  assert.equal(o2.seen, w2.player.id);
  w2.player.m[food] = 5;
  w2.step();
  assert.equal(v2.seen, -1);
  assert.equal(o2.seen, -1);
});

test('senses: the nearest candidate wins, ties go to the lowest id, and a seen target is kept when a nearer one appears', () => {
  const w = world({ legend: '      "q": { tile: floor, spawn: prey }\n', rows: rowsWith([5, row({ 7: 'q' })]) });
  const v = byId(w, 'watcher');
  const [p1, p2] = w.entities.filter((e) => e.archetype.id === 't:prey');
  assert.ok(p1 && p2 && p1.id < p2.id);
  const p = w.player;
  place(p, 1, 1);
  place(p1, v.x + 5, v.y);
  place(p2, v.x + 2, v.y);
  w.step();
  assert.equal(v.seen, p2.id, 'the nearest');
  // Lost (out of range), then a tie at distance 3: the lowest id.
  place(p1, 1, 2);
  place(p2, 1, 3);
  w.step();
  assert.equal(v.seen, -1);
  place(p1, v.x - 3, v.y);
  place(p2, v.x + 3, v.y);
  w.step();
  assert.equal(v.seen, p1.id, 'tie → lowest id');
  // The player comes closer than the seen prey: the watcher keeps what it sees.
  place(p, v.x + 1, v.y);
  w.step();
  assert.equal(v.seen, p1.id);
  // The seen prey leaves: now the watcher switches to the player.
  place(p1, 1, 2);
  w.step();
  assert.equal(v.seen, p.id);
});

test('senses: a target on another floor is neither noticed nor kept; an entity never sees itself', () => {
  const w = world({ floor1: ROWS.map((r) => r.replace(/[@wpr]/g, '.')) });
  const v = byId(w, 'watcher');
  const p = w.player;
  place(p, v.x + 2, v.y, 1);
  w.step();
  assert.equal(v.seen, -1, 'upstairs, straight above: not noticed');
  place(p, v.x + 2, v.y, 0);
  w.step();
  assert.equal(v.seen, p.id);
  place(p, v.x + 2, v.y, 1);
  w.step();
  assert.equal(v.seen, -1, 'lost when it goes upstairs');
  // A sense whose targets include its own tag: two of them see each other, never themselves.
  const w2 = world({
    npcs: `  - { id: mirror, label: Mirror, glyph: m, color: red, tags: [npc, shiny_eyes], ticks_per_turn: 0, senses: { sight: { notice: 8, lose: 12, targets: [shiny_eyes] } } }\n`,
    legend: '      "m": { tile: floor, spawn: mirror }\n',
    rows: rowsWith([2, row({ 5: 'm', 8: 'm' })]),
  });
  const [m1, m2] = w2.entities.filter((e) => e.archetype.id === 't:mirror');
  assert.ok(m1 && m2);
  w2.step();
  assert.equal(m1.seen, m2.id);
  assert.equal(m2.seen, m1.id);
  place(m2, 27, 7);
  w2.step();
  assert.equal(m1.seen, -1, 'alone: it does not see itself');
  assert.equal(m2.seen, -1);
});

test('senses: a dormant entity keeps seen as it is and re-evaluates when it wakes', () => {
  const w = world({ start: '  simulation: { active_radius: 5 }\n' });
  const v = byId(w, 'watcher');
  const prey = byId(w, 'prey');
  const p = w.player;
  // Awake (4 from the player), seeing the prey.
  place(p, v.x - 4, v.y);
  place(prey, v.x + 2, v.y);
  w.step();
  assert.equal(v.seen, prey.id);
  // The player walks off: the watcher is dormant, the prey leaves, and the stale `seen` stays.
  place(p, 1, 1);
  place(prey, 1, 2);
  w.step();
  assert.ok(w.isDormant(v));
  assert.equal(v.seen, prey.id, 'kept while dormant');
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(v.seen, prey.id);
  // Awake again: re-evaluated and lost (the prey is far), then the player is noticed.
  place(p, v.x - 5, v.y);
  w.step();
  assert.equal(w.isDormant(v), false);
  assert.equal(v.seen, p.id, 'the stale prey is dropped and the player, 5 away, noticed in the same step');
  // Dormant with the player in notice range (7 > the active radius 5): nothing is noticed.
  const w2 = world({ start: '  simulation: { active_radius: 5 }\n' });
  const v2 = byId(w2, 'watcher');
  place(w2.player, v2.x - 7, v2.y);
  w2.step();
  assert.ok(w2.isDormant(v2));
  assert.equal(v2.seen, -1, 'a dormant entity does not sense');
});

test('senses: the senses step runs after the status update at creation too, and only non-dormant entities with a sense cost anything', () => {
  // Spawned 3 cells from the player: seen before the first tick.
  const w = world({ rows: ROWS.map((r, i) => (i === 4 ? '#@..w........................#' : r)) });
  assert.equal(byId(w, 'watcher').seen, w.player.id);
  assert.equal(w.tick, 0);
  assert.equal(w.snapshot().entities[byId(w, 'watcher').id]!.seen, w.player.id);
  assert.equal('seen' in w.snapshot().entities[w.player.id]!, false, 'omitted without senses');
});

// ── Expressions ─────────────────────────────────────────────────────────────

test('expressions: self.sees / self.seen, the function forms, == player, and members of the seen entity', () => {
  const w = world();
  const v = byId(w, 'watcher');
  const p = w.player;
  assert.equal(evaluate(w, 'self.sees', v), false);
  assert.equal(evaluate(w, 'sees(self)', v), false);
  assert.equal(evaluate(w, 'self.seen', v), null);
  assert.equal(evaluate(w, 'seen(self)', v), null);
  assert.equal(evaluate(w, 'player.sees', v), false, 'an entity without senses reads false');
  assert.equal(evaluate(w, 'player.seen', v), null);
  place(p, v.x + 3, v.y + 1);
  w.step();
  assert.equal(evaluate(w, 'self.sees', v), true);
  assert.equal(evaluate(w, 'sees(self)', v), true);
  assert.equal(evaluate(w, 'self.seen', v), p);
  assert.equal(evaluate(w, 'seen(self)', v), p);
  assert.equal(evaluate(w, 'self.seen == player', v), true);
  assert.equal(evaluate(w, 'self.seen != player', v), false);
  assert.equal(evaluate(w, 'self.seen.x', v), p.x);
  assert.equal(evaluate(w, 'self.seen.y', v), p.y);
  assert.equal(evaluate(w, 'self.seen.hp', v), 10);
  assert.equal(evaluate(w, 'self.seen.has_tag("living")', v), true);
  assert.equal(evaluate(w, 'has_tag(self.seen, "prey")', v), false);
  assert.equal(evaluate(w, 'chebyshev(self, self.seen)', v), 3);
  assert.equal(evaluate(w, 'euclidean(self, seen(self)) <= 4', v), true);
  assert.equal(evaluate(w, 'can_see(self, self.seen, 8)', v), true);
  assert.equal(evaluate(w, 'has_status(self.seen, "calm")', v), false);
  assert.equal(evaluate(w, 'self.seen.sees', v), false);
  assert.equal(evaluate(w, 'self.seen.seen', v), null);
  assert.equal(evaluate(w, 'sees(seen(self))', v), false);
  // Reads lag one tick behind positions: `seen` is what the last senses step set.
  place(p, 1, 1);
  assert.equal(evaluate(w, 'self.sees', v), true);
  w.step();
  assert.equal(evaluate(w, 'self.sees', v), false);
});

test('expressions: every built-in and member is total on none (AC 7 table)', () => {
  const w = world();
  const v = byId(w, 'watcher');
  assert.equal(v.seen, -1);
  const zero = ['self.seen.x', 'self.seen.y', 'self.seen.z', 'self.seen.hp', 'self.seen.food', 'self.seen.carry_weight', 'self.seen.carry_capacity', 'count_item(self.seen, "coin")', 'self.seen.count_item("coin")', 'count_tagged(self.seen, "shiny")', 'fraction(self.seen, "hp")', 'attitude(self, self.seen)', 'attitude(self.seen, player)'];
  for (const src of zero) assert.equal(evaluate(w, src, v), 0, src);
  const no = [
    'has_tag(self.seen, "living")',
    'self.seen.has_tag("living")',
    'has_status(self.seen, "calm")',
    'self.seen.has_status("calm")',
    'has_item(self.seen, "coin")',
    'has_tagged(self.seen, "shiny")',
    'in_faction(self.seen, "guild")',
    'busy(self.seen)',
    'self.seen.busy',
    'doing(self.seen, "rest")',
    'heard(self.seen, 1)',
    'self.seen.heard(1)',
    'sees(self.seen)',
    'self.seen.sees',
    'can_see(self, self.seen)',
    'can_see(self.seen, self, 5)',
    'can_see(self.seen, self.seen)',
    'hostile(self, self.seen)',
    'hostile(self.seen, player)',
    'friendly(self.seen, self)',
    'friendly(self, seen(self))',
  ];
  for (const src of no) assert.equal(evaluate(w, src, v), false, src);
  for (const src of ['manhattan(self, self.seen)', 'chebyshev(self, self.seen)', 'euclidean(self.seen, self)', 'chebyshev(self.seen, self.seen)']) assert.equal(evaluate(w, src, v), Infinity, src);
  assert.equal(evaluate(w, 'chebyshev(self, self.seen) <= 1', v), false);
  assert.equal(evaluate(w, 'chebyshev(self, self.seen) > 5', v), true);
  assert.equal(evaluate(w, 'self.seen.seen', v), null);
  assert.equal(evaluate(w, 'seen(self.seen)', v), null);
  assert.equal(evaluate(w, 'self.seen == player', v), false);
  assert.equal(evaluate(w, 'not self.sees', v), true);
  // Combined forms the packs use.
  assert.equal(evaluate(w, 'self.sees and chebyshev(self, self.seen) <= 1', v), false);
  assert.equal(evaluate(w, 'self.sees and hostile(self, self.seen)', v), false);
});

test('expressions: none is typed as an entity at load; errors name the member, the arity and the argument type', () => {
  const w = world();
  assert.deepEqual(compileErrors(w, 'self.seen.x + 1'), []);
  assert.deepEqual(compileErrors(w, 'hostile(self, self.seen)'), []);
  assert.deepEqual(compileErrors(w, 'npc.sees', true), []);
  assert.deepEqual(compileErrors(w, 'npc.seen == player', true), []);
  assert.match(compileErrors(w, 'self.seen.nope')[0]!, /entity\.nope: unknown measurement 'nope'/);
  assert.match(compileErrors(w, 'tile.sees')[0]!, /unknown property 'tile\.sees'/);
  assert.match(compileErrors(w, 'sees()')[0]!, /sees\(\) takes 1 argument, got 0/);
  assert.match(compileErrors(w, 'seen(self, player)')[0]!, /seen\(\) takes 1 argument, got 2/);
  assert.match(compileErrors(w, 'sees(tile)')[0]!, /sees\(entity\) expects an entity, got tile/);
  assert.match(compileErrors(w, 'seen(3)')[0]!, /seen\(entity\) expects an entity, got number/);
  assert.match(compileErrors(w, 'self.seen + 1')[0]!, /operator '\+' expects numbers, got entity and number/);
  assert.match(compileErrors(w, 'npc.sees')[0]!, /'npc' is only available in dialogues/);
  assert.match(compileErrors(w, '(1).x')[0]!, /property access '\.x' is only allowed on an entity or on self, player, tile, world/);
});

test('expressions: npc.sees in a dialogue, and the pack-level reads (a system and a status on sees/seen)', () => {
  const w = world({
    legend: '      "k": { tile: floor, spawn: talker }\n',
    rows: rowsWith([4, row({ 1: '@', 2: 'k', 13: 'w', 23: 'p' })]),
    extra: {
      'rules.yaml': `statuses:
  - { id: watching, label: Watching, for: 'self.has_tag("npc")', when: 'self.sees and self.seen == player' }
systems:
  - { id: squeak, every: 0.1, for: 'self.has_tag("npc")', when: 'self.sees and chebyshev(self, self.seen) <= 1', effects: [{ type: noise, radius: 1 }] }
`,
    },
  });
  const k = byId(w, 'talker');
  const watching = w.def.ids.statuses['t:watching']!;
  assert.equal(k.seen, w.player.id, 'next to the player at creation');
  assert.equal(k.st[watching], 0, 'the status reads the seen of the previous update');
  w.step();
  assert.equal(k.st[watching], 1);
  assert.ok(w.player.heardTick >= 0, 'the squeak next to the player landed');
  w.queueAction({ kind: 'talk', entity: k.id });
  w.step();
  assert.ok(w.conversation);
  assert.deepEqual(
    w.conversationView()!.choices.map((c) => c.text),
    ['You saw me', 'Bye'],
  );
  w.leaveConversation();
  // Out of its sight: the choice is hidden. The view reads `seen` after the
  // tick's senses step, so the player stands behind a curtain (a walkable,
  // opaque edge: in reach for talking, out of sight).
  place(w.player, 27, 7);
  w.step();
  assert.equal(k.seen, -1);
  place(w.player, k.x + 1, k.y);
  w.grid.setEdge(w.grid.index(k.x + 1, k.y, 0), 'w', w.def.ids.tiles['t:curtain']!);
  w.queueAction({ kind: 'talk', entity: k.id });
  w.step();
  assert.ok(w.conversation, JSON.stringify(w.lastAction));
  assert.equal(k.seen, -1);
  assert.deepEqual(w.conversationView()!.choices.map((c) => c.text), ['Bye']);
});

test('expressions: a behavior sees `sees` in the think phase after the tick that set it (one-tick lag)', () => {
  const w = world({
    behaviors: `  - id: alert
    initial: idle
    states:
      idle: { do: idle, on: [{ when: 'self.sees', to: alerted }] }
      alerted: { do: idle }
`,
    npcs: `  - { id: guard, label: Guard, glyph: g, color: red, tags: [npc], ticks_per_turn: 0, behavior: alert, senses: { sight: { notice: 8, lose: 12, targets: [living] } } }\n`,
    legend: '      "g": { tile: floor, spawn: guard }\n',
    rows: rowsWith([2, row({ 11: 'g' })]),
  });
  const g = byId(w, 'guard');
  assert.equal(stateOf(g), 'idle');
  place(w.player, g.x - 2, g.y);
  w.step();
  assert.equal(g.seen, w.player.id, 'set at the end of the tick');
  assert.equal(stateOf(g), 'idle', 'the think phase ran before');
  w.step();
  assert.equal(stateOf(g), 'alerted');
});

test('behaviors: pursue with a none target clears its path and waits; flee with none does nothing', () => {
  const w = world({
    behaviors: `  - id: hunt
    initial: chase
    states:
      chase: { do: pursue, target: self.seen }
  - id: scare
    initial: run
    states:
      run: { do: flee, target: self.seen }
`,
    npcs: `  - { id: hunter, label: Hunter, glyph: h, color: red, tags: [npc], ticks_per_turn: 0, ticks_per_step: 1, behavior: hunt, senses: { sight: { notice: 5, lose: 6, targets: [prey] } } }
  - { id: coward, label: Coward, glyph: c, color: red, tags: [npc], ticks_per_turn: 0, ticks_per_step: 1, behavior: scare, senses: { sight: { notice: 5, lose: 6, targets: [prey] } } }
`,
    legend: '      "h": { tile: floor, spawn: hunter }\n      "c": { tile: floor, spawn: coward }\n',
    rows: rowsWith([2, row({ 5: 'h' })], [6, row({ 5: 'c' })]),
  });
  const h = byId(w, 'hunter');
  const c = byId(w, 'coward');
  const prey = byId(w, 'prey');
  const hx = h.x;
  const cx = c.x;
  for (let i = 0; i < 5; i++) w.step();
  assert.deepEqual([h.x, c.x, h.path, h.intent, c.intent], [hx, cx, null, null, null], 'nothing in sight: nobody moves');
  // Prey in sight of both: the hunter walks, the coward backs off.
  place(prey, hx + 3, h.y);
  w.step();
  w.step();
  assert.ok(h.path || h.x !== hx, 'the hunter heads for the prey');
  place(prey, 1, 1);
  w.step();
  assert.equal(h.seen, -1);
  w.step();
  assert.equal(h.path, null, 'none: the path is cleared');
  place(prey, cx + 2, c.y);
  w.step();
  const far = c.x;
  w.step();
  assert.ok(c.x < far || c.intent !== null, 'the coward flees');
  place(prey, 1, 1);
  w.step();
  const stay = c.x;
  for (let i = 0; i < 5; i++) w.step();
  assert.equal(c.x, stay, 'none: flee does nothing');
});

// ── Any-state transitions ───────────────────────────────────────────────────

const ANY = `  - id: any
    initial: a
    on:
      - { when: 'self.has_tag("npc") and world.tick >= 3', to: b, except: [c] }
    states:
      a:
        do: idle
        on: [{ when: 'world.tick >= 3', to: c }]
      b:
        do: idle
        timeout: { after: 1, to: c }
      c:
        do: idle
        on: [{ when: 'world.tick >= 30', to: a }]
`;

function anyWorld(behaviors = ANY): { w: World; e: Entity } {
  const w = world({
    behaviors,
    npcs: `  - { id: bot, label: Bot, glyph: B, color: red, tags: [npc], ticks_per_turn: 0, behavior: any }\n`,
    legend: '      "B": { tile: floor, spawn: bot }\n',
    rows: rowsWith([2, row({ 5: 'B' })]),
  });
  return { w, e: byId(w, 'bot') };
}

test('any-state: the behavior on list is checked before the state own on; except skips it; one transition per tick', () => {
  const { w, e } = anyWorld();
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(stateOf(e), 'a');
  w.step(); // tick 3: both the any-state (→ b) and a's own (→ c) hold: the any-state wins.
  assert.equal(stateOf(e), 'b');
  assert.equal(e.stateTick, 3);
  // In b the any-state (to b) is skipped: no self-transition, the timer is not restarted, and the timeout fires.
  for (let i = 0; i < 9; i++) {
    w.step();
    assert.equal(stateOf(e), 'b');
    assert.equal(e.stateTick, 3, 'timer untouched');
  }
  w.step();
  assert.equal(stateOf(e), 'c', 'the timeout of the current state still counts while the any-state entry is skipped');
  assert.equal(e.stateTick, 13);
  // In c the any-state is excepted: it stays until c's own transition at tick 30.
  for (let i = 0; i < 16; i++) {
    w.step();
    assert.equal(stateOf(e), 'c');
  }
  w.step(); // tick 30: c → a (own), one transition only: not a → b in the same tick.
  assert.equal(stateOf(e), 'a');
  w.step(); // tick 31: a → b (any-state before a's own → c).
  assert.equal(stateOf(e), 'b');
});

test('any-state: the behavior on entries are checked in order, and an entry whose to is the current state is skipped (the timeout keeps counting)', () => {
  const { w, e } = anyWorld(`  - id: any
    initial: a
    on:
      - { when: 'world.tick >= 5', to: a }
      - { when: 'world.tick >= 5', to: b }
      - { when: 'world.tick >= 5', to: c }
    states:
      a:
        do: idle
        timeout: { after: 1, to: c }
      b:
        do: idle
        timeout: { after: 2, to: a }
      c: { do: idle }
`);
  for (let i = 0; i < 5; i++) w.step();
  assert.equal(stateOf(e), 'a');
  w.step(); // tick 5: entry 0 skipped (current), entry 1 fires.
  assert.equal(stateOf(e), 'b');
  assert.equal(e.stateTick, 5);
  w.step(); // tick 6: entry 0 (→ a) fires before b's timeout.
  assert.equal(stateOf(e), 'a');
  assert.equal(e.stateTick, 6);
  w.step();
  assert.equal(stateOf(e), 'b');
  // With a and b excepted everywhere, the skipped entries let a's timeout count.
  const { w: w2, e: e2 } = anyWorld(`  - id: any
    initial: a
    on:
      - { when: 'world.tick >= 0', to: a }
    states:
      a:
        do: idle
        timeout: { after: 1, to: c }
      c: { do: idle }
`);
  for (let i = 0; i < 10; i++) {
    w2.step();
    assert.equal(stateOf(e2), 'a');
    assert.equal(e2.stateTick, 0);
  }
  w2.step();
  assert.equal(stateOf(e2), 'c');
});

test('any-state: a transition clears the path, intent and plan like a state transition', () => {
  const { w, e } = anyWorld(`  - id: any
    initial: go
    on:
      - { when: 'world.tick >= 4', to: stop }
    states:
      go: { do: pursue, target: player }
      stop: { do: idle }
`);
  place(w.player, e.x + 6, e.y);
  for (let i = 0; i < 4; i++) w.step();
  assert.ok(e.path !== null || e.planTick >= 0, 'walking');
  w.step();
  assert.equal(stateOf(e), 'stop');
  assert.deepEqual([e.path, e.intent, e.planTick, e.stateTick], [null, null, -1, 4]);
});

// ── Saves ───────────────────────────────────────────────────────────────────

test('saves: version 8 writes seen only when set; a world where some entities see and others do not round-trips', () => {
  const w = world({ rows: rowsWith([4, row({ 1: '@', 4: 'w', 14: 'w' })]) });
  const [near, far] = w.entities.filter((e) => e.archetype.id === 't:watcher');
  assert.ok(near && far);
  w.step();
  assert.equal(near.seen, w.player.id);
  assert.equal(far.seen, -1);
  const s = w.save();
  assert.equal(s.version, 8);
  assert.equal(SAVE_VERSION, 8);
  assert.equal(s.state.entities[near.id]!.seen, w.player.id);
  assert.equal('seen' in s.state.entities[far.id]!, false, 'omitted when none');
  assert.equal('seen' in s.state.entities[w.player.id]!, false, 'omitted without senses');
  // `seen` is hashed: the same world with the watcher blinded hashes differently.
  const h = w.hash();
  near.seen = -1;
  assert.notEqual(w.hash(), h);
  near.seen = w.player.id;
  assert.equal(w.hash(), h);
  const copy = assertRoundTrip(w, (x) => x.tick === 12 && place(x.player, 20, 2), 40);
  assert.equal(copy.entities[near.id]!.seen, near.seen);
  assert.equal(near.seen, -1, 'the player walked out of sight during the round trip');
});

test('saves: a version 7 save loads with nothing seen, and the first tick notices again', () => {
  const w = world({ rows: rowsWith([4, row({ 1: '@', 4: 'w' })]) });
  const v = byId(w, 'watcher');
  w.step();
  assert.equal(v.seen, w.player.id);
  const old = viaJson(w.save()) as unknown as { version: number; state: { entities: Record<string, unknown>[] } };
  old.version = 7;
  for (const e of old.state.entities) delete e['seen'];
  const r = World.restore(w.def, old);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.world.entities[v.id]!.seen, -1);
  assert.equal(r.world.save().version, 8);
  r.world.step();
  assert.equal(r.world.entities[v.id]!.seen, w.player.id, 'noticed again on the first tick');
  // A version 7 save that (wrongly) carries `seen` ignores it.
  const stale = viaJson(w.save()) as unknown as { version: number };
  stale.version = 7;
  const r2 = World.restore(w.def, stale);
  assert.ok(r2.ok && r2.world.entities[v.id]!.seen === -1);
});

test('saves: a seen that is not an entity, the entity itself, or on an archetype without senses is a restore error with the path', () => {
  const w = world({ rows: rowsWith([4, row({ 1: '@', 4: 'w', 11: 'p' })]) });
  const v = byId(w, 'watcher');
  const rock = byId(w, 'rock');
  w.step();
  const tweak = (f: (s: SaveFile) => void): string[] => {
    const s = viaJson(w.save());
    f(s);
    const r = World.restore(w.def, s);
    assert.equal(r.ok, false, 'expected a restore error');
    return r.ok ? [] : r.errors;
  };
  const n = w.entities.length;
  assert.match(tweak((s) => (s.state.entities[v.id]!.seen = 99))[0]!, new RegExp(`^state\\.entities\\[${v.id}\\]\\.seen: seen entity 99 is not one of the ${n} entities$`));
  assert.match(tweak((s) => (s.state.entities[v.id]!.seen = v.id))[0]!, new RegExp(`^state\\.entities\\[${v.id}\\]\\.seen: entity ${v.id} cannot see itself$`));
  assert.match(tweak((s) => (s.state.entities[rock.id]!.seen = 0))[0]!, new RegExp(`^state\\.entities\\[${rock.id}\\]\\.seen: archetype 't:rock' has no senses, so it cannot see entity 0$`));
  assert.match(tweak((s) => (s.state.entities[v.id]!.seen = -1))[0]!, new RegExp(`^state\\.entities\\[${v.id}\\]\\.seen: `));
  assert.match(tweak((s) => ((s.state.entities[v.id]! as { seen: unknown }).seen = 'player'))[0]!, new RegExp(`^state\\.entities\\[${v.id}\\]\\.seen: `));
  // Not reported for the player's own `seen` key when valid: a sensing player saves and loads it.
  const sw = World.create(loadPacksOrThrow([fixture(files()), mod(`archetypes:\n  - { id: t:hero, override: true, senses: { sight: { notice: 30, lose: 30, targets: [prey] } } }\n`)]), 1);
  sw.step();
  assert.equal(sw.player.seen, byId(sw, 'prey').id);
  assertRoundTrip(sw, undefined, 5);
});

// ── Hover ───────────────────────────────────────────────────────────────────

test('hover: hoverInfo adds sees for an NPC whose seen is the player, nothing for other targets or NPCs without senses', () => {
  const w = world({ rows: rowsWith([4, row({ 1: '@', 4: 'w', 14: 'w', 20: 'p' })]) });
  const [near, far] = w.entities.filter((e) => e.archetype.id === 't:watcher');
  const prey = byId(w, 'prey');
  w.step();
  const info = (e: Entity) => hoverInfo(w, { kind: 'entity', x: e.x, y: e.y, z: e.z, entity: e });
  assert.deepEqual(info(near!), { title: 'Watcher', hint: '', cursor: 'default', sees: true });
  assert.deepEqual(info(far!), { title: 'Watcher', hint: '', cursor: 'default' });
  assert.deepEqual(info(prey), { title: 'Prey', hint: '', cursor: 'default' });
  assert.equal('sees' in info(w.player), false);
  // Seeing the prey, not the player: no line.
  place(prey, near!.x + 1, near!.y);
  place(w.player, 27, 7);
  w.step();
  assert.equal(near!.seen, prey.id);
  assert.equal('sees' in info(near!), false);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test('determinism: two runs with chasers and hiders reach the same hash; the snapshot is plain JSON', () => {
  const run = (): World => {
    const w = world({
      behaviors: `  - id: hunt
    initial: wait
    on: [{ when: 'self.sees', to: chase }]
    states:
      wait: { do: wander, radius: 4 }
      chase: { do: pursue, target: self.seen, on: [{ when: 'not self.sees', to: wait }] }
`,
      npcs: `  - { id: hunter, label: Hunter, glyph: h, color: red, tags: [npc], ticks_per_turn: 0, ticks_per_step: 2, behavior: hunt, senses: { sight: { notice: 6, lose: 9, targets: [living, prey] } } }\n`,
      legend: '      "h": { tile: floor, spawn: hunter }\n',
      rows: rowsWith([2, row({ 3: 'h', 9: 'h', 17: 'h' })]),
    });
    for (let t = 0; t < 300; t++) {
      if (t % 7 === 0) w.queueIntent({ kind: 'step', dx: 1, dy: t % 14 === 0 ? 1 : -1 });
      w.step();
    }
    return w;
  };
  const a = run();
  const b = run();
  assert.equal(a.hash(), b.hash());
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(viaJson(a.snapshot()), a.snapshot());
  assert.ok(a.entities.some((e) => e.seen >= 0), 'someone saw something');
  const def: Definition = a.def;
  assert.ok(def.archetypes.some((x) => x.senses));
});
