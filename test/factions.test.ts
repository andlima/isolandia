import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleKey, journalMessage, type KeyState } from '../src/ascii/terminal.ts';
import {
  attitude,
  DEFAULT_TIERS,
  formatError,
  journalLines,
  journalToast,
  lineOfSight,
  loadPacks,
  loadPacksOrThrow,
  standingRows,
  World,
  type Definition,
  type Entity,
  type LoadError,
  type PackSource,
  type SaveFile,
} from '../src/core/index.ts';
import { compileSource, type ExprContext, type Value } from '../src/core/expr/index.ts';
import { journalView, hasJournal } from '../src/web/panels.ts';
import { hoverInfo, hoverTitleLine } from '../src/web/menu.ts';
import { formatOverrides } from '../src/cli/overrides.ts';
import { assertRoundTrip, fixture } from './helpers.ts';

// Factions (docs/packs.md#factions) on a small two-floor fixture with thin
// walls. Police: two officers and a sergeant (who talks); the mob: a thug
// with a behavior; a clerk without a faction; a cult acolyte upstairs. The
// player's own archetype is in the police, which `attitude` ignores.
//
// Floor 0 (7×3):                         Floor 1: empty but for the acolyte at (6, 2).
//   (0,0) player  (1,0) officer  …  (4,0) | (5,0) officer behind a wall
//   (0,1) sergeant                                       (6,1) thug
//   (0,2) clerk

const TILES = `tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: wall, label: Wall, glyph: "#", color: gray, walkable: false, edge: true }
`;

const MAP = `maps:
  - id: room
    legend:
      ".": { tile: floor }
      "@": { tile: floor, player: true }
      "c": { tile: floor, spawn: officer }
      "s": { tile: floor, spawn: sergeant }
      "t": { tile: floor, spawn: thug }
      "n": { tile: floor, spawn: clerk }
      "a": { tile: floor, spawn: acolyte }
      "|": { tile: wall }
      "-": { tile: wall }
    edges: true
    floors:
      - rows:
          - "+-+-+-+-+-+-+-+"
          - "|@ c . . .|c .|"
          - "+ + + + + + + +"
          - "|s . . . . . t|"
          - "+ + + + + + + +"
          - "|n . . . . . .|"
          - "+-+-+-+-+-+-+-+"
      - rows:
          - "+-+-+-+-+-+-+-+"
          - "|. . . . . . .|"
          - "+ + + + + + + +"
          - "|. . . . . . .|"
          - "+ + + + + + + +"
          - "|. . . . . . a|"
          - "+-+-+-+-+-+-+-+"
start:
  map: room
  player: hero
`;

const ARCHETYPES = `archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, measurements: [hp, food], ticks_per_turn: 0, faction: police }
  - { id: officer, label: Officer, glyph: c, color: blue, ticks_per_turn: 0, faction: police }
  - { id: sergeant, label: Sergeant, glyph: s, color: blue, ticks_per_turn: 0, faction: police, dialogue: desk }
  - { id: thug, label: Thug, glyph: t, color: red, ticks_per_step: 1, ticks_per_turn: 0, faction: mob, behavior: gang }
  - { id: clerk, label: Clerk, glyph: n, color: white, ticks_per_turn: 0 }
  - { id: acolyte, label: Acolyte, glyph: a, color: white, ticks_per_turn: 0, faction: cult }
`;

const FACTIONS = `factions:
  - id: police
    label: Police
    relations: { mob: -50 }
  - id: mob
    label: Mob
    reputation: -20
    relations: { police: -80 }
  - id: town
    label: Townsfolk
    relations: { police: 33.3 }
    hidden: true
  - id: cult
    label: Cult
    hostile_below: -10
    friendly_from: 10
    tiers: [{ from: -100, label: Enemy }, { from: 0, label: Friend }]
`;

const STORY = `behaviors:
  - id: gang
    initial: wait
    states:
      wait: { do: idle, on: [{ when: 'hostile(self, player) and can_see(self, player, 8)', to: chase }] }
      chase: { do: pursue, target: player }
dialogues:
  - id: desk
    start: hi
    nodes:
      hi:
        text: Yes?
        choices:
          - { text: Any work?, when: 'reputation("police") >= 10', unavailable: Only for friends, to: end }
          - { text: Insult, effects: [{ type: reputation, faction: police, delta: -5, witnessed: 3 }], to: hi }
          - { text: Bribe, effects: [{ type: reputation, faction: police, delta: 20 }], to: hi }
actions:
  - id: pick
    label: Pick a lock
    target: self
    effects: [{ type: reputation, faction: police, delta: -15, witnessed: 8, spread: true }]
  - id: peek
    label: Peek
    target: self
    effects: [{ type: reputation, faction: police, delta: -1, witnessed: 1.5 }]
  - id: help
    label: Help
    target: self
    effects: [{ type: reputation, faction: police, delta: 10, spread: true }]
  - id: bribe
    label: Bribe
    target: self
    effects: [{ type: reputation, faction: police, delta: "250 * 2", spread: true }, { type: reputation, faction: police, delta: -1 }, { type: reputation, faction: police, delta: -1 }]
`;

