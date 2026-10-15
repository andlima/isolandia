/**
 * Browser benchmark for the game page (`?bench=<seconds>`): a deterministic
 * camera path over the loaded map and a summary of what frames and ticks
 * cost. Everything here is pure (no DOM, no Pixi): `main.ts` drives a
 * `BenchRun` from its frame loop and `bench-dom.ts` shows the result.
 *
 * The path, after the S0 spike's `BenchRunner.camera`: a 1 s **warm-up** on
 * the player (not measured), then `SWEEP_FRACTION` of the duration in a
 * **serpentine sweep** over every render-chunk row of the map at
 * `SWEEP_ZOOM`, then the rest as an **overview** of the map centre at
 * `MIN_ZOOM`. The sweep covers the whole map whatever the duration, so its
 * speed depends on the map (`sweepCellsPerSecond`). Percentiles are
 * nearest-rank, as the perf line's `Samples.percentile`.
 */

import { cameraAt, MIN_ZOOM, worldToIso, type CameraState, type Point } from '../iso/projection.ts';
import type { SceneStats } from '../iso/scene.ts';

/** Seconds spent on the player before measuring starts. */
export const WARMUP_S = 1;
export const SWEEP_ZOOM = 0.75;
export const OVERVIEW_ZOOM = MIN_ZOOM;
/** Fraction of the measured duration spent in the sweep; the rest is the overview. */
export const SWEEP_FRACTION = 0.8;
/** The camera's zoom during the warm-up (the play default). */
const WARMUP_ZOOM = 1;

export type BenchPhase = 'warmup' | 'sweep' | 'overview' | 'done';

/** The map the path covers: its size in cells and the render chunk size. */
export interface BenchMap {
  readonly width: number;
  readonly height: number;
  readonly chunk: number;
}

// ── Path ──────────────────────────────────────────────────────────────────

/** The phase at measured time `t` (seconds since the warm-up ended; negative during it). */
export function benchPhase(t: number, durationS: number): BenchPhase {
  if (t < 0) return 'warmup';
  if (t >= durationS) return 'done';
  return t / durationS < SWEEP_FRACTION ? 'sweep' : 'overview';
}

/** Number of chunk rows the sweep visits. */
export function sweepRows(map: BenchMap): number {
  return Math.max(1, Math.ceil(map.height / map.chunk));
}

/** Length of the sweep in cells: every chunk row across the map plus the hops between rows. */
export function sweepLength(map: BenchMap): number {
  const rows = sweepRows(map);
  return rows * map.width + (rows - 1) * map.chunk;
}

/** Cells per second the sweep moves at for a run of `durationS`. */
export function sweepCellsPerSecond(map: BenchMap, durationS: number): number {
  return sweepLength(map) / (SWEEP_FRACTION * durationS);
}

/** The y the camera follows along chunk row `row`: its centre line, inside the map on a partial last row. */
function rowCentre(map: BenchMap, row: number): number {
  return Math.min(row * map.chunk + map.chunk / 2, map.height - 0.5);
}

/**
 * Where the sweep is at fraction `f` ∈ [0, 1] of its length: the continuous
 * cell position and the chunk row. Even rows run left to right (x up), odd
 * rows back; between rows the camera hops one chunk down at the row's end.
 */
export function sweepPosition(f: number, map: BenchMap): { x: number; y: number; row: number } {
  const rows = sweepRows(map);
  let d = Math.min(1, Math.max(0, f)) * sweepLength(map);
  for (let r = 0; r < rows; r++) {
    const forward = r % 2 === 0;
    if (d <= map.width || r === rows - 1) {
      const x = Math.min(d, map.width);
      return { x: forward ? x : map.width - x, y: rowCentre(map, r), row: r };
    }
    d -= map.width;
    if (d <= map.chunk) {
      const y0 = rowCentre(map, r);
      const y = y0 + (d / map.chunk) * (rowCentre(map, r + 1) - y0);
      return { x: forward ? map.width : 0, y, row: y < (r + 1) * map.chunk ? r : r + 1 };
    }
    d -= map.chunk;
  }
  return { x: 0, y: rowCentre(map, 0), row: 0 };
}

/**
 * The camera at measured time `t` (seconds; negative during the warm-up) of
 * a run of `durationS` over `map` in a `viewW`×`viewH` viewport. `player` is
 * the player's iso point, where the warm-up looks.
 */
export function benchCamera(t: number, durationS: number, map: BenchMap, viewW: number, viewH: number, player: Point): CameraState {
  const phase = benchPhase(t, durationS);
  const cx = viewW / 2;
  const cy = viewH / 2;
  if (phase === 'warmup') return cameraAt(player.x, player.y, cx, cy, WARMUP_ZOOM);
  if (phase === 'sweep') {
    const p = sweepPosition(t / durationS / SWEEP_FRACTION, map);
    const iso = worldToIso(p.x, p.y);
    return cameraAt(iso.x, iso.y, cx, cy, SWEEP_ZOOM);
  }
  const iso = worldToIso(map.width / 2, map.height / 2);
  return cameraAt(iso.x, iso.y, cx, cy, OVERVIEW_ZOOM);
}

