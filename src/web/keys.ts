/**
 * Keyboard bindings for the browser, matching the terminal: arrows, WASD and
 * the numpad move in 8 directions. Keyed by `KeyboardEvent.code`, so they are
 * layout-independent and the numpad works with NumLock on or off.
 */

type D = -1 | 0 | 1;

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

/** Combined direction of all held movement keys (e.g. W + D = north-east), or null. */
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
  const dx = Math.sign(x) as D;
  const dy = Math.sign(y) as D;
  return dx === 0 && dy === 0 ? null : { dx, dy };
}