const FILES: Record<string, string> = { 'tiles.yaml': TILES, 'map.yaml': MAP, 'archetypes.yaml': ARCHETYPES, 'factions.yaml': FACTIONS, 'story.yaml': STORY };

/** Entity ids of the fixture (spawns by floor, then row-major). */
const PLAYER = 0;
const OFFICER = 1;
const WALLED = 2;
const SERGEANT = 3;
const THUG = 4;
const CLERK = 5;
const ACOLYTE = 6;

function def(files: Record<string, string> = {}): Definition {
  return loadPacksOrThrow([fixture({ ...FILES, ...files })]);
}

function world(files: Record<string, string> = {}, seed = 1): World {
  return World.create(def(files), seed);
}

function errorsOf(files: Record<string, string>, extra: PackSource[] = []): readonly LoadError[] {
  const r = loadPacks([fixture({ ...FILES, ...files }), ...extra]);
  assert.equal(r.ok, false, 'expected the load to fail');
  return r.ok ? [] : r.errors;
}

function expectError(errors: readonly LoadError[], message: RegExp, path?: string): void {
  const hit = errors.find((e) => message.test(e.message) && (path === undefined || e.path === path));
  assert.ok(hit, `no error ${message}${path ? ` at ${path}` : ''}\ngot:\n${errors.map(formatError).join('\n')}`);
}

const rep = (w: World, id: string): number => w.reputation[w.def.ids.factions[`t:${id}`]!]!;
const setRep = (w: World, id: string, v: number): void => void (w.reputation[w.def.ids.factions[`t:${id}`]!] = v);

/** Move an entity (the index catches up by itself). */
function place(e: Entity, x: number, y: number, z = 0): void {
  e.x = x;
  e.y = y;
  e.z = z;
}

/** Run a self action of the player now (one tick). */
function act(w: World, action: string): World {
  w.queueAction({ kind: 'act', action: `t:${action}` });
  w.step();
  assert.equal(w.lastAction?.ok, true, `action ${action}: ${JSON.stringify(w.lastAction)}`);
  return w;
}

/** Send every police member but `keep` upstairs, out of the way. */
function clearPolice(w: World, keep: number[] = []): void {
  [OFFICER, WALLED, SERGEANT].filter((id) => !keep.includes(id)).forEach((id, k) => place(w.entities[id]!, k, 0, 1));
}