// ── Samples and summary ───────────────────────────────────────────────────

/** Per-frame samples of one phase (parallel arrays). */
export interface PhaseSamples {
  frameMs: number[];
  cpuMs: number[];
  visibleEntities: number[];
  builtChunks: number[];
  visibleChunks: number[];
}

export interface BenchSamples {
  sweep: PhaseSamples;
  overview: PhaseSamples;
  /** Tick durations, every measured tick. */
  tickMs: number[];
  /** Active and dormant entity counts, sampled once per measured frame. */
  active: number[];
  dormant: number[];
}

export function emptyPhase(): PhaseSamples {
  return { frameMs: [], cpuMs: [], visibleEntities: [], builtChunks: [], visibleChunks: [] };
}

export function emptySamples(): BenchSamples {
  return { sweep: emptyPhase(), overview: emptyPhase(), tickMs: [], active: [], dormant: [] };
}

/** The figures of one phase (and, over both phases, of the whole run). */
export interface BenchPhaseResult {
  frames: number;
  fpsAvg: number;
  fpsP5: number;
  fpsMin: number;
  frameMsP95: number;
  cpuMsAvg: number;
  cpuMsP95: number;
  visibleEntitiesAvg: number;
  builtChunksMax: number;
  visibleChunksAvg: number;
}

/** What the shell knows about the run that the samples do not. */
export interface BenchMeta {
  /** The resolved pack directories. */
  packs: string[];
  map: { id: string; width: number; height: number; floors: number };
  entities: number;
  /** The loop's backlog dropped under its tick cap (ms of sim time): the sim could not keep up. */
  droppedMs: number;
  /** The tick the game ended on (defeat or victory) during the run, else null; the run goes on regardless. */
  worldEndedAtTick: number | null;
  /** `webgl` or `webgpu` (Pixi's renderer name). */
  renderer: string;
  /** The unmasked GPU string (`SwiftShader` or `llvmpipe` mean software rendering). */
  gpu: string;
  userAgent: string;
  viewport: { width: number; height: number; devicePixelRatio: number; resolution: number };
  seed: number;
  durationS: number;
}

