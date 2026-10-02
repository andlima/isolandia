/**
 * Pack loader pipeline:
 *   parse YAML → collect raw entries per pack → qualify ids → symbol table →
 *   resolve references → compile expressions → freeze.
 * Every stage reports into one ErrorSink; nothing is returned unless the
 * whole set of packs is valid.
 */

import { DEFAULT_CLOCK, parseTimeOfDay, type ClockDef } from '../clock.ts';
import {
  TICKS_PER_SECOND,
  type ArchetypeDef,
  type AssetDef,
  type ActivityKind,
  type BehaviorDef,
  type BehaviorStateDef,
  type ContainerSpec,
  type DefeatDef,
  type DistributionDef,
  type InventorySpec,
  type ItemCount,
  type ItemDef,
  type ItemUseDef,
  type LootEntryDef,
  type LootTableDef,
  type Definition,
  type EffectDef,
  type LightingDef,
  type MapDef,
  type MeasurementDef,
  type NumberTerm,
  type PackInfo,
  type RoomDef,
  type RoomsDef,
  type SpawnDef,
  type StatusDef,
  type StatusRate,
  type SystemDef,
  type TileDef,
  type TintKeyframe,
  type TransitionDef,
} from '../definition.ts';
import { compileSource, isPointType, nearMiss, type Compiled, type CompiledExpr } from '../expr/index.ts';
import { at, ErrorSink, PackLoadError, type LoadError, type Src } from './errors.ts';
import { ID_RE, isObject, parsePack, type Json, type ListDomain, type PackSource, type RawEntry, type RawPack } from './pack.ts';
import { SymbolTable, type Kind, type Scope } from './resolve.ts';
import { Fields } from './validate.ts';

export type LoadResult =
  | { ok: true; definition: Definition; warnings: readonly LoadError[] }
  | { ok: false; errors: readonly LoadError[]; warnings: readonly LoadError[] };

interface Defined {
  readonly id: string;
  readonly index: number;
  readonly entry: RawEntry;
  readonly scope: Scope;
}

const KIND_OF: Record<ListDomain, Kind> = {
  measurements: 'measurement',
  assets: 'asset',
  tiles: 'tile',
  archetypes: 'archetype',
  maps: 'map',
  systems: 'system',
  statuses: 'status',
  items: 'item',
  loot: 'loot',
  behaviors: 'behavior',
};

const DEFAULT_TICKS_PER_STEP = 2;
const DEFAULT_ANCHOR: readonly [number, number] = [0.5, 1];
const ASSET_EXT_RE = /\.(svg|png)$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_EVERY = 1 / TICKS_PER_SECOND;
const DEFAULT_DEFEAT_MESSAGE = 'Game over';
const EFFECT_FIELDS: Record<EffectDef['type'], string> = { apply: 'delta', set: 'value', noise: 'radius' };
const DEFAULT_USE_LABEL = 'Use';
const ACTIVITIES: readonly ActivityKind[] = ['idle', 'wander', 'pursue', 'flee', 'home', 'investigate'];
const DEFAULT_REPATH = 1;
const always = (): boolean => true;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

class Loader {
  readonly sink = new ErrorSink();
  readonly symbols = new SymbolTable();
  readonly defined: Record<ListDomain, Defined[]> = {
    measurements: [],
    assets: [],
    tiles: [],
    archetypes: [],
    maps: [],
    systems: [],
    statuses: [],
    items: [],
    loot: [],
    behaviors: [],
  };
  packs: { raw: RawPack; scope: Scope }[] = [];
  /** Every room tag used by a map, in first-seen order (collected before any expression compiles). */
  roomTags: string[] = [];
  /** Source of each resolved loot entry, per table (parallel to `LootTableDef.entries`). */
  private readonly lootEntrySrc: Src[][] = [];

  run(sources: readonly PackSource[]): LoadResult {
    this.parsePacks(sources);
    this.defineIds();
    this.collectRoomTags();
    const measurements = this.defined.measurements.map((d) => this.measurement(d));
    const assets = this.defined.assets.map((d) => this.asset(d));
    const items = this.defined.items.map((d) => this.item(d));
    const tiles = this.defined.tiles.map((d) => this.tile(d));
    const archetypes = this.defined.archetypes.map((d) => this.archetype(d, measurements, items));
    const maps = this.defined.maps.map((d) => this.map(d));
    const loot = this.defined.loot.map((d) => this.lootTable(d));
    this.checkLootCycles(loot);
    const distributions = this.distributions(tiles, loot, items);
    const statuses = this.defined.statuses.map((d) => this.status(d));
    const systems = this.defined.systems.map((d) => this.system(d));
    const behaviors = this.defined.behaviors.map((d) => this.behavior(d));
    const start = this.start(maps);
    const clock = this.clock();
    const lighting = this.lighting();
    const warnings = this.sink.warnings;
    if (this.sink.count > 0 || !start) return { ok: false, errors: this.sink.errors, warnings };

    const ids = (list: readonly { id: string; index: number }[]) => Object.fromEntries(list.map((d) => [d.id, d.index]));
    const definition: Definition = {
      ticksPerSecond: TICKS_PER_SECOND,
      packs: this.packs.map(
        ({ raw }): PackInfo => ({
          namespace: raw.namespace,
          name: raw.name,
          version: raw.version,
          depends: raw.depends.map((d) => d.ns),
        }),
      ),
      measurements,
      assets,
      tiles,
      archetypes,
      maps,
      systems,
      statuses,
      items,
      loot,
      behaviors,
      distributions,
      roomTags: this.roomTags,
      start,
      clock,
      lighting,
      ids: {
        measurements: ids(measurements),
        assets: ids(assets),
        tiles: ids(tiles),
        archetypes: ids(archetypes),
        maps: ids(maps),
        systems: ids(systems),
        statuses: ids(statuses),
        items: ids(items),
        loot: ids(loot),
        behaviors: ids(behaviors),
      },
    };
    return { ok: true, definition: deepFreeze(definition), warnings };
  }

  // ── Stage 1: packs and depends ──────────────────────────────────────────

