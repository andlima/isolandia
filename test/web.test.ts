import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hudModel, loadPacks, resolveStack, World } from '../src/core/index.ts';
import { CameraRig } from '../src/iso/camera.ts';
import { cameraAt, isoToScreen } from '../src/iso/projection.ts';
import { errorReport } from '../src/web/errors.ts';
import { Gestures, LONG_PRESS_MS } from '../src/web/gestures.ts';
import { HOLD_MS, heldDirection, MoveKeys } from '../src/web/keys.ts';
import { FixedTickLoop } from '../src/web/loop.ts';
import { assetUrls, availablePacks, buildPackSources, webCatalog } from '../src/web/packs.ts';
import { parseParams } from '../src/web/params.ts';
import { pickerModel } from '../src/web/picker.ts';
import { exportFileName, slotKey } from '../src/web/saves.ts';
import { readPack } from '../src/node/read-pack.ts';
import { loadFixture } from './helpers.ts';

// ── Pack sources from Vite globs ───────────────────────────────────────────

const YAML = {
  '/packs/base/pack.yaml': 'namespace: base\nname: Base\nversion: 1\n',
  '/packs/base/tiles.yaml': 'tiles:\n  - { id: floor, label: F, glyph: ".", color: white, walkable: true, sprite: floor_img }\n',
  '/packs/base/art/assets.yml': 'assets:\n  - { id: floor_img, file: art/floor.svg }\n',
  '/packs/game/pack.yaml': 'namespace: game\nname: Game\nversion: 1\ndepends: [base]\n',
  '/packs/game/m.yaml': `archetypes:
  - { id: p, label: P, glyph: p, color: red, sprite: p_img }
assets:
  - { id: p_img, file: p.png }
maps:
  - { id: m, legend: { ".": { tile: floor, player: true } }, rows: ["."] }
start: { map: m, player: p }
`,
  '/packs/other/pack.yaml': 'namespace: other\nname: O\nversion: 1\n',
};
const FILES = {
  '/packs/base/pack.yaml': '/assets/pack-1.yaml',
  '/packs/base/art/floor.svg': 'data:image/svg+xml,floor',
  '/packs/base/README.md': '/assets/README-2.md',
  '/packs/game/p.png': '/assets/p-3.png',
};

test('web packs: glob results → ordered PackSources with YAML text and other file names', () => {
  assert.deepEqual(availablePacks(YAML), ['base', 'game', 'other']);
  const w = buildPackSources(YAML, FILES, ['base', 'game']);
  assert.deepEqual(w.errors, []);
  assert.deepEqual(
    w.sources.map((s) => s.label),
    ['packs/base', 'packs/game'],
  );
  assert.deepEqual(Object.keys(w.sources[0]!.files).sort(), ['art/assets.yml', 'pack.yaml', 'tiles.yaml']);
  assert.deepEqual(w.sources[0]!.otherFiles, ['README.md', 'art/floor.svg']);
  assert.deepEqual(w.sources[1]!.otherFiles, ['p.png']);
  assert.deepEqual(w.urls[0], { 'art/floor.svg': 'data:image/svg+xml,floor', 'README.md': '/assets/README-2.md' });

  const r = loadPacks(w.sources);
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.errors));
  const urls = assetUrls(
    r.definition.assets,
    r.definition.packs.map((p) => p.namespace),
    w.urls,
  );
  assert.deepEqual(urls, [['data:image/svg+xml,floor'], ['/assets/p-3.png']]);
  assert.deepEqual(assetUrls(r.definition.assets, ['nope'], w.urls), [[null], [null]]);
});

test('web packs: unknown pack names are reported like load errors', () => {
  const w = buildPackSources(YAML, FILES, ['base', 'gmae', 'zzz']);
  assert.equal(w.sources.length, 1);
  assert.deepEqual(
    w.errors.map((e) => e.message),
    ["unknown pack 'gmae' (did you mean 'game'?); available: base, game, other", "unknown pack 'zzz'; available: base, game, other"],
  );
  assert.equal(
    errorReport(w.errors),
    "gmae: unknown pack 'gmae' (did you mean 'game'?); available: base, game, other\nzzz: unknown pack 'zzz'; available: base, game, other\n\n2 error(s); packs not loaded.",
  );
});

