/**
 * Controls overlay, Escape priority and pause menu: the pure parts.
 * `helpView` turns the bindings table into the overlay's sections for a
 * mouse or a touch player, `escapeTarget` says what `Escape` closes,
 * `trackWindows` keeps the windows in opening order for it, and the
 * first-run flag lives in the save store. `help-dom.ts` renders all of it.
 */

import { CONTEXT_TITLES, SECTIONS, type Binding, type BindingContext } from './bindings.ts';
import type { SaveStore } from './saves.ts';

/** The player's pointer: the gesture column follows it. */
export type InputKind = 'mouse' | 'touch';

export interface HelpRow {
  readonly id: string;
  /** Key chips (`<kbd>`), possibly none. */
  readonly keys: readonly string[];
  /** The gesture for the current input, or null. */
  readonly gesture: string | null;
  readonly label: string;
}

export interface HelpGroup {
  /** `In the action menu`, … */
  readonly title: string;
  readonly rows: readonly HelpRow[];
}

export interface HelpSection {
  readonly title: string;
  readonly rows: readonly HelpRow[];
  /** Context-only rows, grouped under a small heading. */
  readonly groups: readonly HelpGroup[];
}

export interface HelpView {
  readonly title: string;
  readonly input: InputKind;
  readonly sections: readonly HelpSection[];
  /** The footer: how to close. */
  readonly close: string;
}

/**
 * The overlay: the sections in `SECTIONS` order, each binding as one row
 * with its keys and the gesture for `input`. Rows with neither (a mouse-only
 * gesture on touch) are left out, as are sections that end up empty.
 */
export function helpView(bindings: readonly Binding[], input: InputKind): HelpView {
  const row = (b: Binding): HelpRow | null => {
    const gesture = b.gesture?.[input] ?? null;
    return b.keys.length === 0 && gesture === null ? null : { id: b.id, keys: b.keys, gesture, label: b.label };
  };
  const rowsOf = (list: readonly Binding[]) => list.map(row).filter((r): r is HelpRow => r !== null);
  const sections: HelpSection[] = [];
  for (const title of SECTIONS) {
    const own = bindings.filter((b) => b.section === title);
    const rows = rowsOf(own.filter((b) => !b.context));
    const groups: HelpGroup[] = [];
    for (const context of Object.keys(CONTEXT_TITLES) as BindingContext[]) {
      const g = rowsOf(own.filter((b) => b.context === context));
      if (g.length) groups.push({ title: CONTEXT_TITLES[context], rows: g });
    }
    if (rows.length || groups.length) sections.push({ title, rows, groups });
  }
  return { title: 'Controls', input, sections, close: input === 'touch' ? 'Tap outside or × to close' : 'Escape, ? or a click outside closes' };
}

// ── Escape ──────────────────────────────────────────────────────────────────

/** The windows `Escape` closes, most recently opened first. */
export type WindowId = 'transfer' | 'crafting' | 'journal' | 'log' | 'game';

export const WINDOW_IDS: readonly WindowId[] = ['transfer', 'crafting', 'journal', 'log', 'game'];

export interface EscapeState {
  /** The controls overlay is open. */
  readonly help: boolean;
  /** The context menu is open. */
  readonly menu: boolean;
  /** A conversation is open. */
  readonly dialogue: boolean;
  /** The open windows in opening order (oldest first, see `trackWindows`). */
  readonly windows: readonly WindowId[];
}

export type EscapeTarget =
  | { readonly kind: 'help' }
  | { readonly kind: 'menu' }
  | { readonly kind: 'dialogue' }
  | { readonly kind: 'window'; readonly window: WindowId }
  /** Nothing to close: toggle the pause menu. */
  | { readonly kind: 'pause' };

/**
 * What `Escape` does: close the controls overlay, else the context menu,
 * else leave the dialogue (as its own key handling does), else close the
 * most recently opened window, else toggle the pause menu.
 */
export function escapeTarget(s: EscapeState): EscapeTarget {
  if (s.help) return { kind: 'help' };
  if (s.menu) return { kind: 'menu' };
  if (s.dialogue) return { kind: 'dialogue' };
  const last = s.windows[s.windows.length - 1];
  if (last) return { kind: 'window', window: last };
  return { kind: 'pause' };
}

/**
 * The open windows in opening order: `order` is the previous list, `open`
 * which windows are open now. Newly opened ones go to the end, closed ones
 * drop out; windows that stayed open keep their place.
 */
export function trackWindows(order: readonly WindowId[], open: Readonly<Record<WindowId, boolean>>): WindowId[] {
  const kept = order.filter((w) => open[w]);
  for (const w of WINDOW_IDS) if (open[w] && !kept.includes(w)) kept.push(w);
  return kept;
}

// ── First-run hint ──────────────────────────────────────────────────────────

/** `localStorage` key of the flag set once the player has seen the controls hint or overlay. */
export const HELP_SEEN_KEY = 'isolandia:help-seen';

/** How long the hint stays up before it fades. */
export const HINT_MS = 6000;

/** The hint's text for the player's input. */
export function hintText(input: InputKind): string {
  return input === 'touch' ? 'Tap ? for controls' : 'Press ? for controls';
}

/** Whether the flag is set; a throwing store counts as not set (the hint shows again). */
export function readHelpSeen(store: SaveStore): boolean {
  try {
    return store.read(HELP_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Set the flag; storage errors are ignored. */
export function writeHelpSeen(store: SaveStore): void {
  try {
    store.write(HELP_SEEN_KEY, '1');
  } catch {
    // Blocked or full storage: the hint simply shows again next time.
  }
}

// ── Pause menu ──────────────────────────────────────────────────────────────

export type PauseItemId = 'resume' | 'controls' | 'game' | 'title';

export interface PauseItem {
  readonly id: PauseItemId;
  readonly label: string;
  /** A tooltip, when the item needs a warning. */
  readonly hint?: string;
}

export interface PauseMenuView {
  readonly title: string;
  readonly items: readonly PauseItem[];
}

/** The pause menu's rows: Resume, Controls, Game…, Title screen. After defeat or victory nothing is paused, so the title says `Menu`. */
export function pauseMenuView(ended: boolean): PauseMenuView {
  return {
    title: ended ? 'Menu' : 'Paused',
    items: [
      { id: 'resume', label: ended ? 'Back' : 'Resume' },
      { id: 'controls', label: 'Controls' },
      { id: 'game', label: 'Game…' },
      { id: 'title', label: 'Title screen', hint: 'Back to the title screen (unsaved progress is lost)' },
    ],
  };
}
