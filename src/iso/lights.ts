/**
 * Local lights for the iso scene (docs/iso.md#lighting), kept free of Pixi so
 * it is tested headless, like `chunks.ts`.
 *
 * A **source** is a cell plus a `LightDef` (and a flicker seed): every cell
 * whose tile has a `light`, every edge with a lit edge tile (cast from both
 * cells it separates) and every entity whose archetype has one. A source
 * lights a cell `c` on its own floor when `d = dist(source centre, c centre)
 * < radius` and the grid line of sight from the source's cell is clear
 * (`lineOfSight`: opaque cells and opaque edges block, floors never see each
 * other), with intensity `1 − d / radius`, times the source's flicker factor.
 * An edge light's two casts take the stronger, not the sum. Distinct sources
 * combine as `I = 1 − Π(1 − Iₖ)` with the intensity-weighted mean colour.
 *
 * The result is a **lightmap per render chunk** (`ChunkLightmap`): intensity
 * and colour per chunk cell, computed by `computeChunkLight` from the tile
 * sources around the chunk (`tileSources`) and the frame's entity sources.
 * `litTint` turns a cell's light into a sprite tint: it lifts the ambient
 * day/night tint toward the light's colour and never past it.
 */

import { EMPTY_TILE, lineOfSight, MAX_LIGHT_RADIUS, type Grid, type LightDef, type TileDef } from '../core/index.ts';
import { CHUNK, type ChunkLayout } from './chunks.ts';

export { MAX_LIGHT_RADIUS };

/** A flicker factor is constant over slots of this many milliseconds. */
export const FLICKER_SLOT_MS = 100;

/** A light source: a cell (or an edge's two cells) and what it casts. */
export interface LightSource {
  /** Stable identity (`tileSourceId` / `entitySourceId`), for the stats. */
  id: number;
  /** The cell the light casts from. */
  x: number;
  y: number;
  z: number;
  /** An edge light's second cast cell (the other side of the edge), else -1. */
  x2: number;
  y2: number;
  light: LightDef;
  /** Flicker seed (a cell index, an edge key or an entity id). */
  seed: number;
}

/** Source id of a tile light at cell index `i` (`side` -1 for the cell's own tile, 0 for its `n` edge, 1 for its `w` edge). */
export function tileSourceId(i: number, side: -1 | 0 | 1): number {
  return i * 3 + side + 1;
}

/** Source id of an entity light (negative, so it never meets a tile id). */
export function entitySourceId(entityId: number): number {
  return -(entityId + 1);
}

/** The flicker slot `nowMs` falls in. */
export function flickerSlot(nowMs: number): number {
  return Math.floor(nowMs / FLICKER_SLOT_MS);
}

