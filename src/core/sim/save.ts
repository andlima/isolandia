/**
 * Save files: validation and exact restore of a `World` from `world.save()`
 * (see `docs/saves.md`). Restore reaches into the world only through the
 * internal `RestoreFn` hook of its constructor, which replaces spawning,
 * container creation and loot rolls; nothing is rolled or re-clamped.
 */

import { EMPTY_TILE, type ArchetypeDef, type Definition } from '../definition.ts';
import { FACINGS, type Facing } from '../facing.ts';
import { nearMiss } from '../expr/index.ts';
import type { Activity } from './activity.ts';
import { createContainer, type Container, type ContainerKind } from './containers.ts';
import {
  World,
  type Action,
  type ActionRecord,
  type GotoRecord,
  type Intent,
  type OutcomeRecord,
  type RestoreResult,
  type SaveFile,
} from './world.ts';

/** Current save file format version: bump it on any breaking change to `state` (see `docs/saves.md`). */
export const SAVE_VERSION = 2;

/** Every save `version` that `World.restore` reads (version 1 has no floors: every `z` is 0). */
export const SUPPORTED_SAVE_VERSIONS: readonly number[] = [1, SAVE_VERSION];

/** Shell metadata stored next to a save (never inside `state`). */
export interface SaveMeta {
  /** Wall-clock time of the save, ISO 8601. */
  savedAt: string;
  /** In-game day (from 1) and time `HH:MM` at the save. */
  day: number;
  time: string;
  tick: number;
  /** Pack namespaces, in load order. */
  packs: string[];
}

/** What shells store and export: metadata plus the save. */
export interface SaveWrapper {
  meta: SaveMeta;
  save: SaveFile;
}

const pad2 = (v: number) => String(v).padStart(2, '0');

/** Slot metadata for `world` saved at wall-clock time `savedAt` (ISO string, supplied by the shell). */
export function saveMeta(world: World, savedAt: string): SaveMeta {
  const c = world.clock;
  return { savedAt, day: c.day, time: `${pad2(c.hour)}:${pad2(c.minute)}`, tick: world.tick, packs: world.def.packs.map((p) => p.namespace) };
}

/** `world.save()` wrapped with its metadata. */
export function wrapSave(world: World, savedAt: string): SaveWrapper {
  return { meta: saveMeta(world, savedAt), save: world.save() };
}

/**
 * Accept a wrapper (`{ meta, save }`) or a bare save file: returns the save
 * part (unchecked, for `World.restore`) and the metadata when it looks valid.
 */
export function unwrapSave(v: unknown): { save: unknown; meta: SaveMeta | null } {
  if (isObj(v) && !('format' in v) && 'save' in v) return { save: v['save'], meta: isMeta(v['meta']) ? v['meta'] : null };
  return { save: v, meta: null };
}

function isMeta(v: unknown): v is SaveMeta {
  return (
    isObj(v) &&
    typeof v['savedAt'] === 'string' &&
    Number.isInteger(v['day']) &&
    typeof v['time'] === 'string' &&
    Number.isInteger(v['tick']) &&
    Array.isArray(v['packs']) &&
    v['packs'].every((p) => typeof p === 'string')
  );
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (typeof v === 'string') return `'${v}'`;
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
  } catch {
    return typeof v;
  }
}

const ACTION_KINDS = ['take', 'put', 'drop', 'use', 'act', 'craft'] as const;
const CONTAINER_KINDS: readonly ContainerKind[] = ['tile', 'inventory', 'ground'];

/** Id tables of a definition, by the name used in messages. */
type IdKind = 'archetype' | 'measurement' | 'status' | 'item' | 'tile' | 'action' | 'recipe';

