import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { add, buildCatalog, EDGE_SIDES, formatError, loadPacks, resolveStack, World, type Action, type Catalog, type Definition, type EdgeSide, type LoadError } from '../src/core/index.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { readPack } from '../src/node/read-pack.ts';

// M7: one genre-free base game (`town`), zombie and vampire as mods of it,
// and a balance mod that works with either (specs/m7-town-base.md).

const SHIPPED: Catalog = buildCatalog(
  readdirSync('packs')
    .filter((dir) => existsSync(join('packs', dir, 'pack.yaml')))
    .sort()
    .map((dir) => ({ dir, manifest: readFileSync(join('packs', dir, 'pack.yaml'), 'utf8') })),
);

/** Load a stack from short tokens, as `npm run check` does. */
function stack(tokens: string[]): { def: Definition; warnings: readonly LoadError[] } {
  const r = resolveStack(SHIPPED, tokens);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const l = loadPacks(r.packs.map((p) => readPack(join('packs', p.dir))));
  assert.ok(l.ok, l.ok ? '' : l.errors.map(formatError).join('\n'));
  return { def: l.definition, warnings: l.warnings };
}

const cache = new Map<string, ReturnType<typeof stack>>();
const load = (...tokens: string[]) => {
  const key = tokens.join(',');
  if (!cache.has(key)) cache.set(key, stack(tokens));
  return cache.get(key)!;
};

// ── Genre-free base ────────────────────────────────────────────────────────

/** Genre words a base or balance pack must not contain (whole words, case-insensitive; the stdpack's needs words are fine). */
const GENRE_WORDS = [
  'zmb', 'vamp', 'gdn',
  'zombie', 'vampire', 'undead', 'shambler', 'crawler', 'mansion', 'blood', 'bunny', 'carrot', 'butterfly', 'burrow', 'clover', 'strawberry', 'wheelbarrow',
  'bat', 'coffin', 'crypt', 'survivor',
];
// Letters only delimit a word, so ids (`zmb:window`, `bat_img`, `crypt.svg`) are caught and `bathroom` is not.
const GENRE_RE = new RegExp(`(?<![a-z])(${GENRE_WORDS.join('|')})(?![a-z])`, 'i');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('genre-free: the word check catches ids and file names but not longer words', () => {
  for (const hit of ['zmb:window', 'sprite: bat_img', 'assets/crypt.svg', 'You did not survive the Zombie outbreak', 'VAMP']) assert.ok(GENRE_RE.test(hit), hit);
  for (const miss of ['bathroom', 'hunger', 'thirst', 'combat', 'batch', 'cabinet']) assert.ok(!GENRE_RE.test(miss), miss);
});

test('genre-free: nothing under packs/town or packs/hardship names a genre (contents and file names)', () => {
  const found: string[] = [];
  for (const dir of ['packs/town', 'packs/hardship']) {
    for (const file of filesUnder(dir)) {
      const name = relative(dir, file);
      const m = GENRE_RE.exec(name);
      if (m) found.push(`${file}: file name has '${m[1]}'`);
      if (!/\.(ya?ml|tmj|tsj|md)$/.test(file)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const w = GENRE_RE.exec(line);
          if (w) found.push(`${file}:${i + 1}: '${w[1]}' in ${line.trim()}`);
        });
    }
  }
  assert.deepEqual(found, []);
});

