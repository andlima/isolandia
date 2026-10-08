/**
 * Convert maps whose walls are cells to thin edge walls (docs/packs.md#edge-walls):
 *
 *   npm run map:edges -- <pack-dir>… [--map <id>]
 *
 * Rewrites in place every ASCII map (to the `edges: true` notation) and
 * every Tiled map (to cell + edge layers) of the given packs that still has
 * edge tiles in cells, keeping each map's size and the coordinates of
 * everything on it. Pack directories are read in load order (dependencies
 * first) to resolve tiles; only maps of the packs listed are rewritten,
 * `--map` limits it to one map (local or qualified id).
 *
 * The rule treats every cell holding an edge tile ("wall-like") as a lattice
 * vertex of the new grid:
 *
 * - Two wall-like cells side by side, (x, y) and (x+1, y), give cell (x, y)
 *   an `n` edge; (x, y) above (x, y+1) gives cell (x, y) a `w` edge. The
 *   edge's tile is the tile of (x, y), so a door between two walls gives one
 *   door edge.
 * - The former wall-like cell becomes ground: the tile of its south, else
 *   east, else south-east neighbour, the first that is plain (walkable, not
 *   raised, no container, not an edge tile). Failing that it becomes empty
 *   when one of those neighbours is an empty cell (outside an upper floor),
 *   else takes the nearest plain cell of its region (the cells it reaches
 *   without crossing a new edge), else becomes empty when that region meets
 *   only empty cells, else takes the floor's most common plain tile.
 *   Facings are dropped.
 * - Isolated wall-like cells (no wall-like orthogonal neighbour), door or
 *   window cells that would give no edge or two, and 2×2 blocks of
 *   wall-like cells are reported, not guessed: fix them by hand.
 * - Room rects grow by one cell north and/or west where those cells were
 *   wall-like.
 *
 * The conversion core (`convertCells`, `growRoom`) is pure; `main` does the
 * file work.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import { format, Rows, type Out } from './tiled-json.ts';

// ── Pure core ──────────────────────────────────────────────────────────────

/** A map's cells, by cell index `(z * height + y) * width + x`; null = empty cell. */
export interface CellGrid<T> {
  readonly width: number;
  readonly height: number;
  readonly floors: number;
  readonly cells: readonly (T | null)[];
}

export interface ConvertRules<T> {
  /** Whether a tile is an edge tile (it becomes an edge). */
  wallLike(t: T): boolean;
  /** Whether a tile can stand in for a former wall cell (walkable, not raised, no container, not an edge tile). */
  plain(t: T): boolean;
}

export interface ConvertReport {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly message: string;
}

export interface Converted<T> {
  readonly cells: (T | null)[];
  readonly edgeN: (T | null)[];
  readonly edgeW: (T | null)[];
  /** 1 where the cell was wall-like. */
  readonly wall: Uint8Array;
  readonly reports: ConvertReport[];
}

