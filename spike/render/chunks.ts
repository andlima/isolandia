import { Container, Graphics } from 'pixi.js';
import type { Grid } from '../sim/grid.ts';
import { TILE_H, TILE_W, worldToIso } from './iso.ts';

/** Cheap deterministic per-tile hash for colour variation. */
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function shade(color: number, f: number): number {
  const r = Math.min(255, ((color >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((color >> 8) & 255) * f) | 0;
  const b = Math.min(255, (color & 255) * f) | 0;
  return (r << 16) | (g << 8) | b;
}

/**
 * Builds one chunk's static ground layer (every tile diamond) and caches it as
 * a single texture, so it costs one quad per frame instead of 1024 polygons.
 * Blocked tiles get a dark footprint; the raised block itself is a sprite in
 * the depth-sorted object layer.
 */
export function buildChunkGround(grid: Grid, cx: number, cy: number): Container {
  const g = new Graphics();
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  const cs = grid.chunkSize;
  // Alternate chunk tint slightly so chunk boundaries are visible.
  const base = (cx + cy) % 2 === 0 ? 0x5f8f4e : 0x588a4a;
  for (let y = cy * cs; y < (cy + 1) * cs; y++) {
    for (let x = cx * cs; x < (cx + 1) * cs; x++) {
      const p = worldToIso(x, y);
      const blocked = grid.blocked[y * grid.width + x] !== 0;
      const color = blocked ? 0x2f2a25 : shade(base, 0.9 + hash(x, y) * 0.2);
      g.poly([p.x, p.y, p.x + hw, p.y + hh, p.x, p.y + TILE_H, p.x - hw, p.y + hh]).fill(color);
    }
  }
  const c = new Container();
  c.addChild(g);
  // Resolution 1 regardless of devicePixelRatio: each chunk is ~2048×1024 px,
  // so 16 chunks at DPR 2 would need ~512 MB of textures instead of ~128 MB.
  c.cacheAsTexture({ resolution: 1 });
  return c;
}
