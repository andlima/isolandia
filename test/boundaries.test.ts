import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
  });
}

function imports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

const NODE = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

test('src/core imports no Node built-ins, pixi.js, or spike code', () => {
  const bad: string[] = [];
  for (const f of files('src/core')) {
    for (const spec of imports(readFileSync(f, 'utf8'))) {
      const root = spec.startsWith('node:') ? spec : spec.split('/')[0]!;
      if (NODE.has(root) || spec.startsWith('pixi') || spec.includes('spike/')) bad.push(`${f}: ${spec}`);
      if (!spec.startsWith('.') && spec !== 'yaml') bad.push(`${f}: unexpected dependency ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('src/core uses no Node or DOM globals', () => {
  const globals = /\b(process|require|__dirname|Buffer|window|document|globalThis|localStorage|navigator)\b/;
  const bad: string[] = [];
  for (const f of files('src/core')) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (globals.test(code)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bad, []);
});

test('nothing in src/ imports spike code', () => {
  for (const f of files('src')) {
    for (const spec of imports(readFileSync(f, 'utf8'))) assert.ok(!spec.includes('spike'), `${f} imports ${spec}`);
  }
});

test('no genre words in src/ (the engine is genre-agnostic)', () => {
  const genre = /\b(zombie|zmb|vampire|vamp|blood|hunger|thirst|survivor|shambler|mansion|undead)\b/i;
  const bad: string[] = [];
  for (const f of files('src')) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (genre.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bad, []);
});