test('town: a base game on std and std-needs, with a resident, a generic defeat and no victory', () => {
  const town = SHIPPED.packs.find((p) => p.namespace === 'town')!;
  assert.deepEqual([town.dir, town.kind, town.depends], ['town', 'game', ['std', 'std_needs']]);
  assert.ok(town.description.length > 0);
  const { def } = load('town');
  const resident = def.archetypes[def.start.player]!;
  assert.equal(resident.id, 'town:resident');
  assert.deepEqual(resident.tags, ['humanoid', 'living']);
  assert.deepEqual(
    resident.measurements.map((m) => def.measurements[m]!.id),
    ['std:hp', 'std_needs:hunger', 'std_needs:thirst', 'std_needs:fatigue'],
  );
  assert.deepEqual(
    resident.inventory!.items.map((s) => [def.items[s.item]!.id, s.count]),
    [['town:water_bottle', 1], ['town:crackers', 1]],
  );
  assert.equal(def.assets[resident.sprite!]!.id, 'town:resident_img');
  assert.equal(def.maps[def.start.map]!.id, 'town:city');
  assert.equal(def.start.defeat!.message, 'You did not make it.');
  assert.equal(def.start.victory, null);
  assert.deepEqual(def.start.simulation, { activeRadius: 64, npcPathBudget: 4000, playerPathBudget: 60000 });
  // No NPCs anywhere: no spawns or populate on any map, no behaviors, one entity.
  assert.ok(def.maps.every((m) => m.spawns.length === 0 && m.populate.length === 0));
  assert.equal(def.behaviors.length, 0);
  assert.equal(World.create(def, 1).entities.length, 1);
});

test('town: the resident loots, eats, cooks, sleeps and barricades in the empty town', () => {
  const { def } = load('town');
  const w = World.create(def, 1);
  const p = w.player;
  const item = (id: string) => def.ids.items[id]!;
  const have = (id: string) => p.inv!.stacks.find((s) => s.item === item(id))?.count ?? 0;
  const give = (id: string, n: number) => add(p.inv!, item(id), n, def.items[item(id)]!.weight);
  const measure = (id: string) => w.value(p, id)!;
  const setMeasure = (id: string, v: number) => (p.m[def.ids.measurements[id]!] = v);
  const until = (done: () => boolean, max = 3000) => {
    for (let i = 0; i < max && !done(); i++) w.step();
    assert.ok(done(), `not done after ${max} ticks (last action ${JSON.stringify(w.lastAction)})`);
  };
  const nearest = (ok: (x: number, y: number, z: number) => boolean) => {
    let best: [number, number, number] | null = null;
    for (let z = 0; z < w.grid.floors; z++) for (let y = 0; y < w.grid.height; y++) for (let x = 0; x < w.grid.width; x++) {
      if (!ok(x, y, z)) continue;
      if (!best || Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) < Math.max(Math.abs(best[0] - p.x), Math.abs(best[1] - p.y))) best = [x, y, z];
    }
    return best!;
  };
  const go = (a: Action) => {
    const intent = w.approachIntent(a);
    if (intent) w.queueIntent(intent);
    else w.queueAction(a);
  };
  const tileIs = (id: string) => (x: number, y: number, z: number) => w.grid.tileAt(x, y, z)?.id === id;
  /** The nearest edge holding tile `id`, as [x, y, z, side]. */
  const nearestEdge = (id: string): [number, number, number, EdgeSide] => {
    const sides = (x: number, y: number, z: number) => EDGE_SIDES.filter((s) => w.grid.edgeAt(x, y, z, s)?.id === id);
    const [x, y, z] = nearest((x, y, z) => sides(x, y, z).length > 0);
    return [x, y, z, sides(x, y, z)[0]!];
  };

  // Loot: walk to the nearest stocked container and take from it.
  const box = [...w.containers.values()]
    .filter((c) => c.kind === 'tile' && c.stacks.length > 0)
    .sort((a, b) => Math.max(Math.abs(a.x - p.x), Math.abs(a.y - p.y)) - Math.max(Math.abs(b.x - p.x), Math.abs(b.y - p.y)))[0]!;
  const loot = def.items[box.stacks[0]!.item]!.id;
  const before = have(loot);
  go({ kind: 'take', container: box.id, item: loot });
  until(() => have(loot) > before);

  // Eat.
  give('town:canned_beans', 2);
  setMeasure('std_needs:hunger', 80);
  w.queueAction({ kind: 'use', item: 'town:canned_beans' });
  w.step();
  assert.ok(measure('std_needs:hunger') < 50, `hunger ${measure('std_needs:hunger')}`);

  // Cook at the nearest stove.
  const [sx, sy, sz] = nearest(tileIs('town:stove'));
  go({ kind: 'craft', recipe: 'town:cook_beans', x: sx, y: sy, z: sz });
  until(() => have('town:hot_beans') === 1);

  // Sleep on the nearest bed.
  const [bx, by, bz] = nearest(tileIs('town:bed'));
  setMeasure('std_needs:fatigue', 60);
  w.queueIntent({ kind: 'goto', x: bx, y: by, z: bz });
  until(() => p.x === bx && p.y === by && p.z === bz);
  const tired = measure('std_needs:fatigue');
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(measure('std_needs:fatigue') < tired - 5, `fatigue ${tired} → ${measure('std_needs:fatigue')}`);

  // Barricade the nearest window.
  give('town:hammer', 1);
  give('town:plank', 2);
  give('town:nails', 4);
  const [wx, wy, wz, side] = nearestEdge('town:window');
  go({ kind: 'act', action: 'town:barricade', x: wx, y: wy, z: wz, side });
  until(() => w.grid.edgeAt(wx, wy, wz, side)!.id === 'town:barricaded_window');
  assert.equal(w.entities.length, 1, 'still alone in town');
});

