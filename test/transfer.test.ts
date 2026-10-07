import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, countOf, loadPacksOrThrow, World, type Container } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { itemIconUrls, reselect, transferView } from '../src/web/transfer.ts';
import { GAMES, loadFixture } from './helpers.ts';

function game(name: keyof typeof GAMES, seed = 1): World {
  return World.create(loadPacksOrThrow(GAMES[name].map((d) => readPack(d))), seed);
}

const item = (w: World, id: string) => w.def.ids.items[id]!;

/** Teleport the player next to a tile container with nothing else in reach and empty it; returns it. */
function beside(w: World): Container {
  const p = w.player;
  for (const c of w.containers.values()) {
    if (c.kind !== 'tile') continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (!w.grid.tileAt(x, y, c.z)?.walkable) continue;
        p.x = p.fromX = x;
        p.y = p.fromY = y;
        p.z = p.fromZ = c.z;
        if (w.reachableContainers().length !== 1) continue;
        for (const s of [...c.stacks]) c.stacks.splice(c.stacks.indexOf(s), 1);
        c.load = 0;
        return c;
      }
    }
  }
  throw new Error('no isolated tile container');
}

/** Empty the player's inventory, then give it `items`. */
function carry(w: World, items: Record<string, number>): void {
  const inv = w.player.inv!;
  inv.stacks.length = 0;
  inv.load = 0;
  for (const [id, n] of Object.entries(items)) add(inv, item(w, id), n, w.def.items[item(w, id)]!.weight);
}

test('transfer: one tab per reachable container, the pile on your cell included; reselection when the selected one leaves reach', () => {
  const w = game('zombie');
  const counter = beside(w);
  carry(w, { 'town:rag': 4 });
  assert.deepEqual(transferView(w, null, false).tabs, [], 'inventory-only mode has no tabs');
  w.queueAction({ kind: 'drop', item: 'town:rag', count: 1 });
  w.step();
  const pile = w.containersAt(w.player.x, w.player.y, w.player.z)[0]!;
  assert.equal(pile.kind, 'ground');

  const v = transferView(w, pile.id, false);
  assert.deepEqual(
    v.tabs.map((t) => [t.id, t.selected]),
    [counter.id, pile.id].sort((a, b) => a - b).map((id) => [id, id === pile.id]),
  );
  const tab = v.tabs.find((t) => t.id === pile.id)!;
  assert.deepEqual([tab.label, tab.weight, tab.capacity], ['Ground', 0.1, null]);
  assert.equal(v.tabs.find((t) => t.id === counter.id)!.capacity, counter.capacity / 100);
  assert.equal(v.container!.id, pile.id);
  assert.deepEqual(
    v.container!.stacks.map((s) => [s.label, s.count]),
    [['Rag', 1]],
  );

  // Take the pile back: it vanishes and the counter is selected next.
  const before = v.tabs.map((t) => t.id);
  w.queueAction(v.container!.stacks[0]!.move!);
  w.step();
  const reach = w.reachableContainers().map((c) => c.id);
  assert.deepEqual(reach, [counter.id]);
  assert.equal(reselect(before, pile.id, reach), counter.id);
  assert.equal(transferView(w, pile.id, false).container, null, 'an unreachable container is not shown');
  assert.equal(transferView(w, counter.id, false).tabs[0]!.selected, true);
  assert.equal(reselect([1, 2, 3], 2, [1, 3]), 3);
  assert.equal(reselect([1, 2, 3], 3, [1, 2]), 2);
  assert.equal(reselect([1, 2], 2, []), null);
});

test('transfer: move carries no count, moveOne count 1, both ways; use and drop on inventory stacks only', () => {
  const w = game('zombie');
  const c = beside(w);
  add(c, item(w, 'town:canned_beans'), 3, w.def.items[item(w, 'town:canned_beans')]!.weight);
  carry(w, { 'town:rag': 4, 'town:water_bottle': 1 });
  const v = transferView(w, c.id, false);
  const beans = v.container!.stacks[0]!;
  assert.deepEqual(beans.move, { kind: 'take', container: c.id, item: 'town:canned_beans' });
  assert.deepEqual(beans.moveOne, { kind: 'take', container: c.id, item: 'town:canned_beans', count: 1 });
  assert.equal(beans.use, undefined);
  assert.equal(beans.drop, undefined);
  const [rag, water] = v.inventory!.stacks;
  assert.deepEqual(rag!.move, { kind: 'put', container: c.id, item: 'town:rag' });
  assert.deepEqual(rag!.moveOne, { kind: 'put', container: c.id, item: 'town:rag', count: 1 });
  assert.deepEqual(rag!.drop!.actions, [{ kind: 'drop', item: 'town:rag', count: 4 }]);
  assert.equal(rag!.use, undefined);
  assert.deepEqual(water!.use!.actions, [{ kind: 'use', item: 'town:water_bottle' }]);

  // Shift-click a rag: one goes into the counter.
  w.queueAction(rag!.moveOne!);
  w.step();
  assert.equal(countOf(c, item(w, 'town:rag')), 1);
  assert.equal(countOf(w.player.inv!, item(w, 'town:rag')), 3);

  // Inventory-only: rows do not move, buttons still work.
  const only = transferView(w, null, false);
  assert.equal(only.container, null);
  assert.ok(only.inventory!.stacks.every((s) => s.move === null && s.moveOne === null && s.drop));
  assert.equal(only.takeAll, null);
  assert.equal(only.putAll, null);
});

