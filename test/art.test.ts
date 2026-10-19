import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FACINGS, formatError, loadPacks, World, type Definition } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { imageResolution } from '../src/iso/resolution.ts';
import { decodePng, inDiamond, pngSize } from '../art/png.mjs';

// Pixel-art conventions for the shipped packs (docs/art.md), and the rules
// for imported PNG art (docs/art.md#imported-art).

const STACKS = [
  ['std', 'std-needs', 'town'],
  ['std', 'std-needs', 'town', 'zombie'],
  ['std', 'std-needs', 'town', 'zombie', 'zombie-kenney'],
  ['std', 'std-needs', 'town', 'vampire'],
  ['std', 'std-needs', 'town', 'hardship'],
  ['std', 'std-needs', 'town', 'noir'],
  ['std', 'std-needs', 'town', 'western'],
  ['std', 'garden'],
];
const FURNITURE = ['car', 'bed', 'fridge', 'cupboard', 'cabinet', 'dresser', 'coffin', 'bookshelf', 'chest', 'wine_rack', 'wheelbarrow', 'stairs', 'ladder'];
/** Archetypes drawn as a single image per facing: no walk cycle (every other archetype is a humanoid and walks). */
const STILL = ['crawler', 'bat', 'bunny', 'cat', 'fox', 'butterfly'];
const WALK_FRAMES = 4;
const MAX_COLOURS = 32;

function load(dirs: string[]): { def: Definition; dirOf: Map<string, string> } {
  const r = loadPacks(dirs.map((d) => readPack(`packs/${d}`)));
  assert.ok(r.ok, r.ok ? '' : r.errors.map(formatError).join('\n'));
  const dirOf = new Map(r.definition.packs.map((p, i) => [p.namespace, dirs[i]!]));
  return { def: r.definition, dirOf };
}

// ── A small SVG scan ──────────────────────────────────────────────────────

interface Svg {
  width: number;
  height: number;
  /** Distinct `#rrggbb` fills, lower-cased. */
  fills: Set<string>;
}

const ATTRS: Record<string, readonly string[]> = {
  svg: ['xmlns', 'width', 'height', 'viewBox', 'shape-rendering'],
  g: ['fill', 'fill-opacity', 'opacity'],
  rect: ['x', 'y', 'width', 'height', 'fill', 'fill-opacity', 'opacity'],
};

const even = (s: string | undefined): boolean => s !== undefined && /^\d+$/.test(s) && Number(s) % 2 === 0;

/** Parse and check a pixel-art SVG; returns its size and fills, or throws with the reason. */
function scanSvg(text: string): Svg {
  const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[\s\S]*?\?>/, '');
  const fills = new Set<string>();
  const fillStack: boolean[] = [];
  let root: Record<string, string> | null = null;
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      if (name === 'g') fillStack.pop();
      continue;
    }
    const allowed = ATTRS[name!];
    if (!allowed) throw new Error(`<${name}> is not allowed (only <svg>, <g> and <rect>)`);
    const attrs: Record<string, string> = {};
    for (const [, k, v] of rawAttrs!.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (!allowed.includes(k!)) throw new Error(`<${name}> attribute '${k}' is not allowed`);
      attrs[k!] = v!;
    }
    if (attrs.fill !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(attrs.fill)) throw new Error(`fill '${attrs.fill}' is not #rrggbb`);
      fills.add(attrs.fill.toLowerCase());
    }
    for (const k of ['opacity', 'fill-opacity']) {
      const o = attrs[k];
      if (o !== undefined && !(Number(o) > 0 && Number(o) <= 1)) throw new Error(`${k} '${o}' is not in (0, 1]`);
    }
    if (name === 'svg') {
      if (root) throw new Error('nested <svg>');
      root = attrs;
    } else if (!root) {
      throw new Error(`<${name}> outside <svg>`);
    } else if (name === 'g') {
      if (!selfClosing) fillStack.push(attrs.fill !== undefined);
    } else {
      for (const k of ['x', 'y', 'width', 'height']) {
        if (!even(attrs[k])) throw new Error(`<rect> ${k}="${attrs[k] ?? ''}" is not an even integer`);
      }
      if (attrs.fill === undefined && !fillStack.includes(true)) throw new Error('<rect> without a fill');
    }
  }
  if (!root) throw new Error('no <svg> root');
  if (root['shape-rendering'] !== 'crispEdges') throw new Error('root <svg> needs shape-rendering="crispEdges"');
  if (!even(root.width) || !even(root.height)) throw new Error(`size ${root.width}×${root.height} is not even integers`);
  const vb = (root.viewBox ?? '').trim().split(/\s+/);
  if (vb.join(' ') !== `0 0 ${root.width} ${root.height}`) throw new Error(`viewBox '${root.viewBox}' does not match the size`);
  return { width: Number(root.width), height: Number(root.height), fills };
}

