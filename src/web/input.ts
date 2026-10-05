/**
 * DOM input wiring: pointer gestures, right-click and wheel on the canvas,
 * keyboard on the window. Movement keys are tracked while held; `beforeTick` re-queues
 * the held direction so the player keeps walking at a constant pace.
 */

import type { World } from '../core/index.ts';
import { Gestures, type GestureHandlers } from './gestures.ts';
import { climbKey, heldDirection, MOVE_KEYS, suppressesDefault } from './keys.ts';

export interface InputHandlers extends GestureHandlers {
  /** Non-movement key presses (`KeyboardEvent.code`), without auto-repeat. */
  key(code: string): void;
  /** A climb key (PageUp/PageDown, `<`/`>`): one floor up (1) or down (-1), without auto-repeat. */
  climb?(dz: 1 | -1): void;
  /** Right-click on the canvas (the browser's own menu is suppressed there only). */
  menu(sx: number, sy: number): void;
  /** Offered every key press first (auto-repeat included); true consumes it (e.g. an open menu). */
  captureKey?(code: string): boolean;
}

export class Input {
  private readonly held = new Set<string>();
  private readonly gestures: Gestures;

  constructor(
    el: HTMLElement,
    /** The running world (it changes when a save is loaded). */
    private readonly world: () => World,
    on: InputHandlers,
  ) {
    const gestures = (this.gestures = new Gestures(on));
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      // Touch browsers fire contextmenu on a long-press too; Gestures handles that one.
      if ((ev as PointerEvent).pointerType === 'touch') return;
      on.menu(ev.clientX, ev.clientY);
    });
    el.addEventListener('pointerdown', (ev) => {
      // Only the primary mouse button pans/clicks; touch and pen always count.
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      gestures.down(ev.pointerId, ev.clientX, ev.clientY, ev.pointerType !== 'mouse');
    });
    el.addEventListener('pointermove', (ev) => gestures.move(ev.pointerId, ev.clientX, ev.clientY));
    el.addEventListener('pointerup', (ev) => gestures.up(ev.pointerId, ev.clientX, ev.clientY));
    el.addEventListener('pointercancel', (ev) => gestures.up(ev.pointerId, ev.clientX, ev.clientY, false));
    el.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        on.zoom(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false },
    );

    window.addEventListener('keydown', (ev) => {
      // F5/F9 are quicksave/quickload: never reload the page, even with a modifier or on auto-repeat.
      if (suppressesDefault(ev.code)) ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (on.captureKey?.(ev.code)) {
        ev.preventDefault();
        return;
      }
      const dz = climbKey(ev.key);
      if (dz !== 0) {
        ev.preventDefault();
        if (!ev.repeat) on.climb?.(dz);
      } else if (MOVE_KEYS[ev.code]) {
        ev.preventDefault();
        this.held.add(ev.code);
        if (!ev.repeat) this.queueHeld();
      } else if (!ev.repeat) {
        on.key(ev.code);
      }
    });
    window.addEventListener('keyup', (ev) => this.held.delete(ev.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  /** Call once per frame: fires a pending long-press. */
  frame(now: number): void {
    this.gestures.tick(now);
  }

  /**
   * Call right before each sim tick. Re-queues the held direction only on
   * the tick where the player can step again, so releasing a key between
   * ticks never leaves a stale step queued.
   */
  beforeTick(): void {
    if (this.world().player.moveCooldown <= 1) this.queueHeld();
  }

  private queueHeld(): void {
    const d = heldDirection(this.held);
    if (d) this.world().queueIntent({ kind: 'step', ...d });
  }
}
