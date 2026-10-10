import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, countOf, formatError, loadPacks, Pathfinder, World, type Definition, type Entity } from '../src/core/index.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, GENRE_AT } from './helpers.ts';

// M8d (specs/m8-social-games.md): two mods of the town built only from
// pack data on the M8 primitives. `noir` is a murder mystery on the old town
// block (clues as journal entries, an accusation that wins or loses);
// `western` is a duel at noon settled by dialogue and a roll. Headless
// scenarios with scripted inputs and fixed seeds.

const NIGHT_TICKS = 9 * 600; // 21:00 → 06:00 at 1 sim second per game minute
const NOON_TICK = 6 * 600; // 06:00 → 12:00
const HALF_PAST_NOON = NOON_TICK + 300;

/** Load a shipped stack, asserting that it loads with no warnings at all. */
function game(name: keyof typeof GAMES): Definition {
  const r = loadPacks(GAMES[name].map(readPack));
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  assert.deepEqual(r.warnings.map(formatError), [], `${name}: warnings`);
  return r.definition;
}

const NOIR = game('noir');
const WESTERN = game('western');

/** A cell of `town_center` in city coordinates. */
const T = (x: number, y: number): [number, number] => [x + GENRE_AT.town.x, y + GENRE_AT.town.y];

/** The crime scene (noir), in city coordinates: the bathroom cabinet, the dresser and the bed upstairs. */
const CABINET = [...T(46, 2), 0] as const;
const DRESSER_UP = [...T(49, 2), 1] as const;
const BED_UP = [...T(56, 2), 1] as const;
/** The crate in the north yard (western), for target practice. */
const CRATE = [...T(29, 2), 0] as const;

function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

/** Step until `done()` holds (checked after each tick) or `max` ticks have passed; returns whether it did. */
function until(w: World, done: () => boolean, max: number): boolean {
  for (let i = 0; i < max; i++) {
    if (done()) return true;
    w.step();
  }
  return done();
}

/** Positions set from outside the simulation (tests only). */
function teleport(e: Entity, x: number, y: number, z = 0): void {
  e.x = e.fromX = x;
  e.y = e.fromY = y;
  e.z = e.fromZ = z;
  e.path = null;
  e.intent = null;
}

const npc = (w: World, archetype: string): Entity => {
  const e = w.entities.find((x) => x.archetype.id === archetype);
  assert.ok(e, `no entity of ${archetype}`);
  return e;
};
const stageOf = (w: World, quest: string): string | null => {
  const q = w.def.quests[w.def.ids.quests[quest]!]!;
  const s = w.questStage[q.index]!;
  return s < 0 ? null : q.stages[s]!.name;
};
const rep = (w: World, faction: string): number => w.reputation[w.def.ids.factions[faction]!]!;
const varOf = (w: World, id: string): number => w.vars[w.def.ids.vars[id]!]!;
const hasEntry = (w: World, id: string): boolean => w.journal().entries.some((e) => e.entry === id);
const value = (w: World, m: string): number => w.value(w.player, m)!;
const give = (w: World, item: string, count: number): void => add(w.player.inv!, w.def.ids.items[item]!, count, w.def.items[w.def.ids.items[item]!]!.weight);
const count = (w: World, item: string): number => countOf(w.player.inv!, w.def.ids.items[item]!);

/** Walk up to an NPC (walk-then-talk, as a click does) and open the conversation; returns the ticks it took. */
function walkAndTalk(w: World, e: Entity, max = 2000): number {
  const start = w.tick;
  const intent = w.approachIntent({ kind: 'talk', entity: e.id });
  if (intent) w.queueIntent(intent);
  else w.queueAction({ kind: 'talk', entity: e.id });
  assert.ok(until(w, () => w.conversation !== null, max), `could not reach ${e.archetype.id} (last action ${JSON.stringify(w.lastAction)})`);
  assert.equal(w.conversation!.npc, e);
  return w.tick - start;
}

/** Open a conversation with an NPC the player already stands next to. */
function talk(w: World, e: Entity): void {
  w.queueAction({ kind: 'talk', entity: e.id });
  w.step();
  assert.ok(w.conversation, `talk to ${e.archetype.id} failed: ${JSON.stringify(w.lastAction)}`);
}

const visible = (w: World): string[] => w.conversationView()!.choices.map((c) => c.text);

/** Choose the visible choice whose text starts with `text`. */
function choose(w: World, text: string): void {
  const k = w.conversationView()!.choices.findIndex((c) => c.text.startsWith(text));
  assert.ok(k >= 0, `no visible choice '${text}' in ${JSON.stringify(visible(w))}`);
  const r = w.choose(k);
  assert.ok(r.ok, `choice '${text}' failed: ${r.reason ?? ''} ${r.error ?? ''}`);
}

function leave(w: World): void {
  const r = w.leaveConversation();
  assert.ok(r.ok, `leave failed: ${r.reason}`);
}

