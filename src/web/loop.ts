/**
 * Fixed-timestep accumulator. `advance(elapsedMs)` runs as many whole ticks
 * as fit in the accumulated time, capped at `maxTicksPerFrame`; any backlog
 * beyond the cap is dropped (the sim slows down instead of spiralling).
 */
export class FixedTickLoop {
  readonly tickMs: number;
  readonly maxTicksPerFrame: number;
  private accumulator = 0;
  /** Total backlog time dropped because of the cap (ms). */
  droppedMs = 0;

  constructor(
    private readonly step: () => void,
    opts: { ticksPerSecond: number; maxTicksPerFrame?: number },
  ) {
    this.tickMs = 1000 / opts.ticksPerSecond;
    this.maxTicksPerFrame = opts.maxTicksPerFrame ?? 5;
  }

  /** Returns the number of ticks run. */
  advance(elapsedMs: number): number {
    this.accumulator += Math.max(0, elapsedMs);
    let ticks = 0;
    while (this.accumulator >= this.tickMs && ticks < this.maxTicksPerFrame) {
      this.step();
      this.accumulator -= this.tickMs;
      ticks++;
    }
    if (this.accumulator >= this.tickMs) {
      // Keep the partial tick so interpolation stays continuous; drop the rest.
      const keep = this.accumulator % this.tickMs;
      this.droppedMs += this.accumulator - keep;
      this.accumulator = keep;
    }
    return ticks;
  }

  /** Drop the accumulated time (a new world starts on a whole tick). */
  reset(): void {
    this.accumulator = 0;
  }

  /** Interpolation factor in [0, 1) between the current tick and the next. */
  get alpha(): number {
    return this.accumulator / this.tickMs;
  }
}
