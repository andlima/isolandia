/**
 * Shell pacing: pause and game speed. Pure (no DOM or Node APIs) and shared
 * by both shells. This is not world state: it is never saved or hashed, and
 * only changes how many fixed ticks a shell asks for per second of wall time.
 *
 * Two pauses add up: the **manual** one (`P`, the clock card) and the
 * **window** one (the browser's auto-pause option, while a window is open).
 * `togglePause` always flips what the clock card shows: from paused it clears
 * both, and a window pause cleared that way stays off until every window is
 * closed, so closing the window resumes only if `P` was not pressed between.
 */

export const SPEEDS = [1, 2, 4, 8] as const;

export type Speed = (typeof SPEEDS)[number];

export class Pace {
  /** The manual pause. */
  private manual = false;
  /** The auto pause (the option on while a panel is open). */
  private held = false;
  /** `P` cleared the auto pause: it stays off until every panel is closed. */
  private waived = false;
  speed: Speed = 1;

  /** Whether the shell runs no ticks (the manual or the auto pause). */
  get paused(): boolean {
    return this.manual || this.held;
  }

  /** Whether the manual pause is on. */
  get manualPause(): boolean {
    return this.manual;
  }

  /** `Paused`, `1×`, `2×`, … */
  get label(): string {
    return this.paused ? 'Paused' : `${this.speed}×`;
  }

  togglePause(): void {
    if (this.paused) {
      this.manual = false;
      if (this.held) this.waived = true;
      this.held = false;
    } else {
      this.manual = true;
    }
  }

  /** Next speed up (stays at 8×). */
  faster(): void {
    this.setSpeed(SPEEDS[Math.min(SPEEDS.indexOf(this.speed) + 1, SPEEDS.length - 1)]!);
  }

  /** Next speed down (stays at 1×). */
  slower(): void {
    this.setSpeed(SPEEDS[Math.max(SPEEDS.indexOf(this.speed) - 1, 0)]!);
  }

  /** The clock card's speed button: `1× → 2× → 4× → 8× → 1×`. */
  cycleSpeed(): void {
    this.setSpeed(SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length]!);
  }

  /** Set the speed; a value that is not one of `SPEEDS` is ignored. */
  setSpeed(n: number): void {
    if ((SPEEDS as readonly number[]).includes(n)) this.speed = n as Speed;
  }

  /**
   * The window pause, once per frame: `open` when any window that
   * auto-pauses is open, `autoPause` when the option is on.
   */
  windows(open: boolean, autoPause: boolean): void {
    if (!open) this.waived = false;
    this.held = autoPause && open && !this.waived;
  }
}
