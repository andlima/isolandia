/**
 * Export a loaded map as an isometric Tiled map (64×32, the game's own
 * projection) plus an external image-collection tileset:
 *
 *   npm run map:export -- <pack-dir>… --map <id> --out <dir>
 *
 * Writes `<dir>/<id>.tmj` and `<dir>/<id>.tsj`. Output is stable: the same
 * input gives byte-identical files. Loading the result gives the same
 * `MapDef` as the source map (see the round-trip test). A one-floor map is
 * written as a `ground` tile layer, an `edges n` and an `edges w` tile layer
 * (property `edge: n` / `edge: w`, only when the floor has such edges) and
 * an `objects` layer; a multi-floor map as one `floor N` group (property
 * `floor: N`) per floor holding those.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EMPTY_TILE, FACINGS, formatError, loadPacks, type AssetDef, type Definition, type Facing, type MapDef } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';
import { format, Rows, type Out } from './tiled-json.ts';

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;
const TILED_VERSION = '1.10.2';
const FORMAT_VERSION = '1.10';
const FACING_ORDER: readonly (Facing | null)[] = [null, 'n', 'e', 's', 'w'];

export interface ExportOptions {
  /** Base name of the files: the map is `<name>.tmj`, the tileset `<name>.tsj`. */
  readonly name: string;
  /** Path of an asset image relative to the `.tsj`; null to leave the tile without an image. */
  readonly image: (asset: AssetDef, file: string) => string | null;
}

const prop = (name: string, value: string): Out => ({ name, type: 'string', value });

/** A reference as written in the map's pack: local when it is the pack's own id, else qualified. */
function refFrom(ns: string, id: string): string {
  return id.startsWith(`${ns}:`) ? id.slice(ns.length + 1) : id;
}

/** The unmirrored image of the nearest drawn direction to `facing`. */
function previewFile(asset: AssetDef, facing: Facing): string | null {
  const i = FACINGS.indexOf(facing);
  for (let d = 0; d <= 4; d++) {
    for (const j of d === 0 ? [i] : [(i + d) % 8, (i + 8 - d) % 8]) {
      const fi = asset.byFacing[j];
      if (fi && !fi.mirrored) return asset.images[fi.image]?.file ?? null;
    }
  }
  return asset.images[0]?.file ?? null;
}

