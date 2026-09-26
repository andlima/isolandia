/** Fixed-size ring buffer of samples with avg / percentile helpers (no DOM). */
export class RollingStats {
  private readonly buf: Float64Array;
  private count = 0;
  private head = 0;

  constructor(capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  get size(): number {
    return this.count;
  }

  values(): Float64Array {
    return this.buf.slice(0, this.count);
  }

  avg(): number {
    return mean(this.values());
  }

  percentile(p: number): number {
    return percentile(this.values(), p);
  }
}

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}

/** Nearest-rank percentile, p in [0, 100]. */
export function percentile(xs: ArrayLike<number>, p: number): number {
  if (xs.length === 0) return 0;
  const sorted = Float64Array.from(xs).sort();
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}