test('web packs: Tiled .tmj/.tsj files come in as text, not as asset URLs', () => {
  const text = { ...YAML, '/packs/base/maps/m.tmj': '{"width":1}', '/packs/base/maps/m.tsj': '{"tiles":[]}', '/packs/tiled-only/x.tmj': '{}' };
  const files = { ...FILES, '/packs/base/maps/m.tmj': '/assets/m.tmj', '/packs/base/maps/m.tsj': '/assets/m.tsj' };
  assert.deepEqual(availablePacks(text), ['base', 'game', 'other']);
  const w = buildPackSources(text, files, ['base']);
  assert.equal(w.sources[0]!.files['maps/m.tmj'], '{"width":1}');
  assert.equal(w.sources[0]!.files['maps/m.tsj'], '{"tiles":[]}');
  assert.deepEqual(w.sources[0]!.otherFiles, ['README.md', 'art/floor.svg']);
  assert.equal(w.urls[0]!['maps/m.tmj'], undefined);
});

test('web packs: equivalent to the Node reader for the real packs', () => {
  const node = readPack('packs/town');
  assert.ok(Object.keys(node.files).some((f) => f.endsWith('.tmj')));
  const yaml = Object.fromEntries(Object.entries(node.files).map(([f, t]) => [`/packs/town/${f}`, t]));
  const files = Object.fromEntries((node.otherFiles ?? []).map((f) => [`/packs/town/${f}`, `/u/${f}`]));
  const w = buildPackSources(yaml, files, ['town']);
  assert.deepEqual(w.sources[0]!.files, node.files);
  assert.deepEqual(w.sources[0]!.otherFiles, node.otherFiles);
});

// ── Query params ───────────────────────────────────────────────────────────

test('params: packs list, seed, title screen and errors', () => {
  assert.deepEqual(parseParams(''), { packs: null, seed: 1, errors: [] });
  assert.deepEqual(parseParams('?seed=3'), { packs: null, seed: 3, errors: [] });
  assert.deepEqual(parseParams('?packs=base,%20other&seed=42'), { packs: ['base', 'other'], seed: 42, errors: [] });
  assert.deepEqual(parseParams('?seed=abc').errors, ["?seed= expects an integer, got 'abc'"]);
  assert.equal(parseParams('?packs=').errors.length, 1);
});

// ── Stacks and the title screen ────────────────────────────────────────────

/** Glob-shaped manifests of a small pack set with mods. */
const STACK_YAML = {
  '/packs/base/pack.yaml': 'namespace: base\nname: Base\nversion: 1\n',
  '/packs/base/tiles.yaml': 'tiles: []\n',
  '/packs/game/pack.yaml': 'namespace: game\nname: Game\nversion: 1\nkind: game\ndescription: A game.\ndepends: [base]\n',
  '/packs/other/pack.yaml': 'namespace: oth\nname: Other\nversion: 1\nkind: game\ndepends: [base]\n',
  '/packs/hardmode/pack.yaml': 'namespace: hard\nname: Hard mode\nversion: 1\nkind: mod\ndescription: Harder.\ndepends: [game]\n',
  '/packs/extra/pack.yaml': 'namespace: extra\nname: Extra\nversion: 1\nkind: mod\ndepends: [base]\n',
  '/packs/broken/pack.yaml': 'namespace: broken\nname: Broken\nversion: 1\nkind: mod\ndepends: [nothing]\n',
  '/packs/tiled-only/x.tmj': '{}',
};

test('web catalog: from the glob manifests; ?packs= tokens resolve with the shared resolver', () => {
  const c = webCatalog(STACK_YAML);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(
    c.packs.map((p) => p.dir),
    ['base', 'broken', 'extra', 'game', 'hardmode', 'other'],
  );
  const r = resolveStack(c, ['hardmode', 'extra']);
  assert.ok(r.ok);
  assert.deepEqual(
    r.packs.map((p) => p.dir),
    ['base', 'game', 'hardmode', 'extra'],
  );
  const bad = webCatalog({ ...STACK_YAML, '/packs/dup/pack.yaml': 'namespace: base\nname: B\nversion: 1\n' });
  assert.match(bad.errors[0]!.message, /namespace 'base' is already used/);
});

