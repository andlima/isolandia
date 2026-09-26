/**
 * DOM input wiring: pointer gestures and wheel on the canvas, keyboard on
 * the window. Movement keys are tracked while held; `beforeTick` re-queues
 * the held direction so the player keeps walking at a constant pace.
 */

import type { World } from '../core/index.ts';
import { Gestures, type GestureHandlers } from './gestures.ts';
import { heldDirection, MOVE_KEYS } from './keys.ts';

export interface InputHandlers extends GestureHandlers {
  /** Non-movement key presses (`KeyboardEvent.code`), without auto-repeat. */
  key(code: string): void;
}

export class Input {
  private readonly held = new Set<string>();

  constructor(
    el: HTMLElement,
    private readonly world: World,
    on: InputHandlers,
  ) {
    const gestures = new Gestures(on);
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    el.addEventListener('pointerdown', (ev) => {
      // Only the primary mouse button pans/clicks; touch and pen always count.
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      gestures.down(ev.pointerId, ev.clientX, ev.clientY);
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
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (MOVE_KEYS[ev.code]) {
        ev.preventDefault();
        this.held.add(ev.code);
        if (!ev.repeat) this.queueHeld();
      } else if (!ev.repeat) {
        if (ev.code === 'Space') ev.preventDefault();
        on.key(ev.code);
      }
    });
    window.addEventListener('keyup', (ev) => this.held.delete(ev.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  /** Call right before each sim tick. */
  beforeTick(): void {
    this.queueHeld();
  }

  private queueHeld(): void {
    const d = heldDirection(this.held);
    if (d) this.world.queueIntent({ kind: 'step', ...d });
  }
}
