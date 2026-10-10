/** `check --exposure <map>` output: a map's exposure floor by floor (pure, for tests). */

import { EMPTY_TILE, nearMiss, type Definition, type MapDef } from '../core/index.ts';

/**
 * The map's exposure (docs/packs.md#exposure) as ASCII, floor by floor:
 * a `floor N` line, then one line per row with one character per cell,
 * `.` exposed, `#` not exposed (enclosed or covered), a space for an empty
 * cell. Every column is printed, however wide the map.
 */
export function exposureRows(map: MapDef): string[] {
  const lines: string[] = [];
  const area = map.width * map.height;
  for (let z = 0; z < map.floors; z++) {
    lines.push(`floor ${z}`);
    for (let y = 0; y < map.height; y++) {
      let row = '';
      for (let x = 0; x < map.width; x++) {
        const i = z * area + y * map.width + x;
        row += map.cells[i] === EMPTY_TILE ? ' ' : map.exposed[i] === 1 ? '.' : '#';
      }
      lines.push(row);
    }
  }
  return lines;
}

/**
 * Resolve `id` (qualified, or a short id that names exactly one map) and
 * print its exposure; an unknown id is an error with a *did you mean*.
 */
export function formatExposure(def: Definition, id: string): { ok: true; lines: string[] } | { ok: false; error: string } {
  const maps = def.maps;
  let map = maps.find((m) => m.id === id);
  if (!map) {
    const short = maps.filter((m) => m.id.slice(m.id.indexOf(':') + 1) === id);
    if (short.length === 1) map = short[0];
    else if (short.length > 1) return { ok: false, error: `map '${id}' is ambiguous: ${short.map((m) => `'${m.id}'`).join(', ')}` };
  }
  if (!map) {
    const near = nearMiss(id, maps.map((m) => m.id));
    return { ok: false, error: `unknown map '${id}'${near ? ` (did you mean '${near}'?)` : ''}` };
  }
  return { ok: true, lines: [`${map.id}: ${map.width}×${map.height}, ${map.floors} floor${map.floors === 1 ? '' : 's'}`, ...exposureRows(map)] };
}
