/**
 * The dialogue box model: what the box shows (`dialogueBox`, a pure function
 * of `world.conversationView()`) and what a key does in it (`dialogueKey`),
 * with no DOM types, so both are unit-tested; `dialogue-dom.ts` only renders
 * the box and turns clicks and keys into `world.choose` /
 * `world.leaveConversation`.
 */

import { reasonText, type ConversationView } from '../core/index.ts';
import { shortcutOf } from './menu.ts';

/** A visible choice, numbered from 1 (`world.choose(key - 1)`). */
export interface DialogueRow {
  readonly key: number;
  readonly text: string;
  readonly disabled: boolean;
  /** Why it is disabled (`reasonText`: `Needs: 2× Coin`, the choice's `unavailable` text). */
  readonly hint?: string;
}

export interface DialogueBoxView {
  readonly speaker: string;
  readonly text: string;
  readonly rows: readonly DialogueRow[];
  /** Whether Escape leaves (false: it is refused). */
  readonly leave: boolean;
  /** The key help line, e.g. `1–3 choose · Esc leave`. */
  readonly help: string;
}

/** The box for a conversation view. */
export function dialogueBox(view: ConversationView): DialogueBoxView {
  const rows = view.choices.map((c, k): DialogueRow => (c.ok ? { key: k + 1, text: c.text, disabled: false } : { key: k + 1, text: c.text, disabled: true, hint: reasonText(c) }));
  const n = rows.length;
  const choose = n === 1 ? '1 choose' : `1–${n} choose`;
  return { speaker: view.speaker, text: view.text, rows, leave: view.leave, help: view.leave ? `${choose} · Esc leave` : choose };
}

/**
 * Keys that still reach the shell while the box is open: the journal, the
 * game panel, quicksave and quickload, the HUD and perf toggles.
 */
export const DIALOGUE_PASS_KEYS: ReadonlySet<string> = new Set(['KeyJ', 'KeyO', 'F5', 'F9', 'KeyH', 'F3']);

/** What a key does in the box. */
export type DialogueKey =
  /** Choose row `index` (`world.choose(index)`). */
  | { readonly kind: 'choose'; readonly index: number }
  /** Move the selection to row `index`. */
  | { readonly kind: 'select'; readonly index: number }
  /** Leave the conversation. */
  | { readonly kind: 'leave' }
  /** Escape at a node that cannot be left: shake and say `LEAVE_REFUSED_TEXT`. */
  | { readonly kind: 'refuse' }
  /** Not the box's: the shell handles it (`DIALOGUE_PASS_KEYS`). */
  | { readonly kind: 'pass' }
  /** Swallowed: movement, the menu, the transfer window and so on are off while the box is open. */
  | { readonly kind: 'none' };

const NONE: DialogueKey = { kind: 'none' };

/**
 * A key (`KeyboardEvent.code`) in the box with row `selected` selected (-1
 * for none): `1`–`9` choose an enabled row, arrows move over the enabled
 * rows (wrapping), `Enter` chooses the selected row, or with none selected
 * the only enabled one, and `Escape` leaves or is refused.
 */
export function dialogueKey(box: DialogueBoxView, selected: number, code: string): DialogueKey {
  if (DIALOGUE_PASS_KEYS.has(code)) return { kind: 'pass' };
  const n = shortcutOf(code);
  if (n > 0) {
    const row = box.rows[n - 1];
    return row && !row.disabled ? { kind: 'choose', index: n - 1 } : NONE;
  }
  const enabled = box.rows.flatMap((r, k) => (r.disabled ? [] : [k]));
  switch (code) {
    case 'ArrowDown':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowLeft': {
      if (enabled.length === 0) return NONE;
      const down = code === 'ArrowDown' || code === 'ArrowRight';
      const at = enabled.indexOf(selected);
      const next = at < 0 ? (down ? 0 : enabled.length - 1) : (at + (down ? 1 : -1) + enabled.length) % enabled.length;
      return { kind: 'select', index: enabled[next]! };
    }
    case 'Enter':
    case 'NumpadEnter':
      if (enabled.includes(selected)) return { kind: 'choose', index: selected };
      return enabled.length === 1 ? { kind: 'choose', index: enabled[0]! } : NONE;
    case 'Escape':
      return box.leave ? { kind: 'leave' } : { kind: 'refuse' };
    default:
      return NONE;
  }
}
