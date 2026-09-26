/**
 * Node adapter: turn a pack directory into the in-memory `{ relativePath: text }`
 * map the (platform-free) loader consumes, plus the names of its other files.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { PackSource } from '../core/index.ts';

export function readPack(dir: string): PackSource {
  const files: Record<string, string> = {};
  const otherFiles: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(dir, full).split(sep).join('/');
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(name)) files[rel] = readFileSync(full, 'utf8');
      else otherFiles.push(rel);
    }
  };
  walk(dir);
  return { label: dir, files, otherFiles };
}
