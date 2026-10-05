import { EMPTY_TILE, type MapDef, type TileDef } from '../definition.ts';

/**
 * Tile grid: one tile index per cell in a typed array, for a stack of
 * `floors` floors. The cell index is `(z * height + y) * width + x`; with one
 * floor it is the row-major `y * width + x`. Every `(x, y)` accessor takes a
 * floor `z` that defaults to 0.
 */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly floors: number;
  /** Tile index per cell; `EMPTY_TILE` where the cell holds no tile. */
  readonly cells: Uint16Array;
  /** 1 where the cell is walkable, by cell index (for pathfinding). */
  readonly walk: Uint8Array;
  /** 1 where the cell blocks line of sight, by cell index. */
  readonly opaque: Uint8Array;
  /**
   * Bumped by every `setTile`. Pathfinding and line of sight read `walk` and
   * `opaque` live; region labels (`regions`), renderers and other caches
   * compare it.
   */
  version = 0;
  /** Connected-region label per cell (-1 where not walkable), as of `labelsVersion`. */
  private labels: Int32Array | null = null;
  private labelsVersion = -1;
  private labelCount = 0;
  /** Cells whose tile differs from the map: cell index → tile index. */
  readonly changed = new Map<number, number>();
  private readonly original: readonly number[];
  /** Per tile index: its `climb` as +1 (up), -1 (down) or 0. */
  private readonly climb: Int8Array;

  constructor(
    map: MapDef,
    private readonly tiles: readonly TileDef[],
  ) {
    this.width = map.width;
    this.height = map.height;
    this.floors = map.floors;
    this.original = map.cells;
    this.cells = Uint16Array.from(map.cells);
    this.walk = Uint8Array.from(this.cells, (t) => (t !== EMPTY_TILE && tiles[t]!.walkable ? 1 : 0));
    this.opaque = Uint8Array.from(this.cells, (t) => (t !== EMPTY_TILE && tiles[t]!.opaque ? 1 : 0));
    this.climb = Int8Array.from(tiles, (t) => (t.climb === 'up' ? 1 : t.climb === 'down' ? -1 : 0));
  }

  /** Cells per floor. */
  get area(): number {
    return this.width * this.height;
  }

  /** Replace the tile of cell `i`, updating walkability and opacity at once. */
  setTile(i: number, tile: number): void {
    const t = this.tiles[tile]!;
    this.cells[i] = tile;
    this.walk[i] = t.walkable ? 1 : 0;
    this.opaque[i] = t.opaque ? 1 : 0;
    if (this.original[i] === tile) this.changed.delete(i);
    else this.changed.set(i, tile);
    this.version++;
  }

  inBounds(x: number, y: number, z = 0): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.height && z < this.floors;
  }

  /** Cell index of (x, y, z) (no bounds check). */
  index(x: number, y: number, z = 0): number {
    return (z * this.height + y) * this.width + x;
  }

  /** (x, y, z) of a cell index. */
  cellOf(i: number): { x: number; y: number; z: number } {
    const x = i % this.width;
    const r = (i - x) / this.width;
    const y = r % this.height;
    return { x, y, z: (r - y) / this.height };
  }

  /** Tile at (x, y, z), or undefined out of bounds or on an empty cell. */
  tileAt(x: number, y: number, z = 0): TileDef | undefined {
    if (!this.inBounds(x, y, z)) return undefined;
    const t = this.cells[this.index(x, y, z)]!;
    return t === EMPTY_TILE ? undefined : this.tiles[t];
  }

  /** Whether (x, y, z) is in bounds and holds no tile. */
  isEmpty(x: number, y: number, z = 0): boolean {
    return this.inBounds(x, y, z) && this.cells[this.index(x, y, z)] === EMPTY_TILE;
  }

  walkable(x: number, y: number, z = 0): boolean {
    return this.inBounds(x, y, z) && this.walk[this.index(x, y, z)] === 1;
  }

  /** Whether (x, y, z) blocks line of sight; out of bounds counts as opaque. */
  opaqueAt(x: number, y: number, z = 0): boolean {
    return !this.inBounds(x, y, z) || this.opaque[this.index(x, y, z)] === 1;
  }

  /**
   * Whether a one-tile step from (x, y, z) by (dx, dy) on the same floor is
   * allowed. A diagonal step needs the target and both orthogonal neighbours
   * to be walkable (no corner cutting).
   */
  canStep(x: number, y: number, dx: number, dy: number, z = 0): boolean {
    if (!this.walkable(x + dx, y + dy, z)) return false;
    if (dx !== 0 && dy !== 0) return this.walkable(x + dx, y, z) && this.walkable(x, y + dy, z);
    return true;
  }

  /**
   * Whether cell `i` has a link one floor in direction `dz` in the map's tiles
   * (ignoring walkability): its own tile climbs that way, or the tile at the
   * far cell climbs back.
   */
  linked(i: number, dz: 1 | -1): boolean {
    const a = this.area;
    const z = Math.floor(i / a);
    const j = i + dz * a;
    if (z + dz < 0 || z + dz >= this.floors) return false;
    const own = this.cells[i]!;
    const far = this.cells[j]!;
    return (own !== EMPTY_TILE && this.climb[own] === dz) || (far !== EMPTY_TILE && this.climb[far] === -dz);
  }

  /**
   * Connected-region label per cell index, -1 where the cell is not walkable.
   * Two walkable cells share a label exactly when A* can walk between them:
   * the 8 moves without corner cutting (which connect the same cells as the
   * 4 orthogonal ones) plus links. Computed on the first call and again after
   * any `setTile`; the array is reused, so read it right away.
   */
  regions(): Int32Array {
    if (this.labels && this.labelsVersion === this.version) return this.labels;
    const n = this.cells.length;
    const labels = (this.labels ??= new Int32Array(n));
    labels.fill(-1);
    const queue = new Int32Array(n);
    const { walk, width, height } = this;
    const multi = this.floors > 1;
    let label = 0;
    let tail = 0;
    const visit = (j: number): void => {
      if (walk[j] === 1 && labels[j] === -1) {
        labels[j] = label;
        queue[tail++] = j;
      }
    };
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (walk[s] !== 1 || labels[s] !== -1) continue;
      label = next++;
      labels[s] = label;
      let head = 0;
      tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        const i = queue[head++]!;
        const x = i % width;
        const y = ((i - x) / width) % height;
        if (x > 0) visit(i - 1);
        if (x < width - 1) visit(i + 1);
        if (y > 0) visit(i - width);
        if (y < height - 1) visit(i + width);
        if (multi) {
          const up = this.link(i, 1);
          if (up >= 0) visit(up);
          const down = this.link(i, -1);
          if (down >= 0) visit(down);
        }
      }
    }
    this.labelCount = next;
    this.labelsVersion = this.version;
    return labels;
  }

  /** Number of connected regions (see `regions`). */
  get regionCount(): number {
    this.regions();
    return this.labelCount;
  }

  /**
   * Far cell index of the link from cell `i` one floor in direction `dz`, or
   * -1. A link is an edge in both directions and exists only while both
   * ends are walkable (checked live, so `set_tile` can block stairs).
   */
  link(i: number, dz: 1 | -1): number {
    if (this.walk[i] !== 1 || !this.linked(i, dz)) return -1;
    const j = i + dz * this.area;
    return this.walk[j] === 1 ? j : -1;
  }
}