/** Walk to a cell next to `(x, y, z)` and run a tile action there to completion; returns the ticks it took. */
function walkAndAct(w: World, action: string, x: number, y: number, z: number, max = 4000): number {
  const start = w.tick;
  const act = { kind: 'act', action, x, y, z } as const;
  const before = w.lastAction; // a record of the same action, completed last time, must not count
  const intent = w.approachIntent(act);
  if (intent) w.queueIntent(intent);
  else w.queueAction(act);
  const done = () => w.lastAction !== before && w.lastAction?.kind === 'act' && w.lastAction.action === action && w.lastAction.stage === 'complete';
  assert.ok(until(w, done, max), `${action} did not complete (last action ${JSON.stringify(w.lastAction)})`);
  assert.ok(w.lastAction!.ok, `${action} failed: ${w.lastAction!.reason}`);
  return w.tick - start;
}

// ── Shared ──────────────────────────────────────────────────────────────────

test('both mods are listed by the catalog, stack on the town, and patch it by overrides only', () => {
  for (const [name, ns, deps] of [
    ['noir', 'noir', ['std', 'town']],
    ['western', 'wst', ['std', 'std_needs', 'town']],
  ] as const) {
    const def = game(name);
    const info = def.packs.find((p) => p.namespace === ns)!;
    assert.deepEqual([info.kind, [...info.depends]], ['mod', deps], name);
    assert.ok(info.description.length > 0 && !info.description.includes('\n'));
    // Only the mod's own content is new; everything of the town is patched, never redefined.
    const own = (xs: readonly { id: string }[]) => xs.filter((x) => x.id.startsWith(`${ns}:`)).map((x) => x.id);
    assert.deepEqual(own(def.tiles), []);
    assert.deepEqual(own(def.maps), []);
  }
  const patches = (def: Definition) => {
    const lines = formatOverrides(def);
    return lines.slice(lines.indexOf('patches:') + 1).map((l) => l.trim().split(/\s+/).join(' '));
  };
  assert.deepEqual(patches(NOIR), [
    'noir override archetype town:resident [label]',
    'noir override map town:town_center [rooms, spawns]',
    'noir override map town:city [player, populate]',
    'noir override start [defeat.when, defeat.message, victory.when, victory.message]',
    'noir override clock [start]',
    'noir override lighting [tint]',
  ]);
  assert.deepEqual(patches(WESTERN), [
    'wst override archetype town:resident [label, tags, measurements, initial, inventory]',
    'wst override map town:town_center [spawns]',
    'wst override map town:city [rooms, populate]',
    'wst override start [defeat.when, defeat.message, victory.when, victory.message]',
    'wst override clock [start]',
    'wst override lighting [tint]',
  ]);
});

test('settings: start labels, clocks, lighting moods and factions as specified', () => {
  assert.equal(NOIR.archetypes[NOIR.start.player]!.label, 'Detective');
  assert.equal(NOIR.clock.start, 21 * 60);
  assert.equal(NOIR.start.defeat!.message, 'The case is closed.');
  assert.ok(NOIR.lighting && NOIR.lighting.tint.length >= 3);
  const f = (def: Definition, id: string) => def.factions[def.ids.factions[id]!]!;
  assert.deepEqual([f(NOIR, 'noir:police').reputation, f(NOIR, 'noir:mob').reputation, f(NOIR, 'noir:neighbours').hidden], [20, -20, true]);
  assert.equal(f(NOIR, 'noir:mob').relations[f(NOIR, 'noir:police').index], -80);
  assert.equal(f(NOIR, 'noir:police').relations[f(NOIR, 'noir:mob').index], -80);

  assert.equal(WESTERN.archetypes[WESTERN.start.player]!.label, 'Stranger');
  assert.equal(WESTERN.clock.start, 6 * 60);
  assert.deepEqual([f(WESTERN, 'wst:townsfolk').reputation, f(WESTERN, 'wst:law').reputation, f(WESTERN, 'wst:gang').reputation], [0, 10, -60]);
  assert.equal(f(WESTERN, 'wst:law').relations[f(WESTERN, 'wst:gang').index], -100);
  assert.equal(f(WESTERN, 'wst:gang').relations[f(WESTERN, 'wst:townsfolk').index], -50);
  assert.equal(f(WESTERN, 'wst:gang').relations[f(WESTERN, 'wst:law').index], -100);
  const w = World.create(WESTERN, 1);
  assert.deepEqual([value(w, 'wst:aim'), value(w, 'wst:nerve'), count(w, 'wst:coin')], [20, 50, 10]);
  assert.ok(w.player.archetype.tags.includes('living'), 'the Stranger keeps the needs');
});

