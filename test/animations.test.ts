import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACINGS, formatError, loadPacks, renderPosition, stepProgress, walkFrame, World, type Facing, type LoadError, type PackSource } from '../src/core/index.ts';
import { fixture, loadFixture } from './helpers.ts';

// Asset `animations.walk` (docs/packs.md#assets) and the pose function the
// iso scene picks a walk frame with (docs/iso.md#facing).

const ART = [
  'a/s.svg',
  'a/se.svg',
  'a/ne.svg',
  'a/w.svg',
  'a/nw.svg',
  'a/n.png',
  ...['s', 'se', 'ne', 'w', 'nw', 'n'].flatMap((f) => [1, 2, 3, 4].map((k) => `a/${f}_walk${k}.svg`)),
  'a/x.png',
];

function withAssets(assetsYaml: string): PackSource {
  return { ...fixture({ 'assets.yaml': assetsYaml }), otherFiles: ART };
}

function errorsOf(yaml: string): readonly LoadError[] {
  const r = loadPacks([withAssets(yaml)]);
  assert.ok(!r.ok, 'expected load errors');
  return r.errors;
}

function expectError(errors: readonly LoadError[], path: string, message: RegExp): void {
  const hit = errors.find((e) => e.path === path && message.test(e.message));
  assert.ok(hit, `no error at ${path} matching ${message}; got:\n${errors.map(formatError).join('\n')}`);
  assert.equal(hit.file, 'assets.yaml');
}

function assetOf(yaml: string) {
  const r = loadPacks([withAssets(yaml)]);
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  return r.definition.assets[0]!;
}

const walkList = (f: Facing | 'n' = 's', k = 4) => `[${Array.from({ length: k }, (_, i) => `a/${f}_walk${i + 1}.svg`).join(', ')}]`;

const FIVE = `assets:
  - id: walker
    anchor: [0.5, 0.92]
    directions:
      s: a/s.svg
      se: a/se.svg
      ne: a/ne.svg
      w: a/w.svg
      nw: { file: a/nw.svg, anchor: [0.5, 0.9] }
    animations:
      walk:
        s: ${walkList('s')}
        se: ${walkList('se')}
        ne: ${walkList('ne')}
        w: ${walkList('w')}
        nw: ${walkList('nw')}
`;

// ── Loader: the happy path ──────────────────────────────────────────────────

test('animations.walk: frames are appended to images, indexed per facing, mirrored facings share their partner frames', () => {
  const a = assetOf(FIVE);
  assert.equal(a.ways, 8);
  assert.equal(a.images.length, 5 + 20, 'five standing images plus four frames per drawn facing');
  assert.deepEqual(a.images.slice(0, 5).map((i) => i.file), ['a/s.svg', 'a/se.svg', 'a/ne.svg', 'a/w.svg', 'a/nw.svg'], 'standing images stay first');
  assert.ok(a.walk);
  const walk = a.walk!;
  assert.equal(walk.length, FACINGS.length);
  const files = (f: Facing) => walk[FACINGS.indexOf(f)]!.map((i) => a.images[i]!.file);
  for (const f of ['s', 'se', 'ne', 'w', 'nw'] as Facing[]) {
    assert.deepEqual(files(f), [1, 2, 3, 4].map((k) => `a/${f}_walk${k}.svg`), f);
  }
  // Mirrored facings list their partner's frames; `byFacing` already says they are flipped.
  assert.deepEqual(files('e'), files('s'));
  assert.deepEqual(files('n'), files('w'));
  assert.deepEqual(files('sw'), files('ne'));
  assert.equal(a.byFacing[FACINGS.indexOf('e')]!.mirrored, true);
  assert.equal(a.byFacing[FACINGS.indexOf('e')]!.image, a.byFacing[FACINGS.indexOf('s')]!.image);
  // Every facing has the same frame count.
  for (const list of walk) assert.equal(list!.length, 4);
});