  private parsePacks(sources: readonly PackSource[]): void {
    const seen = new Set<string>();
    for (const source of sources) {
      const raw = parsePack(source, this.sink);
      if (!raw) continue;
      if (seen.has(raw.namespace)) {
        this.sink.add({ source: raw.manifest, path: ['namespace'] }, `namespace '${raw.namespace}' is already loaded by an earlier pack`);
        continue;
      }
      const depends: string[] = [];
      for (const d of raw.depends) {
        if (d.ns === raw.namespace) this.sink.add(d.src, `pack '${raw.namespace}' cannot depend on itself`);
        else if (!seen.has(d.ns)) {
          this.sink.add(d.src, `unmet dependency: pack '${raw.namespace}' depends on '${d.ns}', which must be loaded before it`);
        } else depends.push(d.ns);
      }
      seen.add(raw.namespace);
      this.packs.push({ raw, scope: { namespace: raw.namespace, depends } });
    }
  }

  // ── Stage 2: qualify and register ids ───────────────────────────────────

  private defineIds(): void {
    for (const { raw, scope } of this.packs) {
      for (const domain of Object.keys(this.defined) as ListDomain[]) {
        for (const entry of raw.entries[domain]) {
          const r = this.symbols.define(KIND_OF[domain], entry.value['id'], scope, entry.src, this.sink);
          if (r) this.defined[domain].push({ ...r, entry, scope });
        }
      }
    }
  }

  // ── Expressions ─────────────────────────────────────────────────────────

  /**
   * Compile a numeric (or boolean) expression; reports and returns null on
   * error. `what` names the expected result in the type error.
   */
  private expr(source: string, scope: Scope, src: Src, what = 'a number'): { fn: Compiled; constant?: number } | null {
    const expr = this.compile(source, scope, src);
    if (!expr) return null;
    if (expr.type !== 'number' && expr.type !== 'boolean' && expr.type !== 'any') {
      this.sink.add(src, `expression "${source}" must produce ${what}, got ${expr.type}`);
      return null;
    }
    return expr;
  }

  /** Compile an expression of any type; reports and returns null on error. */
  private compile(source: string, scope: Scope, src: Src): CompiledExpr | null {
    const resolver = (kind: 'measurement' | 'status' | 'item') => (ref: string) => {
      const r = this.symbols.resolve(kind, ref, scope);
      return 'error' in r ? r : { index: r.index };
    };
    const { expr, errors, syntax } = compileSource(source, {
      resolveMeasurement: resolver('measurement'),
      resolveStatus: resolver('status'),
      resolveItem: resolver('item'),
      resolveRoomTag: (tag) => this.roomTag(tag),
    });
    if (errors.length) {
      for (const e of errors) this.sink.add(src, `${syntax ? 'expression syntax error' : 'expression error'} in "${source}": ${e.message}`);
      return null;
    }
    return expr;
  }

  /**
   * A condition field (`for`/`when`/`until`/`defeat.when`): an expression or
   * a boolean literal. Returns undefined when absent, null after an error.
   */
  private condition(f: Fields, key: string, scope: Scope, required = false): Compiled | null | undefined {
    const v = f.raw(key);
    if (v === undefined || v === null) {
      if (required) f.present(key);
      return required ? null : undefined;
    }
    if (typeof v === 'boolean') return () => v;
    if (typeof v !== 'string') {
      this.sink.add(f.at(key), `field '${key}' must be an expression (string) or true/false`);
      return null;
    }
    return this.expr(v, scope, f.at(key), 'a boolean or a number')?.fn ?? null;
  }

  /** A number or numeric expression, folded to a constant when possible; null after an error. */
  private numberTerm(v: Json | undefined, key: string, scope: Scope, src: Src): NumberTerm | null {
    if (typeof v === 'number' && Number.isFinite(v)) return { constant: v, fn: null };
    if (typeof v === 'string') {
      const e = this.expr(v, scope, src);
      if (!e) return null;
      return e.constant !== undefined ? { constant: e.constant, fn: null } : { constant: 0, fn: e.fn };
    }
    this.sink.add(src, `field '${key}' must be a number or an expression`);
    return null;
  }

  /** Validate a tag list (archetype or tile). */
  private tags(f: Fields): string[] {
    const tags = f.stringList('tags');
    tags.forEach((t, i) => {
      if (!ID_RE.test(t)) this.sink.add(f.at('tags', i), `invalid tag '${t}': tags must match [a-z][a-z0-9_]*`);
    });
    return tags;
  }

  // ── Stage 3: build definitions ──────────────────────────────────────────

