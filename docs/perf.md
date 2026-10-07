# Performance (M6 chunked world)

Spec: `specs/m6-chunked-world.md`. The target is the zombie **city** (the
`town` base's city, populated by the `zombie` mod since M7): a
343×343 composite map (roomier since `roomier-maps`; 256×256 before),
two floors in places, ~960 entities, at the 10 Hz tick. Recorded target (not a test gate): **steady p95 ≤ 10 ms per tick in
Node** on the dev machine.

## How to run

```bash
npm run bench:sim -- --packs std,std-needs,town,zombie [--ticks 3000] [--seed 1] [--active-radius 64|none]
npm run bench:sim -- --packs std,std-needs,town,vampire
npm run bench:sim                     # the S0 spike and stress worlds, unchanged
```

`--packs` runs the **real** `World` on a shipped game, with no rendering.
The player walks a fixed route (map centre → the four corners at 10 % / 90 %
→ centre, re-planned whenever it stops, a waypoint counting as reached
within one tile), so the active area moves across the map. It reports tick
avg/p95/max, active entities (avg, min–max), dormant entities, A*
expansions per tick (avg, max) and the search counters (`world.pathStats`).
`--active-radius` overrides `start.simulation.active_radius` for
comparison.

## Results (Node)

Dev machine: WSL2 Linux, 8 cores, Node v24.14.1. 3000 ticks (5 sim
minutes), seed 1. The max is the first ticks (JIT warm-up and the first
region labelling of the city's 235 298 cells).

| Game | Map | Entities | Active radius | Tick avg | Tick p95 | Tick max | Active avg (min–max) | Dormant avg | A* expanded/tick avg | max | Searches | Region rejects | Budget hits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zombie | city 343×343×2 | 961 | 64 | 0.26 ms | 0.46 ms | 36.3 ms | 144 (73–250) | 817 | 17.5 | 3912 | 5038 | 0 | 0 |
| zombie | city 343×343×2 | 961 | none | 0.44 ms | 0.72 ms | 32.0 ms | 961 | 0 | 17.8 | 3912 | 5160 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | 64 | 0.09 ms | 0.16 ms | 6.2 ms | 138 (41–154) | 16 | 5.6 | 4253 | 140 | 0 | 0 |
| vampire | estate 128×128×2 | 154 | none | 0.10 ms | 0.19 ms | 6.4 ms | 154 | 0 | 4.7 | 4233 | 142 | 0 | 0 |
| garden | garden 24×16 | 6 | 64 | 0.01 ms | 0.02 ms | 1.4 ms | 6 | 0 | 0.3 | 140 | 97 | 0 | 0 |

The steady p95 on the city is **0.46 ms**, ~22× under the 10 ms target
(0.38 ms on the old 256×256 city: the bigger map spreads the same NPCs
thinner, so fewer are active, but the walk is longer and NPC searches
cross wider rooms and yards). The max rose with the map: the first region
labelling covers 1.8× the cells. Load (parse, compose, validate) takes
~220–260 ms and `World.create` ~80–100 ms.

## Steps

The spec's order, with what each step did to the numbers (the 256×256
city of the time, 961 entities; the "before" figures are the same build with the step's feature
switched off or measured right before it landed):

1. **Composite maps and populate**: the city itself; 0.28 ms avg per tick
   with no dormancy, profiled as status updates (~19 %), drift (~9 %) and
   the per-entity loops of `step`.
2. **The benchmark**: `bench:sim --packs` (above).
3. **Dormancy** (active radius 64): avg 0.35 → 0.22 ms, p95 0.59 → 0.38 ms.
   About 70 % of the NPCs are dormant on average; drift, systems and
   statuses still run for them, so the gain is the think and movement work.
   Two generic cuts in the per-entity work came with it: a `for` filter that
   is exactly `self.has_tag("…")` is decided once per archetype, and the
   status update no longer allocates per entity (0.275 → 0.207 ms avg with
   no player movement).
4. **Region labels and budget**: the city is one connected region (doors
   join every building to the roads), so no goto was rejected or cut off on
   this route: the largest player search expanded 4 922 nodes, the largest
   NPC search 1 108 on the estate. Labelling the 131 072 cells takes 3–7 ms
   and happens on the first search and after `set_tile`. What the labels
   buy is the worst case: an unreachable goal fails without flooding the
   map (tested), and a budget bounds any search.
5. **Chunk index**: hearing visits only the 16×16 chunks a noise reaches;
   with only a few noises per tick the difference is within noise here.
   `entitiesNear` is the query API for later systems.
6. **Renderer**: lazy, evicted chunks and culled sprites (see
   `docs/iso.md#lazy-chunks-and-culling`); not measurable headless.

## Browser fps (manual)

Chromium is unavailable in the sandbox (as in S0), so browser numbers are
a manual follow-up. Open `npm run dev`, press **F3**, walk across the city
and fill in:

| Device | Browser | Zoom | fps (typical) | fps (min) | Tick p95 | Built chunks | Visible chunks |
|---|---|---|---|---|---|---|---|
| Mid-range laptop | | 1 | | | | | |
| Mid-range laptop | | 0.25 (zoomed out) | | | | | |
| Phone | | 1 | | | | | |
