import { runTerminal } from '../ascii/terminal.ts';
import { World } from '../core/index.ts';
import { fail, loadOrExit, parseArgs } from './common.ts';

const { dirs, seed } = parseArgs(
  process.argv.slice(2),
  'usage: npm run play -- <pack-dir> [<pack-dir>…] [--seed N]',
);
const def = loadOrExit(dirs);
if (!process.stdin.isTTY) fail('play needs an interactive terminal (stdin is not a TTY)');
const world = World.create(def, seed);
await runTerminal(world, { stdin: process.stdin, stdout: process.stdout });
process.exit(0);