/** Evaluate an expression as the world would, with `self`, the player and an optional `npc`. */
function evaluate(w: World, source: string, self: Entity = w.player, npc: Entity | null = null): Value {
  const d = w.def;
  const r = compileSource(source, {
    resolveMeasurement: (ref) => ({ error: `no measurement '${ref}' here` }),
    resolveFaction: (ref) => {
      const k = d.ids.factions[ref.includes(':') ? ref : `t:${ref}`];
      return k === undefined ? { error: `unknown faction '${ref}'` } : { index: k };
    },
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
    inRoom: () => false,
    los: (x0, y0, x1, y1, z0, z1) => lineOfSight(w.grid, x0, y0, x1, y1, z0, z1),
    warn: () => {},
    vars: w.vars,
    questStage: w.questStage,
    questEnd: w.questEnd,
    journalHas: w.journalHas,
    factions: w.factionTable,
  };
  return r.expr.fn(ctx);
}

// ── Loader ──────────────────────────────────────────────────────────────────

test('factions: defaults, relations by index, members, spread targets; archetype faction', () => {
  const d = def();
  const [police, mob, town, cult] = d.factions;
  assert.deepEqual(
    d.factions.map((f) => f.id),
    ['t:police', 't:mob', 't:town', 't:cult'],
  );
  assert.deepEqual([police!.label, police!.reputation, police!.hostileBelow, police!.friendlyFrom, police!.hidden], ['Police', 0, -50, 50, false]);
  assert.deepEqual(police!.tiers, DEFAULT_TIERS);
  assert.deepEqual(
    DEFAULT_TIERS.map((t) => [t.from, t.label]),
    [
      [-100, 'Hostile'],
      [-50, 'Wary'],
      [-10, 'Neutral'],
      [10, 'Liked'],
      [50, 'Trusted'],
    ],
  );
  assert.deepEqual(police!.relations, [0, -50, 0, 0]);
  assert.deepEqual(mob!.relations, [-80, 0, 0, 0]);
  assert.equal(mob!.reputation, -20);
  assert.equal(town!.hidden, true);
  assert.deepEqual([cult!.hostileBelow, cult!.friendlyFrom], [-10, 10]);
  assert.deepEqual(cult!.tiers, [
    { from: -100, label: 'Enemy' },
    { from: 0, label: 'Friend' },
  ]);
  assert.deepEqual(
    d.factions.map((f) => f.members),
    [true, true, false, true],
  );
  // Where a change of police spreads: the mob (-80) and the town (33.3); the cult has no relation to it.
  assert.deepEqual(police!.spread, [
    { faction: 1, relation: -80 },
    { faction: 2, relation: 33.3 },
  ]);
  assert.deepEqual(mob!.spread, [{ faction: 0, relation: -50 }]);
  assert.deepEqual(
    d.archetypes.map((a) => a.faction),
    [0, 0, 0, 1, null, 3],
  );
  assert.equal(d.ids.factions['t:cult'], 3);
});

test('factions: load errors in fields, relations, thresholds and tiers', () => {
  const e = (body: string) => errorsOf({ 'factions.yaml': `${FACTIONS}${body}` });
  expectError(e('  - { id: x }\n'), /missing required field 'label'/, 'factions[4]');
  expectError(e('  - { id: x, label: X, reputation: 101 }\n'), /field 'reputation' \(101\) is outside \[-100, 100\]/, 'factions[4].reputation');
  expectError(e('  - { id: x, label: X, reputation: lots }\n'), /field 'reputation' must be a number in \[-100, 100\]/, 'factions[4].reputation');
  expectError(e('  - { id: x, label: X, relations: { x: 10 } }\n'), /cannot have a relation to itself/, 'factions[4].relations.x');
  expectError(e('  - { id: x, label: X, relations: { polise: 10 } }\n'), /unknown faction 'polise' \(did you mean 'police'\?\)/, 'factions[4].relations.polise');
  expectError(e('  - { id: x, label: X, relations: { mob: -120 } }\n'), /relation to 't:mob' \(-120\) is outside \[-100, 100\]/);
  expectError(e('  - { id: x, label: X, hostile_below: 10, friendly_from: 10 }\n'), /friendly_from \(10\) must be greater than hostile_below \(10\)/, 'factions[4].friendly_from');
  expectError(e('  - { id: x, label: X, hostile_below: 60 }\n'), /friendly_from \(50\) must be greater than hostile_below \(60\)/, 'factions[4].hostile_below');
  expectError(e('  - { id: x, label: X, tiers: [{ from: -50, label: A }] }\n'), /the first tier must start at -100, got -50/, 'factions[4].tiers[0].from');
  expectError(e('  - { id: x, label: X, tiers: [{ from: -100, label: A }, { from: 0, label: B }, { from: 0, label: C }] }\n'), /ascending 'from': 0 is not above 0/, 'factions[4].tiers[2].from');
  expectError(e('  - { id: x, label: X, tiers: [] }\n'), /at least one tier/, 'factions[4].tiers');
  expectError(e('  - { id: x, label: X, tiers: [{ from: -100 }] }\n'), /missing required field 'label'/, 'factions[4].tiers[0]');
  expectError(e('  - { id: x, label: X, tiers: [{ from: -100, label: A, color: red }] }\n'), /unknown tier field 'color'/);
  expectError(e('  - { id: x, label: X, hidden: maybe }\n'), /must be a boolean/, 'factions[4].hidden');
  expectError(e('  - { id: x, label: X, rank: 1 }\n'), /unknown faction field 'rank'/);
  expectError(e('  - { id: police, label: X }\n'), /duplicate faction id 't:police'/);
  expectError(errorsOf({ 'archetypes.yaml': ARCHETYPES.replace('faction: cult', 'faction: cutl') }), /unknown faction 'cutl' \(did you mean 'cult'\?\)/, 'archetypes[5].faction');
});

test('expressions: faction ids are string literals resolved at load; entity arguments are checked', () => {
  const sys = (expr: string) => errorsOf({ 's.yaml': `systems:\n  - { id: s, when: '${expr}', effects: [{ type: apply, measurement: hp, delta: 1 }] }\n` });
  expectError(sys('reputation("polise") > 0'), /reputation: unknown faction 'polise' \(did you mean 'police'\?\)/, 'systems[0].when');
  expectError(sys('self.in_faction("mbo")'), /in_faction: unknown faction 'mbo' \(did you mean 'mob'\?\)/);
  expectError(sys('in_faction(self, 1)'), /in_faction\(\) expects a string literal faction id/);
  expectError(sys('reputation(self)'), /reputation\(\) expects a string literal faction id/);
  expectError(sys('reputation("police", "mob") > 0'), /reputation\(\) takes 1 argument, got 2/);
  expectError(sys('attitude(self, tile) > 0'), /attitude\(a, b\) expects an entity, got tile/);
  expectError(sys('hostile(self)'), /hostile\(\) takes 2 arguments, got 1/);
  expectError(sys('friendly(1, player)'), /friendly\(a, b\) expects an entity, got number/);
  // Every form compiles in a valid pack.
  const ok = loadPacks([
    fixture({
      ...FILES,
      's.yaml': `systems:\n  - { id: s, when: 'self.in_faction("police") and in_faction(player, "t:police") and reputation("mob") < 0 and attitude(self, player) >= 0 and not hostile(player, self) and not friendly(self, player)', effects: [{ type: apply, measurement: hp, delta: 1 }] }\n`,
    }),
  ]);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.map(formatError).join('\n'));
});

