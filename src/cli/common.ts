import { formatError, loadPacks, type Definition, type LoadError, type LoadResult } from '../core/index.ts';
import { readPack } from '../node/read-pack.ts';

export interface CliArgs {
  dirs: string[];
  /** `--seed N`, or null when not given (the default seed is 1). */
  seed: number | null;
  /** `--load <file>` (play). */
  load: string | null;
  /** `--save-file <path>` (play). */
  saveFile: string | null;
  /** `--save <file>` (check). */
  save: string | null;
}

/** Options that take a value; each CLI accepts its own subset. */
export type CliOption = '--seed' | '--load' | '--save-file' | '--save';

export function parseArgs(argv: readonly string[], usage: string, options: readonly CliOption[] = ['--seed']): CliArgs {
  const args: CliArgs = { dirs: [], seed: null, load: null, saveFile: null, save: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      console.log(usage);
      process.exit(0);
    } else if ((options as readonly string[]).includes(a)) {
      const v = argv[++i];
      if (v === undefined) fail(`${a} expects a value\n${usage}`);
      if (a === '--seed') {
        const n = Number(v);
        if (v.trim() === '' || !Number.isInteger(n)) fail(`--seed expects an integer\n${usage}`);
        args.seed = n;
      } else if (a === '--load') args.load = v;
      else if (a === '--save-file') args.saveFile = v;
      else args.save = v;
    } else if (a.startsWith('-')) fail(`unknown option '${a}'\n${usage}`);
    else args.dirs.push(a);
  }
  if (args.dirs.length === 0) fail(usage);
  return args;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Read and load packs; on errors print every one and exit non-zero. */
export function loadOrExit(dirs: readonly string[]): Definition {
  const r = loadOrExitIf(dirs, () => true);
  if (!r.ok) throw new Error('unreachable');
  return r.definition;
}

/**
 * Like {@link loadOrExit}, but only exits when `fatal(errors)` holds;
 * otherwise the failed result is returned to the caller.
 */
export function loadOrExitIf(dirs: readonly string[], fatal: (errors: readonly LoadError[]) => boolean): LoadResult {
  let sources;
  try {
    sources = dirs.map(readPack);
  } catch (e) {
    fail(`cannot read pack: ${(e as Error).message}`);
  }
  const r = loadPacks(sources);
  for (const w of r.warnings) console.error(`warning: ${formatError(w)}`);
  if (!r.ok && fatal(r.errors)) {
    for (const e of r.errors) console.error(formatError(e));
    fail(`\n${r.errors.length} error(s); packs not loaded.`);
  }
  return r;
}
