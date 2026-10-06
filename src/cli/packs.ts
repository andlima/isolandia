/** `npm run packs`: list the pack catalog, or with `--stack <names…>` the resolved stack. */

import { formatError } from '../core/index.ts';
import { catalogTable, fail, parseArgs, resolveCliStack } from './common.ts';

const args = parseArgs(process.argv.slice(2), 'usage: npm run packs -- [--packs-dir <dir>] [--stack <pack|pack-dir>…]', ['--packs-dir'], ['--stack'], false);
if (args.stack && args.dirs.length === 0) fail('--stack expects at least one pack name');
if (!args.stack && args.dirs.length > 0) fail(`unexpected argument '${args.dirs[0]}' (use --stack <names…> to resolve a stack)`);

const s = resolveCliStack(args.dirs, args.packsDir);
if (!args.stack) {
  for (const e of s.catalog.errors) console.error(formatError(e));
  if (s.catalog.packs.length === 0) console.log(`no packs found under ${args.packsDir}/`);
  else for (const line of catalogTable(s.catalog.packs)) console.log(line);
  if (s.catalog.errors.length) fail(`\n${s.catalog.errors.length} error(s) in the catalog.`);
} else {
  if (s.errors.length) {
    for (const e of s.errors) console.error(formatError(e));
    fail(`\n${s.errors.length} error(s); no stack.`);
  }
  for (const line of catalogTable(s.packs, false)) console.log(line);
}
