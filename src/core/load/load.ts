/**
 * Pack loader pipeline:
 *   parse YAML → collect raw entries per pack → qualify ids → symbol table →
 *   resolve references → compile expressions → freeze.
 * Every stage reports into one ErrorSink; nothing is returned unless the
 * whole set of packs is valid.
 */

import {
  TICKS_PER_SECOND,
  type ArchetypeDef,
  type Definition,
  type MapDef,
  type MeasurementDef,
  type PackInfo,
  type SpawnDef,
  type TileDef,
} from '../definition.ts';
import { compileSource, type Compiled } from '../expr/index.ts';
import { at, ErrorSink, PackLoadError, type LoadError, type Src } from './errors.ts';
import { ID_RE, isObject, parsePack, type ListDomain, type PackSource, type RawEntry, type RawPack } from './pack.ts';
import { SymbolTable, type Kind, type Scope } from './resolve.ts';
import { Fields } from './validate.ts';

export type LoadResult = { ok: true; definition: Definition } | { ok: false; errors: readonly LoadError[] };

interface Defined {
  readonly id: string;
  readonly index: number;
  readonly entry: RawEntry;
  readonly scope: Scope;
}

const KIND_OF: Record<ListDomain, Kind> = {
  measurements: 'measurement',
  tiles: 'tile',
  archetypes: 'archetype',
  maps: 'map',
};

const DEFAULT_TICKS_PER_STEP = 2;

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
  readonly defined: Record<ListDomain, Defined[]> = { measurements: [], tiles: [], archetypes: [], maps: [] };
  packs: { raw: RawPack; scope: Scope }[] = [];

  run(sources: readonly PackSource[]): LoadResult {
    this.parsePacks(sources);
    this.defineIds();
    const measurements = this.defined.measurements.map((d) => this.measurement(d));
    const tiles = this.defined.tiles.map((d) => this.tile(d));
    const archetypes = this.defined.archetypes.map((d) => this.archetype(d, measurements));
    const maps = this.defined.maps.map((d) => this.map(d));
    const start = this.start(maps);
    if (this.sink.count > 0 || !start) return { ok: false, errors: this.sink.errors };

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
      tiles,
      archetypes,
      maps,
      start,
      ids: { measurements: ids(measurements), tiles: ids(tiles), archetypes: ids(archetypes), maps: ids(maps) },
    };
    return { ok: true, definition: deepFreeze(definition) };
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

  /** Compile a numeric expression; reports and returns null on error. */
  private expr(source: string, scope: Scope, src: Src): { fn: Compiled; constant?: number } | null {
    const { expr, errors, syntax } = compileSource(source, {
      resolveMeasurement: (ref) => {
        const r = this.symbols.resolve('measurement', ref, scope);
        return 'error' in r ? r : { index: r.index };
      },
    });
    if (errors.length) {
      for (const e of errors) this.sink.add(src, `${syntax ? 'expression syntax error' : 'expression error'} in "${source}": ${e.message}`);
      return null;
    }
    if (expr.type !== 'number' && expr.type !== 'boolean' && expr.type !== 'any') {
      this.sink.add(src, `expression "${source}" must produce a number, got ${expr.type}`);
      return null;
    }
    return expr;
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

  private tile(d: Defined): TileDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'label', 'glyph', 'color', 'walkable'], 'tile');
    return {
      id: d.id,
      index: d.index,
      label: f.string('label') ?? d.id,
      glyph: f.glyph() ?? '?',
      color: f.color() ?? 'white',
      walkable: f.boolean('walkable') ?? false,
    };
  }

  private archetype(d: Defined, measurements: readonly MeasurementDef[]): ArchetypeDef {
    const f = new Fields(
      this.sink,
      d.entry.src,
      d.entry.value,
      ['id', 'label', 'glyph', 'color', 'tags', 'measurements', 'initial', 'ticks_per_step'],
      'archetype',
    );
    const label = f.string('label') ?? d.id;
    const glyph = f.glyph() ?? '?';
    const color = f.color() ?? 'white';
    const tags = f.stringList('tags');
    tags.forEach((t, i) => {
      if (!ID_RE.test(t)) this.sink.add(f.at('tags', i), `invalid tag '${t}': tags must match [a-z][a-z0-9_]*`);
    });

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
    return { id: d.id, index: d.index, label, glyph, color, tags, measurements: indices, initial, ticksPerStep };
  }

  private map(d: Defined): MapDef {
    const f = new Fields(this.sink, d.entry.src, d.entry.value, ['id', 'legend', 'rows'], 'map');

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
    return { id: d.id, index: d.index, width, height, cells, spawns, playerStart };
  }

  private start(maps: readonly MapDef[]): { map: number; player: number } | null {
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
    const f = new Fields(this.sink, entry.src, entry.value, ['map', 'player'], 'start');
    const map = f.has('map') ? this.symbols.ref('map', f.raw('map'), scope, f.at('map'), this.sink) : f.string('map');
    const player = f.has('player') ? this.symbols.ref('archetype', f.raw('player'), scope, f.at('player'), this.sink) : f.string('player');
    if (!map || typeof map !== 'object' || !player || typeof player !== 'object') return null;
    const m = maps[map.index];
    if (m && !m.playerStart) {
      this.sink.add(at(entry.src, 'map'), `start map '${map.id}' has no player start cell (a legend entry with 'player: true')`);
      return null;
    }
    return { map: map.index, player: player.index };
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