test('web catalog: the real packs resolve short stacks', () => {
  const text: Record<string, string> = {};
  for (const dir of ['std', 'std-needs', 'town', 'zombie', 'vampire', 'hardship', 'garden']) text[`/packs/${dir}/pack.yaml`] = readPack(`packs/${dir}`).files['pack.yaml']!;
  const c = webCatalog(text);
  const r = resolveStack(c, ['zombie']);
  assert.ok(r.ok);
  assert.deepEqual(
    r.packs.map((p) => p.dir),
    ['std', 'std-needs', 'town', 'zombie'],
  );
  const v = resolveStack(c, ['vampire', 'hardship']);
  assert.ok(v.ok);
  assert.deepEqual(
    v.packs.map((p) => p.dir),
    ['std', 'std-needs', 'town', 'vampire', 'hardship'],
  );
});

test('saves: a short and a full request share slot keys and export names', () => {
  const text: Record<string, string> = {};
  for (const dir of ['std', 'std-needs', 'town', 'zombie']) text[`/packs/${dir}/pack.yaml`] = readPack(`packs/${dir}`).files['pack.yaml']!;
  const c = webCatalog(text);
  const dirs = (tokens: string[]) => {
    const r = resolveStack(c, tokens);
    assert.ok(r.ok);
    return r.packs.map((p) => p.dir);
  };
  const short = dirs(parseParams('?packs=zombie').packs!);
  const full = dirs(parseParams('?packs=std,std-needs,town,zombie').packs!);
  assert.equal(slotKey(short, 'slot1'), slotKey(full, 'slot1'));
  // Slots saved before stacks (under the full list) stay reachable.
  assert.equal(slotKey(short, 'quick'), 'isolandia:save:std,std-needs,town,zombie:quick');
  assert.equal(exportFileName(short, 2), exportFileName(full, 2));
});

test('picker: games then mods, with names, descriptions and stacks; nothing chosen', () => {
  const v = pickerModel(webCatalog(STACK_YAML), null, []);
  assert.deepEqual(
    v.rows.map((r) => [r.dir, r.kind, r.enabled]),
    [
      ['game', 'game', true],
      ['other', 'game', true],
      ['broken', 'mod', false],
      ['extra', 'mod', true],
      ['hardmode', 'mod', true],
    ],
  );
  const game = v.rows[0]!;
  assert.equal(game.name, 'Game');
  assert.equal(game.description, 'A game.');
  assert.deepEqual(game.stack, ['base', 'game']);
  assert.deepEqual(v.rows.find((r) => r.dir === 'hardmode')!.stack, ['base', 'game', 'hard']);
  assert.match(v.rows.find((r) => r.dir === 'broken')!.reason!, /depends on unknown pack 'nothing'/);
  assert.deepEqual(v.mods, []);
  assert.equal(v.query, null);
});

test('picker: choosing a game offers the other mods; unresolvable ones are disabled with a reason', () => {
  const c = webCatalog(STACK_YAML);
  const v = pickerModel(c, 'game', []);
  assert.ok(v.rows.find((r) => r.dir === 'game')!.chosen);
  assert.deepEqual(
    v.mods.map((m) => [m.dir, m.checked, m.enabled]),
    [
      ['broken', false, false],
      ['extra', false, true],
      ['hardmode', false, true],
    ],
  );
  assert.match(v.mods[0]!.reason!, /unknown pack 'nothing'/);
  assert.equal(v.query, '?packs=game&seed=1');
  assert.deepEqual(v.stack, ['base', 'game']);

  // Checked mods are appended in click order.
  const two = pickerModel(c, 'game', ['hardmode', 'extra'], 7);
  assert.equal(two.query, '?packs=game,hardmode,extra&seed=7');
  assert.deepEqual(two.stack, ['base', 'game', 'hard', 'extra']);
  assert.deepEqual(
    two.mods.filter((m) => m.checked).map((m) => m.dir),
    ['extra', 'hardmode'],
  );
  assert.equal(pickerModel(c, 'game', ['extra', 'hardmode']).query, '?packs=game,extra,hardmode&seed=1');
  // Unresolvable or unknown checks are dropped.
  assert.equal(pickerModel(c, 'game', ['broken', 'nope', 'extra']).query, '?packs=game,extra&seed=1');
});

