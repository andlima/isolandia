/**
 * Save files on disk for the terminal shell and `npm run check -- --save`:
 * the wrapper format (`{ meta, save }`, see `docs/saves.md`); a bare
 * `SaveFile` is accepted too.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { unwrapSave, World, wrapSave, type Definition, type RestoreResult } from '../core/index.ts';

/** Default `--save-file`, in the current directory. */
export const DEFAULT_SAVE_FILE = 'isolandia-save.json';

/** Read, parse and restore a save file; I/O and JSON errors come back as restore errors. */
export function readSaveFile(def: Definition, path: string): RestoreResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, errors: [`cannot read ${path}: ${(e as Error).message}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`${path} is not valid JSON: ${(e as Error).message}`] };
  }
  return World.restore(def, unwrapSave(json).save);
}

/** Write `world` in the wrapper format; returns an error message or null. */
export function writeSaveFile(world: World, path: string, now = new Date()): string | null {
  try {
    writeFileSync(path, JSON.stringify(wrapSave(world, now.toISOString())));
    return null;
  } catch (e) {
    return `cannot write ${path}: ${(e as Error).message}`;
  }
}

/** The terminal's one-line result of a load: `Loaded <path>.` or the first error plus `(+N more)`. */
export function loadMessage(path: string, r: RestoreResult): string {
  if (r.ok) return `Loaded ${path}.${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''})` : ''}`;
  return r.errors[0]! + (r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : '');
}
