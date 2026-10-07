import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCatalog, formatError, loadPacks, resolveStack, type Catalog, type LoadError } from '../src/core/index.ts';
import { catalogTable, resolveCliStack, stackLine, type PackFs } from '../src/cli/common.ts';
import { readPack } from '../src/node/read-pack.ts';
import { GAMES, pack } from './helpers.ts';

const m = (ns: string, extra = ''): string => `namespace: ${ns}\nname: ${ns.toUpperCase()}\nversion: 1\n${extra}`;

/** The shipped catalog, as the CLI and the browser see it (directory names). */
const SHIPPED: Catalog = buildCatalog(
  readdirSync('packs')
    .filter((dir) => existsSync(join('packs', dir, 'pack.yaml')))
    .sort()
    .map((dir) => ({ dir, manifest: readFileSync(join('packs', dir, 'pack.yaml'), 'utf8') })),
);

const ns = (r: ReturnType<typeof resolveStack>): string[] => {
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.packs.map((p) => p.namespace);
};
const messages = (r: ReturnType<typeof resolveStack>): string[] => {
  assert.ok(!r.ok, 'expected errors');
  return r.errors.map((e) => e.message);
};

// ── Catalog ────────────────────────────────────────────────────────────────

test('catalog: records from the shipped manifests, with kind and description', () => {
  assert.deepEqual(SHIPPED.errors, []);
  assert.deepEqual(
    SHIPPED.packs.map((p) => [p.dir, p.namespace, p.kind, p.depends.join(',')]),
    [
      ['garden', 'gdn', 'game', 'std'],
      ['hardship', 'hardship', 'mod', 'std_needs,town'],
      ['std', 'std', 'library', ''],
      ['std-needs', 'std_needs', 'library', 'std'],
      ['town', 'town', 'game', 'std,std_needs'],
      ['vampire', 'vamp', 'mod', 'std,town'],
      ['zombie', 'zmb', 'mod', 'std,std_needs,town'],
    ],
  );
  const zmb = SHIPPED.packs.find((p) => p.namespace === 'zmb')!;
  assert.equal(zmb.name, 'Zombie Town');
  assert.equal(zmb.version, '0.2.0');
  assert.ok(zmb.description.length > 0);
});

test('catalog: kind defaults to library and description to empty', () => {
  const c = buildCatalog([{ dir: 'a', manifest: m('a') }]);
  assert.deepEqual(c.errors, []);
  assert.equal(c.packs[0]!.kind, 'library');
  assert.equal(c.packs[0]!.description, '');
});

test('catalog: duplicate namespace, bad kind and malformed manifests are errors; the rest stays usable', () => {
  const c = buildCatalog([
    { dir: 'a', manifest: m('a') },
    { dir: 'a2', manifest: m('a') },
    { dir: 'k', manifest: m('k', 'kind: gmae\n') },
    { dir: 'd', manifest: m('d', 'description: [1]\n') },
    { dir: 'bad', manifest: 'namespace: [\n' },
    { dir: 'nons', manifest: 'name: X\nversion: 1\n' },
    { dir: 'none', manifest: undefined },
    { dir: 'b', manifest: m('b', 'kind: mod\ndepends: [a]\n') },
  ]);
  assert.deepEqual(
    c.packs.map((p) => p.dir),
    ['a', 'b'],
  );
  const byDir = (dir: string): LoadError[] => c.errors.filter((e) => e.pack === dir);
  assert.match(byDir('a2')[0]!.message, /namespace 'a' is already used by pack directory 'a'/);
  assert.match(byDir('k')[0]!.message, /invalid kind "gmae" \(did you mean 'game'\?\); expected one of game, mod, library/);
  assert.equal(byDir('k')[0]!.path, 'kind');
  assert.match(byDir('d')[0]!.message, /field 'description' must be a string/);
  assert.match(byDir('bad')[0]!.message, /YAML syntax error/);
  assert.match(byDir('nons')[0]!.message, /missing required field 'namespace'/);
  assert.match(byDir('none')[0]!.message, /missing pack manifest/);
  assert.equal(c.errors.length, 6);
});

