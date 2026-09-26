import type { Grid } from './grid.ts';
import { mulberry32, randInt } from './rng.ts';

export interface WorldOptions {
  seed: number;
  chunksX?: number;
  chunksY?: number;
  chunkSize?: number;
  /** Target fraction of blocked tiles (before pocket filling). */
  blockedRatio?: number;
}

export const DEFAULT_SEED = 1337;

/**
 * Generates a seeded world: short wall segments plus scattered single
 * obstacles until ~blockedRatio of the tiles are blocked. Walkable pockets
 * not connected to the largest walkable region are then filled in, so the
 * walkable area is a single connected component.
 */
export function generateWorld(opts: WorldOptions): Grid {
  const chunkSize = opts.chunkSize ?? 32;
  const chunksX = opts.chunksX ?? 4;
  const chunksY = opts.chunksY ?? 4;
  const ratio = opts.blockedRatio ?? 0.15;
  const width = chunksX * chunkSize;
  const height = chunksY * chunkSize;
  const n = width * height;
  const rng = mulberry32(opts.seed);
  const blocked = new Uint8Array(n);
  const target = Math.round(n * ratio);
  let count = 0;

  const block = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (blocked[i] === 0) {
      blocked[i] = 1;
      count++;
    }
  };

  // ~60% of the budget as wall segments, the rest as scattered rocks.
  while (count < target * 0.6) {
    const x = randInt(rng, width);
    const y = randInt(rng, height);
    const len = 3 + randInt(rng, 8);
    const horizontal = rng() < 0.5;
    for (let k = 0; k < len && count < target; k++) {
      if (horizontal) block(x + k, y);
      else block(x, y + k);
    }
  }
  while (count < target) block(randInt(rng, width), randInt(rng, height));

  fillDisconnectedPockets(blocked, width, height);

  let walkableCount = 0;
  for (let i = 0; i < n; i++) if (blocked[i] === 0) walkableCount++;
  const walkable = new Int32Array(walkableCount);
  for (let i = 0, w = 0; i < n; i++) if (blocked[i] === 0) walkable[w++] = i;

  return { width, height, chunkSize, chunksX, chunksY, blocked, walkable };
}

/** Labels 4-connected walkable components and blocks all but the largest. */
function fillDisconnectedPockets(blocked: Uint8Array, width: number, height: number): void {
  const n = width * height;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  for (let start = 0; start < n; start++) {
    if (blocked[start] !== 0 || label[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp > 0) {
      const i = stack[--sp]!;
      size++;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    sizes.push(size);

    function visit(j: number) {
      if (blocked[j] === 0 && label[j] === -1) {
        label[j] = id;
        stack[sp++] = j;
      }
    }
  }
  let largest = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k]! > sizes[largest]!) largest = k;
  for (let i = 0; i < n; i++) if (blocked[i] === 0 && label[i] !== largest) blocked[i] = 1;
}