export interface BenchResult extends BenchPhaseResult, BenchMeta {
  activeAvg: number;
  dormantAvg: number;
  tickMsAvg: number;
  tickMsP95: number;
  ticks: number;
  sweepCellsPerSecond: number;
  phases: { sweep: BenchPhaseResult; overview: BenchPhaseResult };
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Nearest-rank percentile `p` in [0, 100] (0 when empty), as `Samples.percentile` in `perf.ts`. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return sorted[rank]!;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export function summarizePhase(s: PhaseSamples): BenchPhaseResult {
  const fps = s.frameMs.map((ms) => 1000 / Math.max(ms, 1e-3));
  const totalMs = s.frameMs.reduce((a, b) => a + b, 0);
  return {
    frames: s.frameMs.length,
    fpsAvg: round(totalMs > 0 ? (1000 * s.frameMs.length) / totalMs : 0),
    fpsP5: round(percentile(fps, 5)),
    fpsMin: round(fps.length ? Math.min(...fps) : 0),
    frameMsP95: round(percentile(s.frameMs, 95)),
    cpuMsAvg: round(mean(s.cpuMs)),
    cpuMsP95: round(percentile(s.cpuMs, 95)),
    visibleEntitiesAvg: Math.round(mean(s.visibleEntities)),
    builtChunksMax: s.builtChunks.length ? Math.max(...s.builtChunks) : 0,
    visibleChunksAvg: round(mean(s.visibleChunks)),
  };
}

function concat(a: PhaseSamples, b: PhaseSamples): PhaseSamples {
  return {
    frameMs: [...a.frameMs, ...b.frameMs],
    cpuMs: [...a.cpuMs, ...b.cpuMs],
    visibleEntities: [...a.visibleEntities, ...b.visibleEntities],
    builtChunks: [...a.builtChunks, ...b.builtChunks],
    visibleChunks: [...a.visibleChunks, ...b.visibleChunks],
  };
}

/** The whole run's figures: over both phases, per phase, and the tick and entity figures. */
export function summarizeBench(s: BenchSamples, meta: BenchMeta, map: BenchMap): BenchResult {
  return {
    ...meta,
    ...summarizePhase(concat(s.sweep, s.overview)),
    activeAvg: Math.round(mean(s.active)),
    dormantAvg: Math.round(mean(s.dormant)),
    tickMsAvg: round(mean(s.tickMs)),
    tickMsP95: round(percentile(s.tickMs, 95)),
    ticks: s.tickMs.length,
    sweepCellsPerSecond: round(sweepCellsPerSecond(map, meta.durationS)),
    phases: { sweep: summarizePhase(s.sweep), overview: summarizePhase(s.overview) },
  };
}

/** The key figures as text lines (the on-screen overlay). */
export function benchSummaryLines(r: BenchResult): string[] {
  const phase = (p: BenchPhaseResult) => `${p.fpsAvg} fps (p5 ${p.fpsP5})`;
  const map = `${r.map.id} ${r.map.width}×${r.map.height}${r.map.floors > 1 ? `×${r.map.floors}` : ''}`;
  return [
    `fps ${r.fpsAvg} avg · ${r.fpsP5} p5 · ${r.fpsMin} min`,
    `frame ${r.frameMsP95} ms p95 · cpu ${r.cpuMsAvg} ms avg, ${r.cpuMsP95} p95`,
    `tick ${r.tickMsAvg} ms avg, ${r.tickMsP95} p95 · ${r.ticks} ticks · dropped ${r.droppedMs} ms`,
    `sweep ${phase(r.phases.sweep)} · overview ${phase(r.phases.overview)}`,
    `chunks ${r.builtChunksMax} built max, ${r.visibleChunksAvg} visible avg · entities ${r.visibleEntitiesAvg} visible avg of ${r.entities}`,
    `${r.renderer} · ${r.gpu}`,
    `${map} · seed ${r.seed} · ${r.durationS} s${r.worldEndedAtTick !== null ? ` · game ended at tick ${r.worldEndedAtTick}` : ''}`,
  ];
}

// ── The run ───────────────────────────────────────────────────────────────

/** What a frame feeds the run: the frame's interval and CPU time, the scene stats and the entity counts. */
export interface BenchFrame {
  frameMs: number;
  cpuMs: number;
  stats: Pick<SceneStats, 'visibleEntities' | 'builtChunks' | 'visibleChunks'>;
  active: number;
  dormant: number;
}

/**
 * One benchmark run: the clock starts on the first call that asks the time,
 * frames and ticks are recorded by phase, and `result` summarizes once
 * `finished`.
 */
export class BenchRun {
  readonly samples = emptySamples();
  /** The tick the game ended on during the run (set by the shell), else null. */
  worldEndedAtTick: number | null = null;
  private startMs = -1;
  done = false;

  constructor(
    readonly durationS: number,
    readonly map: BenchMap,
  ) {}

  /** Measured time elapsed in seconds (negative during the warm-up); the first call starts the clock. */
  elapsed(nowMs: number): number {
    if (this.startMs < 0) this.startMs = nowMs;
    return (nowMs - this.startMs) / 1000 - WARMUP_S;
  }

  phase(nowMs: number): BenchPhase {
    return this.done ? 'done' : benchPhase(this.elapsed(nowMs), this.durationS);
  }

  camera(nowMs: number, viewW: number, viewH: number, player: Point): CameraState {
    return benchCamera(Math.min(this.elapsed(nowMs), this.durationS), this.durationS, this.map, viewW, viewH, player);
  }

  recordFrame(nowMs: number, f: BenchFrame): void {
    const phase = this.phase(nowMs);
    if (phase === 'warmup' || phase === 'done') return;
    const s = this.samples[phase];
    s.frameMs.push(f.frameMs);
    s.cpuMs.push(f.cpuMs);
    s.visibleEntities.push(f.stats.visibleEntities);
    s.builtChunks.push(f.stats.builtChunks);
    s.visibleChunks.push(f.stats.visibleChunks);
    this.samples.active.push(f.active);
    this.samples.dormant.push(f.dormant);
  }

  recordTick(nowMs: number, tickMs: number): void {
    const phase = this.phase(nowMs);
    if (phase === 'sweep' || phase === 'overview') this.samples.tickMs.push(tickMs);
  }

  finished(nowMs: number): boolean {
    return this.elapsed(nowMs) >= this.durationS;
  }

  /** `bench 12.3/60 s · sweep` for the overlay while the run goes. */
  progress(nowMs: number): string {
    const t = Math.max(0, this.elapsed(nowMs));
    return `bench ${Math.min(t, this.durationS).toFixed(1)}/${this.durationS} s · ${this.phase(nowMs)}`;
  }

  result(meta: Omit<BenchMeta, 'durationS' | 'worldEndedAtTick'>): BenchResult {
    this.done = true;
    return summarizeBench(this.samples, { ...meta, durationS: this.durationS, worldEndedAtTick: this.worldEndedAtTick }, this.map);
  }
}