  private measurement(d: Defined): MeasurementDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'label', 'min', 'max', 'initial', 'rate'], 'measurement');
    const label = f.string('label') ?? d.id;
    const min = f.number('min', false) ?? 0;
    const initial = f.number('initial') ?? min;

    let maxConst = Infinity;
    let maxFn: Compiled | null = null;
    const max = f.raw('max');
    if (typeof max === 'number') maxConst = max;
    else if (typeof max === 'string') {
      if (/^([a-z][a-z0-9_]*:)?[a-z][a-z0-9_]*$/.test(max) && !['self', 'player', 'tile', 'world'].includes(max)) {
        // A bare measurement reference means "this entity's value of it".
        const r = this.symbols.ref('measurement', max, d.scope, f.at('max'), this.sink);
        if (r) {
          if (r.index === d.index) this.sink.add(f.at('max'), `measurement '${d.id}' cannot be its own max`);
          const idx = r.index;
          maxFn = (c) => c.self.m[idx]!;
        }
      } else {
        const e = this.expr(max, d.scope, f.at('max'));
        if (e?.constant !== undefined) maxConst = e.constant;
        else if (e) maxFn = e.fn;
      }
    } else if (max !== undefined && max !== null) {
      this.sink.add(f.at('max'), `field 'max' must be a number, a measurement id or an expression`);
    }
    if (maxConst < min) this.sink.add(f.at('max'), `max (${maxConst}) is less than min (${min})`);

    let rateConst = 0;
    let rateFn: Compiled | null = null;
    const rate = f.raw('rate');
    if (typeof rate === 'number') rateConst = rate;
    else if (typeof rate === 'string') {
      const e = this.expr(rate, d.scope, f.at('rate'));
      if (e?.constant !== undefined) rateConst = e.constant;
      else if (e) rateFn = e.fn;
    } else if (rate !== undefined && rate !== null) {
      this.sink.add(f.at('rate'), `field 'rate' must be a number or an expression`);
    }

    return { id: d.id, index: d.index, label, min, maxConst, maxFn, initial, rateConst, rateFn };
  }

  private asset(d: Defined): AssetDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'file', 'anchor'], 'asset');
    const pack = this.packs.find((p) => p.scope.namespace === d.scope.namespace)!.raw;
    let file = f.string('file') ?? '';
    if (file) {
      file = file.replace(/^\.\//, '');
      if (!ASSET_EXT_RE.test(file)) {
        this.sink.add(f.at('file'), `unsupported asset file '${file}': must end in .svg or .png`);
      } else if (!pack.otherFiles.has(file)) {
        const base = file.slice(file.lastIndexOf('/') + 1);
        const s = nearMiss(file, pack.otherFiles) ?? [...pack.otherFiles].find((p) => p.endsWith(`/${base}`) || p === base) ?? null;
        this.sink.add(f.at('file'), `asset file '${file}' not found in pack '${pack.namespace}'${s ? ` (did you mean '${s}'?)` : ''}`);
      }
    }
    let anchor = DEFAULT_ANCHOR;
    const a = f.raw('anchor');
    if (a !== undefined && a !== null) {
      if (!Array.isArray(a) || a.length !== 2 || !a.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        this.sink.add(f.at('anchor'), `field 'anchor' must be a pair of numbers [ax, ay], got ${JSON.stringify(a)}`);
      } else if (!a.every((v) => (v as number) >= 0 && (v as number) <= 1)) {
        this.sink.add(f.at('anchor'), `anchor ${JSON.stringify(a)} is out of range: both values must be in [0, 1]`);
      } else anchor = [a[0] as number, a[1] as number];
    }
    return { id: d.id, index: d.index, pack: pack.namespace, file, anchor };
  }

  /** Optional `sprite` asset reference → asset index or null. */
  private sprite(f: Fields, d: Defined): number | null {
    if (!f.has('sprite')) return null;
    return this.symbols.ref('asset', f.raw('sprite'), d.scope, f.at('sprite'), this.sink)?.index ?? null;
  }

  private tile(d: Defined): TileDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'label', 'glyph', 'color', 'walkable', 'raised', 'opaque', 'sprite', 'tags', 'container'], 'tile');
    const walkable = f.boolean('walkable') ?? false;
    let container: ContainerSpec | null = null;
    const c = f.mapping('container');
    if (c) {
      const cf = new Fields(this.sink, f.at('container'), c, ['capacity'], 'container');
      const capacity = this.weight(cf, 'capacity');
      if (capacity !== undefined) container = { capacity };
    }
    return {
      id: d.id,
      index: d.index,
      label: f.string('label') ?? d.id,
      glyph: f.glyph() ?? '?',
      color: f.color() ?? 'white',
      walkable,
      raised: f.boolean('raised', false) ?? !walkable,
      opaque: f.boolean('opaque', false) ?? !walkable,
      sprite: this.sprite(f, d),
      tags: this.tags(f),
      container,
    };
  }

  /** A required weight or capacity (number ≥ 0), rounded to integer hundredths. */
  private weight(f: Fields, key: string): number | undefined {
    const v = f.number(key);
    if (v === undefined) return undefined;
    if (v < 0) {
      this.sink.add(f.at(key), `field '${key}' must be a number ≥ 0, got ${v}`);
      return undefined;
    }
    return Math.round(v * 100);
  }

  private item(d: Defined): ItemDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'label', 'glyph', 'color', 'weight', 'tags', 'sprite', 'use'], 'item');
    const label = f.string('label') ?? d.id;
    const glyph = f.glyph() ?? '?';
    const color = f.color() ?? 'white';
    const weight = this.weight(f, 'weight') ?? 0;
    const tags = this.tags(f);
    const sprite = this.sprite(f, d);
    let use: ItemUseDef | null = null;
    const u = f.mapping('use');
    if (u) {
      const uf = new Fields(this.sink, f.at('use'), u, ['label', 'when', 'effects', 'consume'], 'use');
      const useLabel = uf.string('label', false) ?? DEFAULT_USE_LABEL;
      const whenFn = this.condition(uf, 'when', d.scope) ?? null;
      const effects = this.effects(uf, d.scope);
      let consume = 1;
      const cv = uf.raw('consume');
      if (cv !== undefined && cv !== null) {
        if (typeof cv !== 'number' || !Number.isInteger(cv) || cv < 0) {
          this.sink.add(uf.at('consume'), `field 'consume' must be a non-negative integer, got ${JSON.stringify(cv)}`);
        } else consume = cv;
      }
      use = { label: useLabel, whenFn, effects, consume };
    }
    return { id: d.id, index: d.index, label, glyph, color, weight, tags, sprite, use };
  }

  private archetype(d: Defined, measurements: readonly MeasurementDef[], items: readonly ItemDef[]): ArchetypeDef {
    const f = new Fields(
      this.sink,
      d.entry.src,
      d.entry.value,
      ['id', 'label', 'glyph', 'color', 'tags', 'measurements', 'initial', 'ticks_per_step', 'sprite', 'inventory', 'behavior'],
      'archetype',
    );
    const label = f.string('label') ?? d.id;
    const glyph = f.glyph() ?? '?';
    const color = f.color() ?? 'white';
    const tags = this.tags(f);

    const indices: number[] = [];
    (f.list('measurements') ?? []).forEach((ref, i) => {
      const r = this.symbols.ref('measurement', ref, d.scope, f.at('measurements', i), this.sink);
      if (!r) return;
      if (indices.includes(r.index)) this.sink.add(f.at('measurements', i), `measurement '${r.id}' is listed twice`);
      else indices.push(r.index);
    });
    indices.sort((a, b) => a - b);

    const initial = indices.map((i) => measurements[i]!.initial);
    const overrides = f.mapping('initial');
    for (const [ref, value] of Object.entries(overrides ?? {})) {
      const src = f.at('initial', ref);
      const r = this.symbols.ref('measurement', ref, d.scope, src, this.sink);
      if (!r) continue;
      const k = indices.indexOf(r.index);
      if (k < 0) this.sink.add(src, `initial override for '${r.id}', which is not in this archetype's measurements`);
      else if (typeof value !== 'number') this.sink.add(src, `initial override must be a number`);
      else initial[k] = value;
    }

    let ticksPerStep = f.number('ticks_per_step', false) ?? DEFAULT_TICKS_PER_STEP;
    if (!Number.isInteger(ticksPerStep) || ticksPerStep < 1) {
      this.sink.add(f.at('ticks_per_step'), `field 'ticks_per_step' must be a positive integer`);
      ticksPerStep = DEFAULT_TICKS_PER_STEP;
    }
    const sprite = this.sprite(f, d);
    const inventory = this.inventory(f, d, items);
    const behavior = f.has('behavior') ? (this.symbols.ref('behavior', f.raw('behavior'), d.scope, f.at('behavior'), this.sink)?.index ?? null) : null;
    return { id: d.id, index: d.index, label, glyph, color, tags, measurements: indices, initial, ticksPerStep, sprite, inventory, behavior };
  }

  private inventory(f: Fields, d: Defined, items: readonly ItemDef[]): InventorySpec | null {
    const raw = f.mapping('inventory');
    if (!raw) return null;
    const inf = new Fields(this.sink, f.at('inventory'), raw, ['capacity', 'items'], 'inventory');
    const capacity = this.weight(inf, 'capacity');
    const start: ItemCount[] = [];
    let total = 0;
    for (const [ref, value] of Object.entries(inf.mapping('items') ?? {})) {
      const src = inf.at('items', ref);
      const r = this.symbols.ref('item', ref, d.scope, src, this.sink);
      if (!r) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        this.sink.add(src, `starting item count must be a positive integer, got ${JSON.stringify(value)}`);
        continue;
      }
      if (start.some((s) => s.item === r.index)) {
        this.sink.add(src, `item '${r.id}' is listed twice`);
        continue;
      }
      start.push({ item: r.index, count: value });
      total += (items[r.index]?.weight ?? 0) * value;
    }
    if (capacity === undefined) return null;
    if (total > capacity) {
      this.sink.add(inf.at('items'), `starting inventory weighs ${total / 100}, over its capacity of ${capacity / 100}`);
    }
    return { capacity, items: start };
  }

  private map(d: Defined): MapDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'legend', 'rows', 'rooms'], 'map');

    interface Legend {
      tile: number;
      spawn: number | null;
      player: boolean;
    }
    const legend = new Map<string, Legend>();
    const rawLegend = f.mapping('legend', true);
    for (const [ch, value] of Object.entries(rawLegend ?? {})) {
      const src = f.at('legend', ch);
      if ([...ch].length !== 1) {
        this.sink.add(src, `legend keys must be single characters, got ${JSON.stringify(ch)}`);
        continue;
      }
      if (!isObject(value)) {
        this.sink.add(src, `legend entry must be a mapping like { tile: floor }`);
        continue;
      }
      const lf = new Fields(this.sink, src, value, ['tile', 'spawn', 'player'], 'legend');
      const tile = lf.has('tile') ? this.symbols.ref('tile', value['tile'], d.scope, lf.at('tile'), this.sink) : lf.string('tile');
      const spawn = lf.has('spawn') ? this.symbols.ref('archetype', value['spawn'], d.scope, lf.at('spawn'), this.sink) : null;
      const player = lf.boolean('player', false) ?? false;
      if (tile && typeof tile === 'object') legend.set(ch, { tile: tile.index, spawn: spawn?.index ?? null, player });
      else legend.set(ch, { tile: -1, spawn: null, player });
    }

    const rows = f.list('rows');
    if (!rows && !f.has('rows')) f.string('rows'); // reports "missing required field"
    const width = rows && typeof rows[0] === 'string' ? [...rows[0]].length : 0;
    const height = rows?.length ?? 0;
    const cells: number[] = new Array<number>(width * height).fill(0);
    const spawns: SpawnDef[] = [];
    let playerStart: { x: number; y: number } | null = null;
    const missing = new Set<string>();

    if (rows && rows.length === 0) this.sink.add(f.at('rows'), `map must have at least one row`);
    (rows ?? []).forEach((row, y) => {
      const src = f.at('rows', y);
      if (typeof row !== 'string') {
        this.sink.add(src, `map rows must be strings`);
        return;
      }
      const chars = [...row];
      if (chars.length !== width) {
        this.sink.add(src, `ragged map rows: row ${y} has length ${chars.length}, expected ${width} (the length of row 0)`);
        return;
      }
      chars.forEach((ch, x) => {
        const l = legend.get(ch);
        if (!l) {
          if (!missing.has(ch)) {
            missing.add(ch);
            this.sink.add(src, `map character '${ch}' (row ${y}, column ${x}) is not in the legend`);
          }
          return;
        }
        cells[y * width + x] = l.tile;
        if (l.spawn !== null) spawns.push({ x, y, archetype: l.spawn });
        if (l.player) {
          if (playerStart) this.sink.add(src, `map has more than one player start cell (another at ${playerStart.x},${playerStart.y})`);
          else playerStart = { x, y };
        }
      });
    });
    const rooms = this.rooms(f, width, height);
    return { id: d.id, index: d.index, width, height, cells, spawns, playerStart, rooms };
  }

  /** Room tags from every raw map, so expressions and distributions can resolve them. */
  private collectRoomTags(): void {
    const seen = new Set<string>();
    for (const d of this.defined.maps) {
      const rooms = d.entry.value['rooms'];
      if (!Array.isArray(rooms)) continue;
      for (const room of rooms) {
        const tags = isObject(room) ? room['tags'] : null;
        if (!Array.isArray(tags)) continue;
        for (const t of tags) {
          if (typeof t === 'string' && ID_RE.test(t) && !seen.has(t)) {
            seen.add(t);
            this.roomTags.push(t);
          }
        }
      }
    }
  }

  private roomTag(tag: string): { index: number } | { error: string } {
    const index = this.roomTags.indexOf(tag);
    if (index >= 0) return { index };
    const s = nearMiss(tag, this.roomTags);
    return { error: `unknown room tag '${tag}'${s ? ` (did you mean '${s}'?)` : ''}` };
  }

  private rooms(f: Fields, width: number, height: number): RoomsDef {
    const rects: RoomDef[] = [];
    (f.list('rooms') ?? []).forEach((raw, i) => {
      const src = f.at('rooms', i);
      if (!isObject(raw)) {
        this.sink.add(src, `rooms must be mappings like { rect: [x, y, w, h], tags: [kitchen] }`);
        return;
      }
      const rf = new Fields(this.sink, src, raw, ['rect', 'tags'], 'room');
      const rect = rf.raw('rect');
      let ok = true;
      if (rect === undefined || rect === null) ok = rf.present('rect');
      else if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((v) => typeof v === 'number' && Number.isInteger(v))) {
        this.sink.add(rf.at('rect'), `field 'rect' must be four integers [x, y, w, h], got ${JSON.stringify(rect)}`);
        ok = false;
      }
      const tags = this.tags(rf);
      if (!rf.has('tags') || tags.length === 0) {
        this.sink.add(rf.has('tags') ? rf.at('tags') : src, `room 'tags' must list at least one tag`);
        ok = false;
      }
      if (!ok) return;
      const [x, y, w, h] = rect as number[];
      if (w! < 1 || h! < 1) {
        this.sink.add(rf.at('rect'), `room rect ${JSON.stringify(rect)} is empty: w and h must be ≥ 1`);
        return;
      }
      if (x! < 0 || y! < 0 || x! + w! > width || y! + h! > height) {
        this.sink.add(rf.at('rect'), `room rect ${JSON.stringify(rect)} is out of bounds: the map is ${width}×${height}`);
        return;
      }
      const idx = [...new Set(tags.map((t) => this.roomTags.indexOf(t)).filter((k) => k >= 0))].sort((a, b) => a - b);
      rects.push({ x: x!, y: y!, w: w!, h: h!, tags: idx });
    });

    const sets: number[][] = [[]];
    const keys = new Map<string, number>([['', 0]]);
    const cellSet = new Array<number>(width * height).fill(0);
    if (rects.length) {
      const perCell: Set<number>[] = Array.from({ length: width * height }, () => new Set<number>());
      for (const r of rects) {
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) for (const t of r.tags) perCell[y * width + x]!.add(t);
      }
      perCell.forEach((tags, i) => {
        const list = [...tags].sort((a, b) => a - b);
        const key = list.join(',');
        let k = keys.get(key);
        if (k === undefined) {
          k = sets.length;
          keys.set(key, k);
          sets.push(list);
        }
        cellSet[i] = k;
      });
    }
    return { rects, sets, cellSet };
  }

  // ── Loot ────────────────────────────────────────────────────────────────

  /** An integer or an inclusive `[min, max]` range, each ≥ `lo`; null after an error. */
  private range(v: Json | undefined, key: string, lo: number, src: Src): [number, number] | null {
    const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo;
    if (int(v)) return [v, v];
    if (Array.isArray(v) && v.length === 2 && int(v[0]) && int(v[1]) && v[0] <= v[1]) return [v[0], v[1]];
    this.sink.add(src, `field '${key}' must be an integer ≥ ${lo} or a range [min, max] with ${lo} ≤ min ≤ max, got ${JSON.stringify(v)}`);
    return null;
  }

  private lootTable(d: Defined): LootTableDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'rolls', 'entries'], 'loot table');
    let rolls: [number, number] = [1, 1];
    if (f.has('rolls')) rolls = this.range(f.raw('rolls'), 'rolls', 0, f.at('rolls')) ?? rolls;
    const entries: LootEntryDef[] = [];
    const srcs: Src[] = (this.lootEntrySrc[d.index] = []);
    const list = f.list('entries');
    if (!list) {
      if (!f.has('entries')) f.present('entries');
    } else if (list.length === 0) this.sink.add(f.at('entries'), `field 'entries' must list at least one entry`);
    (list ?? []).forEach((raw, i) => {
      const src = f.at('entries', i);
      if (!isObject(raw)) {
        this.sink.add(src, `loot entries must be mappings like { item: bandage, weight: 2 }`);
        return;
      }
      const ef = new Fields(this.sink, src, raw, ['item', 'table', 'nothing', 'weight', 'count'], 'loot entry');
      const kinds = (['item', 'table', 'nothing'] as const).filter((k) => ef.has(k));
      if (kinds.length !== 1) {
        this.sink.add(src, `a loot entry must have exactly one of 'item', 'table' or 'nothing: true'${kinds.length ? `, got ${kinds.join(' and ')}` : ''}`);
        return;
      }
      let weight = 1;
      const wv = ef.raw('weight');
      if (wv !== undefined && wv !== null) {
        if (typeof wv !== 'number' || !Number.isInteger(wv) || wv < 1) {
          this.sink.add(ef.at('weight'), `loot entry weight must be a positive integer, got ${JSON.stringify(wv)}`);
          return;
        }
        weight = wv;
      }
      const kind = kinds[0]!;
      const push = (e: LootEntryDef) => {
        entries.push(e);
        srcs.push(src);
      };
      if (kind !== 'item' && ef.has('count')) {
        this.sink.add(ef.at('count'), `'count' is only allowed on 'item' entries`);
        return;
      }
      if (kind === 'nothing') {
        if (ef.raw('nothing') !== true) {
          this.sink.add(ef.at('nothing'), `field 'nothing' must be true`);
          return;
        }
        push({ kind, weight });
      } else if (kind === 'table') {
        const r = this.symbols.ref('loot', ef.raw('table'), d.scope, ef.at('table'), this.sink);
        if (r) push({ kind, table: r.index, weight });
      } else {
        const r = this.symbols.ref('item', ef.raw('item'), d.scope, ef.at('item'), this.sink);
        const count = ef.has('count') ? this.range(ef.raw('count'), 'count', 1, ef.at('count')) : [1, 1];
        if (r && count) push({ kind, item: r.index, weight, countMin: count[0], countMax: count[1] });
      }
    });
    const cumulative: number[] = [];
    let total = 0;
    for (const e of entries) cumulative.push((total += e.weight));
    return { id: d.id, index: d.index, rollsMin: rolls[0], rollsMax: rolls[1], entries, cumulative, total };
  }

  /** Report every nested-table cycle once, at the entry that closes it. */
  private checkLootCycles(loot: readonly LootTableDef[]): void {
    const state = new Uint8Array(loot.length); // 0 new, 1 on stack, 2 done
    const visit = (t: number, stack: number[]): void => {
      state[t] = 1;
      stack.push(t);
      loot[t]!.entries.forEach((e, i) => {
        if (e.kind !== 'table') return;
        if (state[e.table] === 1) {
          const cycle = [...stack.slice(stack.indexOf(e.table)), e.table].map((k) => loot[k]!.id);
          this.sink.add(this.lootEntrySrc[t]![i]!, `loot table cycle: ${cycle.join(' → ')}`);
        } else if (state[e.table] === 0) visit(e.table, stack);
      });
      stack.pop();
      state[t] = 2;
    };
    for (let t = 0; t < loot.length; t++) if (state[t] === 0) visit(t, []);
  }

  /** Maximum total weight (hundredths) a table can produce; tables on a cycle count as 0. */
  private lootMaxWeight(loot: readonly LootTableDef[], items: readonly ItemDef[], t: number, seen = new Set<number>()): number {
    if (seen.has(t)) return 0;
    seen.add(t);
    const table = loot[t]!;
    let best = 0;
    for (const e of table.entries) {
      const w = e.kind === 'item' ? items[e.item]!.weight * e.countMax : e.kind === 'table' ? this.lootMaxWeight(loot, items, e.table, seen) : 0;
      if (w > best) best = w;
    }
    seen.delete(t);
    return best * table.rollsMax;
  }

  private distributions(tiles: readonly TileDef[], loot: readonly LootTableDef[], items: readonly ItemDef[]): DistributionDef[] {
    const out: DistributionDef[] = [];
    for (const { raw, scope } of this.packs) {
      for (const entry of raw.distributions) {
        const f = new Fields(this.sink, entry.src, entry.value, ['container', 'room', 'table'], 'distribution');
        const tile = f.present('container') ? this.symbols.ref('tile', f.raw('container'), scope, f.at('container'), this.sink) : null;
        const table = f.present('table') ? this.symbols.ref('loot', f.raw('table'), scope, f.at('table'), this.sink) : null;
        let room: number | null = null;
        let ok = true;
        if (f.has('room')) {
          const v = f.raw('room');
          const r = typeof v === 'string' ? this.roomTag(v) : { error: `expected a room tag (string), got ${JSON.stringify(v)}` };
          if ('error' in r) {
            this.sink.add(f.at('room'), r.error);
            ok = false;
          } else room = r.index;
        }
        if (!tile || !table || !ok) continue;
        const spec = tiles[tile.index]!.container;
        if (!spec) {
          this.sink.add(f.at('container'), `tile '${tile.id}' has no 'container', so loot cannot be distributed to it`);
          continue;
        }
        const max = loot[table.index] ? this.lootMaxWeight(loot, items, table.index) : 0;
        if (max > spec.capacity) {
          this.sink.warn(
            f.at('table'),
            `loot table '${table.id}' can produce up to ${max / 100} weight, over the capacity of '${tile.id}' (${spec.capacity / 100}); items that do not fit are dropped`,
          );
        }
        out.push({ container: tile.index, room, table: table.index });
      }
    }
    return out;
  }

  private status(d: Defined): StatusDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'label', 'for', 'when', 'until', 'rates'], 'status');
    const label = f.string('label') ?? d.id;
    const forFn = this.condition(f, 'for', d.scope) ?? null;
    const whenFn = this.condition(f, 'when', d.scope, true) ?? always;
    const untilFn = this.condition(f, 'until', d.scope) ?? ((c) => !whenFn(c));
    const rates: StatusRate[] = [];
    for (const [ref, value] of Object.entries(f.mapping('rates') ?? {})) {
      const src = f.at('rates', ref);
      const r = this.symbols.ref('measurement', ref, d.scope, src, this.sink);
      const term = this.numberTerm(value, `rates.${ref}`, d.scope, src);
      if (!r || !term) continue;
      if (rates.some((x) => x.measurement === r.index)) this.sink.add(src, `rate for measurement '${r.id}' is listed twice`);
      else rates.push({ measurement: r.index, ...term });
    }
    return { id: d.id, index: d.index, label, forFn, whenFn, untilFn, rates };
  }

  private system(d: Defined): SystemDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'every', 'for', 'when', 'effects'], 'system');
    let every = f.number('every', false) ?? DEFAULT_EVERY;
    const period = this.ticks(f, 'every', every) ?? Math.max(1, Math.round(every * TICKS_PER_SECOND));
    if (every <= 0) every = DEFAULT_EVERY;
    const forFn = this.condition(f, 'for', d.scope) ?? null;
    const whenFn = this.condition(f, 'when', d.scope) ?? null;

    const effects = this.effects(f, d.scope);
    return { id: d.id, index: d.index, every, period, forFn, whenFn, effects };
  }

  /** Sim seconds (> 0, a whole number of ticks) → ticks; reports and returns null otherwise. */
  private ticks(f: Fields, key: string, seconds: number): number | null {
    const ticks = seconds * TICKS_PER_SECOND;
    const n = Math.round(ticks);
    if (seconds <= 0) {
      this.sink.add(f.at(key), `field '${key}' must be a number of sim seconds > 0, got ${seconds}`);
      return null;
    }
    if (Math.abs(ticks - n) > 1e-6 || n < 1) {
      this.sink.add(f.at(key), `field '${key}' must be a whole number of ticks (a multiple of ${DEFAULT_EVERY} s), got ${seconds}`);
      return null;
    }
    return n;
  }

  // ── Behaviors ───────────────────────────────────────────────────────────

  private behavior(d: Defined): BehaviorDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'initial', 'states'], 'behavior');
    const raw = f.mapping('states', true);
    const names = Object.keys(raw ?? {});
    if (raw && names.length === 0) this.sink.add(f.at('states'), `field 'states' must define at least one state`);
    for (const name of names) {
      if (!ID_RE.test(name)) this.sink.add(f.at('states', name), `invalid state name '${name}': state names must match [a-z][a-z0-9_]*`);
    }
    const stateRef = (v: Json | undefined, src: Src): number => {
      if (typeof v !== 'string') {
        this.sink.add(src, `expected a state name (string), got ${JSON.stringify(v)}`);
        return 0;
      }
      const k = names.indexOf(v);
      if (k >= 0) return k;
      const s = nearMiss(v, names);
      this.sink.add(src, `unknown state '${v}' in behavior '${d.id}'${s ? ` (did you mean '${s}'?)` : ''}`);
      return 0;
    };
    const initial = f.present('initial') ? stateRef(f.raw('initial'), f.at('initial')) : 0;
    const states = names.map((name, index) => this.behaviorState(f.at('states', name), raw![name], name, index, d.scope, stateRef));
    return { id: d.id, index: d.index, initial, states };
  }

  private behaviorState(
    src: Src,
    raw: Json | undefined,
    name: string,
    index: number,
    scope: Scope,
    stateRef: (v: Json | undefined, src: Src) => number,
  ): BehaviorStateDef {
    const state: BehaviorStateDef = { name, index, activity: 'idle', target: null, radius: null, repath: DEFAULT_REPATH * TICKS_PER_SECOND, on: [], timeout: null, done: null };
    if (!isObject(raw)) {
      this.sink.add(src, `a state must be a mapping like { do: wander, on: [...] }`);
      return state;
    }
    const f = new Fields(this.sink, src, raw, ['do', 'target', 'radius', 'repath', 'on', 'timeout', 'done'], 'state');
    let activity: ActivityKind = 'idle';
    const doRaw = f.string('do');
    if (doRaw !== undefined) {
      if ((ACTIVITIES as readonly string[]).includes(doRaw)) activity = doRaw as ActivityKind;
      else {
        const s = nearMiss(doRaw, ACTIVITIES);
        this.sink.add(f.at('do'), `unknown activity '${doRaw}'${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${ACTIVITIES.join(', ')}`);
      }
    }
    /** Whether `key` is absent or allowed for this activity; reports a misplaced field. */
    const onlyFor = (key: string, kinds: readonly ActivityKind[]): boolean => {
      if (!f.has(key) || kinds.includes(activity)) return true;
      this.sink.add(f.at(key), `field '${key}' is only allowed on ${kinds.map((k) => `'${k}'`).join('/')} states, not '${activity}'`);
      return false;
    };

    let target: Compiled | null = null;
    const needsTarget = activity === 'pursue' || activity === 'flee';
    if (onlyFor('target', ['pursue', 'flee'])) {
      if (needsTarget && !f.has('target')) f.present('target');
      else if (f.has('target')) {
        const v = f.string('target');
        const e = v === undefined ? null : this.compile(v, scope, f.at('target'));
        if (e && !isPointType(e.type)) this.sink.add(f.at('target'), `target "${v}" must be an entity or a tile, got ${e.type}`);
        else if (e) target = e.fn;
      }
    }

    let radius: number | null = null;
    if (onlyFor('radius', ['wander']) && f.has('radius')) {
      const v = f.raw('radius');
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        this.sink.add(f.at('radius'), `field 'radius' must be an integer ≥ 0, got ${JSON.stringify(v)}`);
      } else radius = v;
    }

    let repath = state.repath;
    if (onlyFor('repath', ['pursue', 'investigate']) && f.has('repath')) {
      const v = f.number('repath');
      if (v !== undefined) repath = this.ticks(f, 'repath', v) ?? repath;
    }

    const on: TransitionDef[] = [];
    (f.list('on') ?? []).forEach((t, i) => {
      const tsrc = f.at('on', i);
      if (!isObject(t)) {
        this.sink.add(tsrc, `transitions must be mappings like { when: 'self.has_status("alert")', to: chase }`);
        return;
      }
      const tf = new Fields(this.sink, tsrc, t, ['when', 'to'], 'transition');
      const when = this.condition(tf, 'when', scope, true);
      const to = tf.present('to') ? stateRef(tf.raw('to'), tf.at('to')) : -1;
      if (when && to >= 0) on.push({ when, to });
    });

    let timeout: BehaviorStateDef['timeout'] = null;
    const traw = f.mapping('timeout');
    if (traw) {
      const tf = new Fields(this.sink, f.at('timeout'), traw, ['after', 'to'], 'timeout');
      const after = tf.number('after');
      const afterTicks = after === undefined ? null : this.ticks(tf, 'after', after);
      const to = tf.present('to') ? stateRef(tf.raw('to'), tf.at('to')) : -1;
      if (afterTicks !== null && to >= 0) timeout = { afterTicks, to };
    }

    const done = onlyFor('done', ['home', 'investigate']) && f.has('done') ? stateRef(f.raw('done'), f.at('done')) : null;
    return { name, index, activity, target, radius, repath, on, timeout, done };
  }

  /** A required, non-empty `effects` list (`apply`/`set`/`noise` on `self`). */
  private effects(f: Fields, scope: Scope): EffectDef[] {
    const effects: EffectDef[] = [];
    const list = f.list('effects');
    if (!list) {
      if (!f.has('effects')) f.present('effects');
    } else if (list.length === 0) {
      this.sink.add(f.at('effects'), `field 'effects' must list at least one effect`);
    }
    (list ?? []).forEach((raw, i) => {
      const src = f.at('effects', i);
      if (!isObject(raw)) {
        this.sink.add(src, `effects must be mappings like { type: apply, measurement: energy, delta: -1 }`);
        return;
      }
      const type = raw['type'];
      if (typeof type !== 'string' || !(type in EFFECT_FIELDS)) {
        if (type === undefined || type === null) this.sink.add(src, `missing required field 'type'`);
        else {
          const s = typeof type === 'string' ? nearMiss(type, Object.keys(EFFECT_FIELDS)) : null;
          this.sink.add(
            at(src, 'type'),
            `unknown effect type ${JSON.stringify(type)}${s ? ` (did you mean '${s}'?)` : ''}; expected one of ${Object.keys(EFFECT_FIELDS).join(', ')}`,
          );
        }
        return;
      }
      const t = type as EffectDef['type'];
      const valueKey = EFFECT_FIELDS[t];
      if (t === 'noise') {
        const nf = new Fields(this.sink, src, raw, ['type', valueKey], `'noise' effect`);
        const term = nf.present(valueKey) ? this.numberTerm(nf.raw(valueKey), valueKey, scope, nf.at(valueKey)) : null;
        if (term) effects.push({ type: t, ...term });
        return;
      }
      const ef = new Fields(this.sink, src, raw, ['type', 'measurement', valueKey], `'${t}' effect`);
      const m = ef.present('measurement') ? this.symbols.ref('measurement', ef.raw('measurement'), scope, ef.at('measurement'), this.sink) : null;
      const term = ef.present(valueKey) ? this.numberTerm(ef.raw(valueKey), valueKey, scope, ef.at(valueKey)) : null;
      if (m && term) effects.push({ type: t, measurement: m.index, ...term });
    });
    return effects;
  }

  private defeat(f: Fields, scope: Scope): DefeatDef | null {
    const raw = f.mapping('defeat');
    if (!raw) return null;
    const df = new Fields(this.sink, f.at('defeat'), raw, ['when', 'message'], 'defeat');
    const when = this.condition(df, 'when', scope, true);
    const message = df.string('message', false) ?? DEFAULT_DEFEAT_MESSAGE;
    return when ? { when, message } : null;
  }

  private start(maps: readonly MapDef[]): Definition['start'] | null {
    const all = this.packs.flatMap(({ raw, scope }) => raw.starts.map((entry) => ({ entry, scope })));
    if (all.length === 0) {
      const last = this.packs[this.packs.length - 1];
      if (last) {
        this.sink.add({ source: last.raw.manifest, path: [] }, `no 'start' defined: exactly one loaded pack must define 'start' (map + player)`);
      } else if (this.sink.count === 0) {
        this.sink.raw({ pack: '', file: '', path: '', message: 'no packs loaded' });
      }
      return null;
    }
    const [first, ...rest] = all;
    for (const extra of rest) {
      const s = first!.entry.src;
      this.sink.add(extra.entry.src, `duplicate 'start': already defined in pack '${s.source.pack}' (${s.source.file})`);
    }
    const { entry, scope } = first!;
    const f = new Fields(this.sink, entry.src, entry.value, ['map', 'player', 'defeat'], 'start');
    const defeat = this.defeat(f, scope);
    const map = f.has('map') ? this.symbols.ref('map', f.raw('map'), scope, f.at('map'), this.sink) : f.string('map');
    const player = f.has('player') ? this.symbols.ref('archetype', f.raw('player'), scope, f.at('player'), this.sink) : f.string('player');
    if (!map || typeof map !== 'object' || !player || typeof player !== 'object') return null;
    const m = maps[map.index];
    if (m && !m.playerStart) {
      this.sink.add(at(entry.src, 'map'), `start map '${map.id}' has no player start cell (a legend entry with 'player: true')`);
      return null;
    }
    return { map: map.index, player: player.index, defeat };
  }

  private clock(): ClockDef {
    const all = this.packs.flatMap(({ raw }) => raw.clocks);
    const [first, ...rest] = all;
    if (!first) return DEFAULT_CLOCK;
    for (const extra of rest) {
      const s = first.src;
      this.sink.add(extra.src, `duplicate 'clock': already defined in pack '${s.source.pack}' (${s.source.file})`);
    }
    const f = new Fields(this.sink, first.src, first.value, ['day_length', 'start', 'dawn', 'dusk'], 'clock');
    let dayLength = f.number('day_length', false) ?? DEFAULT_CLOCK.dayLength;
    if (dayLength <= 0) {
      this.sink.add(f.at('day_length'), `field 'day_length' must be a number of seconds > 0, got ${dayLength}`);
      dayLength = DEFAULT_CLOCK.dayLength;
    }
    const time = (key: 'start' | 'dawn' | 'dusk'): number => {
      const v = f.raw(key);
      if (v === undefined || v === null) return DEFAULT_CLOCK[key];
      const m = typeof v === 'string' ? parseTimeOfDay(v) : null;
      if (m === null) {
        this.sink.add(f.at(key), `field '${key}' must be a time "HH:MM" (00:00–23:59), got ${JSON.stringify(v)}`);
        return DEFAULT_CLOCK[key];
      }
      return m;
    };
    const start = time('start');
    const dawn = time('dawn');
    const dusk = time('dusk');
    if (dawn >= dusk) {
      this.sink.add(f.has('dawn') ? f.at('dawn') : f.at('dusk'), `dawn must be before dusk (daylight cannot wrap past midnight)`);
    }
    return { dayLength, start, dawn, dusk };
  }

  private lighting(): LightingDef | null {
    const all = this.packs.flatMap(({ raw }) => raw.lightings);
    const [first, ...rest] = all;
    if (!first) return null;
    for (const extra of rest) {
      const s = first.src;
      this.sink.add(extra.src, `duplicate 'lighting': already defined in pack '${s.source.pack}' (${s.source.file})`);
    }
    const f = new Fields(this.sink, first.src, first.value, ['tint'], 'lighting');
    const list = f.list('tint');
    if (!list) {
      if (!f.has('tint')) f.present('tint');
      return null;
    }
    if (list.length === 0) {
      this.sink.add(f.at('tint'), `field 'tint' must list at least one keyframe`);
      return null;
    }
    const tint: TintKeyframe[] = [];
    list.forEach((raw, i) => {
      const src = f.at('tint', i);
      if (!isObject(raw)) {
        this.sink.add(src, `tint keyframes must be mappings like { at: "07:00", color: "#ffffff" }`);
        return;
      }
      const kf = new Fields(this.sink, src, raw, ['at', 'color'], 'tint keyframe');
      const atStr = kf.string('at');
      const colorStr = kf.string('color');
      const minutes = atStr === undefined ? null : parseTimeOfDay(atStr);
      const colorOk = colorStr !== undefined && HEX_COLOR_RE.test(colorStr);
      if (atStr !== undefined && minutes === null) {
        this.sink.add(kf.at('at'), `field 'at' must be a time "HH:MM" (00:00–23:59), got ${JSON.stringify(atStr)}`);
      }
      if (colorStr !== undefined && !colorOk) {
        this.sink.add(kf.at('color'), `field 'color' must be a '#rrggbb' colour, got ${JSON.stringify(colorStr)}`);
      }
      if (minutes === null || !colorOk) return;
      if (tint.some((k) => k.at === minutes)) {
        this.sink.add(kf.at('at'), `duplicate tint keyframe time '${atStr}'`);
        return;
      }
      tint.push({ at: minutes, color: parseInt(colorStr.slice(1), 16) });
    });
    tint.sort((a, b) => a.at - b.at);
    return tint.length ? { tint } : null;
  }
}

/**
 * Load an ordered list of packs. Each pack's `depends` must be satisfied by
 * an earlier pack in the list. All errors are collected before failing.
 */
export function loadPacks(sources: readonly PackSource[]): LoadResult {
  return new Loader().run(sources);
}

/** Like loadPacks, but throws a PackLoadError listing every error. */
export function loadPacksOrThrow(sources: readonly PackSource[]): Definition {
  const r = loadPacks(sources);
  if (!r.ok) throw new PackLoadError(r.errors);
  return r.definition;
}
