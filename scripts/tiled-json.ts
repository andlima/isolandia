/**
 * Tiled JSON text as `npm run map:export` and `npm run map:edges` write it:
 * 2-space JSON with keys in insertion order, a layer's gid list one map row
 * per line, and a trailing newline (added by the caller).
 */

/** A layer's gid list, written one map row per line. */
export class Rows {
  constructor(
    readonly values: readonly number[],
    readonly width: number,
  ) {}
}

export type Out = null | boolean | number | string | Rows | Out[] | { [k: string]: Out };

/** 2-space JSON with keys in insertion order (written in Tiled's alphabetical order). */
export function format(v: Out, indent = ''): string {
  const inner = indent + '  ';
  if (v instanceof Rows) {
    if (!v.values.length) return '[]';
    const lines: string[] = [];
    for (let i = 0; i < v.values.length; i += v.width) lines.push(inner + v.values.slice(i, i + v.width).join(', '));
    return `[\n${lines.join(',\n')}\n${indent}]`;
  }
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + format(x, inner)).join(',\n')}\n${indent}]` : '[]';
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v);
    return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${format(x, inner)}`).join(',\n')}\n${indent}}` : '{}';
  }
  return JSON.stringify(v);
}