/** Collects errors (with JSON paths) and warnings in one pass. */
class Checker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  constructor(
    readonly def: Definition,
    readonly width: number,
    readonly height: number,
    readonly floors: number,
  ) {}

  err(path: string, msg: string): null {
    this.errors.push(`${path}: ${msg}`);
    return null;
  }

  warn(path: string, msg: string): void {
    this.warnings.push(`${path}: ${msg}`);
  }

  obj(v: unknown, path: string): Obj | null {
    return isObj(v) ? v : this.err(path, `expected an object, got ${show(v)}`);
  }

  arr(v: unknown, path: string): unknown[] | null {
    return Array.isArray(v) ? v : this.err(path, `expected an array, got ${show(v)}`);
  }

  int(v: unknown, path: string, min = -Infinity, max = Infinity): number | null {
    if (typeof v !== 'number' || !Number.isInteger(v)) return this.err(path, `expected an integer, got ${show(v)}`);
    if (v < min || v > max) return this.err(path, max === Infinity ? `${v} must be ≥ ${min}` : `${v} is out of range [${min}, ${max}]`);
    return v;
  }

  num(v: unknown, path: string): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : this.err(path, `expected a finite number, got ${show(v)}`);
  }

  str(v: unknown, path: string): string | null {
    return typeof v === 'string' ? v : this.err(path, `expected a string, got ${show(v)}`);
  }

  bool(v: unknown, path: string): boolean | null {
    return typeof v === 'boolean' ? v : this.err(path, `expected a boolean, got ${show(v)}`);
  }

  /** Index of a qualified id, or null (error with a did-you-mean). */
  id(kind: IdKind, v: unknown, path: string): number | null {
    const s = this.str(v, path);
    if (s === null) return null;
    const table = this.table(kind);
    const k = table[s];
    if (k !== undefined) return k;
    const near = nearMiss(s, Object.keys(table));
    return this.err(path, `unknown ${kind} '${s}'${near ? ` (did you mean '${near}'?)` : ''}`);
  }

  private table(kind: IdKind): Readonly<Record<string, number>> {
    const ids = this.def.ids;
    switch (kind) {
      case 'archetype':
        return ids.archetypes;
      case 'measurement':
        return ids.measurements;
      case 'status':
        return ids.statuses;
      case 'item':
        return ids.items;
      case 'tile':
        return ids.tiles;
      case 'action':
        return ids.actions;
      case 'recipe':
        return ids.recipes;
    }
  }

  /** An in-bounds cell (`[x, y, z]` triple or `x`/`y`/`z` fields), or null. */
  cell(x: unknown, y: unknown, z: unknown, path: string): [number, number, number] | null {
    const cx = this.int(x, `${path}.x`);
    const cy = this.int(y, `${path}.y`);
    const cz = this.int(z, `${path}.z`);
    if (cx === null || cy === null || cz === null) return null;
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.width || cy >= this.height || cz >= this.floors) {
      return this.err(path, `cell (${cx}, ${cy}, ${cz}) is out of bounds (map is ${this.width}×${this.height}, ${this.floors} floor${this.floors === 1 ? '' : 's'})`);
    }
    return [cx, cy, cz];
  }

  /** A `[x, y, z]` triple inside the map. */
  triple(v: unknown, path: string): [number, number, number] | null {
    if (!Array.isArray(v) || v.length !== 3) return this.err(path, `expected [x, y, z], got ${show(v)}`);
    return this.cell(v[0], v[1], v[2], path);
  }

  /** Cell index of an in-bounds cell. */
  index([x, y, z]: readonly [number, number, number]): number {
    return (z * this.height + y) * this.width + x;
  }

  /** Optional field: absent is fine, otherwise checked by `check`. */
  opt<T>(o: Obj, key: string, path: string, check: (v: unknown, p: string) => T | null): boolean {
    return o[key] === undefined || check(o[key], `${path}.${key}`) !== null;
  }

  /** A player action (queued, `then`, or a goto's `then`). */
  action(v: unknown, path: string): Action | null {
    const o = this.obj(v, path);
    if (!o) return null;
    const kind = o['kind'];
    if (!ACTION_KINDS.includes(kind as Action['kind'])) return this.err(`${path}.kind`, `unknown action kind ${show(kind)}`);
    const n = this.errors.length;
    const count = (p: string) => this.opt(o, 'count', p, (c, q) => this.num(c, q));
    const xy = () => {
      this.opt(o, 'x', path, (c, q) => this.int(c, q));
      this.opt(o, 'y', path, (c, q) => this.int(c, q));
      this.opt(o, 'z', path, (c, q) => this.int(c, q));
    };
    switch (kind as Action['kind']) {
      case 'take':
      case 'put':
        this.int(o['container'], `${path}.container`, 0);
        this.id('item', o['item'], `${path}.item`);
        count(path);
        break;
      case 'drop':
        this.id('item', o['item'], `${path}.item`);
        count(path);
        break;
      case 'use':
        this.id('item', o['item'], `${path}.item`);
        break;
      case 'act':
        this.id('action', o['action'], `${path}.action`);
        xy();
        break;
      case 'craft':
        this.id('recipe', o['recipe'], `${path}.recipe`);
        xy();
        break;
    }
    return this.errors.length === n ? (o as unknown as Action) : null;
  }

  intent(v: unknown, path: string, isPlayer: boolean): Intent | null | undefined {
    if (v === null) return null;
    const o = this.obj(v, path);
    if (!o) return undefined;
    const n = this.errors.length;
    if (o['kind'] === 'step') {
      this.int(o['dx'], `${path}.dx`, -1, 1);
      this.int(o['dy'], `${path}.dy`, -1, 1);
    } else if (o['kind'] === 'goto') {
      this.int(o['x'], `${path}.x`);
      this.int(o['y'], `${path}.y`);
      this.opt(o, 'z', path, (c, q) => this.int(c, q));
      this.opt(o, 'adjacent', path, (c, q) => this.bool(c, q));
      if (o['then'] !== undefined) {
        if (!isPlayer) this.err(`${path}.then`, `only the player's goto may carry 'then'`);
        else this.action(o['then'], `${path}.then`);
      }
    } else this.err(`${path}.kind`, `unknown intent kind ${show(o['kind'])}`);
    return this.errors.length === n ? (o as unknown as Intent) : undefined;
  }

  record(v: unknown, path: string): OutcomeRecord | null | undefined {
    if (v === null) return null;
    const o = this.obj(v, path);
    if (!o) return undefined;
    const ok = this.int(o['tick'], `${path}.tick`, 0) !== null && this.str(o['message'], `${path}.message`) !== null;
    return ok ? (o as unknown as OutcomeRecord) : undefined;
  }

  lastAction(v: unknown, path: string): ActionRecord | null | undefined {
    if (v === null) return null;
    const o = this.obj(v, path);
    if (!o) return undefined;
    const n = this.errors.length;
    const kind = o['kind'];
    if (!ACTION_KINDS.includes(kind as Action['kind'])) this.err(`${path}.kind`, `unknown action kind ${show(kind)}`);
    const item = this.str(o['item'], `${path}.item`);
    if (item) this.id('item', item, `${path}.item`);
    this.opt(o, 'action', path, (c, q) => this.id('action', c, q));
    this.opt(o, 'recipe', path, (c, q) => this.id('recipe', c, q));
    this.num(o['moved'], `${path}.moved`);
    this.opt(o, 'dropped', path, (c, q) => this.num(c, q));
    this.bool(o['ok'], `${path}.ok`);
    if (o['stage'] !== 'start' && o['stage'] !== 'complete') this.err(`${path}.stage`, `expected 'start' or 'complete', got ${show(o['stage'])}`);
    this.opt(o, 'reason', path, (c, q) => this.str(c, q));
    this.int(o['tick'], `${path}.tick`, 0);
    return this.errors.length === n ? (o as unknown as ActionRecord) : undefined;
  }
}

