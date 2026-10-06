/**
 * The title screen's model (DOM in `picker-dom.ts`): every `game` and `mod`
 * pack of the catalog, and once one is chosen, checkboxes for the other
 * mods. A pure function of the catalog and the current choice.
 */

import { formatError, resolveStack, type Catalog, type CatalogPack } from '../core/index.ts';
import { DEFAULT_SEED } from './params.ts';

export interface PickerRow {
  /** Pack directory name (the `?packs=` token). */
  readonly dir: string;
  readonly name: string;
  readonly kind: 'game' | 'mod';
  readonly description: string;
  /** Namespaces of the resolved stack, in load order (empty when it does not resolve). */
  readonly stack: readonly string[];
  readonly chosen: boolean;
  readonly enabled: boolean;
  /** Why the row is disabled, or null. */
  readonly reason: string | null;
}

export interface PickerMod {
  readonly dir: string;
  readonly name: string;
  readonly description: string;
  readonly checked: boolean;
  readonly enabled: boolean;
  /** Why the box is disabled, or null. */
  readonly reason: string | null;
}

export interface PickerView {
  /** Games first, then mods, each by directory. */
  readonly rows: readonly PickerRow[];
  /** The other mods, when a row is chosen (else empty). */
  readonly mods: readonly PickerMod[];
  /** Namespaces of the stack that Play loads (empty when nothing is chosen). */
  readonly stack: readonly string[];
  /** `?packs=<chosen>,<checked…>&seed=<seed>`, or null when nothing playable is chosen. */
  readonly query: string | null;
  /** Catalog errors (malformed manifests…), as text. */
  readonly errors: readonly string[];
}

const byDir = (a: CatalogPack, b: CatalogPack) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);

function stackOf(catalog: Catalog, tokens: readonly string[]): { stack: string[]; reason: string | null } {
  const r = resolveStack(catalog, tokens);
  return r.ok ? { stack: r.packs.map((p) => p.namespace), reason: null } : { stack: [], reason: r.errors.map((e) => e.message).join('; ') };
}

/**
 * `chosen`: the chosen game or mod (directory name) or null; `checked`: the
 * checked mods in click order (unknown or unavailable ones are dropped).
 */
export function pickerModel(catalog: Catalog, chosen: string | null, checked: readonly string[], seed: number = DEFAULT_SEED): PickerView {
  const games = catalog.packs.filter((p) => p.kind === 'game').sort(byDir);
  const mods = catalog.packs.filter((p) => p.kind === 'mod').sort(byDir);
  const rows = [...games, ...mods].map((p): PickerRow => {
    const { stack, reason } = stackOf(catalog, [p.dir]);
    return { dir: p.dir, name: p.name, kind: p.kind as 'game' | 'mod', description: p.description, stack, chosen: p.dir === chosen, enabled: reason === null, reason };
  });
  const errors = catalog.errors.map(formatError);
  const row = rows.find((r) => r.chosen && r.enabled);
  if (!row) return { rows, mods: [], stack: [], query: null, errors };

  // Keep the checked mods that still resolve, in click order.
  const kept: string[] = [];
  for (const dir of checked) {
    if (dir === row.dir || kept.includes(dir) || !mods.some((m) => m.dir === dir)) continue;
    if (stackOf(catalog, [row.dir, ...kept, dir]).reason === null) kept.push(dir);
  }
  const current = stackOf(catalog, [row.dir, ...kept]).stack;
  const modRows = mods
    .filter((m) => m.dir !== row.dir)
    .map((m): PickerMod => {
      const base = { dir: m.dir, name: m.name, description: m.description };
      if (kept.includes(m.dir)) return { ...base, checked: true, enabled: true, reason: null };
      if (current.includes(m.namespace)) return { ...base, checked: false, enabled: false, reason: 'already in the stack' };
      const { reason } = stackOf(catalog, [row.dir, ...kept, m.dir]);
      return { ...base, checked: false, enabled: reason === null, reason };
    });
  const q = new URLSearchParams();
  q.set('packs', [row.dir, ...kept].join(','));
  q.set('seed', String(seed));
  // Keep the commas readable: `?packs=game,hard&seed=1`.
  return { rows, mods: modRows, stack: current, query: `?${q.toString().replace(/%2C/g, ',')}`, errors };
}
