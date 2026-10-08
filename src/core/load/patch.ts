/**
 * Stage 2b: mods. Registers every base definition, then applies the
 * `override: true` / `remove: true` patches in pack load order, and gives the
 * surviving entries dense indices. A merged entry remembers which pack wrote
 * each top-level field, so the builders resolve that field in the writer's
 * scope and report it at the writer's location.
 */

import type { PatchDef, PatchDomain } from '../definition.ts';
import { nearMiss } from '../expr/index.ts';
import { at, lineOf, type ErrorSink, type Src } from './errors.ts';
import { ID_RE, LIST_DOMAINS, type JsonObject, type ListDomain, type RawEntry, type RawPack } from './pack.ts';
import { splitId, type Kind, type Scope, type SymbolTable } from './resolve.ts';

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
};

/** A loaded pack: its raw content, what it can see, and every pack it depends on (transitively). */
export interface LoadedPack {
  readonly raw: RawPack;
  readonly scope: Scope;
  readonly closure: ReadonlySet<string>;
}

/** An entry after patches: the merged value, plus the writer of each top-level field. */
export interface Merged {
  /** `src` is the base definition; `value` the merged fields (no `override`/`remove`). */
  readonly entry: RawEntry;
  /** Scope of the base definition's pack. */
  readonly scope: Scope;
  /** The entry that last wrote `key` (the base definition unless overridden). */
  srcOf(key: string): Src;
  /** The scope `key` resolves in: that of the pack that last wrote it. */
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
}

class Entry implements Defined {
  index = -1;
  /** Fields written by overrides (base fields are absent). A field cleared with `null` stays here. */
  readonly writers = new Map<string, Writer>();
  removedBy: string | null = null;

  constructor(
    readonly id: string,
    readonly entry: { readonly src: Src; readonly value: JsonObject },
    readonly base: LoadedPack,
  ) {}

  get scope(): Scope {
    return this.base.scope;
  }

  srcOf(key: string): Src {
    return this.writers.get(key)?.src ?? this.entry.src;
  }

  scopeOf(key: string): Scope {
    return this.writers.get(key)?.pack.scope ?? this.base.scope;
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
function where(src: Src, key?: string): string {
  const line = lineOf(src.source, key === undefined ? src.path : [...src.path, key]);
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
   * Write the patch's `keys` into `target` (`null` clears a field). A field
   * last written by an override of a pack that `pack` does not depend on
   * warns (later wins).
   */
  merge(target: Entry, value: JsonObject, keys: readonly string[], pack: LoadedPack, src: Src): void {
    for (const k of keys) {
      const prev = target.writers.get(k);
      if (prev && prev.pack !== pack && !pack.closure.has(prev.pack.scope.namespace)) {
        this.sink.warn(
          at(src, k),
          `also overridden by pack '${prev.pack.scope.namespace}' (${where(prev.src, k)}); '${pack.scope.namespace}' wins (later in load order)`,
        );
      }
      const v = value[k];
      if (v === null) delete target.entry.value[k];
      else target.entry.value[k] = v!;
      target.writers.set(k, { pack, src });
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
          const e = new Entry(d.id, { src: entry.src, value: r.value }, pack);
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
        this.merge(target, p.value, keys, p.pack, p.src);
        this.patches.push({ domain: p.domain, id: target.id, pack: ns, op: 'override', fields: keys });
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
        this.merge(base, r.value, keys, pack, entry.src);
        this.patches.push({ domain, id: null, pack: ns, op: 'override', fields: keys });
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
