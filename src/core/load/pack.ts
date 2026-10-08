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
  /**
   * Text files: relative path → text. YAML files are domain files; Tiled
   * `.tmj`/`.tsj` files are read only when a map references them.
   */
  readonly files: Readonly<Record<string, string>>;
  /** Relative paths of the pack's other (non-text) files (names only), for asset checks. */
  readonly otherFiles?: readonly string[];
}

export const LIST_DOMAINS = ['measurements', 'assets', 'tiles', 'archetypes', 'maps', 'systems', 'statuses', 'items', 'loot', 'behaviors', 'actions', 'recipes', 'vars', 'quests', 'journal', 'dialogues', 'factions'] as const;
export type ListDomain = (typeof LIST_DOMAINS)[number];
export const DOMAIN_KEYS: readonly string[] = [...LIST_DOMAINS, 'distributions', 'start', 'clock', 'lighting'];

/** Pack text files: YAML plus Tiled JSON maps and tilesets. */
export const TEXT_FILE_RE = /\.(ya?ml|tmj|tsj)$/;
export const TILED_FILE_RE = /\.(tmj|tsj)$/;

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

export interface RawPack extends Manifest {
  /** Non-text files shipped with the pack. */
  readonly otherFiles: ReadonlySet<string>;
  /** Tiled `.tmj`/`.tsj` text files: relative path → text. */
  readonly tiledFiles: Readonly<Record<string, string>>;
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

export const PACK_KINDS = ['game', 'mod', 'library'] as const;
export type PackKind = (typeof PACK_KINDS)[number];

const MANIFEST_FIELDS = ['namespace', 'name', 'version', 'kind', 'description', 'depends'];

/** A validated `pack.yaml`: what the loader and the catalog both need. */
export interface Manifest {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PackKind;
  readonly description: string;
  readonly depends: readonly { ns: string; src: Src }[];
  readonly manifest: SourceFile;
}

/**
 * Parse and validate a pack manifest's text. `label` names the pack in
 * errors raised before the namespace is known. Returns null when the
 * manifest is unusable; other problems are reported and defaulted.
 */
export function readManifest(label: string, text: string | undefined, sink: ErrorSink): Manifest | null {
  if (text === undefined) {
    sink.raw({ pack: label, file: MANIFEST, path: '', message: `missing pack manifest '${MANIFEST}'` });
    return null;
  }
  // Pre-parse with the label; the namespace is not known yet.
  const pre = parseFile(label, MANIFEST, text, sink);
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
    if (!MANIFEST_FIELDS.includes(k)) {
      const s = nearMiss(k, MANIFEST_FIELDS);
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
  let kind: PackKind = 'library';
  const k = m['kind'];
  if (k !== undefined && k !== null) {
    if (typeof k === 'string' && (PACK_KINDS as readonly string[]).includes(k)) kind = k as PackKind;
    else {
      const s = typeof k === 'string' ? nearMiss(k, PACK_KINDS) : null;
      sink.add(at(mroot, 'kind'), `invalid kind ${JSON.stringify(k)}${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${PACK_KINDS.join(', ')}`);
    }
  }
  const description = m['description'];
  if (description !== undefined && description !== null && typeof description !== 'string') {
    sink.add(at(mroot, 'description'), `field 'description' must be a string`);
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
    kind,
    description: typeof description === 'string' ? description : '',
    depends,
    manifest,
  };
}

function parseManifest(source: PackSource, sink: ErrorSink): RawPack | null {
  const m = readManifest(source.label, source.files[MANIFEST], sink);
  if (!m) return null;
  return {
    ...m,
    otherFiles: new Set(source.otherFiles ?? []),
    tiledFiles: Object.fromEntries(Object.entries(source.files).filter(([f]) => TILED_FILE_RE.test(f))),
    entries: { measurements: [], assets: [], tiles: [], archetypes: [], maps: [], systems: [], statuses: [], items: [], loot: [], behaviors: [], actions: [], recipes: [], vars: [], quests: [], journal: [], dialogues: [], factions: [] },
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