test('animations.walk: a frame takes its facing anchor (per-direction or the entry one), and frame files are deduplicated', () => {
  const a = assetOf(FIVE);
  const anchorsOf = (f: Facing) => a.walk![FACINGS.indexOf(f)]!.map((i) => a.images[i]!.anchor);
  for (const an of anchorsOf('s')) assert.deepEqual(an, [0.5, 0.92]);
  for (const an of anchorsOf('nw')) assert.deepEqual(an, [0.5, 0.9]);
  // The same file listed twice (and a frame equal to the standing image) is one image.
  const b = assetOf(`assets:
  - id: box
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s.svg, a/s_walk1.svg, a/s.svg, a/s_walk1.svg]
        w: [a/w_walk1.svg, a/w_walk2.svg, a/w_walk1.svg, a/w_walk2.svg]
`);
  assert.equal(b.ways, 4);
  assert.deepEqual(b.images.map((i) => i.file), ['a/s.svg', 'a/w.svg', 'a/s_walk1.svg', 'a/w_walk1.svg', 'a/w_walk2.svg']);
  assert.deepEqual(b.walk![FACINGS.indexOf('s')], [0, 2, 0, 2]);
  assert.deepEqual(b.walk![FACINGS.indexOf('w')], [3, 4, 3, 4]);
  // The diagonals of a 4-way asset have no frames, like they have no standing image.
  for (const f of ['ne', 'se', 'sw', 'nw'] as Facing[]) assert.equal(b.walk![FACINGS.indexOf(f)], null);
  assert.deepEqual(b.walk![FACINGS.indexOf('e')], [0, 2, 0, 2], 'e mirrors s');
});

test('animations: a two-frame cycle is the minimum; an asset without animations has walk null', () => {
  const a = assetOf(`assets:
  - id: box
    directions: { s: a/s.svg, w: a/w.svg }
    animations: { walk: { s: [a/s_walk1.svg, a/s_walk2.svg], w: [a/w_walk1.svg, a/w_walk2.svg] } }
`);
  assert.equal(a.walk![FACINGS.indexOf('s')]!.length, 2);
  const b = assetOf('assets:\n  - { id: box, directions: { s: a/s.svg, w: a/w.svg } }\n');
  assert.equal(b.walk, null);
  const c = assetOf('assets:\n  - { id: one, file: a/s.svg }\n');
  assert.equal(c.walk, null);
});

// ── Loader: errors ─────────────────────────────────────────────────────────

test('error: animations on a file asset', () => {
  const errors = errorsOf(`assets:
  - id: one
    file: a/s.svg
    animations: { walk: { s: [a/s_walk1.svg, a/s_walk2.svg] } }
`);
  expectError(errors, 'assets[0].animations', /^only a directional asset can have animations/);
});

test('error: unknown animation names and an empty animations mapping', () => {
  const errors = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      run: { s: [a/s_walk1.svg, a/s_walk2.svg], w: [a/w_walk1.svg, a/w_walk2.svg] }
  - id: b
    directions: { s: a/s.svg, w: a/w.svg }
    animations: {}
`);
  expectError(errors, 'assets[0].animations.run', /^unknown animation 'run': 'walk' is the only animation known$/);
  expectError(errors, 'assets[1].animations', /must list at least one animation/);
});

test('error: the walk facing set must equal the directions set, both ways', () => {
  const errors = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s_walk1.svg, a/s_walk2.svg]
        n: [a/n_walk1.svg, a/n_walk2.svg]
`);
  expectError(errors, 'assets[0].animations.walk.n', /^walk frames for 'n' but no standing image: 'directions' does not list 'n'$/);
  expectError(errors, 'assets[0].animations.walk', /^no walk frames for 'w': every facing listed in 'directions' needs a frame list$/);
});

