import { EMPTY_TILE, type EdgeSide, type MapDef, type TileDef } from '../definition.ts';

/**
 * Tile grid: one tile index per cell in a typed array, for a stack of
 * `floors` floors. The cell index is `(z * height + y) * width + x`; with one
 * floor it is the row-major `y * width + x`. Every `(x, y)` accessor takes a
 * floor `z` that defaults to 0.
 *
 * Each cell also owns two optional edges (thin walls, doors, windows,
 * fences): its north edge `n` (towards (x, y-1)) and its west edge `w`
 * (towards (x-1, y)), stored by cell index like the cells. Crossing from a
 * cell to an orthogonal neighbour crosses one edge: towards +x the `w` of
 * the cell on the right, towards +y the `n` of the cell below. The map
 * border needs no edges (out of bounds is impassable and opaque).
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
  /** Edge tile on each cell's north / west side, by cell index; `EMPTY_TILE` where there is no edge. */
  readonly edgeN: Uint16Array;
  readonly edgeW: Uint16Array;
  /** 1 where the cell's north / west edge blocks movement (a non-walkable edge tile). */
  readonly blockN: Uint8Array;
  readonly blockW: Uint8Array;
  /** 1 where the cell's north / west edge blocks line of sight (an opaque edge tile). */
  readonly opaqueN: Uint8Array;
  readonly opaqueW: Uint8Array;
  /**
   * Bumped by every `setTile` and `setEdge`. Pathfinding and line of sight read `walk` and
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
  /** Edges whose tile differs from the map: `edgeKey(i, side)` → tile index (`EMPTY_TILE` for a removed edge). */
  readonly changedEdges = new Map<number, number>();
  private readonly original: readonly number[];
  private readonly originalN: readonly number[];
  private readonly originalW: readonly number[];
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
    this.originalN = map.edgeN;
    this.originalW = map.edgeW;
    this.edgeN = Uint16Array.from(map.edgeN);
    this.edgeW = Uint16Array.from(map.edgeW);
    const blocks = (t: number) => (t !== EMPTY_TILE && !tiles[t]!.walkable ? 1 : 0);
    const hides = (t: number) => (t !== EMPTY_TILE && tiles[t]!.opaque ? 1 : 0);
    this.blockN = Uint8Array.from(this.edgeN, blocks);
    this.blockW = Uint8Array.from(this.edgeW, blocks);
    this.opaqueN = Uint8Array.from(this.edgeN, hides);
    this.opaqueW = Uint8Array.from(this.edgeW, hides);
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

  /**
   * Replace the edge tile on side `side` of cell `i` (`EMPTY_TILE` removes
   * it), updating its movement and sight blocking at once.
   */
  setEdge(i: number, side: EdgeSide, tile: number): void {
    const t = tile === EMPTY_TILE ? null : this.tiles[tile]!;
    const block = t && !t.walkable ? 1 : 0;
    const hide = t?.opaque ? 1 : 0;
    if (side === 'n') {
      this.edgeN[i] = tile;
      this.blockN[i] = block;
      this.opaqueN[i] = hide;
    } else {
      this.edgeW[i] = tile;
      this.blockW[i] = block;
      this.opaqueW[i] = hide;
    }
    const original = (side === 'n' ? this.originalN : this.originalW)[i];
    const key = edgeKey(i, side);
    if (original === tile) this.changedEdges.delete(key);
    else this.changedEdges.set(key, tile);
    this.version++;
  }

  /** Edge tile on side `side` of (x, y, z), or undefined out of bounds or where there is no edge. */
  edgeAt(x: number, y: number, z: number, side: EdgeSide): TileDef | undefined {
    if (!this.inBounds(x, y, z)) return undefined;
    const i = this.index(x, y, z);
    const t = side === 'n' ? this.edgeN[i]! : this.edgeW[i]!;
    return t === EMPTY_TILE ? undefined : this.tiles[t];
  }

  /**
   * Whether the edge between (x, y, z) and its orthogonal neighbour
   * (x + dx, y + dy) can be crossed (no edge, or a walkable one). Both cells
   * must be in bounds; their own tiles are not checked.
   */
  crossable(x: number, y: number, dx: number, dy: number, z = 0): boolean {
    const i = this.index(x, y, z);
    if (dx > 0) return this.blockW[i + 1] === 0;
    if (dx < 0) return this.blockW[i] === 0;
    if (dy > 0) return this.blockN[i + this.width] === 0;
    return this.blockN[i] === 0;
  }

  /** Whether the edge between (x, y, z) and its orthogonal neighbour (x + dx, y + dy) lets sight through (both in bounds). */
  seeThrough(x: number, y: number, dx: number, dy: number, z = 0): boolean {
    const i = this.index(x, y, z);
    if (dx > 0) return this.opaqueW[i + 1] === 0;
    if (dx < 0) return this.opaqueW[i] === 0;
    if (dy > 0) return this.opaqueN[i + this.width] === 0;
    return this.opaqueN[i] === 0;
  }

  /**
   * Whether no non-walkable edge separates cell `i` = (x, y) from its
   * neighbour (x + dx, y + dy) on the same floor (both in bounds, |dx|, |dy|
   * ≤ 1). A diagonal needs every edge of both L-shaped routes (x then y,
   * y then x) crossable. Cells are not checked.
   */
  edgesOpen(i: number, dx: number, dy: number): boolean {
    const w = this.width;
    const { blockN, blockW } = this;
    if (dy === 0) return dx === 0 || blockW[dx > 0 ? i + 1 : i] === 0;
    if (dx === 0) return blockN[dy > 0 ? i + w : i] === 0;
    // Vertical edges (`w`) in rows y and y+dy at the column between x and x+dx;
    // horizontal edges (`n`) in columns x and x+dx at the row between y and y+dy.
    const col = dx > 0 ? i + 1 : i;
    const row = dy > 0 ? i + w : i;
    return blockW[col] === 0 && blockW[col + dy * w] === 0 && blockN[row] === 0 && blockN[row + dx] === 0;
  }

  /**
   * Whether an actor on (ax, ay, az) can reach cell (x, y, z): the same
   * floor, Chebyshev distance ≤ 1, and no non-walkable edge between them
   * (`edgesOpen`; the target cell's own tile does not matter).
   */
  reaches(ax: number, ay: number, az: number, x: number, y: number, z: number): boolean {
    if (az !== z || !this.inBounds(x, y, z) || !this.inBounds(ax, ay, az)) return false;
    const dx = x - ax;
    const dy = y - ay;
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1) return false;
    return this.edgesOpen(this.index(ax, ay, az), dx, dy);
  }

  /**
   * Whether an actor on (ax, ay, az) can reach the edge on side `side` of
   * (x, y, z): it stands on one of the two cells the edge separates.
   */
  reachesEdge(ax: number, ay: number, az: number, x: number, y: number, z: number, side: EdgeSide): boolean {
    if (az !== z || !this.inBounds(x, y, z)) return false;
    if (ax === x && ay === y) return true;
    return side === 'n' ? ax === x && ay === y - 1 && y > 0 : ay === y && ax === x - 1 && x > 0;
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
   * allowed: the target is walkable and the crossed edge is walkable. A
   * diagonal step needs both L-shaped routes fully clear: both orthogonal
   * neighbours walkable and every edge they cross walkable (no corner
   * cutting).
   */
  canStep(x: number, y: number, dx: number, dy: number, z = 0): boolean {
    if (!this.walkable(x + dx, y + dy, z) || !this.inBounds(x, y, z)) return false;
    if (dx !== 0 && dy !== 0 && !(this.walkable(x + dx, y, z) && this.walkable(x, y + dy, z))) return false;
    return this.edgesOpen(this.index(x, y, z), dx, dy);
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
   * 4 orthogonal ones across crossable edges) plus links. Computed on the first call and again after
   * any `setTile`; the array is reused, so read it right away.
   */
  regions(): Int32Array {
    if (this.labels && this.labelsVersion === this.version) return this.labels;
    const n = this.cells.length;
    const labels = (this.labels ??= new Int32Array(n));
    labels.fill(-1);
    const queue = new Int32Array(n);
    const { walk, width, height, blockN, blockW } = this;
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
        if (x > 0 && blockW[i] === 0) visit(i - 1);
        if (x < width - 1 && blockW[i + 1] === 0) visit(i + 1);
        if (y > 0 && blockN[i] === 0) visit(i - width);
        if (y < height - 1 && blockN[i + width] === 0) visit(i + width);
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

/** Key of an edge in `Grid.changedEdges`: `2 * cell index`, plus 1 for a `w` edge. */
export function edgeKey(i: number, side: EdgeSide): number {
  return i * 2 + (side === 'w' ? 1 : 0);
}

/** Cell index and side of an `edgeKey`. */
export function edgeOfKey(key: number): { i: number; side: EdgeSide } {
  return { i: key >> 1, side: (key & 1) === 1 ? 'w' : 'n' };
}
