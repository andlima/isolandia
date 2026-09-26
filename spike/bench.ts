import type { Grid } from './sim/grid.ts';
import { mean, percentile } from './sim/stats.ts';
import { worldToIso, type CameraState } from './render/iso.ts';

const WARMUP_S = 1;
const SWEEP_ZOOM = 0.75;
const OVERVIEW_ZOOM = 0.2;
/** Fraction of the run spent in the serpentine sweep; the rest is a whole-map overview. */
const SWEEP_FRACTION = 0.8;

interface PhaseSamples {
  frameMs: number[];
  cpuMs: number[];
  visibleEntities: number[];
}

export interface PhaseResult {
  frames: number;
  fpsAvg: number;
  fpsP5: number;
  fpsMin: number;
  frameMsP95: number;
  cpuMsAvg: number;
  cpuMsP95: number;
  visibleEntitiesAvg: number;
}

export interface BenchResult extends PhaseResult {
  entities: number;
  seed: number;
  durationS: number;
  tickMsAvg: number;
  tickMsP95: number;
  ticks: number;
  pathRequests: number;
  renderer: string;
  gpu: string;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number; resolution: number };
  phases: { sweep: PhaseResult; overview: PhaseResult };
}

/**
 * Deterministic camera path: a 1 s warm-up on the map's start corner, then a
 * serpentine sweep over every chunk row at zoom 0.75, then a zoomed-out view
 * of the whole map (every entity and block visible — the worst case for
 * sorting and draw calls). The path depends only on elapsed time.
 */
export class BenchRunner {
  readonly durationS: number;
  private readonly grid: Grid;
  private readonly sweep: PhaseSamples = { frameMs: [], cpuMs: [], visibleEntities: [] };
  private readonly overview: PhaseSamples = { frameMs: [], cpuMs: [], visibleEntities: [] };
  private readonly tickMs: number[] = [];
  private startMs = -1;
  done = false;

  constructor(durationS: number, grid: Grid) {
    this.durationS = durationS;
    this.grid = grid;
  }

  /** Measured time elapsed (excludes warm-up), in seconds. */
  elapsed(nowMs: number): number {
    if (this.startMs < 0) this.startMs = nowMs;
    return (nowMs - this.startMs) / 1000 - WARMUP_S;
  }

  camera(nowMs: number, viewW: number, viewH: number): CameraState {
    const t = Math.max(0, this.elapsed(nowMs));
    const f = Math.min(1, t / this.durationS);
    const { width, height, chunkSize } = this.grid;
    let wx: number;
    let wy: number;
    let zoom: number;
    if (f < SWEEP_FRACTION) {
      // Serpentine over chunk rows: row r runs along x at y = centre of chunk row r.
      const rows = height / chunkSize;
      const rowLen = width;
      const total = rows * rowLen + (rows - 1) * chunkSize;
      let d = (f / SWEEP_FRACTION) * total;
      let r = 0;
      wx = 0;
      wy = chunkSize / 2;
      for (; r < rows; r++) {
        wy = r * chunkSize + chunkSize / 2;
        if (d <= rowLen) {
          wx = r % 2 === 0 ? d : rowLen - d;
          break;
        }
        d -= rowLen;
        if (d <= chunkSize) {
          wx = r % 2 === 0 ? rowLen : 0;
          wy += d;
          break;
        }
        d -= chunkSize;
      }
      zoom = SWEEP_ZOOM;
    } else {
      wx = width / 2;
      wy = height / 2;
      zoom = OVERVIEW_ZOOM;
    }
    const p = worldToIso(wx, wy);
    return { zoom, offsetX: viewW / 2 - p.x * zoom, offsetY: viewH / 2 - p.y * zoom };
  }

  recordFrame(nowMs: number, frameMs: number, cpuMs: number, visibleEntities: number): void {
    const t = this.elapsed(nowMs);
    if (t < 0 || this.done) return;
    const phase = t / this.durationS < SWEEP_FRACTION ? this.sweep : this.overview;
    phase.frameMs.push(frameMs);
    phase.cpuMs.push(cpuMs);
    phase.visibleEntities.push(visibleEntities);
  }

  recordTick(nowMs: number, tickMs: number): void {
    if (this.elapsed(nowMs) >= 0 && !this.done) this.tickMs.push(tickMs);
  }

  finished(nowMs: number): boolean {
    return this.elapsed(nowMs) >= this.durationS;
  }

  result(meta: Pick<BenchResult, 'entities' | 'seed' | 'pathRequests' | 'renderer' | 'gpu' | 'userAgent' | 'viewport'>): BenchResult {
    this.done = true;
    const all: PhaseSamples = {
      frameMs: [...this.sweep.frameMs, ...this.overview.frameMs],
      cpuMs: [...this.sweep.cpuMs, ...this.overview.cpuMs],
      visibleEntities: [...this.sweep.visibleEntities, ...this.overview.visibleEntities],
    };
    return {
      ...meta,
      durationS: this.durationS,
      ...summarize(all),
      tickMsAvg: round(mean(this.tickMs)),
      tickMsP95: round(percentile(this.tickMs, 95)),
      ticks: this.tickMs.length,
      phases: { sweep: summarize(this.sweep), overview: summarize(this.overview) },
    };
  }
}

function summarize(s: PhaseSamples): PhaseResult {
  const fps = s.frameMs.map((ms) => 1000 / Math.max(ms, 1e-3));
  const totalMs = s.frameMs.reduce((a, b) => a + b, 0);
  return {
    frames: s.frameMs.length,
    fpsAvg: round(totalMs > 0 ? (1000 * s.frameMs.length) / totalMs : 0),
    fpsP5: round(percentile(fps, 5)),
    fpsMin: round(fps.length ? fps.reduce((a, b) => Math.min(a, b), Infinity) : 0),
    frameMsP95: round(percentile(s.frameMs, 95)),
    cpuMsAvg: round(mean(s.cpuMs)),
    cpuMsP95: round(percentile(s.cpuMs, 95)),
    visibleEntitiesAvg: Math.round(mean(s.visibleEntities)),
  };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
