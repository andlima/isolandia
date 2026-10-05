/**
 * Keyboard bindings for the browser: arrows, WASD and the numpad move in 8
 * directions, **screen-relative** (`W` = straight up on screen, `D` = right).
 * These differ from the terminal, which stays grid-aligned. Keyed by
 * `KeyboardEvent.code`, so they are layout-independent and the numpad works
 * with NumLock on or off.
 */

type D = -1 | 0 | 1;

/** Screen direction per key: [sx, sy], x rightwards, y downwards. */
export const MOVE_KEYS: Readonly<Record<string, readonly [D, D]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
  Numpad8: [0, -1],
  Numpad2: [0, 1],
  Numpad4: [-1, 0],
  Numpad6: [1, 0],
  Numpad7: [-1, -1],
  Numpad9: [1, -1],
  Numpad1: [-1, 1],
  Numpad3: [1, 1],
};

/**
 * Grid step for all held movement keys, or null. Keys are summed in screen
 * space, then mapped to the grid by inverting the 2:1 iso projection
 * (`worldToIso`): up = (-1,-1), up-right (W + D) = (0,-1) map-north, etc.
 */
export function heldDirection(held: Iterable<string>): { dx: D; dy: D } | null {
  let x = 0;
  let y = 0;
  for (const code of held) {
    const d = MOVE_KEYS[code];
    if (d) {
      x += d[0];
      y += d[1];
    }
  }
  const sx = Math.sign(x);
  const sy = Math.sign(y);
  const dx = Math.sign(sx + sy) as D;
  const dy = Math.sign(sy - sx) as D;
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

/**
 * Climb keys, by `KeyboardEvent.key` (so `<` / `>` follow the keyboard
 * layout): PageUp and `<` go up a floor, PageDown and `>` go down.
 */
export const CLIMB_KEYS: Readonly<Record<string, 1 | -1>> = { PageUp: 1, '<': 1, PageDown: -1, '>': -1 };

/** Floor direction of a climb key (`KeyboardEvent.key`), or 0. */
export function climbKey(key: string): 1 | -1 | 0 {
  return CLIMB_KEYS[key] ?? 0;
}

/** Keys whose browser default (focus change, scrolling, page reload) the game suppresses. */
export const SUPPRESSED_KEYS: ReadonlySet<string> = new Set(['Space', 'Tab', 'F5', 'F9', 'PageUp', 'PageDown']);

export function suppressesDefault(code: string): boolean {
  return SUPPRESSED_KEYS.has(code);
}
