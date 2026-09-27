import { formatError, loadPacks, type Definition, type LoadError, type LoadResult } from '../core/index.ts';
import { readPack } from '../node/read-pack.ts';

export interface CliArgs {
  dirs: string[];
  seed: number;
}

export function parseArgs(argv: readonly string[], usage: string): CliArgs {
  const dirs: string[] = [];
  let seed = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--seed') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v)) fail(`--seed expects an integer\n${usage}`);
      seed = v;
    } else if (a === '-h' || a === '--help') {
      console.log(usage);
      process.exit(0);
    } else if (a.startsWith('-')) fail(`unknown option '${a}'\n${usage}`);
    else dirs.push(a);
  }
  if (dirs.length === 0) fail(usage);
  return { dirs, seed };
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
