/**
 * The world grid. Tiles are stored in one flat array indexed by `y * width + x`.
 * Chunks are only a storage/render grouping: the sim and A* see one flat grid,
 * so paths cross chunk boundaries transparently.
 */
export interface Grid {
  readonly width: number;
  readonly height: number;
  readonly chunkSize: number;
  readonly chunksX: number;
  readonly chunksY: number;
  /** 1 = blocked, 0 = walkable. */
  readonly blocked: Uint8Array;
  /** Indices of every walkable tile (for picking random destinations). */
  readonly walkable: Int32Array;
}

export function inBounds(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

export function isWalkable(grid: Grid, x: number, y: number): boolean {
  return inBounds(grid, x, y) && grid.blocked[y * grid.width + x] === 0;
}
