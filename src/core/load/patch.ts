/**
 * Stage 2b: mods. Registers every base definition, then applies the
 * `override: true` / `remove: true` patches in pack load order, and gives the
 * surviving entries dense indices. A merged entry remembers which pack wrote
 * each top-level field, so the builders resolve that field in the writer's
 * scope and report it at the writer's location.
 */

import type { PatchDef, PatchDomain } from '../definition.ts';
import { nearMiss, SCOPE_NAMES } from '../expr/index.ts';
import { at, lineOf, type ErrorSink, type Src } from './errors.ts';
import { ID_RE, isObject, LIST_DOMAINS, type Json, type JsonObject, type ListDomain, type RawEntry, type RawPack } from './pack.ts';
import { splitId, type Kind, type Scope, type SymbolTable } from './resolve.ts';

/**
 * Fields an override may give a `{ scale, add }` term instead of a value:
 * those the parsers read as a number or a number-or-expression at the top
 * level of an entry (`test/overrides.test.ts` checks each against its parser).
 */
export const TERM_FIELDS: Partial<Record<PatchDomain, readonly string[]>> = {
  measurements: ['min', 'max', 'initial', 'rate'],
  systems: ['every'],
  actions: ['duration'],
  recipes: ['duration'],
  vars: ['initial', 'min', 'max'],
  factions: ['reputation', 'hostile_below', 'friendly_from'],
  clock: ['day_length'],
};
const TERM_KEYS = ['scale', 'add'] as const;

/** `start` sub-mappings an override merges per field instead of replacing whole. */
const DEEP_START_KEYS: readonly string[] = ['defeat', 'victory', 'simulation'];

/** A bare measurement reference as `measurements[].max` reads it (`max: max_hp`), which no term can scale. */
const BARE_REF_RE = /^([a-z][a-z0-9_]*:)?[a-z][a-z0-9_]*$/;

/** A mapping that looks like a term (`{ scale }`, `{ add }`, or both, possibly with stray keys). */
function termLike(v: Json | undefined): v is JsonObject {
  return isObject(v) && TERM_KEYS.some((k) => v[k] !== undefined);
}

/** A number as expression text the lexer reads back (no exponent; negatives in parentheses). */
function numberText(n: number): string {
  let s = String(Math.abs(n));
  if (/e/.test(s)) s = Math.abs(n).toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return n < 0 ? `(-${s})` : s;
}

/** `check --overrides` label of a term: `×2`, `+3`, `×2 +3`. */
function termLabel(scale: number, add: number): string {
  const parts: string[] = [];
  if (scale !== 1 || add === 0) parts.push(`×${String(scale)}`);
  if (add !== 0) parts.push(add < 0 ? `-${String(-add)}` : `+${String(add)}`);
  return parts.join(' ');
}

export const KIND_OF: Record<ListDomain, Kind> = {
  measurements: 'measurement',
  assets: 'asset',
  tiles: 'tile',
  archetypes: 'archetype',
  maps: 'map',
  systems: 'system',
  statuses: 'status',
  items: 'item',
  loot: 'loot',
  behaviors: 'behavior',
  actions: 'action',
  recipes: 'recipe',
  vars: 'var',
  quests: 'quest',
  journal: 'journal entry',
  dialogues: 'dialogue',
  factions: 'faction',
};

/** A loaded pack: its raw content, what it can see, and every pack it depends on (transitively). */
export interface LoadedPack {
  readonly raw: RawPack;
  readonly scope: Scope;
  readonly closure: ReadonlySet<string>;
}

/**
 * An entry after patches: the merged value, plus the writer of each top-level
 * field. `key` may be a sub-field path (`defeat.message`) where the merge
 * goes one level deeper; it falls back to the field's writer.
 */
