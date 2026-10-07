/**
 * Pack stacks: a catalog of available packs (manifests only) and the
 * resolver that turns the packs a user asks for into the ordered list to
 * load, dependencies first. Platform-free: the shells supply the manifests.
 */

import { nearMiss } from '../expr/index.ts';
import { ErrorSink, type LoadError } from './errors.ts';
import { readManifest, type PackKind } from './pack.ts';

/** One available pack, as described by its manifest. */
export interface CatalogPack {
  /** Where the pack lives, as the shell named it (`town`, `packs/town`, `/abs/mods/hard`). */
  readonly dir: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PackKind;
  readonly description: string;
  /** Namespaces, as listed in the manifest. */
  readonly depends: readonly string[];
}

export interface Catalog {
  /** Usable packs, in entry order. */
  readonly packs: readonly CatalogPack[];
  /** Malformed manifests and duplicate namespaces; the other packs stay usable. */
  readonly errors: readonly LoadError[];
}

export type StackResult = { ok: true; packs: CatalogPack[] } | { ok: false; errors: LoadError[] };

/** The last segment of a pack's `dir`: the name a request can use. */
export function dirName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** Parse only the manifests of `entries` (`manifest` is the `pack.yaml` text). */
export function buildCatalog(entries: readonly { dir: string; manifest: string | undefined }[]): Catalog {
  const packs: CatalogPack[] = [];
  const errors: LoadError[] = [];
  const byNs = new Map<string, CatalogPack>();
  for (const { dir, manifest } of entries) {
    const sink = new ErrorSink();
    const m = readManifest(dir, manifest, sink);
    if (sink.count > 0 || !m) {
      // Name the directory: the namespace alone may not find the file.
      errors.push(...sink.errors.map((e) => ({ ...e, pack: dir })));
      continue;
    }
    const prev = byNs.get(m.namespace);
    if (prev) {
      errors.push({ pack: dir, file: 'pack.yaml', path: 'namespace', message: `namespace '${m.namespace}' is already used by pack directory '${prev.dir}'` });
      continue;
    }
    const pack: CatalogPack = {
      dir,
      namespace: m.namespace,
      name: m.name,
      version: m.version,
      kind: m.kind,
      description: m.description,
      depends: m.depends.map((d) => d.ns),
    };
    byNs.set(m.namespace, pack);
    packs.push(pack);
  }
  return { packs, errors };
}

/** The catalog pack a request token names: its `dir`, directory name or namespace. */
export function findPack(catalog: Catalog, token: string): CatalogPack | undefined {
  return (
    catalog.packs.find((p) => p.dir === token) ??
    catalog.packs.find((p) => dirName(p.dir) === token) ??
    catalog.packs.find((p) => p.namespace === token)
  );
}

/** Directory names of the catalog, sorted (for error messages). */
export function availableNames(catalog: Catalog): string[] {
  return catalog.packs.map((p) => dirName(p.dir)).sort();
}

/**
 * The packs to load for `requested` (directory names, dirs or namespaces):
 * every requested pack plus the transitive closure of their `depends`,
 * each once, dependencies before dependents and otherwise in request order
 * (a depth-first walk over the tokens, `depends` in listed order).
 */
export function resolveStack(catalog: Catalog, requested: readonly string[]): StackResult {
  const errors: LoadError[] = [];
  const err = (pack: string, message: string) => errors.push({ pack, file: '', path: '', message });
  const byNs = new Map(catalog.packs.map((p) => [p.namespace, p]));
  const out: CatalogPack[] = [];
  const done = new Set<string>();
  const failed = new Set<string>();
  const path: CatalogPack[] = [];

  const visit = (p: CatalogPack): void => {
    if (done.has(p.namespace) || failed.has(p.namespace)) return;
    const i = path.indexOf(p);
    if (i >= 0) {
      const cycle = [...path.slice(i), p].map((q) => q.namespace);
      err(p.namespace, `dependency cycle: ${cycle.join(' → ')}`);
      for (const q of path.slice(i)) failed.add(q.namespace);
      return;
    }
    path.push(p);
    for (const ns of p.depends) {
      const d = byNs.get(ns);
      if (!d) {
        const s = nearMiss(ns, [...byNs.keys()]);
        err(p.namespace, `pack '${p.namespace}' (${p.dir}) depends on unknown pack '${ns}'${s ? ` (did you mean '${s}'?)` : ''}`);
        failed.add(p.namespace);
      } else visit(d);
    }
    path.pop();
    if (failed.has(p.namespace)) return;
    if (p.depends.some((ns) => !done.has(ns))) {
      failed.add(p.namespace);
      return;
    }
    done.add(p.namespace);
    out.push(p);
  };

  const seen = new Set<string>();
  for (const token of requested) {
    if (seen.has(token)) continue;
    seen.add(token);
    const p = findPack(catalog, token);
    if (!p) {
      const available = availableNames(catalog);
      const s = nearMiss(token, [...available, ...catalog.packs.map((q) => q.namespace)]);
      err(token, `unknown pack '${token}'${s ? ` (did you mean '${s}'?)` : ''}; available: ${available.join(', ')}`);
      continue;
    }
    visit(p);
  }
  return errors.length ? { ok: false, errors } : { ok: true, packs: out };
}