/** Convert one map's wall-like cells to edges (see the file comment). */
export function convertCells<T>(g: CellGrid<T>, rules: ConvertRules<T>): Converted<T> {
  const { width, height, floors } = g;
  const area = width * height;
  const n = area * floors;
  const wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = g.cells[i];
    if (t !== null && t !== undefined && rules.wallLike(t)) wall[i] = 1;
  }
  const isWall = (x: number, y: number, z: number) => x >= 0 && y >= 0 && x < width && y < height && wall[(z * height + y) * width + x] === 1;
  const cells = g.cells.slice();
  const edgeN = new Array<T | null>(n).fill(null);
  const edgeW = new Array<T | null>(n).fill(null);
  const reports: ConvertReport[] = [];
  /** Per floor, its most common plain tile (the last fallback for ground). */
  const commonPlain: (T | null)[] = [];

  for (let z = 0; z < floors; z++) {
    const counts = new Map<T, number>();
    for (let i = z * area; i < (z + 1) * area; i++) {
      const t = g.cells[i];
      if (t !== null && t !== undefined && !wall[i] && rules.plain(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let best = 0;
    for (const [t, k] of counts) if (k > best) [commonPlain[z], best] = [t, k];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (z * height + y) * width + x;
        if (!wall[i]) continue;
        const t = g.cells[i]!;
        const east = isWall(x + 1, y, z);
        const south = isWall(x, y + 1, z);
        const west = isWall(x - 1, y, z);
        const north = isWall(x, y - 1, z);
        if (east) edgeN[i] = t;
        if (south) edgeW[i] = t;
        if (!east && !south && !west && !north) reports.push({ x, y, z, message: `isolated '${String(t)}' (no wall-like neighbour): it gives no edge and becomes ground` });
        else {
          // A door or window between walls gives one edge; at a run's end or on a corner it would give none or two.
          const tileAt = (dx: number, dy: number) => g.cells[i + dy * width + dx];
          const kin = (east && tileAt(1, 0) === t) || (south && tileAt(0, 1) === t) || (west && tileAt(-1, 0) === t) || (north && tileAt(0, -1) === t);
          const made = (east ? 1 : 0) + (south ? 1 : 0);
          if (!kin && made !== 1) reports.push({ x, y, z, message: `'${String(t)}' between other wall-like tiles gives ${made === 0 ? 'no edge (it ends a run to its west or north)' : 'two edges (a corner)'}` });
        }
        if (east && south && isWall(x + 1, y + 1, z)) reports.push({ x, y, z, message: `2×2 block of wall-like cells from here: it gives a closed 1×1 box` });
      }
    }
  }
  // Ground for the former wall-like cells, now that every edge is placed.
  const queue = new Int32Array(n);
  const seen = new Uint32Array(n);
  let stamp = 0;
  for (let z = 0; z < floors; z++) {
    const common = commonPlain[z] ?? null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (z * height + y) * width + x;
        if (!wall[i]) continue;
        let ground: T | null | undefined;
        let nearEmpty = false;
        // South, east, south-east: the first plain one; else empty next to an empty cell.
        for (const [dx, dy] of [
          [0, 1],
          [1, 0],
          [1, 1],
        ] as const) {
          if (x + dx >= width || y + dy >= height) continue;
          const j = i + dy * width + dx;
          const c = g.cells[j];
          if (c === null || c === undefined) nearEmpty = true;
          else if (!wall[j] && rules.plain(c)) {
            ground = c;
            break;
          }
        }
        if (ground === undefined && nearEmpty) ground = null;
        // Else the nearest plain cell of its region (bounded by the new edges): empty when the region only meets
        // empty cells, else the floor's most common plain tile.
        if (ground === undefined) {
          const found = nearestPlain(g, rules, wall, edgeN, edgeW, i, width, height, queue, seen, ++stamp);
          ground = found === undefined ? common : found;
          if (found === undefined && common === null) reports.push({ x, y, z, message: `no plain tile on the floor to put in place of '${String(g.cells[i])}': the cell becomes empty` });
        }
        cells[i] = ground;
      }
    }
  }
  return { cells, edgeN, edgeW, wall, reports };
}

/**
 * Breadth-first from cell `start` over its floor's cells, never crossing an
 * edge of `edgeN`/`edgeW` nor entering an empty cell (neighbours south, east,
 * west, north): the first cell that was not wall-like and is plain, `null`
 * when none is found but an empty cell was met, else undefined.
 */
function nearestPlain<T>(
  g: CellGrid<T>,
  rules: ConvertRules<T>,
  wall: Uint8Array,
  edgeN: readonly (T | null)[],
  edgeW: readonly (T | null)[],
  start: number,
  width: number,
  height: number,
  queue: Int32Array,
  seen: Uint32Array,
  stamp: number,
): T | null | undefined {
  const base = start - (start % (width * height));
  let head = 0;
  let tail = 0;
  let empty = false;
  queue[tail++] = start;
  seen[start] = stamp;
  while (head < tail) {
    const i = queue[head++]!;
    const c = g.cells[i];
    if (i !== start && !wall[i] && c !== null && c !== undefined && rules.plain(c)) return c;
    const x = (i - base) % width;
    const y = Math.floor((i - base) / width);
    const steps: [number, boolean][] = [
      [i + width, y + 1 < height && edgeN[i + width] === null],
      [i + 1, x + 1 < width && edgeW[i + 1] === null],
      [i - 1, x > 0 && edgeW[i] === null],
      [i - width, y > 0 && edgeN[i] === null],
    ];
    for (const [j, open] of steps) {
      if (!open || seen[j] === stamp) continue;
      seen[j] = stamp;
      if (g.cells[j] === null || g.cells[j] === undefined) empty = true;
      else queue[tail++] = j;
    }
  }
  return empty ? null : undefined;
}