/** Logical size of a pack image: an SVG's checked size, or a PNG's IHDR size over its `@Nx` resolution. */
function imageSize(path: string): { width: number; height: number } {
  if (!path.toLowerCase().endsWith('.png')) return scanSvg(readFileSync(path, 'utf8'));
  const { width, height } = pngSize(readFileSync(path));
  const n = imageResolution(path);
  return { width: width / n, height: height / n };
}

// Imported PNGs are exempt from the grid and palette checks by design (they
// are not pixel art); only SVGs are scanned there.
function svgFiles(dir: string): string[] {
  try {
    return readdirSync(`packs/${dir}/assets`)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => `packs/${dir}/assets/${f}`);
  } catch {
    return [];
  }
}

// ── Coverage and directionality ───────────────────────────────────────────

test('art: every tile, archetype and item of the shipped stacks has a sprite', () => {
  for (const dirs of STACKS) {
    const { def } = load(dirs);
    const missing = [
      ...def.tiles.filter((t) => t.sprite === null).map((t) => `tile ${t.id}`),
      ...def.archetypes.filter((a) => a.sprite === null).map((a) => `archetype ${a.id}`),
      ...def.items.filter((i) => i.sprite === null).map((i) => `item ${i.id}`),
    ];
    assert.deepEqual(missing, [], `${dirs.join(',')}: placeholders left`);
  }
});

test('art: characters are 8-way, oriented furniture is 4-way, everything else a single image', () => {
  for (const dirs of STACKS) {
    const { def } = load(dirs);
    const ways = (sprite: number | null) => (sprite === null ? null : def.assets[sprite]!.ways);
    for (const a of def.archetypes) assert.equal(ways(a.sprite), 8, `archetype ${a.id}`);
    for (const t of def.tiles) assert.equal(ways(t.sprite), FURNITURE.includes(t.id.split(':').pop()!) ? 4 : 1, `tile ${t.id}`);
    for (const i of def.items) assert.equal(ways(i.sprite), 1, `item ${i.id}`);
  }
});

test('art: image sizes and anchors follow the per-kind conventions', () => {
  for (const dirs of STACKS) {
    const { def, dirOf } = load(dirs);
    const check = (sprite: number | null, what: string, ok: (w: number, h: number, anchor: readonly [number, number]) => boolean) => {
      const asset = def.assets[sprite!]!;
      for (const img of asset.images) {
        const { width, height } = imageSize(`packs/${dirOf.get(asset.pack)}/${img.file}`);
        assert.ok(ok(width, height, img.anchor), `${what}: ${img.file} is ${width}×${height} anchored at [${img.anchor}]`);
      }
    };
    const bottom = (a: readonly [number, number]) => a[0] === 0.5 && a[1] === 1;
    for (const t of def.tiles) {
      if (t.edge) check(t.sprite, `edge tile ${t.id}`, (w, h, a) => w === 40 && h === 64 && a[0] === 0.1 && a[1] === 0.65625);
      else if (t.raised) check(t.sprite, `raised tile ${t.id}`, (w, h, a) => w === 64 && h >= 64 && bottom(a));
      else check(t.sprite, `flat tile ${t.id}`, (w, h, a) => w === 64 && h === 32 && bottom(a));
    }
    for (const c of def.archetypes) check(c.sprite, `archetype ${c.id}`, (w, h, a) => w === 32 && h === 48 && a[0] === 0.5 && a[1] > 0.85 && a[1] < 1);
    for (const i of def.items) check(i.sprite, `item ${i.id}`, (w, h, a) => w <= 32 && h <= 32 && a[0] === 0.5 && a[1] === 0.5);
  }
});

