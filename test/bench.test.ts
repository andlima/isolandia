import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoToScreen, MIN_ZOOM, worldToIso } from '../src/iso/projection.ts';
import {
  benchCamera,
  benchPhase,
  BenchRun,
  benchSummaryLines,
  emptySamples,
  mean,
  OVERVIEW_ZOOM,
  percentile,
  summarizeBench,
  summarizePhase,
  SWEEP_FRACTION,
  SWEEP_ZOOM,
  sweepCellsPerSecond,
  sweepLength,
  sweepPosition,
  sweepRows,
  WARMUP_S,
  type BenchMap,
  type BenchMeta,
} from '../src/web/bench.ts';
import { parseParams } from '../src/web/params.ts';
import { Samples } from '../src/web/perf.ts';

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} != ${b}`);

/** A city-sized map: 22 chunk rows, the last one partial. */
const CITY: BenchMap = { width: 343, height: 343, chunk: 16 };
const SMALL: BenchMap = { width: 32, height: 32, chunk: 16 };
const VIEW = { w: 1920, h: 1080 };
const PLAYER = worldToIso(100.5, 50.5);

// ── Params ────────────────────────────────────────────────────────────────

test('params: ?bench= is a positive whole number of seconds, 0 when absent, an error otherwise', () => {
  assert.equal(parseParams('?packs=a').bench, 0);
  assert.equal(parseParams('?packs=a&bench=30').bench, 30);
  assert.deepEqual(parseParams('?packs=a&bench=30').errors, []);
  for (const bad of ['0', '-5', '1.5', 'abc', '']) {
    const p = parseParams(`?packs=a&bench=${bad}`);
    assert.equal(p.bench, 0);
    assert.deepEqual(p.errors, [`?bench= expects a positive whole number of seconds, got '${bad}'`]);
  }
  // Without packs the value is parsed (the title screen ignores it).
  assert.deepEqual(parseParams('?bench=10'), { packs: null, seed: 1, bench: 10, errors: [] });
});

// ── Phases ────────────────────────────────────────────────────────────────

test('bench phases: warm-up below 0, the sweep for 80 % of the duration, then the overview, then done', () => {
  assert.equal(WARMUP_S, 1);
  assert.equal(SWEEP_FRACTION, 0.8);
  assert.equal(benchPhase(-0.5, 10), 'warmup');
  assert.equal(benchPhase(0, 10), 'sweep');
  assert.equal(benchPhase(7.999, 10), 'sweep');
  assert.equal(benchPhase(8, 10), 'overview');
  assert.equal(benchPhase(9.999, 10), 'overview');
  assert.equal(benchPhase(10, 10), 'done');
  assert.equal(benchPhase(48 - 1e-9, 60), 'sweep');
  assert.equal(benchPhase(48, 60), 'overview');
});

// ── Sweep ─────────────────────────────────────────────────────────────────

test('sweep: starts on row 0 at the map edge and runs the rows as a serpentine, hopping one chunk between rows', () => {
  assert.equal(sweepRows(CITY), 22);
  assert.equal(sweepLength(CITY), 22 * 343 + 21 * 16);
  assert.deepEqual(sweepPosition(0, CITY), { x: 0, y: 8, row: 0 });
  // Mid first row: x grows, y stays on the row's centre line.
  const quarterRow = 343 / 2 / sweepLength(CITY);
  const mid = sweepPosition(quarterRow, CITY);
  close(mid.x, 171.5);
  assert.equal(mid.y, 8);
  assert.equal(mid.row, 0);
  // The end of row 0, the hop, the start of row 1 (which runs backwards).
  const L = sweepLength(CITY);
  assert.deepEqual(sweepPosition(343 / L, CITY), { x: 343, y: 8, row: 0 });
  const hop = sweepPosition((343 + 8) / L, CITY);
  assert.equal(hop.x, 343);
  close(hop.y, 16);
  assert.equal(hop.row, 1, 'the hop crosses into the next row at its boundary');
  assert.equal(sweepPosition((343 + 4) / L, CITY).row, 0);
  const row1 = sweepPosition((343 + 16 + 100) / L, CITY);
  close(row1.x, 243);
  assert.equal(row1.y, 24);
  assert.equal(row1.row, 1);
  // The end: the last (odd) row finishes at x = 0; the partial row's centre line stays inside the map.
  const end = sweepPosition(1, CITY);
  assert.equal(end.row, 21);
  close(end.x, 0);
  assert.equal(end.y, 342.5);
  // Out-of-range fractions clamp.
  assert.deepEqual(sweepPosition(-1, CITY), sweepPosition(0, CITY));
  assert.deepEqual(sweepPosition(2, CITY), sweepPosition(1, CITY));
});

test('sweep: every chunk row is visited, in order, and y stays inside its row', () => {
  for (const map of [CITY, SMALL, { width: 100, height: 40, chunk: 16 }]) {
    const rows = sweepRows(map);
    const seen: number[] = [];
    for (let i = 0; i <= 4000; i++) {
      const p = sweepPosition(i / 4000, map);
      if (seen[seen.length - 1] !== p.row) seen.push(p.row);
      assert.ok(p.x >= 0 && p.x <= map.width, `x ${p.x} inside the map`);
      assert.ok(p.y >= p.row * map.chunk && p.y <= Math.min((p.row + 1) * map.chunk, map.height), `y ${p.y} inside row ${p.row}`);
      assert.ok(p.y < map.height, 'y inside the map');
    }
    assert.deepEqual(seen, Array.from({ length: rows }, (_, r) => r), `rows of ${map.width}×${map.height}`);
  }
});

test('sweep: the speed depends on the map and the duration (the whole map in 80 % of the run)', () => {
  close(sweepCellsPerSecond(SMALL, 10), 80 / 8);
  close(sweepCellsPerSecond(CITY, 60), (22 * 343 + 21 * 16) / 48);
  close(sweepCellsPerSecond(CITY, 30), 2 * sweepCellsPerSecond(CITY, 60));
});

// ── Camera ────────────────────────────────────────────────────────────────

test('bench camera: the warm-up centres the player at 1×, the sweep runs at 0.75 from row 0, the overview centres the map at MIN_ZOOM', () => {
  assert.equal(SWEEP_ZOOM, 0.75);
  assert.equal(OVERVIEW_ZOOM, MIN_ZOOM);
  const centre = (cam: ReturnType<typeof benchCamera>, p: { x: number; y: number }) => {
    const s = isoToScreen(p.x, p.y, cam);
    close(s.x, VIEW.w / 2);
    close(s.y, VIEW.h / 2);
  };
  const warm = benchCamera(-0.5, 10, CITY, VIEW.w, VIEW.h, PLAYER);
  assert.equal(warm.zoom, 1);
  centre(warm, PLAYER);
  const start = benchCamera(0, 10, CITY, VIEW.w, VIEW.h, PLAYER);
  assert.equal(start.zoom, SWEEP_ZOOM);
  centre(start, worldToIso(0, 8));
  const quarter = benchCamera(2, 10, CITY, VIEW.w, VIEW.h, PLAYER);
  assert.equal(quarter.zoom, SWEEP_ZOOM);
  centre(quarter, worldToIso(sweepPosition(0.25, CITY).x, sweepPosition(0.25, CITY).y));
  const lastSweep = benchCamera(8 - 1e-9, 10, CITY, VIEW.w, VIEW.h, PLAYER);
  assert.equal(lastSweep.zoom, SWEEP_ZOOM);
  const over = benchCamera(8, 10, CITY, VIEW.w, VIEW.h, PLAYER);
  assert.equal(over.zoom, MIN_ZOOM);
  centre(over, worldToIso(171.5, 171.5));
  assert.deepEqual(benchCamera(9.5, 10, CITY, VIEW.w, VIEW.h, PLAYER), over);
  // The viewport matters only for where the centre is.
  const small = benchCamera(8, 10, CITY, 800, 600, PLAYER);
  const s = isoToScreen(worldToIso(171.5, 171.5).x, worldToIso(171.5, 171.5).y, small);
  close(s.x, 400);
  close(s.y, 300);
});

// ── Summary ───────────────────────────────────────────────────────────────

test('percentile: nearest-rank, as the perf line', () => {
  for (const xs of [[5], [3, 1, 2], [10, 20, 30, 40], Array.from({ length: 100 }, (_, i) => 100 - i)]) {
    const s = new Samples(xs.length);
    for (const x of xs) s.push(x);
    for (const p of [0, 5, 50, 95, 100]) assert.equal(percentile(xs, p), s.percentile(p), `p${p} of ${xs.length}`);
  }
  assert.equal(percentile([], 95), 0);
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
});

test('summarizePhase: fixed samples', () => {
  const r = summarizePhase({ frameMs: [10, 20, 30, 40], cpuMs: [1, 2, 3, 4], visibleEntities: [10, 20, 30, 41], builtChunks: [5, 7, 6, 3], visibleChunks: [1, 2, 3, 4] });
  assert.deepEqual(r, {
    frames: 4,
    fpsAvg: 40,
    fpsP5: 25,
    fpsMin: 25,
    frameMsP95: 40,
    cpuMsAvg: 2.5,
    cpuMsP95: 4,
    visibleEntitiesAvg: 25,
    builtChunksMax: 7,
    visibleChunksAvg: 2.5,
  });
  assert.deepEqual(summarizePhase({ frameMs: [], cpuMs: [], visibleEntities: [], builtChunks: [], visibleChunks: [] }), {
    frames: 0,
    fpsAvg: 0,
    fpsP5: 0,
    fpsMin: 0,
    frameMsP95: 0,
    cpuMsAvg: 0,
    cpuMsP95: 0,
    visibleEntitiesAvg: 0,
    builtChunksMax: 0,
    visibleChunksAvg: 0,
  });
});

const META: BenchMeta = {
  packs: ['base', 'game'],
  map: { id: 'game:m', width: 32, height: 32, floors: 2 },
  entities: 100,
  droppedMs: 0,
  worldEndedAtTick: null,
  renderer: 'webgl',
  gpu: 'Test GPU',
  userAgent: 'test',
  viewport: { width: 1920, height: 1080, devicePixelRatio: 1, resolution: 1 },
  seed: 1,
  durationS: 10,
};

test('summarizeBench: the whole run over both phases, per phase, ticks and entity counts', () => {
  const s = emptySamples();
  s.sweep = { frameMs: [10, 20], cpuMs: [1, 2], visibleEntities: [10, 20], builtChunks: [5, 7], visibleChunks: [1, 2] };
  s.overview = { frameMs: [30, 40], cpuMs: [3, 4], visibleEntities: [30, 41], builtChunks: [6, 3], visibleChunks: [3, 4] };
  s.tickMs = [1, 2, 3, 4, 5];
  s.active = [40, 60];
  s.dormant = [60, 40];
  const r = summarizeBench(s, META, SMALL);
  assert.equal(r.frames, 4);
  assert.equal(r.fpsAvg, 40);
  assert.equal(r.fpsP5, 25);
  assert.equal(r.frameMsP95, 40);
  assert.equal(r.builtChunksMax, 7);
  assert.equal(r.visibleChunksAvg, 2.5);
  assert.equal(r.visibleEntitiesAvg, 25);
  assert.deepEqual(r.phases.sweep, summarizePhase(s.sweep));
  assert.deepEqual(r.phases.overview, summarizePhase(s.overview));
  assert.equal(r.phases.sweep.fpsAvg, 66.67);
  assert.equal(r.phases.overview.fpsAvg, 28.57);
  assert.equal(r.tickMsAvg, 3);
  assert.equal(r.tickMsP95, 5);
  assert.equal(r.ticks, 5);
  assert.equal(r.activeAvg, 50);
  assert.equal(r.dormantAvg, 50);
  assert.equal(r.sweepCellsPerSecond, 10);
  assert.equal(r.durationS, 10);
  assert.deepEqual(r.map, META.map);
  assert.deepEqual(r.packs, ['base', 'game']);
  assert.equal(r.gpu, 'Test GPU');
  assert.equal(r.worldEndedAtTick, null);
  // The JSON round-trips (plain data only).
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  const lines = benchSummaryLines(r);
  assert.equal(lines.length, 7);
  assert.equal(lines[0], 'fps 40 avg · 25 p5 · 25 min');
  assert.equal(lines[3], 'sweep 66.67 fps (p5 50) · overview 28.57 fps (p5 25)');
  assert.equal(lines[5], 'webgl · Test GPU');
  assert.equal(lines[6], 'game:m 32×32×2 · seed 1 · 10 s');
  assert.match(benchSummaryLines({ ...r, worldEndedAtTick: 120 })[6]!, /game ended at tick 120$/);
});

// ── The run ───────────────────────────────────────────────────────────────

test('BenchRun: the clock starts on first use, the warm-up is not measured, frames and ticks land in their phase', () => {
  const run = new BenchRun(10, SMALL);
  const stats = { visibleEntities: 3, builtChunks: 4, visibleChunks: 2 };
  const frame = (now: number) => run.recordFrame(now, { frameMs: 16, cpuMs: 2, stats, active: 5, dormant: 1 });
  assert.equal(run.phase(1000), 'warmup');
  close(run.elapsed(1000), -1);
  frame(1500);
  run.recordTick(1500, 1);
  assert.equal(run.samples.sweep.frameMs.length, 0);
  assert.deepEqual(run.samples.tickMs, []);
  assert.equal(run.progress(1500), 'bench 0.0/10 s · warmup');
  // Measuring starts 1 s after the first call.
  assert.equal(run.phase(2000), 'sweep');
  frame(2000);
  run.recordTick(2100, 2);
  assert.equal(run.phase(9999), 'sweep');
  assert.equal(run.phase(10000), 'overview');
  frame(10000);
  run.recordTick(10000, 3);
  assert.equal(run.progress(10000), 'bench 8.0/10 s · overview');
  assert.equal(run.finished(11999), false);
  assert.equal(run.finished(12000), true);
  assert.equal(run.samples.sweep.frameMs.length, 1);
  assert.equal(run.samples.overview.frameMs.length, 1);
  assert.deepEqual(run.samples.tickMs, [2, 3]);
  assert.deepEqual(run.samples.active, [5, 5]);
  // The camera follows the path on the same clock; after the run it stays on the overview.
  assert.equal(run.camera(1500, 800, 600, PLAYER).zoom, 1);
  assert.equal(run.camera(2000, 800, 600, PLAYER).zoom, SWEEP_ZOOM);
  assert.equal(run.camera(10000, 800, 600, PLAYER).zoom, MIN_ZOOM);
  assert.equal(run.camera(20000, 800, 600, PLAYER).zoom, MIN_ZOOM);
  run.worldEndedAtTick = 42;
  const { durationS: _d, worldEndedAtTick: _w, ...meta } = META;
  const r = run.result(meta);
  assert.ok(run.done);
  assert.equal(run.phase(12000), 'done');
  assert.equal(r.frames, 2);
  assert.equal(r.ticks, 2);
  assert.equal(r.durationS, 10);
  assert.equal(r.worldEndedAtTick, 42);
  assert.equal(r.sweepCellsPerSecond, 10);
  // Nothing is recorded after the result.
  frame(13000);
  run.recordTick(13000, 9);
  assert.equal(run.samples.overview.frameMs.length, 1);
  assert.deepEqual(run.samples.tickMs, [2, 3]);
});
