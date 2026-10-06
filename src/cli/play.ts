import { runTerminal } from '../ascii/terminal.ts';
import { World } from '../core/index.ts';
import { fail, loadOrExit, parseArgs, stackOrExit } from './common.ts';
import { DEFAULT_SAVE_FILE, loadMessage, readSaveFile, writeSaveFile } from './saves.ts';

const args = parseArgs(
  process.argv.slice(2),
  'usage: npm run play -- <pack|pack-dir> [<pack|pack-dir>…] [--packs-dir <dir>] [--seed N | --load <file>] [--save-file <path>]',
  ['--seed', '--load', '--save-file', '--packs-dir'],
);
if (args.load !== null && args.seed !== null) fail('--seed cannot be used with --load: the save carries its seed');
const def = loadOrExit(stackOrExit(args));
const saveFile = args.saveFile ?? DEFAULT_SAVE_FILE;

let world: World;
let status = '';
if (args.load !== null) {
  const r = readSaveFile(def, args.load);
  if (!r.ok) {
    for (const e of r.errors) console.error(e);
    fail(`\n${r.errors.length} error(s); save not loaded.`);
  }
  for (const w of r.warnings) console.error(`warning: ${w}`);
  world = r.world;
  status = loadMessage(args.load, r);
} else world = World.create(def, args.seed ?? 1);

if (!process.stdin.isTTY) fail('play needs an interactive terminal (stdin is not a TTY)');
await runTerminal(
  world,
  { stdin: process.stdin, stdout: process.stdout },
  {
    save: (w) => writeSaveFile(w, saveFile) ?? `Saved to ${saveFile}.`,
    load: () => {
      const r = readSaveFile(def, saveFile);
      return { world: r.ok ? r.world : null, message: loadMessage(saveFile, r) };
    },
  },
  status,
);
process.exit(0);