test('loader: bad kind is a load error too (shared manifest validation)', () => {
  const r = loadPacks([pack('p', { 'pack.yaml': m('p', 'kind: library\n') }), pack('q', { 'pack.yaml': m('q', 'kind: plugin\n') })]);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.pack === 'q' && /invalid kind "plugin"/.test(e.message)));
});

// ── Resolver ──────────────────────────────────────────────────────────────

test('resolver: a game pulls in its dependencies, in order', () => {
  assert.deepEqual(ns(resolveStack(SHIPPED, ['town'])), ['std', 'std_needs', 'town']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['zombie'])), ['std', 'std_needs', 'town', 'zmb']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['zmb'])), ['std', 'std_needs', 'town', 'zmb']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['vampire'])), ['std', 'std_needs', 'town', 'vamp']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['zombie', 'hardship'])), ['std', 'std_needs', 'town', 'zmb', 'hardship']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['vampire', 'zombie'])), ['std', 'std_needs', 'town', 'vamp', 'zmb']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['std-needs'])), ['std', 'std_needs']);
  assert.deepEqual(ns(resolveStack(SHIPPED, ['std_needs'])), ['std', 'std_needs']);
});

test('resolver: every explicit stack used in the repo resolves to itself', () => {
  const stacks = [
    ...Object.values(GAMES).map((dirs) => dirs.map((d) => d.replace('packs/', ''))),
    ['std', 'std-needs', 'town', 'zombie'],
    ['std', 'std-needs', 'town', 'vampire'],
    ['std', 'std-needs', 'town', 'zombie', 'hardship'],
    ['std', 'garden'],
    ['std', 'std-needs'],
    ['std'],
  ];
  for (const s of stacks) {
    const r = resolveStack(SHIPPED, s);
    assert.ok(r.ok);
    assert.deepEqual(
      r.packs.map((p) => p.dir),
      s,
    );
  }
});

const MODS = buildCatalog([
  { dir: 'base', manifest: m('base') },
  { dir: 'game', manifest: m('game', 'kind: game\ndepends: [base]\n') },
  { dir: 'hardmode', manifest: m('hard', 'kind: mod\ndepends: [game]\n') },
  { dir: 'extra', manifest: m('extra', 'kind: mod\ndepends: [base]\n') },
  { dir: 'both', manifest: m('both', 'kind: mod\ndepends: [extra, hard]\n') },
]);

test('resolver: mods after what they need; unrelated packs in request order', () => {
  assert.deepEqual(ns(resolveStack(MODS, ['game', 'hardmode'])), ['base', 'game', 'hard']);
  assert.deepEqual(ns(resolveStack(MODS, ['hardmode'])), ['base', 'game', 'hard']);
  assert.deepEqual(ns(resolveStack(MODS, ['game', 'hardmode', 'extra'])), ['base', 'game', 'hard', 'extra']);
  assert.deepEqual(ns(resolveStack(MODS, ['game', 'extra', 'hardmode'])), ['base', 'game', 'extra', 'hard']);
  assert.deepEqual(ns(resolveStack(MODS, ['extra', 'game'])), ['base', 'extra', 'game']);
  assert.deepEqual(ns(resolveStack(MODS, ['both'])), ['base', 'extra', 'game', 'hard', 'both']);
  // Out-of-order requests are fixed: dependencies first.
  assert.deepEqual(ns(resolveStack(MODS, ['hardmode', 'base'])), ['base', 'game', 'hard']);
});

test('resolver: duplicate tokens collapse to the first occurrence', () => {
  assert.deepEqual(ns(resolveStack(MODS, ['game', 'extra', 'game', 'base', 'extra'])), ['base', 'game', 'extra']);
  assert.deepEqual(ns(resolveStack(MODS, ['hard', 'hardmode'])), ['base', 'game', 'hard']);
});

test('resolver: unknown token with a suggestion and the available packs', () => {
  assert.deepEqual(messages(resolveStack(MODS, ['gmae', 'zzz'])), [
    "unknown pack 'gmae' (did you mean 'game'?); available: base, both, extra, game, hardmode",
    "unknown pack 'zzz'; available: base, both, extra, game, hardmode",
  ]);
});

