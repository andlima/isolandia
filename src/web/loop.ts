/**
 * Fixed-timestep accumulator. `advance(elapsedMs)` runs as many whole ticks
 * as fit in the accumulated time, capped at `maxTicksPerFrame`; any backlog
 * beyond the cap is dropped (the sim slows down instead of spiralling).
 *
 * The shell's pace (`setPace`) scales it: at speed `s` wall time counts `s`
 * times over and the cap is `s × maxTicksPerFrame`; while paused nothing
 * accumulates and `alpha` stays frozen. The accumulator holds sim time and is
 * always under one tick after `advance`, so unpausing or changing speed never
 * gives a burst of catch-up ticks.
 */
export class FixedTickLoop {
  readonly tickMs: number;
  readonly maxTicksPerFrame: number;
  private accumulator = 0;
  private speed = 1;
  private paused = false;
  /** Total backlog time dropped because of the cap (ms of sim time). */
  droppedMs = 0;

  constructor(
    private readonly step: () => void,
    opts: { ticksPerSecond: number; maxTicksPerFrame?: number },
  ) {
    this.tickMs = 1000 / opts.ticksPerSecond;
    this.maxTicksPerFrame = opts.maxTicksPerFrame ?? 5;
  }

  /** Pause and speed (from `Pace`); cheap to call every frame. */
  setPace(paused: boolean, speed: number): void {
    this.paused = paused;
    this.speed = speed;
  }

  /** The tick cap of one `advance` at the current speed. */
  get frameCap(): number {
    return this.maxTicksPerFrame * this.speed;
  }

  /** Returns the number of ticks run. */
  advance(elapsedMs: number): number {
    if (this.paused) return 0;
    this.accumulator += Math.max(0, elapsedMs) * this.speed;
    const cap = this.frameCap;
    let ticks = 0;
    while (this.accumulator >= this.tickMs && ticks < cap) {
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
