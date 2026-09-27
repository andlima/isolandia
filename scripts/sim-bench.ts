// Headless sim tick-time benchmark: times Sim.step() without any rendering.
// Usage: npm run bench:sim [-- --seed 1337 --ticks 600 --burst 100 --n 500,2000]
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Sim } from '../spike/sim/sim.ts';
import { mean, percentile } from '../spike/sim/stats.ts';
import { generateWorld } from '../spike/sim/world.ts';
import { loadPacks, World, type PackSource } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';

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

// ── World (the real engine) ───────────────────────────────────────────────
// A synthetic in-memory pack: a SIZE×SIZE floor map with one entity on every
// other cell. The `survival` variant adds tile tags, statuses with rates and
// systems with several periods, so their cost shows up next to `plain`.
const SIZE = 64;

function stressPack(survival: boolean): PackSource {
  const rows: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    let row = '';
    for (let x = 0; x < SIZE; x++) row += x === 0 && y === 0 ? '@' : (x + y) % 2 === 0 ? 'e' : (x * 7 + y) % 11 === 0 ? 'w' : '.';
    rows.push(row);
  }
  const content = `
measurements:
  - { id: hp, label: HP, max: 100, initial: 100, rate: -0.05 }
  - { id: food, label: Food, max: 100, initial: 60, rate: "-0.5 - 0.5 * world.is_day" }
tiles:
  - { id: floor, label: Floor, glyph: ".", color: white, walkable: true }
  - { id: well, label: Well, glyph: "w", color: blue, walkable: true${survival ? ', tags: [water]' : ''} }
archetypes:
  - { id: hero, label: Hero, glyph: "@", color: yellow, tags: [living], measurements: [hp, food] }
  - { id: mob, label: Mob, glyph: e, color: red, tags: [living], measurements: [hp, food] }
maps:
  - id: field
    legend:
      ".": { tile: floor }
      "w": { tile: well }
      "e": { tile: floor, spawn: mob }
      "@": { tile: floor, player: true }
    rows:
${rows.map((r) => `      - "${r}"`).join('\n')}
start: { map: field, player: hero }
${
  survival
    ? `
statuses:
  - { id: hungry, label: Hungry, when: "self.food < 30", until: "self.food > 40", rates: { hp: -0.5 } }
  - { id: starving, label: Starving, when: "self.food <= 0", rates: { hp: "-1 - self.has_status(\\"hungry\\")" } }
systems:
  - id: drink
    for: 'self.has_tag("living")'
    when: 'tile.has_tag("water")'
    effects: [{ type: apply, measurement: food, delta: 5 }]
  - id: forage
    every: 1
    when: "self.food < 50"
    effects: [{ type: apply, measurement: food, delta: "random(0, 3)" }]
  - id: rest
    every: 10
    effects: [{ type: set, measurement: hp, value: "min(100, self.hp + 1)" }]
`
    : ''
}`;
  return { label: 'stress', files: { 'pack.yaml': 'namespace: s\nname: Stress\nversion: 1.0.0\n', 'content.yaml': content } };
}

const worldTicks = Number(values.ticks) * 5;
console.log(`\nWorld.step(), ${SIZE}×${SIZE} map, ${worldTicks} ticks\n`);
console.log('| variant | entities | ticks/s | avg tick |');
console.log('|---|---|---|---|');
const variants: [string, () => PackSource[]][] = [
  ['base+zombie', () => [readPack('packs/base'), readPack('packs/zombie')]],
  ['base+vampire', () => [readPack('packs/base'), readPack('packs/vampire')]],
  ['stress plain', () => [stressPack(false)]],
  ['stress survival', () => [stressPack(true)]],
];
for (const [name, packs] of variants) {
  const r = loadPacks(packs());
  if (!r.ok) {
    console.log(`| ${name} | – | load failed: ${r.errors[0]!.message} | – |`);
    continue;
  }
  const w = World.create(r.definition, seed);
  for (let t = 0; t < 100; t++) w.step(); // warm-up
  const t0 = performance.now();
  for (let t = 0; t < worldTicks; t++) w.step();
  const ms = performance.now() - t0;
  console.log(`| ${name} | ${w.entities.length} | ${Math.round((worldTicks / ms) * 1000)} | ${fmt(ms / worldTicks)} |`);
}