test('resolver: dependency cycles and unknown depends are errors', () => {
  const cyc = buildCatalog([
    { dir: 'a', manifest: m('a', 'depends: [b]\n') },
    { dir: 'b', manifest: m('b', 'depends: [a]\n') },
    { dir: 'c', manifest: m('c', 'depends: [c]\n') },
  ]);
  assert.deepEqual(messages(resolveStack(cyc, ['a'])), ['dependency cycle: a → b → a']);
  assert.deepEqual(messages(resolveStack(cyc, ['a', 'b'])), ['dependency cycle: a → b → a']);
  assert.deepEqual(messages(resolveStack(cyc, ['c'])), ['dependency cycle: c → c']);

  const unk = buildCatalog([
    { dir: 'base', manifest: m('base') },
    { dir: 'm', manifest: m('mm', 'depends: [base, bsae, nothing]\n') },
    { dir: 'n', manifest: m('n', 'depends: [mm]\n') },
  ]);
  const r = resolveStack(unk, ['n']);
  assert.ok(!r.ok);
  assert.deepEqual(
    r.errors.map((e) => [e.pack, e.message]),
    [
      ['mm', "pack 'mm' (m) depends on unknown pack 'bsae' (did you mean 'base'?)"],
      ['mm', "pack 'mm' (m) depends on unknown pack 'nothing'"],
    ],
  );
});

// ── Kind checks (loader, whole stack) ──────────────────────────────────────

const TILES = 'tiles:\n  - { id: floor, label: F, glyph: ".", color: white, walkable: true }\n';
const GAME_FILES = `archetypes:
  - { id: p, label: P, glyph: p, color: red }
maps:
  - { id: m, legend: { ".": { tile: floor, player: true } }, rows: ["."] }
`;

test('kind: a game must define a base start; a start override does not count', () => {
  const base = pack('base', { 'pack.yaml': m('base'), 't.yaml': TILES + GAME_FILES + 'start: { map: m, player: p }\n' });
  const ok = loadPacks([pack('g', { 'pack.yaml': m('g', 'kind: game\n'), 't.yaml': TILES + GAME_FILES + 'start: { map: m, player: p }\n' })]);
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.map(formatError).join('\n'));
  assert.equal(ok.definition.packs[0]!.kind, 'game');

  const r = loadPacks([base, pack('g', { 'pack.yaml': m('g', 'kind: game\ndepends: [base]\n'), 's.yaml': 'start: { override: true, map: base:m }\n' })]);
  assert.ok(!r.ok);
  const e = r.errors.find((x) => /is a game but defines no base 'start'/.test(x.message));
  assert.ok(e, r.errors.map(formatError).join('\n'));
  assert.equal(e.pack, 'g');
  assert.equal(e.file, 'pack.yaml');

  const lib = loadPacks([base, pack('l', { 'pack.yaml': m('l', 'depends: [base]\n') })]);
  assert.ok(lib.ok, 'libraries are not checked');
});

test('kind: a mod must list depends', () => {
  const r = loadPacks([pack('x', { 'pack.yaml': m('x', 'kind: mod\n'), 't.yaml': TILES + GAME_FILES + 'start: { map: m, player: p }\n' })]);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.pack === 'x' && /is a mod but has no 'depends'/.test(e.message)));
});

test('kind: PackInfo carries kind and description; shipped stacks load as before', () => {
  const r = loadPacks(GAMES.zombie.map(readPack));
  assert.ok(r.ok);
  assert.deepEqual(
    r.definition.packs.map((p) => [p.namespace, p.kind]),
    [
      ['std', 'library'],
      ['std_needs', 'library'],
      ['town', 'game'],
      ['zmb', 'mod'],
    ],
  );
  assert.ok(r.definition.packs.every((p) => typeof p.description === 'string' && p.description.length > 0));
});

// ── CLI argument resolver ─────────────────────────────────────────────────