test('error: unknown walk facing keys get the directions near-miss message', () => {
  const errors = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s_walk1.svg, a/s_walk2.svg]
        w: [a/w_walk1.svg, a/w_walk2.svg]
        north: [a/n_walk1.svg, a/n_walk2.svg]
`);
  expectError(errors, 'assets[0].animations.walk.north', /^unknown direction 'north'.*; expected one of n, ne, e, se, s, sw, w, nw$/);
  const typo = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s_walk1.svg, a/s_walk2.svg]
        ww: [a/w_walk1.svg, a/w_walk2.svg]
`);
  expectError(typo, 'assets[0].animations.walk.ww', /^unknown direction 'ww' \(did you mean '[sn]?w'\?\); expected one of/);
});

test('error: frame counts must match across facings and be even', () => {
  const differ = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s_walk1.svg, a/s_walk2.svg, a/s_walk3.svg, a/s_walk4.svg]
        w: [a/w_walk1.svg, a/w_walk2.svg]
`);
  expectError(differ, 'assets[0].animations.walk', /^walk frame counts differ: 's' has 4, 'w' has 2; every facing needs the same number of frames$/);
  const odd = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s_walk1.svg, a/s_walk2.svg, a/s_walk3.svg]
        w: [a/w_walk1.svg, a/w_walk2.svg, a/w_walk3.svg]
`);
  expectError(odd, 'assets[0].animations.walk', /^walk frame count must be even \(a cycle spans two steps\), got 3$/);
});

