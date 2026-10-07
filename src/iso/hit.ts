/**
 * Sprite-accurate hit testing, kept free of Pixi and the DOM so it is tested
 * with hand-made masks.
 *
 * A **hit mask** records which pixels of a texture are opaque (alpha ≥ 0.5),
 * sampled on the texture's art-pixel grid (2×2 iso px for SVG art and
 * generated placeholders, one pixel for PNGs; see `docs/art.md`). A
 * **candidate** is a drawn sprite: its iso rectangle, mask, mirroring, draw
 * order and what it stands for. `hitTest` returns the frontmost candidate
 * whose mask contains a point.
 */

import { Layer, depthKey } from './depth.ts';
import type { Bounds } from './projection.ts';

/** Opaque pixels of a texture on its art-pixel grid, row-major (1 = opaque). */
export interface HitMask {
  readonly cols: number;
  readonly rows: number;
  readonly bits: Uint8Array;
}

/** Alpha (0–255) from which a pixel counts as a hit. */
const OPAQUE = 128;

/** A mask from a predicate over art-pixel (col, row). */
export function makeMask(cols: number, rows: number, opaque: (col: number, row: number) => boolean): HitMask {
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) bits[r * cols + c] = opaque(c, r) ? 1 : 0;
  return { cols, rows, bits };
}

/**
 * A `cols × rows` mask from RGBA pixels (`width × height`, any resolution):
 * each art pixel samples the pixel at its centre.
 */
export function maskFromRgba(rgba: ArrayLike<number>, width: number, height: number, cols: number, rows: number): HitMask {
  return makeMask(cols, rows, (c, r) => {
    const px = Math.min(width - 1, Math.floor(((c + 0.5) * width) / cols));
    const py = Math.min(height - 1, Math.floor(((r + 0.5) * height) / rows));
    return rgba[(py * width + px) * 4 + 3]! >= OPAQUE;
  });
}

/** Whether the mask is opaque at (col, row); outside is transparent. */
export function maskAt(m: HitMask, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < m.cols && row < m.rows && m.bits[row * m.cols + col] === 1;
}

/** A drawn sprite that can be hit. */
export interface Candidate<T> {
  /** The sprite's iso rectangle (as drawn, i.e. after mirroring). */
  readonly bounds: Bounds;
  readonly mask: HitMask;
  /** Drawn flipped horizontally around its anchor spot: the mask is read right to left. */
  readonly mirrored: boolean;
  /** Draw order: larger is drawn later (in front). */
  readonly order: number;
  readonly target: T;
}

/** Whether a candidate's mask contains iso point (px, py). */
export function hits(c: Candidate<unknown>, px: number, py: number): boolean {
  const b = c.bounds;
  if (px < b.minX || px >= b.maxX || py < b.minY || py >= b.maxY) return false;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const lx = c.mirrored ? b.maxX - px : px - b.minX;
  const col = Math.min(c.mask.cols - 1, Math.floor((lx / w) * c.mask.cols));
  const row = Math.floor(((py - b.minY) / h) * c.mask.rows);
  return maskAt(c.mask, col, row);
}

/** The frontmost of the first `count` candidates whose mask contains (px, py), or null. */
export function hitTest<T>(px: number, py: number, candidates: readonly Candidate<T>[], count = candidates.length): Candidate<T> | null {
  let best: Candidate<T> | null = null;
  for (let i = 0; i < count; i++) {
    const c = candidates[i]!;
    if ((best === null || c.order > best.order) && hits(c, px, py)) best = c;
  }
  return best;
}

/**
 * Iso rectangle of a `width × height` sprite whose anchor (`anchorX`,
 * `anchorY`, normalized) is at (x, y); a mirrored sprite is flipped around
 * that spot. Writes into `out` when given.
 */
export function spriteBounds(
  x: number,
  y: number,
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
  mirrored: boolean,
  out: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 },
): Bounds {
  const left = (mirrored ? 1 - anchorX : anchorX) * width;
  out.minX = x - left;
  out.maxX = x - left + width;
  out.minY = y - anchorY * height;
  out.maxY = y - anchorY * height + height;
  return out;
}

/** Room for every `depthKey` of a map up to the size `depthKey` supports. */
const FLOOR_ORDER = 2 ** 36;

/** Draw order of an object on floor `floor` at continuous tile position (x, y): floor, then diagonal, then `depthKey`. */
export function drawOrder(floor: number, x: number, y: number, layer: Layer): number {
  return floor * FLOOR_ORDER + depthKey(x, y, layer);
}

/** How far a sprite can reach from its anchor spot (iso px): up, down and to either side. */
export interface Reach {
  up: number;
  down: number;
  side: number;
}

/** Grow `r` to cover a `width × height` sprite with the given anchor. */
export function growReach(r: Reach, width: number, height: number, anchorX: number, anchorY: number): void {
  r.up = Math.max(r.up, anchorY * height);
  r.down = Math.max(r.down, (1 - anchorY) * height);
  r.side = Math.max(r.side, Math.max(anchorX, 1 - anchorX) * width);
}
