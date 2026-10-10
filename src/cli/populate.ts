/** `check --populate` output: what every populate entry places, per map (pure, for tests). */

import { populatePlan, type Definition } from '../core/index.ts';

/**
 * For every map with populate entries (a composite lists its parts' entries
 * per placement, in application order), one line per entry: the archetype,
 * `count N` or `density d → N`, the candidate cells after `where`, and the
 * cells sure to be free after earlier overlapping entries; then the total.
 */
export function formatPopulate(def: Pick<Definition, 'maps' | 'tiles' | 'archetypes'>): string[] {
  const out = ['populate:'];
  let any = false;
  for (const map of def.maps) {
    if (!map.populate.length) continue;
    any = true;
    out.push(`  ${map.id}`);
    const plans = populatePlan(map, def.tiles);
    const names = map.populate.map((p) => def.archetypes[p.archetype]!.id);
    const w = Math.max(...names.map((n) => n.length));
    const howMany = map.populate.map((p, k) => (p.count !== null ? `count ${p.count}` : `density ${p.density} → ${plans[k]!.count}`));
    const hw = Math.max(...howMany.map((h) => h.length));
    let total = 0;
    plans.forEach(({ candidates, count, taken }, k) => {
      total += count;
      out.push(`    ${names[k]!.padEnd(w)}  ${howMany[k]!.padEnd(hw)}  ${candidates.length} candidates, ${candidates.length - taken} free`);
    });
    out.push(`    total ${total}`);
  }
  if (!any) out.push('  none');
  return out;
}
