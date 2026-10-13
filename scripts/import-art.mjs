#!/usr/bin/env node
// Import third-party art: `node scripts/import-art.mjs <pack> [--preview out.png]`.
//
// The recipe art/imports/<pack>.mjs exports `sources` (zips: `{ id, url,
// sha256 }`) and `images()` (one entry per output file in
// packs/<pack>/assets/). An image is either
//   { file, source, entry, ops }         a zip entry run through `ops`, or
//   { file, canvas: [w, h], layers }     layers drawn in order onto a
//                                        transparent canvas, each a
//                                        `{ source, entry, ops }` placed with
//                                        `at: [x, y]` (top-left) or
//                                        `centre: [x, y]`, or a shadow
//                                        `{ ellipse: [cx, cy, rx, ry], rgba }`.
// Ops: `{ crop: [x, y, w, h] }`, `{ resize: [w, h] }` (area average, down
// only), `{ scale: n }` (integer, nearest neighbour), `{ diamond: { cell,
// inset } }` (the exact 2:1 diamond alpha mask on `cell` px art pixels, the
// outer `inset` px refilled from inside; see docs/art.md#imported-art).
//
// Zips are cached in .cache/art/ and checked against their SHA-256 before
// use. Uses node:zlib only (art/png.mjs); the output is deterministic, so
// rerunning leaves `git status` clean.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, inDiamond, readZip } from '../art/png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = resolve(root, '.cache/art');

const args = process.argv.slice(2);
const p = args.indexOf('--preview');
const preview = p >= 0 ? args.splice(p, 2)[1] : null;
const [pack] = args;
const recipes = readdirSync(resolve(root, 'art/imports')).map((f) => f.replace(/\.mjs$/, ''));
if (!pack || !recipes.includes(pack)) {
  console.error(`usage: node scripts/import-art.mjs <pack> [--preview out.png] (have ${recipes.join(', ')})`);
  process.exit(2);
}
const recipe = await import(`../art/imports/${pack}.mjs`);

// ── Sources ───────────────────────────────────────────────────────────────

/** The zip of a source, downloaded into the cache unless it is there, checked against its SHA-256. */
async function fetchSource({ id, url, sha256 }) {
  const name = url.split('/').pop();
  const path = resolve(cacheDir, name);
  if (!existsSync(path)) {
    console.log(`downloading ${url}`);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`source '${id}': cannot download ${name} from ${url} (${e.cause?.code ?? e.message}); put the file at .cache/art/${name} to import offline`);
    }
    if (!res.ok) throw new Error(`source '${id}': downloading ${name} from ${url} failed: HTTP ${res.status}`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(path);
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== sha256) throw new Error(`source '${id}': .cache/art/${name} has SHA-256 ${got}, expected ${sha256} (delete it to download again; do not edit the recipe's hash)`);
  return readZip(buf);
}

const zips = new Map();
for (const s of recipe.sources) zips.set(s.id, await fetchSource(s));

function entry(source, name) {
  const zip = zips.get(source);
  if (!zip) throw new Error(`unknown source '${source}'`);
  const buf = zip.get(name);
  if (!buf) throw new Error(`source '${source}' has no entry ${name}`);
  return decodePng(buf);
}

// ── Image operations (RGBA, straight alpha) ──────────────────────────────

const blank = (width, height) => ({ width, height, data: new Uint8Array(width * height * 4) });

function crop(img, [x0, y0, w, h]) {
  if (x0 < 0 || y0 < 0 || x0 + w > img.width || y0 + h > img.height) throw new Error(`crop [${x0}, ${y0}, ${w}, ${h}] is outside the ${img.width}×${img.height} image`);
  const out = blank(w, h);
  for (let y = 0; y < h; y++) out.data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return out;
}

/** Per output index along one axis: the source indices its footprint covers and their weights (summing to 1). */
function footprints(from, to) {
  const k = from / to;
  return Array.from({ length: to }, (_, i) => {
    const a = i * k;
    const b = (i + 1) * k;
    const taps = [];
    for (let s = Math.floor(a); s < Math.ceil(b); s++) taps.push([s, (Math.min(b, s + 1) - Math.max(a, s)) / k]);
    return taps;
  });
}

/** Area-average (box filter) downscale, in premultiplied alpha. */
function resize(img, [w, h]) {
  if (w > img.width || h > img.height) throw new Error(`resize to ${w}×${h} would enlarge the ${img.width}×${img.height} image (use scale)`);
  const fx = footprints(img.width, w);
  const fy = footprints(img.height, h);
  const pre = new Float64Array(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3] / 255;
    pre.set([img.data[i * 4] * a, img.data[i * 4 + 1] * a, img.data[i * 4 + 2] * a, a * 255], i * 4);
  }
  const out = blank(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      for (const [sy, wy] of fy[y])
        for (const [sx, wx] of fx[x]) {
          const s = (sy * img.width + sx) * 4;
          for (let k = 0; k < 4; k++) acc[k] += pre[s + k] * wx * wy;
        }
      const a = acc[3];
      const d = (y * w + x) * 4;
      if (a > 0) for (let k = 0; k < 3; k++) out.data[d + k] = Math.min(255, Math.round((acc[k] * 255) / a));
      out.data[d + 3] = Math.round(a);
    }
  return out;
}

