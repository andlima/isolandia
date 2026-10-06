import { createHash } from 'node:crypto';
import { EMPTY_TILE, loadPacksOrThrow, World, type Definition } from '../src/core/index.ts';
import { readPack } from '../src/node/read-pack.ts';

/**
 * A namespace-free summary of a game's starting world, for the M7 move
 * equivalence tests (test/stacks-town.test.ts): the zombie and vampire games
 * must start the same world before and after becoming mods of `town`. Ids are
 * compared by **local id** (the part after `ns:`); `rename` maps a local id
 * of the current packs to the one recorded before the move.
 */
export interface WorldSummary {
  seed: number;
  map: { width: number; height: number; floors: number; cells: string[] };
  player: { archetype: string; x: number; y: number; z: number };
  entities: { counts: Record<string, number>; digest: string };
  containers: { count: number; items: Record<string, number>; digest: string };
  clock: { dayLength: number; start: number; dawn: number; dusk: number };
  lighting: { at: number; color: number }[] | null;
}

export type Rename = Readonly<Record<string, string>>;

const local = (id: string, rename: Rename): string => {
  const l = id.slice(id.indexOf(':') + 1);
  return rename[l] ?? l;
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const sorted = (m: Map<string, number>): Record<string, number> => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function loadStack(dirs: readonly string[]): Definition {
  return loadPacksOrThrow(dirs.map((d) => readPack(d)));
}

export function summarize(def: Definition, seed: number, rename: Rename = {}): WorldSummary {
  const w = World.create(def, seed);
  const map = def.maps[def.start.map]!;
  const tileId = (t: number) => (t === EMPTY_TILE ? '' : local(def.tiles[t]!.id, rename));
  const per = map.width * map.height;
  const cells: string[] = [];
  for (let z = 0; z < map.floors; z++) cells.push(sha(map.cells.slice(z * per, (z + 1) * per).map(tileId).join(',')));

  const counts = new Map<string, number>();
  for (const e of w.entities) {
    const a = local(e.archetype.id, rename);
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const entities = w.entities.map((e) => `${local(e.archetype.id, rename)}@${e.x},${e.y},${e.z}`).join(';');

  const items = new Map<string, number>();
  const rows: string[] = [];
  let count = 0;
  for (const c of w.containers.values()) {
    if (c.kind !== 'tile') continue;
    count++;
    const stacks = c.stacks.map((s) => {
      const id = local(def.items[s.item]!.id, rename);
      items.set(id, (items.get(id) ?? 0) + s.count);
      return `${id}x${s.count}`;
    });
    rows.push(`${tileId(c.tile)}@${c.x},${c.y},${c.z}:${stacks.join(',')}`);
  }

  const { dayLength, start, dawn, dusk } = def.clock;
  return {
    seed,
    map: { width: map.width, height: map.height, floors: map.floors, cells },
    player: { archetype: local(w.player.archetype.id, rename), x: w.player.x, y: w.player.y, z: w.player.z },
    entities: { counts: sorted(counts), digest: sha(entities) },
    containers: { count, items: sorted(items), digest: sha(rows.join(';')) },
    clock: { dayLength, start, dawn, dusk },
    lighting: def.lighting ? def.lighting.tint.map((k) => ({ at: k.at, color: k.color })) : null,
  };
}
