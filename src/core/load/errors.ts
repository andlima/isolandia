import type { Document, LineCounter } from 'yaml';

export interface LoadError {
  /** Pack namespace (or the pack's label when the manifest is unusable). */
  readonly pack: string;
  /** File path relative to the pack root. */
  readonly file: string;
  /** YAML key path, e.g. `measurements[2].max`. Empty for whole-file errors. */
  readonly path: string;
  /** 1-based source line, when known. */
  readonly line?: number;
  readonly message: string;
}

export type KeyPath = readonly (string | number)[];

/** A parsed YAML file with enough context to locate any key path. */
export interface SourceFile {
  readonly pack: string;
  readonly file: string;
  readonly doc: Document.Parsed;
  readonly lines: LineCounter;
}

/** A location inside a source file. */
export interface Src {
  readonly source: SourceFile;
  readonly path: KeyPath;
}

export function at(src: Src, ...more: (string | number)[]): Src {
  return { source: src.source, path: [...src.path, ...more] };
}

export function formatPath(path: KeyPath): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`;
    else if (!/^[A-Za-z_][\w:]*$/.test(p)) out += `[${JSON.stringify(p)}]`;
    else out += out ? `.${p}` : p;
  }
  return out;
}

/** Line of the deepest existing node on `path`. */
export function lineOf(source: SourceFile, path: KeyPath): number | undefined {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? source.doc.contents : source.doc.getIn(path.slice(0, n), true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range) return source.lines.linePos(range[0]).line;
  }
  return undefined;
}

export function formatError(e: LoadError): string {
  const loc = e.line !== undefined ? `${e.file}:${e.line}` : e.file;
  const where = [e.pack, loc].filter(Boolean).join(' ');
  return `${where}${e.path ? ` ${e.path}` : ''}: ${e.message}`;
}

/** Accumulates errors (and non-fatal warnings) across all loader stages. */
export class ErrorSink {
  readonly errors: LoadError[] = [];
  readonly warnings: LoadError[] = [];

  warn(src: Src, message: string): void {
    this.warnings.push({
      pack: src.source.pack,
      file: src.source.file,
      path: formatPath(src.path),
      line: lineOf(src.source, src.path),
      message,
    });
  }

  add(src: Src, message: string): void {
    this.errors.push({
      pack: src.source.pack,
      file: src.source.file,
      path: formatPath(src.path),
      line: lineOf(src.source, src.path),
      message,
    });
  }

  raw(e: LoadError): void {
    this.errors.push(e);
  }

  get count(): number {
    return this.errors.length;
  }
}

export class PackLoadError extends Error {
  constructor(readonly errors: readonly LoadError[]) {
    super(`${errors.length} pack load error(s):\n${errors.map(formatError).join('\n')}`);
    this.name = 'PackLoadError';
  }
}