/** A checked entity, ready to build. */
interface EntityPlan {
  archetype: ArchetypeDef;
  x: number;
  y: number;
  z: number;
  facing: Facing;
  fromX: number;
  fromY: number;
  fromZ: number;
  stepTick: number;
  moveCooldown: number;
  path: Int32Array | null;
  /** [measurement index, value] for each saved measurement the archetype has. */
  measurements: [number, number][];
  statuses: number[];
  intent: Intent | null;
  lastGoto: GotoRecord | null;
  home: [number, number, number];
  driven: boolean;
  /** Behavior state index, or -1 for the initial state. */
  state: number;
  stateTick: number;
  /** [x, y, z, tick]. */
  plan: [number, number, number, number] | null;
  /** [x, y, z, tick]. */
  heard: [number, number, number, number] | null;
  activity: { kind: 'act' | 'use' | 'craft'; index: number; x: number; y: number; z: number; startTick: number; endTick: number } | null;
  then: Action | null;
}

interface ContainerPlan {
  id: number;
  kind: ContainerKind;
  x: number;
  y: number;
  z: number;
  owner: number;
  stacks: [number, number][];
}

/** `World.restore`: validate everything, then build the world through its restore hook. */
export function restoreWorld(def: Definition, save: unknown): RestoreResult {
  try {
    return restore(def, save);
  } catch (e) {
    // Defensive: validation should make this unreachable.
    return { ok: false, errors: [`save: cannot restore (${e instanceof Error ? e.message : String(e)})`] };
  }
}