/** A 32-bit mix of (seed, slot) mapped to [0, 1): the same on every platform. */
function hash01(seed: number, slot: number): number {
  let h = (Math.imul(seed | 0, 73856093) ^ Math.imul(slot | 0, 19349663)) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Flicker factor of a source in `[1 − amount, 1]`: piecewise constant over
 * `FLICKER_SLOT_MS` slots from a hash of (seed, slot); exactly 1 for
 * `amount` 0 (no hashing).
 */
export function flickerAt(seed: number, nowMs: number, amount: number): number {
  if (amount === 0) return 1;
  return 1 - amount * hash01(seed, flickerSlot(nowMs));
}

/**
 * Sprite tint of a cell lit with intensity `intensity` and colour `color`
 * under the ambient tint: per channel `ambient + (max(ambient, color) −
 * ambient) × intensity`, rounded. A light only lifts the ambient toward its
 * colour and never past it, so a white lamp restores a sprite's own colours
 * at night and is invisible under a white ambient.
 */
export function litTint(ambient: number, color: number, intensity: number): number {
  if (intensity <= 0) return ambient;
  const ch = (shift: number): number => {
    const a = (ambient >> shift) & 0xff;
    const c = (color >> shift) & 0xff;
    return c <= a ? a : Math.round(a + (c - a) * intensity);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Farthest integer cell offset a light of `radius` can reach (`d < radius`). */
export function reachCells(radius: number): number {
  return Math.max(0, Math.ceil(radius) - 1);
}

/**
 * Keys of the chunks (on floor `z`) that a light of `radius` at cell (x, y)
 * can reach: those meeting the box of cells within `reachCells(radius)`.
 * What an entity light dirties when it enters or leaves a cell.
 */
export function chunksInReach(l: ChunkLayout, x: number, y: number, z: number, radius = MAX_LIGHT_RADIUS): number[] {
  const out: number[] = [];
  if (z < 0 || z >= l.floors) return out;
  const r = reachCells(radius);
  const cx0 = Math.max(0, Math.floor((x - r) / CHUNK));
  const cx1 = Math.min(l.cols - 1, Math.floor((x + r) / CHUNK));
  const cy0 = Math.max(0, Math.floor((y - r) / CHUNK));
  const cy1 = Math.min(l.rows - 1, Math.floor((y + r) / CHUNK));
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.push((z * l.rows + cy) * l.cols + cx);
  return out;
}

/** Whether a source can reach a cell of the box [x0, x1) × [y0, y1) on floor `z` (by its reach box, not line of sight). */
export function sourceReaches(s: LightSource, x0: number, y0: number, x1: number, y1: number, z: number): boolean {
  if (s.z !== z) return false;
  const r = reachCells(s.light.radius);
  const near = (x: number, y: number): boolean => x + r >= x0 && x - r < x1 && y + r >= y0 && y - r < y1;
  return near(s.x, s.y) || (s.x2 >= 0 && near(s.x2, s.y2));
}

/**
 * The tile sources that can reach the chunk at (x0, y0) on floor `z`: every
 * lit cell tile and lit edge tile within `MAX_LIGHT_RADIUS` of the chunk's
 * cells (at most (16 + 24)² cells scanned). An edge casts from both cells it
 * separates; a side cell outside the map is dropped.
 */
export function tileSources(grid: Grid, tiles: readonly TileDef[], x0: number, y0: number, z: number): LightSource[] {
  const out: LightSource[] = [];
  const { width, height } = grid;
  const xa = Math.max(0, x0 - MAX_LIGHT_RADIUS);
  const ya = Math.max(0, y0 - MAX_LIGHT_RADIUS);
  const xb = Math.min(width, x0 + CHUNK + MAX_LIGHT_RADIUS);
  const yb = Math.min(height, y0 + CHUNK + MAX_LIGHT_RADIUS);
  const { cells, edgeN, edgeW } = grid;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (z * height + y) * width + x;
      const t = cells[i]!;
      if (t !== EMPTY_TILE) {
        const light = tiles[t]?.light ?? null;
        if (light) out.push({ id: tileSourceId(i, -1), x, y, z, x2: -1, y2: -1, light, seed: i });
      }
      const n = edgeN[i]!;
      if (n !== EMPTY_TILE) {
        const light = tiles[n]?.light ?? null;
        if (light) out.push({ id: tileSourceId(i, 0), x, y, z, x2: y > 0 ? x : -1, y2: y > 0 ? y - 1 : -1, light, seed: i * 2 });
      }
      const w = edgeW[i]!;
      if (w !== EMPTY_TILE) {
        const light = tiles[w]?.light ?? null;
        if (light) out.push({ id: tileSourceId(i, 1), x, y, z, x2: x > 0 ? x - 1 : -1, y2: x > 0 ? y : -1, light, seed: i * 2 + 1 });
      }
    }
  }
  return out;
}

/** The light of one render chunk: intensity and colour per chunk cell. */
export interface ChunkLightmap {
  /** The chunk's origin cell and floor. */
  readonly x0: number;
  readonly y0: number;
  readonly z: number;
  /** Intensity in (0, 1] per chunk cell `(y − y0) × CHUNK + (x − x0)`; 0 where unlit. */
  readonly intensity: Float32Array;
  /** Colour (0xRRGGBB) per chunk cell, meaningful where `intensity > 0`. */
  readonly color: Uint32Array;
  /** Lit cells. */
  lit: number;
  /** Ids of the sources that reached at least one cell of the chunk. */
  readonly reached: number[];
  /** Whether a flickering source reached the chunk (it must be recomputed when the flicker slot changes). */
  flickering: boolean;
}

export function newChunkLightmap(x0: number, y0: number, z: number): ChunkLightmap {
  return { x0, y0, z, intensity: new Float32Array(CHUNK * CHUNK), color: new Uint32Array(CHUNK * CHUNK), lit: 0, reached: [], flickering: false };
}

// Scratch accumulators, reused by every `computeChunkLight` call.
const prod = new Float32Array(CHUNK * CHUNK);
const sumR = new Float32Array(CHUNK * CHUNK);
const sumG = new Float32Array(CHUNK * CHUNK);
const sumB = new Float32Array(CHUNK * CHUNK);
const sumW = new Float32Array(CHUNK * CHUNK);

/** Intensity cast from (sx, sy) on cell (x, y) of floor `z`: falloff by distance, 0 beyond `radius` or out of sight. */
function cast(grid: Grid, sx: number, sy: number, x: number, y: number, z: number, radius: number): number {
  const dx = x - sx;
  const dy = y - sy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= radius) return 0;
  return lineOfSight(grid, sx, sy, x, y, z) ? 1 - d / radius : 0;
}

/**
 * The lit cells of the render chunk at (x0, y0) on floor `z` from `sources`
 * at wall-clock `nowMs` (for the flicker), written into `out` (reset first;
 * a fresh lightmap when omitted). Sources on another floor or out of reach
 * cost nothing; empty cells without edges are skipped.
 */
