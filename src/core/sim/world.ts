/**
 * Mutable, fixed-tick simulation state built from a loaded Definition.
 * Deterministic: same definition + seed + intents ⇒ same state.
 */

import type { ArchetypeDef, Definition, MeasurementDef } from '../definition.ts';
import type { ExprContext, ExprEntity } from '../expr/index.ts';
import { Grid } from './grid.ts';
import { Rng } from './rng.ts';

export interface Entity extends ExprEntity {
  readonly id: number;
  readonly archetype: ArchetypeDef;
  x: number;
  y: number;
  /** Values indexed by measurement index (length = all measurements). */
  readonly m: Float64Array;
  /** Resolved max per measurement as of the last clamp (Infinity if unbounded). */
  readonly max: Float64Array;
  /** Ticks until the entity may step again. */
  moveCooldown: number;
}

export interface Intent {
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
}

export interface EntitySnapshot {
  id: number;
  archetype: string;
  x: number;
  y: number;
  measurements: Record<string, number>;
}

export interface WorldSnapshot {
  tick: number;
  rng: number;
  player: number;
  entities: EntitySnapshot[];
}

/** FNV-1a 32-bit over a string, as 8 hex chars. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class World {
  readonly grid: Grid;
  readonly entities: Entity[] = [];
  readonly player: Entity;
  readonly rng: Rng;
  tick = 0;
  /** Expression warnings (e.g. division by zero) with occurrence counts. */
  readonly warnings = new Map<string, number>();

  private intent: Intent | null = null;
  private readonly ctx: ExprContext;
  private readonly tagSets: ReadonlySet<string>[];

  constructor(
    readonly def: Definition,
    seed: number,
  ) {
    const map = def.maps[def.start.map]!;
    this.grid = new Grid(map, def.tiles);
    this.rng = new Rng(seed);
    this.tagSets = def.archetypes.map((a) => new Set(a.tags));

    const start = map.playerStart!;
    this.player = this.spawn(def.archetypes[def.start.player]!, start.x, start.y);
    for (const s of map.spawns) this.spawn(def.archetypes[s.archetype]!, s.x, s.y);

    const world = this;
    this.ctx = {
      self: this.player,
      player: this.player,
      tick: 0,
      ticksPerSecond: def.ticksPerSecond,
      random: () => world.rng.next(),
      tileIdAt: (x, y) => world.grid.tileAt(x, y)?.id ?? '',
      warn: (msg) => world.warnings.set(msg, (world.warnings.get(msg) ?? 0) + 1),
    };
    for (const e of this.entities) this.clamp(e);
  }

  static create(def: Definition, seed: number): World {
    return new World(def, seed);
  }

  get seconds(): number {
    return this.tick / this.def.ticksPerSecond;
  }

  private spawn(archetype: ArchetypeDef, x: number, y: number): Entity {
    const m = new Float64Array(this.def.measurements.length);
    archetype.measurements.forEach((idx, k) => (m[idx] = archetype.initial[k]!));
    const max = new Float64Array(this.def.measurements.length).fill(Infinity);
    const e: Entity = { id: this.entities.length, archetype, x, y, m, max, tags: this.tagSets[archetype.index]!, moveCooldown: 0 };
    this.entities.push(e);
    return e;
  }

  /** Queue the player's next move; the latest intent wins until it is applied. */
  queueIntent(intent: Intent): void {
    if (intent.dx === 0 && intent.dy === 0) return;
    this.intent = intent;
  }

  /** Advance exactly one tick (1 / ticksPerSecond seconds). */
  step(): void {
    this.ctx.tick = this.tick;
    this.applyIntent();
    const ms = this.def.measurements;
    const tps = this.def.ticksPerSecond;
    for (const e of this.entities) {
      this.ctx.self = e;
      const m = e.m;
      for (const idx of e.archetype.measurements) {
        const md = ms[idx]!;
        if (md.rateFn) m[idx] = m[idx]! + Number(md.rateFn(this.ctx)) / tps;
        else if (md.rateConst !== 0) m[idx] = m[idx]! + md.rateConst / tps;
      }
    }
    for (const e of this.entities) this.clamp(e);
    this.tick++;
  }

  private applyIntent(): void {
    const p = this.player;
    if (p.moveCooldown > 0) p.moveCooldown--;
    if (!this.intent || p.moveCooldown > 0) return;
    const { dx, dy } = this.intent;
    this.intent = null;
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (!this.grid.walkable(nx, ny)) return;
    p.x = nx;
    p.y = ny;
    p.moveCooldown = p.archetype.ticksPerStep;
  }

  /** Resolved max of a measurement for an entity (Infinity if unbounded). */
  maxOf(e: Entity, md: MeasurementDef): number {
    if (!md.maxFn) return md.maxConst;
    this.ctx.self = e;
    return Number(md.maxFn(this.ctx));
  }

  private clamp(e: Entity): void {
    const ms = this.def.measurements;
    for (const idx of e.archetype.measurements) {
      const md = ms[idx]!;
      let v = e.m[idx]!;
      const max = this.maxOf(e, md);
      e.max[idx] = max;
      if (v > max) v = max;
      if (v < md.min) v = md.min;
      e.m[idx] = v;
    }
  }

  /** Measurement value by qualified id (undefined if the entity lacks it). */
  value(e: Entity, measurementId: string): number | undefined {
    const idx = this.def.ids.measurements[measurementId];
    if (idx === undefined || !e.archetype.measurements.includes(idx)) return undefined;
    return e.m[idx];
  }

  snapshot(): WorldSnapshot {
    const ms = this.def.measurements;
    return {
      tick: this.tick,
      rng: this.rng.state,
      player: this.player.id,
      entities: this.entities.map((e) => ({
        id: e.id,
        archetype: e.archetype.id,
        x: e.x,
        y: e.y,
        measurements: Object.fromEntries(e.archetype.measurements.map((idx) => [ms[idx]!.id, e.m[idx]!])),
      })),
    };
  }

  hash(): string {
    return fnv1a(JSON.stringify(this.snapshot()));
  }
}