test('reachability: every NPC and every clue cell is reachable from the start, in both mods', () => {
  for (const [name, def, clues] of [
    ['noir', NOIR, [CABINET, DRESSER_UP, BED_UP]],
    ['western', WESTERN, [CRATE, [...T(27, 25), 0] as const]],
  ] as const) {
    const w = World.create(def, 1);
    const pf = new Pathfinder(w.grid);
    const p = w.player;
    for (const e of w.entities) {
      if (e === p) continue;
      assert.ok(w.grid.walkable(e.x, e.y, e.z), `${name}: ${e.archetype.id} spawned on a non-walkable cell (${e.x}, ${e.y}, ${e.z})`);
      const path = pf.findPathAdjacent(p.x, p.y, e.x, e.y, p.z, e.z);
      assert.ok(path, `${name}: ${e.archetype.id} at (${e.x}, ${e.y}, ${e.z}) is unreachable from (${p.x}, ${p.y})`);
    }
    for (const [x, y, z] of clues) {
      assert.ok(['town:cabinet', 'town:dresser', 'town:bed', 'town:crate'].includes(w.grid.tileAt(x, y, z)!.id), `${name}: (${x}, ${y}, ${z}) is ${w.grid.tileAt(x, y, z)!.id}, not furniture`);
      assert.ok(pf.findPathAdjacent(p.x, p.y, x, y, p.z, z), `${name}: clue cell (${x}, ${y}, ${z}) is unreachable`);
    }
    // Every spawn is a mod archetype of its own namespace, placed by the mod.
    assert.ok(w.entities.length >= 7, `${name}: ${w.entities.length} entities`);
  }
});

test("town loot: the mods leave the old town block's containers and their tables untouched", () => {
  const TOWN = game('town');
  const inBlock = (x: number, y: number) => x >= GENRE_AT.town.x && x < GENRE_AT.town.x + 59 && y >= GENRE_AT.town.y && y < GENRE_AT.town.y + 29;
  /** First most specific distribution for a tile container in a cell (as the world picks it). */
  const tableFor = (def: Definition, w: World, tile: number, x: number, y: number, z: number): string | null => {
    const tags = w.roomTagsAt(x, y, z);
    let best: { room: boolean; table: number } | null = null;
    for (const d of def.distributions) {
      if (d.container !== tile) continue;
      if (d.room !== null && !tags.includes(d.room)) continue;
      if (!best || (d.room !== null && !best.room)) best = { room: d.room !== null, table: d.table };
    }
    return best ? def.loot[best.table]!.id : null;
  };
  const tables = (def: Definition): [string, string | null][] => {
    const w = World.create(def, 1);
    return [...w.containers.values()]
      .filter((c) => c.kind === 'tile' && inBlock(c.x, c.y))
      .map((c) => [`${c.x},${c.y},${c.z}`, tableFor(def, w, c.tile, c.x, c.y, c.z)]);
  };
  const base = tables(TOWN);
  assert.ok(base.length >= 20 && base.some(([, t]) => t === 'town:bedroom_stuff') && base.some(([, t]) => t === 'town:bathroom_meds'));
  assert.deepEqual(tables(NOIR), base);
  assert.deepEqual(tables(WESTERN), base);
  // The noir mod adds no distributions at all, so the block's contents are identical too.
  const contents = (def: Definition) =>
    [...World.create(def, 1).containers.values()].filter((c) => c.kind === 'tile' && inBlock(c.x, c.y)).map((c) => [c.x, c.y, c.z, c.stacks.map((s) => [def.items[s.item]!.id, s.count])]);
  assert.deepEqual(contents(NOIR), contents(TOWN));
  // The western's shells reach the garages' crates through a room-specific entry, never the block.
  const garage = WESTERN.roomTags.indexOf('garage');
  const ww = World.create(WESTERN, 1);
  const bullet = WESTERN.ids.items['wst:bullet']!;
  const crates = [...ww.containers.values()].filter((c) => c.kind === 'tile' && WESTERN.tiles[c.tile]!.id === 'town:crate' && ww.roomTagsAt(c.x, c.y, c.z).includes(garage));
  assert.ok(crates.length >= 10 && crates.some((c) => countOf(c, bullet) > 0), 'shells in some garage crate');
  assert.ok(crates.every((c) => !inBlock(c.x, c.y)));
});

test('mixed stacks load (with warnings): town,zombie,noir and noir,western', () => {
  for (const dirs of [
    [...GAMES.zombie, 'packs/noir'],
    [...GAMES.noir, 'packs/western'],
    [...GAMES.western, 'packs/noir'],
  ]) {
    const r = loadPacks(dirs.map(readPack));
    assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
    assert.ok(r.warnings.length > 0, 'both mods write the same fields');
    assert.ok(r.warnings.every((e) => /also overridden by pack/.test(e.message)));
  }
});

// ── noir ────────────────────────────────────────────────────────────────────


