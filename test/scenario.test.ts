import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockAt, EMPTY_TILE, formatError, loadPacks, World, type Container, type Definition } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES } from './helpers.ts';
import { Looter, type LooterOptions } from './looter.ts';

// Headless scenarios on the real genre packs (M3 AC 18).

const DAY_TICKS = 14400; // 1440 s × 10 ticks/s
const SEEDS = [1, 2, 3, 4, 5];
/**
 * Seeds for the composite start maps (the 256×256 zombie city with ~1000
 * entities, the vampire estate): two in-game days cost ~25× the old maps per
 * seed, so they run on fewer seeds to keep this file within a few seconds each.
 */
const BIG_SEEDS = [1, 2];

function genre(name: string): Definition {
  const r = loadPacks(GAMES[name as keyof typeof GAMES].map(readPack));
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition;
}

/** Tile tags that restore a need just by standing on them (the survivor must never use these). */
const RESTORING: Record<string, readonly string[]> = { zombie: ['bed', 'food', 'water'], vampire: ['blood'] };

const LOOTERS: Record<string, LooterOptions> = {
  zombie: {
    needs: [
      { measurement: 'std_needs:thirst', above: 40, items: ['town:water_bottle', 'town:soda'], stock: 3 },
      { measurement: 'std_needs:hunger', above: 40, items: ['town:canned_beans', 'town:crackers'], stock: 3 },
      { measurement: 'std_needs:fatigue', above: 45, items: ['town:coffee'], stock: 2 },
      { measurement: 'std:hp', below: 70, items: ['town:bandage'], stock: 1 },
    ],
  },
  vampire: {
    needs: [{ measurement: 'vamp:blood', below: 30, items: ['vamp:blood_vial'], stock: 6 }],
  },
};

for (const name of ['zombie', 'vampire']) {
  test(`scenario (${name}): an idle player gains a status on day 1 and is defeated within 2 days`, () => {
    const def = genre(name);
    for (const seed of BIG_SEEDS) {
      const w = World.create(def, seed);
      let firstStatus = -1;
      while (!w.defeat && w.tick < 2 * DAY_TICKS) {
        w.step();
        if (firstStatus < 0 && w.player.st.includes(1)) firstStatus = w.tick;
      }
      assert.ok(firstStatus >= 0 && firstStatus <= DAY_TICKS, `seed ${seed}: first status at tick ${firstStatus}`);
      assert.ok(w.defeat && w.defeat.tick < 2 * DAY_TICKS, `seed ${seed}: not defeated`);
    }
  });

  test(`scenario (${name}): a looting player survives to the end of day 2 with goto/take/use only`, () => {
    const def = genre(name);
    for (const seed of BIG_SEEDS) {
      const w = World.create(def, seed);
      const bot = new Looter(w, LOOTERS[name]!);
      const kinds = new Set<string>();
      const queue = w.queueAction.bind(w);
      w.queueAction = (a) => (kinds.add(a.kind), queue(a));
      let used = 0;
      while (!w.defeat && w.tick < 2 * DAY_TICKS) {
        if (w.tick % 10 === 0) bot.think();
        w.step();
        const tags = w.grid.tileAt(w.player.x, w.player.y)!.tags;
        assert.ok(!RESTORING[name]!.some((t) => tags.includes(t)), `seed ${seed}: stood on a restoring tile at tick ${w.tick}`);
        if (w.lastAction?.kind === 'use' && w.lastAction.ok && w.lastAction.tick === w.tick - 1) used++;
      }
      assert.equal(w.defeat, null, `seed ${seed}: defeated at tick ${w.defeat?.tick}`);
      assert.equal(w.tick, 2 * DAY_TICKS);
      assert.deepEqual([...kinds].sort(), ['take', 'use'], `seed ${seed}: action kinds`);
      assert.ok(used >= 5, `seed ${seed}: only ${used} uses`);
    }
  });

  test(`scenario (${name}): taking stops at capacity with reason too_heavy`, () => {
    const def = genre(name);
    for (const seed of BIG_SEEDS) {
      const w = World.create(def, seed);
      const inv = w.player.inv!;
      const tried = new Set<number>();
      let target: Container | null = null;
      while (w.lastAction?.reason !== 'too_heavy' && w.tick < DAY_TICKS / 4) {
        if (w.tick % 10 === 0) {
          const reach = w.reachableContainers().filter((c) => c.stacks.length > 0);
          for (const c of reach) for (const s of c.stacks) w.queueAction({ kind: 'take', container: c.id, item: def.items[s.item]!.id });
          if (reach.length) tried.add(target?.id ?? -1);
          else if (!w.player.path) {
            const p = w.player;
            let best: Container | null = null;
            for (const c of w.containers.values()) {
              if (c.kind === 'inventory' || c.stacks.length === 0 || tried.has(c.id)) continue;
              if (!best || Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) < Math.max(Math.abs(best.x - p.x), Math.abs(best.y - p.y))) best = c;
            }
            if (best) {
              tried.add(best.id);
              target = best;
              w.queueIntent({ kind: 'goto', x: best.x, y: best.y, z: best.z, adjacent: true });
            }
          }
        }
        w.step();
        assert.ok(inv.load <= inv.capacity, `seed ${seed}: over capacity`);
      }
      assert.equal(w.lastAction?.ok, false, `seed ${seed}: never hit capacity`);
      assert.equal(w.lastAction?.reason, 'too_heavy');
      assert.equal(w.lastAction?.moved, 0);
      assert.ok(inv.load <= inv.capacity);
    }
  });
}