test('picker: choosing a mod; mods already in its stack are disabled', () => {
  const v = pickerModel(webCatalog(STACK_YAML), 'hardmode', []);
  assert.equal(v.query, '?packs=hardmode&seed=1');
  assert.deepEqual(
    v.mods.map((m) => m.dir),
    ['broken', 'extra'],
  );
  const twice = pickerModel(
    webCatalog({ ...STACK_YAML, '/packs/plus/pack.yaml': 'namespace: plus\nname: Plus\nversion: 1\nkind: mod\ndepends: [hard]\n' }),
    'plus',
    [],
  );
  const hard = twice.mods.find((m) => m.dir === 'hardmode')!;
  assert.equal(hard.enabled, false);
  assert.equal(hard.reason, 'already in the stack');
  // A disabled row cannot be chosen.
  assert.equal(pickerModel(webCatalog(STACK_YAML), 'broken', []).query, null);
});

test('picker: catalog errors are listed', () => {
  const v = pickerModel(webCatalog({ ...STACK_YAML, '/packs/bad/pack.yaml': 'name: X\n' }), null, []);
  assert.equal(v.errors.length, 1);
  assert.match(v.errors[0]!, /^bad pack\.yaml.*missing required field 'namespace'/);
});

// ── Loop ──────────────────────────────────────────────────────────────────

test('loop: 10 ticks/s from an accumulator, max 5 per frame, backlog dropped', () => {
  let ticks = 0;
  const loop = new FixedTickLoop(() => ticks++, { ticksPerSecond: 10 });
  assert.equal(loop.advance(50), 0);
  assert.equal(loop.advance(50), 1);
  assert.equal(loop.advance(250), 2);
  assert.ok(Math.abs(loop.alpha - 0.5) < 1e-9);
  assert.equal(loop.advance(5030), 5);
  assert.ok(loop.alpha < 1);
  assert.ok(loop.droppedMs > 4000);
  assert.equal(loop.advance(100), 1);
  assert.equal(ticks, 9);
});

// ── Input ─────────────────────────────────────────────────────────────────

function recorder() {
  const log: string[] = [];
  const clock = { now: 0 };
  const g = new Gestures(
    {
      pan: (dx, dy) => log.push(`pan ${dx},${dy}`),
      zoom: (x, y, f) => log.push(`zoom ${x},${y},${f.toFixed(2)}`),
      click: (x, y) => log.push(`click ${x},${y}`),
      longPress: (x, y) => log.push(`long ${x},${y}`),
    },
    () => clock.now,
  );
  return { g, log, clock };
}

test('gestures: a press held still for LONG_PRESS_MS long-presses once and never clicks', () => {
  const { g, log, clock } = recorder();
  g.down(1, 100, 100);
  clock.now = LONG_PRESS_MS - 1;
  g.tick(clock.now);
  assert.deepEqual(log, []);
  g.move(1, 104, 103); // within the drag threshold
  clock.now = LONG_PRESS_MS;
  g.tick(clock.now);
  g.tick(clock.now + 100);
  g.up(1, 104, 103);
  assert.deepEqual(log, ['long 104,103']);
  // Released after the hold without a frame in between: still a long-press, not a click.
  const r = recorder();
  r.g.down(1, 5, 5);
  r.clock.now = 600;
  r.g.up(1, 5, 5);
  assert.deepEqual(r.log, ['long 5,5']);
  // A short press stays a click.
  const c = recorder();
  c.g.down(1, 5, 5);
  c.clock.now = 200;
  c.g.tick(200);
  c.g.up(1, 5, 5);
  assert.deepEqual(c.log, ['click 5,5']);
});

test('gestures: a drag or a second pointer cancels the long-press', () => {
  const { g, log, clock } = recorder();
  g.down(1, 100, 100);
  g.move(1, 120, 100);
  clock.now = 1000;
  g.tick(clock.now);
  g.up(1, 120, 100);
  assert.deepEqual(log, ['pan 20,0']);
  const r = recorder();
  r.g.down(1, 100, 100);
  r.g.down(2, 200, 100);
  r.g.up(2, 200, 100);
  r.clock.now = 1000;
  r.g.tick(r.clock.now);
  r.g.up(1, 100, 100);
  assert.deepEqual(r.log, []);
  // A press marked as not long-pressable (a mouse) only clicks.
  const m = recorder();
  m.g.down(1, 5, 5, false);
  m.clock.now = 1000;
  m.g.tick(m.clock.now);
  m.g.up(1, 5, 5);
  assert.deepEqual(m.log, ['click 5,5']);
});