test('effects: reputation loads in every effect list; its load errors', () => {
  const d = def();
  assert.deepEqual(d.actions[0]!.effects, [{ type: 'reputation', faction: 0, constant: -15, fn: null, witnessed: 8, spread: true }]);
  assert.deepEqual(d.actions[3]!.effects[0], { type: 'reputation', faction: 0, constant: 500, fn: null, witnessed: null, spread: true });
  const eff = (e: string) => `{ type: reputation, faction: police, delta: 1${e} }`;
  const everywhere = loadPacks([
    fixture({
      ...FILES,
      'e.yaml': `items:
  - { id: badge, label: Badge, glyph: b, color: white, weight: 1, use: { effects: [${eff('')}] } }
recipes:
  - { id: r, label: R, consume: { badge: 1 }, produce: { badge: 1 }, effects: [${eff('')}] }
systems:
  - { id: s, effects: [${eff(', witnessed: 2')}] }
quests:
  - { id: q, title: Q, stages: [{ id: a, when: "true", journal: A, effects: [${eff(', spread: true')}] }] }
`,
    }),
  ]);
  assert.ok(everywhere.ok, everywhere.ok ? '' : everywhere.errors.map(formatError).join('\n'));
  const e = (effect: string) => errorsOf({ 's.yaml': `systems:\n  - { id: s, effects: [${effect}] }\n` });
  expectError(e('{ type: reputation, faction: polise, delta: 1 }'), /unknown faction 'polise' \(did you mean 'police'\?\)/, 'systems[0].effects[0].faction');
  expectError(e('{ type: reputation, delta: 1 }'), /missing required field 'faction'/);
  expectError(e('{ type: reputation, faction: police }'), /missing required field 'delta'/);
  expectError(e('{ type: reputation, faction: police, delta: 1, witnessed: 0 }'), /'witnessed' must be a number of tiles > 0/, 'systems[0].effects[0].witnessed');
  expectError(e('{ type: reputation, faction: police, delta: 1, witnessed: near }'), /must be a number/);
  expectError(e('{ type: reputation, faction: police, delta: 1, spread: yes please }'), /must be a boolean/);
  expectError(e('{ type: reputation, faction: police, delta: 1, on: npc }'), /unknown 'reputation' effect field 'on'/);
  expectError(e('{ type: reputaton, faction: police, delta: 1 }'), /did you mean 'reputation'/);
});

// ── Attitude ────────────────────────────────────────────────────────────────

test('attitude: every row of the rules; the player’s own faction plays no part', () => {
  const w = world();
  const [p, officer, , sergeant, thug, clerk, acolyte] = w.entities;
  const t = w.factionTable;
  const att = (a: Entity, b: Entity) => attitude(t, p!, a, b);
  setRep(w, 'police', -30);
  setRep(w, 'mob', -60);
  assert.equal(att(officer!, officer!), 100, 'same entity');
  assert.equal(att(p!, p!), 100, 'the player regards itself at 100');
  assert.equal(att(clerk!, p!), 0, 'an NPC without a faction');
  assert.equal(att(clerk!, thug!), 0);
  assert.equal(att(officer!, p!), -30, 'NPC of F toward the player: reputation(F), although the player is in F');
  assert.equal(att(officer!, sergeant!), 100, 'same faction');
  assert.equal(att(officer!, thug!), -50, 'F.relations[G]');
  assert.equal(att(thug!, officer!), -80, 'relations need not be symmetric');
  assert.equal(att(officer!, acolyte!), 0, 'an unset relation');
  assert.equal(att(officer!, clerk!), 0, 'b without a faction');
  assert.equal(att(p!, thug!), -60, 'the player toward G: reputation(G)');
  assert.equal(att(p!, officer!), -30);
  assert.equal(att(p!, clerk!), 0, 'the player toward an NPC without a faction');
  // Through the compiled built-ins.
  assert.equal(evaluate(w, 'attitude(self, player)', officer), -30);
  assert.equal(evaluate(w, 'attitude(npc, self)', officer, thug), -80);
  assert.equal(evaluate(w, 'reputation("mob")'), -60);
  assert.equal(evaluate(w, 'self.in_faction("police")', officer), true);
  assert.equal(evaluate(w, 'player.in_faction("police") and in_faction(player, "police")'), true, "in_faction reads the player's archetype");
  assert.equal(evaluate(w, 'in_faction(npc, "police")', p, thug), false);
  assert.equal(evaluate(w, 'self.in_faction("police")', clerk), false);
});