// ── Mods on the base ───────────────────────────────────────────────────────

test('mods: zombie and vampire are mods of town; hardship is a genre-free balance mod', () => {
  const info = (ns: string) => SHIPPED.packs.find((p) => p.namespace === ns)!;
  assert.deepEqual([info('zmb').dir, info('zmb').kind, info('zmb').depends, info('zmb').version], ['zombie', 'mod', ['std', 'std_needs', 'town'], '0.2.0']);
  assert.deepEqual([info('vamp').dir, info('vamp').kind, info('vamp').depends, info('vamp').version], ['vampire', 'mod', ['std', 'town'], '0.2.0']);
  assert.deepEqual([info('hardship').dir, info('hardship').kind, info('hardship').depends], ['hardship', 'mod', ['std_needs', 'town']]);
  // The zombie keeps only its own content.
  const { def } = load('zombie');
  const own = (xs: readonly { id: string }[]) => xs.filter((x) => x.id.startsWith('zmb:')).map((x) => x.id);
  assert.deepEqual(own(def.archetypes), ['zmb:shambler', 'zmb:crawler']);
  assert.deepEqual(own(def.behaviors), ['zmb:shambler']);
  assert.deepEqual(own(def.statuses), ['zmb:alert']);
  assert.deepEqual(own(def.assets), ['zmb:shambler_img', 'zmb:crawler_img']);
  for (const xs of [def.tiles, def.items, def.loot, def.recipes, def.actions, def.systems, def.maps]) assert.deepEqual(own(xs), []);
  // The vampire's window is the town's, wherever it was used.
  const v = load('vampire').def;
  assert.equal(v.ids.tiles['vamp:window'], undefined);
  const shutter = v.actions[v.ids.actions['vamp:shutter']!]!;
  assert.equal(JSON.stringify(shutter.target).includes(String(v.ids.tiles['town:window'])), true);
});

/** The `check --overrides` patch lines of a stack (without the stack header). */
const patches = (...tokens: string[]) => {
  const lines = formatOverrides(load(...tokens).def);
  return lines.slice(lines.indexOf('patches:') + 1).map((l) => l.trim().split(/\s+/).join(' '));
};

test('check --overrides: the zombie and vampire mods patch the town by overrides only', () => {
  assert.deepEqual(patches('zombie'), [
    'zmb override archetype town:resident [label]',
    'zmb override map town:town_center [spawns]',
    'zmb override map town:house_c [populate]',
    'zmb override map town:city [populate]',
    'zmb override start [defeat, victory]',
  ]);
  assert.deepEqual(patches('vampire'), [
    'vamp override tile town:window [color, sprite]',
    'vamp override start [map, player, defeat]',
    'vamp override clock [start]',
    'vamp override lighting [tint]',
  ]);
  assert.deepEqual(patches('hardship'), [
    'hardship override measurement std_needs:hunger [rate]',
    'hardship override measurement std_needs:thirst [rate]',
    'hardship override loot town:kitchen_food [rolls, entries]',
    'hardship remove recipe town:tear_bandage',
  ]);
  const z = load('zombie').def;
  assert.equal(z.archetypes[z.start.player]!.label, 'Survivor');
  assert.equal(z.start.defeat!.message, 'You did not survive the outbreak.');
  assert.equal(z.start.victory!.message, 'You got the car running!');
});

