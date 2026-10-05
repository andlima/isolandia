/**
 * Tiled JSON map reader (`maps[].tiled`). Pure and platform-free: it reads
 * `.tmj`/`.tsj` text from the pack's file map and returns the same
 * intermediate the ASCII path builds (cells, facings, spawns, player start,
 * room rects with tag names). Problems carry the Tiled file and a JSON path;
 * the loader adds the pack and the YAML map entry.
 *
 * Tile ids and facings come from tileset tile properties (`tile`, `facing`),
 * never from gids or flip flags. The top-most non-empty gid of the visible
 * tile layers wins per cell. Objects are matched by `type`/`class`.
 */

import type { SpawnDef } from '../definition.ts';
import { CARDINALS, isFacing, type Facing } from '../facing.ts';
import { nearMiss } from '../expr/index.ts';
import { formatPath, type KeyPath } from './errors.ts';
import { ID_RE } from './pack.ts';

export interface TiledProblem {
  /** Pack-relative path of the Tiled file (`.tmj` or `.tsj`). */
  readonly file: string;
  /** JSON path inside the file, e.g. `layers[1].data[517]`. */
  readonly path: string;
  readonly message: string;
}

export type TiledLookup = (ref: string) => { index: number } | { error: string };

export interface TiledInput {
  /** The pack's Tiled text files: pack-relative path → text. */
  readonly files: Readonly<Record<string, string>>;
  /** Pack-relative path of the `.tmj`. */
  readonly path: string;
  readonly tile: TiledLookup;
  readonly archetype: TiledLookup;
}

export interface TiledRoom {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Room tag names, validated against the id pattern. */
  readonly tags: readonly string[];
}

export interface TiledMap {
  readonly width: number;
  readonly height: number;
  readonly cells: number[];
  readonly facings: (Facing | null)[];
  readonly spawns: SpawnDef[];
  readonly playerStart: { x: number; y: number } | null;
  readonly rooms: TiledRoom[];
}

export const OBJECT_CLASSES = ['player', 'spawn', 'room'] as const;

const FLIP_BITS = 0xf0000000;
const MAX_EMPTY_LISTED = 5;
const UNRESOLVED = -2;
const FAILED = -1;
const FACING_CODE: readonly (Facing | null)[] = [null, ...CARDINALS];