/** A fake file system: pack dir → manifest. */
function fakeFs(packs: Record<string, string>): PackFs {
  return {
    subdirs: (dir) =>
      [
        ...new Set(
          Object.keys(packs)
            .filter((p) => p.startsWith(`${dir}/`))
            .map((p) => p.slice(dir.length + 1).split('/')[0]!),
        ),
      ].sort(),
    manifest: (dir) => packs[dir.replace(/\/+$/, '')],
  };
}

const FS = fakeFs({
  'packs/std': m('std', 'kind: library\n'),
  'packs/std-needs': m('std_needs', 'depends: [std]\n'),
  'packs/zombie': m('zmb', 'kind: game\ndepends: [std, std_needs]\n'),
  'mods/hardmode': m('hard', 'kind: mod\ndepends: [zmb]\n'),
  'alt/std': m('std'),
  'alt/garden': m('gdn', 'kind: game\ndepends: [std]\n'),
});

test('cli stack: names, namespaces and directories mixed', () => {
  const s = resolveCliStack(['zombie'], 'packs', FS);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(
    s.packs.map((p) => p.dir),
    ['packs/std', 'packs/std-needs', 'packs/zombie'],
  );
  assert.equal(s.sameAsArgs, false);
  assert.equal(stackLine(s.packs), 'stack: std, std_needs, zmb');

  const full = resolveCliStack(['packs/std', 'packs/std-needs', 'packs/zombie'], 'packs', FS);
  assert.deepEqual(
    full.packs.map((p) => p.dir),
    ['packs/std', 'packs/std-needs', 'packs/zombie'],
  );
  assert.equal(full.sameAsArgs, true, 'today’s explicit lists print no stack line');

  const names = resolveCliStack(['std', 'std_needs', 'zmb'], 'packs', FS);
  assert.equal(names.sameAsArgs, true);

  const mixed = resolveCliStack(['packs/zombie/', 'mods/hardmode'], 'packs', FS);
  assert.deepEqual(mixed.errors, []);
  assert.deepEqual(
    mixed.packs.map((p) => p.dir),
    ['packs/std', 'packs/std-needs', 'packs/zombie', 'mods/hardmode'],
  );
});

test('cli stack: --packs-dir replaces packs/ as the catalog root', () => {
  const s = resolveCliStack(['garden'], 'alt', FS);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(
    s.packs.map((p) => p.dir),
    ['alt/std', 'alt/garden'],
  );
  const missing = resolveCliStack(['zombie'], 'alt', FS);
  assert.deepEqual(
    missing.errors.map((e) => e.message),
    ["unknown pack 'zombie'; available: garden, std"],
  );
});

test('cli stack: catalog and resolver errors', () => {
  // An explicit directory outside the root whose namespace is taken.
  const dup = resolveCliStack(['alt/std'], 'packs', FS);
  assert.match(dup.errors[0]!.message, /namespace 'std' is already used by pack directory 'packs\/std'/);
  const unknown = resolveCliStack(['zmbie'], 'packs', FS);
  assert.deepEqual(
    unknown.errors.map((e) => e.message),
    ["unknown pack 'zmbie' (did you mean 'zombie'?); available: std, std-needs, zombie"],
  );
  const noDir = resolveCliStack(['nowhere/pack'], 'packs', FS);
  assert.match(noDir.errors[0]!.message, /missing pack manifest/);
  assert.equal(noDir.errors[0]!.pack, 'nowhere/pack');
});

test('cli: packs table, games then mods then libraries, each by directory', () => {
  const s = resolveCliStack(['mods/hardmode'], 'packs', FS);
  const lines = catalogTable(s.catalog.packs);
  assert.match(lines[0]!, /^DIRECTORY\s+NAMESPACE\s+VERSION\s+KIND\s+DEPENDS\s+DESCRIPTION$/);
  assert.deepEqual(
    lines.slice(1).map((l) => l.split(/\s+/)[0]),
    ['packs/zombie', 'mods/hardmode', 'packs/std', 'packs/std-needs'],
  );
  assert.deepEqual(
    catalogTable(s.packs, false)
      .slice(1)
      .map((l) => l.split(/\s+/)[0]),
    ['packs/std', 'packs/std-needs', 'packs/zombie', 'mods/hardmode'],
  );
});