// ── Joint validation ───────────────────────────────────────────────────────

const PLAYABLE = [['town'], ['zombie'], ['vampire'], ['garden'], ['hardship'], ['zombie', 'hardship'], ['vampire', 'hardship'], ['zombie', 'vampire'], ['vampire', 'zombie']];

test('joint: the shipped stacks load without warnings', () => {
  for (const s of [['town'], ['zombie'], ['vampire'], ['garden'], ['hardship'], ['zombie', 'hardship'], ['vampire', 'hardship']]) {
    assert.deepEqual(load(...s).warnings.map(formatError), [], s.join(','));
  }
});

test('joint: zombie + vampire warns only for start.defeat; the vampire (later) wins it and keeps the estate', () => {
  const { def, warnings } = load('zombie', 'vampire');
  assert.deepEqual(
    warnings.map((w) => [w.pack, w.path]),
    [['vamp', 'start.defeat']],
  );
  assert.match(warnings[0]!.message, /also overridden by pack 'zmb' .*; 'vamp' wins \(later in load order\)/);
  assert.equal(def.maps[def.start.map]!.id, 'vamp:estate');
  assert.equal(def.archetypes[def.start.player]!.id, 'vamp:vampire');
  assert.equal(def.start.defeat!.message, 'Your unlife has ended.');
  // Fields only one mod touches do not conflict: the zombie's victory is inherited.
  assert.equal(def.start.victory!.message, 'You got the car running!');
  assert.equal(def.clock.start, 20 * 60);
});

test('joint: vampire + zombie mirrors it; load order settles only the conflicting field', () => {
  const { def, warnings } = load('vampire', 'zombie');
  assert.deepEqual(
    warnings.map((w) => [w.pack, w.path]),
    [['zmb', 'start.defeat']],
  );
  assert.match(warnings[0]!.message, /also overridden by pack 'vamp' .*; 'zmb' wins \(later in load order\)/);
  // The zombie never overrides start.map or start.player: still the estate and the vampire.
  assert.equal(def.maps[def.start.map]!.id, 'vamp:estate');
  assert.equal(def.archetypes[def.start.player]!.id, 'vamp:vampire');
  assert.equal(def.start.defeat!.message, 'You did not survive the outbreak.');
  assert.equal(def.start.victory!.message, 'You got the car running!');
});

test('joint: every playable stack runs 300 ticks deterministically', () => {
  for (const s of PLAYABLE) {
    const { def } = load(...s);
    const run = () => {
      const w = World.create(def, 11);
      for (let i = 0; i < 300; i++) w.step();
      return w.hash();
    };
    assert.equal(run(), run(), s.join(','));
  }
});

test('joint: the town systems and statuses leave entities without `living` alone (vampire, bats)', () => {
  const { def } = load('vampire');
  const w = World.create(def, 1);
  const town = (xs: readonly { id: string }[]) => xs.filter((x) => x.id.startsWith('town:') || x.id.startsWith('std_needs:'));
  const statuses = new Set(town(def.statuses).map((s) => def.ids.statuses[s.id]!));
  const blood = def.ids.measurements['vamp:blood']!;
  for (let i = 0; i < 600; i++) w.step();
  for (const e of w.entities) {
    assert.ok(!e.archetype.tags.includes('living'), e.archetype.id);
    assert.ok(![...statuses].some((s) => e.st[s] === 1), `${e.archetype.id} has a town status`);
  }
  assert.ok(w.player.archetype.measurements.includes(blood));
});
