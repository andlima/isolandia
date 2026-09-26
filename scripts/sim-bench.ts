// Headless sim tick-time benchmark: times Sim.step() without any rendering.
// Usage: npm run bench:sim [-- --seed 1337 --ticks 600 --burst 100 --n 500,2000]
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Sim } from '../spike/sim/sim.ts';
import { mean, percentile } from '../spike/sim/stats.ts';
import { generateWorld } from '../spike/sim/world.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1337' },
    ticks: { type: 'string', default: '600' },
    burst: { type: 'string', default: '100' },
    n: { type: 'string', default: '500,2000' },
  },
});
const seed = Number(values.seed);
const ticks = Number(values.ticks);
const burst = Math.min(Number(values.burst), ticks);
const counts = values.n.split(',').map(Number);

const fmt = (ms: number): string => `${ms.toFixed(2)} ms`;
const row = (xs: Float64Array): string[] => {
  let max = 0;
  for (const x of xs) if (x > max) max = x;
  return [fmt(mean(xs)), fmt(percentile(xs, 95)), fmt(max)];
};

console.log(`seed ${seed}, ${ticks} ticks, first ${burst} = burst (Node ${process.version})\n`);
console.log('| n | burst avg | burst p95 | burst max | steady avg | steady p95 | steady max |');
console.log('|---|---|---|---|---|---|---|');
for (const n of counts) {
  const sim = new Sim(generateWorld({ seed }), { entityCount: n, seed });
  const times = new Float64Array(ticks);
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now();
    sim.step();
    times[t] = performance.now() - t0;
  }
  const cells = [...row(times.subarray(0, burst)), ...row(times.subarray(burst))];
  console.log(`| ${n} | ${cells.join(' | ')} |`);
}
