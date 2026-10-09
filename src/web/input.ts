/**
 * DOM input wiring: pointer gestures (with Shift on clicks), mouse and pen
 * hover, right-click and wheel on the canvas, keyboard on the window. Movement keys are tracked while held. A fresh press
 * queues a turn-in-place step: a tap in a new direction only turns the player,
 * a tap in the faced direction steps. Once the latest press is `HOLD_MS` old,
 * `beforeTick` re-queues the held direction as plain steps so the player
 * walks at a constant pace.
 */

import type { World } from '../core/index.ts';
import { Gestures, type GestureHandlers } from './gestures.ts';
import { climbKey, MOVE_KEYS, MoveKeys, suppressesDefault, type MoveStep } from './keys.ts';

export interface InputHandlers extends Omit<GestureHandlers, 'click'> {
  /** A click or tap; `shift` when Shift was held on release. */
  click(sx: number, sy: number, shift: boolean): void;
  /** A mouse or pen pointer resting over the canvas with no button down, or null when it leaves, drags or presses. */
  hover?(p: { sx: number; sy: number } | null): void;
  /** Non-movement key presses (`KeyboardEvent.code`), without auto-repeat. */
  key(code: string): void;
  /** A climb key (PageUp/PageDown, `<`/`>`): one floor up (1) or down (-1), without auto-repeat. */
  climb?(dz: 1 | -1): void;
  /** Right-click on the canvas (the browser's own menu is suppressed there only). */
  menu(sx: number, sy: number): void;
  /** Offered every key press first (auto-repeat included); true consumes it (e.g. an open menu). */
  captureKey?(code: string): boolean;
  /** True while the shell is paused: movement keys are ignored (no steps or turns). */
  paused?(): boolean;
}

export class Input {
  private readonly moves = new MoveKeys();
  private readonly gestures: Gestures;

  constructor(
    el: HTMLElement,
    /** The running world (it changes when a save is loaded). */
    private readonly world: () => World,
    on: InputHandlers,
    private readonly now: () => number = () => performance.now(),
  ) {
    let shift = false;
    const gestures = (this.gestures = new Gestures({ ...on, click: (sx, sy) => on.click(sx, sy, shift) }));
    const hover = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch') return;
      on.hover?.(ev.buttons === 0 ? { sx: ev.clientX, sy: ev.clientY } : null);
    };
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
      on.hover?.(null);
      gestures.down(ev.pointerId, ev.clientX, ev.clientY, ev.pointerType !== 'mouse');
    });
    el.addEventListener('pointermove', (ev) => {
      gestures.move(ev.pointerId, ev.clientX, ev.clientY);
      hover(ev);
    });
    el.addEventListener('pointerleave', () => on.hover?.(null));
    el.addEventListener('pointerup', (ev) => {
      shift = ev.shiftKey;
      gestures.up(ev.pointerId, ev.clientX, ev.clientY);
    });
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
        if (on.paused?.()) return;
        this.queue(this.moves.down(ev.code, ev.repeat, this.now()));
      } else if (!ev.repeat) {
        on.key(ev.code);
      }
    });
    window.addEventListener('keyup', (ev) => this.moves.up(ev.code));
    window.addEventListener('blur', () => this.moves.clear());
  }

  /** Forget held movement keys (the shell paused): a key held through the pause must be pressed again. */
  clearMoves(): void {
    this.moves.clear();
  }

  /** Call once per frame: fires a pending long-press. */
  frame(now: number): void {
    this.gestures.tick(now);
  }

  /**
   * Call right before each sim tick. Once the key has been held for
   * `HOLD_MS`, re-queues the held direction as a plain step, only on the tick
   * where the player can step again, so releasing a key between ticks never
   * leaves a stale step queued. Before that, the pending turn is left alone.
   */
  beforeTick(): void {
    this.queue(this.moves.repeat(this.now(), this.world().player.moveCooldown));
  }

  private queue(step: MoveStep | null): void {
    if (step) this.world().queueIntent(step);
  }
}