function restore(def: Definition, raw: unknown): RestoreResult {
  const map = def.maps[def.start.map]!;
  const c = new Checker(def, map.width, map.height, map.floors);
  const root = c.obj(raw, 'save');
  if (!root) return { ok: false, errors: c.errors };

  // ── Header ───────────────────────────────────────────────────────────────
  let headerOk = true;
  if (root['format'] !== 'isolandia-save') {
    c.err('format', `expected 'isolandia-save', got ${show(root['format'])}`);
    headerOk = false;
  }
  if (!SUPPORTED_SAVE_VERSIONS.includes(root['version'] as number)) {
    c.err('version', `unsupported save version ${show(root['version'])} (supported: ${SUPPORTED_SAVE_VERSIONS.join(', ')})`);
    headerOk = false;
  }
  const packs = c.arr(root['packs'], 'packs');
  if (packs) {
    const saved: (string | null)[] = packs.map((p, i) => {
      const o = c.obj(p, `packs[${i}]`);
      if (!o) return null;
      const ns = c.str(o['namespace'], `packs[${i}].namespace`);
      const version = c.str(o['version'], `packs[${i}].version`);
      const loaded = def.packs.find((d) => d.namespace === ns);
      if (loaded && version !== null && loaded.version !== version) c.warn(`packs[${i}]`, `pack '${ns}' is version ${loaded.version}, the save was made with ${version}`);
      return ns;
    });
    const want = def.packs.map((p) => p.namespace);
    if (saved.every((s) => s !== null) && (saved.length !== want.length || saved.some((s, i) => s !== want[i]))) {
      c.err('packs', `the save was made with packs [${saved.join(', ')}] but the loaded packs are [${want.join(', ')}]`);
      headerOk = false;
    }
  }
  const v1 = root['version'] === 1;
  const m = c.obj(root['map'], 'map');
  if (m) {
    const id = c.str(m['id'], 'map.id');
    const w = c.int(m['width'], 'map.width');
    const h = c.int(m['height'], 'map.height');
    const f = v1 ? 1 : c.int(m['floors'], 'map.floors', 1);
    const size = (ww: number, hh: number, ff: number) => `${ww}×${hh}${ff > 1 ? `, ${ff} floors` : ''}`;
    if (id !== null && w !== null && h !== null && f !== null && (id !== map.id || w !== map.width || h !== map.height || f !== map.floors)) {
      c.err('map', `the save is for map '${id}' (${size(w, h, f)}) but the start map is '${map.id}' (${size(map.width, map.height, map.floors)})`);
      headerOk = false;
    }
  }
  // Another format, version, pack list or map: the state's ids and cells would only add noise.
  if (!headerOk) return { ok: false, errors: c.errors };
  const s = c.obj(v1 ? upgradeV1(root['state']) : root['state'], 'state');
  if (!s) return { ok: false, errors: c.errors };

  // ── World fields ─────────────────────────────────────────────────────────
  const tick = c.int(s['tick'], 'state.tick', 0);
  const rng = c.int(s['rng'], 'state.rng', 0, 0xffffffff);
  const seed = c.int(s['seed'], 'state.seed');
  const player = c.int(s['player'], 'state.player', 0);
  const nextContainer = c.int(s['nextContainer'], 'state.nextContainer', 0);
  const actions: Action[] = [];
  const rawActions = c.arr(s['actions'], 'state.actions');
  rawActions?.forEach((a, i) => {
    const ok = c.action(a, `state.actions[${i}]`);
    if (ok) actions.push(ok);
  });
  const lastAction = c.lastAction(s['lastAction'], 'state.lastAction');
  const defeat = c.record(s['defeat'], 'state.defeat');
  const victory = c.record(s['victory'], 'state.victory');

  // ── Changed tiles (applied before the tile container check) ──────────────
  const tiles: [number, number][] = [];
  const tileAt = new Map<number, number>();
  c.arr(s['tiles'], 'state.tiles')?.forEach((t, i) => {
    const path = `state.tiles[${i}]`;
    if (!Array.isArray(t) || t.length !== 4) return c.err(path, `expected [x, y, z, tile id], got ${show(t)}`);
    const cell = c.cell(t[0], t[1], t[2], path);
    const tile = c.id('tile', t[3], `${path}[3]`);
    if (cell && tile !== null) {
      const at = c.index(cell);
      if (map.cells[at] === EMPTY_TILE) return c.err(path, `cell (${cell.join(', ')}) is empty in the map; a changed tile cannot be placed there`);
      tiles.push([at, tile]);
      tileAt.set(at, tile);
    }
    return null;
  });

  // ── Entities ─────────────────────────────────────────────────────────────
  const plans: (EntityPlan | null)[] = [];
  const rawEntities = c.arr(s['entities'], 'state.entities') ?? [];
  rawEntities.forEach((v, i) => plans.push(checkEntity(c, v, i, i === player)));
  if (player !== null && rawEntities.length > 0 && player >= rawEntities.length) c.err('state.player', `player ${player} is not one of the ${rawEntities.length} entities`);
  if (rawEntities.length === 0 && Array.isArray(s['entities'])) c.err('state.entities', 'no entities (the player must be one of them)');

  // ── Containers ───────────────────────────────────────────────────────────
  const containers: ContainerPlan[] = [];
  const seen = new Set<number>();
  const owners = new Map<number, number>();
  c.arr(s['containers'], 'state.containers')?.forEach((v, i) => {
    const path = `state.containers[${i}]`;
    const o = c.obj(v, path);
    if (!o) return;
    const id = c.int(o['id'], `${path}.id`, 0);
    if (id !== null) {
      if (seen.has(id)) c.err(`${path}.id`, `duplicate container id ${id}`);
      else if (nextContainer !== null && id >= nextContainer) c.err(`${path}.id`, `container id ${id} is not below nextContainer (${nextContainer})`);
      seen.add(id);
    }
    const kind = o['kind'] as ContainerKind;
    if (!CONTAINER_KINDS.includes(kind)) {
      c.err(`${path}.kind`, `expected one of ${CONTAINER_KINDS.join(', ')}, got ${show(o['kind'])}`);
      return;
    }
    let x = -1;
    let y = -1;
    let z = -1;
    let owner = -1;
    let ok = true;
    if (kind === 'inventory') {
      const n = c.errors.length;
      const ow = o['owner'] === undefined ? c.err(`${path}.owner`, 'inventory has no owner') : c.int(o['owner'], `${path}.owner`, 0);
      const plan = ow === null ? undefined : plans[ow];
      if (ow !== null && ow >= rawEntities.length) c.err(`${path}.owner`, `owner ${ow} is not an entity`);
      else if (plan && !plan.archetype.inventory) c.err(`${path}.owner`, `archetype '${plan.archetype.id}' of entity ${ow} has no inventory`);
      else if (ow !== null && owners.has(ow)) c.err(`${path}.owner`, `entity ${ow} already has inventory ${owners.get(ow)}`);
      if (ow !== null && id !== null && !owners.has(ow)) owners.set(ow, id);
      owner = ow ?? -1;
      ok = c.errors.length === n;
    } else {
      const cell = c.triple(o['cell'], `${path}.cell`);
      if (cell) {
        [x, y, z] = cell;
        const at = c.index(cell);
        const t = tileAt.get(at) ?? map.cells[at]!;
        const tile = t === EMPTY_TILE ? undefined : def.tiles[t]!;
        if (kind === 'tile' && !tile?.container) ok = !!c.err(`${path}.cell`, `${tile ? `tile '${tile.id}'` : 'the empty cell'} at (${x}, ${y}, ${z}) holds no container`);
      } else ok = false;
    }
    const stacks: [number, number][] = [];
    c.arr(o['stacks'], `${path}.stacks`)?.forEach((st, k) => {
      const sp = `${path}.stacks[${k}]`;
      if (!Array.isArray(st) || st.length !== 2) return void c.err(sp, `expected [item id, count], got ${show(st)}`);
      const item = c.id('item', st[0], `${sp}[0]`);
      const count = c.int(st[1], `${sp}[1]`, 1);
      if (item !== null && stacks.some((x) => x[0] === item)) c.err(`${sp}[0]`, `item '${def.items[item]!.id}' has more than one stack`);
      else if (item !== null && count !== null) stacks.push([item, count]);
    });
    if (ok && id !== null) containers.push({ id, kind, x, y, z, owner, stacks });
  });
  plans.forEach((p, i) => {
    if (p?.archetype.inventory && !owners.has(i)) c.err(`state.entities[${i}]`, `archetype '${p.archetype.id}' has an inventory, but the save has no inventory container for entity ${i}`);
  });

  if (c.errors.length > 0) return { ok: false, errors: c.errors };

  // ── Build ────────────────────────────────────────────────────────────────
  const entities = plans as EntityPlan[];
  containers.sort((a, b) => a.id - b.id);
  const world = new World(def, seed!, (w, host) => {
    w.tick = tick!;
    w.rng.state = rng!;
    w.lastAction = lastAction ?? null;
    w.defeat = defeat ?? null;
    w.victory = victory ?? null;
    for (const [at, tile] of tiles) w.grid.setTile(at, tile);
    const invs = new Map<number, Container>();
    for (const p of containers) {
      const cellTile = p.kind === 'tile' ? w.grid.cells[w.grid.index(p.x, p.y, p.z)]! : -1;
      const capacity = p.kind === 'tile' ? def.tiles[cellTile]!.container!.capacity : p.kind === 'ground' ? Infinity : entities[p.owner]!.archetype.inventory!.capacity;
      const box = createContainer(p.id, p.kind, capacity, p.kind === 'inventory' ? { owner: p.owner } : { x: p.x, y: p.y, z: p.z, ...(p.kind === 'tile' ? { tile: cellTile } : {}) });
      for (const [item, count] of p.stacks) {
        box.stacks.push({ item, count });
        box.load += host.itemWeights[item]! * count;
      }
      if (p.kind === 'inventory') invs.set(p.owner, box);
      host.container(box);
    }
    entities.forEach((p, i) => {
      const e = host.entity(p.archetype, p.x, p.y, p.z, p.home, invs.get(i) ?? null, p.driven);
      e.facing = p.facing;
      e.fromX = p.fromX;
      e.fromY = p.fromY;
      e.fromZ = p.fromZ;
      e.stepTick = p.stepTick;
      e.moveCooldown = p.moveCooldown;
      e.path = p.path;
      e.pathPos = 0;
      for (const [idx, v] of p.measurements) e.m[idx] = v;
      for (const k of p.statuses) e.st[k] = 1;
      e.intent = p.intent;
      e.lastGoto = p.lastGoto;
      if (e.behavior && p.state >= 0) {
        e.state = p.state;
        e.stateTick = p.stateTick;
      }
      if (e.behavior && p.plan) [e.planX, e.planY, e.planZ, e.planTick] = p.plan;
      if (p.heard) [e.heardX, e.heardY, e.heardZ, e.heardTick] = p.heard;
      if (p.activity) {
        const a = p.activity;
        const source = a.kind === 'act' ? host.actionSources[a.index]! : a.kind === 'craft' ? host.recipeSources[a.index]! : host.useSources[a.index]!;
        const activity: Activity = { source, action: source.action, x: a.x, y: a.y, z: a.z, startTick: a.startTick, endTick: a.endTick };
        e.activity = activity;
      }
      e.then = p.then;
    });
    host.setNextContainer(nextContainer!);
    host.setActions(actions);
    return w.entities[player!]!;
  });
  return { ok: true, world, warnings: c.warnings };
}

