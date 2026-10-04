import { deflateSync } from 'node:zlib';

// Tiny raster library for the pack pixel art (see docs/art.md).
//
// A Canvas is a grid of *art pixels* holding palette names (or null for
// transparent). Every art pixel becomes a 2×2 px <rect> in the SVG, so the
// output always sits on the 2 px grid. Iso shapes are filled by sampling
// pixel centres through the inverse projection, which yields the 2:1
// staircase edges and lets faces be shaded like tiny shaders.

/** Art pixels per tile: the 64×32 px diamond is 32×16 art pixels. */
export const TW = 32;
export const TH = 16;
/** Art pixels per block height (a 64×64 block rises 32 px = 16 art px). */
export const BH = 16;

/** A face or plane coordinate (tile units) → its art-px row/column (0..15). */
export const px = (t) => Math.max(0, Math.min(15, Math.floor(t * 16)));

export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Array(w * h).fill(null);
  }
  get(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.px[y * this.w + x];
  }
  set(x, y, c) {
    if (c === undefined || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = c;
  }
  rect(x, y, w, h, c) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
    return this;
  }
  /** Paint every pixel for which `fn(x, y)` returns a colour name (null/undefined = skip). */
  shade(fn) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const c = fn(x, y, this.get(x, y));
        if (c) this.set(x, y, c);
      }
    return this;
  }
  /** Paste a text grid with its top-left at (x, y); `key` maps chars to colours ('.' and ' ' skip). */
  grid(x, y, rows, key) {
    rows.forEach((row, j) => {
      [...row].forEach((ch, i) => {
        if (ch === '.' || ch === ' ') return;
        const c = key[ch];
        if (c === undefined) throw new Error(`grid: no colour for '${ch}'`);
        if (c) this.set(x + i, y + j, c);
      });
    });
    return this;
  }
  /** Draw `other` on top of this canvas (its non-null pixels win). */
  over(other, dx = 0, dy = 0) {
    for (let y = 0; y < other.h; y++) for (let x = 0; x < other.w; x++) this.set(x + dx, y + dy, other.get(x, y) ?? undefined);
    return this;
  }
  /** Add an outline in `c` around the drawn pixels (4-neighbourhood). */
  outline(c) {
    const add = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push([x, y]);
      }
    for (const [x, y] of add) this.set(x, y, c);
    return this;
  }
}

/** Point-in-polygon at the pixel centre (even-odd). */
export function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function poly(c, pts, colour) {
  return c.shade((x, y) => (inPoly(pts, x + 0.5, y + 0.5) ? colour : null));
}

