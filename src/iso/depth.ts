/**
 * Depth ordering for the object layer (edges, raised tiles and entities).
 *
 * Objects are keyed by their continuous tile position (x, y) — a tile's
 * origin corner, interpolated for moving entities: nearer diagonals
 * (larger x + y) draw later, then larger x, then edges, blocks, ground
 * piles and entities in that order. An edge is keyed by the cell it
 * belongs to, so the `n` edge of (x, y) draws in front of everything in
 * (x, y − 1) (an earlier diagonal) and behind whatever stands in (x, y);
 * likewise the `w` edge with (x − 1, y).
 * Keys are only compared inside one diagonal bucket (`diagonalOf`), and
 * buckets are drawn in diagonal order, so moving an entity only re-sorts
 * the one bucket it is in.
 */

export const Layer = { Edge: 0, Block: 1, Pile: 2, Entity: 3 } as const;
export type Layer = (typeof Layer)[keyof typeof Layer];

/** Maps up to ROW / 4 tiles wide keep keys exact. */
const ROW = 1 << 17;

export function depthKey(x: number, y: number, layer: Layer): number {
  return (x + y) * ROW + x * 4 + layer;
}

/** Diagonal bucket for an object at (x, y). */
export function diagonalOf(x: number, y: number): number {
  return Math.floor(x + y);
}
