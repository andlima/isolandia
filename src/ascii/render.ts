/**
 * Top-down ASCII renderer. Pure: reads the world, returns text. No ANSI
 * codes — per-cell colors are returned separately for the terminal shell.
 * Shows the player's floor only; empty cells are spaces.
 */

import { hudLines, hudModel, type World } from '../core/index.ts';

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
  /** HUD: clock line, one line per player measurement, then inventory/status/nearby/action/defeat/victory lines if any. */
  readonly hud: readonly string[];
}

export function renderAscii(world: World, viewport: Viewport): AsciiFrame {
  const { width, height } = viewport;
  const { grid, player } = world;
  const z = player.z;
  const x0 = player.x - Math.floor(width / 2);
  const y0 = player.y - Math.floor(height / 2);

  const glyphs: string[][] = [];
  const colors: (string | null)[][] = [];
  for (let vy = 0; vy < height; vy++) {
    const row: string[] = [];
    const crow: (string | null)[] = [];
    for (let vx = 0; vx < width; vx++) {
      const t = grid.tileAt(x0 + vx, y0 + vy, z);
      row.push(t ? t.glyph : ' ');
      crow.push(t ? t.color : null);
    }
    glyphs.push(row);
    colors.push(crow);
  }

  // Ground piles show their first stack's item; entities draw over them.
  for (const c of world.containers.values()) {
    if (c.kind !== 'ground' || c.stacks.length === 0 || c.z !== z) continue;
    const vx = c.x - x0;
    const vy = c.y - y0;
    if (vx < 0 || vy < 0 || vx >= width || vy >= height) continue;
    const item = world.def.items[c.stacks[0]!.item]!;
    glyphs[vy]![vx] = item.glyph;
    colors[vy]![vx] = item.color;
  }

  // Entities on top of tiles; the player last so it is always visible.
  const draw = (e: (typeof world.entities)[number]) => {
    if (e.z !== z) return;
    const vx = e.x - x0;
    const vy = e.y - y0;
    if (vx < 0 || vy < 0 || vx >= width || vy >= height) return;
    glyphs[vy]![vx] = e.archetype.glyph;
    colors[vy]![vx] = e.archetype.color;
  };
  for (const e of world.entities) if (e !== player) draw(e);
  draw(player);

  const hud = hudLines(hudModel(world));

  return { lines: glyphs.map((r) => r.join('')), colors, hud };
}

/** Plain-text frame: map, blank line, HUD. */
export function frameToText(frame: AsciiFrame): string {
  return [...frame.lines, '', ...frame.hud].join('\n');
}
