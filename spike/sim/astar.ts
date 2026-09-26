import type { Grid } from './grid.ts';

const SQRT2 = Math.SQRT2;
// 8 directions: dx, dy, cost. Orthogonals first.
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

/**
 * 8-directional A* with an octile heuristic. Diagonal steps are only allowed
 * when both orthogonal neighbours are walkable (no corner cutting).
 *
 * All per-node state lives in typed arrays indexed by `y * width + x`, reused
 * across searches via a generation stamp (no clearing, no per-node objects).
 * The open set is a binary min-heap with lazy deletion.
 */
export class Pathfinder {
  readonly grid: Grid;
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly seen: Uint32Array; // generation when g/parent were set
  private readonly closed: Uint32Array; // generation when node was closed
  private gen = 0;
  private heapNode: Int32Array;
  private heapF: Float32Array;
  private heapSize = 0;
  /** Nodes expanded by the last search (for stats). */
  lastExpanded = 0;

  constructor(grid: Grid) {
    this.grid = grid;
    const n = grid.width * grid.height;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heapNode = new Int32Array(1024);
    this.heapF = new Float32Array(1024);
  }

  /**
   * Returns the path as tile indices from start (exclusive) to goal
   * (inclusive), an empty array if start === goal, or null if there is no path.
   */
  findPath(sx: number, sy: number, gx: number, gy: number): Int32Array | null {
    const { width, height, blocked } = this.grid;
    this.lastExpanded = 0;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) return null;
    const start = sy * width + sx;
    const goal = gy * width + gx;
    if (blocked[goal] !== 0) return null;
    if (start === goal) return new Int32Array(0);

    const gen = ++this.gen;
    const { g, parent, seen, closed } = this;
    this.heapSize = 0;
    g[start] = 0;
    parent[start] = -1;
    seen[start] = gen;
    this.push(start, octile(sx, sy, gx, gy));

    while (this.heapSize > 0) {
      const cur = this.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      this.lastExpanded++;
      if (cur === goal) return this.reconstruct(goal);

      const cx = cur % width;
      const cy = (cur / width) | 0;
      const gc = g[cur]!;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (blocked[ni] !== 0 || closed[ni] === gen) continue;
        if (d >= 4) {
          // No corner cutting: both orthogonal neighbours must be walkable.
          if (blocked[cy * width + nx] !== 0 || blocked[ny * width + cx] !== 0) continue;
        }
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

  private push(node: number, f: number): void {
    if (this.heapSize === this.heapNode.length) {
      const nn = new Int32Array(this.heapSize * 2);
      nn.set(this.heapNode);
      this.heapNode = nn;
      const nf = new Float32Array(this.heapSize * 2);
      nf.set(this.heapF);
      this.heapF = nf;
    }
    const hn = this.heapNode;
    const hf = this.heapF;
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p]! <= f) break;
      hn[i] = hn[p]!;
      hf[i] = hf[p]!;
      i = p;
    }
    hn[i] = node;
    hf[i] = f;
  }

  private pop(): number {
    const hn = this.heapNode;
    const hf = this.heapF;
    const top = hn[0]!;
    const size = --this.heapSize;
    if (size > 0) {
      const node = hn[size]!;
      const f = hf[size]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= size) break;
        const r = l + 1;
        const c = r < size && hf[r]! < hf[l]! ? r : l;
        if (hf[c]! >= f) break;
        hn[i] = hn[c]!;
        hf[i] = hf[c]!;
        i = c;
      }
      hn[i] = node;
      hf[i] = f;
    }
    return top;
  }
}

export function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
}
