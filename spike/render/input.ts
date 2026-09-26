import { zoomAt, type CameraState } from './iso.ts';

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
const DRAG_THRESHOLD = 8; // px before a press becomes a pan instead of a click
const KEY_PAN_SPEED = 900; // screen px per second

/**
 * Camera + input: drag / WASD / arrows to pan, wheel or pinch to zoom
 * (clamped), click or tap to select a tile. Screen → tile conversion is left
 * to the caller via `onClick` so it can use the pure projection functions.
 */
export class CameraController {
  cam: CameraState;
  enabled = true;
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private press: { id: number; x: number; y: number; dragged: boolean } | null = null;
  private pinchDist = 0;

  constructor(
    el: HTMLElement,
    cam: CameraState,
    private readonly onClick: (sx: number, sy: number) => void,
    private readonly onKey: (key: string) => void,
  ) {
    this.cam = cam;
    el.style.touchAction = 'none';

    el.addEventListener('contextmenu', (ev) => ev.preventDefault());

    el.addEventListener('pointerdown', (ev) => {
      // Only the primary mouse button pans/clicks; touch and pen always count.
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this.pointers.size === 1) {
        this.press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, dragged: false };
      } else {
        // Second finger: start a pinch, cancel the tap.
        if (this.press) this.press.dragged = true;
        this.pinchDist = this.currentPinchDist();
      }
    });

    el.addEventListener('pointermove', (ev) => {
      const prev = this.pointers.get(ev.pointerId);
      if (!prev || !this.enabled) return;
      const cur = { x: ev.clientX, y: ev.clientY };
      this.pointers.set(ev.pointerId, cur);
      if (this.pointers.size >= 2) {
        const d = this.currentPinchDist();
        const mid = this.pinchMid();
        if (this.pinchDist > 0 && d > 0) this.zoom(mid.x, mid.y, d / this.pinchDist);
        this.pinchDist = d;
        this.pan((cur.x - prev.x) / 2, (cur.y - prev.y) / 2);
        return;
      }
      const p = this.press;
      if (!p || p.id !== ev.pointerId) return;
      if (!p.dragged && Math.hypot(cur.x - p.x, cur.y - p.y) > DRAG_THRESHOLD) {
        p.dragged = true;
        this.pan(cur.x - p.x, cur.y - p.y);
      } else if (p.dragged) {
        this.pan(cur.x - prev.x, cur.y - prev.y);
      }
    });

    const release = (ev: PointerEvent, click: boolean) => {
      this.pointers.delete(ev.pointerId);
      const p = this.press;
      if (p && p.id === ev.pointerId) {
        if (click && !p.dragged && this.enabled) this.onClick(ev.clientX, ev.clientY);
        this.press = null;
      }
      if (this.pointers.size < 2) this.pinchDist = 0;
    };
    el.addEventListener('pointerup', (ev) => release(ev, true));
    el.addEventListener('pointercancel', (ev) => release(ev, false));

    el.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        if (this.enabled) this.zoom(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false },
    );

    window.addEventListener('keydown', (ev) => {
      this.keys.add(ev.key.toLowerCase());
      if (!ev.repeat) this.onKey(ev.key.toLowerCase());
    });
    window.addEventListener('keyup', (ev) => this.keys.delete(ev.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Applies held-key panning; call once per frame. */
  update(dtMs: number): void {
    if (!this.enabled) return;
    const k = this.keys;
    const d = (KEY_PAN_SPEED * dtMs) / 1000;
    let dx = 0;
    let dy = 0;
    if (k.has('a') || k.has('arrowleft')) dx += d;
    if (k.has('d') || k.has('arrowright')) dx -= d;
    if (k.has('w') || k.has('arrowup')) dy += d;
    if (k.has('s') || k.has('arrowdown')) dy -= d;
    if (dx || dy) this.pan(dx, dy);
  }

  pan(dx: number, dy: number): void {
    this.cam = { ...this.cam, offsetX: this.cam.offsetX + dx, offsetY: this.cam.offsetY + dy };
  }

  zoom(sx: number, sy: number, factor: number): void {
    this.cam = zoomAt(this.cam, sx, sy, factor, MIN_ZOOM, MAX_ZOOM);
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