test('hostile and friendly: thresholds of the regarding faction (a’s, or b’s when a is the player)', () => {
  const w = world();
  const [p, officer, , , thug, clerk, acolyte] = w.entities;
  const h = (self: Entity, npc: Entity, expr = 'hostile(self, npc)') => evaluate(w, expr, self, npc);
  assert.equal(h(officer!, thug!), false, 'police regards the mob at -50: not below -50');
  assert.equal(h(thug!, officer!), true, 'the mob regards police at -80');
  assert.equal(h(officer!, thug!, 'friendly(self, npc)'), false);
  assert.equal(h(officer!, officer!, 'friendly(self, npc)'), true, 'an NPC is friendly to itself');
  assert.equal(h(p!, thug!, 'hostile(npc, player)'), false, 'mob at -20');
  setRep(w, 'mob', -50);
  assert.equal(h(p!, thug!, 'hostile(npc, player)'), false, 'exactly hostile_below is not hostile');
  setRep(w, 'mob', -50.5);
  assert.equal(h(p!, thug!, 'hostile(npc, player)'), true);
  assert.equal(h(p!, thug!, 'hostile(player, npc)'), true, 'the player toward the thug uses the mob’s threshold');
  setRep(w, 'police', 50);
  assert.equal(h(p!, officer!, 'friendly(npc, player) and friendly(player, npc)'), true, 'exactly friendly_from is friendly');
  // The cult's own thresholds (-10 / 10).
  setRep(w, 'cult', -10);
  assert.equal(h(p!, acolyte!, 'hostile(npc, player)'), false);
  setRep(w, 'cult', -10.5);
  assert.equal(h(p!, acolyte!, 'hostile(npc, player)'), true);
  setRep(w, 'cult', 10);
  assert.equal(h(p!, acolyte!, 'friendly(npc, player)'), true);
  // No faction on either side: neither.
  assert.equal(h(p!, clerk!, 'hostile(npc, player) or friendly(npc, player) or hostile(player, npc) or friendly(player, npc)'), false);
  assert.equal(evaluate(w, 'hostile(player, player) or friendly(player, player)'), false, 'the player’s own faction plays no part');
  assert.deepEqual(w.attitudeOf(acolyte!), { faction: 't:cult', label: 'Cult', tier: 'Friend', hostile: false, friendly: true });
  assert.deepEqual(w.attitudeOf(thug!), { faction: 't:mob', label: 'Mob', tier: 'Hostile', hostile: true, friendly: false }, 'the mob at -50.5');
  assert.equal(w.attitudeOf(clerk!), null);
  assert.equal(w.attitudeOf(p!), null);
});

// ── Effects ─────────────────────────────────────────────────────────────────

test('reputation effect: clamped to [-100, 100] on every write; the same faction twice applies twice', () => {
  const w = world();
  act(w, 'bribe');
  // +500 clamps to 100, then -1 and -1: each write is clamped on its own.
  assert.equal(rep(w, 'police'), 98);
  assert.equal(rep(w, 'mob'), -100, '-20 + 500 × -80 / 100 clamps to -100');
  assert.equal(rep(w, 'town'), 100);
  assert.equal(rep(w, 'cult'), 0);
});

test('reputation effect: witnessed — in sight, out of range, behind an opaque edge, on another floor', () => {
  // In sight: the officer next to the player sees it.
  let w = world();
  clearPolice(w, [OFFICER]);
  act(w, 'pick');
  assert.equal(rep(w, 'police'), -15);
  // Range is euclidean: (1, 1) is √2 ≤ 1.5 away, (2, 0) is 2 > 1.5.
  w = world();
  clearPolice(w, [OFFICER]);
  place(w.entities[OFFICER]!, 2, 0);
  act(w, 'peek');
  assert.equal(rep(w, 'police'), 0, 'out of range');
  place(w.entities[OFFICER]!, 1, 1);
  act(w, 'peek');
  assert.equal(rep(w, 'police'), -1, 'diagonal neighbour in range');
  // Behind an opaque edge: the player at (4, 0), the only officer on the floor at (5, 0) behind the wall.
  w = world();
  clearPolice(w, [WALLED]);
  place(w.player, 4, 0);
  act(w, 'pick');
  assert.equal(rep(w, 'police'), 0, 'behind the wall');
  place(w.player, 4, 1);
  act(w, 'pick');
  assert.equal(rep(w, 'police'), -15, 'around the wall');
  // On another floor: right above the player.
  w = world();
  clearPolice(w);
  place(w.entities[OFFICER]!, 0, 0, 1);
  act(w, 'pick');
  assert.equal(rep(w, 'police'), 0, 'upstairs');
  assert.equal(rep(w, 'mob'), -20, 'nothing spreads when the change does not apply');
});

