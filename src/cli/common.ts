import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import {
  buildCatalog,
  findPack,
  formatError,
  loadPacks,
  MANIFEST,
  resolveStack,
  type Catalog,
  type CatalogPack,
  type Definition,
  type LoadError,
  type LoadResult,
} from '../core/index.ts';
import { readPack } from '../node/read-pack.ts';

export interface CliArgs {
  /** Pack names (directory name or namespace) and pack directories, as given. */
  dirs: string[];
  /** `--packs-dir <dir>`: the catalog root (default `packs`). */
  packsDir: string;
  /** `--stack` (packs). */
  stack: boolean;
  /** `--seed N`, or null when not given (the default seed is 1). */
  seed: number | null;
  /** `--load <file>` (play). */
  load: string | null;
  /** `--save-file <path>` (play). */
  saveFile: string | null;
  /** `--save <file>` (check). */
  save: string | null;
  /** `--overrides` (check). */
  overrides: boolean;
  /** `--populate` (check). */
  populate: boolean;
  /** `--exposure <map id>` (check), or null when not given. */
  exposure: string | null;
}

/** Options that take a value; each CLI accepts its own subset. */
export type CliOption = '--seed' | '--load' | '--save-file' | '--save' | '--packs-dir' | '--exposure';
/** Options without a value. */
export type CliFlag = '--overrides' | '--populate' | '--stack';

export const DEFAULT_PACKS_DIR = 'packs';

export function parseArgs(
  argv: readonly string[],
  usage: string,
  options: readonly CliOption[] = ['--seed'],
  flags: readonly CliFlag[] = [],
  needPacks = true,
): CliArgs {
  const args: CliArgs = { dirs: [], packsDir: DEFAULT_PACKS_DIR, stack: false, seed: null, load: null, saveFile: null, save: null, overrides: false, populate: false, exposure: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      console.log(usage);
      process.exit(0);
    } else if ((flags as readonly string[]).includes(a)) {
      if (a === '--stack') args.stack = true;
      else if (a === '--populate') args.populate = true;
      else args.overrides = true;
    } else if ((options as readonly string[]).includes(a)) {
      const v = argv[++i];
      if (v === undefined) fail(`${a} expects a value\n${usage}`);
      if (a === '--seed') {
        const n = Number(v);
        if (v.trim() === '' || !Number.isInteger(n)) fail(`--seed expects an integer\n${usage}`);
        args.seed = n;
      } else if (a === '--load') args.load = v;
      else if (a === '--packs-dir') args.packsDir = v;
      else if (a === '--save-file') args.saveFile = v;
      else if (a === '--exposure') args.exposure = v;
      else args.save = v;
    } else if (a.startsWith('-')) fail(`unknown option '${a}'\n${usage}`);
    else args.dirs.push(a);
  }
  if (needPacks && args.dirs.length === 0) fail(usage);
  return args;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ── Stacks ─────────────────────────────────────────────────────────────────

/** The file system calls the stack resolver needs (injected for tests). */
export interface PackFs {
  /** Names of the subdirectories of `dir`; [] when it does not exist. */
  subdirs(dir: string): string[];
  /** The `pack.yaml` text of a pack directory, or undefined. */
  manifest(dir: string): string | undefined;
}

export const nodePackFs: PackFs = {
  subdirs: (dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .sort();
  },
  manifest: (dir) => {
    const f = join(dir, MANIFEST);
    return existsSync(f) && statSync(f).isFile() ? readFileSync(f, 'utf8') : undefined;
  },
};

export interface CliStack {
  readonly catalog: Catalog;
  /** The resolved stack, in load order (empty after errors). */
  readonly packs: readonly CatalogPack[];
  readonly errors: readonly LoadError[];
  /** Whether the stack is exactly the arguments, in order (then nothing is printed). */
  readonly sameAsArgs: boolean;
}

const isPath = (token: string): boolean => /[\\/]/.test(token) || token === '.' || token === '..';

/**
 * Turn pack arguments into a stack. The catalog is every directory directly
 * under `packsDir` with a `pack.yaml`, plus each explicit directory argument
 * outside it. A token with a path separator (or a directory with a manifest
 * that is not a catalog name) is a directory; any other token is a pack's
 * directory name or namespace.
 */
export function resolveCliStack(tokens: readonly string[], packsDir: string, fs: PackFs = nodePackFs): CliStack {
  const entries: { dir: string; manifest: string | undefined }[] = [];
  const byPath = new Map<string, string>();
  for (const name of fs.subdirs(packsDir)) {
    const dir = join(packsDir, name);
    const manifest = fs.manifest(dir);
    if (manifest === undefined) continue;
    entries.push({ dir, manifest });
    byPath.set(resolve(dir), dir);
  }
  const base = buildCatalog(entries);
  let added = false;
  // Explicit directories: tokens become the catalog `dir` they name.
  const requested = tokens.map((t) => {
    const asDir = isPath(t) || (!findPack(base, t) && fs.manifest(t) !== undefined);
    if (!asDir) return t;
    const abs = resolve(t);
    const known = byPath.get(abs);
    if (known !== undefined) return known;
    const dir = normalize(t).replace(/[\\/]+$/, '') || t;
    entries.push({ dir, manifest: fs.manifest(t) });
    byPath.set(abs, dir);
    added = true;
    return dir;
  });
  const catalog = added ? buildCatalog(entries) : base;
  if (catalog.errors.length) return { catalog, packs: [], errors: catalog.errors, sameAsArgs: false };
  const r = resolveStack(catalog, requested);
  if (!r.ok) return { catalog, packs: [], errors: r.errors, sameAsArgs: false };
  const sameAsArgs = r.packs.length === requested.length && r.packs.every((p, i) => findPack(catalog, requested[i]!) === p);
  return { catalog, packs: r.packs, errors: [], sameAsArgs };
}

/** `stack: base, needs, game` (namespaces in load order). */
export function stackLine(packs: readonly CatalogPack[]): string {
  return `stack: ${packs.map((p) => p.namespace).join(', ')}`;
}

/** Resolve the pack arguments; on errors print every one and exit non-zero. Returns the pack directories. */
export function stackOrExit(args: Pick<CliArgs, 'dirs' | 'packsDir'>): string[] {
  const s = resolveCliStack(args.dirs, args.packsDir);
  if (s.errors.length) {
    for (const e of s.errors) console.error(formatError(e));
    fail(`\n${s.errors.length} error(s); packs not loaded.`);
  }
  if (!s.sameAsArgs) console.error(stackLine(s.packs));
  return s.packs.map((p) => p.dir);
}

const KIND_ORDER = { game: 0, mod: 1, library: 2 } as const;

/**
 * `npm run packs`: the catalog as an aligned table, games, then mods, then
 * libraries, each by directory. With `sort = false` the rows keep the given
 * order (a resolved stack).
 */
export function catalogTable(packs: readonly CatalogPack[], sort = true): string[] {
  const sorted = !sort ? packs : [...packs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const rows = [
    ['DIRECTORY', 'NAMESPACE', 'VERSION', 'KIND', 'DEPENDS', 'DESCRIPTION'],
    ...sorted.map((p) => [p.dir, p.namespace, p.version, p.kind, p.depends.join(', ') || '-', p.description]),
  ];
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) =>
    r
      .map((v, c) => (c === r.length - 1 ? v : v.padEnd(widths[c]!)))
      .join('  ')
      .trimEnd(),
  );
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