/** A room rect grown by one cell north and/or west where that whole row or column was wall-like (floor `z`). */
export function growRoom(r: { x: number; y: number; w: number; h: number; z: number }, wall: Uint8Array, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const at = (x: number, y: number) => wall[(r.z * height + y) * width + x] === 1;
  let { x, y, w, h } = r;
  if (y > 0) {
    let all = true;
    for (let k = x; k < x + w && all; k++) all = at(k, y - 1);
    if (all) {
      y--;
      h++;
    }
  }
  if (x > 0) {
    let all = true;
    for (let k = y; k < y + h && all; k++) all = at(x - 1, k);
    if (all) {
      x--;
      w++;
    }
  }
  return { x, y, w, h };
}

/**
 * A floor's rows in the `edges: true` notation: cells at odd (row, column),
 * `n` edges at (even, odd), `w` edges at (odd, even); a vertex shows an
 * adjacent edge's character (a non-walkable one first), else a space.
 */
export function edgeRows(width: number, height: number, cell: (x: number, y: number) => string, n: (x: number, y: number) => string | null, w: (x: number, y: number) => string | null, solid: (ch: string) => boolean): string[] {
  const rows: string[] = [];
  const nAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? n(x, y) : null);
  const wAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? w(x, y) : null);
  for (let r = 0; r <= 2 * height; r++) {
    let row = '';
    for (let c = 0; c <= 2 * width; c++) {
      const x = c >> 1;
      const y = r >> 1;
      if (r % 2 === 1 && c % 2 === 1) row += cell(x, y);
      else if (r % 2 === 0 && c % 2 === 1) row += nAt(x, y) ?? ' ';
      else if (r % 2 === 1 && c % 2 === 0) row += wAt(x, y) ?? ' ';
      else {
        const around = [nAt(x - 1, y), nAt(x, y), wAt(x, y - 1), wAt(x, y)].filter((ch): ch is string => ch !== null);
        row += around.find(solid) ?? around[0] ?? ' ';
      }
    }
    rows.push(row);
  }
  return rows;
}

// ── Packs and tiles ────────────────────────────────────────────────────────

interface RawTile {
  walkable: boolean;
  raised: boolean | null;
  container: boolean;
  edge: boolean;
}

interface PackDir {
  readonly dir: string;
  readonly ns: string;
  readonly depends: readonly string[];
  /** Pack-relative YAML file paths. */
  readonly yaml: readonly string[];
}

type Json = { [k: string]: unknown };
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function listYaml(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) out.push(...listYaml(dir, r));
    else if (/\.ya?ml$/.test(name)) out.push(r);
  }
  return out;
}

function readPackDir(dir: string): PackDir {
  const manifest = parseDocument(readFileSync(join(dir, 'pack.yaml'), 'utf8')).toJS() as Json;
  const depends = Array.isArray(manifest['depends']) ? (manifest['depends'] as unknown[]).map((d) => (isObj(d) ? String(d['ns'] ?? d['namespace']) : String(d))) : [];
  return { dir, ns: String(manifest['namespace']), depends, yaml: listYaml(dir).filter((f) => f !== 'pack.yaml') };
}

/** Every tile of the packs (qualified id → what the converter needs), overrides merged in load order. */
function collectTiles(packs: readonly PackDir[]): Map<string, RawTile> {
  const tiles = new Map<string, RawTile>();
  for (const p of packs) {
    for (const file of p.yaml) {
      const doc = parseDocument(readFileSync(join(p.dir, file), 'utf8')).toJS() as unknown;
      if (!isObj(doc) || !Array.isArray(doc['tiles'])) continue;
      for (const t of doc['tiles'] as unknown[]) {
        if (!isObj(t) || typeof t['id'] !== 'string') continue;
        const id = t['id'].includes(':') ? t['id'] : `${p.ns}:${t['id']}`;
        const prev = tiles.get(id);
        const base: RawTile = prev && t['override'] === true ? prev : { walkable: false, raised: null, container: false, edge: false };
        tiles.set(id, {
          walkable: typeof t['walkable'] === 'boolean' ? t['walkable'] : base.walkable,
          raised: typeof t['raised'] === 'boolean' ? t['raised'] : base.raised,
          container: t['container'] !== undefined ? t['container'] !== null : base.container,
          edge: typeof t['edge'] === 'boolean' ? t['edge'] : base.edge,
        });
      }
    }
  }
  return tiles;
}