/** Check one saved entity; null when it has errors. */
function checkEntity(c: Checker, v: unknown, i: number, isPlayer: boolean): EntityPlan | null {
  const path = `state.entities[${i}]`;
  const o = c.obj(v, path);
  if (!o) return null;
  const { def } = c;
  const n = c.errors.length;
  const id = c.int(o['id'], `${path}.id`);
  if (id !== null && id !== i) c.err(`${path}.id`, `entity ids must be 0..n-1 in order: expected ${i}, got ${id}`);
  const ai = c.id('archetype', o['archetype'], `${path}.archetype`);
  const archetype = ai === null ? null : def.archetypes[ai]!;
  const pos = c.cell(o['x'], o['y'], o['z'], path);
  const facing = FACINGS.includes(o['facing'] as Facing) ? (o['facing'] as Facing) : c.err(`${path}.facing`, `expected one of ${FACINGS.join(', ')}, got ${show(o['facing'])}`);
  const from = c.cell(o['fromX'], o['fromY'], o['fromZ'], `${path}.from`);
  const stepTick = c.int(o['stepTick'], `${path}.stepTick`, 0);
  const moveCooldown = c.int(o['moveCooldown'], `${path}.moveCooldown`, 0);

  let path_: Int32Array | null = null;
  if (o['path'] !== null) {
    const cells = c.arr(o['path'], `${path}.path`);
    if (cells) {
      const out: number[] = [];
      cells.forEach((p, k) => {
        const cell = c.triple(p, `${path}.path[${k}]`);
        if (cell) out.push(c.index(cell));
      });
      path_ = out.length > 0 ? Int32Array.from(out) : null;
    }
  }

  const measurements: [number, number][] = [];
  const ms = c.obj(o['measurements'], `${path}.measurements`);
  if (ms) {
    const savedIdx = new Set<number>();
    for (const [key, value] of Object.entries(ms)) {
      const mp = `${path}.measurements[${JSON.stringify(key)}]`;
      const idx = c.id('measurement', key, mp);
      const val = c.num(value, mp);
      if (idx === null || val === null || !archetype) continue;
      savedIdx.add(idx);
      if (archetype.measurements.includes(idx)) measurements.push([idx, val]);
      else c.warn(mp, `archetype '${archetype.id}' no longer has measurement '${key}'; dropped`);
    }
    if (archetype) {
      archetype.measurements.forEach((idx, k) => {
        if (!savedIdx.has(idx)) c.warn(`${path}.measurements`, `measurement '${def.measurements[idx]!.id}' is missing; it starts at ${archetype.initial[k]}`);
      });
    }
  }

  const statuses: number[] = [];
  c.arr(o['statuses'], `${path}.statuses`)?.forEach((st, k) => {
    const idx = c.id('status', st, `${path}.statuses[${k}]`);
    if (idx !== null) statuses.push(idx);
  });

  const intent = c.intent(o['intent'], `${path}.intent`, isPlayer);
  let lastGoto: GotoRecord | null = null;
  if (o['lastGoto'] !== null) {
    const g = c.obj(o['lastGoto'], `${path}.lastGoto`);
    if (g) {
      const lp = `${path}.lastGoto`;
      const ok = [c.int(g['x'], `${lp}.x`), c.int(g['y'], `${lp}.y`), c.int(g['z'], `${lp}.z`), c.bool(g['ok'], `${lp}.ok`), c.int(g['tick'], `${lp}.tick`, 0)];
      if (ok.every((x) => x !== null)) lastGoto = g as unknown as GotoRecord;
    }
  }
  const home = c.triple(o['home'], `${path}.home`);

  // Behavior: the player is never driven.
  const behavior = archetype && !isPlayer && archetype.behavior !== null ? def.behaviors[archetype.behavior]! : null;
  let state = -1;
  let stateTick = 0;
  let plan: [number, number, number, number] | null = null;
  const b = o['behavior'];
  if (b !== null) {
    const bo = c.obj(b, `${path}.behavior`);
    if (bo && archetype && !behavior) c.warn(`${path}.behavior`, `archetype '${archetype.id}' has no behavior here; the saved state is dropped`);
    if (bo && behavior) {
      const bp = `${path}.behavior`;
      const name = c.str(bo['state'], `${bp}.state`);
      if (name !== null) {
        const k = behavior.states.findIndex((st) => st.name === name);
        if (k >= 0) state = k;
        else {
          const near = nearMiss(name, behavior.states.map((st) => st.name));
          c.err(`${bp}.state`, `behavior '${behavior.id}' has no state '${name}'${near ? ` (did you mean '${near}'?)` : ''}`);
        }
      }
      stateTick = c.int(bo['since'], `${bp}.since`, 0) ?? 0;
      if (bo['plan'] !== null) {
        const pl = bo['plan'];
        if (!Array.isArray(pl) || pl.length !== 4) c.err(`${bp}.plan`, `expected [x, y, z, tick], got ${show(pl)}`);
        else {
          const ptick = c.int(pl[3], `${bp}.plan[3]`, 0);
          // `investigate` marks a state planned without a goto as (-1, -1, -1).
          const cell = pl[0] === -1 && pl[1] === -1 && pl[2] === -1 ? ([-1, -1, -1] as [number, number, number]) : c.cell(pl[0], pl[1], pl[2], `${bp}.plan`);
          if (cell && ptick !== null) plan = [cell[0], cell[1], cell[2], ptick];
        }
      }
    }
  } else if (behavior) c.warn(`${path}.behavior`, `archetype '${archetype!.id}' now has behavior '${behavior.id}'; it starts in its initial state`);

  let heard: [number, number, number, number] | null = null;
  if (o['heard'] !== null) {
    const h = c.obj(o['heard'], `${path}.heard`);
    if (h) {
      const cell = c.cell(h['x'], h['y'], h['z'], `${path}.heard`);
      const t = c.int(h['tick'], `${path}.heard.tick`, 0);
      if (cell && t !== null) heard = [cell[0], cell[1], cell[2], t];
    }
  }

  let activity: EntityPlan['activity'] = null;
  if (o['activity'] !== null) {
    const ap = `${path}.activity`;
    const a = c.obj(o['activity'], ap);
    if (a) {
      let index: number | null = null;
      const kind = a['kind'];
      if (kind === 'act') index = c.id('action', a['action'], `${ap}.action`);
      else if (kind === 'craft') index = c.id('recipe', a['recipe'], `${ap}.recipe`);
      else if (kind === 'use') {
        index = c.id('item', a['item'], `${ap}.item`);
        if (index !== null && !def.items[index]!.use) index = c.err(`${ap}.item`, `item '${def.items[index]!.id}' has no use`);
      } else c.err(`${ap}.kind`, `expected 'act', 'use' or 'craft', got ${show(kind)}`);
      const cell = c.cell(a['x'], a['y'], a['z'], ap);
      const start = c.int(a['startTick'], `${ap}.startTick`, 0);
      const end = c.int(a['endTick'], `${ap}.endTick`, 0);
      if (start !== null && end !== null && end <= start) c.err(`${ap}.endTick`, `endTick ${end} must be after startTick ${start}`);
      if (index !== null && cell && start !== null && end !== null) activity = { kind: kind as 'act' | 'use' | 'craft', index, x: cell[0], y: cell[1], z: cell[2], startTick: start, endTick: end };
    }
  }

  let then: Action | null = null;
  if (o['then'] !== null) {
    if (!isPlayer) c.err(`${path}.then`, `only the player may have a pending 'then'`);
    else then = c.action(o['then'], `${path}.then`);
  }

  if (c.errors.length !== n || !archetype || !pos || !facing || !from || !home || stepTick === null || moveCooldown === null || intent === undefined) return null;
  return {
    archetype,
    x: pos[0],
    y: pos[1],
    z: pos[2],
    facing,
    fromX: from[0],
    fromY: from[1],
    fromZ: from[2],
    stepTick,
    moveCooldown,
    path: path_,
    measurements,
    statuses,
    intent,
    lastGoto,
    home,
    driven: behavior !== null,
    state,
    stateTick,
    plan,
    heard,
    activity,
    then,
  };
}