export interface Merged {
  /** `src` is the base definition; `value` the merged fields (no `override`/`remove`). */
  readonly entry: RawEntry;
  /** Scope of the base definition's pack. */
  readonly scope: Scope;
  /** The entry that last wrote `key` (the base definition unless overridden). */
  srcOf(key: string): Src;
  /**
   * The scope `key` resolves in: that of the pack that last wrote it, or,
   * for an expression a term wrapped, that of the pack that wrote the
   * original expression.
   */
  scopeOf(key: string): Scope;
}

/** A surviving list-domain entry with its final (dense) index. */
export interface Defined extends Merged {
  readonly id: string;
  readonly index: number;
}

interface Writer {
  readonly pack: LoadedPack;
  /** The writing entry (the field sits at `at(src, key)`). */
  readonly src: Src;
  /** The scope the value resolves in when it is not the writer's (an expression a term wrapped). */
  readonly scope?: Scope;
}

class Entry implements Defined {
  index = -1;
  /** Fields (or `key.sub` paths) written by overrides (base fields are absent). A field cleared with `null` stays here. */
  readonly writers = new Map<string, Writer>();
  removedBy: string | null = null;

  constructor(
    readonly id: string,
    readonly entry: RawEntry,
    readonly base: LoadedPack,
  ) {}

  get scope(): Scope {
    return this.base.scope;
  }

  /** The override that last wrote `key`, or its parent field for a `key.sub` path; undefined when only the base wrote it. */
  writer(key: string): Writer | undefined {
    const w = this.writers.get(key);
    if (w) return w;
    const dot = key.indexOf('.');
    return dot < 0 ? undefined : this.writers.get(key.slice(0, dot));
  }

  /** A field filled in by the file's `defaults` is located at that `defaults` mapping. */
  srcOf(key: string): Src {
    return this.writer(key)?.src ?? this.entry.fieldSrc?.[key] ?? this.entry.src;
  }

  scopeOf(key: string): Scope {
    const w = this.writer(key);
    return w ? (w.scope ?? w.pack.scope) : this.base.scope;
  }
}

export interface Patched {
  readonly defined: Record<ListDomain, Defined[]>;
  readonly start: Merged | null;
  readonly clock: Merged | null;
  readonly lighting: Merged | null;
  readonly patches: PatchDef[];
}

type Op = 'define' | 'override' | 'remove';

const KEYWORDS = ['override', 'remove'] as const;

/** Where a source location is, as `file:line`. */
function where(src: Src, ...keys: string[]): string {
  const line = lineOf(src.source, [...src.path, ...keys]);
  return `${src.source.file}${line !== undefined ? `:${line}` : ''}`;
}

class Patcher {
  readonly patches: PatchDef[] = [];

  constructor(
    private readonly sink: ErrorSink,
    private readonly symbols: SymbolTable,
  ) {}

  /** The entry's operation and its value without `override`/`remove`; null after an error. */
  op(entry: RawEntry, allowRemove: boolean): { op: Op; value: JsonObject } | null {
    const flags: Record<string, boolean> = {};
    let ok = true;
    for (const k of KEYWORDS) {
      if (k === 'remove' && !allowRemove) continue;
      const v = entry.value[k];
      if (v === undefined || v === false) continue;
      if (v !== true) {
        this.sink.add(at(entry.src, k), `field '${k}' must be true or false, got ${JSON.stringify(v)}`);
        ok = false;
      } else flags[k] = true;
    }
    if (!ok) return null;
    if (flags['override'] && flags['remove']) {
      this.sink.add(at(entry.src, 'remove'), `an entry takes either 'override: true' or 'remove: true', not both`);
      return null;
    }
    const value: JsonObject = {};
    for (const [k, v] of Object.entries(entry.value)) if (!(KEYWORDS as readonly string[]).includes(k) || (k === 'remove' && !allowRemove)) value[k] = v;
    return { op: flags['override'] ? 'override' : flags['remove'] ? 'remove' : 'define', value };
  }

