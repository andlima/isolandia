import type { MapDef, TileDef } from '../definition.ts';

/** Tile grid: one tile index per cell in a typed array. */
export class Grid {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint16Array;

  constructor(
    map: MapDef,
    private readonly tiles: readonly TileDef[],
  ) {
    this.width = map.width;
    this.height = map.height;
    this.cells = Uint16Array.from(map.cells);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Tile at (x, y), or undefined out of bounds. */
  tileAt(x: number, y: number): TileDef | undefined {
    return this.inBounds(x, y) ? this.tiles[this.cells[y * this.width + x]!] : undefined;
  }

  walkable(x: number, y: number): boolean {
    return this.tileAt(x, y)?.walkable ?? false;
  }
}
