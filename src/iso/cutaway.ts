/**
 * Floor cutaway and near-wall fading for the iso view. Pure: the scene
 * applies these rules by toggling floor containers and block alphas.
 *
 * - The view floor is the player's floor; while climbing it switches at the
 *   step's midpoint (`viewFloor` of the interpolated `z`).
 * - Floors above the view floor are hidden.
 * - On the view floor, a raised block fades when it is in front of the
 *   player and close on screen: its diagonal `x + y` is in
 *   `(px + py, px + py + 3]` and `|(x − y) − (px − py)| ≤ 2`.
 * - Edges fade by the same rule on the cell they belong to (`n` and `w` of
 *   a fading cell fade). So the south side of the player's cell (the `n` of
 *   the cell below) and its east side (the `w` of the cell to the right)
 *   count as in front, and its own `n` and `w` do not.
 */

/** Alpha of a faded block. */
export const FADE_ALPHA = 0.35;
/** How many diagonals in front of the player fade. */
const FADE_DEPTH = 3;
/** How far (in `x − y`) to either side of the player blocks fade. */
const FADE_SPREAD = 2;

/** The floor shown for an interpolated floor `z` (switches at the midpoint), clamped to the map's floors. */
export function viewFloor(z: number, floors: number): number {
  return Math.min(floors - 1, Math.max(0, Math.floor(z + 0.5)));
}

/** Whether floor `z` is drawn with view floor `view` (floors above it are cut away). */
export function floorVisible(z: number, view: number): boolean {
  return z <= view;
}

/** Whether a raised block at (x, y) on the view floor fades for a player at (px, py). */
export function fades(x: number, y: number, px: number, py: number): boolean {
  const d = x + y - (px + py);
  return d > 0 && d <= FADE_DEPTH && Math.abs(x - y - (px - py)) <= FADE_SPREAD;
}

/** Every cell `fades` is true for, for a player at integer (px, py), nearest diagonal first. */
export function fadeCells(px: number, py: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const s0 = px + py;
  const u0 = px - py;
  for (let s = s0 + 1; s <= s0 + FADE_DEPTH; s++) {
    for (let u = u0 - FADE_SPREAD; u <= u0 + FADE_SPREAD; u++) {
      if ((s + u) % 2 !== 0) continue; // x + y and x − y share parity
      out.push({ x: (s + u) / 2, y: (s - u) / 2 });
    }
  }
  return out;
}
