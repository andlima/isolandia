/**
 * Stage 1: parse a pack's YAML files (keeping line info) and collect raw
 * entries per domain key. No cross-pack knowledge here.
 */

import { LineCounter, parseDocument } from 'yaml';
import { nearMiss } from '../expr/index.ts';
import { at, type ErrorSink, type SourceFile, type Src } from './errors.ts';

/** An in-memory pack: `{ relativePath: fileText }`, produced by a platform adapter. */
export interface PackSource {
  /** Human label for errors raised before the namespace is known (e.g. the directory). */
  readonly label: string;
  /** YAML files: relative path → text. */
  readonly files: Readonly<Record<string, string>>;
  /** Relative paths of the pack's non-YAML files (names only), for asset checks. */
  readonly otherFiles?: readonly string[];
}

export const LIST_DOMAINS = ['measurements', 'assets', 'tiles', 'archetypes', 'maps', 'systems', 'statuses', 'items', 'loot'] as const;
export type ListDomain = (typeof LIST_DOMAINS)[number];
export const DOMAIN_KEYS: readonly string[] = [...LIST_DOMAINS, 'distributions', 'start', 'clock', 'lighting'];

export const ID_RE = /^[a-z][a-z0-9_]*$/;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One raw definition object from some file, with its location. */
export interface RawEntry {
  readonly src: Src;
  readonly value: JsonObject;
}

export interface RawPack {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly depends: readonly { ns: string; src: Src }[];
  readonly manifest: SourceFile;
  /** Non-YAML files shipped with the pack. */
  readonly otherFiles: ReadonlySet<string>;
  readonly entries: Record<ListDomain, RawEntry[]>;
  /** `distributions` entries (a list without ids). */
  readonly distributions: RawEntry[];
  readonly starts: RawEntry[];
  readonly clocks: RawEntry[];
  readonly lightings: RawEntry[];
}

export const MANIFEST = 'pack.yaml';

function parseFile(pack: string, file: string, text: string, sink: ErrorSink): SourceFile | null {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length) {
    for (const e of doc.errors) {
      sink.raw({
        pack,
        file,
        path: '',
        line: lines.linePos(e.pos[0]).line,
        message: `YAML syntax error: ${e.message.split('\n')[0]}`,
      });
    }
    return null;
  }
  return { pack, file, doc, lines };
}

function parseManifest(source: PackSource, sink: ErrorSink): RawPack | null {
  const text = source.files[MANIFEST];
  if (text === undefined) {
    sink.raw({ pack: source.label, file: MANIFEST, path: '', message: `missing pack manifest '${MANIFEST}'` });
    return null;
  }
  // Pre-parse with the label; the namespace is not known yet.
  const pre = parseFile(source.label, MANIFEST, text, sink);
  if (!pre) return null;
  const root: Src = { source: pre, path: [] };
  const m = pre.doc.toJS() as unknown;
  if (!isObject(m)) {
    sink.add(root, 'pack manifest must be a mapping');
    return null;
  }
  const before = sink.count;
  const ns = m['namespace'];
  if (ns === undefined) sink.add(root, "missing required field 'namespace'");
  else if (typeof ns !== 'string' || !ID_RE.test(ns)) {
    sink.add(at(root, 'namespace'), `invalid namespace ${JSON.stringify(ns)}: must match [a-z][a-z0-9_]*`);
  }
  if (sink.count > before) return null;
  const manifest: SourceFile = { ...pre, pack: ns as string };
  const mroot: Src = { source: manifest, path: [] };

  for (const k of Object.keys(m)) {
    if (!['namespace', 'name', 'version', 'depends'].includes(k)) {
      const s = nearMiss(k, ['namespace', 'name', 'version', 'depends']);
      sink.add(at(mroot, k), `unknown manifest field '${k}'${s ? ` (did you mean '${s}'?)` : ''}`);
    }
  }
  const name = m['name'];
  if (name === undefined) sink.add(mroot, "missing required field 'name'");
  else if (typeof name !== 'string') sink.add(at(mroot, 'name'), `field 'name' must be a string`);
  const version = m['version'];
  if (version === undefined) sink.add(mroot, "missing required field 'version'");
  else if (typeof version !== 'string' && typeof version !== 'number') {
    sink.add(at(mroot, 'version'), `field 'version' must be a string`);
  }
  const depends: { ns: string; src: Src }[] = [];
  const dep = m['depends'];
  if (dep !== undefined && dep !== null) {
    if (!Array.isArray(dep)) sink.add(at(mroot, 'depends'), `field 'depends' must be a list of namespaces`);
    else {
      dep.forEach((d, i) => {
        const src = at(mroot, 'depends', i);
        if (typeof d !== 'string' || !ID_RE.test(d)) sink.add(src, `invalid namespace ${JSON.stringify(d)} in depends`);
        else depends.push({ ns: d, src });
      });
    }
  }
  return {
    namespace: ns as string,
    name: typeof name === 'string' ? name : '',
    version: String(version ?? ''),
    depends,
    manifest,
    otherFiles: new Set(source.otherFiles ?? []),
    entries: { measurements: [], assets: [], tiles: [], archetypes: [], maps: [], systems: [], statuses: [], items: [], loot: [] },
    distributions: [],
    starts: [],
    clocks: [],
    lightings: [],
  };
}

/** Parse a pack's manifest and content files. Returns null if the manifest is unusable. */
export function parsePack(source: PackSource, sink: ErrorSink): RawPack | null {
  const pack = parseManifest(source, sink);
  if (!pack) return null;
  const ns = pack.namespace;

  const files = Object.keys(source.files)
    .filter((f) => f !== MANIFEST && /\.ya?ml$/.test(f))
    .sort();
  for (const file of files) {
    const sf = parseFile(ns, file, source.files[file]!, sink);
    if (!sf) continue;
    const root: Src = { source: sf, path: [] };
    const content = sf.doc.toJS() as unknown;
    if (content === null || content === undefined) continue;
    if (!isObject(content)) {
      sink.add(root, `content file must be a mapping of domain keys (${DOMAIN_KEYS.join(', ')})`);
      continue;
    }
    for (const [key, value] of Object.entries(content)) {
      const ksrc = at(root, key);
      if (key === 'start') {
        if (!isObject(value)) sink.add(ksrc, "'start' must be a mapping with 'map' and 'player'");
        else pack.starts.push({ src: ksrc, value });
        continue;
      }
      if (key === 'clock') {
        if (!isObject(value)) sink.add(ksrc, "'clock' must be a mapping (day_length, start, dawn, dusk)");
        else pack.clocks.push({ src: ksrc, value });
        continue;
      }
      if (key === 'lighting') {
        if (!isObject(value)) sink.add(ksrc, "'lighting' must be a mapping with a 'tint' list");
        else pack.lightings.push({ src: ksrc, value });
        continue;
      }
      const list = key === 'distributions' ? pack.distributions : (LIST_DOMAINS as readonly string[]).includes(key) ? pack.entries[key as ListDomain] : null;
      if (!list) {
        const s = nearMiss(key, DOMAIN_KEYS);
        sink.add(ksrc, `unknown top-level key '${key}'${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${DOMAIN_KEYS.join(', ')}`);
        continue;
      }
      if (value === null) continue;
      if (!Array.isArray(value)) {
        sink.add(ksrc, `'${key}' must be a list`);
        continue;
      }
      value.forEach((v, i) => {
        if (!isObject(v)) sink.add(at(ksrc, i), `each entry in '${key}' must be a mapping`);
        else list.push({ src: at(ksrc, i), value: v });
      });
    }
  }
  return pack;
}
