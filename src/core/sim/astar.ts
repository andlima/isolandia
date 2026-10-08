import type { EdgeSide } from '../definition.ts';
import type { Grid } from './grid.ts';

const SQRT2 = Math.SQRT2;
// 8 directions: orthogonals first, then diagonals. This fixed order plus the
// heap's (f, then insertion order) comparison makes tie-breaking deterministic.
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];
// Links are tried after the 8 directions: up, then down.
const LINKS = [1, -1] as const;

export function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}

/**
 * A* over a Grid's floors: the 8 same-floor neighbours with an octile cost
 * across crossable edges and no corner cutting (a diagonal needs both
 * orthogonal neighbours walkable and every edge of both L routes crossable,
 * as `Grid.canStep`), then the cell's links up and down (cost 1, see
 * `Grid.link`).
 * The heuristic is octile on (x, y) only, which stays admissible.
 *
 * Per-node state lives in typed arrays indexed by cell index
 * (`(z * height + y) * width + x`), reused across searches via a generation
 * stamp. The open set is a binary min-heap with lazy deletion; ties on f are
 * broken by insertion order (links after the 8 directions), so results
 * depend only on the grid and the endpoints.
 */
export class Pathfinder {
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  /** Goal cells of the current search (stamped with `gen`). */
  private readonly goal: Uint32Array;
  private gen = 0;
  private heapNode = new Int32Array(256);
  private heapF = new Float64Array(256);
  private heapSeq = new Uint32Array(256);
  private heapSize = 0;
  private seq = 0;
  /** Nodes expanded by the latest search (0 when it failed without searching). */
  lastExpanded = 0;
  /** Whether the latest search stopped at its budget. */
  lastBudgetHit = false;
  /** Whether the latest search failed on region labels, without searching. */
  lastRegionReject = false;

  constructor(readonly grid: Grid) {
    const n = grid.width * grid.height * grid.floors;
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.goal = new Uint32Array(n);
  }

  /**
   * Path as cell indices from start (exclusive) to goal (inclusive); empty
   * if start === goal; null if the goal is out of bounds, not walkable, or
   * unreachable, or when the search expands `budget` nodes without reaching
   * it. A goal in another connected region than a walkable start (see
   * `Grid.regions`) fails without searching. `sz`/`gz` are the start and
   * goal floors (default 0).
   */
  findPath(sx: number, sy: number, gx: number, gy: number, sz = 0, gz = 0, budget = Infinity): Int32Array | null {
    this.reset();
    const { walk } = this.grid;
    if (!this.grid.inBounds(sx, sy, sz) || !this.grid.inBounds(gx, gy, gz)) return null;
    const goal = this.grid.index(gx, gy, gz);
    if (walk[goal] !== 1) return null;
    const start = this.grid.index(sx, sy, sz);
    if (walk[start] === 1) {
      const labels = this.grid.regions();
      if (labels[start] !== labels[goal]) {
        this.lastRegionReject = true;
        return null;
      }
    }
    const gen = ++this.gen;
    this.goal[goal] = gen;
    return this.search(sx, sy, sz, gx, gy, 0, budget);
  }

  private reset(): void {
    this.lastExpanded = 0;
    this.lastBudgetHit = false;
    this.lastRegionReject = false;
  }

  /**
   * Shortest path to any walkable tile from which (gx, gy) is in reach on the
   * goal's floor `gz` (8-adjacent with no non-walkable edge between, see
   * `Grid.reaches`), or to the goal itself when it is walkable (same return
   * convention and budget as `findPath`). One multi-goal search; ties are
   * broken like `findPath`. Fails without searching when no goal cell shares
   * a walkable start's region.
   */
  findPathAdjacent(sx: number, sy: number, gx: number, gy: number, sz = 0, gz = 0, budget = Infinity): Int32Array | null {
    this.reset();
    const grid = this.grid;
    const { width, height, walk } = grid;
    if (!grid.inBounds(sx, sy, sz) || !grid.inBounds(gx, gy, gz)) return null;
    const gen = ++this.gen;
    for (let y = Math.max(0, gy - 1); y <= Math.min(height - 1, gy + 1); y++) {
      for (let x = Math.max(0, gx - 1); x <= Math.min(width - 1, gx + 1); x++) {
        const i = grid.index(x, y, gz);
        if (walk[i] === 1 && grid.edgesOpen(i, gx - x, gy - y)) this.goal[i] = gen;
      }
    }
    return this.searchGoals(sx, sy, sz, gx, gy, gz, gen, budget);
  }

