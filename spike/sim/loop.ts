/**
 * Fixed-timestep accumulator. `advance(elapsedMs)` runs as many whole ticks as
 * fit in the accumulated time, capped at `maxTicksPerFrame`. When the cap is
 * hit, the backlog is dropped (the sim slows down instead of spiralling).
 */
export class FixedTickLoop {
  readonly tickMs: number;
  readonly maxTicksPerFrame: number;
  private accumulator = 0;
  /** Total backlog time dropped because of the cap (ms). */
  droppedMs = 0;

  constructor(
    private readonly step: () => void,
    opts: { ticksPerSecond?: number; maxTicksPerFrame?: number } = {},
  ) {
    this.tickMs = 1000 / (opts.ticksPerSecond ?? 10);
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

  /** Interpolation factor in [0, 1) between the previous and current tick. */
  get alpha(): number {
    return this.accumulator / this.tickMs;
  }
}
