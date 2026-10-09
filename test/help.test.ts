import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadPacksOrThrow, Pace, World, type Definition } from '../src/core/index.ts';
import { helpLines, TERMINAL_BINDINGS } from '../src/ascii/bindings.ts';
import { handleKey, helpLine, type KeyState } from '../src/ascii/terminal.ts';
import { BINDINGS, bindingFor, keyBindings, SECTIONS } from '../src/web/bindings.ts';
import { escapeTarget, HELP_SEEN_KEY, helpView, hintText, pauseMenuView, readHelpSeen, trackWindows, WINDOW_IDS, writeHelpSeen, type HelpRow, type HelpView, type WindowId } from '../src/web/help.ts';
import { INPUT_BINDINGS } from '../src/web/input.ts';
import { PAUSE_KEYS, speedKey } from '../src/web/keys.ts';
import { MemoryStore } from '../src/web/saves.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES } from './helpers.ts';

// ── Bindings table ──────────────────────────────────────────────────────────

test('bindings: unique ids, sections in order, lookup by key then by code, time rows agree with keys.ts', () => {
  const ids = BINDINGS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const order = BINDINGS.map((b) => SECTIONS.indexOf(b.section));
  assert.ok(order.every((n) => n >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'rows are grouped by section, in SECTIONS order');
  assert.equal(bindingFor('Slash', '?'), 'help');
  assert.equal(bindingFor('Comma', '<'), 'climb_up');
  assert.equal(bindingFor('PageUp', 'PageUp'), 'climb_up');
  assert.equal(bindingFor('Period', '>'), 'climb_down');
  assert.equal(bindingFor('KeyW', 'w'), 'move');
  assert.equal(bindingFor('Numpad7', '7'), 'move');
  assert.equal(bindingFor('KeyI', 'i'), 'inventory');
  assert.equal(bindingFor('Tab', 'Tab'), 'inventory');
  assert.equal(bindingFor('Escape', 'Escape'), 'escape');
  assert.equal(bindingFor('Equal', '+'), 'faster');
  assert.equal(bindingFor('NumpadSubtract', '-'), 'slower');
  assert.equal(bindingFor('KeyE', 'e'), 'menu');
  assert.equal(bindingFor('KeyZ', 'z'), null);
  const by = (id: string) => BINDINGS.find((b) => b.id === id)!;
  assert.deepEqual(new Set(by('pause').codes), PAUSE_KEYS);
  for (const c of by('faster').codes!) assert.equal(speedKey(c), 1);
  for (const c of by('slower').codes!) assert.equal(speedKey(c), -1);
  assert.deepEqual(by('inventory').keys, ['I', 'Tab']);
  assert.deepEqual(by('menu').gesture, { mouse: 'Right-click', touch: 'Long-press' });
});

test('bindings: every key binding has a handler (a switch case in main.ts, or Input itself)', () => {
  const main = readFileSync('src/web/main.ts', 'utf8');
  const cases = new Set([...main.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));
  const missing = keyBindings()
    .map((b) => b.id)
    .filter((id) => !cases.has(id) && !INPUT_BINDINGS.has(id));
  assert.deepEqual(missing, [], 'bindings without a handler');
  for (const id of INPUT_BINDINGS) assert.ok(keyBindings().some((b) => b.id === id), `${id} is a key binding`);
  // The check is not vacuous.
  assert.ok(cases.has('inventory') && cases.has('help') && cases.has('escape'));
});

test('docs: the Keys table in docs/ui.md lists every key in BINDINGS; the README quick start mentions ?', () => {
  const doc = readFileSync('docs/ui.md', 'utf8');
  const at = doc.indexOf('\n## Keys');
  assert.ok(at >= 0);
  const table = doc
    .slice(at)
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .join('\n')
    .replace(/`/g, '');
  const missing: string[] = [];
  for (const b of BINDINGS) for (const k of b.keys) if (!table.includes(k)) missing.push(`${b.id}: ${k}`);
  assert.deepEqual(missing, [], 'keys missing from the docs table');
  assert.match(readFileSync('README.md', 'utf8').slice(0, 3000), /`\?`/);
});

// ── Controls overlay ────────────────────────────────────────────────────────

const rowOf = (v: HelpView, id: string): HelpRow | undefined => v.sections.flatMap((s) => [...s.rows, ...s.groups.flatMap((g) => g.rows)]).find((r) => r.id === id);

test('helpView: sections in order, key chips, the gesture for the input, context groups', () => {
  const mouse = helpView(BINDINGS, 'mouse');
  assert.equal(mouse.title, 'Controls');
  assert.deepEqual(
    mouse.sections.map((s) => s.title),
    ['Moving', 'Interacting', 'Windows', 'Time', 'Game', 'View'],
  );
  assert.deepEqual(rowOf(mouse, 'inventory'), { id: 'inventory', keys: ['I', 'Tab'], gesture: null, label: 'Inventory / transfer window' });
  assert.equal(rowOf(mouse, 'menu')!.gesture, 'Right-click');
  assert.equal(rowOf(mouse, 'interact')!.gesture, 'Click');
  assert.equal(rowOf(mouse, 'walk')!.gesture, 'Shift + click');
  const touch = helpView(BINDINGS, 'touch');
  assert.equal(touch.input, 'touch');
  assert.equal(rowOf(touch, 'menu')!.gesture, 'Long-press');
  assert.equal(rowOf(touch, 'interact')!.gesture, 'Tap');
  assert.equal(rowOf(touch, 'zoom')!.gesture, 'Pinch');
  assert.equal(rowOf(touch, 'walk'), undefined, 'a mouse-only gesture row is left out on touch');
  assert.deepEqual(rowOf(touch, 'move')!.keys, ['Arrows', 'WASD', 'numpad'], 'keys stay on touch');
  const interacting = mouse.sections[1]!;
  assert.deepEqual(
    interacting.groups.map((g) => g.title),
    ['In the action menu', 'In a conversation'],
  );
  assert.ok(interacting.groups[0]!.rows.some((r) => r.id === 'menu_choose'));
  assert.ok(!interacting.rows.some((r) => r.id.startsWith('menu_') || r.id.startsWith('dialogue_')), 'context rows are only in their group');
  assert.deepEqual(
    mouse.sections[2]!.groups.map((g) => g.title),
    ['In the transfer window'],
  );
  for (const b of keyBindings()) {
    assert.ok(rowOf(mouse, b.id), `${b.id} shown for mouse`);
    assert.ok(rowOf(touch, b.id), `${b.id} shown for touch`);
  }
  assert.notEqual(mouse.close, touch.close);
  // An empty section is dropped.
  assert.deepEqual(
    helpView(
      BINDINGS.filter((b) => b.section === 'Time'),
      'mouse',
    ).sections.map((s) => s.title),
    ['Time'],
  );
});

// ── Escape ──────────────────────────────────────────────────────────────────

test('escapeTarget: the overlay, the menu, the dialogue, the last-opened window, then the pause menu', () => {
  const none = { help: false, menu: false, dialogue: false, windows: [] as WindowId[] };
  assert.deepEqual(escapeTarget(none), { kind: 'pause' });
  assert.deepEqual(escapeTarget({ ...none, windows: ['journal', 'transfer'] }), { kind: 'window', window: 'transfer' });
  assert.deepEqual(escapeTarget({ ...none, windows: ['transfer', 'journal'] }), { kind: 'window', window: 'journal' });
  assert.deepEqual(escapeTarget({ ...none, windows: ['game'] }), { kind: 'window', window: 'game' });
  assert.deepEqual(escapeTarget({ ...none, dialogue: true, windows: ['journal'] }), { kind: 'dialogue' });
  assert.deepEqual(escapeTarget({ ...none, menu: true, dialogue: true, windows: ['log'] }), { kind: 'menu' });
  assert.deepEqual(escapeTarget({ ...none, menu: true }), { kind: 'menu' });
  assert.deepEqual(escapeTarget({ help: true, menu: true, dialogue: true, windows: ['transfer', 'crafting'] }), { kind: 'help' });
  assert.deepEqual(escapeTarget({ ...none, help: true }), { kind: 'help' });
});

test('trackWindows: opening order kept, closed windows drop out, re-opened ones go last', () => {
  const open = (...ws: WindowId[]) => Object.fromEntries(WINDOW_IDS.map((w) => [w, ws.includes(w)])) as Record<WindowId, boolean>;
  let order = trackWindows([], open('journal'));
  assert.deepEqual(order, ['journal']);
  order = trackWindows(order, open('journal', 'transfer'));
  assert.deepEqual(order, ['journal', 'transfer']);
  order = trackWindows(order, open('journal', 'transfer', 'crafting'));
  assert.deepEqual(order, ['journal', 'transfer', 'crafting']);
  order = trackWindows(order, open('journal', 'crafting'));
  assert.deepEqual(order, ['journal', 'crafting']);
  order = trackWindows(order, open('journal', 'crafting', 'transfer'));
  assert.deepEqual(order, ['journal', 'crafting', 'transfer'], 'the transfer window re-opened last');
  assert.deepEqual(trackWindows(order, open()), []);
});

// ── Pause sources ───────────────────────────────────────────────────────────

test('pace: the modal pause (overlay, pause menu) pauses and never overrides a manual or window pause', () => {
  const p = new Pace();
  p.modal(true);
  assert.equal(p.paused, true);
  assert.equal(p.modalPause, true);
  assert.equal(p.manualPause, false);
  p.modal(false);
  assert.equal(p.paused, false);
  p.togglePause();
  p.modal(true);
  p.modal(false);
  assert.equal(p.paused, true, 'closing the overlay keeps the manual pause');
  assert.equal(p.manualPause, true);
  const q = new Pace();
  q.windows(true, true);
  q.modal(true);
  q.modal(false);
  assert.equal(q.paused, true, 'the window pause stays');
  q.windows(false, true);
  assert.equal(q.paused, false);
});

test('pauseMenuView: Resume, Controls, Game…, Title screen; Menu and Back once the game has ended', () => {
  const v = pauseMenuView(false);
  assert.equal(v.title, 'Paused');
  assert.deepEqual(
    v.items.map((i) => i.id),
    ['resume', 'controls', 'game', 'title'],
  );
  assert.deepEqual(
    v.items.map((i) => i.label),
    ['Resume', 'Controls', 'Game…', 'Title screen'],
  );
  assert.ok(v.items[3]!.hint);
  const e = pauseMenuView(true);
  assert.equal(e.title, 'Menu');
  assert.equal(e.items[0]!.label, 'Back');
});

// ── First-run hint ──────────────────────────────────────────────────────────

test('first-run flag: unset then set in a working store; a throwing store reads unset and ignores writes', () => {
  const store = new MemoryStore();
  assert.equal(readHelpSeen(store), false);
  writeHelpSeen(store);
  assert.equal(store.read(HELP_SEEN_KEY), '1');
  assert.equal(readHelpSeen(store), true);
  const blocked = new MemoryStore();
  blocked.blocked = true;
  assert.equal(readHelpSeen(blocked), false);
  assert.doesNotThrow(() => writeHelpSeen(blocked));
  assert.equal(readHelpSeen(blocked), false, 'the hint shows again');
  assert.equal(hintText('mouse'), 'Press ? for controls');
  assert.equal(hintText('touch'), 'Tap ? for controls');
});

// ── Terminal ────────────────────────────────────────────────────────────────

const DEF: Definition = loadPacksOrThrow(GAMES.town.map((d) => readPack(d)));

test('terminal: ? shows the controls until any key; the screen is grouped by section', () => {
  const w = World.create(DEF, 1);
  const keys: KeyState = { dropPending: false, actions: null, crafting: null, pace: new Pace() };
  assert.equal(handleKey(w, '?', keys), undefined);
  assert.equal(keys.help, true);
  handleKey(w, 'w', keys);
  assert.equal(keys.help, false, 'any key closes');
  assert.equal(w.player.intent, null, 'the closing key does nothing else');
  handleKey(w, 'x', keys);
  handleKey(w, '?', keys);
  assert.equal(keys.actions, null, '? closes the action list');
  assert.equal(keys.help, true);
  const lines = helpLines();
  assert.equal(lines[0], 'Controls');
  for (const s of ['Moving', 'Interacting', 'Windows', 'Time', 'Game']) assert.ok(lines.includes(s), s);
  assert.ok(lines.some((l) => /^ {2}\? +This help/.test(l)));
  assert.ok(lines.some((l) => /^ {2}p +Pause or resume/.test(l)));
  assert.ok(lines.includes('  In a conversation'));
  for (const b of TERMINAL_BINDINGS) assert.ok(lines.some((l) => l.includes(b.label)), b.id);
  assert.equal(TERMINAL_BINDINGS.find((b) => b.id === 'help')!.keys[0], '?');
});

test('terminal: the help line ends with ?: help and shrinks to q: quit  ?: help on a narrow terminal', () => {
  const full = helpLine(true, true, 200);
  assert.ok(full.endsWith('  ?: help'));
  assert.ok(full.includes('J: journal  M: log  p: pause  +/-: speed  S: save  L: load'));
  assert.equal(helpLine(true, true, 40), 'q: quit  ?: help');
  assert.equal(helpLine(true, true, full.length, '  |  PAUSED'), 'q: quit  ?: help', 'the pace and sim tags count too');
  assert.equal(helpLine(true, true, full.length + 11, '  |  PAUSED'), full);
  assert.ok(!helpLine(false, false, 200).includes('S: save'));
  assert.ok(helpLine(false, false, 200).endsWith('?: help'));
});