  /**
   * Shortest path to a walkable cell from which the edge on side `side` of
   * (gx, gy, gz) is in reach: one of the two cells it separates (same
   * return convention and budget as `findPath`).
   */
  findPathToEdge(sx: number, sy: number, gx: number, gy: number, side: EdgeSide, sz = 0, gz = 0, budget = Infinity): Int32Array | null {
    this.reset();
    const grid = this.grid;
    const { walk } = grid;
    if (!grid.inBounds(sx, sy, sz) || !grid.inBounds(gx, gy, gz)) return null;
    const gen = ++this.gen;
    const i = grid.index(gx, gy, gz);
    if (walk[i] === 1) this.goal[i] = gen;
    const ox = side === 'w' ? gx - 1 : gx;
    const oy = side === 'n' ? gy - 1 : gy;
    if (grid.inBounds(ox, oy, gz) && walk[grid.index(ox, oy, gz)] === 1) this.goal[grid.index(ox, oy, gz)] = gen;
    return this.searchGoals(sx, sy, sz, gx, gy, gz, gen, budget);
  }

  /** Search towards the goal cells of the 3×3 around (gx, gy, gz) stamped with `gen`; fails early on region labels. */
  private searchGoals(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, gen: number, budget: number): Int32Array | null {
    const grid = this.grid;
    const { width, height, walk } = grid;
    const start = grid.index(sx, sy, sz);
    const labels = walk[start] === 1 ? grid.regions() : null;
    let any = false;
    let reachable = labels === null;
    for (let y = Math.max(0, gy - 1); y <= Math.min(height - 1, gy + 1); y++) {
      for (let x = Math.max(0, gx - 1); x <= Math.min(width - 1, gx + 1); x++) {
        const i = grid.index(x, y, gz);
        if (this.goal[i] !== gen) continue;
        any = true;
        if (labels && labels[i] === labels[start]) reachable = true;
      }
    }
    if (!any) return null;
    if (!reachable) {
      this.lastRegionReject = true;
      return null;
    }
    // Every goal is within octile distance √2 of (gx, gy), so this stays admissible.
    return this.search(sx, sy, sz, gx, gy, SQRT2, budget);
  }