function scale(img, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`scale ${n} is not a positive integer`);
  const out = blank(img.width * n, img.height * n);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) out.data.set(img.data.subarray((Math.floor(y / n) * img.width + Math.floor(x / n)) * 4, (Math.floor(y / n) * img.width + Math.floor(x / n)) * 4 + 4), (y * out.width + x) * 4);
  return out;
}

/**
 * Apply the exact diamond mask (`inDiamond` in art/png.mjs, judged per
 * `cell`×`cell` art pixel: 4 for an @2x tile gives the pixel-art staircase):
 * inside opaque, outside fully transparent (and black). Inside pixels the
 * source left semi-transparent take the colour of their nearest opaque
 * neighbour (breadth-first, ties in scan order). With `inset: n`, so do the
 * pixels within n px (vertically) of the diamond's edge: it drops a
 * source's own edge shading, so neighbouring tiles join without a drawn grid.
 */
function diamond(img, { cell = 1, inset = 0 }) {
  const { width: W, height: H } = img;
  const core = 1 - inset / (H / 2);
  const inside = (x, y) => inDiamond(x, y, W, H, cell);
  const out = blank(W, H);
  out.data.set(img.data);
  const done = new Uint8Array(W * H);
  let frontier = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!inside(x, y)) out.data.fill(0, i * 4, i * 4 + 4);
      else if (img.data[i * 4 + 3] === 255 && Math.abs(x + 0.5 - W / 2) / (W / 2) + Math.abs(y + 0.5 - H / 2) / (H / 2) <= core) {
        done[i] = 1;
        frontier.push(i);
      }
    }
  if (!frontier.length) throw new Error('diamond: no opaque pixel inside the mask');
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (done[j] || !inside(nx, ny)) continue;
        done[j] = 1;
        out.data.set(out.data.subarray(i * 4, i * 4 + 3), j * 4);
        out.data[j * 4 + 3] = 255;
        next.push(j);
      }
    }
    frontier = next;
  }
  return out;
}

/** Draw `src` over `dst` with its top-left at (ox, oy) (straight-alpha "over"). */
function over(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const tx = ox + x;
      const ty = oy + y;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const sa = src.data[s + 3] / 255;
      if (sa === 0) continue;
      const da = dst.data[d + 3] / 255;
      const a = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) dst.data[d + k] = Math.round((src.data[s + k] * sa + dst.data[d + k] * da * (1 - sa)) / a);
      dst.data[d + 3] = Math.round(a * 255);
    }
}

/** A filled ellipse in one RGBA colour (by pixel centre), the size of `dst`. */
function ellipse(w, h, [cx, cy, rx, ry], rgba) {
  const out = blank(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) out.data.set(rgba, (y * w + x) * 4);
  return out;
}

const OPS = { crop, resize, scale, diamond };

function run({ source, entry: name, ops = [] }) {
  return ops.reduce((img, op) => {
    const [kind, arg] = Object.entries(op)[0];
    const fn = OPS[kind];
    if (!fn) throw new Error(`unknown op '${kind}'`);
    return fn(img, arg);
  }, entry(source, name));
}

function build(spec) {
  if (!spec.canvas) return run(spec);
  const [w, h] = spec.canvas;
  const out = blank(w, h);
  for (const layer of spec.layers) {
    if (layer.ellipse) {
      over(out, ellipse(w, h, layer.ellipse, layer.rgba), 0, 0);
      continue;
    }
    const img = run(layer);
    const [x, y] = layer.at ?? [Math.round(layer.centre[0] - img.width / 2), Math.round(layer.centre[1] - img.height / 2)];
    over(out, img, x, y);
  }
  return out;
}

// ── Write ─────────────────────────────────────────────────────────────────

const dir = resolve(root, 'packs', pack, 'assets');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const built = [];
for (const spec of recipe.images()) {
  if (!/@[1-4]x\.png$/.test(spec.file)) throw new Error(`${spec.file}: imported art is a PNG named with an @Nx suffix`);
  const img = build(spec);
  writeFileSync(resolve(dir, spec.file), encodePng(img));
  built.push(img);
}
console.log(`packs/${pack}/assets: ${built.length} images`);

if (preview) {
  // Each image ×2 on a grey checkerboard, side by side.
  const pad = 8;
  const W = built.reduce((s, i) => s + i.width * 2 + pad, pad);
  const H = Math.max(...built.map((i) => i.height * 2)) + 2 * pad;
  const sheet = blank(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = (Math.floor((i % W) / 8) + Math.floor(i / W / 8)) % 2 ? 0x70 : 0x60;
    sheet.data.set([v, v, v + 8, 255], i * 4);
  }
  let x = pad;
  for (const img of built) {
    over(sheet, scale(img, 2), x, pad);
    x += img.width * 2 + pad;
  }
  writeFileSync(preview, encodePng(sheet));
  console.log(`preview: ${preview}`);
}