test('noir: a direct solve, walking the block, takes about half of the night and wins', () => {
  const w = World.create(NOIR, 1);
  w.step();
  assert.equal(stageOf(w, 'noir:elm_street'), null, 'the case starts with the sergeant');
  assert.deepEqual([rep(w, 'noir:police'), rep(w, 'noir:mob'), rep(w, 'noir:neighbours')], [20, -20, 10]);

  // Sgt. Hale, at the front door, gives the case.
  walkAndTalk(w, npc(w, 'noir:hale'));
  assert.match(w.conversationView()!.text, /Harold Vane/);
  assert.equal(stageOf(w, 'noir:elm_street'), 'sergeant');
  choose(w, "I'll find your man.");
  assert.equal(w.conversation, null);

  // The widow in the kitchen: her alibi.
  walkAndTalk(w, npc(w, 'noir:widow'));
  choose(w, 'Where were you tonight?');
  assert.ok(hasEntry(w, 'noir:widow_alibi'));
  leave(w);
  assert.equal(varOf(w, 'noir:talked_widow'), 1);
  assert.equal(rep(w, 'noir:neighbours'), 20, 'gentle with the widow');

  // The lodger in his room: out all night, he says. No light to ask about yet.
  walkAndTalk(w, npc(w, 'noir:pike'));
  assert.ok(!visible(w).some((c) => /light/.test(c)), 'the light needs Dot first');
  leave(w);
  w.step();
  assert.equal(stageOf(w, 'noir:elm_street'), 'household');

  // Dot, across the road.
  walkAndTalk(w, npc(w, 'noir:dot'));
  choose(w, 'What did you see tonight?');
  assert.ok(hasEntry(w, 'noir:dot_light'));
  leave(w);

  // Upstairs: the mattress (a red herring), then the locked cabinet, slowly.
  walkAndAct(w, 'noir:search_bed', ...BED_UP);
  assert.ok(hasEntry(w, 'noir:betting_slip'));
  assert.equal(stageOf(w, 'noir:elm_street'), 'name_killer', 'three clues known');
  const slow = walkAndAct(w, 'noir:search_cabinet', ...CABINET);
  assert.ok(slow >= NOIR.actions[NOIR.ids.actions['noir:search_cabinet']!]!.duration.ticks, `picking the lock took ${slow} ticks`);
  assert.ok(hasEntry(w, 'noir:ledger'));
  assert.equal(rep(w, 'noir:police'), 20, 'no crime in picking a lock quietly');
  // Searched once: nothing more there (both ways in), while the dresser is still worth a look.
  const atCabinet = w.interactionsAt(...CABINET).filter((i) => i.kind === 'act');
  assert.deepEqual(
    atCabinet.map((i) => [i.label, i.ok, i.unavailable]),
    [
      ['Search', false, 'Nothing more here'],
      ['Force the drawer', false, 'Nothing more here'],
    ],
  );
  assert.deepEqual(
    w.interactionsAt(...DRESSER_UP).filter((i) => i.kind === 'act').map((i) => [i.label, i.ok]),
    [['Search', true]],
  );

  // Back to Pike about the light: the contradiction.
  walkAndTalk(w, npc(w, 'noir:pike'));
  choose(w, 'About the light');
  assert.ok(hasEntry(w, 'noir:pike_lied'));
  leave(w);

  // Hale hears the accusation. Only Pike's is open: the others lack clues.
  walkAndTalk(w, npc(w, 'noir:hale'));
  const choices = w.conversationView()!.choices;
  assert.deepEqual(
    choices.map((c) => [c.text.split('.')[0], c.ok, c.unavailable ?? '']),
    [
      ['It was Pike', true, ''],
      ['The widow did it', true, ''], // her alibi is a clue against her, for a hasty detective
      ["Mickey's people did it", true, ''], // the betting slip
      ['Not yet', true, ''],
    ],
  );
  choose(w, 'It was Pike');
  assert.equal(stageOf(w, 'noir:elm_street'), 'solved');
  assert.match(w.conversationView()!.text, /Book him/);
  leave(w);
  w.step();
  assert.ok(w.victory, 'won');
  assert.equal(w.victory!.message, 'Case closed. Pike goes down for Harold Vane.');
  assert.deepEqual(w.journal().quests.map((q) => [q.title, q.state]), [['Death on Elm Street', 'success']]);
  assert.match(w.journal().quests[0]!.text, /ledger/);
  // About half of the night, walking the block and picking the lock the slow way.
  assert.ok(w.tick > NIGHT_TICKS * 0.3 && w.tick < NIGHT_TICKS * 0.7, `solved at tick ${w.tick} of ${NIGHT_TICKS}`);
  // Frozen once won.
  const h = w.hash();
  steps(w, 5);
  assert.equal(w.hash(), h);
});