test('reputation effect: witnessed never counts self or the player; a faction without members never sees', () => {
  // A system run by the officer: the only other police member on its floor is the player (in police by archetype).
  const w = world({
    's.yaml': `systems:
  - { id: s, for: 'self.in_faction("police") and self.z == 0 and self.x > 0', effects: [{ type: reputation, faction: police, delta: -1, witnessed: 5 }] }
  - { id: c, for: 'self.in_faction("police")', effects: [{ type: reputation, faction: town, delta: -1, witnessed: 5 }] }
`,
  });
  clearPolice(w, [OFFICER]);
  w.step();
  assert.equal(rep(w, 'police'), 0, 'the officer alone (with the player) witnesses nothing');
  assert.equal(rep(w, 'town'), 0, 'the town has no members');
  // Two officers on the floor see each other.
  place(w.entities[WALLED]!, 2, 0, 0);
  w.step();
  assert.equal(rep(w, 'police'), -2);
});

test('reputation effect: spread arithmetic (rounded to 2 decimals), one step, no chaining', () => {
  const w = world();
  act(w, 'help');
  assert.equal(rep(w, 'police'), 10, 'no echo back from the mob (-8 × -50 / 100 would be +4)');
  assert.equal(rep(w, 'mob'), -28, 'helping the police (+10) with the mob regarding them at -80 changes the mob by -8');
  assert.equal(rep(w, 'town'), 3.33, '10 × 33.3 / 100');
  assert.equal(rep(w, 'cult'), 0, 'no relation');
});

test('reputation effect: in a system it runs once per matching entity', () => {
  const w = world({ 's.yaml': `systems:\n  - { id: s, for: 'self.in_faction("police")', effects: [{ type: reputation, faction: police, delta: -1 }] }\n` });
  w.step();
  assert.equal(rep(w, 'police'), -4, 'three officers and the player (police by archetype)');
  w.step();
  assert.equal(rep(w, 'police'), -8);
});

// ── Integration ─────────────────────────────────────────────────────────────

test('behavior: the thug switches to pursue on hostile(self, player) and can_see(self, player, 8)', () => {
  const w = world();
  const thug = w.entities[THUG]!;
  const state = () => w.snapshot().entities[THUG]!.behavior!.state;
  for (let i = 0; i < 5; i++) w.step();
  assert.equal(state(), 'wait');
  assert.deepEqual([thug.x, thug.y], [6, 1]);
  setRep(w, 'mob', -60);
  w.step();
  assert.equal(state(), 'chase');
  for (let i = 0; i < 6; i++) w.step();
  assert.ok(Math.max(Math.abs(thug.x - w.player.x), Math.abs(thug.y - w.player.y)) <= 2, `the thug closes in: (${thug.x}, ${thug.y})`);
});

test('dialogue: a choice gated by reputation; the NPC being talked to counts as a member who sees', () => {
  const w = world();
  clearPolice(w, [SERGEANT]);
  w.queueAction({ kind: 'talk', entity: SERGEANT });
  w.step();
  const choices = () => w.conversationView()!.choices;
  assert.deepEqual(choices()[0], { text: 'Any work?', ok: false, reason: 'cannot_act', unavailable: 'Only for friends' });
  assert.equal(w.choose(2).ok, true, 'Bribe');
  assert.equal(rep(w, 'police'), 20);
  assert.deepEqual(choices()[0], { text: 'Any work?', ok: true });
  assert.equal(w.choose(1).ok, true, 'Insult, witnessed by the sergeant');
  assert.equal(rep(w, 'police'), 15);
});

test('events: a tier change of a shown faction adds a journal event; a change within a tier only bumps journalVersion', () => {
  const w = world();
  clearPolice(w, [OFFICER]);
  const v0 = w.journalVersion;
  act(w, 'pick');
  assert.deepEqual(w.journalEvents, [
    { tick: 0, kind: 'reputation', faction: 't:police', from: 'Neutral', to: 'Wary' },
    { tick: 0, kind: 'reputation', faction: 't:mob', from: 'Wary', to: 'Neutral' },
  ]);
  assert.ok(w.journalVersion > v0);
  // -15 × 33.3 / 100 moved the hidden town (no event) too.
  assert.equal(rep(w, 'town'), -5);
  assert.deepEqual(w.journal().standing, [
    { faction: 't:police', label: 'Police', value: -15, tier: 'Wary' },
    { faction: 't:mob', label: 'Mob', value: -8, tier: 'Neutral' },
    { faction: 't:cult', label: 'Cult', value: 0, tier: 'Friend' },
  ]);
  const v1 = w.journalVersion;
  act(w, 'peek');
  assert.equal(rep(w, 'police'), -16);
  assert.deepEqual(w.journalEvents, []);
  assert.equal(w.journalVersion, v1 + 1);
  // journal() is pure.
  const h = w.hash();
  w.journal();
  w.attitudeOf(w.entities[OFFICER]!);
  assert.equal(w.hash(), h);
});

