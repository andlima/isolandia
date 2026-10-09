/**
 * The terminal's key table (the same `Binding` shape as the browser's, keys
 * only) and the `?` help screen drawn from it, grouped by section.
 */

import type { Binding } from '../web/bindings.ts';

export const TERMINAL_BINDINGS: readonly Binding[] = [
  // ── Moving ──
  { id: 'move', keys: ['arrows', 'wasd', 'hjklyubn', 'numpad'], label: 'Move (grid-aligned, 8 directions)', section: 'Moving' },
  { id: 'climb_up', keys: ['<'], label: 'Go up the stairs you stand on', section: 'Moving' },
  { id: 'climb_down', keys: ['>'], label: 'Go down', section: 'Moving' },
  // ── Interacting ──
  { id: 'act', keys: ['x'], label: 'List what you can do here (1–9 chooses, any other key closes)', section: 'Interacting' },
  { id: 'take_all', keys: ['g'], label: 'Take everything nearby that fits', section: 'Interacting' },
  { id: 'use', keys: ['1–9'], label: 'Use inventory stack N', section: 'Interacting' },
  { id: 'drop', keys: ['d 1–9'], label: 'Drop one of inventory stack N', section: 'Interacting' },
  { id: 'dialogue_choose', keys: ['1–9'], label: 'Choose that answer', section: 'Interacting', context: 'dialogue' },
  { id: 'dialogue_leave', keys: ['Esc'], label: 'Leave the conversation', section: 'Interacting', context: 'dialogue' },
  // ── Windows ──
  { id: 'crafting', keys: ['c'], label: 'List the recipes you can make now (1–9 crafts one)', section: 'Windows' },
  { id: 'journal', keys: ['J'], label: 'Journal (until any key)', section: 'Windows' },
  { id: 'log', keys: ['M'], label: 'Message log (until any key)', section: 'Windows' },
  // ── Time ──
  { id: 'pause', keys: ['p'], label: 'Pause or resume', section: 'Time' },
  { id: 'faster', keys: ['+', '='], label: 'Faster (2×, 4×, 8×)', section: 'Time' },
  { id: 'slower', keys: ['-'], label: 'Slower (down to 1×)', section: 'Time' },
  // ── Game ──
  { id: 'save', keys: ['S'], label: 'Save to the save file', section: 'Game' },
  { id: 'load', keys: ['L'], label: 'Load the save file', section: 'Game' },
  { id: 'help', keys: ['?'], label: 'This help (until any key)', section: 'Game' },
  { id: 'quit', keys: ['q'], label: 'Quit', section: 'Game' },
];

/**
 * The `?` screen: `Controls`, then each section with its rows as
 * `  keys  label`, the keys padded to one column; context rows follow their
 * section under an indented heading. The caller adds the `(any key)` footer.
 */
export function helpLines(bindings: readonly Binding[] = TERMINAL_BINDINGS): string[] {
  const keysOf = (b: Binding) => b.keys.join(' / ');
  const width = Math.max(0, ...bindings.map((b) => keysOf(b).length));
  const row = (b: Binding) => `  ${keysOf(b).padEnd(width)}  ${b.label}`;
  const out = ['Controls'];
  for (const section of [...new Set(bindings.map((b) => b.section))]) {
    const own = bindings.filter((b) => b.section === section);
    out.push('', section, ...own.filter((b) => !b.context).map(row));
    for (const context of [...new Set(own.flatMap((b) => (b.context ? [b.context] : [])))]) {
      out.push(`  ${context === 'dialogue' ? 'In a conversation' : context === 'menu' ? 'In the action list' : 'In the transfer window'}`);
      out.push(...own.filter((b) => b.context === context).map(row));
    }
  }
  return out;
}
