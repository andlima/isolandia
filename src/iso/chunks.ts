/**
 * Render-chunk bookkeeping for the iso scene, kept free of Pixi so it can be
 * tested headless: which 16×16 chunks are visible or near the view, which to
 * build and which to evict (an LRU capped at `MAX_BUILT_CHUNKS`), and which
 * entity or pile sprites to create and destroy.
 *
 * A chunk key is `(z * rows + cy) * cols + cx`, with `cx`, `cy` in chunks.
 */

import { BLOCK_H, FLOOR_H, intersects, tileRectIsoBounds, type Bounds } from './projection.ts';

export const CHUNK = 16;
/** Built chunks kept before the least recently needed ones are destroyed. */
export const MAX_BUILT_CHUNKS = 160;

/** A map's chunk layout. */
export interface ChunkLayout {
  readonly cols: number;
  readonly rows: number;
  readonly floors: number;
}

export function chunkLayout(width: number, height: number, floors: number): ChunkLayout {
  return { cols: Math.ceil(width / CHUNK), rows: Math.ceil(height / CHUNK), floors };
}

export function chunkCount(l: ChunkLayout): number {
  return l.cols * l.rows * l.floors;
}

/** Chunk key of the chunk holding cell (x, y) on floor z (clamped into the map). */
export function chunkKeyOf(l: ChunkLayout, x: number, y: number, z: number): number {
  const cx = Math.min(Math.max(Math.floor(x / CHUNK), 0), l.cols - 1);
  const cy = Math.min(Math.max(Math.floor(y / CHUNK), 0), l.rows - 1);
  const cz = Math.min(Math.max(z, 0), l.floors - 1);
  return (cz * l.rows + cy) * l.cols + cx;
}

/** (cx, cy, z) of a chunk key. */
export function chunkOf(l: ChunkLayout, key: number): { cx: number; cy: number; z: number } {
  const cx = key % l.cols;
  const r = (key - cx) / l.cols;
  const cy = r % l.rows;
  return { cx, cy, z: (r - cy) / l.rows };
}

/** Iso bounds of a chunk, grown upwards for raised tiles and tall sprites, and raised by its floor. */
export function chunkBounds(l: ChunkLayout, key: number): Bounds {
  const { cx, cy, z } = chunkOf(l, key);
  const b = tileRectIsoBounds(cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
  b.minY -= BLOCK_H * 3 + z * FLOOR_H;
  b.maxY -= z * FLOOR_H;
  return b;
}

/**
 * The chunks intersecting `view` (`visible`) and those plus a one-chunk
 * margin around them on the same floor (`near`), both ascending.
 */
export function chunksInView(l: ChunkLayout, bounds: readonly Bounds[], view: Bounds): { visible: number[]; near: number[] } {
  const visible: number[] = [];
  const near = new Set<number>();
  for (let key = 0; key < bounds.length; key++) {
    if (!intersects(bounds[key]!, view)) continue;
    visible.push(key);
    const { cx, cy, z } = chunkOf(l, key);
    for (let y = Math.max(0, cy - 1); y <= Math.min(l.rows - 1, cy + 1); y++) {
      for (let x = Math.max(0, cx - 1); x <= Math.min(l.cols - 1, cx + 1); x++) near.add((z * l.rows + y) * l.cols + x);
    }
  }
  return { visible, near: [...near].sort((a, b) => a - b) };
}

/**
 * Built chunks in least-recently-needed order. `update` marks the chunks
 * needed this frame, returns those to build and, once more than `max` are
 * built, the least recently needed ones to evict (never a needed one).
 */
export class ChunkLru {
  /** Built chunk keys, least recently needed first (Map keeps insertion order). */
  private readonly order = new Map<number, true>();

  constructor(readonly max = MAX_BUILT_CHUNKS) {}

  has(key: number): boolean {
    return this.order.has(key);
  }

  get size(): number {
    return this.order.size;
  }

  /** Built chunk keys, least recently needed first. */
  keys(): number[] {
    return [...this.order.keys()];
  }

  update(needed: readonly number[]): { build: number[]; evict: number[] } {
    const build: number[] = [];
    for (const key of needed) {
      if (this.order.has(key)) this.order.delete(key);
      else build.push(key);
      this.order.set(key, true);
    }
    const evict: number[] = [];
    const keep = new Set(needed);
    for (const key of this.order.keys()) {
      if (this.order.size - evict.length <= this.max) break;
      if (!keep.has(key)) evict.push(key);
    }
    for (const key of evict) this.order.delete(key);
    return { build, evict };
  }

  /** Forget every chunk (the scene is destroyed). */
  clear(): void {
    this.order.clear();
  }
}

/** Sprites to create (wanted, not live) and destroy (live, not wanted), ascending. */
export function spriteDiff(live: Iterable<number>, wanted: Iterable<number>): { create: number[]; destroy: number[] } {
  const want = new Set(wanted);
  const have = new Set(live);
  const create = [...want].filter((id) => !have.has(id)).sort((a, b) => a - b);
  const destroy = [...have].filter((id) => !want.has(id)).sort((a, b) => a - b);
  return { create, destroy };
}

/** Whether an object at cell (x, y) on floor z needs a sprite: its chunk is built and visible. */
export function inShownChunk(l: ChunkLayout, built: { has(key: number): boolean }, visible: ReadonlySet<number>, x: number, y: number, z: number): boolean {
  const key = chunkKeyOf(l, x, y, z);
  return built.has(key) && visible.has(key);
}
