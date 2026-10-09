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

/** Pause toggles (`KeyboardEvent.code`): `P` and the `Pause` key. */
export const PAUSE_KEYS: ReadonlySet<string> = new Set(['KeyP', 'Pause']);

/**
 * Speed keys (`KeyboardEvent.code`): `+` / `=` and the numpad `+` go faster
 * (1), `-` and the numpad `-` slower (-1); else 0.
 */
export function speedKey(code: string): 1 | -1 | 0 {
  if (code === 'Equal' || code === 'NumpadAdd') return 1;
  if (code === 'Minus' || code === 'NumpadSubtract') return -1;
  return 0;
}

/** Keys whose browser default (focus change, scrolling, page reload) the game suppresses. */
export const SUPPRESSED_KEYS: ReadonlySet<string> = new Set(['Space', 'Tab', 'F3', 'F5', 'F9', 'PageUp', 'PageDown']);

export function suppressesDefault(code: string): boolean {
  return SUPPRESSED_KEYS.has(code);
}

/** How long a movement key must be held before the player walks; a shorter tap only turns. */
export const HOLD_MS = 200;

/** A browser movement step: `turnInPlace` on a fresh press, plain while held. */
export interface MoveStep {
  readonly kind: 'step';
  readonly dx: D;
  readonly dy: D;
  readonly turnInPlace?: true;
}

/**
 * Held movement keys and hold-to-walk timing (pure; time is passed in, in
 * ms). A fresh press gives a turn-in-place step and restarts the hold clock;
 * once the latest press is `HOLD_MS` old, `repeat` gives plain steps on the
 * ticks where the player can step again.
 */
export class MoveKeys {
  private readonly held = new Set<string>();
  /** Time of the latest fresh press, or -1 when no direction is held. */
  private pressedAt = -1;

  /** A movement keydown; returns the step to queue now, if any. */
  down(code: string, repeat: boolean, now: number): MoveStep | null {
    // An auto-repeat of a key that is not held (dropped by `clear`) stays ignored until pressed again.
    if (repeat) return null;
    this.held.add(code);
    const d = heldDirection(this.held);
    if (!d) return null;
    this.pressedAt = now;
    return { kind: 'step', ...d, turnInPlace: true };
  }

  up(code: string): void {
    this.held.delete(code);
    if (!heldDirection(this.held)) this.pressedAt = -1;
  }

  clear(): void {
    this.held.clear();
    this.pressedAt = -1;
  }

  /** Right before a sim tick: the plain step to re-queue, if any. */
  repeat(now: number, moveCooldown: number): MoveStep | null {
    if (this.pressedAt < 0 || now - this.pressedAt < HOLD_MS || moveCooldown > 1) return null;
    const d = heldDirection(this.held);
    return d ? { kind: 'step', ...d } : null;
  }
}
