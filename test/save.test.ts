import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from '../src/core/sim/containers.ts';
import { loadPacksOrThrow, Rng, unwrapSave, World, wrapSave, type Action, type Definition, type Entity, type SaveFile } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { assertRoundTrip, GAMES, loadFixture, type Script } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   ##############    c = crate (container, loot), s = stove (heat), W = window
//   #.@......i..o#    NPCs, one per behavior activity: i idle, w wander,
//   #cs.........W#    P pursue, F flee, H home, L investigate (after a noise);
//   #.......w....#    o = a rock (no measurements, no behavior)
//   #............#
//   #.......P..F.#
//   #...H.....L..#
//   ##############

const FILES: Record<string, string> = {
  'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: window, label: Window, glyph: W, color: cyan, walkable: false, opaque: false }
  - { id: boarded, label: Boarded window, glyph: B, color: gray, walkable: false }
  - { id: stove, label: Stove, glyph: s, color: red, walkable: false, tags: [heat] }
  - { id: crate, label: Crate, glyph: c, color: gray, walkable: false, container: { capacity: 20 } }
`,
  'things.yaml': `items:
  - { id: plank, label: Plank, glyph: "/", color: gray, weight: 1 }
  - { id: raw, label: Raw, glyph: "%", color: red, weight: 0.5 }
  - { id: cooked, label: Cooked, glyph: "u", color: yellow, weight: 0.5 }
  - id: bell
    label: Bell
    glyph: "o"
    color: yellow
    weight: 0.5
    use: { label: Ring, consume: 0, effects: [{ type: noise, radius: 30 }] }
  - id: bandage
    label: Bandage
    glyph: "+"
    color: white
    weight: 0.1
    use:
      label: Apply
      when: 'self.hp < 10'
      duration: 1
      effects:
        - { type: apply, measurement: hp, delta: 2 }
loot:
  - { id: stuff, rolls: [1, 3], entries: [{ item: plank, count: [1, 2] }, { item: raw }] }
distributions:
  - { container: crate, table: stuff }
actions:
  - id: board
    label: Board up
    target: { tiles: [window] }
    consume: { plank: 1 }
    duration: 1
    effects:
      - { type: set_tile, tile: boarded }
      - { type: noise, radius: 4 }
  - id: rest
    label: Rest
    target: self
    duration: 2
    effects:
      - { type: apply, measurement: hp, delta: 1 }
recipes:
  - id: cook
    label: Cooked
    verb: Cook
    station: { tags: [heat] }
    consume: { raw: 1 }
    produce: { cooked: 1 }
    duration: 1
behaviors:
  - id: still
    initial: stay
    states:
      stay: { do: idle }
  - id: roamer
    initial: roam
    states:
      roam: { do: wander, radius: 2 }
  - id: hunter
    initial: hunt
    states:
      hunt: { do: pursue, target: player }
  - id: coward
    initial: run
    states:
      run: { do: flee, target: player }
  - id: homer
    initial: back
    states:
      back: { do: home, done: roam }
      roam: { do: wander, radius: 1 }
  - id: listener
    initial: rest
    states:
      rest:
        do: idle
        on:
          - { when: 'heard(self, 1)', to: go }
      go:
        do: investigate
        repath: 0.5
        done: rest
`,
  'archetypes.yaml': `archetypes:
  - id: hero
    label: Hero
    glyph: "@"
    color: yellow
    measurements: [hp, food]
    ticks_per_step: 1
    inventory: { capacity: 20, items: { plank: 2, raw: 2, bell: 1, bandage: 1 } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
  - { id: still, label: Still, glyph: i, color: gray, behavior: still, measurements: [hp] }
  - { id: roamer, label: Roamer, glyph: w, color: gray, ticks_per_step: 2, behavior: roamer }
  - { id: hunter, label: Hunter, glyph: P, color: red, ticks_per_step: 3, behavior: hunter, inventory: { capacity: 5, items: { raw: 1 } } }
  - { id: coward, label: Coward, glyph: F, color: gray, ticks_per_step: 2, behavior: coward }
  - { id: homer, label: Homer, glyph: H, color: gray, ticks_per_step: 2, behavior: homer }
  - { id: listener, label: Listener, glyph: L, color: gray, ticks_per_step: 2, behavior: listener }
`,
  'map.yaml': `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "W": { tile: window }
      "s": { tile: stove }
      "c": { tile: crate }
      "@": { tile: floor, player: true }
      "o": { tile: floor, spawn: rock }
      "i": { tile: floor, spawn: still }
      "w": { tile: floor, spawn: roamer }
      "P": { tile: floor, spawn: hunter }
      "F": { tile: floor, spawn: coward }
      "H": { tile: floor, spawn: homer }
      "L": { tile: floor, spawn: listener }
    rows:
      - "##############"
      - "#.@......i..o#"
      - "#cs.........W#"
      - "#.......w....#"
      - "#............#"
      - "#.......P..F.#"
      - "#...H.....L..#"
      - "##############"
start:
  map: room
  player: hero
  defeat:
    when: 'self.hp <= 0'
    message: Down.
`,
};

const DEF: Definition = loadFixture(FILES);
const world = (seed = 1) => World.create(DEF, seed);

function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

function stepUntil(w: World, done: () => boolean, max = 200): void {
  for (let i = 0; i < max && !done(); i++) w.step();
  assert.ok(done(), `condition not reached within ${max} ticks (tick ${w.tick})`);
}

const byArchetype = (w: World, id: string) => w.entities.find((e) => e.archetype.id === id)!;
const activityOf = (e: Entity) => e.behavior!.states[e.state]!.activity;
const HP = DEF.ids.measurements['t:hp']!;

function teleport(e: Entity, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
  e.path = null;
  e.intent = null;
}

/** Bell rung, homer sent home from afar, cook started: activities, paths, plans, noises and a ground pile in one world. */
function rich(): World {
  const w = world();
  teleport(byArchetype(w, 't:homer'), 8, 4);
  w.queueAction({ kind: 'use', item: 't:bell' });
  w.queueAction({ kind: 'drop', item: 't:plank', count: 1 });
  steps(w, 3);
  w.queueAction({ kind: 'craft', recipe: 't:cook' });
  steps(w, 2);
  return w;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

test('snapshot: seed, nextContainer and changed tiles as [x, y, id], row-major', () => {
  const w = world(7);
  const s = w.snapshot();
  assert.equal(w.seed, 7);
  assert.equal(s.seed, 7);
  assert.equal(s.nextContainer, 3, 'the crate, then the hero and the hunter inventories');
  assert.deepEqual(s.tiles, []);
  w.grid.setTile(2 * w.grid.width + 12, DEF.ids.tiles['t:boarded']!);
  w.grid.setTile(1 * w.grid.width + 13, DEF.ids.tiles['t:floor']!);
  assert.deepEqual(w.snapshot().tiles, [
    [13, 1, 't:floor'],
    [12, 2, 't:boarded'],
  ]);
  assert.notEqual(world(7).hash(), world(8).hash(), 'the seed is hashed');
});

test('save: a plain JSON SaveFile with format, version, packs and map', () => {
  const w = world();
  const s = w.save();
  assert.equal(s.format, 'isolandia-save');
  assert.equal(s.version, 1);
  assert.deepEqual(s.packs, [{ namespace: 't', version: '1.0.0' }]);
  assert.deepEqual(s.map, { id: 't:room', width: 14, height: 8 });
  assert.deepEqual(s.state, w.snapshot());
  assert.deepStrictEqual(json(s), s, 'plain JSON');
  assert.deepEqual(Object.keys(s).sort(), ['format', 'map', 'packs', 'state', 'version'], 'no wall-clock time or other metadata');
});

test('save: pure — hash, RNG state and warnings are unchanged; works on an ended world', () => {
  const w = rich();
  const hash = w.hash();
  const rng = w.rng.state;
  const warnings = w.warnings.size;
  w.save();
  w.save();
  assert.equal(w.hash(), hash);
  assert.equal(w.rng.state, rng);
  assert.equal(w.warnings.size, warnings);
  w.player.m[HP] = 0;
  w.step();
  assert.ok(w.defeat);
  assert.equal(w.save().state.defeat!.message, 'Down.');
});

// ── Round trip on the fixture ───────────────────────────────────────────────

test('round trip: tick 0', () => {
  assertRoundTrip(world(), undefined, 100);
  assertRoundTrip(world(3), undefined, 100);
});

test('round trip: mid-path with a goto.then pending, then the action and set_tile', () => {
  const w = world();
  const intent = w.approachIntent({ kind: 'act', action: 't:board', x: 12, y: 2 })!;
  assert.ok(intent.then);
  w.queueIntent(intent);
  steps(w, 3);
  assert.ok(w.player.path && w.player.then, 'walking, with the action pending');
  assertRoundTrip(w, undefined, 5);
  stepUntil(w, () => w.player.activity !== null);
  assert.equal(w.player.activity!.source.kind, 'act');
  steps(w, 2);
  assertRoundTrip(w, undefined, 30);
  assert.deepEqual(w.snapshot().tiles, [[12, 2, 't:boarded']]);
  assertRoundTrip(w, undefined, 30);
});

test('round trip: mid-activity — a timed item use, a recipe and a self action', () => {
  const use = world();
  use.player.m[HP] = 5;
  use.queueAction({ kind: 'use', item: 't:bandage' });
  steps(use, 2);
  assert.equal(use.player.activity?.source.kind, 'use');
  assertRoundTrip(use, undefined, 20);
  assert.equal(use.value(use.player, 't:hp'), 7);

  const craft = world();
  craft.queueAction({ kind: 'craft', recipe: 't:cook' });
  steps(craft, 3);
  assert.equal(craft.player.activity?.source.kind, 'craft');
  assertRoundTrip(craft, undefined, 20);

  const rest = world();
  rest.queueAction({ kind: 'act', action: 't:rest' });
  steps(rest, 1);
  assert.equal(rest.player.activity?.source.kind, 'act');
  assertRoundTrip(rest, undefined, 30);
});

test('round trip: a ground pile created and removed — nextContainer survives', () => {
  const w = world();
  w.queueAction({ kind: 'drop', item: 't:raw', count: 1 });
  w.step();
  const pile = w.containersAt(w.player.x, w.player.y)[0]!;
  assert.equal(pile.kind, 'ground');
  w.queueAction({ kind: 'take', container: pile.id, item: 't:raw' });
  w.step();
  const s = w.snapshot();
  assert.ok(!s.containers.some((c) => c.kind === 'ground'));
  assert.equal(s.nextContainer, Math.max(...s.containers.map((c) => c.id)) + 2, 'not derivable from the live containers');
  // A new pile in both worlds gets the same, never reused, id.
  const t0 = w.tick;
  const drop: Script = (x) => {
    if (x.tick === t0 + 2) x.queueAction({ kind: 'drop', item: 't:plank', count: 1 });
  };
  const copy = assertRoundTrip(w, drop, 5);
  assert.equal(copy.containersAt(copy.player.x, copy.player.y)[0]!.id, pile.id + 1);
});

test('round trip: NPCs in every behavior activity, investigate after a noise', () => {
  const w = rich();
  const activities = new Set(w.entities.filter((e) => e.behavior).map(activityOf));
  assert.deepEqual([...activities].sort(), ['flee', 'home', 'idle', 'investigate', 'pursue', 'wander']);
  const listener = byArchetype(w, 't:listener');
  assert.ok(listener.heardTick >= 0 && listener.planTick >= 0 && listener.path, 'walking to the noise');
  assert.ok(byArchetype(w, 't:homer').path, 'walking home');
  assert.ok(w.player.activity, 'cooking');
  assertRoundTrip(w, undefined, 120);
});

test('round trip: after defeat', () => {
  const w = rich();
  w.player.m[HP] = 0;
  w.step();
  assert.ok(w.defeat);
  const copy = assertRoundTrip(w, undefined, 5);
  assert.ok(copy.ended);
});

// ── Round trip on the shipped genres ────────────────────────────────────────

const GENRES = Object.fromEntries(Object.entries(GAMES).map(([name, dirs]) => [name, loadPacksOrThrow(dirs.map((d) => readPack(d)))])) as Record<keyof typeof GAMES, Definition>;

/** Give the player `count` of an item (ignoring capacity). */
function give(w: World, item: number, count: number): void {
  add(w.player.inv!, item, count, w.def.items[item]!.weight);
}

/** Put the player on each walkable cell in turn until `ready()` holds; false if none. */
function placeUntil(w: World, ready: () => boolean): boolean {
  const { grid } = w;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    if (!grid.walkable(x, y)) continue;
    teleport(w.player, x, y);
    if (ready()) return true;
  }
  return false;
}

/** Start a timed activity of `kind` in a fresh world (items given, player placed); null when the genre has none that can start. */
function midActivity(def: Definition, kind: 'act' | 'use' | 'craft'): World | null {
  const timed = (d: { duration: { ticks: number; fn: unknown } }) => d.duration.fn !== null || d.duration.ticks > 0;
  const candidates: { requires: { item: number; count: number }[]; find: (w: World) => Action | null }[] = [];
  if (kind === 'act') {
    for (const a of def.actions.filter(timed)) {
      candidates.push({
        requires: [...a.tools.map((item) => ({ item, count: 1 })), ...a.consume],
        find: (w) => {
          const e = w.availableActions().find((x) => x.kind === 'act' && x.action === a.id && x.ok);
          return e ? (e.x !== undefined ? { kind: 'act', action: a.id, x: e.x, y: e.y! } : { kind: 'act', action: a.id }) : null;
        },
      });
    }
  } else if (kind === 'use') {
    for (const i of def.items.filter((x) => x.use && timed(x.use))) {
      candidates.push({ requires: [{ item: i.index, count: 1 }], find: (w) => (w.availableActions().some((x) => x.kind === 'use' && x.item === i.id && x.ok) ? { kind: 'use', item: i.id } : null) });
    }
  } else {
    for (const r of def.recipes.filter(timed)) {
      candidates.push({
        requires: [...r.tools.map((item) => ({ item, count: 1 })), ...r.consume],
        find: (w) => {
          const e = w.availableRecipes().find((x) => x.recipe === r.id && x.ok);
          return e ? (e.station ? { kind: 'craft', recipe: r.id, x: e.station.x, y: e.station.y } : { kind: 'craft', recipe: r.id }) : null;
        },
      });
    }
  }
  for (const c of candidates) {
    const w = World.create(def, 1);
    if (!w.player.inv) return null;
    for (const r of c.requires) give(w, r.item, r.count);
    // Measurements halfway, so `when: self.x < max` conditions hold.
    for (const idx of w.player.archetype.measurements) {
      const md = def.measurements[idx]!;
      const max = w.player.max[idx]!;
      if (Number.isFinite(max)) w.player.m[idx] = (md.min + max) / 2;
    }
    let action: Action | null = null;
    if (!placeUntil(w, () => (action = c.find(w)) !== null)) continue;
    w.queueAction(action!);
    w.step();
    w.step();
    if (w.player.activity?.source.kind === kind) return w;
  }
  return null;
}

for (const name of Object.keys(GAMES) as (keyof typeof GAMES)[]) {
  test(`round trip (${name}): tick 0, mid-path with goto.then, ground pile, end of game`, () => {
    const def = GENRES[name];
    assertRoundTrip(World.create(def, 1), undefined, 100);

    // Walk to the farthest container with something in it, to take it on arrival.
    const w = World.create(def, 1);
    const p = w.player;
    const far = [...w.containers.values()]
      .filter((c) => c.kind === 'tile' && c.stacks.length > 0)
      .sort((a, b) => Math.hypot(b.x - p.x, b.y - p.y) - Math.hypot(a.x - p.x, a.y - p.y))[0]!;
    const intent = w.approachIntent({ kind: 'take', container: far.id, item: def.items[far.stacks[0]!.item]!.id })!;
    w.queueIntent(intent);
    steps(w, 4);
    assert.ok(p.path && p.then, `${name}: walking with a pending take`);
    assertRoundTrip(w, undefined, 150);

    // Drop and take back: a pile created and removed.
    const g = World.create(def, 2);
    give(g, 0, 1);
    g.queueAction({ kind: 'drop', item: def.items[0]!.id, count: 1 });
    g.step();
    const pile = g.containersAt(g.player.x, g.player.y).find((c) => c.kind === 'ground')!;
    g.queueAction({ kind: 'take', container: pile.id, item: def.items[0]!.id });
    g.step();
    assert.ok(!g.containers.has(pile.id));
    assertRoundTrip(g, undefined, 50);

    // End the game: measurements at their minimum, plenty of every item.
    const e = World.create(def, 1);
    for (let i = 0; i < 3; i++) e.step();
    for (const idx of e.player.archetype.measurements) e.player.m[idx] = def.measurements[idx]!.min;
    for (const item of def.items) give(e, item.index, 10);
    stepUntil(e, () => e.ended, 5);
    assertRoundTrip(e, undefined, 3);
  });

  test(`round trip (${name}): mid-activity and set_tile`, () => {
    const def = GENRES[name];
    const kinds = (['act', 'use', 'craft'] as const).filter((k) => {
      const w = midActivity(def, k);
      if (!w) return false;
      assertRoundTrip(w, undefined, 120);
      return true;
    });
    const expected = { zombie: ['act', 'use', 'craft'], vampire: ['act', 'craft'], garden: [] }[name];
    assert.deepEqual(kinds, expected);
    if (def.actions.some((a) => a.effects.some((x) => x.type === 'set_tile'))) {
      const w = midActivity(def, 'act')!;
      stepUntil(w, () => w.snapshot().tiles.length > 0);
      assertRoundTrip(w, undefined, 60);
    }
  });
}

// ── Scripted fuzz ───────────────────────────────────────────────────────────

/** Seeded random input: steps, gotos (some with `then`), uses, drops, takes and crafts. Depends only on the world and its tick. */
function fuzz(seed: number): Script {
  return (w) => {
    const r = new Rng((Math.imul(seed, 0x9e3779b1) ^ Math.imul(w.tick + 1, 0x85ebca6b)) >>> 0);
    const roll = r.next();
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r.next() * xs.length)];
    const p = w.player;
    const near = () => ({ x: p.x + Math.floor(r.next() * 13) - 6, y: p.y + Math.floor(r.next() * 13) - 6 });
    if (roll < 0.03) {
      const d = [-1, 0, 1] as const;
      w.queueIntent({ kind: 'step', dx: pick(d)!, dy: pick(d)! });
    } else if (roll < 0.05) {
      const { x, y } = near();
      w.queueIntent({ kind: 'goto', x, y, adjacent: r.next() < 0.3 });
    } else if (roll < 0.08) {
      const { x, y } = near();
      const it = pick(w.interactionsAt(x, y).filter((i) => i.action));
      if (it) {
        const intent = w.approachIntent(it.action!);
        if (intent) w.queueIntent(intent);
        else w.queueAction(it.action!);
      }
    } else if (roll < 0.1) {
      const c = pick([...w.containers.values()].filter((x) => x.kind !== 'inventory' && x.stacks.length > 0));
      const s = c && pick(c.stacks);
      if (s) {
        const take: Action = { kind: 'take', container: c.id, item: w.def.items[s.item]!.id };
        w.queueIntent(w.approachIntent(take) ?? { kind: 'goto', x: c.x, y: c.y, adjacent: true, then: take });
      }
    } else if (roll < 0.11 && p.inv) {
      const s = pick(p.inv.stacks);
      if (s) w.queueAction({ kind: 'use', item: w.def.items[s.item]!.id });
    } else if (roll < 0.12 && p.inv) {
      const s = pick(p.inv.stacks);
      if (s) w.queueAction({ kind: 'drop', item: w.def.items[s.item]!.id, count: 1 });
    } else if (roll < 0.16) {
      const c = pick(w.reachableContainers());
      const s = c && pick(c.stacks);
      if (s) w.queueAction({ kind: 'take', container: c.id, item: w.def.items[s.item]!.id });
    } else if (roll < 0.17) {
      const rc = pick(w.availableRecipes().filter((x) => x.ok));
      if (rc) w.queueAction(rc.station ? { kind: 'craft', recipe: rc.recipe, x: rc.station.x, y: rc.station.y } : { kind: 'craft', recipe: rc.recipe });
    } else if (roll < 0.18) {
      const a = pick(w.availableActions().filter((x) => x.kind === 'act' && x.ok));
      if (a) w.queueAction(a.x !== undefined ? { kind: 'act', action: a.action!, x: a.x, y: a.y! } : { kind: 'act', action: a.action! });
    }
  };
}

const FUZZ_TICKS = 600;

for (const [name, def] of [...Object.entries(GENRES), ['fixture', DEF] as const]) {
  test(`fuzz (${name}): saves at three random ticks restore exactly to tick ${FUZZ_TICKS}`, () => {
    const r = new Rng(name.length * 31 + 5);
    const at = [0, 0, 0].map(() => 1 + Math.floor(r.next() * (FUZZ_TICKS - 1))).sort((a, b) => a - b);
    const script = fuzz(name.length);
    for (const t of at) {
      const w = World.create(def, 3);
      for (let i = 0; i < t; i++) {
        script(w);
        w.step();
      }
      assertRoundTrip(w, script, FUZZ_TICKS - t);
    }
    // The script really plays: it moves, acts and changes containers.
    const w = World.create(def, 3);
    const cells = new Set<number>();
    let records = 0;
    let last = w.lastAction;
    for (let i = 0; i < FUZZ_TICKS; i++) {
      script(w);
      w.step();
      cells.add(w.player.y * w.grid.width + w.player.x);
      if (w.lastAction !== last) records++;
      last = w.lastAction;
    }
    assert.ok(cells.size >= 10 && records >= 10 && w.containerVersion > 0, `${name}: ${cells.size} cells, ${records} action records, ended ${JSON.stringify(w.defeat ?? w.victory)}`);
  });
}

// ── Validation ──────────────────────────────────────────────────────────────

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const RICH: SaveFile = json(rich().save());

/** Restore a mutated copy of the rich save and expect an error matching `re` at `path`. */
function expectError(mutate: (s: SaveFile & Record<string, unknown>) => void, path: string, re: RegExp, def = DEF): string[] {
  const s = json(RICH) as SaveFile & Record<string, unknown>;
  mutate(s);
  const r = World.restore(def, s);
  assert.ok(!r.ok, `expected an error at ${path}`);
  const hit = r.errors.find((e) => e.startsWith(`${path}: `) && re.test(e));
  assert.ok(hit, `expected ${path}: ${re}, got:\n${r.errors.join('\n')}`);
  return r.errors;
}

function expectWarning(mutate: (s: SaveFile & Record<string, unknown>) => void, path: string, re: RegExp): World {
  const s = json(RICH) as SaveFile & Record<string, unknown>;
  mutate(s);
  const r = World.restore(DEF, s);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.ok(
    r.warnings.some((w) => w.startsWith(`${path}: `) && re.test(w)),
    `expected warning ${path}: ${re}, got:\n${r.warnings.join('\n')}`,
  );
  return r.world;
}

const idx = (s: SaveFile, archetype: string) => s.state.entities.findIndex((e) => e.archetype === archetype);

test('validation: format, version, packs and map', () => {
  expectError((s) => (s.format = 'other' as 'isolandia-save'), 'format', /expected 'isolandia-save', got 'other'/);
  expectError((s) => ((s as { version: number }).version = 2), 'version', /unsupported save version 2 \(supported: 1\)/);
  expectError((s) => (s.packs = [{ namespace: 'u', version: '1.0.0' }]), 'packs', /made with packs \[u\] but the loaded packs are \[t\]/);
  expectError((s) => s.packs.push({ namespace: 'u', version: '1' }), 'packs', /\[t, u\] but the loaded packs are \[t\]/);
  expectError((s) => (s.map.id = 't:other'), 'map', /map 't:other' \(14×8\) but the start map is 't:room' \(14×8\)/);
  expectError((s) => (s.map.width = 15), 'map', /15×8/);
});

test('validation: unknown qualified ids, with did-you-mean and JSON path', () => {
  const rock = idx(RICH, 't:rock');
  const hero = RICH.state.player;
  const listener = idx(RICH, 't:listener');
  expectError((s) => (s.state.entities[rock]!.archetype = 't:rok'), `state.entities[${rock}].archetype`, /unknown archetype 't:rok' \(did you mean 't:rock'\?\)/);
  expectError((s) => {
    const m = s.state.entities[hero]!.measurements;
    m['t:fod'] = m['t:food']!;
    delete m['t:food'];
  }, `state.entities[${hero}].measurements["t:fod"]`, /unknown measurement 't:fod' \(did you mean 't:food'\?\)/);
  expectError((s) => s.state.entities[hero]!.statuses.push('t:sad'), `state.entities[${hero}].statuses[0]`, /unknown status 't:sad'/);
  expectError((s) => (s.state.containers[0]!.stacks[0]![0] = 't:plnk'), 'state.containers[0].stacks[0][0]', /unknown item 't:plnk' \(did you mean 't:plank'\?\)/);
  expectError((s) => s.state.tiles.push([12, 2, 't:bordd']), 'state.tiles[0][2]', /unknown tile 't:bordd' \(did you mean 't:boarded'\?\)/);
  expectError((s) => s.state.actions.push({ kind: 'act', action: 't:bord', x: 12, y: 2 }), 'state.actions[0].action', /unknown action 't:bord' \(did you mean 't:board'\?\)/);
  expectError((s) => (s.state.entities[hero]!.activity!.recipe = 't:cok'), `state.entities[${hero}].activity.recipe`, /unknown recipe 't:cok' \(did you mean 't:cook'\?\)/);
  expectError((s) => (s.state.entities[listener]!.behavior!.state = 'goo'), `state.entities[${listener}].behavior.state`, /behavior 't:listener' has no state 'goo' \(did you mean 'go'\?\)/);
  expectError((s) => (s.state.entities[hero]!.activity = { kind: 'use', item: 't:plank', x: 2, y: 1, startTick: 1, endTick: 4 }), `state.entities[${hero}].activity.item`, /has no use/);
});

test('validation: entity ids, player, inventories and container ids', () => {
  expectError((s) => (s.state.entities[2]!.id = 5), 'state.entities[2].id', /0\.\.n-1 in order: expected 2, got 5/);
  expectError((s) => s.state.entities.reverse(), 'state.entities[0].id', /expected 0, got/);
  expectError((s) => (s.state.player = 40), 'state.player', /player 40 is not one of the 8 entities/);
  const inv = RICH.state.containers.findIndex((c) => c.kind === 'inventory');
  expectError((s) => delete s.state.containers[inv]!.owner, `state.containers[${inv}].owner`, /inventory has no owner/);
  const rock = idx(RICH, 't:rock');
  expectError((s) => (s.state.containers[inv]!.owner = rock), `state.containers[${inv}].owner`, /archetype 't:rock' of entity \d+ has no inventory/);
  expectError((s) => s.state.containers.splice(inv, 1), `state.entities[${RICH.state.player}]`, /has an inventory, but the save has no inventory container/);
  expectError((s) => (s.state.containers[1]!.id = s.state.containers[0]!.id), 'state.containers[1].id', /duplicate container id 0/);
  expectError((s) => (s.state.nextContainer = 2), 'state.containers[2].id', /container id 2 is not below nextContainer \(2\)/);
});

test('validation: every kind of cell out of bounds', () => {
  const hero = RICH.state.player;
  const listener = idx(RICH, 't:listener');
  const homer = idx(RICH, 't:homer');
  const OOB = /out of bounds \(map is 14×8\)/;
  const e = (k: number) => `state.entities[${k}]`;
  expectError((s) => (s.state.entities[hero]!.x = 14), e(hero), OOB);
  expectError((s) => (s.state.entities[hero]!.fromY = -1), `${e(hero)}.from`, OOB);
  expectError((s) => (s.state.entities[hero]!.home = [0, 8]), `${e(hero)}.home`, OOB);
  expectError((s) => s.state.entities[homer]!.path!.push([20, 3]), `${e(homer)}.path[${RICH.state.entities[homer]!.path!.length}]`, OOB);
  expectError((s) => (s.state.containers[0]!.cell = [99, 1]), 'state.containers[0].cell', OOB);
  expectError((s) => s.state.tiles.push([3, 9, 't:floor']), 'state.tiles[0]', OOB);
  expectError((s) => (s.state.entities[hero]!.activity!.x = -2), `${e(hero)}.activity`, OOB);
  expectError((s) => (s.state.entities[listener]!.heard!.y = 8), `${e(listener)}.heard`, OOB);
  expectError((s) => (s.state.entities[listener]!.behavior!.plan![0] = 30), `${e(listener)}.behavior.plan`, OOB);
});

test('validation: a tile container must sit on a container tile of the restored grid', () => {
  expectError((s) => s.state.tiles.push([1, 2, 't:floor']), 'state.containers[0].cell', /tile 't:floor' at \(1, 2\) holds no container/);
  expectError((s) => (s.state.containers[0]!.cell = [3, 3]), 'state.containers[0].cell', /holds no container/);
  // Changed tiles are applied first: a crate placed on a floor cell may hold a container.
  const s = json(RICH);
  s.state.tiles.push([3, 3, 't:crate']);
  s.state.containers.push({ id: s.state.nextContainer, kind: 'tile', cell: [3, 3], stacks: [] });
  s.state.nextContainer++;
  const r = World.restore(DEF, s);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.equal(r.world.containersAt(3, 3)[0]!.capacity, 2000);
});

test('validation: every error is reported, not just the first', () => {
  const errors = expectError((s) => {
    s.state.entities[0]!.archetype = 't:nope';
    s.state.containers[0]!.stacks[0]![0] = 't:nope';
    s.state.tick = -1;
  }, 'state.tick', /out of range/);
  assert.ok(errors.length >= 3, errors.join('\n'));
});

test('validation: warnings — pack version, missing and dropped measurements', () => {
  expectWarning((s) => (s.packs[0]!.version = '0.9.0'), 'packs[0]', /pack 't' is version 1\.0\.0, the save was made with 0\.9\.0/);
  const hero = RICH.state.player;
  const w = expectWarning((s) => delete s.state.entities[hero]!.measurements['t:food'], `state.entities[${hero}].measurements`, /measurement 't:food' is missing; it starts at 50/);
  assert.equal(w.value(w.player, 't:food'), 50);
  const rock = idx(RICH, 't:rock');
  const r = expectWarning((s) => (s.state.entities[rock]!.measurements['t:hp'] = 3), `state.entities[${rock}].measurements["t:hp"]`, /no longer has measurement 't:hp'; dropped/);
  assert.deepEqual(r.snapshot().entities[rock]!.measurements, {});
});

test('restore: never throws on garbage, or on a wrong type in any field of a valid save', () => {
  for (const g of [null, undefined, [], {}, 'save', 42, true, { format: 'isolandia-save', version: 1 }, { format: 'isolandia-save', version: 1, packs: 'x', map: [], state: [] }]) {
    const r = World.restore(DEF, g);
    assert.equal(r.ok, false, JSON.stringify(g));
  }
  const WRONG: unknown[] = [null, 'x', 1.5, -1, 1e9, true, {}, [], [1, 2, 3]];
  let restored = 0;
  let total = 0;
  // Walk every value of the save by JSON path and replace it in a fresh copy.
  const paths: (string | number)[][] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    paths.push(path);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(RICH, []);
  for (const path of paths.slice(1)) {
    for (const value of [...WRONG, undefined]) {
      const mutated: unknown = json(RICH);
      let parent = mutated as Record<string | number, unknown>;
      for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
      const key = path[path.length - 1]!;
      if (value === undefined) {
        if (Array.isArray(parent)) parent.splice(key as number, 1);
        else delete parent[key];
      } else parent[key] = value;
      total++;
      let r;
      try {
        r = World.restore(DEF, mutated);
      } catch (e) {
        assert.fail(`restore threw for ${path.join('.')} = ${JSON.stringify(value)}: ${String(e)}`);
      }
      if (r.ok) {
        restored++;
        r.world.snapshot();
        for (let i = 0; i < 3; i++) r.world.step();
        r.world.save();
      } else assert.ok(r.errors.length > 0);
    }
  }
  assert.ok(total > 1000 && restored > 0 && restored < total, `${restored}/${total}`);
});

// ── Wrapper ─────────────────────────────────────────────────────────────────

test('wrapper: metadata next to the save; unwrap accepts a wrapper or a bare save', () => {
  const w = world();
  steps(w, 600);
  const wrapped = wrapSave(w, '2026-10-04T12:00:00.000Z');
  assert.deepEqual(wrapped.meta, { savedAt: '2026-10-04T12:00:00.000Z', day: 1, time: '09:00', tick: 600, packs: ['t'] });
  assert.ok(!('savedAt' in wrapped.save.state));
  const u = unwrapSave(json(wrapped));
  assert.deepEqual(u.meta, wrapped.meta);
  assert.deepEqual(u.save, json(wrapped.save));
  const bare = unwrapSave(json(w.save()));
  assert.equal(bare.meta, null);
  assert.equal((bare.save as SaveFile).format, 'isolandia-save');
});
