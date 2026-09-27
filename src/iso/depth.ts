/**
 * Depth ordering for the object layer (raised tiles and entities).
 *
 * Objects are keyed by their continuous tile position (x, y) — a tile's
 * origin corner, interpolated for moving entities: nearer diagonals
 * (larger x + y) draw later, then larger x, then blocks, ground piles and
 * entities in that order.
 * Keys are only compared inside one diagonal bucket (`diagonalOf`), and
 * buckets are drawn in diagonal order, so moving an entity only re-sorts
 * the one bucket it is in.
 */

export const Layer = { Block: 0, Pile: 1, Entity: 2 } as const;
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
