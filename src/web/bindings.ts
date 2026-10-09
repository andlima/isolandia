/**
 * The one table of every browser key and gesture. The key handlers dispatch
 * through it (`bindingFor`), the controls overlay (`help.ts`) draws it, and
 * a test checks the Keys table in `docs/ui.md` against it.
 *
 * `keys` are display names (`I`, `Tab`, `Arrows`); the lookup uses `codes`
 * (`KeyboardEvent.code`, layout-independent) and `chars` (`KeyboardEvent.key`,
 * for `<`, `>` and `?`, which follow the layout). Movement stays in
 * `MOVE_KEYS` for the step logic: the table lists it as one row.
 */

import { CLIMB_KEYS, MOVE_KEYS, PAUSE_KEYS } from './keys.ts';

/** The overlay's sections, in order. */
export const SECTIONS = ['Moving', 'Interacting', 'Windows', 'Time', 'Game', 'View'] as const;

export type BindingSection = (typeof SECTIONS)[number];

/** Rows that only apply while something is open: the action menu, the dialogue box or the transfer window. */
export type BindingContext = 'menu' | 'dialogue' | 'window';

export interface Binding {
  readonly id: string;
  /** Display names of the keys, e.g. `['I', 'Tab']`; empty for a gesture-only row. */
  readonly keys: readonly string[];
  /** The mouse and touch gestures that do the same, when any. */
  readonly gesture?: { readonly mouse?: string; readonly touch?: string };
  readonly label: string;
  readonly section: BindingSection;
  readonly context?: BindingContext;
  /** `KeyboardEvent.code` values that dispatch to this binding. */
  readonly codes?: readonly string[];
  /** `KeyboardEvent.key` values that dispatch to this binding (checked before `codes`). */
  readonly chars?: readonly string[];
}

/** Headings of the context groups in the overlay. */
export const CONTEXT_TITLES: Readonly<Record<BindingContext, string>> = {
  menu: 'In the action menu',
  dialogue: 'In a conversation',
  window: 'In the transfer window',
};

const climb = (dz: 1 | -1) => Object.keys(CLIMB_KEYS).filter((k) => CLIMB_KEYS[k] === dz);

export const BINDINGS: readonly Binding[] = [
  // ── Moving ──
  { id: 'move', keys: ['Arrows', 'WASD', 'numpad'], label: 'Move (screen-relative)', section: 'Moving', codes: Object.keys(MOVE_KEYS) },
  { id: 'walk', keys: [], gesture: { mouse: 'Shift + click' }, label: 'Walk there', section: 'Moving' },
  { id: 'climb_up', keys: ['PageUp', '<'], label: 'Go up the stairs you stand on', section: 'Moving', chars: climb(1) },
  { id: 'climb_down', keys: ['PageDown', '>'], label: 'Go down', section: 'Moving', chars: climb(-1) },
  // ── Interacting ──
  { id: 'interact', keys: [], gesture: { mouse: 'Click', touch: 'Tap' }, label: 'Talk to an NPC, the safe default (open, climb, walk), or the menu', section: 'Interacting' },
  { id: 'menu', keys: ['E'], gesture: { mouse: 'Right-click', touch: 'Long-press' }, label: 'Action menu', section: 'Interacting', codes: ['KeyE'] },
  { id: 'menu_choose', keys: ['1–9'], label: 'Choose that menu row', section: 'Interacting', context: 'menu' },
  { id: 'menu_keys', keys: ['Arrows', 'Enter', 'Escape'], label: 'Move, choose (or fold / unfold), close', section: 'Interacting', context: 'menu' },
  { id: 'dialogue_choose', keys: ['1–9'], gesture: { mouse: 'Click', touch: 'Tap' }, label: 'Choose that answer', section: 'Interacting', context: 'dialogue' },
  { id: 'dialogue_keys', keys: ['Arrows', 'Enter', 'Escape'], label: 'Move, choose (or the only enabled answer), leave', section: 'Interacting', context: 'dialogue' },
  // ── Windows ──
  { id: 'inventory', keys: ['I', 'Tab'], label: 'Inventory / transfer window', section: 'Windows', codes: ['KeyI', 'Tab'] },
  { id: 'crafting', keys: ['C'], label: 'Crafting panel', section: 'Windows', codes: ['KeyC'] },
  { id: 'journal', keys: ['J'], label: 'Journal panel', section: 'Windows', codes: ['KeyJ'] },
  { id: 'log', keys: ['M'], label: 'Message log history', section: 'Windows', codes: ['KeyM'] },
  { id: 'transfer_move', keys: [], gesture: { mouse: 'Click / Shift + click a stack', touch: 'Tap a stack' }, label: 'Move the whole stack / one unit', section: 'Windows', context: 'window' },
  // ── Time ──
  { id: 'pause', keys: ['P', 'Pause'], label: 'Pause or resume', section: 'Time', codes: [...PAUSE_KEYS] },
  { id: 'faster', keys: ['+', '=', 'numpad +'], label: 'Faster (2×, 4×, 8×)', section: 'Time', codes: ['Equal', 'NumpadAdd'] },
  { id: 'slower', keys: ['-', 'numpad -'], label: 'Slower (down to 1×)', section: 'Time', codes: ['Minus', 'NumpadSubtract'] },
  // ── Game ──
  { id: 'game', keys: ['O'], label: 'Game panel (save slots, export, import)', section: 'Game', codes: ['KeyO'] },
  { id: 'quicksave', keys: ['F5'], label: 'Quicksave', section: 'Game', codes: ['F5'] },
  { id: 'quickload', keys: ['F9'], label: 'Quickload', section: 'Game', codes: ['F9'] },
  { id: 'help', keys: ['?'], label: 'Controls (this overlay)', section: 'Game', chars: ['?'] },
  { id: 'escape', keys: ['Escape'], label: 'Close what is open, or the pause menu', section: 'Game', codes: ['Escape'] },
  // ── View ──
  { id: 'pan', keys: [], gesture: { mouse: 'Drag', touch: 'Drag' }, label: 'Pan the camera', section: 'View' },
  { id: 'zoom', keys: [], gesture: { mouse: 'Wheel', touch: 'Pinch' }, label: 'Zoom', section: 'View' },
  { id: 'recenter', keys: ['Space'], label: 'Recenter the camera', section: 'View', codes: ['Space'] },
  { id: 'hud', keys: ['H'], label: 'Toggle the HUD, the message log strip and hover tooltips', section: 'View', codes: ['KeyH'] },
  { id: 'perf', keys: ['F3'], label: 'Toggle the perf line', section: 'View', codes: ['F3'] },
];

const BY_CHAR = new Map<string, string>();
const BY_CODE = new Map<string, string>();
for (const b of BINDINGS) {
  for (const k of b.chars ?? []) BY_CHAR.set(k, b.id);
  for (const c of b.codes ?? []) BY_CODE.set(c, b.id);
}

/**
 * The binding a key press dispatches to, or null: `KeyboardEvent.key` first
 * (`<`, `>`, `?` follow the layout), then `KeyboardEvent.code`.
 */
export function bindingFor(code: string, key: string): string | null {
  return BY_CHAR.get(key) ?? BY_CODE.get(code) ?? null;
}

/** The bindings a key press can reach: those with `codes` or `chars` (gesture-only and context rows are handled elsewhere). */
export function keyBindings(bindings: readonly Binding[] = BINDINGS): readonly Binding[] {
  return bindings.filter((b) => (b.codes?.length ?? 0) + (b.chars?.length ?? 0) > 0);
}
