/**
 * Browser saves: the quicksave and three slots in `localStorage` (behind the
 * small `SaveStore` interface), file export/import, and the Game panel's
 * view model. Everything here is DOM-free and testable; `game-panel.ts`
 * renders the view and `main.ts` swaps the running world.
 */

import { unwrapSave, World, wrapSave, type Definition, type RestoreResult, type SaveMeta, type SaveWrapper } from '../core/index.ts';

/** Key-value storage for saves; any call may throw (quota, private mode, blocked storage). */
export interface SaveStore {
  /** Every key in the store. */
  list(): string[];
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** `localStorage` (or any `Storage`) as a `SaveStore`. */
export function storageStore(storage: () => Storage): SaveStore {
  return {
    list: () => {
      const s = storage();
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) out.push(s.key(i)!);
      return out;
    },
    read: (key) => storage().getItem(key),
    write: (key, value) => storage().setItem(key, value),
    remove: (key) => storage().removeItem(key),
  };
}

/** The error a full store throws (named like the browser's). */
export class QuotaError extends Error {
  override readonly name = 'QuotaExceededError';
}

/** In-memory `SaveStore` for tests; `quota` caps the total stored characters. */
export class MemoryStore implements SaveStore {
  readonly data = new Map<string, string>();
  /** When true, every call throws (blocked storage). */
  blocked = false;

  constructor(public quota = Infinity) {}

  private check(): void {
    if (this.blocked) throw new Error('The operation is insecure.');
  }

  list(): string[] {
    this.check();
    return [...this.data.keys()];
  }

  read(key: string): string | null {
    this.check();
    return this.data.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.check();
    let used = value.length;
    for (const [k, v] of this.data) if (k !== key) used += v.length;
    if (used > this.quota) throw new QuotaError('quota exceeded');
    this.data.set(key, value);
  }

  remove(key: string): void {
    this.check();
    this.data.delete(key);
  }
}

export type SlotId = 'quick' | 'slot1' | 'slot2' | 'slot3';

export const SLOTS: readonly SlotId[] = ['quick', 'slot1', 'slot2', 'slot3'];

const SLOT_TITLES: Readonly<Record<SlotId, string>> = { quick: 'Quicksave', slot1: 'Slot 1', slot2: 'Slot 2', slot3: 'Slot 3' };

/** Storage key of a slot: one set of slots per pack list, e.g. `isolandia:save:std,std-needs,game:slot1`. */
export function slotKey(packs: readonly string[], slot: SlotId): string {
  return `isolandia:save:${packs.join(',')}:${slot}`;
}

/** Storage key of the Game panel's **Pause while windows are open** option (one for every pack list). */
export const AUTO_PAUSE_KEY = 'isolandia:pause-while-windows';