test('error: a walk value that is not a list of strings, or an empty list', () => {
  const errors = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: a/s_walk1.svg
        w: [a/w_walk1.svg, 3]
  - id: b
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: []
        w: [a/w_walk1.svg, a/w_walk2.svg]
  - id: c
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk: [a/s_walk1.svg]
`);
  expectError(errors, 'assets[0].animations.walk.s', /^walk frames for 's' must be a list of file paths$/);
  expectError(errors, 'assets[0].animations.walk.w', /^walk frames for 'w' must be a list of file paths$/);
  expectError(errors, 'assets[1].animations.walk.s', /must list at least one file/);
  expectError(errors, 'assets[2].animations.walk', /must map each facing to a list of frame files/);
});

test('error: frame files follow the file rules (missing with a near miss, extension)', () => {
  const errors = errorsOf(`assets:
  - id: a
    directions: { s: a/s.svg, w: a/w.svg }
    animations:
      walk:
        s: [a/s_walk1.svg, a/s_walk9.svg]
        w: [a/w_walk1.svg, a/w_walk2.txt]
`);
  expectError(errors, 'assets[0].animations.walk.s[1]', /^asset file 'a\/s_walk9\.svg' not found in pack 't' \(did you mean 'a\/s_walk1\.svg'\?\)$/);
  expectError(errors, 'assets[0].animations.walk.w[1]', /unsupported asset file 'a\/w_walk2\.txt'/);
});

test('animations do not touch the sim: same snapshot and hash with and without frames', () => {
  const plain = loadPacks([withAssets('assets:\n  - { id: walker, directions: { s: a/s.svg, w: a/w.svg } }\n')]);
  const r = loadPacks([withAssets(FIVE)]);
  assert.ok(plain.ok && r.ok);
  const a = World.create(plain.definition, 5);
  const b = World.create(r.definition, 5);
  for (let i = 0; i < 20; i++) {
    a.step();
    b.step();
  }
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.hash(), b.hash());
});

test('overrides: a mod replaces animations whole (frame files relative to its own pack) or clears it with null', () => {
  const base = withAssets(FIVE);
  const mod = (yaml: string): PackSource => ({
    label: 'mod',
    files: { 'pack.yaml': 'namespace: m\nname: Mod\nversion: 1.0.0\ndepends: [t]\n', 'mod.yaml': yaml },
    otherFiles: ['m/s_walk1.svg', 'm/s_walk2.svg', 'm/w_walk1.svg', 'm/w_walk2.svg', 'm/x_walk1.svg', 'm/x_walk2.svg', 'm/x_walk3.svg', 'm/x_walk4.svg'],
  });
  const replaced = loadPacks([base, mod(`assets:
  - id: t:walker
    override: true
    animations:
      walk:
        s: [m/x_walk1.svg, m/x_walk2.svg, m/x_walk3.svg, m/x_walk4.svg]
        se: [m/x_walk1.svg, m/x_walk2.svg, m/x_walk3.svg, m/x_walk4.svg]
        ne: [m/x_walk1.svg, m/x_walk2.svg, m/x_walk3.svg, m/x_walk4.svg]
        w: [m/x_walk1.svg, m/x_walk2.svg, m/x_walk3.svg, m/x_walk4.svg]
        nw: [m/x_walk1.svg, m/x_walk2.svg, m/x_walk3.svg, m/x_walk4.svg]
`)]);
  assert.ok(replaced.ok, replaced.ok ? '' : replaced.errors.map(formatError).join('\n'));
  const a = replaced.definition.assets[0]!;
  // The four shared frame files, once per distinct anchor (`nw` has its own), deduplicated like the standing images.
  assert.equal(a.images.length, 5 + 4 * 2);
  assert.deepEqual(a.walk![FACINGS.indexOf('s')]!.map((i) => a.images[i]!.file), ['m/x_walk1.svg', 'm/x_walk2.svg', 'm/x_walk3.svg', 'm/x_walk4.svg']);
  assert.deepEqual(a.walk![FACINGS.indexOf('se')], a.walk![FACINGS.indexOf('s')], 'same files and anchor: same images');
  assert.notDeepEqual(a.walk![FACINGS.indexOf('nw')], a.walk![FACINGS.indexOf('s')], 'a different anchor: its own images');
  assert.deepEqual(a.walk![FACINGS.indexOf('nw')]!.map((i) => a.images[i]!.anchor[1]), [0.9, 0.9, 0.9, 0.9]);
  assert.deepEqual(replaced.definition.patches.map((p) => [p.id, p.fields]), [['t:walker', ['animations']]]);
  const cleared = loadPacks([base, mod('assets:\n  - id: t:walker\n    override: true\n    animations: null\n')]);
  assert.ok(cleared.ok, cleared.ok ? '' : cleared.errors.map(formatError).join('\n'));
  assert.equal(cleared.definition.assets[0]!.walk, null);
  assert.equal(cleared.definition.assets[0]!.images.length, 5);
  // The override is validated like a fresh entry: the facing set still has to match.
  const bad = loadPacks([base, mod('assets:\n  - id: t:walker\n    override: true\n    animations: { walk: { s: [m/s_walk1.svg, m/s_walk2.svg] } }\n')]);
  assert.ok(!bad.ok);
  const hit = bad.errors.find((e) => e.pack === 'm' && e.path === 'assets[0].animations.walk' && /no walk frames for 'se'/.test(e.message));
  assert.ok(hit, bad.ok ? '' : bad.errors.map(formatError).join('\n'));
});

// ── Pose ───────────────────────────────────────────────────────────────────

test('walkFrame: the first step of a pair plays the first half of the cycle, the second step the rest', () => {
  const eps = 1e-9;
  // n = 4: frames 0, 1 on stride 0; 2, 3 on stride 1.
  assert.equal(walkFrame(0, 0, 4), 0);
  assert.equal(walkFrame(0.5 - eps, 0, 4), 0);
  assert.equal(walkFrame(0.5, 0, 4), 1);
  assert.equal(walkFrame(1 - eps, 0, 4), 1);
  assert.equal(walkFrame(0, 1, 4), 2);
  assert.equal(walkFrame(0.5 - eps, 1, 4), 2);
  assert.equal(walkFrame(0.5, 1, 4), 3);
  assert.equal(walkFrame(1 - eps, 1, 4), 3);
  // n = 2: one frame per step.
  assert.equal(walkFrame(0, 0, 2), 0);
  assert.equal(walkFrame(1 - eps, 0, 2), 0);
  assert.equal(walkFrame(0, 1, 2), 1);
  assert.equal(walkFrame(1 - eps, 1, 2), 1);
  // n = 6: three per step.
  assert.deepEqual([0, 1 / 3, 2 / 3].map((p) => walkFrame(p + eps, 0, 6)), [0, 1, 2]);
  assert.deepEqual([0, 1 / 3, 2 / 3].map((p) => walkFrame(p + eps, 1, 6)), [3, 4, 5]);
});

test('walkFrame: standing (progress 1) is null, and the result is clamped to the frame range', () => {
  for (const stride of [0, 1] as const) {
    assert.equal(walkFrame(1, stride, 4), null);
    assert.equal(walkFrame(1.5, stride, 4), null);
    assert.equal(walkFrame(1, stride, 2), null);
  }
  assert.equal(walkFrame(-0.5, 0, 4), 0, 'below 0 clamps to the first frame');
  assert.equal(walkFrame(0.999999, 1, 4), 3);
  assert.equal(walkFrame(0.5, 0, 0), null, 'no frames: standing');
});

test('stepProgress: the clamp renderPosition uses, with stepTick semantics (t ≤ 0 right after a step is issued)', () => {
  const def = loadFixture();
  const w = World.create(def, 1);
  const p = w.player;
  assert.equal(p.archetype.ticksPerStep, 2);
  // Never moved: `stepTick` 0 reads as a step at tick 0 (as for renderPosition, where `from` is the cell so nothing moves);
  // the scene shows the standing image while `from` equals the cell.
  assert.deepEqual([p.fromX, p.fromY, p.fromZ], [p.x, p.y, p.z]);
  assert.equal(stepProgress(p, 0, 0), 0);
  assert.equal(stepProgress(p, 2, 0), 1);
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(stepProgress(p, w.tick, 0.7), 1, 'standing');
  w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
  w.step();
  assert.equal(p.stepTick, w.tick, 'a step issued at tick T sets stepTick = T + 1 = the new world tick');
  assert.equal(stepProgress(p, w.tick, 0), 0);
  assert.equal(stepProgress(p, w.tick - 1, 0.5), 0, 't ≤ 0 clamps to 0');
  assert.equal(stepProgress(p, w.tick, 0.5), 0.25);
  assert.equal(stepProgress(p, w.tick, 0.999), 0.4995);
  // Every (tick, alpha) sample agrees with renderPosition's interpolation.
  for (let dt = -1; dt <= 3; dt++) {
    for (const alpha of [0, 0.25, 0.5, 0.75, 0.999]) {
      const prog = stepProgress(p, w.tick + dt, alpha);
      const r = renderPosition(p, w.tick + dt, alpha);
      assert.ok(prog >= 0 && prog <= 1);
      assert.equal(r.x, p.fromX + (p.x - p.fromX) * prog, `tick+${dt} alpha ${alpha}`);
    }
  }
  w.step();
  assert.equal(stepProgress(p, w.tick, 0), 0.5);
  assert.equal(stepProgress(p, w.tick, 0.999), 0.9995, 'the step ends just as the next one may begin');
  w.step();
  assert.equal(stepProgress(p, w.tick, 0), 1, 'standing once the step is over');
});

test('stepProgress: walking continuously never dwells at 1, so the walk cycle has no standing-frame flicker', () => {
  const w = World.create(loadFixture({ 'map.yaml': `maps:
  - id: m
    legend: { ".": { tile: floor }, "@": { tile: floor, player: true } }
    rows: ["@........."]
start: { map: m, player: hero }
` }), 1);
  const p = w.player;
  let steps = 0;
  let last = p.stepTick;
  for (let i = 0; i < 12; i++) {
    w.queueIntent({ kind: 'step', dx: 1, dy: 0 });
    w.step();
    if (p.stepTick !== last) {
      last = p.stepTick;
      steps++;
    }
    if (p.x < 9) for (const alpha of [0, 0.5, 0.999]) assert.ok(stepProgress(p, w.tick, alpha) < 1, `tick ${w.tick} alpha ${alpha}`);
  }
  assert.ok(steps >= 5, `walked ${steps} steps`);
});
