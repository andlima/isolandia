/**
 * Top-down ASCII renderer. Pure: reads the world, returns text. No ANSI
 * codes — per-character colors are returned separately for the terminal
 * shell. Shows the player's floor only, in the double-resolution layout of
 * the `edges: true` map notation (docs/packs.md#edge-walls): cell (x, y) of
 * the viewport at line 2y+1, column 2x+1; its north edge at (2y, 2x+1), its
 * west edge at (2y+1, 2x); vertices at even (line, column). Empty cells and
 * edge positions without an edge are spaces.
 */

import { EMPTY_TILE, hudLineLevels, hudLines, hudModel, type TileDef, type World } from '../core/index.ts';

export interface Viewport {
  /** Map area size in cells (the frame is 2·width + 1 characters by 2·height + 1 lines). */
  readonly width: number;
  readonly height: number;
}

export interface AsciiFrame {
  /** Map lines: 2·`viewport.height` + 1 lines of 2·`viewport.width` + 1 characters. */
  readonly lines: readonly string[];
  /** Color per map character (`null` for empty space), same shape as `lines`. */
  readonly colors: readonly (readonly (string | null)[])[];
  /** HUD: clock line, one line per player measurement, then inventory/status/nearby/action/defeat/victory lines if any. */
  readonly hud: readonly string[];
  /** Per `hud` line: `warn` or `danger` when it should stand out (yellow / red in the terminal), else null. */
  readonly hudLevels: readonly ('warn' | 'danger' | null)[];
}

export function renderAscii(world: World, viewport: Viewport): AsciiFrame {
  const { width, height } = viewport;
  const { grid, player } = world;
  const tiles = world.def.tiles;
  const z = player.z;
  const x0 = player.x - Math.floor(width / 2);
  const y0 = player.y - Math.floor(height / 2);
  const cols = 2 * width + 1;
  const rows = 2 * height + 1;

  const glyphs: string[][] = [];
  const colors: (string | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    glyphs.push(new Array<string>(cols).fill(' '));
    colors.push(new Array<string | null>(cols).fill(null));
  }
  const put = (r: number, c: number, t: TileDef | undefined) => {
    if (!t) return;
    glyphs[r]![c] = t.glyph;
    colors[r]![c] = t.color;
  };
  /** The edge on `side` of map cell (x, y), or undefined. */
  const edge = (x: number, y: number, side: 'n' | 'w'): TileDef | undefined => {
    if (!grid.inBounds(x, y, z)) return undefined;
    const i = grid.index(x, y, z);
    const t = side === 'n' ? grid.edgeN[i]! : grid.edgeW[i]!;
    return t === EMPTY_TILE ? undefined : tiles[t];
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c >> 1);
      const y = y0 + (r >> 1);
      if (r % 2 === 1 && c % 2 === 1) put(r, c, grid.tileAt(x, y, z));
      else if (r % 2 === 0 && c % 2 === 1) put(r, c, edge(x, y, 'n'));
      else if (r % 2 === 1 && c % 2 === 0) put(r, c, edge(x, y, 'w'));
      else {
        // A vertex shows an adjacent edge (a non-walkable one first): left, right, up, down.
        const around = [edge(x - 1, y, 'n'), edge(x, y, 'n'), edge(x, y - 1, 'w'), edge(x, y, 'w')];
        put(r, c, around.find((t) => t && !t.walkable) ?? around.find((t) => t));
      }
    }
  }

  // Ground piles show their first stack's item; entities draw over them.
  for (const c of world.containers.values()) {
    if (c.kind !== 'ground' || c.stacks.length === 0 || c.z !== z) continue;
    const vx = c.x - x0;
    const vy = c.y - y0;
    if (vx < 0 || vy < 0 || vx >= width || vy >= height) continue;
    const item = world.def.items[c.stacks[0]!.item]!;
    glyphs[2 * vy + 1]![2 * vx + 1] = item.glyph;
    colors[2 * vy + 1]![2 * vx + 1] = item.color;
  }

  // Entities on top of tiles; the player last so it is always visible.
  const draw = (e: (typeof world.entities)[number]) => {
    if (e.z !== z) return;
    const vx = e.x - x0;
    const vy = e.y - y0;
    if (vx < 0 || vy < 0 || vx >= width || vy >= height) return;
    glyphs[2 * vy + 1]![2 * vx + 1] = e.archetype.glyph;
    colors[2 * vy + 1]![2 * vx + 1] = e.archetype.color;
  };
  for (const e of world.entities) if (e !== player) draw(e);
  draw(player);

  const m = hudModel(world);

  return { lines: glyphs.map((r) => r.join('')), colors, hud: hudLines(m), hudLevels: hudLineLevels(m) };
}

/** Plain-text frame: map, blank line, HUD. */
export function frameToText(frame: AsciiFrame): string {
  return [...frame.lines, '', ...frame.hud].join('\n');
}