test('transfer: take all and put all, null when their side is empty; weight bar', () => {
  const w = game('zombie');
  const c = beside(w);
  carry(w, {});
  let v = transferView(w, c.id, false);
  assert.equal(v.takeAll, null);
  assert.equal(v.putAll, null);
  assert.deepEqual([v.inventory!.weight, v.inventory!.fill], [0, 0]);

  add(c, item(w, 'town:canned_beans'), 3, 40);
  add(c, item(w, 'town:rag'), 2, 10);
  v = transferView(w, c.id, false);
  assert.deepEqual(v.takeAll!.actions, [
    { kind: 'take', container: c.id, item: 'town:canned_beans' },
    { kind: 'take', container: c.id, item: 'town:rag' },
  ]);
  assert.equal(v.putAll, null);
  for (const a of v.takeAll!.actions) w.queueAction(a);
  w.step();
  v = transferView(w, c.id, false);
  assert.equal(v.takeAll, null);
  assert.equal(v.container!.stacks.length, 0);
  assert.deepEqual(v.putAll!.actions, [
    { kind: 'put', container: c.id, item: 'town:canned_beans' },
    { kind: 'put', container: c.id, item: 'town:rag' },
  ]);
  assert.equal(v.inventory!.weight, 1.4);
  assert.equal(v.inventory!.fill, 1.4 / v.inventory!.capacity);
  assert.equal(v.inventory!.carrying, `Carrying: 1.4/${v.inventory!.capacity}`);
});

test('transfer: icons are the sprite file URL, else a colour and glyph swatch', () => {
  const w = game('zombie');
  const c = beside(w);
  add(c, item(w, 'town:canned_beans'), 1, 40);
  const urls = w.def.assets.map((a) => a.images.map((im) => `/packs/${a.pack}/${im.file}`));
  const icons = itemIconUrls(w.def, urls);
  assert.deepEqual(transferView(w, c.id, false, icons).container!.stacks[0]!.icon, { kind: 'image', url: '/packs/town/assets/canned_beans.svg' });
  // Without URLs (or a missing file) the icon is a swatch.
  assert.deepEqual(transferView(w, c.id, false).container!.stacks[0]!.icon, { kind: 'swatch', color: '#c9a227', glyph: '%' });

  // An item without a sprite.
  const plain = World.create(
    loadFixture({
      'items.yaml': 'items:\n  - { id: pebble, label: Pebble, glyph: "*", color: gray, weight: 0.1 }\n',
      'archetypes.yaml': `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, ticks_per_turn: 0, measurements: [hp, food], inventory: { capacity: 1, items: { pebble: 2 } } }
  - { id: rock, label: Rock, glyph: o, color: gray, ticks_per_turn: 0 }
`,
    }),
    1,
  );
  assert.deepEqual(itemIconUrls(plain.def, []), [null]);
  assert.deepEqual(transferView(plain, null, false, itemIconUrls(plain.def, [])).inventory!.stacks[0]!.icon, { kind: 'swatch', color: 'gray', glyph: '*' });
});

test('transfer: read-only after defeat', () => {
  const w = game('zombie');
  const c = beside(w);
  add(c, item(w, 'town:rag'), 2, 10);
  w.defeat = { tick: w.tick, message: 'You died.' };
  const v = transferView(w, c.id, w.ended);
  assert.ok([...v.container!.stacks, ...v.inventory!.stacks].every((s) => s.disabled));
  assert.ok(v.inventory!.stacks.every((s) => s.drop!.disabled && (s.use?.disabled ?? true)));
  assert.equal(v.takeAll!.disabled, true);
  assert.equal(v.putAll!.disabled, true);
  w.queueAction(v.container!.stacks[0]!.move!);
  w.step();
  assert.equal(countOf(c, item(w, 'town:rag')), 2);
});

for (const name of ['zombie', 'vampire'] as const) {
  test(`transfer (${name}): moving a stack of 3 takes all 3, or as many as fit, and a failure shows in the window`, () => {
    const w = game(name);
    const c = beside(w);
    const beans = item(w, 'town:canned_beans');
    const weight = w.def.items[beans]!.weight;
    add(c, beans, 3, weight);
    carry(w, {});
    w.queueAction(transferView(w, c.id, false).container!.stacks[0]!.move!);
    w.step();
    assert.equal(countOf(w.player.inv!, beans), 3);
    assert.equal(countOf(c, beans), 0);

    // Put them back, then fill the inventory so only one can fits.
    w.queueAction(transferView(w, c.id, false).inventory!.stacks[0]!.move!);
    w.step();
    assert.equal(countOf(c, beans), 3);
    const inv = w.player.inv!;
    inv.load = inv.capacity - weight - 1;
    w.queueAction(transferView(w, c.id, false).container!.stacks[0]!.move!);
    w.step();
    assert.equal(countOf(inv, beans), 1);
    assert.equal(countOf(c, beans), 2);
    assert.equal(transferView(w, c.id, false).message, null);

    w.queueAction(transferView(w, c.id, false).container!.stacks[0]!.move!);
    w.step();
    assert.equal(w.lastAction!.reason, 'too_heavy');
    assert.equal(transferView(w, c.id, false).message, 'Too heavy');
  });
}
