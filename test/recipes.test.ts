import assert from 'node:assert/strict';
import { test } from 'node:test';
import { craftMenu, craftMenuText, handleKey, type KeyState } from '../src/ascii/terminal.ts';
import {
  actionText,
  countOf,
  hudModel,
  loadPacks,
  loadPacksOrThrow,
  recipeHint,
  stationLabel,
  World,
  type Action,
  type Definition,
  type Entity,
  type LoadError,
} from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { contextMenu, runMenuItem } from '../src/web/menu.ts';
import { craftingRowText, craftingView } from '../src/web/panels.ts';
import { fixture, GAMES, GENRE_AT, genreCell } from './helpers.ts';

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   #######      O = oven (not walkable, tag hot), B = bin (a container)
//   #O.@..#      the cook carries a knife, 2 meat and 4 herbs (capacity 5);
//   #.....#      `boil` and `stew` need an oven in reach, the rest do not
//   #B.O..#
//   #######

const FILES: Record<string, string> = {
  'tiles.yaml': `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false }
  - { id: oven, label: Oven, glyph: O, color: red, walkable: false, tags: [hot] }
  - { id: bin, label: Bin, glyph: B, color: gray, walkable: false, container: { capacity: 5 } }
`,
  'archetypes.yaml': `archetypes:
  - id: cook
    label: Cook
    glyph: "@"
    color: yellow
    measurements: [hp, food]
    ticks_per_turn: 0
    inventory: { capacity: 5, items: { knife: 1, meat: 2, herb: 4 } }
  - { id: ghost, label: Ghost, glyph: g, color: white, ticks_per_turn: 0 }
`,
  'items.yaml': `items:
  - { id: knife, label: Knife, glyph: "/", color: gray, weight: 0.5 }
  - { id: meat, label: Meat, glyph: "%", color: red, weight: 1 }
  - { id: herb, label: Herb, glyph: "'", color: green, weight: 0.1 }
  - { id: stew, label: Stew, glyph: "u", color: yellow, weight: 0.5 }
  - { id: salad, label: Salad, glyph: "s", color: green, weight: 0.1 }
  - { id: rock, label: Rock, glyph: "*", color: gray, weight: 2 }
`,
  'recipes.yaml': `recipes:
  - id: stew
    label: Stew
    verb: Cook
    category: Kitchen
    station: { tags: [hot] }
    consume: { meat: 1 }
    tools: [knife]
    produce: { stew: 1 }
    duration: 2
    interrupt: 'heard(self, 0.2)'
    effects:
      - { type: noise, radius: 2 }
      - { type: apply, measurement: food, delta: 'self.count_item("stew") * 10 + tile.x' }
  - id: salad
    label: Salad
    consume: { herb: 2 }
    produce: { salad: 1 }
  - id: rocks
    label: Rocks
    verb: Dig
    consume: { herb: 1 }
    produce: { rock: 2, salad: 1 }
  - id: boil
    label: Broth
    verb: Boil
    category: Kitchen
    station: { tiles: [oven] }
    consume: { meat: 2 }
    produce: { stew: 1 }
    progress: Boiling
    duration: 1
  - id: picky
    label: Picky
    consume: { herb: 1 }
    produce: { salad: 1 }
    when: 'self.food > 1000'
    unavailable: Not hungry enough
  - id: lucky
    label: Lucky
    consume: { herb: 1 }
    produce: { salad: 1 }
    when: 'random(0, 1) > 2'
`,
  'map.yaml': `maps:
  - id: kitchen
    legend:
      ".": { tile: floor }
      "#": { tile: wall }
      "O": { tile: oven }
      "B": { tile: bin }
      "@": { tile: floor, player: true }
    rows:
      - "#######"
      - "#O.@..#"
      - "#.....#"
      - "#B.O..#"
      - "#######"
start:
  map: kitchen
  player: cook
`,
};

const DEF: Definition = loadPacksOrThrow([fixture(FILES)]);

function world(seed = 1): World {
  return World.create(DEF, seed);
}

function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

function moveTo(e: Entity, x: number, y: number): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
}

const count = (w: World, id: string) => countOf(w.player.inv!, w.def.ids.items[id]!);
const food = (w: World) => w.value(w.player, 't:food')!;
const ground = (w: World, x: number, y: number) => w.containersAt(x, y).find((c) => c.kind === 'ground');

function load(files: Record<string, string>): { errors: readonly LoadError[]; warnings: readonly LoadError[] } {
  const r = loadPacks([fixture({ ...FILES, ...files })]);
  return r.ok ? { errors: [], warnings: r.warnings } : { errors: r.errors, warnings: r.warnings };
}