// ── Saves ───────────────────────────────────────────────────────────────────

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test('save v6: reputation by qualified id; the round trip covers changed standings', () => {
  const w = world();
  clearPolice(w, [OFFICER]);
  act(w, 'pick');
  act(w, 'help');
  const s = w.save();
  assert.equal(s.version, 7);
  assert.deepEqual(s.state.reputation, { 't:police': -5, 't:mob': -16, 't:town': -1.67, 't:cult': 0 });
  const copy = assertRoundTrip(w, (x) => x.tick === 3 && x.queueAction({ kind: 'act', action: 't:pick' }), 10);
  assert.equal(rep(copy, 'police'), -20);
  assert.deepEqual(copy.journal().standing, w.journal().standing);
});

test('save v5: loads with every faction at its starting reputation', () => {
  const w = world();
  act(w, 'help');
  const save = json(w.save()) as unknown as Record<string, unknown> & { state: Record<string, unknown> };
  save['version'] = 5;
  delete save.state['reputation'];
  const r = World.restore(w.def, save);
  if (!r.ok) assert.fail(r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.world.snapshot().reputation, { 't:police': 0, 't:mob': -20, 't:town': 0, 't:cult': 0 });
  assert.equal(r.world.save().version, 7);
});

test('save v6: an unknown faction is a restore error with did-you-mean; a missing one warns; out of range is clamped', () => {
  const w = world();
  act(w, 'help');
  const base = json(w.save());
  const restoreWith = (edit: (s: SaveFile) => void) => {
    const s = json(base);
    edit(s);
    return World.restore(w.def, s);
  };
  const bad = restoreWith((s) => (s.state.reputation = { ...s.state.reputation, 't:polise': 1 }));
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors.includes(`state.reputation["t:polise"]: unknown faction 't:polise' (did you mean 't:police'?)`), JSON.stringify(bad));
  const nan = restoreWith((s) => (s.state.reputation['t:mob'] = 'x' as unknown as number));
  assert.ok(!nan.ok && nan.errors.some((e) => e.startsWith('state.reputation["t:mob"]: expected a finite number')));
  const gone = restoreWith((s) => delete (s.state as Partial<SaveFile['state']>).reputation);
  assert.ok(!gone.ok && gone.errors.some((e) => e.startsWith('state.reputation: expected an object')));
  const missing = restoreWith((s) => {
    delete s.state.reputation['t:mob'];
    s.state.reputation['t:police'] = 140;
  });
  if (!missing.ok) assert.fail(missing.errors.join('\n'));
  assert.deepEqual(missing.warnings, [`state.reputation["t:police"]: 140 is outside [-100, 100]; clamped`, `state.reputation: faction 't:mob' is missing; it starts at -20`]);
  assert.equal(rep(missing.world, 'mob'), -20);
  assert.equal(rep(missing.world, 'police'), 100);
});

// ── Overrides ───────────────────────────────────────────────────────────────

const MOD_MANIFEST = 'namespace: mod\nname: Mod\nversion: 1.0.0\nkind: mod\ndepends: [t]\n';

test('overrides: factions take override (relations and tiers replaced whole) and remove; archetype faction is patchable', () => {
  const r = loadPacks([
    fixture(FILES),
    {
      label: 'mod',
      files: {
        'pack.yaml': MOD_MANIFEST,
        'm.yaml': `factions:
  - { id: t:police, override: true, relations: { cult: 20 }, tiers: [{ from: -100, label: Foe }, { from: 0, label: Pal }] }
  - { id: t:town, remove: true }
archetypes:
  - { id: t:clerk, override: true, faction: t:mob }
`,
      },
    },
  ]);
  if (!r.ok) assert.fail(r.errors.map(formatError).join('\n'));
  const d = r.definition;
  assert.deepEqual(
    d.factions.map((f) => f.id),
    ['t:police', 't:mob', 't:cult'],
  );
  assert.deepEqual(d.factions[0]!.relations, [0, 0, 20], 'relations replaced whole: no more mob entry');
  assert.deepEqual(d.factions[0]!.tiers.map((t) => t.label), ['Foe', 'Pal']);
  assert.equal(d.archetypes[4]!.faction, 1, 'the clerk enlisted in the mob');
  assert.deepEqual(
    formatOverrides(d)
      .slice(-3)
      .map((l) => l.trim().split(/\s+/).join(' ')),
    ['mod override archetype t:clerk [faction]', 'mod override faction t:police [relations, tiers]', 'mod remove faction t:town'],
  );
});

test('overrides: removing a faction still named by an archetype, a relation, an expression or an effect names the remover', () => {
  const errors = errorsOf(
    { 's.yaml': `systems:\n  - { id: s, when: 'reputation("mob") > 0', effects: [{ type: reputation, faction: mob, delta: 1 }] }\n` },
    [{ label: 'mod', files: { 'pack.yaml': MOD_MANIFEST, 'm.yaml': 'factions:\n  - { id: t:mob, remove: true }\n' } }],
  );
  const gone = /unknown faction 't:mob' \(removed by pack 'mod'\)/;
  expectError(errors, gone, 'archetypes[3].faction');
  expectError(errors, gone, 'factions[0].relations.mob');
  expectError(errors, gone, 'systems[0].when');
  expectError(errors, gone, 'systems[0].effects[0].faction');
});