test('art: every humanoid character has a 4-frame walk cycle per facing; critters, the crawler and the bat stay single drawings', () => {
  let walkers = 0;
  for (const dirs of STACKS) {
    const { def, dirOf } = load(dirs);
    for (const c of def.archetypes) {
      const asset = def.assets[c.sprite!]!;
      const name = c.id.split(':').pop()!;
      if (STILL.includes(name)) {
        assert.equal(asset.walk, null, `archetype ${c.id} is a single drawing per facing`);
        continue;
      }
      assert.ok(asset.walk, `archetype ${c.id} has a walk cycle`);
      walkers++;
      FACINGS.forEach((f, i) => {
        const standing = asset.byFacing[i]!;
        const frames = asset.walk![i]!;
        assert.equal(frames.length, WALK_FRAMES, `${c.id} ${f}`);
        frames.forEach((k, n) => {
          const img = asset.images[k]!;
          assert.notEqual(k, standing.image, `${c.id} ${f}: frame ${n} is not the standing image`);
          if (!standing.mirrored) assert.match(img.file, new RegExp(`_${f}_walk${n + 1}\\.svg$`), `${c.id} ${f}: frame file name`);
          assert.deepEqual(img.anchor, asset.images[standing.image]!.anchor, `${c.id} ${f}: a frame uses its facing's anchor`);
          const { width, height } = imageSize(`packs/${dirOf.get(asset.pack)}/${img.file}`);
          assert.ok(width === 32 && height === 48, `${c.id} ${f}: ${img.file} is ${width}×${height}`);
        });
      });
    }
  }
  assert.ok(walkers >= 15, `${walkers} walking archetypes across the stacks`);
});

// ── Pixel-art format and palettes ─────────────────────────────────────────

test('art: every pack SVG is drawn on the 2 px art-pixel grid', () => {
  const dirs = readdirSync('packs');
  let n = 0;
  for (const dir of dirs) {
    for (const file of svgFiles(dir)) {
      try {
        scanSvg(readFileSync(file, 'utf8'));
      } catch (e) {
        assert.fail(`${file}: ${(e as Error).message}`);
      }
      n++;
    }
  }
  assert.ok(n > 0);
});

test(`art: each pack uses at most ${MAX_COLOURS} fill colours`, () => {
  for (const dir of readdirSync('packs')) {
    const colours = new Set<string>();
    for (const file of svgFiles(dir)) for (const f of scanSvg(readFileSync(file, 'utf8')).fills) colours.add(f);
    assert.ok(colours.size <= MAX_COLOURS, `packs/${dir}: ${colours.size} colours`);
  }
});