/** The auto-pause option (default off; storage errors read as off). */
export function readAutoPause(store: SaveStore): boolean {
  try {
    return store.read(AUTO_PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Store the auto-pause option; storage errors are ignored. */
export function writeAutoPause(store: SaveStore, on: boolean): void {
  try {
    store.write(AUTO_PAUSE_KEY, on ? '1' : '0');
  } catch {
    // As for saves, a storage failure never stops the game; the option just is not remembered.
  }
}

/** A short, player-facing text for a storage failure. */
export function storageErrorMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'Not enough browser storage to save. Delete a slot or export to a file.';
  return `Browser storage is unavailable (${e instanceof Error ? e.message : String(e)}).`;
}

/** Download name of an export: `isolandia-<packs>-day<N>.json`. */
export function exportFileName(packs: readonly string[], day: number): string {
  return `isolandia-${packs.join('-')}-day${day}.json`;
}

/** Parse an imported or stored file (a wrapper or a bare save) and restore it. */
export function restoreText(def: Definition, text: string): RestoreResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not a save file: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return World.restore(def, unwrapSave(json).save);
}

/** Outcome of a slot operation: a message, or a restored world (with warnings). */
export type SlotResult = { ok: true; message: string } | { ok: false; message: string };
export type LoadResult = { ok: true; world: World; warnings: string[]; message: string } | { ok: false; errors: string[]; message: string };

/**
 * The quicksave and slots of one pack list over a `SaveStore`. Every store
 * access is guarded: failures become messages, never exceptions. Slot
 * metadata is cached after the first read.
 */
export class SaveSlots {
  private readonly cache = new Map<SlotId, SaveMeta | null>();

  constructor(
    private readonly store: SaveStore,
    /** Pack directory names, in load order (as in `?packs=`). */
    readonly packs: readonly string[],
  ) {}

  /** Metadata of a slot, or null when empty or unreadable. */
  meta(slot: SlotId): SaveMeta | null {
    if (!this.cache.has(slot)) {
      let meta: SaveMeta | null = null;
      try {
        const text = this.store.read(slotKey(this.packs, slot));
        if (text !== null) meta = unwrapSave(JSON.parse(text)).meta;
      } catch {
        meta = null;
      }
      this.cache.set(slot, meta);
    }
    return this.cache.get(slot)!;
  }

  /** Metadata of every slot, for `gameView`. */
  metas(): Record<SlotId, SaveMeta | null> {
    return { quick: this.meta('quick'), slot1: this.meta('slot1'), slot2: this.meta('slot2'), slot3: this.meta('slot3') };
  }

  save(slot: SlotId, world: World, now: Date): SlotResult {
    const wrapper = wrapSave(world, now.toISOString());
    try {
      this.store.write(slotKey(this.packs, slot), JSON.stringify(wrapper));
    } catch (e) {
      return { ok: false, message: storageErrorMessage(e) };
    }
    this.cache.set(slot, wrapper.meta);
    return { ok: true, message: `Saved to ${SLOT_TITLES[slot]}.` };
  }

  load(slot: SlotId, def: Definition): LoadResult {
    let text: string | null;
    try {
      text = this.store.read(slotKey(this.packs, slot));
    } catch (e) {
      const message = storageErrorMessage(e);
      return { ok: false, errors: [message], message };
    }
    if (text === null) return { ok: false, errors: [], message: `${SLOT_TITLES[slot]} is empty.` };
    return loadResult(restoreText(def, text), `Loaded ${SLOT_TITLES[slot]}.`, `Cannot load ${SLOT_TITLES[slot]}.`);
  }

  remove(slot: SlotId): SlotResult {
    try {
      this.store.remove(slotKey(this.packs, slot));
    } catch (e) {
      return { ok: false, message: storageErrorMessage(e) };
    }
    this.cache.set(slot, null);
    return { ok: true, message: `Deleted ${SLOT_TITLES[slot]}.` };
  }
}

/** A restore result with the panel's message. */
export function loadResult(r: RestoreResult, done: string, failed: string): LoadResult {
  return r.ok ? { ...r, message: r.warnings.length ? `${done} (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''})` : done } : { ...r, message: failed };
}

/** The export file of a world: name and JSON text (the slot wrapper). */
export function exportFile(world: World, packs: readonly string[], now: Date): { name: string; text: string; wrapper: SaveWrapper } {
  const wrapper = wrapSave(world, now.toISOString());
  return { name: exportFileName(packs, wrapper.meta.day), text: JSON.stringify(wrapper), wrapper };
}

// ── Game panel view ─────────────────────────────────────────────────────────

export type GameCommand = 'save' | 'load' | 'delete';

export interface GameButton {
  readonly label: string;
  readonly command: GameCommand;
  readonly slot: SlotId;
  readonly disabled: boolean;
}

export interface GameSlotRow {
  readonly slot: SlotId;
  readonly title: string;
  /** `Day 2, 14:05 · tick 21900 · saved 2026-10-04 18:30`, or `empty`. */
  readonly text: string;
  readonly buttons: readonly GameButton[];
}

export interface GameView {
  readonly rows: readonly GameSlotRow[];
  /** The latest message (saved, deleted, storage failure…), or null. */
  readonly message: string | null;
  /** Errors of the last failed load or import, listed under the message. */
  readonly errors: readonly string[];
}

/** `YYYY-MM-DD HH:MM` in local time; the input as-is when it is not a date. */
export function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The Game panel: a pure function of each slot's metadata (null = empty) and the last message/errors. */
export function gameView(metas: Readonly<Record<SlotId, SaveMeta | null>>, message: string | null = null, errors: readonly string[] = []): GameView {
  return {
    rows: SLOTS.map((slot): GameSlotRow => {
      const m = metas[slot];
      return {
        slot,
        title: SLOT_TITLES[slot],
        text: m ? `Day ${m.day}, ${m.time} · tick ${m.tick} · saved ${formatSavedAt(m.savedAt)}` : 'empty',
        buttons: [
          { label: 'Save', command: 'save', slot, disabled: false },
          { label: 'Load', command: 'load', slot, disabled: m === null },
          { label: 'Delete', command: 'delete', slot, disabled: m === null },
        ],
      };
    }),
    message,
    errors,
  };
}