// ── UI models ───────────────────────────────────────────────────────────────

test('journal panel: the Standing section with label, tier and a bar position; hidden factions left out', () => {
  const w = world();
  assert.equal(hasJournal(w), true, 'factions alone give a journal');
  const empty = journalView(w);
  assert.equal(empty.empty, null);
  assert.equal(empty.standingTitle, 'Standing');
  clearPolice(w, [OFFICER]);
  act(w, 'pick');
  assert.deepEqual(journalView(w).standing, [
    { faction: 't:police', label: 'Police', tier: 'Wary', value: -15, fraction: 0.425, text: 'Police: Wary (-15)' },
    { faction: 't:mob', label: 'Mob', tier: 'Neutral', value: -8, fraction: 0.46, text: 'Mob: Neutral (-8)' },
    { faction: 't:cult', label: 'Cult', tier: 'Friend', value: 0, fraction: 0.5, text: 'Cult: Friend (0)' },
  ]);
  assert.deepEqual(journalLines(w.journal()), ['Journal', '', 'Standing', '  Police: Wary (-15)', '  Mob: Neutral (-8)', '  Cult: Friend (0)']);
  setRep(w, 'mob', -0.4);
  assert.equal(standingRows(w.journal())[1]!.text, 'Mob: Neutral (0)', 'never -0');
  const hidden = world({ 'factions.yaml': FACTIONS.replace(/label: (Police|Mob|Cult)/g, 'label: $1\n    hidden: true') });
  assert.equal(hasJournal(hidden), false);
  assert.deepEqual(hidden.journal().standing, []);
});

test('toasts: <Label>: <from> → <to>, the last event with (+N); the terminal message line', () => {
  const w = world();
  clearPolice(w, [OFFICER]);
  act(w, 'pick');
  assert.equal(journalToast(w.journalEvents, w), 'Mob: Wary → Neutral (+1)');
  assert.equal(journalToast(w.journalEvents.slice(0, 1), w), 'Police: Neutral → Wary');
  assert.equal(journalMessage(w), 'Mob: Wary → Neutral (+1)');
  const keys: KeyState = { dropPending: false };
  handleKey(w, 'J', keys);
  assert.deepEqual(keys.journal!.slice(-4), ['Standing', '  Police: Wary (-15)', '  Mob: Neutral (-8)', '  Cult: Friend (0)']);
});

test('tooltip: an NPC with a faction shows its tier; a hostile one is flagged for the danger colour', () => {
  const w = world();
  const at = (id: number) => {
    const e = w.entities[id]!;
    return hoverInfo(w, { kind: 'entity', x: e.x, y: e.y, z: e.z, entity: e });
  };
  setRep(w, 'police', -22);
  const officer = at(OFFICER);
  assert.equal(officer.title, 'Officer');
  assert.deepEqual([officer.standing, officer.hostile], ['Police (Wary)', false]);
  assert.equal(hoverTitleLine(officer), 'Officer · Police (Wary)');
  const sergeant = at(SERGEANT);
  assert.equal(sergeant.hint, 'Click: Talk to Sergeant');
  assert.equal(hoverTitleLine(sergeant), 'Sergeant · Police (Wary)');
  setRep(w, 'mob', -80);
  assert.deepEqual([at(THUG).standing, at(THUG).hostile], ['Mob (Hostile)', true]);
  const clerk = at(CLERK);
  assert.equal('standing' in clerk, false, 'no faction, no standing');
  assert.equal(hoverTitleLine(clerk), 'Clerk');
  assert.equal('standing' in at(PLAYER), false);
  assert.equal(hoverTitleLine(at(ACOLYTE)), 'Acolyte · Cult (Friend)');
});

// ── Guards ──────────────────────────────────────────────────────────────────

test('determinism: same seed and inputs, same hashes; standings are hashed', () => {
  const run = () => {
    const w = world({ 's.yaml': `systems:\n  - { id: s, every: 0.5, for: 'self.in_faction("mob")', effects: [{ type: reputation, faction: mob, delta: "random(-3, 3)", witnessed: 6, spread: true }] }\n` });
    const hashes: string[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 5) w.queueAction({ kind: 'act', action: 't:pick' });
      w.step();
      hashes.push(w.hash());
    }
    return { hashes, snap: w.snapshot().reputation };
  };
  const a = run();
  assert.deepEqual(run(), a);
  const w = world();
  const h = w.hash();
  setRep(w, 'cult', 1);
  assert.notEqual(w.hash(), h);
});