test('noir: naming the wrong man loses, and the journal says which ending it was', () => {
  const w = World.create(NOIR, 2);
  w.step();
  walkAndTalk(w, npc(w, 'noir:hale'));
  choose(w, "I'll find your man.");
  // Without a clue against anyone, every accusation is closed: "You need more than a hunch".
  walkAndTalk(w, npc(w, 'noir:hale'));
  assert.deepEqual(
    w.conversationView()!.choices.map((c) => [c.ok, c.unavailable ?? '']),
    [
      [false, 'You need more than a hunch'],
      [false, 'You need more than a hunch'],
      [false, 'You need more than a hunch'],
      [true, ''],
    ],
  );
  leave(w);
  // The torn photograph upstairs points at the widow.
  walkAndAct(w, 'noir:search_dresser', ...DRESSER_UP);
  assert.ok(hasEntry(w, 'noir:photograph'));
  walkAndTalk(w, npc(w, 'noir:hale'));
  choose(w, 'The widow did it');
  assert.equal(stageOf(w, 'noir:elm_street'), 'wrong_man');
  leave(w);
  w.step();
  assert.ok(w.defeat && !w.victory);
  assert.equal(w.defeat!.message, 'The case is closed.');
  const q = w.journal().quests[0]!;
  assert.deepEqual([q.state, q.stage], ['failure', 'wrong_man']);
  assert.match(q.text, /wrong one/);
  // Hale will not talk any more.
  assert.equal(w.interactionsAt(npc(w, 'noir:hale').x, npc(w, 'noir:hale').y).length, 0, 'the world has ended');
});

test('noir: dawn without a name is a cold case; before that the night runs its course', () => {
  const w = World.create(NOIR, 3);
  w.step();
  walkAndTalk(w, npc(w, 'noir:hale'));
  choose(w, "I'll find your man.");
  assert.ok(until(w, () => w.ended, NIGHT_TICKS + 20));
  assert.equal(w.tick, NIGHT_TICKS + 1, 'defeat on the first tick of 06:00');
  assert.equal(w.defeat!.message, 'The case is closed.');
  assert.deepEqual(w.journal().quests.map((q) => [q.stage, q.state]), [['cold_case', 'failure']]);
  // The officer kept to his beat all night.
  const o = npc(w, 'noir:officer');
  assert.ok(Math.max(Math.abs(o.x - o.homeX), Math.abs(o.y - o.homeY)) <= 10);
  assert.ok(o.x !== o.homeX || o.y !== o.homeY, 'he did move');
});

test('noir: forcing the drawer in sight of the officer drops police standing and raises the mob, out of sight it does not', () => {
  const run = (officerAt: [number, number]) => {
    const w = World.create(NOIR, 4);
    const officer = npc(w, 'noir:officer');
    teleport(officer, ...officerAt);
    teleport(w.player, ...T(46, 3));
    w.step();
    const events = w.journalEvents.length;
    w.queueAction({ kind: 'act', action: 'noir:force_drawer', x: CABINET[0], y: CABINET[1], z: 0 });
    // Keep the officer where he is while the drawer gives (three seconds).
    assert.ok(until(w, () => w.lastAction?.stage === 'complete', 60));
    assert.ok(w.lastAction!.ok, w.lastAction!.reason ?? "");
    assert.ok(hasEntry(w, 'noir:ledger'), 'the ledger either way');
    return { w, events };
  };
  // In the hallway, looking through the bathroom door.
  const seen = run(T(46, 7));
  assert.deepEqual([rep(seen.w, 'noir:police'), rep(seen.w, 'noir:mob'), rep(seen.w, 'noir:neighbours')], [-10, 4, 1]);
  assert.ok(seen.w.journalEvents.some((e) => e.kind === 'reputation' && e.faction === 'noir:police' && e.from === 'Liked' && e.to === 'Neutral'));
  // Mickey now talks to a Neutral: no bribe needed.
  const m = npc(seen.w, 'noir:mickey');
  teleport(seen.w.player, m.x, m.y + 1);
  talk(seen.w, m);
  assert.match(seen.w.conversationView()!.text, /two hundred/);
  assert.ok(hasEntry(seen.w, 'noir:mickey_debt'));
  leave(seen.w);
  // And Dot, with the neighbours cooled to 1, still opens the door; a bribe would shut it.
  // Out on the road, thirty tiles west: nobody sees a thing.
  const unseen = run(T(10, 13));
  assert.deepEqual([rep(unseen.w, 'noir:police'), rep(unseen.w, 'noir:mob'), rep(unseen.w, 'noir:neighbours')], [20, -20, 10]);
  assert.ok(!unseen.w.journalEvents.some((e) => e.kind === 'reputation'));
});

