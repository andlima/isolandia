import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleKey, type KeyState } from '../src/ascii/terminal.ts';
import { loadMessage, readSaveFile, writeSaveFile } from '../src/cli/saves.ts';
import { loadPacksOrThrow, World, type Definition, type SaveMeta } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { suppressesDefault } from '../src/web/keys.ts';
import { FixedTickLoop } from '../src/web/loop.ts';
import { exportFile, exportFileName, formatSavedAt, gameView, MemoryStore, restoreText, SaveSlots, slotKey, storageErrorMessage, type SlotId } from '../src/web/saves.ts';
import { GAMES } from './helpers.ts';

const PACKS = ['std', 'std-needs', 'zombie'];
const DEF: Definition = loadPacksOrThrow(GAMES.zombie.map((d) => readPack(d)));

function played(ticks = 50): World {
  const w = World.create(DEF, 4);
  for (let i = 0; i < ticks; i++) w.step();
  return w;
}

const NOW = new Date('2026-10-04T12:34:00.000Z');
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── Game panel view ─────────────────────────────────────────────────────────

test('game panel: the quicksave and three slots; Load and Delete disabled when empty', () => {
  const meta: SaveMeta = { savedAt: NOW.toISOString(), day: 2, time: '14:05', tick: 21900, packs: ['std'] };
  const metas: Record<SlotId, SaveMeta | null> = { quick: null, slot1: meta, slot2: null, slot3: null };
  const v = gameView(metas, 'Saved to Slot 1.');
  assert.deepEqual(
    v.rows.map((r) => [r.slot, r.title]),
    [
      ['quick', 'Quicksave'],
      ['slot1', 'Slot 1'],
      ['slot2', 'Slot 2'],
      ['slot3', 'Slot 3'],
    ],
  );
  assert.equal(v.rows[0]!.text, 'empty');
  assert.equal(v.rows[1]!.text, `Day 2, 14:05 · tick 21900 · saved ${formatSavedAt(meta.savedAt)}`);
  assert.match(formatSavedAt(meta.savedAt), /^2026-10-0[45] \d\d:\d\d$/);
  assert.equal(formatSavedAt('nonsense'), 'nonsense');
  const buttons = (k: number) => v.rows[k]!.buttons.map((b) => `${b.label}${b.disabled ? '-' : '+'}`);
  assert.deepEqual(buttons(0), ['Save+', 'Load-', 'Delete-']);
  assert.deepEqual(buttons(1), ['Save+', 'Load+', 'Delete+']);
  assert.deepEqual([v.message, v.errors], ['Saved to Slot 1.', []]);
  assert.deepEqual(gameView(metas, 'Cannot load Slot 1.', ['state.tick: bad']).errors, ['state.tick: bad']);
});

// ── Slots over a SaveStore ──────────────────────────────────────────────────

test('slots: per-pack-list keys; save, metadata, load, delete', () => {
  assert.equal(slotKey(PACKS, 'slot1'), 'isolandia:save:std,std-needs,zombie:slot1');
  const store = new MemoryStore();
  const slots = new SaveSlots(store, PACKS);
  assert.deepEqual(slots.metas(), { quick: null, slot1: null, slot2: null, slot3: null });
  const w = played(600);
  assert.deepEqual(slots.save('quick', w, NOW), { ok: true, message: 'Saved to Quicksave.' });
  assert.deepEqual(store.list(), ['isolandia:save:std,std-needs,zombie:quick']);
  const stored = JSON.parse(store.read('isolandia:save:std,std-needs,zombie:quick')!);
  assert.deepEqual(Object.keys(stored).sort(), ['meta', 'save'], 'wrapper: { meta, save }');
  assert.deepEqual(stored.meta, { savedAt: NOW.toISOString(), day: 1, time: '09:00', tick: 600, packs: ['std', 'std_needs', 'zmb'] });
  // A fresh SaveSlots reads the metadata back from the store.
  assert.deepEqual(new SaveSlots(store, PACKS).meta('quick'), stored.meta);
  assert.equal(new SaveSlots(store, ['std', 'vampire']).meta('quick'), null, 'another game has its own slots');

  const r = slots.load('quick', DEF);
  assert.ok(r.ok);
  assert.equal(r.message, 'Loaded Quicksave.');
  assert.deepEqual(r.world.snapshot(), json(w.snapshot()));

  assert.deepEqual(slots.remove('quick'), { ok: true, message: 'Deleted Quicksave.' });
  assert.equal(slots.meta('quick'), null);
  assert.deepEqual(store.list(), []);
  const empty = slots.load('quick', DEF);
  assert.ok(!empty.ok);
  assert.equal(empty.message, 'Quicksave is empty.');
});

test('slots: quota and blocked storage become messages, never exceptions', () => {
  const full = new MemoryStore(1000);
  const slots = new SaveSlots(full, PACKS);
  const r = slots.save('slot2', played(), NOW);
  assert.deepEqual(r, { ok: false, message: 'Not enough browser storage to save. Delete a slot or export to a file.' });
  assert.equal(slots.meta('slot2'), null);

  const blocked = new MemoryStore();
  blocked.blocked = true;
  const b = new SaveSlots(blocked, PACKS);
  assert.equal(b.meta('slot1'), null);
  assert.match(b.save('slot1', played(), NOW).message, /^Browser storage is unavailable \(The operation is insecure\.\)/);
  const l = b.load('slot1', DEF);
  assert.ok(!l.ok);
  assert.match(l.message, /^Browser storage is unavailable/);
  assert.ok(!b.remove('slot1').ok);
  assert.equal(storageErrorMessage(Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })), 'Not enough browser storage to save. Delete a slot or export to a file.');
});