  /**
   * Write the patch's `keys` into `target` (`null` clears a field): a value
   * replaces the field, a `{ scale, add }` term on a numeric field rescales
   * its current value, and a `start` sub-mapping (`defeat`, `victory`,
   * `simulation`) merges per key. Returns the fields written, as
   * `check --overrides` lists them (`rate ×2`, `defeat.message`).
   */
  merge(target: Entry, domain: PatchDomain, value: JsonObject, keys: readonly string[], pack: LoadedPack, src: Src): string[] {
    const written: string[] = [];
    const termFields = TERM_FIELDS[domain] ?? [];
    for (const k of keys) {
      const v = value[k];
      if (domain === 'start' && DEEP_START_KEYS.includes(k) && isObject(v)) {
        written.push(...this.mergeDeep(target, k, v, pack, src));
        continue;
      }
      if (termFields.includes(k) && isObject(v)) {
        const label = this.applyTerm(target, domain, k, v, pack, src);
        if (label !== null) written.push(label);
        continue;
      }
      if (termLike(v)) {
        this.sink.add(at(src, k), `a term ({ scale: n } / { add: n }) is only allowed on a numeric field (${termFields.length ? termFields.join(', ') : `none for ${domain}`}), not on '${k}'`);
        continue;
      }
      this.write(target, k, v, pack, src);
      if (domain === 'start' && DEEP_START_KEYS.includes(k)) for (const w of [...target.writers.keys()]) if (w.startsWith(`${k}.`)) target.writers.delete(w);
      written.push(k);
    }
    return written;
  }

  /**
   * Set one field (or `key.sub` path) of `target`, warning when an unrelated
   * pack's override wrote it last (for a whole field, any of its sub-fields).
   */
  private write(target: Entry, key: string, v: Json | undefined, pack: LoadedPack, src: Src, scope?: Scope): void {
    let prev = target.writer(key);
    if (!prev && !key.includes('.')) for (const [k, w] of target.writers) if (k.startsWith(`${key}.`) && w.pack !== pack && !pack.closure.has(w.pack.scope.namespace)) prev = w;
    const path = key.split('.');
    if (prev && prev.pack !== pack && !pack.closure.has(prev.pack.scope.namespace)) {
      this.sink.warn(
        at(src, ...path),
        `also overridden by pack '${prev.pack.scope.namespace}' (${where(prev.src, ...path)}); '${pack.scope.namespace}' wins (later in load order)`,
      );
    }
    let obj: JsonObject = target.entry.value;
    for (const p of path.slice(0, -1)) {
      let next = obj[p];
      if (!isObject(next)) obj[p] = next = {};
      obj = next;
    }
    const last = path[path.length - 1]!;
    if (v === null || v === undefined) delete obj[last];
    else obj[last] = v;
    target.writers.set(key, scope ? { pack, src, scope } : { pack, src });
  }

  /**
   * Merge a `start` sub-mapping per key: a listed key replaces that key,
   * `null` clears one, omitted keys are kept, so an empty mapping over an
   * upstream value changes nothing (and warns).
   */
  private mergeDeep(target: Entry, key: string, v: JsonObject, pack: LoadedPack, src: Src): string[] {
    if (!isObject(target.entry.value[key])) {
      // No upstream value: the mapping is a fresh definition, located at this
      // override. Seeding it through `write` keeps the conflict warning when an
      // unrelated pack cleared (or wrote) the mapping before.
      this.write(target, key, {}, pack, src);
    } else if (Object.keys(v).length === 0) {
      this.sink.warn(at(src, key), `'${key}: {}' changes nothing: omitted keys are kept; write the keys to change, or 'null' to remove the mapping`);
    }
    const written: string[] = [];
    for (const [sub, sv] of Object.entries(v)) {
      const path = `${key}.${sub}`;
      if (termLike(sv)) {
        this.sink.add(at(src, key, sub), `a term ({ scale: n } / { add: n }) is only allowed on a numeric top-level field, not on '${path}'`);
        continue;
      }
      this.write(target, path, sv, pack, src);
      written.push(path);
    }
    return written;
  }

