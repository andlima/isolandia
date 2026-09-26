/**
 * Top-down ASCII renderer. Pure: reads the world, returns text. No ANSI
 * codes — per-cell colors are returned separately for the terminal shell.
 */

import { hudModel, type World } from '../core/index.ts';

export interface Viewport {
  /** Map area size in cells. */
  readonly width: number;
  readonly height: number;
}

export interface AsciiFrame {
  /** Map rows, each exactly `viewport.width` characters. */
  readonly lines: readonly string[];
  /** Color per map cell (`null` for empty space), same shape as `lines`. */
  readonly colors: readonly (readonly (string | null)[])[];
  /** HUD: clock line followed by one line per player measurement. */
  readonly hud: readonly string[];
}

export function renderAscii(world: World, viewport: Viewport): AsciiFrame {
  const { width, height } = viewport;
  const { grid, player } = world;
  const x0 = player.x - Math.floor(width / 2);
  const y0 = player.y - Math.floor(height / 2);

  const glyphs: string[][] = [];
  const colors: (string | null)[][] = [];
  for (let vy = 0; vy < height; vy++) {
    const row: string[] = [];
    const crow: (string | null)[] = [];
    for (let vx = 0; vx < width; vx++) {
      const t = grid.tileAt(x0 + vx, y0 + vy);
      row.push(t ? t.glyph : ' ');
      crow.push(t ? t.color : null);
    }
    glyphs.push(row);
    colors.push(crow);
  }

  // Entities on top of tiles; the player last so it is always visible.
  const draw = (e: (typeof world.entities)[number]) => {
    const vx = e.x - x0;
    const vy = e.y - y0;
    if (vx < 0 || vy < 0 || vx >= width || vy >= height) return;
    glyphs[vy]![vx] = e.archetype.glyph;
    colors[vy]![vx] = e.archetype.color;
  };
  for (const e of world.entities) if (e !== player) draw(e);
  draw(player);

  const model = hudModel(world);
  const hud = [model.time, ...model.measurements.map((m) => m.text)];

  return { lines: glyphs.map((r) => r.join('')), colors, hud };
}

/** Plain-text frame: map, blank line, HUD. */
export function frameToText(frame: AsciiFrame): string {
  return [...frame.lines, '', ...frame.hud].join('\n');
}
