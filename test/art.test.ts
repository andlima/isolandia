import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatError, loadPacks, type Definition } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';

// Pixel-art conventions for the shipped packs (docs/art.md).

const STACKS = [
  ['std', 'std-needs', 'zombie'],
  ['std', 'vampire'],
  ['std', 'garden'],
];
const FURNITURE = ['car', 'bed', 'fridge', 'cupboard', 'cabinet', 'dresser', 'coffin', 'bookshelf', 'chest', 'wine_rack', 'wheelbarrow'];
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
        const { width, height } = scanSvg(readFileSync(`packs/${dirOf.get(asset.pack)}/${img.file}`, 'utf8'));
        assert.ok(ok(width, height, img.anchor), `${what}: ${img.file} is ${width}×${height} anchored at [${img.anchor}]`);
      }
    };
    const bottom = (a: readonly [number, number]) => a[0] === 0.5 && a[1] === 1;
    for (const t of def.tiles) {
      if (t.raised) check(t.sprite, `raised tile ${t.id}`, (w, h, a) => w === 64 && h >= 64 && bottom(a));
      else check(t.sprite, `flat tile ${t.id}`, (w, h, a) => w === 64 && h === 32 && bottom(a));
    }
    for (const c of def.archetypes) check(c.sprite, `archetype ${c.id}`, (w, h, a) => w === 32 && h === 48 && a[0] === 0.5 && a[1] > 0.85 && a[1] < 1);
    for (const i of def.items) check(i.sprite, `item ${i.id}`, (w, h, a) => w <= 32 && h <= 32 && a[0] === 0.5 && a[1] === 0.5);
  }
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
