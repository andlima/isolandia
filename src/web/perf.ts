/**
 * The browser's perf line (toggled with F3): tick time over the last 100
 * ticks, frame rate, active and dormant entities, and render chunks. The
 * meter and the formatting are pure, so they are tested headless.
 */

/** Ring of the last `size` samples. */
export class Samples {
  private readonly values: Float64Array;
  private next = 0;
  private count = 0;

  constructor(readonly size = 100) {
    this.values = new Float64Array(size);
  }

  push(v: number): void {
    this.values[this.next] = v;
    this.next = (this.next + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  get length(): number {
    return this.count;
  }

  /** Mean of the samples (0 when empty). */
  avg(): number {
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.values[i]!;
    return this.count ? sum / this.count : 0;
  }

  /** Nearest-rank percentile `p` in [0, 100] (0 when empty). */
  percentile(p: number): number {
    if (!this.count) return 0;
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((a, b) => a - b);
    const rank = Math.min(this.count - 1, Math.max(0, Math.ceil((p / 100) * this.count) - 1));
    return sorted[rank]!;
  }
}

export interface PerfFigures {
  tickAvg: number;
  tickP95: number;
  fps: number;
  active: number;
  dormant: number;
  builtChunks: number;
  visibleChunks: number;
}

export function perfLine(f: PerfFigures): string {
  return `tick ${f.tickAvg.toFixed(2)}/${f.tickP95.toFixed(2)} ms (avg/p95)  ${Math.round(f.fps)} fps  entities ${f.active} active, ${f.dormant} dormant  chunks ${f.builtChunks} built, ${f.visibleChunks} visible`;
}

/** Tick durations (last 100) and frame intervals (last 100) for the perf line. */
export class PerfMeter {
  readonly ticks = new Samples(100);
  readonly frames = new Samples(100);
  private lastFrame = -1;

  tick(ms: number): void {
    this.ticks.push(ms);
  }

  frame(now: number): void {
    if (this.lastFrame >= 0) this.frames.push(now - this.lastFrame);
    this.lastFrame = now;
  }

  get fps(): number {
    const avg = this.frames.avg();
    return avg > 0 ? 1000 / avg : 0;
  }
}