/** A tile reference as the loader resolves it from pack `p`, or null. */
function resolveTile(tiles: Map<string, RawTile>, p: PackDir, ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  if (ref.includes(':')) return tiles.has(ref) ? ref : null;
  if (tiles.has(`${p.ns}:${ref}`)) return `${p.ns}:${ref}`;
  const found = p.depends.map((d) => `${d}:${ref}`).filter((id) => tiles.has(id));
  return found.length === 1 ? found[0]! : null;
}

function rulesFor(tiles: Map<string, RawTile>): ConvertRules<string> {
  return {
    wallLike: (id) => tiles.get(id)?.edge === true,
    plain: (id) => {
      const t = tiles.get(id);
      return !!t && t.walkable && !(t.raised ?? !t.walkable) && !t.container && !t.edge;
    },
  };
}

// ── ASCII maps ─────────────────────────────────────────────────────────────

interface Legend {
  tile: string | null;
  ref: string;
  spawn: boolean;
  player: boolean;
  facing: boolean;
}

/** Characters tried for a legend entry the converter has to add. */
const SPARE_CHARS = ".,:;_-~'`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A text replacement in a YAML source: [start, end) → text. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Column of offset `at` in `text`. */
const columnOf = (text: string, at: number) => at - (text.lastIndexOf('\n', at - 1) + 1);
/** End of a node's text at `range`, without the whitespace and newlines after it. */
const endOf = (text: string, range: readonly number[]) => range[0]! + text.slice(range[0], range[1]).trimEnd().length;
/** A YAML scalar for a map row: single quotes when it holds a double quote. */
const quoteRow = (r: string) => (r.includes('"') && !r.includes("'") ? `'${r}'` : JSON.stringify(r));

/**
 * Convert one ASCII map entry of `text` (parsed as `map`); returns the text
 * edits and reports, or null when it has no edge tiles in cells. Only the
 * rows, room rects and new legend entries change, so comments and layout
 * stay as written.
 */
