/** `check` output for mods: what every pack overrode or removed (pure, for tests). */

import type { Definition, PatchDomain } from '../core/index.ts';

const KIND: Record<PatchDomain, string> = {
  measurements: 'measurement',
  assets: 'asset',
  tiles: 'tile',
  archetypes: 'archetype',
  maps: 'map',
  systems: 'system',
  statuses: 'status',
  items: 'item',
  loot: 'loot',
  behaviors: 'behavior',
  actions: 'action',
  recipes: 'recipe',
  vars: 'var',
  quests: 'quest',
  journal: 'journal entry',
  start: 'start',
  clock: 'clock',
  lighting: 'lighting',
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One line per pack that patched anything: `hardmode: 3 overrides, 1 removal`. */
export function patchSummary(def: Pick<Definition, 'packs' | 'patches'>): string[] {
  const out: string[] = [];
  for (const { namespace } of def.packs) {
    const mine = def.patches.filter((p) => p.pack === namespace);
    if (!mine.length) continue;
    const overrides = mine.filter((p) => p.op === 'override').length;
    const removals = mine.length - overrides;
    const parts = [overrides ? plural(overrides, 'override', 'overrides') : '', removals ? plural(removals, 'removal', 'removals') : ''].filter(Boolean);
    out.push(`${namespace}: ${parts.join(', ')}`);
  }
  return out;
}

/** `check --overrides`: the loaded stack, then one aligned line per patch in application order. */
export function formatOverrides(def: Pick<Definition, 'packs' | 'patches'>): string[] {
  const out = ['stack:'];
  const nsWidth = Math.max(0, ...def.packs.map((p) => p.namespace.length));
  for (const p of def.packs) out.push(`  ${p.namespace.padEnd(nsWidth)}  ${p.version}`);
  if (!def.patches.length) {
    out.push('patches: none');
    return out;
  }
  out.push('patches:');
  const w = {
    pack: Math.max(...def.patches.map((p) => p.pack.length)) + 2,
    op: 'override'.length + 2,
    kind: Math.max(...def.patches.map((p) => KIND[p.domain].length)) + 1,
    id: Math.max(...def.patches.map((p) => (p.id ?? '').length)) + 2,
  };
  for (const p of def.patches) {
    const fields = p.op === 'override' ? `[${p.fields.join(', ')}]` : '';
    const line = `${p.pack.padEnd(w.pack)}${p.op.padEnd(w.op)}${KIND[p.domain].padEnd(w.kind)}${(p.id ?? '').padEnd(w.id)}${fields}`;
    out.push(`  ${line.trimEnd()}`);
  }
  return out;
}