test('gestures: a press without movement is a click', () => {
  const { g, log } = recorder();
  g.down(1, 100, 100);
  g.move(1, 103, 102); // under the drag threshold
  g.up(1, 103, 102);
  assert.deepEqual(log, ['click 103,102']);
});

test('gestures: a drag pans and does not click', () => {
  const { g, log } = recorder();
  g.down(1, 100, 100);
  g.move(1, 120, 100);
  g.move(1, 130, 110);
  g.move(1, 101, 100); // back near the start: still a drag
  g.up(1, 101, 100);
  assert.deepEqual(log, ['pan 20,0', 'pan 10,10', 'pan -29,-10']);
});

test('gestures: pinch zooms around its centre and cancels the tap', () => {
  const { g, log } = recorder();
  g.down(1, 100, 100);
  g.down(2, 200, 100);
  g.move(2, 300, 100);
  g.up(2, 300, 100);
  g.up(1, 100, 100);
  assert.deepEqual(log, ['zoom 200,100,2.00', 'pan 50,0']);
  // pointercancel never clicks
  const r = recorder();
  r.g.down(1, 5, 5);
  r.g.up(1, 5, 5, false);
  assert.deepEqual(r.log, []);
});

test('keys: arrows, WASD and numpad are screen-relative and map to grid steps', () => {
  assert.deepEqual(heldDirection(['KeyW']), { dx: -1, dy: -1 });
  assert.deepEqual(heldDirection(['KeyD']), { dx: 1, dy: -1 });
  assert.deepEqual(heldDirection(['KeyS']), { dx: 1, dy: 1 });
  assert.deepEqual(heldDirection(['KeyA']), { dx: -1, dy: 1 });
  assert.deepEqual(heldDirection(['KeyW', 'KeyD']), { dx: 0, dy: -1 });
  assert.deepEqual(heldDirection(['KeyW', 'KeyA']), { dx: -1, dy: 0 });
  assert.deepEqual(heldDirection(['KeyS', 'KeyD']), { dx: 1, dy: 0 });
  assert.deepEqual(heldDirection(['ArrowDown', 'ArrowLeft']), { dx: 0, dy: 1 });
  assert.deepEqual(heldDirection(['ArrowUp']), { dx: -1, dy: -1 });
  assert.deepEqual(heldDirection(['Numpad9']), { dx: 0, dy: -1 });
  assert.deepEqual(heldDirection(['Numpad3']), { dx: 1, dy: 0 });
  assert.equal(heldDirection(['KeyA', 'KeyD']), null);
  assert.equal(heldDirection(['KeyH', 'Space']), null);
});

test('keys: a fresh press turns in place; plain steps repeat once held for HOLD_MS', () => {
  assert.ok(HOLD_MS >= 150 && HOLD_MS <= 300);
  const k = new MoveKeys();
  assert.deepEqual(k.down('KeyD', false, 1000), { kind: 'step', dx: 1, dy: -1, turnInPlace: true });
  assert.equal(k.down('KeyD', true, 1030), null, 'auto-repeat queues nothing');
  assert.equal(k.repeat(1000, 0), null);
  assert.equal(k.repeat(1000 + HOLD_MS - 1, 0), null, 'no re-queue before HOLD_MS');
  assert.deepEqual(k.repeat(1000 + HOLD_MS, 1), { kind: 'step', dx: 1, dy: -1 });
  assert.equal(k.repeat(1000 + HOLD_MS, 2), null, 'only when the player can step again');
});

test('keys: a release before HOLD_MS gives no step', () => {
  const k = new MoveKeys();
  k.down('KeyW', false, 0);
  k.up('KeyW');
  assert.equal(k.repeat(HOLD_MS * 2, 0), null);
  k.down('KeyW', false, 500);
  k.clear();
  assert.equal(k.repeat(500 + HOLD_MS, 0), null, 'blur clears too');
});