function convertAscii(text: string, map: YAMLMap, p: PackDir, tiles: Map<string, RawTile>): { edits: Edit[]; reports: ConvertReport[] } | null {
  const rules = rulesFor(tiles);
  const legendNode = map.get('legend', true);
  if (!isMap(legendNode)) return null;
  const legend = new Map<string, Legend>();
  for (const pair of legendNode.items) {
    const ch = String(isScalar(pair.key) ? pair.key.value : pair.key);
    const v = isMap(pair.value) ? (pair.value.toJSON() as Json) : {};
    legend.set(ch, { tile: resolveTile(tiles, p, v['tile']), ref: String(v['tile']), spawn: v['spawn'] !== undefined, player: v['player'] === true, facing: v['facing'] !== undefined });
  }
  const floorsNode = map.get('floors', true);
  const layers: YAMLSeq[] = [];
  if (isSeq(floorsNode)) {
    for (const f of floorsNode.items) {
      const rows = isMap(f) ? f.get('rows', true) : null;
      if (!isSeq(rows)) return null;
      layers.push(rows);
    }
  } else {
    const rows = map.get('rows', true);
    if (!isSeq(rows)) return null;
    layers.push(rows);
  }
  const grid = layers.map((rows) => rows.items.map((r) => [...String(isScalar(r) ? r.value : r)]));
  const height = grid[0]!.length;
  const width = grid[0]![0]?.length ?? 0;
  const floors = grid.length;
  const chars: string[] = [];
  const cells: (string | null)[] = [];
  for (const rows of grid)
    for (const row of rows)
      for (const ch of row) {
        chars.push(ch);
        const l = legend.get(ch);
        cells.push(l ? l.tile : null);
      }
  if (!cells.some((t) => t !== null && rules.wallLike(t))) return null; // nothing to convert
  const out = convertCells({ width, height, floors, cells }, rules);
  const edits: Edit[] = [];

  // Legend characters for the new ground tiles (added when the legend has none).
  const added: string[] = [];
  const groundChar = new Map<string, string>();
  const charOf = (tile: string): string => {
    let ch = groundChar.get(tile);
    if (ch) return ch;
    const plainEntry = (noFacing: boolean) => [...legend].find(([c, l]) => c !== ' ' && l.tile === tile && !l.spawn && !l.player && (!noFacing || !l.facing));
    ch = (plainEntry(true) ?? plainEntry(false))?.[0];
    if (!ch) {
      ch = [...SPARE_CHARS].find((c) => !legend.has(c))!;
      const ref = [...legend.values()].find((l) => l.tile === tile)?.ref ?? (tile.startsWith(`${p.ns}:`) ? tile.slice(p.ns.length + 1) : tile);
      legend.set(ch, { tile, ref, spawn: false, player: false, facing: false });
      added.push(`${JSON.stringify(ch)}: { tile: ${ref} }`);
    }
    groundChar.set(tile, ch);
    return ch;
  };
  const area = width * height;
  const solid = (ch: string) => {
    const t = legend.get(ch)?.tile;
    return !!t && !(tiles.get(t)?.walkable ?? false);
  };
  layers.forEach((rowsNode, z) => {
    const at = (x: number, y: number) => z * area + y * width + x;
    const rows = edgeRows(
      width,
      height,
      (x, y) => {
        const i = at(x, y);
        if (!out.wall[i]) return chars[i]!;
        const t = out.cells[i];
        return t === null || t === undefined ? ' ' : charOf(t);
      },
      (x, y) => (out.edgeN[at(x, y)] !== null ? chars[at(x, y)]! : null),
      (x, y) => (out.edgeW[at(x, y)] !== null ? chars[at(x, y)]! : null),
      solid,
    );
    const start = rowsNode.range![0];
    const end = endOf(text, rowsNode.range!);
    const indent = ' '.repeat(columnOf(text, start));
    edits.push({ start, end, text: rows.map((r) => `- ${quoteRow(r)}`).join(`\n${indent}`) });
  });
  if (added.length) {
    const first = legendNode.items[0]!.key as Scalar;
    const indent = ' '.repeat(columnOf(text, first.range![0]));
    const end = endOf(text, legendNode.range!);
    edits.push({ start: end, end, text: added.map((a) => `\n${indent}${a}`).join('') });
  }
  // `edges: true` on its own line, right before the rows.
  const key = map.items.find((pair) => isScalar(pair.key) && pair.key.value === (isSeq(floorsNode) ? 'floors' : 'rows'))!.key as Scalar;
  const keyAt = key.range![0];
  edits.push({ start: keyAt, end: keyAt, text: `edges: true\n${' '.repeat(columnOf(text, keyAt))}` });

  const rooms = map.get('rooms', true);
  if (isSeq(rooms)) {
    for (const room of rooms.items) {
      if (!isMap(room)) continue;
      const rect = room.get('rect', true);
      const z = Number(room.get('floor') ?? 0);
      if (!isSeq(rect) || rect.items.length !== 4) continue;
      const [x, y, w, h] = rect.items.map((v) => Number(isScalar(v) ? v.value : v));
      const g = growRoom({ x: x!, y: y!, w: w!, h: h!, z }, out.wall, width, height);
      if (g.x !== x || g.y !== y || g.w !== w || g.h !== h) edits.push({ start: rect.range![0], end: endOf(text, rect.range!), text: `[${g.x}, ${g.y}, ${g.w}, ${g.h}]` });
    }
  }
  return { edits, reports: out.reports };
}

// ── Tiled maps ─────────────────────────────────────────────────────────────

interface TilesetRef {
  firstgid: number;
  /** The tileset object (inline, or the parsed external `.tsj`). */
  ts: Json;
  /** Path of the external `.tsj` (pack-relative), or null for an inline one. */
  file: string | null;
}

interface FloorLayers {
  /** Visible tile layers without an `edge` property, bottom first. */
  cells: Json[];
  /** The list holding the floor's layers (a group's `layers`, or the map's for floor 0 without groups). */
  list: unknown[];
  objects: Json[];
}

const property = (o: Json, name: string): unknown => (Array.isArray(o['properties']) ? (o['properties'] as Json[]).find((p) => p['name'] === name)?.['value'] : undefined);

