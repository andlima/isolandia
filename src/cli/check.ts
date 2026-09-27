import type { LoadError } from '../core/index.ts';
import { loadOrExitIf, parseArgs } from './common.ts';

const { dirs } = parseArgs(process.argv.slice(2), 'usage: npm run check -- <pack-dir> [<pack-dir>…]');

/**
 * A stack whose only error is the missing `start` is a valid *library* stack
 * (e.g. `std` + `std-needs` without a genre pack): not playable, but its
 * content validates. Everything else is fatal.
 */
const isMissingStartOnly = (errors: readonly LoadError[]): boolean =>
  errors.length === 1 && errors[0]!.message.startsWith("no 'start' defined");

const r = loadOrExitIf(dirs, (errors) => !isMissingStartOnly(errors));
if (!r.ok) {
  console.log(`OK: ${dirs.join(', ')} — library stack (no 'start' defined; not playable on its own)`);
} else {
  const def = r.definition;
  console.log(
    `OK: ${def.packs.map((p) => `${p.namespace}@${p.version}`).join(', ')} — ` +
      `${def.measurements.length} measurements, ${def.assets.length} assets, ${def.tiles.length} tiles, ` +
      `${def.archetypes.length} archetypes, ${def.maps.length} maps, ` +
      `${def.systems.length} systems, ${def.statuses.length} statuses, ` +
      `${def.items.length} items, ${def.loot.length} loot tables, ${def.distributions.length} distributions`,
  );
}