/** Write `map` as Tiled JSON: the `.tmj` text and its external `.tsj` tileset. */
export function exportTiledMap(def: Definition, map: MapDef, opts: ExportOptions): { tmj: string; tsj: string } {
  const ns = map.id.slice(0, map.id.indexOf(':'));
  const { width, height, floors } = map;
  const area = width * height;
  const key = (tile: number, facing: Facing | null) => `${tile}|${facing ?? ''}`;

  // One tileset tile per used (tile, facing) pair, sorted by tile id then facing.
  const pairs = new Map<string, { tile: number; facing: Facing | null }>();
  map.cells.forEach((tile, i) => tile !== EMPTY_TILE && pairs.set(key(tile, map.facings[i] ?? null), { tile, facing: map.facings[i] ?? null }));
  for (const edges of [map.edgeN, map.edgeW]) for (const tile of edges) if (tile !== EMPTY_TILE) pairs.set(key(tile, null), { tile, facing: null });
  const sorted = [...pairs.values()].sort((a, b) => {
    const ia = def.tiles[a.tile]!.id;
    const ib = def.tiles[b.tile]!.id;
    return ia < ib ? -1 : ia > ib ? 1 : FACING_ORDER.indexOf(a.facing) - FACING_ORDER.indexOf(b.facing);
  });
  const localId = new Map(sorted.map((p, i) => [key(p.tile, p.facing), i]));

  const tiles: Out[] = sorted.map((p, id) => {
    const t = def.tiles[p.tile]!;
    const props: Out[] = [];
    if (p.facing) props.push(prop('facing', p.facing));
    props.push(prop('tile', refFrom(ns, t.id)));
    const out: { [k: string]: Out } = { id };
    if (t.sprite !== null) {
      const asset = def.assets[t.sprite]!;
      const file = previewFile(asset, p.facing ?? 's');
      const image = file !== null ? opts.image(asset, file) : null;
      if (image !== null) out['image'] = image;
    }
    out['properties'] = props;
    return out;
  });
  const tsj: Out = {
    columns: 0,
    grid: { height: TILE_HEIGHT, orientation: 'isometric', width: TILE_WIDTH },
    margin: 0,
    name: opts.name,
    spacing: 0,
    tilecount: sorted.length,
    tiledversion: TILED_VERSION,
    tileheight: TILE_HEIGHT,
    tiles,
    tilewidth: TILE_WIDTH,
    type: 'tileset',
    version: FORMAT_VERSION,
  };

  // Objects per floor: the player, spawns (as loaded), then rooms in source order.
  // Tiled stores isometric object positions in tile-height units on both axes.
  const u = TILE_HEIGHT;
  const objects: Out[][] = Array.from({ length: floors }, () => []);
  let nextId = 1;
  const point = (type: string, name: string, x: number, y: number, z: number, props: Out[]): void => {
    const o: { [k: string]: Out } = { height: 0, id: nextId++, name, point: true };
    if (props.length) o['properties'] = props;
    Object.assign(o, { rotation: 0, type, visible: true, width: 0, x: (x + 0.5) * u, y: (y + 0.5) * u });
    objects[z]!.push(o);
  };
  if (map.playerStart) point('player', 'player', map.playerStart.x, map.playerStart.y, map.playerStart.z, []);
  for (const s of map.spawns) {
    const arch = refFrom(ns, def.archetypes[s.archetype]!.id);
    point('spawn', arch, s.x, s.y, s.z, [prop('archetype', arch)]);
  }
  for (const r of map.rooms.rects) {
    const tags = r.tags.map((t) => def.roomTags[t]!).join(', ');
    objects[r.z]!.push({
      height: r.h * u,
      id: nextId++,
      name: tags,
      properties: [prop('tags', tags)],
      rotation: 0,
      type: 'room',
      visible: true,
      width: r.w * u,
      x: r.x * u,
      y: r.y * u,
    });
  }

  let nextLayer = 1;
  const tileLayer = (name: string, gids: number[], props: Out[] | null): Out => {
    const layer: { [k: string]: Out } = { data: new Rows(gids, width), height, id: nextLayer++, name, opacity: 1 };
    if (props) layer['properties'] = props;
    return Object.assign(layer, { type: 'tilelayer', visible: true, width, x: 0, y: 0 });
  };
  const floorLayers = (z: number): Out[] => {
    const out: Out[] = [
      tileLayer(
        'ground',
        map.cells.slice(z * area, (z + 1) * area).map((tile, i) => (tile === EMPTY_TILE ? 0 : 1 + localId.get(key(tile, map.facings[z * area + i] ?? null))!)),
        null,
      ),
    ];
    for (const [side, edges] of [['n', map.edgeN], ['w', map.edgeW]] as const) {
      const gids = edges.slice(z * area, (z + 1) * area).map((tile) => (tile === EMPTY_TILE ? 0 : 1 + localId.get(key(tile, null))!));
      if (gids.some((g) => g !== 0)) out.push(tileLayer(`edges ${side}`, gids, [prop('edge', side)]));
    }
    out.push({ draworder: 'topdown', id: nextLayer++, name: 'objects', objects: objects[z]!, opacity: 1, type: 'objectgroup', visible: true, x: 0, y: 0 });
    return out;
  };
  const layers: Out[] =
    floors === 1
      ? floorLayers(0)
      : Array.from({ length: floors }, (_, z): Out => {
          const id = nextLayer++;
          return { id, layers: floorLayers(z), name: `floor ${z}`, opacity: 1, properties: [{ name: 'floor', type: 'int', value: z }], type: 'group', visible: true, x: 0, y: 0 };
        });

  const tmj: Out = {
    compressionlevel: -1,
    height,
    infinite: false,
    layers,
    nextlayerid: nextLayer,
    nextobjectid: nextId,
    orientation: 'isometric',
    renderorder: 'right-down',
    tiledversion: TILED_VERSION,
    tileheight: TILE_HEIGHT,
    tilesets: [{ firstgid: 1, source: `${opts.name}.tsj` }],
    tilewidth: TILE_WIDTH,
    type: 'map',
    version: FORMAT_VERSION,
    width,
  };
  return { tmj: format(tmj) + '\n', tsj: format(tsj) + '\n' };
}

/** Find a map by qualified id, or by local id when exactly one pack defines it. */
export function findMap(def: Definition, id: string): MapDef | string {
  const exact = def.maps.find((m) => m.id === id);
  if (exact) return exact;
  const local = def.maps.filter((m) => m.id.slice(m.id.indexOf(':') + 1) === id);
  if (local.length === 1) return local[0]!;
  const ids = def.maps.map((m) => m.id).join(', ');
  return local.length > 1 ? `map '${id}' is ambiguous (${local.map((m) => m.id).join(', ')}); qualify it` : `unknown map '${id}'; available: ${ids}`;
}

function usage(message: string): never {
  console.error(`${message}\nusage: npm run map:export -- <pack-dir>… --map <id> --out <dir>`);
  process.exit(2);
}

function main(argv: readonly string[]): void {
  const dirs: string[] = [];
  let mapId: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--map') mapId = argv[++i];
    else if (a === '--out') out = argv[++i];
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else dirs.push(a);
  }
  if (!dirs.length) usage('no pack directories given');
  if (!mapId) usage('missing --map <id>');
  if (!out) usage('missing --out <dir>');

  const result = loadPacks(dirs.map(readPack));
  if (!result.ok) {
    for (const e of result.errors) console.error(formatError(e));
    process.exit(1);
  }
  const def = result.definition;
  const map = findMap(def, mapId);
  if (typeof map === 'string') usage(map);

  const outDir = resolve(out);
  const packDir = new Map(def.packs.map((p, i) => [p.namespace, resolve(dirs[i]!)]));
  const name = map.id.slice(map.id.indexOf(':') + 1);
  const { tmj, tsj } = exportTiledMap(def, map, {
    name,
    image: (asset, file) => {
      const dir = packDir.get(asset.pack);
      return dir ? relative(outDir, join(dir, file)).split(sep).join('/') : null;
    },
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.tmj`), tmj);
  writeFileSync(join(outDir, `${name}.tsj`), tsj);
  console.log(`wrote ${join(out, `${name}.tmj`)} and ${join(out, `${name}.tsj`)} (${map.width}×${map.height}${map.floors > 1 ? `, ${map.floors} floors` : ''})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