test('slots: a corrupt or mismatched slot lists the restore errors', () => {
  const store = new MemoryStore();
  const slots = new SaveSlots(store, PACKS);
  const bad = json(played().save());
  bad.state.tick = -5;
  store.write(slotKey(PACKS, 'slot3'), JSON.stringify(bad));
  const r = slots.load('slot3', DEF);
  assert.ok(!r.ok);
  assert.equal(r.message, 'Cannot load Slot 3.');
  assert.deepEqual(r.errors, ['state.tick: -5 must be ≥ 0']);
  store.write(slotKey(PACKS, 'slot3'), '{"meta":');
  const t = slots.load('slot3', DEF);
  assert.ok(!t.ok && /^not a save file/.test(t.errors[0]!));
});

// ── Export / import ─────────────────────────────────────────────────────────

test('export: file name and wrapper; import accepts the wrapper and a bare SaveFile', () => {
  assert.equal(exportFileName(PACKS, 3), 'isolandia-std-std-needs-zombie-day3.json');
  const w = played();
  const f = exportFile(w, PACKS, NOW);
  assert.equal(f.name, 'isolandia-std-std-needs-zombie-day1.json');
  assert.deepEqual(JSON.parse(f.text), json(f.wrapper));
  for (const text of [f.text, JSON.stringify(w.save())]) {
    const r = restoreText(DEF, text);
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.equal(r.world.hash(), w.hash());
  }
  const r = restoreText(DEF, 'not json');
  assert.ok(!r.ok && /^not a save file/.test(r.errors[0]!));
  const other = restoreText(DEF, JSON.stringify({ meta: {}, save: { format: 'nope' } }));
  assert.ok(!other.ok && other.errors.some((e) => e.startsWith('format:')));
});

// ── Browser keys and loop ───────────────────────────────────────────────────

test('browser: F5 and F9 never reach the browser (no reload); the loop accumulator resets', () => {
  for (const k of ['F5', 'F9', 'Space', 'Tab']) assert.ok(suppressesDefault(k), k);
  assert.ok(!suppressesDefault('KeyO'));
  const loop = new FixedTickLoop(() => {}, { ticksPerSecond: 10 });
  loop.advance(150);
  assert.ok(loop.alpha > 0.4);
  loop.reset();
  assert.equal(loop.alpha, 0);
});

// ── Terminal ────────────────────────────────────────────────────────────────

test('terminal: S and L return save/load before the movement fallback; s and l still move', () => {
  const w = World.create(DEF, 1);
  const keys: KeyState = { dropPending: false, actions: null, crafting: null };
  assert.equal(handleKey(w, 'S', keys), 'save');
  assert.equal(handleKey(w, 'L', keys), 'load');
  assert.equal(w.player.intent, null, 'Shift+s / Shift+l no longer move');
  handleKey(w, 's', keys);
  assert.deepEqual(w.player.intent, { kind: 'step', dx: 0, dy: 1 });
  handleKey(w, 'l', keys);
  assert.deepEqual(w.player.intent, { kind: 'step', dx: 1, dy: 0 });
  // S/L close a pending prompt or list first.
  keys.dropPending = true;
  assert.equal(handleKey(w, 'S', keys), 'save');
  assert.equal(keys.dropPending, false);
  handleKey(w, 'x', keys);
  assert.ok(keys.actions);
  assert.equal(handleKey(w, 'L', keys), 'load');
  assert.equal(keys.actions, null);
});

test('cli: save file in the wrapper format, read back (wrapper or bare), load messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolandia-save-'));
  const path = join(dir, 'game.json');
  const w = played();
  assert.equal(writeSaveFile(w, path, NOW), null);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(file.meta.savedAt, NOW.toISOString());
  const r = readSaveFile(DEF, path);
  assert.ok(r.ok);
  assert.equal(r.world.hash(), w.hash());
  assert.equal(loadMessage(path, r), `Loaded ${path}.`);
  writeFileSync(path, JSON.stringify(w.save()));
  assert.ok(readSaveFile(DEF, path).ok, 'a bare SaveFile');

  const bad = json(w.save());
  bad.state.tick = -1;
  bad.state.rng = -1;
  bad.state.player = 'x' as unknown as number;
  writeFileSync(path, JSON.stringify(bad));
  const e = readSaveFile(DEF, path);
  assert.ok(!e.ok);
  assert.equal(loadMessage(path, e), 'state.tick: -1 must be ≥ 0 (+2 more)');
  assert.match(loadMessage(path, readSaveFile(DEF, join(dir, 'missing.json'))), /^cannot read .*missing\.json/);
  assert.match(writeSaveFile(w, join(dir, 'no', 'such', 'dir.json')) ?? '', /^cannot write /);
});