function convertTiled(p: PackDir, tmjPath: string, tiles: Map<string, RawTile>): { reports: ConvertReport[]; files: Map<string, string> } | null {
  const rules = rulesFor(tiles);
  const root = JSON.parse(readFileSync(join(p.dir, tmjPath), 'utf8')) as Json;
  const width = root['width'] as number;
  const height = root['height'] as number;
  const area = width * height;
  const sets: TilesetRef[] = (root['tilesets'] as Json[]).map((t) => {
    if (typeof t['source'] === 'string') {
      const file = join(dirname(tmjPath), t['source']).split('\\').join('/');
      return { firstgid: t['firstgid'] as number, ts: JSON.parse(readFileSync(join(p.dir, file), 'utf8')) as Json, file };
    }
    return { firstgid: t['firstgid'] as number, ts: t, file: null };
  });
  sets.sort((a, b) => a.firstgid - b.firstgid);
  const setOf = (gid: number) => [...sets].reverse().find((s) => s.firstgid <= gid);
  const tileOf = (gid: number): { id: string | null; facing: unknown } => {
    const s = setOf(gid);
    const entry = s && (s.ts['tiles'] as Json[] | undefined)?.find((t) => t['id'] === gid - s.firstgid);
    return entry ? { id: resolveTile(tiles, p, property(entry, 'tile')), facing: property(entry, 'facing') } : { id: null, facing: undefined };
  };

  // Floors: groups with a `floor` property, else the top-level list is floor 0.
  const floors: FloorLayers[] = [];
  const top = root['layers'] as Json[];
  const collect = (list: Json[], z: number): void => {
    const f = (floors[z] ??= { cells: [], list, objects: [] });
    for (const l of list) {
      if (l['visible'] === false) continue;
      if (l['type'] === 'group') {
        const fz = property(l, 'floor');
        collect(l['layers'] as Json[], typeof fz === 'number' ? fz : z);
      } else if (l['type'] === 'tilelayer' && property(l, 'edge') === undefined) f.cells.push(l);
      else if (l['type'] === 'objectgroup') f.objects.push(...((l['objects'] as Json[]) ?? []));
    }
  };
  collect(top, 0);
  const nf = floors.length;
  const gids: (number | null)[] = new Array<number | null>(area * nf).fill(null);
  floors.forEach((f, z) => {
    for (const l of f.cells) {
      const data = l['data'] as number[];
      for (let i = 0; i < area; i++) if (data[i]) gids[z * area + i] = data[i]!;
    }
  });
  const gidRules: ConvertRules<number> = {
    wallLike: (g) => {
      const id = tileOf(g).id;
      return id !== null && rules.wallLike(id);
    },
    plain: (g) => {
      const id = tileOf(g).id;
      return id !== null && rules.plain(id);
    },
  };
  if (!gids.some((g) => g !== null && gidRules.wallLike(g))) return null;
  const out = convertCells({ width, height, floors: nf, cells: gids }, gidRules);

  // A ground gid without a facing: the same tile's unfaced tileset tile (added to the last tileset when missing).
  const dirty = new Set<TilesetRef>();
  const unfaced = (gid: number): number => {
    const { id, facing } = tileOf(gid);
    if (facing === undefined) return gid;
    for (const s of sets) {
      for (const t of (s.ts['tiles'] as Json[]) ?? []) {
        if (resolveTile(tiles, p, property(t, 'tile')) === id && property(t, 'facing') === undefined) return s.firstgid + (t['id'] as number);
      }
    }
    const last = sets[sets.length - 1]!;
    const list = ((last.ts['tiles'] as Json[]) ??= []);
    const localId = Math.max((last.ts['tilecount'] as number) ?? 0, ...list.map((t) => (t['id'] as number) + 1));
    const ref = property(list.find((t) => resolveTile(tiles, p, property(t, 'tile')) === id) ?? {}, 'tile') ?? id;
    list.push({ id: localId, properties: [{ name: 'tile', type: 'string', value: ref }] });
    last.ts['tilecount'] = localId + 1;
    dirty.add(last);
    return last.firstgid + localId;
  };

  let nextLayer = root['nextlayerid'] as number;
  floors.forEach((f, z) => {
    for (let i = 0; i < area; i++) {
      if (!out.wall[z * area + i]) continue;
      const ground = out.cells[z * area + i];
      f.cells.forEach((l, k) => ((l['data'] as number[])[i] = k === 0 && ground !== null && ground !== undefined ? unfaced(ground) : 0));
    }
    // Edge layers after the floor's last cell layer.
    const last = f.cells[f.cells.length - 1];
    let at = last ? f.list.indexOf(last) + 1 : f.list.length;
    for (const [side, edges] of [['n', out.edgeN], ['w', out.edgeW]] as const) {
      const data = edges.slice(z * area, (z + 1) * area).map((g) => g ?? 0);
      if (!data.some((g) => g !== 0)) continue;
      const layer = { data, height, id: nextLayer++, name: `edges ${side}`, opacity: 1, properties: [{ name: 'edge', type: 'string', value: side }], type: 'tilelayer', visible: true, width, x: 0, y: 0 };
      f.list.splice(at++, 0, layer);
    }
    // Rooms (in tile-height units on both axes for isometric maps).
    const ux = root['orientation'] === 'isometric' ? (root['tileheight'] as number) : (root['tilewidth'] as number);
    const uy = root['tileheight'] as number;
    for (const o of f.objects) {
      if ((o['type'] ?? o['class']) !== 'room') continue;
      const r = { x: Math.round((o['x'] as number) / ux), y: Math.round((o['y'] as number) / uy), w: Math.round((o['width'] as number) / ux), h: Math.round((o['height'] as number) / uy), z };
      const g = growRoom(r, out.wall, width, height);
      Object.assign(o, { height: g.h * uy, width: g.w * ux, x: g.x * ux, y: g.y * uy });
    }
  });
  root['nextlayerid'] = nextLayer;

  const files = new Map<string, string>();
  const rowsOf = (v: unknown, w: number): Out => {
    if (Array.isArray(v)) return v.map((x) => rowsOf(x, w));
    if (isObj(v)) {
      const o: { [k: string]: Out } = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === 'data' && Array.isArray(x) ? new Rows(x as number[], (v['width'] as number) ?? w) : rowsOf(x, w);
      return o;
    }
    return v as Out;
  };
  files.set(tmjPath, format(rowsOf(root, width)) + '\n');
  for (const s of dirty) if (s.file) files.set(s.file, format(rowsOf(s.ts, width)) + '\n');
  return { reports: out.reports, files };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function usage(message: string): never {
  console.error(`${message}\nusage: npm run map:edges -- <pack-dir>… [--map <id>]`);
  process.exit(2);
}

function main(argv: readonly string[]): void {
  const dirs: string[] = [];
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--map') only = argv[++i] ?? usage('missing map id after --map');
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else dirs.push(a);
  }
  if (!dirs.length) usage('no pack directories given');
  const packs = dirs.map((d) => readPackDir(resolve(d)));
  const tiles = collectTiles(packs);
  if (![...tiles.values()].some((t) => t.edge)) usage(`no tile has 'edge: true' in these packs: mark the wall-like tiles first`);
  let converted = 0;
  let reported = 0;
  for (const p of packs) {
    for (const file of p.yaml) {
      const text = readFileSync(join(p.dir, file), 'utf8');
      const doc = parseDocument(text);
      const maps = doc.get('maps', true);
      if (!isSeq(maps)) continue;
      const edits: Edit[] = [];
      for (const m of maps.items) {
        if (!isMap(m)) continue;
        const id = String(m.get('id'));
        if (only && only !== id && only !== `${p.ns}:${id}`) continue;
        if (m.get('edges') === true || m.has('size') || m.has('parts')) continue;
        const where = `${join(p.dir, file)} map '${p.ns}:${id}'`;
        let reports: ConvertReport[] | null = null;
        if (typeof m.get('tiled') === 'string') {
          const r = convertTiled(p, String(m.get('tiled')), tiles);
          if (r) {
            for (const [f, t] of r.files) writeFileSync(join(p.dir, f), t);
            reports = r.reports;
            console.log(`converted ${join(p.dir, String(m.get('tiled')))} (map '${p.ns}:${id}')`);
          }
        } else {
          const r = convertAscii(text, m, p, tiles);
          if (r) {
            edits.push(...r.edits);
            reports = r.reports;
            console.log(`converted ${where}`);
          }
        }
        if (!reports) continue;
        converted++;
        for (const r of reports) {
          reported++;
          console.log(`  check by hand: cell (${r.x}, ${r.y}${r.z ? `, floor ${r.z}` : ''}): ${r.message}`);
        }
      }
      if (edits.length) {
        let next = text;
        for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
        writeFileSync(join(p.dir, file), next);
      }
    }
  }
  console.log(`${converted} map${converted === 1 ? '' : 's'} converted, ${reported} cell${reported === 1 ? '' : 's'} to check by hand`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
