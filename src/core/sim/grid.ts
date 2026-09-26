import type { MapDef, TileDef } from '../definition.ts';

/** Tile grid: one tile index per cell in a typed array. */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint16Array;
  /** 1 where the cell is walkable, row-major (for pathfinding). */
  readonly walk: Uint8Array;

  constructor(
    map: MapDef,
    private readonly tiles: readonly TileDef[],
  ) {
    this.width = map.width;
    this.height = map.height;
    this.cells = Uint16Array.from(map.cells);
    this.walk = Uint8Array.from(this.cells, (t) => (tiles[t]!.walkable ? 1 : 0));
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Tile at (x, y), or undefined out of bounds. */
  tileAt(x: number, y: number): TileDef | undefined {
    return this.inBounds(x, y) ? this.tiles[this.cells[y * this.width + x]!] : undefined;
  }

  walkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.walk[y * this.width + x] === 1;
  }

  /**
   * Whether a one-tile step from (x, y) by (dx, dy) is allowed. A diagonal
   * step needs the target and both orthogonal neighbours to be walkable (no
   * corner cutting).
   */
  canStep(x: number, y: number, dx: number, dy: number): boolean {
    if (!this.walkable(x + dx, y + dy)) return false;
    if (dx !== 0 && dy !== 0) return this.walkable(x + dx, y) && this.walkable(x, y + dy);
    return true;
  }
}