  /**
   * `{ scale, add }` on a numeric field: a number is folded now, an
   * expression is wrapped as text (compiled later in its original scope).
   * Returns the `check --overrides` label, or null after reporting.
   */
  private applyTerm(target: Entry, domain: PatchDomain, k: string, term: JsonObject, pack: LoadedPack, src: Src): string | null {
    const fsrc = at(src, k);
    let ok = true;
    for (const key of Object.keys(term)) {
      if ((TERM_KEYS as readonly string[]).includes(key)) continue;
      const s = nearMiss(key, TERM_KEYS);
      this.sink.add(at(fsrc, key), `a term takes only 'scale' and 'add', got '${key}'${s ? ` (did you mean '${s}'?)` : ''}`);
      ok = false;
    }
    const num = (key: 'scale' | 'add', fallback: number): number => {
      const v = term[key];
      if (v === undefined || v === null) return fallback;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      this.sink.add(at(fsrc, key), `'${key}' must be a number, got ${JSON.stringify(v)}`);
      ok = false;
      return fallback;
    };
    const scale = num('scale', 1);
    const add = num('add', 0);
    if (term['scale'] === undefined && term['add'] === undefined) {
      this.sink.add(fsrc, `a term needs 'scale' and/or 'add' (e.g. { scale: 2 })`);
      ok = false;
    }
    if (!ok) return null;
    const kind = KIND_OF[domain as ListDomain] ?? domain;
    const cur = target.entry.value[k];
    if (cur === undefined || cur === null) {
      this.sink.add(fsrc, `cannot scale '${k}' of ${kind} '${target.id}': it has no current value (the entry does not set '${k}')`);
      return null;
    }
    const label = `${k} ${termLabel(scale, add)}`;
    if (typeof cur === 'number') {
      this.write(target, k, cur * scale + add, pack, src);
      return label;
    }
    if (typeof cur === 'string') {
      if (domain === 'measurements' && k === 'max' && BARE_REF_RE.test(cur) && !(SCOPE_NAMES as readonly string[]).includes(cur)) {
        this.sink.add(fsrc, `cannot scale 'max' of measurement '${target.id}': '${cur}' is a measurement reference, not a number or an expression`);
        return null;
      }
      let text = `(${cur})`;
      if (scale !== 1) text += ` * ${numberText(scale)}`;
      if (add !== 0) text += add < 0 ? ` - ${numberText(-add)}` : ` + ${numberText(add)}`;
      this.write(target, k, text, pack, src, target.scopeOf(k));
      return label;
    }
    this.sink.add(fsrc, `cannot scale '${k}' of ${kind} '${target.id}': its current value (${JSON.stringify(cur)}) is not a number or an expression`);
    return null;
  }

  /** A definition (not an override) with a term on a numeric field: there is nothing to scale yet. */
  private noTerms(domain: PatchDomain, value: JsonObject, src: Src): void {
    for (const k of TERM_FIELDS[domain] ?? []) {
      if (termLike(value[k])) this.sink.add(at(src, k), `a term ({ scale: n } / { add: n }) is only allowed in an override (override: true): a definition has no current '${k}' to scale`);
    }
  }

  // ── List domains ──────────────────────────────────────────────────────