type Obj = { [k: string]: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Normalize a `/`-separated path, resolving `.` and `..`; null if it climbs above the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

interface Property {
  readonly value: unknown;
  readonly path: KeyPath;
}

/** A custom property by name (Tiled ≥ 1.2 stores them as a list of `{ name, type, value }`). */
function property(owner: Obj, ownerPath: KeyPath, name: string): Property | null {
  const props = owner['properties'];
  if (!Array.isArray(props)) return null;
  for (let i = 0; i < props.length; i++) {
    const p: unknown = props[i];
    if (isObj(p) && p['name'] === name) return { value: p['value'], path: [...ownerPath, 'properties', i, 'value'] };
  }
  return null;
}

interface Tileset {
  readonly firstgid: number;
  /** Number of gids the tileset covers. */
  readonly span: number;
  readonly name: string;
  readonly file: string;
  /** JSON path of the tileset object within `file`. */
  readonly path: KeyPath;
  /** Local id → `tiles[]` entry and its index. */
  readonly tiles: Map<number, { tile: Obj; index: number }>;
}

class Reader {
  readonly problems: TiledProblem[] = [];
  readonly file: string;

  constructor(readonly input: TiledInput) {
    this.file = input.path;
  }

  problem(path: KeyPath, message: string, file = this.file): void {
    this.problems.push({ file, path: formatPath(path), message });
  }

  json(file: string, what: string): Obj | null {
    let v: unknown;
    try {
      v = JSON.parse(this.input.files[file]!);
    } catch (e) {
      this.problem([], `invalid JSON in ${what}: ${(e as Error).message}`, file);
      return null;
    }
    if (!isObj(v)) {
      this.problem([], `a Tiled ${what} must be a JSON object`, file);
      return null;
    }
    return v;
  }

  read(): TiledMap | null {
    const root = this.json(this.file, 'map');
    if (!root) return null;
    const before = this.problems.length;

    if (root['type'] !== undefined && root['type'] !== 'map') {
      this.problem(['type'], `expected a Tiled map (type 'map'), got type ${JSON.stringify(root['type'])}`);
    }
    const orientation = root['orientation'];
    if (orientation !== 'orthogonal' && orientation !== 'isometric') {
      const hint = orientation === 'staggered' || orientation === 'hexagonal' ? ` (${orientation} maps are not supported)` : '';
      this.problem(['orientation'], `map orientation must be 'isometric' or 'orthogonal', got ${JSON.stringify(orientation)}${hint}`);
    }
    if (root['infinite'] === true) this.problem(['infinite'], `infinite maps are not supported: disable 'Infinite' in Map Properties`);
    const width = root['width'];
    const height = root['height'];
    for (const [k, v] of [['width', width], ['height', height]] as const) {
      if (!isInt(v) || v < 1) this.problem([k], `map '${k}' must be a positive integer, got ${JSON.stringify(v)}`);
    }
    for (const k of ['tilewidth', 'tileheight']) {
      const v = root[k];
      if (typeof v !== 'number' || !(v > 0)) this.problem([k], `map '${k}' must be a positive number, got ${JSON.stringify(v)}`);
    }
    if (this.problems.length > before) return null;
    const w = width as number;
    const h = height as number;

    const tilesets = this.tilesets(root);
    const gids = new GidTable(this, tilesets);
    const top = new Uint32Array(w * h);
    const objects: { obj: Obj; path: KeyPath }[] = [];
    if (!Array.isArray(root['layers'])) this.problem(['layers'], `map 'layers' must be a list`);
    else this.layers(root['layers'], ['layers'], w, h, gids, top, objects);

    const cells = new Array<number>(w * h).fill(0);
    const facings = new Array<Facing | null>(w * h).fill(null);
    const empty: number[] = [];
    for (let i = 0; i < w * h; i++) {
      const code = top[i] ? gids.code(top[i]!) : UNRESOLVED;
      if (!top[i]) empty.push(i);
      else if (code >= 0) {
        cells[i] = Math.floor(code / FACING_CODE.length);
        facings[i] = FACING_CODE[code % FACING_CODE.length]!;
      }
    }
    if (empty.length) {
      const listed = empty
        .slice(0, MAX_EMPTY_LISTED)
        .map((i) => `(${i % w}, ${Math.floor(i / w)})`)
        .join(', ');
      const more = empty.length > MAX_EMPTY_LISTED ? ', …' : '';
      this.problem(['layers'], `${empty.length} cell(s) are empty on every visible tile layer: ${listed}${more}; paint a tile on every cell`);
    }

    const ux = root['tilewidth'] as number;
    const uy = root['tileheight'] as number;
    // Tiled stores isometric object positions in tile-height units on both axes.
    const unit = orientation === 'isometric' ? [uy, uy] : [ux, uy];
    const { spawns, playerStart, rooms } = this.objects(objects, w, h, unit[0]!, unit[1]!);
    return { width: w, height: h, cells, facings, spawns, playerStart, rooms };
  }

  private tilesets(root: Obj): Tileset[] {
    const raw = root['tilesets'];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.problem(['tilesets'], `map 'tilesets' must be a list`);
      return [];
    }
    const out: Tileset[] = [];
    raw.forEach((ref: unknown, i) => {
      const path: KeyPath = ['tilesets', i];
      if (!isObj(ref)) {
        this.problem(path, `tileset entries must be objects`);
        return;
      }
      const firstgid = ref['firstgid'];
      if (!isInt(firstgid) || firstgid < 1) {
        this.problem([...path, 'firstgid'], `tileset 'firstgid' must be a positive integer, got ${JSON.stringify(firstgid)}`);
        return;
      }
      let ts: Obj = ref;
      let file = this.file;
      let tsPath: KeyPath = path;
      const source = ref['source'];
      if (source !== undefined) {
        if (typeof source !== 'string') {
          this.problem([...path, 'source'], `tileset 'source' must be a path`);
          return;
        }
        if (/\.tsx$/i.test(source)) {
          this.problem([...path, 'source'], `tileset '${source}' is a TSX (XML) file: save the tileset as JSON in Tiled (File → Export As… → JSON tileset files) and reference the .tsj`);
          return;
        }
        const resolved = normalizePath(dirOf(this.file) + source);
        if (resolved === null || this.input.files[resolved] === undefined) {
          const known = Object.keys(this.input.files).filter((f) => f.endsWith('.tsj'));
          const s = nearMiss(resolved ?? source, known);
          this.problem([...path, 'source'], `tileset file '${source}' not found (resolved to '${resolved ?? source}' in the pack)${s ? ` (did you mean '${s}'?)` : ''}`);
          return;
        }
        const ext = this.json(resolved, 'tileset');
        if (!ext) return;
        ts = ext;
        file = resolved;
        tsPath = [];
      }
      const tiles = new Map<number, { tile: Obj; index: number }>();
      let maxId = -1;
      const list = ts['tiles'];
      if (Array.isArray(list)) {
        list.forEach((t: unknown, index) => {
          if (isObj(t) && isInt(t['id'])) {
            tiles.set(t['id'], { tile: t, index });
            maxId = Math.max(maxId, t['id']);
          }
        });
      }
      const count = ts['tilecount'];
      const span = Math.max(isInt(count) ? count : 0, maxId + 1);
      const name = typeof ts['name'] === 'string' ? ts['name'] : `#${i}`;
      out.push({ firstgid, span, name, file, path: tsPath, tiles });
    });
    return out.sort((a, b) => a.firstgid - b.firstgid);
  }

  private layers(list: unknown[], path: KeyPath, w: number, h: number, gids: GidTable, top: Uint32Array, objects: { obj: Obj; path: KeyPath }[]): void {
    list.forEach((layer: unknown, i) => {
      const lp: KeyPath = [...path, i];
      if (!isObj(layer)) {
        this.problem(lp, `layers must be objects`);
        return;
      }
      if (layer['visible'] === false) return;
      const type = layer['type'];
      if (type === 'group') {
        if (Array.isArray(layer['layers'])) this.layers(layer['layers'], [...lp, 'layers'], w, h, gids, top, objects);
      } else if (type === 'tilelayer') this.tileLayer(layer, lp, w, h, gids, top);
      else if (type === 'objectgroup') {
        const objs = layer['objects'];
        if (Array.isArray(objs)) objs.forEach((obj: unknown, j) => isObj(obj) && objects.push({ obj, path: [...lp, 'objects', j] }));
      }
    });
  }

  private tileLayer(layer: Obj, path: KeyPath, w: number, h: number, gids: GidTable, top: Uint32Array): void {
    const compression = layer['compression'];
    if (typeof compression === 'string' && compression !== '') {
      this.problem([...path, 'compression'], `compressed layer data ('${compression}') is not supported: set Map Properties → Tile Layer Format to 'CSV' or 'Base64 (uncompressed)'`);
      return;
    }
    if (layer['width'] !== undefined && layer['height'] !== undefined && (layer['width'] !== w || layer['height'] !== h)) {
      this.problem(path, `tile layer is ${String(layer['width'])}×${String(layer['height'])}, but the map is ${w}×${h}`);
      return;
    }
    const dpath: KeyPath = [...path, 'data'];
    const raw = layer['data'];
    let data: ArrayLike<number>;
    let base64 = false;
    if (layer['encoding'] === 'base64') {
      if (typeof raw !== 'string') {
        this.problem(dpath, `base64 layer data must be a string`);
        return;
      }
      let bytes: string;
      try {
        bytes = atob(raw.trim());
      } catch {
        this.problem(dpath, `layer data is not valid base64`);
        return;
      }
      if (bytes.length !== w * h * 4) {
        this.problem(dpath, `layer data decodes to ${bytes.length} bytes, expected ${w * h * 4} (${w}×${h} cells × 4)`);
        return;
      }
      const out = new Uint32Array(w * h);
      for (let i = 0; i < out.length; i++) {
        const b = i * 4;
        out[i] = (bytes.charCodeAt(b) | (bytes.charCodeAt(b + 1) << 8) | (bytes.charCodeAt(b + 2) << 16) | (bytes.charCodeAt(b + 3) << 24)) >>> 0;
      }
      data = out;
      base64 = true;
    } else if (layer['encoding'] !== undefined && layer['encoding'] !== 'csv') {
      this.problem([...path, 'encoding'], `unsupported layer encoding ${JSON.stringify(layer['encoding'])}`);
      return;
    } else {
      if (!Array.isArray(raw)) {
        this.problem(dpath, `tile layer 'data' must be a list of gids`);
        return;
      }
      if (raw.length !== w * h) {
        this.problem(dpath, `tile layer has ${raw.length} cells, expected ${w * h} (${w}×${h})`);
        return;
      }
      data = raw as number[];
    }
    let flippedReported = false;
    for (let i = 0; i < w * h; i++) {
      const gid = data[i]!;
      const cpath: KeyPath = base64 ? dpath : [...dpath, i];
      const cell = `(cell ${i % w}, ${Math.floor(i / w)})`;
      if (!isInt(gid) || gid < 0 || gid > 0xffffffff) {
        this.problem(cpath, `invalid gid ${JSON.stringify(gid)} ${cell}`);
        continue;
      }
      if (gid === 0) continue;
      if ((gid & FLIP_BITS) !== 0) {
        if (!flippedReported) {
          flippedReported = true;
          this.problem(cpath, `flipped or rotated tile (gid ${gid}) ${cell}: use a tileset tile with a 'facing' property instead of flipping`);
        }
        continue;
      }
      gids.resolve(gid, cpath, cell);
      top[i] = gid;
    }
  }

  private objects(
    list: readonly { obj: Obj; path: KeyPath }[],
    w: number,
    h: number,
    ux: number,
    uy: number,
  ): Pick<TiledMap, 'spawns' | 'playerStart' | 'rooms'> {
    const spawns: { x: number; y: number; id: number; archetype: number }[] = [];
    let playerStart: { x: number; y: number } | null = null;
    const rooms: TiledRoom[] = [];
    for (const { obj, path } of list) {
      if (obj['visible'] === false) continue;
      const cls = typeof obj['type'] === 'string' && obj['type'] ? obj['type'] : typeof obj['class'] === 'string' ? obj['class'] : '';
      if (!cls) continue;
      const clsKey = typeof obj['type'] === 'string' && obj['type'] ? 'type' : 'class';
      if (!(OBJECT_CLASSES as readonly string[]).includes(cls)) {
        const s = nearMiss(cls, OBJECT_CLASSES);
        this.problem([...path, clsKey], `unknown object class '${cls}'${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${OBJECT_CLASSES.join(', ')}`);
        continue;
      }
      const rotation = obj['rotation'];
      if (rotation !== undefined && rotation !== 0) {
        this.problem([...path, 'rotation'], `rotated objects are not supported (rotation ${JSON.stringify(rotation)})`);
        continue;
      }
      const x = obj['x'];
      const y = obj['y'];
      if (typeof x !== 'number' || typeof y !== 'number') {
        this.problem(path, `object needs numeric 'x' and 'y'`);
        continue;
      }
      if (cls === 'room') {
        const ow = obj['width'];
        const oh = obj['height'];
        const rect = [Math.round(x / ux), Math.round(y / uy), Math.round((typeof ow === 'number' ? ow : 0) / ux), Math.round((typeof oh === 'number' ? oh : 0) / uy)] as const;
        const [x0, y0, rw, rh] = rect;
        let ok = true;
        const tagsProp = property(obj, path, 'tags');
        const tags: string[] = [];
        if (!tagsProp || typeof tagsProp.value !== 'string') {
          this.problem(tagsProp?.path ?? path, `room needs a string property 'tags' listing room tags (separated by commas or spaces)`);
          ok = false;
        } else {
          for (const t of tagsProp.value.split(/[\s,]+/).filter(Boolean)) {
            if (!ID_RE.test(t)) {
              this.problem(tagsProp.path, `invalid tag '${t}': tags must match [a-z][a-z0-9_]*`);
              ok = false;
            } else tags.push(t);
          }
          if (ok && tags.length === 0) {
            this.problem(tagsProp.path, `room 'tags' must list at least one tag`);
            ok = false;
          }
        }
        if (rw < 1 || rh < 1) {
          this.problem(path, `room rect [${rect.join(', ')}] is empty: w and h must be ≥ 1`);
          ok = false;
        } else if (x0 < 0 || y0 < 0 || x0 + rw > w || y0 + rh > h) {
          this.problem(path, `room rect [${rect.join(', ')}] is out of bounds: the map is ${w}×${h}`);
          ok = false;
        }
        if (ok) rooms.push({ x: x0, y: y0, w: rw, h: rh, tags });
        continue;
      }
      const cx = Math.floor(x / ux);
      const cy = Math.floor(y / uy);
      const cell = `(cell ${cx}, ${cy})`;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) {
        this.problem(path, `${cls} object is outside the map ${cell}; the map is ${w}×${h}`);
        continue;
      }
      if (cls === 'player') {
        if (playerStart) this.problem(path, `map has more than one player object ${cell} (another at ${playerStart.x},${playerStart.y})`);
        else playerStart = { x: cx, y: cy };
        continue;
      }
      const arch = property(obj, path, 'archetype');
      if (!arch || typeof arch.value !== 'string') {
        this.problem(arch?.path ?? path, `spawn needs a string property 'archetype' ${cell}`);
        continue;
      }
      const r = this.input.archetype(arch.value);
      if ('error' in r) {
        this.problem(arch.path, `${r.error} ${cell}`);
        continue;
      }
      spawns.push({ x: cx, y: cy, id: isInt(obj['id']) ? obj['id'] : 0, archetype: r.index });
    }
    // Row-major, then object id: entity ids match the ASCII loader whatever the file order.
    spawns.sort((a, b) => a.y - b.y || a.x - b.x || a.id - b.id);
    return { spawns: spawns.map(({ x, y, archetype }) => ({ x, y, archetype })), playerStart, rooms };
  }
}

