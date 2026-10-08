/**
 * Tile-based line of sight. Integer-only and allocation-free, so every
 * platform gets the same answer and it is cheap to call from expressions.
 */

import type { Grid } from './grid.ts';

/**
 * Whether (x0, y0) and (x1, y1) can see each other. Only tiles block sight
 * (entities never do): opaque cells strictly between the endpoints, and
 * opaque edges crossed on the way. A step between orthogonal neighbours is
 * blocked by an opaque edge between them; a diagonal step is blocked when
 * both L routes (x then y, y then x) are blocked, each by an opaque cell or
 * an opaque edge (no corner peeking). The same cell is always visible, and
 * so are adjacent cells unless opaque edges separate them (for diagonals:
 * unless both L routes cross an opaque edge; opaque corner cells alone do
 * not hide a diagonal neighbour). The result is symmetric: the pair is
 * visible if a Bresenham walk in either direction is clear. Out-of-bounds
 * endpoints are never visible. Sight stays on one floor: cells on different
 * floors (`z0` ≠ `z1`) never see each other.
 */
export function lineOfSight(grid: Grid, x0: number, y0: number, x1: number, y1: number, z0 = 0, z1 = z0): boolean {
  if (z0 !== z1 || !grid.inBounds(x0, y0, z0) || !grid.inBounds(x1, y1, z1)) return false;
  if (Math.abs(x1 - x0) <= 1 && Math.abs(y1 - y0) <= 1) return x0 === x1 && y0 === y1 ? true : stepClear(grid, x0, y0, x1 - x0, y1 - y0, z0, false);
  return clearWalk(grid, x0, y0, x1, y1, z0) || clearWalk(grid, x1, y1, x0, y0, z0);
}

/**
 * Whether sight passes one step from (x, y) by (dx, dy) on floor z (both cells
 * in bounds; the target cell itself is not tested). Orthogonal: the edge
 * between is not opaque. Diagonal: at least one L route is clear, i.e.
 * neither edge it crosses is opaque, nor (with `corners`) its corner cell.
 */
function stepClear(grid: Grid, x: number, y: number, dx: number, dy: number, z: number, corners = true): boolean {
  const i = grid.index(x, y, z);
  const w = grid.width;
  const { opaqueN, opaqueW, opaque } = grid;
  if (dy === 0) return opaqueW[dx > 0 ? i + 1 : i] === 0;
  if (dx === 0) return opaqueN[dy > 0 ? i + w : i] === 0;
  const col = dx > 0 ? i + 1 : i;
  const row = dy > 0 ? i + w : i;
  // Route x then y: corner (x + dx, y), the `w` edge in row y, then the `n` edge in column x + dx.
  if ((!corners || opaque[i + dx] === 0) && opaqueW[col] === 0 && opaqueN[row + dx] === 0) return true;
  // Route y then x: corner (x, y + dy), the `n` edge in column x, then the `w` edge in row y + dy.
  return (!corners || opaque[i + dy * w] === 0) && opaqueN[row] === 0 && opaqueW[col + dy * w] === 0;
}

/** One Bresenham walk from (x0, y0) to (x1, y1) on floor z; true when nothing between them blocks. */
function clearWalk(grid: Grid, x0: number, y0: number, x1: number, y1: number, z: number): boolean {
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
    if (!stepClear(grid, x, y, nx - x, ny - y, z)) return false;
    x = nx;
    y = ny;
    if (x === x1 && y === y1) return true;
    if (grid.opaqueAt(x, y, z)) return false;
  }
}
