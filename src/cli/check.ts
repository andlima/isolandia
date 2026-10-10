import type { LoadError } from '../core/index.ts';
import { fail, loadOrExitIf, parseArgs, stackOrExit } from './common.ts';
import { formatExposure } from './exposure.ts';
import { formatOverrides, patchSummary } from './overrides.ts';
import { formatPopulate } from './populate.ts';
import { readSaveFile } from './saves.ts';

const args = parseArgs(
  process.argv.slice(2),
  'usage: npm run check -- <pack|pack-dir> [<pack|pack-dir>…] [--packs-dir <dir>] [--save <file>] [--overrides] [--populate] [--exposure <map>]',
  ['--seed', '--save', '--packs-dir', '--exposure'],
  ['--overrides', '--populate'],
);
const { save, overrides, populate, exposure } = args;
const dirs = stackOrExit(args);

/**
 * A stack whose only error is the missing `start` is a valid *library* stack
 * (e.g. `std` + `std-needs` without a genre pack): not playable, but its
 * content validates. Everything else is fatal.
 */
const isMissingStartOnly = (errors: readonly LoadError[]): boolean =>
  errors.length === 1 && errors[0]!.message.startsWith("no 'start' defined");

const r = loadOrExitIf(dirs, (errors) => save !== null || !isMissingStartOnly(errors));
if (!r.ok) {
  console.log(`OK: ${dirs.join(', ')} — library stack (no 'start' defined; not playable on its own)`);
} else {
  const def = r.definition;
  console.log(
    `OK: ${def.packs.map((p) => `${p.namespace}@${p.version}`).join(', ')} — ` +
      `${def.measurements.length} measurements, ${def.assets.length} assets, ${def.tiles.length} tiles, ` +
      `${def.archetypes.length} archetypes, ${def.maps.length} maps, ` +
      `${def.systems.length} systems, ${def.statuses.length} statuses, ` +
      `${def.items.length} items, ${def.loot.length} loot tables, ${def.distributions.length} distributions, ` +
      `${def.behaviors.length} behaviors, ${def.actions.length} actions, ${def.recipes.length} recipes, ` +
      `${def.vars.length} vars, ${def.quests.length} quests, ${def.journal.length} journal entries, ${def.dialogues.length} dialogues, ${def.factions.length} factions`,
  );
  for (const line of overrides ? formatOverrides(def) : patchSummary(def)) console.log(line);
  if (populate) for (const line of formatPopulate(def)) console.log(line);
  if (exposure !== null) {
    const e = formatExposure(def, exposure);
    if (!e.ok) fail(e.error);
    for (const line of e.lines) console.log(line);
  }
  if (save !== null) {
    const s = readSaveFile(def, save);
    if (!s.ok) {
      for (const e of s.errors) console.error(`${save}: ${e}`);
      fail(`\n${s.errors.length} error(s); save not loaded.`);
    }
    for (const w of s.warnings) console.error(`warning: ${save}: ${w}`);
    const { day, hour, minute } = s.world.clock;
    console.log(
      `OK: ${save} — tick ${s.world.tick}, day ${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}, ` +
        `${s.world.entities.length} entities, ${s.world.containers.size} containers` +
        (s.warnings.length ? `, ${s.warnings.length} warning(s)` : ''),
    );
  }
}