function expectLoadError(files: Record<string, string>, message: RegExp, path?: string): void {
  const { errors } = load(files);
  const hit = errors.find((e) => message.test(e.message));
  assert.ok(hit, `expected ${message}, got:\n${errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
  if (path !== undefined) assert.equal(hit.path, path);
}

function game(name: keyof typeof GAMES, seed = 1): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), seed);
}

// ── Loader ──────────────────────────────────────────────────────────────────

test('recipes: the fixture and both genre stacks load; defaults', () => {
  assert.equal(DEF.recipes.length, 6);
  const stew = DEF.recipes[DEF.ids.recipes['t:stew']!]!;
  assert.deepEqual([stew.verb, stew.category, stew.progress, stew.duration.ticks], ['Cook', 'Kitchen', 'Cook: Stew', 20]);
  assert.deepEqual(stew.consume, [{ item: DEF.ids.items['t:meat'], count: 1 }]);
  assert.deepEqual(stew.tools, [DEF.ids.items['t:knife']]);
  assert.deepEqual(stew.station!.match, DEF.tiles.map((t) => (t.id === 't:oven' ? 1 : 0)));
  const salad = DEF.recipes[DEF.ids.recipes['t:salad']!]!;
  assert.deepEqual([salad.verb, salad.category, salad.progress, salad.station, salad.duration.ticks, salad.tools, salad.effects], ['Craft', 'General', 'Craft: Salad', null, 0, [], []]);
  const rocks = DEF.recipes[DEF.ids.recipes['t:rocks']!]!;
  assert.deepEqual(
    rocks.produce.map((p) => [DEF.items[p.item]!.id, p.count]),
    [
      ['t:rock', 2],
      ['t:salad', 1],
    ],
  );
  assert.equal(DEF.recipes[DEF.ids.recipes['t:boil']!]!.progress, 'Boiling');
  for (const dirs of Object.values(GAMES)) assert.ok(loadPacks(dirs.map((d) => readPack(d))).ok, dirs.join(','));
});

test('recipes load errors: consume, produce, tools, station, effects and fields', () => {
  const recipe = (extra: string) => ({ 'extra.yaml': `recipes:\n  - id: r\n    label: R\n${extra}` });
  expectLoadError(recipe('    produce: { stew: 1 }\n'), /missing required field 'consume'/, 'recipes[0]');
  expectLoadError(recipe('    consume: { meat: 1 }\n'), /missing required field 'produce'/);
  expectLoadError(recipe('    consume: {}\n    produce: { stew: 1 }\n'), /field 'consume' must list at least one item/, 'recipes[0].consume');
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: {}\n'), /field 'produce' must list at least one item/);
  expectLoadError(recipe('    consume: [meat]\n    produce: { stew: 1 }\n'), /field 'consume' must be a mapping/);
  expectLoadError(recipe('    consume: { meet: 1 }\n    produce: { stew: 1 }\n'), /unknown item 'meet' \(did you mean 'meat'\?\)/, 'recipes[0].consume.meet');
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stw: 1 }\n'), /unknown item 'stw' \(did you mean 'stew'\?\)/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    tools: [knif]\n    produce: { stew: 1 }\n'), /unknown item 'knif' \(did you mean 'knife'\?\)/);
  expectLoadError(recipe('    consume: { meat: 0 }\n    produce: { stew: 1 }\n'), /consumed count must be an integer ≥ 1/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1.5 }\n'), /produced count must be an integer ≥ 1/);
  expectLoadError(
    recipe('    consume: { meat: 1, knife: 1 }\n    tools: [knife]\n    produce: { stew: 1 }\n'),
    /item 't:knife' is both consumed and a tool/,
    'recipes[0].tools[0]',
  );
  expectLoadError(recipe('    consume: { meat: 1 }\n    tools: [knife, knife]\n    produce: { stew: 1 }\n'), /tool 't:knife' is listed twice/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    station: { tiles: [ovn] }\n'), /unknown tile 'ovn' \(did you mean 'oven'\?\)/, 'recipes[0].station.tiles[0]');
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    station: {}\n'), /needs a non-empty 'tiles' or 'tags' list/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    station: oven\n'), /a tile filter must be a mapping/);
  expectLoadError(
    recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    station: { tags: [hot] }\n    effects: [{ type: set_tile, tile: floor }]\n'),
    /'set_tile' effects are only allowed in the effects of tile-targeted actions/,
  );
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    duration: -1\n'), /field 'duration' must be a number of sim seconds ≥ 0/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    interrupt: "self.nope"\n'), /expression error/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    when: "self.nope"\n'), /expression error/);
  expectLoadError(recipe('    consume: { meat: 1 }\n    produce: { stew: 1 }\n    vrb: Cook\n'), /unknown recipe field 'vrb' \(did you mean 'verb'\?\)/);
  expectLoadError({ 'extra.yaml': 'recipes:\n  - { id: stew, label: S, consume: { meat: 1 }, produce: { stew: 1 } }\n' }, /duplicate/);
});

test('recipes load warning: a station tag no tile carries', () => {
  const { errors, warnings } = load({ 'extra.yaml': 'recipes:\n  - { id: r, label: R, station: { tags: [hott] }, consume: { meat: 1 }, produce: { stew: 1 } }\n' });
  assert.deepEqual(errors, []);
  const w = warnings.find((x) => /no tile carries the tag 'hott' \(did you mean 'hot'\?\)/.test(x.message));
  assert.ok(w, warnings.map((x) => x.message).join('\n'));
  assert.equal(w.path, 'recipes[0].station.tags[0]');
});

// ── Starting and station selection ──────────────────────────────────────────

test('craft: start checks in order', () => {
  const w = world();
  const reason = (a: Action) => {
    w.queueAction(a);
    w.step();
    return w.lastAction!.reason;
  };
  assert.equal(reason({ kind: 'craft', recipe: 't:nope' }), 'unknown_recipe');
  assert.equal(w.lastAction!.recipe, 't:nope');
  // Station recipes: no oven in reach from (3, 1).
  assert.equal(reason({ kind: 'craft', recipe: 't:stew' }), 'out_of_reach');
  assert.equal(reason({ kind: 'craft', recipe: 't:stew', x: 3, y: 3, z: 0 }), 'out_of_reach');
  assert.equal(reason({ kind: 'craft', recipe: 't:stew', x: 1.5, y: 1, z: 0 }), 'invalid_target');
  assert.equal(reason({ kind: 'craft', recipe: 't:stew', x: 1 }), 'invalid_target');
  moveTo(w.player, 2, 2);
  assert.equal(reason({ kind: 'craft', recipe: 't:stew', x: 2, y: 1, z: 0 }), 'invalid_target');
  // Recipes without a station refuse a cell.
  assert.equal(reason({ kind: 'craft', recipe: 't:salad', x: 2, y: 2, z: 0 }), 'invalid_target');
  // Items, then `when`.
  w.player.inv!.stacks.splice(0, 1); // the knife
  assert.equal(reason({ kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 }), 'missing');
  assert.equal(w.lastAction!.stage, 'start');
  assert.equal(reason({ kind: 'craft', recipe: 't:picky' }), 'cannot_act');
  assert.equal(w.lastAction!.stage, 'complete');
  // An inventory-less player fails with no_inventory before the station check.
  const d = loadPacksOrThrow([fixture({ ...FILES, 'map.yaml': FILES['map.yaml']!.replace('player: cook', 'player: ghost') })]);
  const g = World.create(d, 1);
  g.queueAction({ kind: 'craft', recipe: 't:stew' });
  g.step();
  assert.equal(g.lastAction!.reason, 'no_inventory');
});

test('craft: station given by x/y, auto-picked in row-major order, or out of reach', () => {
  const w = world();
  moveTo(w.player, 2, 2); // both ovens, (1, 1) and (3, 3), are in reach
  w.queueAction({ kind: 'craft', recipe: 't:stew' });
  w.step();
  assert.deepEqual([w.player.activity!.x, w.player.activity!.y], [1, 1]);
  w.queueAction({ kind: 'craft', recipe: 't:stew', x: 3, y: 3, z: 0 });
  w.step();
  assert.deepEqual([w.player.activity!.x, w.player.activity!.y], [3, 3]);
  moveTo(w.player, 4, 2); // only (3, 3)
  w.queueAction({ kind: 'craft', recipe: 't:stew' });
  w.step();
  assert.deepEqual([w.player.activity!.x, w.player.activity!.y], [3, 3]);
  // `tile` is the station cell: the completion effect adds tile.x.
  const before = food(w);
  steps(w, 20);
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.ok(Math.abs(food(w) - before - 11) < 0.01, `${before} → ${food(w)}`); // 1 stew × 10 + x 3, minus 2 s of drift
  moveTo(w.player, 5, 1);
  w.queueAction({ kind: 'craft', recipe: 't:stew' });
  w.step();
  assert.equal(w.lastAction!.reason, 'out_of_reach');
});

// ── Timing and lifecycle ────────────────────────────────────────────────────

test('craft: a 0 s recipe completes at once with a single complete record', () => {
  const w = world();
  const version = w.containerVersion;
  w.queueAction({ kind: 'craft', recipe: 't:salad' });
  w.step();
  assert.equal(w.player.activity, null);
  assert.deepEqual(w.lastAction, { kind: 'craft', item: '', recipe: 't:salad', moved: 1, ok: true, stage: 'complete', tick: 0 });
  assert.equal(count(w, 't:herb'), 2);
  assert.equal(count(w, 't:salad'), 1);
  assert.equal(w.containerVersion, version + 1);
});

test('craft: a 2 s recipe completes 20 ticks after it starts; snapshot and hash cover it', () => {
  const w = world();
  moveTo(w.player, 2, 2);
  w.queueAction({ kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 });
  w.step();
  const start = w.lastAction!;
  assert.deepEqual([start.kind, start.recipe, start.stage, start.ok], ['craft', 't:stew', 'start', true]);
  assert.deepEqual(w.snapshot().entities[0]!.activity, { kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0, startTick: 0, endTick: 20 });
  assert.equal(hudModel(w).activity!.label, 'Cook: Stew');
  assert.equal(hudModel(w).lastAction, 'You start: Cook: Stew.');
  steps(w, 19);
  assert.equal(count(w, 't:meat'), 2, 'nothing is consumed before completion');
  assert.equal(count(w, 't:stew'), 0);
  w.step();
  assert.equal(w.lastAction!.tick, 20);
  assert.equal(w.lastAction!.ok, true);
  assert.equal(count(w, 't:meat'), 1);
  assert.equal(count(w, 't:stew'), 1);
  assert.equal(count(w, 't:knife'), 1, 'tools are kept');
  assert.ok(w.noises.some((n) => n.x === 2 && n.y === 2 && n.radius === 2), 'effects run at completion');
  // Determinism: same intents ⇒ same hash.
  const again = world();
  moveTo(again.player, 2, 2);
  again.queueAction({ kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 });
  steps(again, 21);
  assert.equal(again.hash(), w.hash());
});

test('craft: moving or a new action cancels it; nothing is consumed', () => {
  const w = world();
  moveTo(w.player, 2, 2);
  w.queueAction({ kind: 'craft', recipe: 't:stew' });
  w.step();
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  w.step();
  assert.equal(w.lastAction!.reason, 'cancelled');
  assert.equal(hudModel(w).lastAction, 'Cook: Stew cancelled.');
  moveTo(w.player, 2, 2);
  w.queueAction({ kind: 'craft', recipe: 't:stew' });
  w.step();
  w.queueAction({ kind: 'craft', recipe: 't:salad' });
  w.step();
  assert.equal(w.player.activity, null);
  assert.equal(count(w, 't:meat'), 2);
  assert.equal(count(w, 't:salad'), 1);
});

test('craft: interrupt, and the completion re-check when an ingredient is dropped mid-way', () => {
  const w = world();
  moveTo(w.player, 2, 2);
  w.queueAction({ kind: 'craft', recipe: 't:stew' });
  w.step();
  w.player.heardTick = w.tick - 1;
  w.step();
  assert.equal(w.lastAction!.reason, 'interrupted');
  assert.equal(actionText(w, w.lastAction!), 'Cook: Stew interrupted.');
  assert.equal(count(w, 't:meat'), 2);
  w.player.heardTick = -1;
  // Boil needs both pieces of meat; one goes missing before completion.
  w.queueAction({ kind: 'craft', recipe: 't:boil' });
  w.step();
  assert.equal(w.player.activity?.source.progress, 'Boiling');
  w.player.inv!.stacks.find((s) => s.item === w.def.ids.items['t:meat'])!.count = 1;
  steps(w, 10);
  assert.equal(w.lastAction!.stage, 'complete');
  assert.equal(w.lastAction!.reason, 'missing');
  assert.equal(count(w, 't:stew'), 0);
  assert.equal(actionText(w, w.lastAction!), 'You need Meat x2.');
});

// ── Completion ──────────────────────────────────────────────────────────────

test('craft: consumed items leave before produced ones arrive', () => {
  const w = world();
  moveTo(w.player, 2, 2);
  // Fill the inventory to capacity (5): knife 0.5 + 2 meat + 4 herbs 0.4 + 2.1 of rocks… exactly.
  const inv = w.player.inv!;
  inv.stacks.push({ item: w.def.ids.items['t:rock']!, count: 1 });
  inv.load += 200;
  inv.stacks.find((s) => s.item === w.def.ids.items['t:herb'])!.count = 5;
  inv.load += 10;
  assert.equal(inv.load, inv.capacity);
  w.queueAction({ kind: 'craft', recipe: 't:boil' });
  steps(w, 11);
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(w.lastAction!.dropped, undefined);
  assert.equal(count(w, 't:stew'), 1);
  assert.equal(ground(w, 2, 2), undefined);
});

test('craft: overflow goes to a new or the existing ground pile; moved and texts', () => {
  const w = world();
  moveTo(w.player, 4, 2);
  // Rocks: 2 × 2 into 5 − 2.8 of room ⇒ 1 fits, 1 drops; the salad fits.
  w.queueAction({ kind: 'craft', recipe: 't:rocks' });
  w.step();
  const r = w.lastAction!;
  assert.deepEqual([r.ok, r.moved, r.dropped], [true, 3, 1]);
  assert.equal(count(w, 't:rock'), 1);
  assert.equal(count(w, 't:salad'), 1);
  const pile = ground(w, 4, 2)!;
  assert.deepEqual(
    pile.stacks.map((s) => [w.def.items[s.item]!.id, s.count]),
    [['t:rock', 1]],
  );
  assert.equal(actionText(w, r), 'You make 2× Rock, 1× Salad. (some dropped on the ground)');
  // Again: no room for rocks at all; the same pile grows.
  w.queueAction({ kind: 'craft', recipe: 't:rocks' });
  w.step();
  assert.deepEqual([w.lastAction!.moved, w.lastAction!.dropped], [3, 2]);
  assert.equal(ground(w, 4, 2), pile);
  assert.equal(countOf(pile, w.def.ids.items['t:rock']!), 3);
  assert.equal(w.containersAt(4, 2).length, 1);
  // Without overflow the text has no suffix.
  w.queueAction({ kind: 'craft', recipe: 't:salad' });
  w.step();
  assert.equal(actionText(w, w.lastAction!), 'You make 1× Salad.');
});

test('craft: action texts for failures', () => {
  const w = world();
  const text = (a: Action) => {
    w.queueAction(a);
    w.step();
    return actionText(w, w.lastAction!);
  };
  assert.equal(text({ kind: 'craft', recipe: 't:nope' }), 'Unknown recipe t:nope');
  assert.equal(text({ kind: 'craft', recipe: 't:stew' }), 'You need to be at a Oven.');
  assert.equal(text({ kind: 'craft', recipe: 't:salad', x: 1, y: 1, z: 0 }), "You can't craft that here.");
  assert.equal(text({ kind: 'craft', recipe: 't:picky' }), 'Not hungry enough');
  w.player.inv!.stacks.length = 0;
  w.player.inv!.load = 0;
  assert.equal(text({ kind: 'craft', recipe: 't:salad' }), 'You need Herb x2.');
});

// ── Queries ─────────────────────────────────────────────────────────────────

test('availableRecipes: every recipe in definition order; station in reach; pure', () => {
  const w = world();
  const far = w.availableRecipes();
  assert.deepEqual(
    far.map((r) => r.recipe),
    ['t:stew', 't:salad', 't:rocks', 't:boil', 't:picky', 't:lucky'],
  );
  assert.deepEqual(far[0], { recipe: 't:stew', label: 'Stew', verb: 'Cook', category: 'Kitchen', ok: false, reason: 'out_of_reach' });
  assert.deepEqual(far[1], { recipe: 't:salad', label: 'Salad', verb: 'Craft', category: 'General', ok: true });
  assert.deepEqual(far[4], { recipe: 't:picky', label: 'Picky', verb: 'Craft', category: 'General', ok: false, reason: 'cannot_act', unavailable: 'Not hungry enough' });
  moveTo(w.player, 2, 2);
  const near = w.availableRecipes();
  assert.deepEqual(near[0], { recipe: 't:stew', label: 'Stew', verb: 'Cook', category: 'Kitchen', ok: true, station: { x: 1, y: 1, z: 0 } });
  w.player.inv!.stacks.find((s) => s.item === w.def.ids.items['t:meat'])!.count = 1;
  assert.deepEqual(near[3]!.ok, true);
  assert.deepEqual(w.availableRecipes()[3], {
    recipe: 't:boil',
    label: 'Broth',
    verb: 'Boil',
    category: 'Kitchen',
    ok: false,
    reason: 'missing',
    missing: [{ item: 't:meat', label: 'Meat', count: 1 }],
    station: { x: 1, y: 1, z: 0 },
  });
  // Pure: the `random` in lucky's `when` never moves the world RNG.
  const hash = w.hash();
  for (let i = 0; i < 5; i++) w.availableRecipes();
  assert.equal(w.hash(), hash);
});

test('interactionsAt: station recipes after tile actions and before containers; ignoring reach; pure', () => {
  const extra = `actions:
  - { id: poke, label: Poke, target: { tiles: [oven] }, effects: [{ type: noise, radius: 1 }] }
`;
  const d = loadPacksOrThrow([fixture({ ...FILES, 'actions.yaml': extra, 'tiles.yaml': FILES['tiles.yaml']!.replace('tags: [hot] }', 'tags: [hot], container: { capacity: 2 } }') })]);
  const w = World.create(d, 1);
  const at = w.interactionsAt(1, 1);
  assert.deepEqual(
    at.map((e) => [e.id, e.label, e.kind, e.ok, e.inReach]),
    [
      ['act:t:poke', 'Poke', 'act', true, false],
      ['craft:t:stew', 'Cook: Stew', 'craft', true, false],
      ['craft:t:boil', 'Boil: Broth', 'craft', true, false],
      [`open:${at[3]!.container}`, 'Open Oven', 'open', true, false],
    ],
  );
  assert.deepEqual(at[1]!.action, { kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 });
  // Recipes without a station are never listed per cell.
  const own = w.interactionsAt(w.player.x, w.player.y);
  assert.ok(!own.some((e) => e.kind === 'craft'));
  // Missing items show as for actions.
  const base = world();
  base.player.inv!.stacks.splice(0, 1);
  const stew = base.interactionsAt(3, 3).find((e) => e.id === 'craft:t:stew')!;
  assert.deepEqual([stew.ok, stew.reason, stew.missing], [false, 'missing', [{ item: 't:knife', label: 'Knife', count: 1 }]]);
  const hash = base.hash();
  base.interactionsAt(1, 1);
  assert.equal(base.hash(), hash);
});

test('approachIntent: a station recipe from afar walks up and crafts on arrival', () => {
  const w = world();
  const act: Action = { kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 };
  assert.deepEqual(w.approachIntent(act), { kind: 'goto', x: 1, y: 1, z: 0, adjacent: true, then: act });
  assert.equal(w.approachIntent({ kind: 'craft', recipe: 't:salad' }), null);
  assert.equal(w.approachIntent({ kind: 'craft', recipe: 't:stew' }), null);
  assert.equal(w.approachIntent({ kind: 'craft', recipe: 't:nope', x: 1, y: 1, z: 0 }), null);
  moveTo(w.player, 2, 2);
  assert.equal(w.approachIntent(act), null);
});

// ── UI models ───────────────────────────────────────────────────────────────

test('crafting panel: grouped by category, inputs, tools, station and hints', () => {
  const w = world();
  assert.equal(stationLabel(w, 't:stew'), 'Oven');
  assert.equal(stationLabel(w, 't:salad'), null);
  const v = craftingView(w, false);
  assert.deepEqual(
    v.groups.map((g) => [g.category, g.rows.map((r) => r.recipe)]),
    [
      ['Kitchen', ['t:stew', 't:boil']],
      ['General', ['t:salad', 't:rocks', 't:picky', 't:lucky']],
    ],
  );
  const stew = v.groups[0]!.rows[0]!;
  assert.deepEqual(stew, {
    recipe: 't:stew',
    label: 'Stew',
    inputs: '1× Meat',
    tools: 'Knife',
    station: 'at Oven',
    craft: { label: 'Craft', actions: [{ kind: 'craft', recipe: 't:stew' }], disabled: true, hint: 'Go to a Oven' },
  });
  assert.equal(craftingRowText(stew), 'Stew: 1× Meat · tools: Knife · at Oven');
  const salad = v.groups[1]!.rows[0]!;
  assert.deepEqual(salad.craft, { label: 'Craft', actions: [{ kind: 'craft', recipe: 't:salad' }], disabled: false });
  assert.equal(craftingRowText(salad), 'Salad: 2× Herb');
  assert.equal(v.groups[1]!.rows[2]!.craft.hint, 'Not hungry enough');
  // In reach: Craft queues the recipe at the chosen station.
  moveTo(w.player, 4, 2);
  const near = craftingView(w, false).groups[0]!.rows[0]!.craft;
  assert.deepEqual(near, { label: 'Craft', actions: [{ kind: 'craft', recipe: 't:stew', x: 3, y: 3, z: 0 }], disabled: false });
  assert.equal(craftingView(w, true).groups[0]!.rows[0]!.craft.disabled, true);
  w.player.inv!.stacks.find((s) => s.item === w.def.ids.items['t:meat'])!.count = 0;
  assert.equal(recipeHint(w, w.availableRecipes()[3]!), 'Needs: 2× Meat');
  assert.equal(recipeHint(w, w.availableRecipes()[0]!), 'Needs: Meat');
});

test('context menu: station recipes from afar walk there; in reach they start at once', () => {
  const w = world();
  const far = contextMenu(w, 1, 1).items;
  const act: Action = { kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 };
  assert.deepEqual(far[0], { label: 'Cook: Stew', disabled: false, ...(far[0]!.detail ? { detail: far[0]!.detail } : {}), run: { intent: { kind: 'goto', x: 1, y: 1, z: 0, adjacent: true, then: act } } });
  runMenuItem(w, far[0]!);
  for (let i = 0; i < 200 && !w.player.activity; i++) w.step();
  assert.equal(w.player.activity?.source.recipe, w.def.ids.recipes['t:stew']);
  const near = contextMenu(w, 1, 1).items;
  assert.deepEqual(near[0]!.run, { actions: [act] });
  w.player.inv!.stacks.splice(0, 1);
  const without = contextMenu(w, 1, 1).disabled[0]!;
  assert.deepEqual([without.disabled, without.hint], [true, 'Needs: Knife']);
});

test('ascii: c lists the ok recipes, 1-9 craft; with none, a few blocked ones with hints', () => {
  const w = world();
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'c', keys);
  assert.deepEqual(
    keys.crafting!.entries.map((e) => e.label),
    ['Craft: Salad', 'Dig: Rocks'],
  );
  assert.equal(craftMenuText(keys.crafting!), 'craft: 1) Craft: Salad  2) Dig: Rocks');
  handleKey(w, '1', keys);
  assert.equal(keys.crafting, null);
  w.step();
  assert.equal(w.lastAction!.recipe, 't:salad');
  assert.equal(count(w, 't:salad'), 1);
  // Any other key closes the list (and still acts).
  handleKey(w, 'c', keys);
  handleKey(w, 'z', keys);
  assert.equal(keys.crafting, null);
  // Nothing to craft: up to three blocked recipes, in definition order.
  w.player.inv!.stacks.length = 0;
  w.player.inv!.load = 0;
  const menu = craftMenu(w);
  assert.deepEqual(menu.entries, []);
  assert.equal(craftMenuText(menu), 'Nothing to craft  Cook: Stew [Go to a Oven]  Craft: Salad [Needs: 2× Herb]  Dig: Rocks [Needs: Herb]');
  handleKey(w, 'c', keys);
  handleKey(w, '1', keys);
  assert.equal(w.snapshot().actions.length, 0);
  // At the oven the station recipe is listed with its cell.
  const w2 = world();
  moveTo(w2.player, 2, 2);
  const m2 = craftMenu(w2);
  assert.deepEqual(m2.entries[0]!.actions, [{ kind: 'craft', recipe: 't:stew', x: 1, y: 1, z: 0 }]);
});

// ── Scenarios ───────────────────────────────────────────────────────────────

/** Walk the player to (x, y) (or next to it), stepping until the path ends. */
function walk(w: World, x: number, y: number, adjacent = false): void {
  w.queueIntent({ kind: 'goto', x, y, adjacent });
  w.step();
  assert.ok(w.lastGoto?.ok, `no path to ${x},${y}`);
  for (let i = 0; i < 2000 && w.player.path; i++) w.step();
  assert.equal(w.player.path, null);
}

test('zombie: loot canned beans, walk to a stove via the menu, cook and eat them; tear rags into a bandage', () => {
  const w = game('zombie', 2);
  const id = (s: string) => w.def.ids.items[s]!;
  const have = (s: string) => countOf(w.player.inv!, id(s));
  const T = (x: number, y: number) => genreCell('zombie', x, y);
  // The north-east kitchen's cupboard holds a can (seed 2; the city rolls loot for many more containers first).
  const cupboard = w.containersAt(...T(30, 2))[0]!;
  assert.ok(countOf(cupboard, id('town:canned_beans')) >= 1);
  walk(w, ...T(30, 2), true);
  w.queueAction({ kind: 'take', container: cupboard.id, item: 'town:canned_beans' });
  w.step();
  assert.ok(have('town:canned_beans') >= 1);
  const cans = have('town:canned_beans');

  // The south-east kitchen's stove, from afar.
  const [sx, sy] = T(31, 18);
  assert.equal(w.grid.tileAt(sx, sy)!.id, 'town:stove');
  assert.ok(Math.max(Math.abs(w.player.x - sx), Math.abs(w.player.y - sy)) > 1);
  const item = contextMenu(w, sx, sy).items.find((i) => i.label.startsWith('Cook: Hot beans'))!;
  assert.equal(item.disabled, false);
  assert.ok(item.run.intent?.then, 'walks there first');
  runMenuItem(w, item);
  for (let i = 0; i < 2000 && !w.player.activity; i++) w.step();
  assert.equal(w.player.activity?.source.recipe, w.def.ids.recipes['town:cook_beans'], JSON.stringify(w.lastAction));
  assert.equal(hudModel(w).activity!.label, 'Cook: Hot beans');
  const start = w.lastAction!.tick;
  for (let i = 0; i < 100 && w.player.activity; i++) w.step();
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(w.lastAction!.tick, start + 50);
  assert.equal(hudModel(w).lastAction, 'You make 1× Hot beans.');
  assert.equal(have('town:canned_beans'), cans - 1);
  assert.equal(have('town:hot_beans'), 1);
  assert.ok(w.noises.some((n) => n.x === w.player.x && n.y === w.player.y), 'the sizzle is heard');

  // Eat them: more filling than cold beans.
  const hunger = () => w.value(w.player, 'std_needs:hunger')!;
  w.player.m[w.def.ids.measurements['std_needs:hunger']!] = 80;
  w.queueAction({ kind: 'use', item: 'town:hot_beans' });
  w.step();
  assert.ok(hunger() < 40, `${hunger()}`);
  assert.equal(have('town:hot_beans'), 0);

  // Rags into a bandage, anywhere (no station): it is in the crafting panel only.
  w.player.inv!.stacks.push({ item: id('town:rag'), count: 2 });
  w.player.inv!.load += 2 * w.def.items[id('town:rag')]!.weight;
  const row = craftingView(w, false).groups.find((g) => g.category === 'Medical')!.rows[0]!;
  assert.equal(row.craft.disabled, false);
  for (const a of row.craft.actions) w.queueAction(a);
  w.step();
  steps(w, 30);
  assert.equal(w.lastAction!.recipe, 'town:tear_bandage');
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(have('town:rag'), 0);
  assert.ok(have('town:bandage') >= 1);
});

test('zombie: the stoves keep the kitchens walkable and every container reachable', () => {
  const w = game('zombie', 1);
  // The old town: town_center's 44×21 cells inside the city.
  const { x: ox, y: oy } = GENRE_AT.zombie;
  const inTown = (x: number, y: number) => x >= ox && y >= oy && x < ox + 44 && y < oy + 21;
  const stoves: [number, number][] = [];
  for (let y = oy; y < oy + 21; y++) for (let x = ox; x < ox + 44; x++) if (w.grid.tileAt(x, y)!.id === 'town:stove') stoves.push([x, y]);
  assert.equal(stoves.length, 4);
  for (const c of w.containers.values()) {
    if (c.kind !== 'tile' || !inTown(c.x, c.y)) continue;
    w.player.path = null;
    w.queueIntent({ kind: 'goto', x: c.x, y: c.y, z: c.z, adjacent: !w.grid.walkable(c.x, c.y, c.z) });
    w.step();
    assert.ok(w.lastGoto!.ok, `container at ${c.x},${c.y},${c.z} is unreachable`);
  }
  for (const [x, y] of stoves) {
    w.queueIntent({ kind: 'goto', x, y, adjacent: true });
    w.step();
    assert.ok(w.lastGoto!.ok, `stove at ${x},${y} is unreachable`);
  }
});

test('vampire: fill an empty vial at the font, then mix blood wine anywhere', () => {
  const w = game('vampire', 1);
  const id = (s: string) => w.def.ids.items[s]!;
  const have = (s: string) => countOf(w.player.inv!, id(s));
  // Loot an empty vial and a bottle of wine from the library and the cellar (seed 1).
  for (const [mx, my, item] of [
    [7, 9, 'vamp:empty_vial'],
    [16, 12, 'vamp:wine'],
  ] as const) {
    const [x, y] = genreCell('vampire', mx, my);
    const c = w.containersAt(x, y)[0]!;
    assert.ok(countOf(c, id(item)) >= 1, `${item} at ${x},${y}`);
    walk(w, x, y, true);
    w.queueAction({ kind: 'take', container: c.id, item, count: 1 });
    w.step();
    assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  }
  const vials = have('vamp:blood_vial');

  // At the font: the menu offers Fill; it walks up and fills the vial.
  const [fx, fy] = genreCell('vampire', 13, 3);
  assert.equal(w.grid.tileAt(fx, fy)!.id, 'vamp:font');
  const fill = contextMenu(w, fx, fy).items.find((i) => i.label === 'Fill: Blood vial')!;
  assert.equal(fill.disabled, false);
  runMenuItem(w, fill);
  for (let i = 0; i < 2000 && !w.player.activity; i++) w.step();
  assert.equal(w.player.activity?.source.recipe, w.def.ids.recipes['vamp:fill_vial'], JSON.stringify(w.lastAction));
  for (let i = 0; i < 100 && w.player.activity; i++) w.step();
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(have('vamp:empty_vial'), 0);
  assert.equal(have('vamp:blood_vial'), vials + 1);

  // Mix: no station, from the crafting list.
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'c', keys);
  const k = keys.crafting!.entries.findIndex((e) => e.label === 'Mix: Blood wine');
  assert.ok(k >= 0, craftMenuText(keys.crafting!));
  handleKey(w, String(k + 1), keys);
  w.step();
  steps(w, 20);
  assert.equal(w.lastAction!.recipe, 'vamp:mix_blood_wine');
  assert.equal(w.lastAction!.ok, true, JSON.stringify(w.lastAction));
  assert.equal(have('vamp:blood_wine'), 1);
  assert.equal(have('vamp:wine'), 0);
  assert.equal(have('vamp:blood_vial'), vials);

  // Drink it: blood and a little hp.
  w.player.m[w.def.ids.measurements['vamp:blood']!] = 10;
  w.player.m[w.def.ids.measurements['std:hp']!] = 90; // blood is capped at hp / 2
  w.queueAction({ kind: 'use', item: 'vamp:blood_wine' });
  w.step();
  assert.ok(w.value(w.player, 'vamp:blood')! >= 35, `${w.value(w.player, 'vamp:blood')}`);
  assert.ok(w.value(w.player, 'std:hp')! > 90);
});