test('noir: Mickey wants a Neutral mob or a bribe, which the police notice; hostile police close the case', () => {
  const w = World.create(NOIR, 5);
  w.step();
  const m = npc(w, 'noir:mickey');
  teleport(w.player, m.x, m.y + 1);
  talk(w, m);
  assert.match(w.conversationView()!.text, /Cops' friends/);
  choose(w, 'Slip him a few bills.');
  assert.deepEqual([rep(w, 'noir:mob'), rep(w, 'noir:police'), rep(w, 'noir:neighbours')], [0, 4, 2]);
  assert.ok(hasEntry(w, 'noir:mickey_debt'));
  leave(w);
  // Mouth off at Hale, then the drawer in front of the officer: Hostile.
  const hale = npc(w, 'noir:hale');
  teleport(w.player, hale.x, hale.y + 1);
  talk(w, hale);
  choose(w, "I don't take orders");
  assert.equal(rep(w, 'noir:police'), -26);
  leave(w);
  teleport(npc(w, 'noir:officer'), ...T(46, 7));
  teleport(w.player, ...T(46, 3));
  w.queueAction({ kind: 'act', action: 'noir:force_drawer', x: CABINET[0], y: CABINET[1], z: 0 });
  w.step();
  assert.ok(until(w, () => w.lastAction?.kind === 'act' && w.lastAction.stage === 'complete', 60));
  assert.ok(w.lastAction!.ok, w.lastAction!.reason ?? "");
  assert.equal(rep(w, 'noir:police'), -56);
  // Dot shuts the door on a crook.
  assert.ok(rep(w, 'noir:neighbours') < 0);
  const dot = npc(w, 'noir:dot');
  teleport(w.player, dot.x, dot.y + 1);
  talk(w, dot);
  assert.match(w.conversationView()!.text, /crooks/);
  assert.deepEqual(visible(w), ['Leave']);
  leave(w);
  // Hale refuses to hear a name, however good the clues.
  teleport(w.player, hale.x, hale.y + 1);
  talk(w, hale);
  assert.match(w.conversationView()!.text, /Get off my block/);
  assert.deepEqual(visible(w), ['Leave']);
  leave(w);
  assert.ok(until(w, () => w.ended, NIGHT_TICKS + 20));
  assert.deepEqual(w.journal().quests.map((q) => q.stage), ['cold_case']);
});

// ── western ─────────────────────────────────────────────────────────────────

const SHERIFF_AT = T(31, 13);

/** See the sheriff: the quest, a revolver and shells. */
function seeSheriff(w: World): void {
  walkAndTalk(w, npc(w, 'wst:sheriff'));
  choose(w, "I'll be on Main Street");
  assert.equal(stageOf(w, 'wst:high_noon'), 'get_ready');
  assert.deepEqual([count(w, 'wst:revolver'), count(w, 'wst:bullet')], [1, 30]);
  leave(w);
}

/** Practise on the bottles until aim reaches 70 (nine rounds from 20). */
function practise(w: World): void {
  let rounds = 0;
  while (value(w, 'wst:aim') < 70) {
    walkAndAct(w, 'wst:shoot_bottles', ...CRATE);
    rounds++;
  }
  assert.equal(rounds, 9);
  assert.equal(value(w, 'wst:aim'), 74);
  assert.equal(count(w, 'wst:bullet'), 3);
  const more = w.interactionsAt(...CRATE).find((i) => i.kind === 'act' && i.id.includes('shoot'))!;
  assert.deepEqual([more.ok, more.unavailable], [false, 'Your aim is as good as practice makes it']);
}

/** The three favours: a bandage for the doc, crackers for the kid, a round at the saloon. */
function favours(w: World): void {
  give(w, 'town:bandage', 1);
  const coins = count(w, 'wst:coin');
  const townsfolk = rep(w, 'wst:townsfolk');
  const gang = rep(w, 'wst:gang');
  walkAndTalk(w, npc(w, 'wst:doc'));
  choose(w, "Here's a bandage.");
  leave(w);
  walkAndTalk(w, npc(w, 'wst:kid'));
  choose(w, 'Here. Crackers.');
  leave(w);
  const bar = npc(w, 'wst:bartender');
  teleport(w.player, bar.x, bar.y + 1); // the saloon is a long walk: skip it
  talk(w, bar);
  choose(w, 'A round for the house.');
  choose(w, 'Obliged.');
  assert.equal(w.conversation, null);
  assert.equal(count(w, 'wst:whiskey'), 1);
  assert.equal(count(w, 'wst:coin'), coins + 10 + 10 - 5 + 10);
  assert.equal(rep(w, 'wst:townsfolk'), townsfolk + 60, 'Trusted');
  assert.equal(rep(w, 'wst:gang'), gang - 30, 'spread: the gang hates it');
  assert.equal(count(w, 'town:bandage') + count(w, 'town:crackers'), 0);
}

/** Wait for noon, then stand before Black Jack in the middle of Main Street. */
function faceJack(w: World): Entity {
  const jack = npc(w, 'wst:black_jack');
  const start: [number, number] = [jack.x, jack.y];
  assert.deepEqual(start, T(57, 14), 'the far end of Main Street');
  teleport(w.player, ...T(31, 20)); // out of the riders' way, in a yard
  assert.ok(until(w, () => w.tick >= NOON_TICK, NOON_TICK + 1));
  assert.deepEqual([jack.x, jack.y], start, 'he waits until noon');
  w.step(); // the first tick of 12:00: the quest phase sees the hour
  assert.equal(stageOf(w, 'wst:high_noon'), 'face');
  const arrived = () => Math.max(Math.abs(jack.x - SHERIFF_AT[0]), Math.abs(jack.y - SHERIFF_AT[1])) <= 1;
  assert.ok(until(w, arrived, 200), `Black Jack at (${jack.x}, ${jack.y}) after the bell`);
  const spot: [number, number] = [jack.x, jack.y];
  steps(w, 50);
  assert.deepEqual([jack.x, jack.y], spot, 'and there he stays');
  teleport(w.player, jack.x, jack.y + 1);
  talk(w, jack);
  assert.match(w.conversationView()!.text, /Last chance to crawl/);
  assert.equal(w.conversationView()!.leave, false);
  assert.equal(varOf(w, 'wst:faced_jack'), 1);
  return jack;
}

interface Duel {
  draw: number;
  stage: string | null;
  hash: string;
}

/** The whole morning and the draw, scripted; the outcome follows the roll. */
function duel(seed: number): Duel {
  const w = World.create(WESTERN, seed);
  w.step();
  assert.equal(stageOf(w, 'wst:high_noon'), 'see_sheriff');
  seeSheriff(w);
  practise(w);
  favours(w);
  // Dutch courage: tipsy adds nerve and takes aim while it lasts.
  const aim = value(w, 'wst:aim');
  const nerve = value(w, 'wst:nerve');
  w.queueAction({ kind: 'use', item: 'wst:whiskey' });
  steps(w, 2);
  assert.ok(w.player.st[WESTERN.ids.statuses['wst:tipsy']!] === 1, 'tipsy');
  steps(w, 200);
  assert.ok(value(w, 'wst:nerve') > nerve + 10 && value(w, 'wst:aim') < aim - 3, `tipsy: nerve ${value(w, 'wst:nerve')}, aim ${value(w, 'wst:aim')}`);
  faceJack(w);
  assert.deepEqual(visible(w), ['Go for your gun', 'Talk him down', 'Pay him off', 'Back down']);
  assert.ok(w.conversationView()!.choices.every((c) => c.ok), 'armed, Trusted and 35 dollars');
  choose(w, 'Go for your gun');
  const draw = varOf(w, 'wst:draw');
  assert.equal(w.conversationView()!.leave, false, 'the roll cannot be dodged');
  assert.deepEqual(visible(w), ['Fire!'], 'exactly one of the two');
  choose(w, 'Fire!');
  const stage = stageOf(w, 'wst:high_noon');
  assert.equal(stage, draw >= 118 ? 'won' : 'shot', `draw ${draw}`);
  leave(w);
  w.step();
  if (stage === 'won') assert.equal(w.victory?.message, 'Black Jack is gone. Main Street is yours.');
  else assert.equal(w.defeat?.message, 'They buried you on the hill at sundown.');
  return { draw, stage, hash: w.hash() };
}

test('western: practise to 70, do the favours, wait for noon and draw; the same seed gives the same duel', () => {
  const first = duel(1);
  assert.deepEqual(duel(1), first);
  // Another seed may roll the other way; the outcome always follows the roll.
  const other = duel(7);
  assert.ok(other.draw > 0);
});

test('western: Trusted townsfolk talk him down; a stranger nobody knows cannot', () => {
  const w = World.create(WESTERN, 2);
  w.step();
  seeSheriff(w);
  faceJack(w);
  const talkDown = w.conversationView()!.choices.find((c) => c.text === 'Talk him down')!;
  assert.deepEqual([talkDown.ok, talkDown.unavailable], [false, 'Nobody on this street would back you']);
  const pay = w.conversationView()!.choices.find((c) => c.text === 'Pay him off')!;
  assert.deepEqual([pay.ok, pay.reason, pay.missing?.map((m) => [m.item, m.count])], [false, 'missing', [['wst:coin', 20]]]);
  assert.equal(w.choose(1).ok, false, 'disabled');
  // Back for the favours (the world stays paused: leave is forbidden, so this is a fresh noon).
  const v = World.create(WESTERN, 2);
  v.step();
  seeSheriff(v);
  favours(v);
  faceJack(v);
  choose(v, 'Talk him down');
  assert.match(v.conversationView()!.text, /Every window has a face/);
  assert.equal(stageOf(v, 'wst:high_noon'), 'talked_down');
  leave(v);
  v.step();
  assert.ok(v.victory);
  assert.match(v.journal().quests[0]!.text, /spat, and rode out/);
});

test('western: thirty dollars pay him off', () => {
  const w = World.create(WESTERN, 3);
  w.step();
  seeSheriff(w);
  give(w, 'wst:coin', 25);
  faceJack(w);
  choose(w, 'Pay him off');
  assert.equal(count(w, 'wst:coin'), 5);
  assert.equal(stageOf(w, 'wst:high_noon'), 'paid_off');
  leave(w);
  w.step();
  assert.ok(w.victory);
  assert.match(w.journal().quests[0]!.text, /Thirty dollars/);
});

test('western: not showing by half past twelve is cowardice; so is backing down to his face', () => {
  const w = World.create(WESTERN, 4);
  w.step();
  seeSheriff(w);
  teleport(w.player, ...T(31, 20));
  assert.ok(until(w, () => w.ended, HALF_PAST_NOON + 20));
  assert.equal(w.tick, HALF_PAST_NOON + 1);
  assert.deepEqual(w.journal().quests.map((q) => [q.stage, q.state]), [['coward', 'failure']]);
  assert.equal(w.defeat!.message, 'They buried you on the hill at sundown.');

  const v = World.create(WESTERN, 4);
  v.step();
  seeSheriff(v);
  faceJack(v);
  choose(v, 'Back down');
  assert.equal(stageOf(v, 'wst:high_noon'), 'coward');
  leave(v);
  v.step();
  assert.ok(v.defeat);
});

test('western: before noon Black Jack only taunts; unarmed, the draw is closed', () => {
  const w = World.create(WESTERN, 5);
  w.step();
  const jack = npc(w, 'wst:black_jack');
  teleport(w.player, jack.x, jack.y + 1);
  talk(w, jack);
  assert.match(w.conversationView()!.text, /Noon, stranger/);
  assert.equal(varOf(w, 'wst:faced_jack'), 0);
  leave(w);
  // No sheriff, no revolver: at noon the gun is out of reach.
  faceJack(w);
  const gun = w.conversationView()!.choices.find((c) => c.text === 'Go for your gun')!;
  assert.deepEqual([gun.ok, gun.unavailable], [false, "You're unarmed"]);
});

test('western: a hostile rider waits until ten, then pursues the Stranger on sight and drains nerve', () => {
  const w = World.create(WESTERN, 6);
  const rider = npc(w, 'wst:rider');
  const home: [number, number] = [rider.x, rider.y];
  // In plain sight on Main Street at nine: nothing yet.
  teleport(w.player, rider.x + 5, rider.y);
  assert.ok(until(w, () => w.tick >= 3 * 600, 3 * 600 + 1));
  assert.deepEqual([rider.x, rider.y], home, 'idle before ten');
  assert.equal(value(w, 'wst:nerve'), 50);
  // Ten o'clock: he comes over and stands at your elbow.
  assert.ok(until(w, () => w.tick >= 4 * 600 + 10, 700));
  const near = () => Math.max(Math.abs(rider.x - w.player.x), Math.abs(rider.y - w.player.y)) <= 1;
  assert.ok(until(w, near, 200), `rider at (${rider.x}, ${rider.y}), player at (${w.player.x}, ${w.player.y})`);
  const nerve = value(w, 'wst:nerve');
  steps(w, 100);
  assert.ok(varOf(w, 'wst:crowded') >= 1);
  assert.equal(w.player.st[WESTERN.ids.statuses['wst:crowded']!], 1);
  assert.ok(value(w, 'wst:nerve') <= nerve - 20, `nerve ${nerve} → ${value(w, 'wst:nerve')}`);
  // Walk off down the street, out of his sight: he gives up, and the var clears.
  teleport(w.player, ...T(50, 20));
  steps(w, 30);
  assert.equal(varOf(w, 'wst:crowded'), 0);
  assert.equal(w.player.st[WESTERN.ids.statuses['wst:crowded']!], 0);
});

test('western: duel odds — about 90 % with aim 70 and nerve 60, about 30 % with no practice (300 seeds each)', () => {
  // The draw is roll(1, 100) + 1.1 × aim + nerve / 2 against 118: exact odds first.
  const odds = (aim: number, nerve: number) => [...Array(100).keys()].filter((r) => r + 1 + 1.1 * aim + nerve / 2 >= 118).length / 100;
  assert.equal(odds(70, 60), 0.9);
  assert.equal(odds(20, 50), 0.3);
  // Then through the real dialogue, reseeding the world RNG per trial and
  // rewinding the quest (tests only) so the same noon can be replayed.
  const w = World.create(WESTERN, 1);
  w.step();
  const jack = npc(w, 'wst:black_jack');
  give(w, 'wst:revolver', 1);
  teleport(w.player, ...T(40, 20));
  assert.ok(until(w, () => w.tick >= NOON_TICK + 120, NOON_TICK + 121));
  teleport(w.player, jack.x, jack.y + 1);
  const q = WESTERN.ids.quests['wst:high_noon']!;
  const face = WESTERN.quests[q]!.stages.findIndex((s) => s.name === 'face');
  const measure = (aim: number, nerve: number, trials: number): number => {
    let wins = 0;
    for (let seed = 1; seed <= trials; seed++) {
      w.player.m[WESTERN.ids.measurements['wst:aim']!] = aim;
      w.player.m[WESTERN.ids.measurements['wst:nerve']!] = nerve;
      w.rng.state = seed * 7919;
      talk(w, jack);
      choose(w, 'Go for your gun');
      const draw = varOf(w, 'wst:draw');
      choose(w, 'Fire!');
      const stage = stageOf(w, 'wst:high_noon');
      assert.equal(stage, draw >= 118 ? 'won' : 'shot');
      if (stage === 'won') wins++;
      leave(w);
      w.questStage[q] = face;
      w.questEnd[q] = 0;
    }
    return wins / trials;
  };
  const trained = measure(70, 60, 300);
  const green = measure(20, 50, 300);
  assert.ok(trained > 0.82 && trained < 0.97, `trained: ${trained}`);
  assert.ok(green > 0.21 && green < 0.39, `green: ${green}`);
});