/** Deterministic PRNG (mulberry32), seeded from a string. */
export function rng(seed) {
  let a = 0;
  for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap 2-D hash noise in [0, 1) for integer coordinates. */
export function hash(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Iso helper for a canvas whose tile's top ground vertex sits at (ox, oy):
 * map-x (`u`, east) goes down-right, map-y (`v`, south) down-left and `z`
 * up, all in tile units (1 = a whole tile / a whole block height).
 */
export function iso(c, ox, oy) {
  const P = (u, v, z = 0) => [ox + (TW / 2) * (u - v), oy + (TH / 2) * (u + v) - BH * z];
  /** Pixel centre → (u, v) on the horizontal plane at height z. */
  const onPlane = (x, y, z) => {
    const a = (x + 0.5 - ox) / (TW / 2);
    const b = (y + 0.5 - oy + BH * z) / (TH / 2);
    return [(a + b) / 2, (b - a) / 2];
  };
  const fill = (spec, ...args) => (typeof spec === 'function' ? spec(...args) : spec);
  const api = {
    P,
    /** Horizontal face at height z over [u0,u1)×[v0,v1); `spec(u, v, x, y)` or a colour. */
    top(u0, v0, u1, v1, z, spec) {
      c.shade((x, y) => {
        const [u, v] = onPlane(x, y, z);
        return u >= u0 && u < u1 && v >= v0 && v < v1 ? fill(spec, u, v, x, y) : null;
      });
      return api;
    },
    /** Face on the plane v = vf (faces down-left, screen-left); `spec(u, z, x, y)`. */
    south(vf, u0, u1, z0, z1, spec) {
      c.shade((x, y) => {
        const u = (x + 0.5 - ox) / (TW / 2) + vf;
        const z = (oy + (TH / 2) * (u + vf) - (y + 0.5)) / BH;
        return u >= u0 && u < u1 && z >= z0 && z < z1 ? fill(spec, u, z, x, y) : null;
      });
      return api;
    },
    /** Face on the plane u = uf (faces down-right, screen-right); `spec(v, z, x, y)`. */
    east(uf, v0, v1, z0, z1, spec) {
      c.shade((x, y) => {
        const v = uf - (x + 0.5 - ox) / (TW / 2);
        const z = (oy + (TH / 2) * (uf + v) - (y + 0.5)) / BH;
        return v >= v0 && v < v1 && z >= z0 && z < z1 ? fill(spec, v, z, x, y) : null;
      });
      return api;
    },
    /**
     * A box with its visible faces: `left` (south face), `right` (east face)
     * and `top`, each a colour or a shader as for the face functions.
     */
    box(u0, v0, u1, v1, z0, z1, { top, left, right }) {
      if (left) api.south(v1, u0, u1, z0, z1, left);
      if (right) api.east(u1, v0, v1, z0, z1, right);
      if (top) api.top(u0, v0, u1, v1, z1, top);
      return api;
    },
  };
  return api;
}

/** A canvas for a flat 64×32 tile (32×16 art px); its iso origin is the top vertex. */
export function flatTile() {
  const c = new Canvas(TW, TH);
  return { c, I: iso(c, TW / 2, 0) };
}

/** A canvas for a 64×64 block (32×32 art px); the ground diamond fills the bottom half. */
export function blockTile() {
  const c = new Canvas(TW, TH + BH);
  return { c, I: iso(c, TW / 2, BH) };
}

/** Pixel-ellipse drop shadow centred at (cx, cy) (art px, may be .5). */
export function shadow(c, cx, cy, rx, ry, colour = 'shadow') {
  return c.shade((x, y) => (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 < 1 ? colour : null));
}

// ── Output ────────────────────────────────────────────────────────────────

const hex = (s) => /^#[0-9a-f]{6}$/.test(s);

/** Resolve a palette entry to `{ fill, opacity }`. */
export function swatch(palette, name) {
  const e = palette[name];
  if (!e) throw new Error(`no palette colour '${name}'`);
  const [fill, opacity] = Array.isArray(e) ? e : [e, 1];
  if (!hex(fill)) throw new Error(`palette colour '${name}' is not #rrggbb: ${fill}`);
  return { fill, opacity };
}

/** SVG on the 2 px grid: runs per row, merged down when identical. */
export function toSvg(c, palette, comment) {
  const open = new Map(); // "x,w,colour" → rect
  const rects = [];
  for (let y = 0; y <= c.h; y++) {
    const runs = new Set();
    if (y < c.h) {
      for (let x = 0; x < c.w; ) {
        const col = c.get(x, y);
        let e = x + 1;
        while (e < c.w && c.get(e, y) === col) e++;
        if (col) {
          const k = `${x},${e - x},${col}`;
          runs.add(k);
          const r = open.get(k);
          if (r) r.h++;
          else {
            const n = { x, y, w: e - x, h: 1, col };
            open.set(k, n);
            rects.push(n);
          }
        }
        x = e;
      }
    }
    for (const k of [...open.keys()]) if (!runs.has(k)) open.delete(k);
  }
  const W = c.w * 2;
  const H = c.h * 2;
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`];
  if (comment) lines.push(`  <!-- ${comment} -->`);
  for (const r of rects) {
    const { fill, opacity } = swatch(palette, r.col);
    const op = opacity < 1 ? ` fill-opacity="${opacity}"` : '';
    lines.push(`  <rect x="${r.x * 2}" y="${r.y * 2}" width="${r.w * 2}" height="${r.h * 2}" fill="${fill}"${op}/>`);
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

// ── PNG preview (contact sheet) ───────────────────────────────────────────


const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGB rows (Uint8Array w*h*3) as PNG. */
export function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Lay canvases out on a sheet (each art px = `scale` sheet px) and return a PNG. */
export function contactSheet(items, scale = 4, cols = 8) {
  const cell = 34; // art px per cell (fits 32×32 blocks and 16×24 characters)
  const rows = Math.ceil(items.length / cols);
  const W = cols * cell * scale;
  const H = rows * cell * scale;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const x = Math.floor(i % W / (scale * 2));
    const y = Math.floor(Math.floor(i / W) / (scale * 2));
    const v = (x + y) % 2 ? 0x70 : 0x60;
    rgb.set([v, v, v + 8], i * 3);
  }
  items.forEach(({ c, palette }, n) => {
    const ox = (n % cols) * cell + 1;
    const oy = Math.floor(n / cols) * cell + 1;
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const name = c.get(x, y);
        if (!name) continue;
        const { fill, opacity } = swatch(palette, name);
        const col = [1, 3, 5].map((k) => parseInt(fill.slice(k, k + 2), 16));
        for (let j = 0; j < scale; j++)
          for (let i = 0; i < scale; i++) {
            const p = ((oy + y) * scale + j) * W + (ox + x) * scale + i;
            for (let k = 0; k < 3; k++) rgb[p * 3 + k] = Math.round(rgb[p * 3 + k] * (1 - opacity) + col[k] * opacity);
          }
      }
  });
  return png(W, H, rgb);
}