  listDomains(packs: readonly LoadedPack[]): Record<ListDomain, Defined[]> {
    const base = Object.fromEntries(LIST_DOMAINS.map((d) => [d, [] as Entry[]])) as Record<ListDomain, Entry[]>;
    const byId = Object.fromEntries(LIST_DOMAINS.map((d) => [d, new Map<string, Entry>()])) as Record<ListDomain, Map<string, Entry>>;
    const queued: { pack: LoadedPack; domain: ListDomain; src: Src; value: JsonObject; op: 'override' | 'remove' }[] = [];

    for (const pack of packs) {
      for (const domain of LIST_DOMAINS) {
        for (const entry of pack.raw.entries[domain]) {
          const r = this.op(entry, true);
          if (!r) continue;
          if (r.op !== 'define') {
            queued.push({ pack, domain, src: entry.src, value: r.value, op: r.op });
            continue;
          }
          const d = this.symbols.define(KIND_OF[domain], r.value['id'], pack.scope, entry.src, this.sink);
          if (!d) continue;
          this.noTerms(domain, r.value, entry.src);
          const e = new Entry(d.id, { src: entry.src, value: r.value, ...(entry.fieldSrc ? { fieldSrc: entry.fieldSrc } : {}) }, pack);
          base[domain].push(e);
          byId[domain].set(d.id, e);
        }
      }
    }

    for (const p of queued) {
      const kind = KIND_OF[p.domain];
      const target = this.target(kind, p.value['id'], p.pack, p.src, p.op, byId[p.domain]);
      if (!target) continue;
      const ns = p.pack.scope.namespace;
      if (p.op === 'override') {
        const keys = Object.keys(p.value).filter((k) => k !== 'id');
        if (keys.length === 0) this.sink.warn(p.src, `override of ${kind} '${target.id}' changes nothing`);
        const fields = this.merge(target, p.domain, p.value, keys, p.pack, p.src);
        this.patches.push({ domain: p.domain, id: target.id, pack: ns, op: 'override', fields });
      } else {
        const extra = Object.keys(p.value).filter((k) => k !== 'id');
        for (const k of extra) this.sink.add(at(p.src, k), `a removal lists only 'id' and 'remove: true', got '${k}'`);
        if (extra.length) continue;
        const others = new Map<string, Writer>();
        for (const w of target.writers.values()) {
          const q = w.pack.scope.namespace;
          if (w.pack !== p.pack && !p.pack.closure.has(q) && !others.has(q)) others.set(q, w);
        }
        for (const [q, w] of others) {
          this.sink.warn(at(p.src, 'remove'), `${kind} '${target.id}' is also overridden by pack '${q}' (${where(w.src)}); '${ns}' removes it (later in load order)`);
        }
        target.removedBy = ns;
        this.symbols.remove(kind, target.id, ns);
        this.patches.push({ domain: p.domain, id: target.id, pack: ns, op: 'remove', fields: [] });
      }
    }

    this.symbols.reindex();
    const defined = {} as Record<ListDomain, Defined[]>;
    for (const domain of LIST_DOMAINS) {
      const alive = base[domain].filter((e) => e.removedBy === null);
      alive.forEach((e, i) => (e.index = i));
      defined[domain] = alive;
    }
    return defined;
  }

