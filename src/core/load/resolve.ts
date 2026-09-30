/**
 * Namespaced ids: qualification of definitions and resolution of references.
 */

import { nearMiss } from '../expr/index.ts';
import { at, formatPath, lineOf, type ErrorSink, type Src } from './errors.ts';
import { ID_RE } from './pack.ts';

export type Kind = 'measurement' | 'asset' | 'tile' | 'archetype' | 'map' | 'system' | 'status' | 'item' | 'loot' | 'behavior';

/** The namespaces a pack can see: its own first, then its direct depends. */
export interface Scope {
  readonly namespace: string;
  readonly depends: readonly string[];
}

interface Symbol {
  readonly index: number;
  readonly src: Src;
}

export type Resolved = { id: string; index: number } | { error: string };

export function splitId(id: string): [string | null, string] {
  const i = id.indexOf(':');
  return i < 0 ? [null, id] : [id.slice(0, i), id.slice(i + 1)];
}

function describeSrc(src: Src): string {
  const line = lineOf(src.source, src.path);
  return `${src.source.pack} ${src.source.file}${line !== undefined ? `:${line}` : ''} ${formatPath(src.path)}`;
}

export class SymbolTable {
  private readonly tables: Record<Kind, Map<string, Symbol>> = {
    measurement: new Map(),
    asset: new Map(),
    tile: new Map(),
    archetype: new Map(),
    map: new Map(),
    system: new Map(),
    status: new Map(),
    item: new Map(),
    loot: new Map(),
    behavior: new Map(),
  };

  /**
   * Qualify and register a definition's id. Returns the qualified id and its
   * index, or null after reporting an error.
   */
  define(kind: Kind, raw: unknown, scope: Scope, entry: Src, sink: ErrorSink): { id: string; index: number } | null {
    const src = at(entry, 'id');
    if (raw === undefined) {
      sink.add(entry, "missing required field 'id'");
      return null;
    }
    if (typeof raw !== 'string') {
      sink.add(src, `field 'id' must be a string`);
      return null;
    }
    const [ns, local] = splitId(raw);
    if ((ns !== null && !ID_RE.test(ns)) || !ID_RE.test(local)) {
      sink.add(src, `invalid id '${raw}': ids must match [a-z][a-z0-9_]* (optionally qualified as ns:id)`);
      return null;
    }
    if (ns !== null && ns !== scope.namespace) {
      sink.add(src, `id '${raw}' uses namespace '${ns}' but is defined in pack '${scope.namespace}'`);
      return null;
    }
    const id = `${scope.namespace}:${local}`;
    const table = this.tables[kind];
    const prev = table.get(id);
    if (prev) {
      sink.add(src, `duplicate ${kind} id '${id}' (first defined at ${describeSrc(prev.src)})`);
      return null;
    }
    const index = table.size;
    table.set(id, { index, src: entry });
    return { id, index };
  }

  has(kind: Kind, id: string): boolean {
    return this.tables[kind].has(id);
  }

  /** Resolve a short or qualified reference as seen from `scope`. */
  resolve(kind: Kind, ref: string, scope: Scope): Resolved {
    const table = this.tables[kind];
    const visible = [scope.namespace, ...scope.depends];
    const [ns, local] = splitId(ref);
    if ((ns !== null && !ID_RE.test(ns)) || !ID_RE.test(local)) {
      return { error: `invalid ${kind} reference '${ref}'` };
    }
    const found = (id: string): Resolved => ({ id, index: table.get(id)!.index });

    if (ns !== null) {
      if (!visible.includes(ns)) {
        return { error: `${kind} '${ref}' is in namespace '${ns}', which pack '${scope.namespace}' does not depend on` };
      }
      if (table.has(ref)) return found(ref);
      const s = nearMiss(ref, [...table.keys()].filter((k) => visible.includes(splitId(k)[0]!)));
      return { error: `unknown ${kind} '${ref}'${s ? ` (did you mean '${s}'?)` : ''}` };
    }

    const own = `${scope.namespace}:${local}`;
    if (table.has(own)) return found(own);
    const matches = scope.depends.map((d) => `${d}:${local}`).filter((id) => table.has(id));
    if (matches.length === 1) return found(matches[0]!);
    if (matches.length > 1) {
      return { error: `ambiguous ${kind} reference '${ref}': matches ${matches.join(', ')}; qualify it` };
    }
    const locals = [...table.keys()].filter((k) => visible.includes(splitId(k)[0]!)).map((k) => splitId(k)[1]);
    const s = nearMiss(local, locals);
    return { error: `unknown ${kind} '${ref}'${s ? ` (did you mean '${s}'?)` : ''}` };
  }

  /** Resolve or report at `src`. */
  ref(kind: Kind, value: unknown, scope: Scope, src: Src, sink: ErrorSink): { id: string; index: number } | null {
    if (typeof value !== 'string') {
      sink.add(src, `expected a ${kind} id (string), got ${JSON.stringify(value)}`);
      return null;
    }
    const r = this.resolve(kind, value, scope);
    if ('error' in r) {
      sink.add(src, r.error);
      return null;
    }
    return r;
  }
}
