/**
 * Field-level validation helpers. Every problem is reported to the sink with
 * its key path; readers return `undefined` for missing or mistyped values so
 * later stages can keep going and surface further errors.
 */

import { nearMiss } from '../expr/index.ts';
import { at, type ErrorSink, type Src } from './errors.ts';
import type { Json, JsonObject } from './pack.ts';

const COLOR_RE = /^(#[0-9a-fA-F]{6}|[a-z_]+)$/;

function typeName(v: Json | undefined): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'list';
  return typeof v === 'object' ? 'mapping' : typeof v;
}

export class Fields {
  /**
   * `srcOf(key)` locates the entry that wrote a top-level field (an override
   * can write fields of an entry defined elsewhere); `src` by default.
   */
  constructor(
    private readonly sink: ErrorSink,
    readonly src: Src,
    readonly obj: JsonObject,
    allowed: readonly string[],
    what: string,
    private readonly srcOf: (key: string) => Src = () => src,
  ) {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) {
        const s = nearMiss(k, allowed);
        sink.add(this.at(k), `unknown ${what} field '${k}'${s ? ` (did you mean '${s}'?)` : ''}`);
      }
    }
  }

  at(key: string, ...more: (string | number)[]): Src {
    return at(this.srcOf(key), key, ...more);
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined && this.obj[key] !== null;
  }

  raw(key: string): Json | undefined {
    return this.obj[key];
  }

  /** Whether a required field is present; reports it as missing otherwise. */
  present(key: string): boolean {
    if (this.has(key)) return true;
    this.missing(key);
    return false;
  }

  private missing(key: string): undefined {
    this.sink.add(this.srcOf(key), `missing required field '${key}'`);
    return undefined;
  }

  private mistyped(key: string, expected: string): undefined {
    this.sink.add(this.at(key), `field '${key}' must be ${expected}, got ${typeName(this.obj[key])}`);
    return undefined;
  }

  string(key: string, required = true): string | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return required ? this.missing(key) : undefined;
    return typeof v === 'string' ? v : this.mistyped(key, 'a string');
  }

  number(key: string, required = true): number | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return required ? this.missing(key) : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : this.mistyped(key, 'a number');
  }

  boolean(key: string, required = true): boolean | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return required ? this.missing(key) : undefined;
    return typeof v === 'boolean' ? v : this.mistyped(key, 'a boolean (true/false)');
  }

  glyph(key = 'glyph'): string | undefined {
    const v = this.string(key);
    if (v === undefined) return undefined;
    if ([...v].length !== 1) {
      this.sink.add(this.at(key), `field '${key}' must be a single character, got ${JSON.stringify(v)}`);
      return undefined;
    }
    return v;
  }

  color(key = 'color'): string | undefined {
    const v = this.string(key);
    if (v === undefined) return undefined;
    if (!COLOR_RE.test(v)) {
      this.sink.add(this.at(key), `field '${key}' must be '#rrggbb' or a color name, got ${JSON.stringify(v)}`);
      return undefined;
    }
    return v;
  }

  list(key: string): Json[] | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return undefined;
    return Array.isArray(v) ? v : this.mistyped(key, 'a list');
  }

  mapping(key: string, required = false): JsonObject | undefined {
    const v = this.obj[key];
    if (v === undefined || v === null) return required ? this.missing(key) : undefined;
    return typeof v === 'object' && !Array.isArray(v) ? v : this.mistyped(key, 'a mapping');
  }

  stringList(key: string): string[] {
    const list = this.list(key);
    if (!list) return [];
    const out: string[] = [];
    list.forEach((v, i) => {
      if (typeof v === 'string') out.push(v);
      else this.sink.add(this.at(key, i), `entries of '${key}' must be strings, got ${typeName(v)}`);
    });
    return out;
  }
}
