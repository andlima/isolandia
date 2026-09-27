/**
 * Tile-based line of sight. Integer-only and allocation-free, so every
 * platform gets the same answer and it is cheap to call from expressions.
 */

import type { Grid } from './grid.ts';

/**
 * Whether (x0, y0) and (x1, y1) can see each other. Only tiles block sight
 * (entities never do), and only cells strictly between the endpoints are
 * tested. Same and adjacent cells are always visible. A diagonal step
 * between two opaque orthogonal neighbours is blocked (no corner peeking).
 * The result is symmetric: the pair is visible if a Bresenham walk in either
 * direction is clear. Out-of-bounds endpoints are never visible.
 */
export function lineOfSight(grid: Grid, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!grid.inBounds(x0, y0) || !grid.inBounds(x1, y1)) return false;
  if (Math.abs(x1 - x0) <= 1 && Math.abs(y1 - y0) <= 1) return true;
  return clearWalk(grid, x0, y0, x1, y1) || clearWalk(grid, x1, y1, x0, y0);
}

/** One Bresenham walk from (x0, y0) to (x1, y1); true when nothing between them blocks. */
function clearWalk(grid: Grid, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    const e2 = 2 * err;
    let nx = x;
    let ny = y;
    if (e2 >= dy) {
      err += dy;
      nx += sx;
    }
    if (e2 <= dx) {
      err += dx;
      ny += sy;
    }
    if (nx !== x && ny !== y && grid.opaqueAt(nx, y) && grid.opaqueAt(x, ny)) return false;
    x = nx;
    y = ny;
    if (x === x1 && y === y1) return true;
    if (grid.opaqueAt(x, y)) return false;
  }
}
