import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mjs)$/.test(n) ? [p] : [];
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

const isPixi = (spec: string) => spec === 'pixi.js' || spec.startsWith('pixi.js/') || spec.startsWith('@pixi/');

test('only src/iso, src/web and spike import pixi.js', () => {
  const bad: string[] = [];
  for (const f of [...files('src'), ...files('test'), ...files('scripts')]) {
    if (/^src[\\/](iso|web)[\\/]/.test(f)) continue;
    for (const spec of imports(readFileSync(f, 'utf8'))) if (isPixi(spec)) bad.push(`${f}: ${spec}`);
  }
  assert.deepEqual(bad, []);
  // The renderer really does use Pixi (the check above is not vacuous).
  assert.ok(files('src/iso').some((f) => imports(readFileSync(f, 'utf8')).some(isPixi)));
});

test('src/iso and src/web import no spike code and no Node built-ins; src/iso imports no shell code', () => {
  const bad: string[] = [];
  for (const dir of ['src/iso', 'src/web']) {
    for (const f of files(dir)) {
      for (const spec of imports(readFileSync(f, 'utf8'))) {
        const root = spec.startsWith('node:') ? spec : spec.split('/')[0]!;
        if (spec.includes('spike')) bad.push(`${f}: imports spike code ${spec}`);
        if (NODE.has(root)) bad.push(`${f}: imports Node built-in ${spec}`);
        if (!spec.startsWith('.')) continue;
        // Relative imports: src/iso may use core and itself; src/web may also use iso.
        const target = relative('src', resolve(dirname(f), spec)).split(/[\\/]/)[0]!;
        const allowed = dir === 'src/iso' ? ['core', 'iso'] : ['core', 'iso', 'web'];
        if (!allowed.includes(target)) bad.push(`${f}: imports ${spec} (src/${target})`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
