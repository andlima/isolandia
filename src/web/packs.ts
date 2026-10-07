/**
 * Browser pack sources. `main.ts` hands over Vite's `import.meta.glob`
 * results (YAML and Tiled `.tmj`/`.tsj` as raw text, every other pack file
 * as a URL); these pure
 * functions turn them into loader `PackSource`s and asset URLs.
 */

import { buildCatalog, MANIFEST, nearMiss, TEXT_FILE_RE, type AssetDef, type Catalog, type LoadError, type PackSource } from '../core/index.ts';

/** Glob results keyed by project path, e.g. `/packs/std/tiles.yaml`. */
export type GlobMap = Readonly<Record<string, string>>;

export interface WebPacks {
  /** One source per requested pack, in the requested order. */
  readonly sources: PackSource[];
  /** Per source (same order): pack-relative file → URL. */
  readonly urls: Readonly<Record<string, string>>[];
  /** Unknown pack names, as load errors. */
  readonly errors: LoadError[];
}

const PACK_PATH = /^\/?packs\/([^/]+)\/(.+)$/;

function split(path: string): [string, string] | null {
  const m = PACK_PATH.exec(path);
  return m ? [m[1]!, m[2]!] : null;
}

/** `pack.yaml` text of each pack directory in the glob results (`packs/<dir>/pack.yaml`), by directory. */
function manifests(text: GlobMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, value] of Object.entries(text)) {
    const s = split(path);
    if (s && s[1] === MANIFEST) out.set(s[0], value);
  }
  return out;
}

/** Pack directory names present in the glob results (those with a `pack.yaml`), sorted. */
export function availablePacks(text: GlobMap): string[] {
  return [...manifests(text).keys()].sort();
}

/** The catalog of the bundled packs; each pack's `dir` is its directory name under `packs/`. */
export function webCatalog(text: GlobMap): Catalog {
  return buildCatalog(
    [...manifests(text)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([dir, manifest]) => ({ dir, manifest })),
  );
}

/**
 * `text`: YAML and Tiled files as raw text; `files`: every pack file as a URL
 * (text files are skipped). `names` are pack directories, in load order (a
 * resolved stack).
 */
export function buildPackSources(text: GlobMap, files: GlobMap, names: readonly string[]): WebPacks {
  const available = availablePacks(text);
  const sources: PackSource[] = [];
  const urls: Record<string, string>[] = [];
  const errors: LoadError[] = [];
  for (const name of names) {
    if (!available.includes(name)) {
      const s = nearMiss(name, available);
      errors.push({
        pack: name,
        file: '',
        path: '',
        message: `unknown pack '${name}'${s ? ` (did you mean '${s}'?)` : ''}; available: ${available.join(', ')}`,
      });
      continue;
    }
    const own: Record<string, string> = {};
    const other: Record<string, string> = {};
    for (const [path, value] of Object.entries(text)) {
      const s = split(path);
      if (s && s[0] === name && TEXT_FILE_RE.test(s[1])) own[s[1]] = value;
    }
    for (const [path, value] of Object.entries(files)) {
      const s = split(path);
      if (s && s[0] === name && !TEXT_FILE_RE.test(s[1])) other[s[1]] = value;
    }
    sources.push({ label: `packs/${name}`, files: own, otherFiles: Object.keys(other).sort() });
    urls.push(other);
  }
  return { sources, urls, errors };
}

/**
 * URL for each image of each asset (`result[asset][image]`, aligned with
 * `assets` and `AssetDef.images`). `namespaces[i]` is the namespace of the
 * pack loaded from `urls[i]` — after a successful load, `definition.packs`
 * lists them in source order.
 */
export function assetUrls(
  assets: readonly AssetDef[],
  namespaces: readonly string[],
  urls: readonly Readonly<Record<string, string>>[],
): (string | null)[][] {
  return assets.map((a) => {
    const i = namespaces.indexOf(a.pack);
    return a.images.map((im) => (i >= 0 ? urls[i]?.[im.file] : undefined) ?? null);
  });
}
