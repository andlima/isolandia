/**
 * Pointer gesture tracking, free of DOM types so it can be unit-tested:
 * one pointer drags (pans), two pointers pinch (zoom + pan), and a press
 * that never moved past the drag threshold is a click — or, when held for
 * `LONG_PRESS_MS`, a long-press. A drag never also counts as a click, and
 * a long-press never also clicks. Time comes from an injectable clock and
 * `tick(now)` (called every frame), not from timers.
 */

export const DRAG_THRESHOLD = 8; // px before a press becomes a pan
export const LONG_PRESS_MS = 500;

export interface GestureHandlers {
  pan(dx: number, dy: number): void;
  zoom(sx: number, sy: number, factor: number): void;
  click(sx: number, sy: number): void;
  /** A single pointer held still for `LONG_PRESS_MS` (fires once per press). */
  longPress(sx: number, sy: number): void;
}

interface Press {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  dragged: boolean;
  /** Clock time of the press, or -1 when it cannot become a long-press. */
  readonly at: number;
  longPressed: boolean;
}

export class Gestures {
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private press: Press | null = null;
  private pinchDist = 0;

  constructor(
    private readonly on: GestureHandlers,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Pointer pressed; `longPress` false for presses that never long-press (e.g. a mouse). */
  down(id: number, x: number, y: number, longPress = true): void {
    this.pointers.set(id, { x, y });
    if (this.pointers.size === 1) {
      this.press = { id, x, y, dragged: false, at: longPress ? this.now() : -1, longPressed: false };
    } else {
      // A second finger starts a pinch and cancels the tap.
      if (this.press) this.press.dragged = true;
      this.pinchDist = this.currentPinchDist();
    }
  }

  move(id: number, x: number, y: number): void {
    const prev = this.pointers.get(id);
    if (!prev) return;
    this.pointers.set(id, { x, y });
    if (this.pointers.size >= 2) {
      const d = this.currentPinchDist();
      const mid = this.pinchMid();
      if (this.pinchDist > 0 && d > 0) this.on.zoom(mid.x, mid.y, d / this.pinchDist);
      this.pinchDist = d;
      this.on.pan((x - prev.x) / 2, (y - prev.y) / 2);
      return;
    }
    const p = this.press;
    if (!p || p.id !== id) return;
    if (!p.dragged && Math.hypot(x - p.x, y - p.y) > DRAG_THRESHOLD) {
      p.dragged = true;
      this.on.pan(x - p.x, y - p.y);
    } else if (p.dragged) {
      this.on.pan(x - prev.x, y - prev.y);
    }
  }

  /** Fire the long-press of a press held still long enough; call once per frame. */
  tick(now: number): void {
    const p = this.press;
    if (!p || p.dragged || p.longPressed || p.at < 0 || this.pointers.size !== 1 || now - p.at < LONG_PRESS_MS) return;
    p.longPressed = true;
    const pos = this.pointers.get(p.id)!;
    this.on.longPress(pos.x, pos.y);
  }

  /** Pointer released (`click` false for pointercancel). */
  up(id: number, x: number, y: number, click = true): void {
    const p = this.press;
    if (p && p.id === id) {
      if (click) this.tick(this.now());
      if (click && !p.dragged && !p.longPressed) this.on.click(x, y);
      this.press = null;
    }
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinchDist = 0;
    // After a pinch, hand the press to the remaining finger so it keeps panning.
    if (this.pointers.size === 1 && !this.press) {
      const [[rid, pos]] = [...this.pointers];
      this.press = { id: rid, x: pos.x, y: pos.y, dragged: true, at: -1, longPressed: false };
    }
  }

  private currentPinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private pinchMid(): { x: number; y: number } {
    const [a, b] = [...this.pointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  }
}