test('keys: a new press (e.g. a second key for a diagonal) turns in place and resets the clock', () => {
  const k = new MoveKeys();
  k.down('KeyW', false, 0);
  assert.deepEqual(k.down('KeyD', false, 150), { kind: 'step', dx: 0, dy: -1, turnInPlace: true });
  assert.equal(k.repeat(HOLD_MS, 0), null, 'the clock restarted at the second press');
  assert.deepEqual(k.repeat(150 + HOLD_MS, 0), { kind: 'step', dx: 0, dy: -1 });
  k.up('KeyD');
  assert.deepEqual(k.repeat(150 + HOLD_MS + 100, 0), { kind: 'step', dx: -1, dy: -1 }, 'releasing one of two keys keeps walking');
});

// ── Camera ────────────────────────────────────────────────────────────────

test('camera: follows the player, drag disables follow, space re-enables', () => {
  const rig = new CameraRig();
  const player = { x: 100, y: 50 };
  const at = () => isoToScreen(player.x, player.y, rig.cam);
  rig.update(player, 800, 600);
  assert.deepEqual(at(), { x: 400, y: 300 });
  player.x = 164;
  rig.update(player, 800, 600);
  assert.deepEqual(at(), { x: 400, y: 300 });
  rig.pan(10, 0);
  assert.equal(rig.follow, false);
  player.x = 200;
  rig.update(player, 800, 600);
  assert.notDeepEqual(at(), { x: 400, y: 300 });
  rig.recenter();
  rig.update(player, 800, 600);
  assert.deepEqual(at(), { x: 400, y: 300 });
});

test('camera: zoom around the cursor keeps the point under it, clamps, and keeps following', () => {
  const rig = new CameraRig();
  const player = { x: 0, y: 0 };
  rig.update(player, 800, 600);
  rig.zoom(600, 300, 2, player, 800, 600);
  assert.equal(rig.cam.zoom, 2);
  // The iso point that was under the cursor (x = 200) is still there.
  assert.ok(Math.abs(isoToScreen(200, 0, rig.cam).x - 600) < 1e-9);
  rig.update(player, 800, 600);
  assert.ok(Math.abs(isoToScreen(200, 0, rig.cam).x - 600) < 1e-9, 'follow keeps the zoomed anchor');
  assert.ok(rig.follow);
  rig.zoom(0, 0, 100, player, 800, 600);
  assert.equal(rig.cam.zoom, 3);
  rig.zoom(0, 0, 1e-6, player, 800, 600);
  assert.equal(rig.cam.zoom, 0.25);
  assert.deepEqual(cameraAt(0, 0, 400, 300, 1), { zoom: 1, offsetX: 400, offsetY: 300 });
});

// ── HUD ───────────────────────────────────────────────────────────────────

test('hudModel: clock and player measurements, shared with the ASCII HUD', () => {
  const w = World.create(loadFixture(), 1);
  for (let i = 0; i < 25; i++) w.step();
  const m = hudModel(w);
  assert.equal(m.clock, 'Day 1 08:02');
  assert.equal(m.time, 'Time: Day 1 08:02 (tick 25)');
  assert.deepEqual(
    m.measurements.map((x) => x.text),
    ['HP: 10.0/10.0', 'Food: 47.5/100.0'],
  );
  assert.ok(Math.abs(m.measurements[1]!.value - 47.5) < 1e-9);
  assert.equal(m.measurements[1]!.max, 100);
});

test('web packs: a directional asset resolves one URL per distinct image', () => {
  const yaml = {
    '/packs/d/pack.yaml': 'namespace: d\nname: D\nversion: 1\n',
    '/packs/d/m.yaml': `tiles:
  - { id: floor, label: F, glyph: ".", color: white, walkable: true }
archetypes:
  - { id: p, label: P, glyph: p, color: red, sprite: p_img }
assets:
  - { id: p_img, directions: { s: s.svg, w: w.svg, n: { file: s.svg, anchor: [0.5, 0.5] } } }
maps:
  - { id: m, legend: { ".": { tile: floor, player: true } }, rows: ["."] }
start: { map: m, player: p }
`,
  };
  const files = { '/packs/d/s.svg': '/u/s.svg', '/packs/d/w.svg': '/u/w.svg' };
  const w = buildPackSources(yaml, files, ['d']);
  const r = loadPacks(w.sources);
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.errors));
  assert.deepEqual(assetUrls(r.definition.assets, ['d'], w.urls), [['/u/s.svg', '/u/w.svg', '/u/s.svg']]);
});