/**
 * Gid → `tile * 5 + facing code` (facing code 0 = unset, else 1 + CARDINALS
 * index), resolved lazily so only used tiles are checked. One problem per
 * bad gid, at its first use.
 */
class GidTable {
  private readonly table: Int32Array;
  private readonly outside = new Set<number>();

  constructor(
    private readonly reader: Reader,
    private readonly tilesets: readonly Tileset[],
  ) {
    const max = tilesets.reduce((m, t) => Math.max(m, t.firstgid + t.span), 1);
    this.table = new Int32Array(max).fill(UNRESOLVED);
  }

  code(gid: number): number {
    return gid < this.table.length ? this.table[gid]! : FAILED;
  }

  resolve(gid: number, usePath: KeyPath, cell: string): void {
    if (gid < this.table.length ? this.table[gid] !== UNRESOLVED : this.outside.has(gid)) return;
    const ts = this.tileset(gid);
    if (!ts) {
      this.reader.problem(usePath, `gid ${gid} is outside every tileset ${cell}`);
      if (gid < this.table.length) this.table[gid] = FAILED;
      else this.outside.add(gid);
      return;
    }
    this.table[gid] = FAILED;
    const local = gid - ts.firstgid;
    const where = `tileset '${ts.name}' tile ${local}`;
    const used = `first used at ${this.reader.file} ${formatPath(usePath)} ${cell}`;
    const entry = ts.tiles.get(local);
    const tilesPath: KeyPath = entry ? [...ts.path, 'tiles', entry.index] : [...ts.path, 'tiles'];
    const tileProp = entry ? property(entry.tile, tilesPath, 'tile') : null;
    if (!tileProp || typeof tileProp.value !== 'string') {
      this.reader.problem(tilesPath, `${where} has no string property 'tile' naming a pack tile (${used})`, ts.file);
      return;
    }
    const r = this.reader.input.tile(tileProp.value);
    if ('error' in r) {
      this.reader.problem(tileProp.path, `${where}: ${r.error} (${used})`, ts.file);
      return;
    }
    let code = 0;
    const facing = property(entry!.tile, tilesPath, 'facing');
    if (facing) {
      const f = facing.value;
      if (typeof f === 'string' && CARDINALS.includes(f as Facing)) code = 1 + CARDINALS.indexOf(f as Facing);
      else {
        const diag = isFacing(f) ? ` (tiles face one of the 4 diamond sides; diagonals are not allowed)` : '';
        this.reader.problem(facing.path, `${where}: 'facing' must be one of ${CARDINALS.join(', ')}, got ${JSON.stringify(f)}${diag} (${used})`, ts.file);
        return;
      }
    }
    this.table[gid] = r.index * FACING_CODE.length + code;
  }

  private tileset(gid: number): Tileset | null {
    let found: Tileset | null = null;
    for (const t of this.tilesets) if (t.firstgid <= gid) found = t;
    return found && gid < found.firstgid + found.span ? found : null;
  }
}

/** Read a `.tmj` (and its `.tsj` tilesets) into the loader's map intermediate. */
export function readTiledMap(input: TiledInput): { map: TiledMap | null; problems: TiledProblem[] } {
  const reader = new Reader(input);
  const map = reader.read();
  return { map: reader.problems.length ? null : map, problems: reader.problems };
}