export function computeChunkLight(grid: Grid, x0: number, y0: number, z: number, sources: readonly LightSource[], nowMs: number, out: ChunkLightmap = newChunkLightmap(x0, y0, z)): ChunkLightmap {
  out.intensity.fill(0);
  out.lit = 0;
  out.reached.length = 0;
  out.flickering = false;
  const w = Math.min(CHUNK, grid.width - x0);
  const h = Math.min(CHUNK, grid.height - y0);
  if (w <= 0 || h <= 0 || z < 0 || z >= grid.floors) return out;
  prod.fill(1);
  sumR.fill(0);
  sumG.fill(0);
  sumB.fill(0);
  sumW.fill(0);
  const { width, height, cells, edgeN, edgeW } = grid;
  const base = z * height;
  for (const s of sources) {
    if (!sourceReaches(s, x0, y0, x0 + w, y0 + h, z)) continue;
    const { radius, color, flicker } = s.light;
    const factor = flickerAt(s.seed, nowMs, flicker);
    const r = reachCells(radius);
    const two = s.x2 >= 0;
    const xa = Math.max(x0, Math.min(s.x, two ? s.x2 : s.x) - r);
    const xb = Math.min(x0 + w - 1, Math.max(s.x, two ? s.x2 : s.x) + r);
    const ya = Math.max(y0, Math.min(s.y, two ? s.y2 : s.y) - r);
    const yb = Math.min(y0 + h - 1, Math.max(s.y, two ? s.y2 : s.y) + r);
    const cr = (color >> 16) & 0xff;
    const cg = (color >> 8) & 0xff;
    const cb = color & 0xff;
    let hit = false;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const i = (base + y) * width + x;
        if (cells[i] === EMPTY_TILE && edgeN[i] === EMPTY_TILE && edgeW[i] === EMPTY_TILE) continue;
        let I = cast(grid, s.x, s.y, x, y, z, radius);
        if (two) {
          const other = cast(grid, s.x2, s.y2, x, y, z, radius);
          if (other > I) I = other;
        }
        I *= factor;
        if (I <= 0) continue;
        hit = true;
        const k = (y - y0) * CHUNK + (x - x0);
        prod[k] *= 1 - I;
        sumR[k] += I * cr;
        sumG[k] += I * cg;
        sumB[k] += I * cb;
        sumW[k] += I;
      }
    }
    if (hit) {
      out.reached.push(s.id);
      if (flicker > 0) out.flickering = true;
    }
  }
  if (!out.reached.length) return out;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * CHUNK + x;
      const wsum = sumW[k]!;
      if (wsum <= 0) continue;
      out.intensity[k] = 1 - prod[k]!;
      out.color[k] = (Math.round(sumR[k]! / wsum) << 16) | (Math.round(sumG[k]! / wsum) << 8) | Math.round(sumB[k]! / wsum);
      out.lit++;
    }
  }
  return out;
}

/** A lit cell as a plain record: its grid cell index, intensity and colour (for tests and tools). */
export interface LitCell {
  index: number;
  i: number;
  color: number;
}

/** The lit cells of a lightmap, ascending cell index. */
export function litCells(map: ChunkLightmap, grid: Pick<Grid, 'width' | 'height'>): LitCell[] {
  const out: LitCell[] = [];
  for (let k = 0; k < CHUNK * CHUNK; k++) {
    const i = map.intensity[k]!;
    if (i <= 0) continue;
    const x = map.x0 + (k % CHUNK);
    const y = map.y0 + Math.floor(k / CHUNK);
    out.push({ index: (map.z * grid.height + y) * grid.width + x, i, color: map.color[k]! });
  }
  return out;
}

/** Intensity of a lightmap at grid cell (x, y) (0 outside the chunk or where unlit). */
export function lightIntensity(map: ChunkLightmap, x: number, y: number): number {
  const lx = x - map.x0;
  const ly = y - map.y0;
  if (lx < 0 || ly < 0 || lx >= CHUNK || ly >= CHUNK) return 0;
  return map.intensity[ly * CHUNK + lx]!;
}

/** Colour of a lightmap at grid cell (x, y) (meaningful where `lightIntensity` > 0). */
export function lightColor(map: ChunkLightmap, x: number, y: number): number {
  return map.color[(y - map.y0) * CHUNK + (x - map.x0)]!;
}

/** The keys of the chunks a flicker slot change makes stale: those whose lightmap a flickering source reached. */
export function flickerDirty(chunks: Iterable<readonly [number, Pick<ChunkLightmap, 'flickering'>]>): number[] {
  const out: number[] = [];
  for (const [key, map] of chunks) if (map.flickering) out.push(key);
  return out;
}
