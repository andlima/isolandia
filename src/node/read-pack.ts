/**
 * Node adapter: turn a pack directory into the in-memory `{ relativePath: text }`
 * map the (platform-free) loader consumes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { PackSource } from '../core/index.ts';

export function readPack(dir: string): PackSource {
  const files: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(name)) files[relative(dir, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return { label: dir, files };
}