test('art: the SVG scan rejects what the grid does not allow', () => {
  const svg = (inner: string, root = 'width="4" height="4" viewBox="0 0 4 4" shape-rendering="crispEdges"') =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${inner}</svg>`;
  assert.deepEqual([...scanSvg(svg('<!-- ok --><g fill="#AABBCC"><rect x="0" y="2" width="2" height="2"/></g>')).fills], ['#aabbcc']);
  const bad: [string, RegExp][] = [
    [svg('<rect x="1" y="0" width="2" height="2" fill="#000000"/>'), /x="1" is not an even integer/],
    [svg('<rect x="0" y="0" width="2" height="2"/>'), /without a fill/],
    [svg('<circle cx="2" cy="2" r="1" fill="#000000"/>'), /<circle> is not allowed/],
    [svg('<path d="M0 0h2" fill="#000000"/>'), /<path> is not allowed/],
    [svg('<rect x="0" y="0" width="2" height="2" fill="#000000" stroke="#ffffff"/>'), /'stroke' is not allowed/],
    [svg('<rect x="0" y="0" width="2" height="2" fill="#000000" transform="scale(2)"/>'), /'transform' is not allowed/],
    [svg('<rect x="0" y="0" width="2" height="2" fill="red"/>'), /not #rrggbb/],
    [svg('<rect x="0" y="0" width="2" height="2" fill="url(#g)"/>'), /not #rrggbb/],
    [svg('', 'width="4" height="4" viewBox="0 0 4 4"'), /crispEdges/],
    [svg('', 'width="4" height="4" viewBox="0 0 8 8" shape-rendering="crispEdges"'), /viewBox/],
    [svg('', 'width="3" height="4" viewBox="0 0 3 4" shape-rendering="crispEdges"'), /not even/],
  ];
  for (const [text, err] of bad) assert.throws(() => scanSvg(text), err, text);
});

// ── Imported art ──────────────────────────────────────────────────────────

test('art: imported PNGs are referenced, named @Nx, credited, and flat tiles are masked to the exact diamond', () => {
  // Flat tiles drawn with a PNG in any shipped stack (the mask rule).
  const flats = new Set<string>();
  for (const dirs of STACKS) {
    const { def, dirOf } = load(dirs);
    for (const t of def.tiles) {
      if (t.sprite === null || t.edge || t.raised) continue;
      const asset = def.assets[t.sprite]!;
      for (const img of asset.images) if (img.file.toLowerCase().endsWith('.png')) flats.add(`packs/${dirOf.get(asset.pack)}/${img.file}`);
    }
  }
  let n = 0;
  let masked = 0;
  for (const dir of readdirSync('packs')) {
    let files: string[];
    try {
      files = readdirSync(`packs/${dir}/assets`).filter((f) => f.toLowerCase().endsWith('.png'));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const assets = readFileSync(`packs/${dir}/assets.yaml`, 'utf8');
    let credits = '';
    try {
      credits = readFileSync(`packs/${dir}/CREDITS.md`, 'utf8');
    } catch {
      assert.fail(`packs/${dir}: imports PNG art but has no CREDITS.md`);
    }
    for (const f of files) {
      const path = `packs/${dir}/assets/${f}`;
      assert.ok(assets.includes(`assets/${f}`), `${path}: not referenced by packs/${dir}/assets.yaml`);
      const m = /@([1-4])x\.png$/i.exec(f);
      assert.ok(m, `${path}: an imported PNG is named with an @Nx suffix`);
      const res = Number(m[1]);
      const { width, height } = pngSize(readFileSync(path));
      assert.ok(width % res === 0 && height % res === 0, `${path}: ${width}×${height} is not a multiple of ${res}`);
      const row = credits.split('\n').find((l) => l.includes(`\`${f}\``));
      assert.ok(row && /\b\w+\.zip\b/.test(row), `${path}: CREDITS.md names no source zip for it`);
      if (flats.has(path)) {
        const img = decodePng(readFileSync(path));
        for (let y = 0; y < img.height; y++)
          for (let x = 0; x < img.width; x++) {
            const a = img.data[(y * img.width + x) * 4 + 3];
            assert.equal(a, inDiamond(x, y, img.width, img.height, 2 * res) ? 255 : 0, `${path}: alpha at (${x}, ${y})`);
          }
        masked++;
      }
      n++;
    }
  }
  assert.ok(n > 0 && masked > 0);
});

test('art: the zombie-kenney skin changes only sprites, so it plays exactly like zombie', () => {
  const base = load(['std', 'std-needs', 'town', 'zombie']).def;
  const skin = load(['std', 'std-needs', 'town', 'zombie', 'zombie-kenney']).def;
  const noSprite = (def: Definition) => def.tiles.map(({ sprite: _sprite, ...t }) => t);
  assert.deepEqual(noSprite(skin), noSprite(base));
  const changed = skin.tiles.filter((t, i) => skin.assets[t.sprite!]!.id !== base.assets[base.tiles[i]!.sprite!]!.id).map((t) => t.id);
  assert.deepEqual(changed.sort(), ['std:floor', 'std:landing', 'town:car', 'town:grass', 'town:road']);
  const a = World.create(base, 3);
  const b = World.create(skin, 3);
  for (let i = 0; i < 200; i++) {
    a.step();
    b.step();
  }
  assert.equal(b.hash(), a.hash());
});
