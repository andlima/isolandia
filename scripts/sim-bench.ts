// Headless sim tick-time benchmarks, without any rendering.
//
// Spike (S0) and stress worlds:
//   npm run bench:sim [-- --seed 1337 --ticks 600 --burst 100 --n 500,2000]
// The real World on a shipped game, with the player walking a fixed route
// across the map so the active area moves (docs/perf.md):
//   npm run bench:sim -- --packs std,std-needs,town,zombie [--ticks 3000] [--seed 1] [--active-radius 64|none]
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Sim } from '../spike/sim/sim.ts';
import { mean, percentile } from '../spike/sim/stats.ts';
import { generateWorld } from '../spike/sim/world.ts';
import { formatError, loadPacks, World, type Definition, type PackSource } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    ticks: { type: 'string' },
    burst: { type: 'string', default: '100' },
    n: { type: 'string', default: '500,2000' },
    packs: { type: 'string' },
    'active-radius': { type: 'string' },
  },
});

function fmt(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

if (values.packs) {
  benchWorld(values.packs.split(','), Number(values.seed ?? 1), Number(values.ticks ?? 3000), values['active-radius']);
  process.exit(0);
}

/**
 * The real World on a shipped game: load, create, then step `ticks` times
 * while the player walks between waypoints near the map's corners and centre
 * (re-planned whenever it stops). Reports tick times, active and dormant
 * entities, and A* expansions per tick.
 */
function benchWorld(names: string[], seed: number, ticks: number, radius: string | undefined): void {
  const t0 = performance.now();
  const r = loadPacks(names.map((n) => readPack(`packs/${n}`)));
  if (!r.ok) {
    for (const e of r.errors) console.error(formatError(e));
    process.exit(1);
  }
  let def: Definition = r.definition;
  if (radius !== undefined) {
    const activeRadius = radius === 'none' ? null : Number(radius);
    def = { ...def, start: { ...def.start, simulation: { ...def.start.simulation, activeRadius } } };
  }
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  const w = World.create(def, seed);
  const createMs = performance.now() - t1;
  const { width, height } = w.grid;
  const route = [
    [0.5, 0.5],
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
    [0.5, 0.5],
  ].map(([fx, fy]) => ({ x: Math.floor(fx! * (width - 1)), y: Math.floor(fy! * (height - 1)) }));
  let leg = 0;
  const times = new Float64Array(ticks);
  const expanded = new Float64Array(ticks);
  let activeSum = 0;
  let activeMin = Infinity;
  let activeMax = 0;
  for (let t = 0; t < ticks; t++) {
    const p = w.player;
    if (!p.path && !p.intent) {
      // Next waypoint (skipping ones that cannot be reached), or wait at the end of the route.
      if (leg < route.length && w.lastGoto && w.lastGoto.tick === w.tick - 1 && !w.lastGoto.ok) leg++;
      while (leg < route.length && Math.max(Math.abs(p.x - route[leg]!.x), Math.abs(p.y - route[leg]!.y)) <= 1) leg++;
      if (leg < route.length) w.queueIntent({ kind: 'goto', x: route[leg]!.x, y: route[leg]!.y, z: 0, adjacent: true });
    }
    const active = w.activeCount;
    activeSum += active;
    activeMin = Math.min(activeMin, active);
    activeMax = Math.max(activeMax, active);
    const e0 = w.pathStats.expanded;
    const s = performance.now();
    w.step();
    times[t] = performance.now() - s;
    expanded[t] = w.pathStats.expanded - e0;
  }
  let max = 0;
  for (const x of times) if (x > max) max = x;
  let emax = 0;
  for (const x of expanded) if (x > emax) emax = x;
  const st = w.pathStats;
  const n = w.entities.length;
  const map = def.maps[def.start.map]!;
  console.log(`${names.join(',')}: ${map.id} ${width}×${height}×${w.grid.floors}, ${n} entities, seed ${seed}, ${ticks} ticks (Node ${process.version})`);
  console.log(`active radius ${def.start.simulation.activeRadius ?? 'none'}; load ${loadMs.toFixed(0)} ms, create ${createMs.toFixed(0)} ms; player reached waypoint ${leg}/${route.length}\n`);
  console.log('| tick avg | tick p95 | tick max | active avg (min–max) | dormant avg | A* expanded/tick avg | max | searches | region rejects | budget hits |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  const activeAvg = activeSum / ticks;
  console.log(
    `| ${fmt(mean(times))} | ${fmt(percentile(times, 95))} | ${fmt(max)} | ${activeAvg.toFixed(0)} (${activeMin}–${activeMax}) | ${(n - activeAvg).toFixed(0)} | ${mean(expanded).toFixed(1)} | ${emax} | ${st.searches} | ${st.regionRejects} | ${st.budgetHits} |`,
  );
}

const seed = Number(values.seed ?? 1337);
const ticks = Number(values.ticks ?? 600);
const burst = Math.min(Number(values.burst), ticks);
const counts = values.n.split(',').map(Number);

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

const worldTicks = ticks * 5;
console.log(`\nWorld.step(), ${SIZE}×${SIZE} map, ${worldTicks} ticks\n`);
console.log('| variant | entities | ticks/s | avg tick |');
console.log('|---|---|---|---|');
const variants: [string, () => PackSource[]][] = [
  ['town+zombie', () => ['packs/std', 'packs/std-needs', 'packs/town', 'packs/zombie'].map(readPack)],
  ['town+vampire', () => ['packs/std', 'packs/std-needs', 'packs/town', 'packs/vampire'].map(readPack)],
  ['std+garden', () => ['packs/std', 'packs/garden'].map(readPack)],
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