// ── Garden: no defeat, a collecting game won by gathering carrots ─────────

const GARDEN_BOT: LooterOptions = {
  needs: [
    { measurement: 'gdn:energy', below: 50, items: ['gdn:strawberry', 'gdn:clover'], stock: 2 },
    { items: ['gdn:carrot'], stock: 10 },
  ],
};

test('scenario (garden): an idle bunny gets sleepy on day 1, is never defeated and does not win within 2 days', () => {
  const def = genre('garden');
  const sleepy = def.ids.statuses['gdn:sleepy']!;
  for (const seed of SEEDS) {
    const w = World.create(def, seed);
    let firstSleepy = -1;
    while (!w.ended && w.tick < 2 * DAY_TICKS) {
      w.step();
      if (firstSleepy < 0 && w.player.st[sleepy] === 1) firstSleepy = w.tick;
    }
    assert.equal(w.defeat, null, `seed ${seed}: defeated`);
    assert.equal(w.victory, null, `seed ${seed}: won while idle`);
    assert.equal(w.tick, 2 * DAY_TICKS);
    assert.ok(firstSleepy >= 0, `seed ${seed}: never sleepy`);
    assert.equal(clockAt(def.clock, firstSleepy, def.ticksPerSecond).day, 1, `seed ${seed}: sleepy at tick ${firstSleepy}`);
    assert.equal(w.value(w.player, 'std:hp'), undefined, 'the bunny has no health to lose');
  }
});

test('scenario (garden): every seed holds enough carrots for the win', () => {
  const def = genre('garden');
  const carrot = def.ids.items['gdn:carrot']!;
  for (const seed of [...SEEDS, 6, 7, 8, 9, 10]) {
    const w = World.create(def, seed);
    let n = 0;
    for (const c of w.containers.values()) if (c.kind === 'tile') n += c.stacks.find((s) => s.item === carrot)?.count ?? 0;
    assert.ok(n >= 10, `seed ${seed}: only ${n} carrots`);
  }
});

test('scenario (garden): a collecting bunny wins within 1 in-game day with goto/take/use only', () => {
  const def = genre('garden');
  for (const seed of SEEDS) {
    const w = World.create(def, seed);
    const bot = new Looter(w, GARDEN_BOT);
    const kinds = new Set<string>();
    const queue = w.queueAction.bind(w);
    w.queueAction = (a) => (kinds.add(a.kind), queue(a));
    const intents = new Set<string>();
    const queueIntent = w.queueIntent.bind(w);
    w.queueIntent = (i, e) => (intents.add(i.kind), queueIntent(i, e));
    while (!w.ended && w.tick < DAY_TICKS) {
      if (w.tick % 10 === 0) bot.think();
      w.step();
    }
    assert.equal(w.defeat, null);
    assert.ok(w.victory, `seed ${seed}: did not win (carrots: ${w.player.inv!.stacks.map((s) => `${def.items[s.item]!.id} x${s.count}`).join(', ')})`);
    assert.equal(w.victory.message, 'You gathered all the carrots! Snack time!');
    assert.ok(w.victory.tick < DAY_TICKS);
    assert.ok([...kinds].every((k) => k === 'take' || k === 'use'), `seed ${seed}: action kinds ${[...kinds].join(', ')}`);
    assert.deepEqual([...intents], ['goto']);
    // Frozen once won.
    const hash = w.hash();
    bot.think();
    w.step();
    assert.equal(w.hash(), hash);
  }
});

test('genre packs use every M2 and M3 primitive', () => {
  for (const name of ['town', 'zombie', 'vampire']) {
    const def = genre(name);
    assert.ok(def.tiles.some((t) => t.tags.length > 0), `${name}: tile tags`);
    assert.ok(def.statuses.some((s) => s.rates.length > 0), `${name}: status rates`);
    assert.ok(def.systems.length >= 2, `${name}: systems`);
    assert.ok(def.start.defeat, `${name}: defeat`);
    assert.ok(def.lighting, `${name}: lighting`);
    assert.ok(def.items.some((i) => i.use), `${name}: items with use`);
    assert.ok(def.archetypes[def.start.player]!.inventory?.items.length, `${name}: starting inventory`);
    assert.ok(def.loot.some((t) => t.entries.some((e) => e.kind === 'table')), `${name}: nested loot`);
    assert.ok(def.distributions.some((d) => d.room !== null) && def.distributions.some((d) => d.room === null), `${name}: distributions with and without room`);
    const map = def.maps[def.start.map]!;
    assert.ok(map.rooms.rects.length > 0, `${name}: rooms`);
    // Tile containers in at least two kinds of room.
    const roomsWithContainers = new Set<number>();
    map.cells.forEach((t, i) => {
      if (t !== EMPTY_TILE && def.tiles[t]!.container) for (const tag of map.rooms.sets[map.rooms.cellSet[i]!]!) roomsWithContainers.add(tag);
    });
    assert.ok(roomsWithContainers.size >= 2, `${name}: containers in ${roomsWithContainers.size} room kinds`);
    // count_item / has_item in a status or system (expressions are compiled away, so check the source).
    const srcs = GAMES[name as keyof typeof GAMES].map(readPack);
    const uses = srcs.flatMap((src) => Object.values(src.files)).some((text) => /^(statuses|systems):/m.test(text) && /(count_item|has_item)\(/.test(text));
    assert.ok(uses, `${name}: count_item/has_item in a status or system`);
    const w = World.create(def, 1);
    assert.ok(w.containers.size > 0);
  }
});