  /** The entry a patch targets, after checking the id rules; null after reporting. */
  private target(kind: Kind, raw: unknown, pack: LoadedPack, src: Src, op: 'override' | 'remove', byId: ReadonlyMap<string, Entry>): Entry | null {
    const isrc = at(src, 'id');
    const self = pack.scope.namespace;
    if (raw === undefined) {
      this.sink.add(src, `missing required field 'id' (the qualified id of the ${kind} to ${op})`);
      return null;
    }
    if (typeof raw !== 'string') {
      this.sink.add(isrc, `field 'id' must be a string`);
      return null;
    }
    const [ns, local] = splitId(raw);
    if ((ns !== null && !ID_RE.test(ns)) || !ID_RE.test(local)) {
      this.sink.add(isrc, `invalid id '${raw}': ids must match [a-z][a-z0-9_]* (optionally qualified as ns:id)`);
      return null;
    }
    if (ns === null) {
      const deps = pack.scope.depends.filter((d) => byId.has(`${d}:${local}`));
      const hint = deps.length ? ` (e.g. '${deps[0]}:${local}')` : '';
      this.sink.add(isrc, `cannot ${op} '${raw}': '${op}' takes the qualified id (ns:id) of an entry of a pack '${self}' depends on${hint}`);
      return null;
    }
    if (ns === self) {
      this.sink.add(isrc, `cannot ${op} '${raw}': it is pack '${self}''s own ${kind}; edit its definition directly`);
      return null;
    }
    if (!pack.scope.depends.includes(ns)) {
      this.sink.add(isrc, `cannot ${op} '${raw}': pack '${self}' does not depend on '${ns}' (add '${ns}' to its depends)`);
      return null;
    }
    const target = byId.get(raw);
    if (target?.removedBy) {
      if (op === 'override') this.sink.add(isrc, `cannot override ${kind} '${raw}': removed by pack '${target.removedBy}'`);
      else this.sink.warn(isrc, `${kind} '${raw}' is already removed by pack '${target.removedBy}'`);
      return null;
    }
    if (!target) {
      const s = nearMiss(raw, [...byId.keys()].filter((k) => splitId(k)[0] === ns));
      this.sink.add(isrc, `cannot ${op} unknown ${kind} '${raw}'${s ? ` (did you mean '${s}'?)` : ''}`);
      return null;
    }
    return target;
  }

  // ── Singletons ────────────────────────────────────────────────────────

  singleton(domain: Exclude<PatchDomain, ListDomain>, packs: readonly LoadedPack[], entries: (p: RawPack) => readonly RawEntry[]): Merged | null {
    let base: Entry | null = null;
    for (const pack of packs) {
      const ns = pack.scope.namespace;
      for (const entry of entries(pack.raw)) {
        const r = this.op(entry, false);
        if (!r) continue;
        if (r.op === 'define') {
          if (!base) {
            this.noTerms(domain, r.value, entry.src);
            base = new Entry(domain, { src: entry.src, value: r.value }, pack);
            continue;
          }
          const s = base.entry.src;
          const hint = pack.closure.has(base.base.scope.namespace) ? `; add 'override: true' to patch it` : '';
          this.sink.add(entry.src, `duplicate '${domain}': already defined in pack '${s.source.pack}' (${s.source.file})${hint}`);
          continue;
        }
        if (!base) {
          this.sink.add(at(entry.src, 'override'), `nothing to override: no earlier pack defines '${domain}'`);
          continue;
        }
        const definer = base.base.scope.namespace;
        if (!pack.closure.has(definer)) {
          const how = definer === ns ? `it is defined by pack '${ns}' itself; edit it directly` : `pack '${ns}' does not depend on '${definer}', which defines it (add '${definer}' to its depends)`;
          this.sink.add(at(entry.src, 'override'), `cannot override '${domain}': ${how}`);
          continue;
        }
        const keys = Object.keys(r.value);
        if (keys.length === 0) this.sink.warn(entry.src, `override of '${domain}' changes nothing`);
        const fields = this.merge(base, domain, r.value, keys, pack, entry.src);
        this.patches.push({ domain, id: null, pack: ns, op: 'override', fields });
      }
    }
    return base;
  }
}

/** Register base definitions, apply every patch in load order, and index the survivors densely. */
export function applyPatches(packs: readonly LoadedPack[], symbols: SymbolTable, sink: ErrorSink): Patched {
  const p = new Patcher(sink, symbols);
  const defined = p.listDomains(packs);
  const start = p.singleton('start', packs, (r) => r.starts);
  const clock = p.singleton('clock', packs, (r) => r.clocks);
  const lighting = p.singleton('lighting', packs, (r) => r.lightings);
  // Domains are independent: list the patches in pack load order.
  const order = new Map(packs.map((k, i) => [k.scope.namespace, i]));
  const patches = p.patches.map((x, i) => ({ x, i })).sort((a, b) => order.get(a.x.pack)! - order.get(b.x.pack)! || a.i - b.i).map(({ x }) => x);
  return { defined, start, clock, lighting, patches };
}
