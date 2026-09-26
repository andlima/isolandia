import type { Grid } from './grid.ts';

const SQRT2 = Math.SQRT2;
// 8 directions: orthogonals first, then diagonals. This fixed order plus the
// heap's (f, then insertion order) comparison makes tie-breaking deterministic.
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

export function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}

/**
 * 8-directional A* over a Grid with an octile heuristic and no corner
 * cutting (a diagonal needs both orthogonal neighbours walkable).
 *
 * Per-node state lives in typed arrays indexed by `y * width + x`, reused
 * across searches via a generation stamp. The open set is a binary min-heap
 * with lazy deletion; ties on f are broken by insertion order, so results
 * depend only on the grid and the endpoints.
 */
export class Pathfinder {
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private gen = 0;
  private heapNode = new Int32Array(256);
  private heapF = new Float64Array(256);
  private heapSeq = new Uint32Array(256);
  private heapSize = 0;
  private seq = 0;

  constructor(readonly grid: Grid) {
    const n = grid.width * grid.height;
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /**
   * Path as cell indices (`y * width + x`) from start (exclusive) to goal
   * (inclusive); empty if start === goal; null if the goal is out of bounds,
   * not walkable, or unreachable.
   */
  findPath(sx: number, sy: number, gx: number, gy: number): Int32Array | null {
    const { width, height, walk } = this.grid;
    if (!this.grid.inBounds(sx, sy) || !this.grid.inBounds(gx, gy)) return null;
    const start = sy * width + sx;
    const goal = gy * width + gx;
    if (walk[goal] !== 1) return null;
    if (start === goal) return new Int32Array(0);

    const gen = ++this.gen;
    const { g, parent, seen, closed } = this;
    this.heapSize = 0;
    this.seq = 0;
    g[start] = 0;
    parent[start] = -1;
    seen[start] = gen;
    this.push(start, octile(sx, sy, gx, gy));

    while (this.heapSize > 0) {
      const cur = this.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) return this.reconstruct(goal);

      const cx = cur % width;
      const cy = (cur / width) | 0;
      const gc = g[cur]!;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (walk[ni] !== 1 || closed[ni] === gen) continue;
        if (d >= 4 && (walk[cy * width + nx] !== 1 || walk[ny * width + cx] !== 1)) continue;
        const ng = gc + COST[d]!;
        if (seen[ni] === gen && ng >= g[ni]!) continue;
        seen[ni] = gen;
        g[ni] = ng;
        parent[ni] = cur;
        this.push(ni, ng + octile(nx, ny, gx, gy));
      }
    }
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