/**
 * A version 1 `state` in the version 2 shape: every cell gains `z = 0`.
 * Only well-formed parts are rewritten; anything else is left for the
 * checks to report.
 */
function upgradeV1(state: unknown): unknown {
  if (!isObj(state)) return state;
  const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 ? [v[0], v[1], 0] : v);
  // `z` goes right after `y`, as version 2 writes it (records are kept as saved, so key order reaches `hash()`).
  const xy = (v: unknown) => {
    if (!isObj(v) || v['z'] !== undefined) return v;
    const { x, y, ...rest } = v;
    return { x, y, z: 0, ...rest };
  };
  const out: Obj = { ...state };
  if (Array.isArray(state['tiles'])) out['tiles'] = state['tiles'].map((t: unknown) => (Array.isArray(t) && t.length === 3 ? [t[0], t[1], 0, t[2]] : t));
  if (Array.isArray(state['containers'])) out['containers'] = state['containers'].map((v: unknown) => (isObj(v) && v['cell'] !== undefined ? { ...v, cell: pair(v['cell']) } : v));
  if (Array.isArray(state['entities'])) {
    out['entities'] = state['entities'].map((v: unknown) => {
      if (!isObj(v)) return v;
      const e: Obj = { ...v, z: 0, fromZ: 0, home: pair(v['home']) };
      if (Array.isArray(v['path'])) e['path'] = v['path'].map(pair);
      if (isObj(v['lastGoto'])) e['lastGoto'] = xy(v['lastGoto']);
      if (isObj(v['heard'])) e['heard'] = xy(v['heard']);
      if (isObj(v['activity'])) e['activity'] = xy(v['activity']);
      const b = v['behavior'];
      if (isObj(b) && Array.isArray(b['plan']) && b['plan'].length === 3) {
        const [x, y, tick] = b['plan'] as unknown[];
        e['behavior'] = { ...b, plan: [x, y, x === -1 && y === -1 ? -1 : 0, tick] };
      }
      return e;
    });
  }
  return out;
}