  /**
   * A* towards the cells stamped in `goal` for the current generation; h =
   * octile to (gx, gy) − slack. Gives up (null) once `budget` nodes have been
   * expanded without reaching a goal.
   */
  private search(sx: number, sy: number, sz: number, gx: number, gy: number, slack: number, budget: number): Int32Array | null {
    const grid = this.grid;
    const { width, height, walk, blockN, blockW } = grid;
    const multi = grid.floors > 1;
    const start = grid.index(sx, sy, sz);
    const gen = this.gen;
    const goal = this.goal;
    if (goal[start] === gen) return new Int32Array(0);
    const h = (x: number, y: number) => (slack === 0 ? octile(x, y, gx, gy) : Math.max(0, octile(x, y, gx, gy) - slack));

    const { g, parent, seen, closed } = this;
    this.heapSize = 0;
    this.seq = 0;
    g[start] = 0;
    parent[start] = -1;
    seen[start] = gen;
    this.push(start, h(sx, sy));

    let expanded = 0;
    while (this.heapSize > 0) {
      const cur = this.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (goal[cur] === gen) {
        this.lastExpanded = expanded;
        return this.reconstruct(cur);
      }
      if (expanded >= budget) {
        this.lastExpanded = expanded;
        this.lastBudgetHit = true;
        return null;
      }
      expanded++;

      const cx = cur % width;
      const rest = (cur - cx) / width;
      const cy = rest % height;
      const base = cur - cy * width - cx; // first cell of this floor
      const gc = g[cur]!;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = base + ny * width + nx;
        if (walk[ni] !== 1 || closed[ni] === gen) continue;
        const dx = DX[d]!;
        const dy = DY[d]!;
        if (d < 4) {
          // The crossed edge: the `w` of the cell to the right, or the `n` of the cell below.
          if (dx !== 0 ? blockW[dx > 0 ? ni : cur] !== 0 : blockN[dy > 0 ? ni : cur] !== 0) continue;
        } else {
          if (walk[base + cy * width + nx] !== 1 || walk[base + ny * width + cx] !== 1) continue;
          // Every edge of both L routes (see `Grid.edgesOpen`).
          const col = dx > 0 ? cur + 1 : cur;
          const row = dy > 0 ? cur + width : cur;
          if (blockW[col] !== 0 || blockW[col + dy * width] !== 0 || blockN[row] !== 0 || blockN[row + dx] !== 0) continue;
        }
        const ng = gc + COST[d]!;
        if (seen[ni] === gen && ng >= g[ni]!) continue;
        seen[ni] = gen;
        g[ni] = ng;
        parent[ni] = cur;
        this.push(ni, ng + h(nx, ny));
      }
      if (!multi) continue;
      for (const dz of LINKS) {
        const ni = grid.link(cur, dz);
        if (ni < 0 || closed[ni] === gen) continue;
        const ng = gc + 1;
        if (seen[ni] === gen && ng >= g[ni]!) continue;
        seen[ni] = gen;
        g[ni] = ng;
        parent[ni] = cur;
        this.push(ni, ng + h(cx, cy));
      }
    }
    this.lastExpanded = expanded;
    return null;
  }

  private reconstruct(goal: number): Int32Array {
    let len = 0;
    for (let i = goal; this.parent[i] !== -1; i = this.parent[i]!) len++;
    const path = new Int32Array(len);
    for (let i = goal, k = len - 1; k >= 0; i = this.parent[i]!, k--) path[k] = i;
    return path;
  }

  /** Heap order: smaller f first, then earlier insertion. */
  private less(fa: number, sa: number, fb: number, sb: number): boolean {
    return fa < fb || (fa === fb && sa < sb);
  }

  private push(node: number, f: number): void {
    if (this.heapSize === this.heapNode.length) {
      const grow = <T extends Int32Array | Float64Array | Uint32Array>(a: T, b: T): T => (b.set(a), b);
      const n = this.heapSize * 2;
      this.heapNode = grow(this.heapNode, new Int32Array(n));
      this.heapF = grow(this.heapF, new Float64Array(n));
      this.heapSeq = grow(this.heapSeq, new Uint32Array(n));
    }
    const { heapNode: hn, heapF: hf, heapSeq: hs } = this;
    const s = this.seq++;
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(f, s, hf[p]!, hs[p]!)) break;
      hn[i] = hn[p]!;
      hf[i] = hf[p]!;
      hs[i] = hs[p]!;
      i = p;
    }
    hn[i] = node;
    hf[i] = f;
    hs[i] = s;
  }

  private pop(): number {
    const { heapNode: hn, heapF: hf, heapSeq: hs } = this;
    const top = hn[0]!;
    const size = --this.heapSize;
    if (size > 0) {
      const node = hn[size]!;
      const f = hf[size]!;
      const s = hs[size]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= size) break;
        const r = l + 1;
        const c = r < size && this.less(hf[r]!, hs[r]!, hf[l]!, hs[l]!) ? r : l;
        if (!this.less(hf[c]!, hs[c]!, f, s)) break;
        hn[i] = hn[c]!;
        hf[i] = hf[c]!;
        hs[i] = hs[c]!;
        i = c;
      }
      hn[i] = node;
      hf[i] = f;
      hs[i] = s;
    }
    return top;
  }
}
