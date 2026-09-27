/**
 * Mutable, fixed-tick simulation state built from a loaded Definition.
 * Deterministic: same definition + seed + intents ⇒ same state.
 */

import { clockAt, type ClockTime } from '../clock.ts';
import type { ArchetypeDef, Definition, MeasurementDef, NumberTerm } from '../definition.ts';
import type { ExprContext, ExprEntity } from '../expr/index.ts';
import { Pathfinder } from './astar.ts';
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
  /** Tile the current (or last) step started from; equals (x, y) before any step. */
  fromX: number;
  fromY: number;
  /**
   * World tick at which the current step starts showing: the value of
   * `world.tick` right after the tick that took the step. See `renderPosition`.
   */
  stepTick: number;
  /** Remaining path as cell indices (`y * width + x`), or null. */
  path: Int32Array | null;
  /** Index of the next cell of `path` to step onto. */
  pathPos: number;
  /** Active statuses, indexed by status index (1 = active). */
  readonly st: Uint8Array;
}

/** Recorded when the pack's `start.defeat` condition becomes true. */
export interface DefeatRecord {
  readonly tick: number;
  readonly message: string;
}

/** One-tile move in a direction (keyboard); cancels any active path. */
export interface StepIntent {
  readonly kind: 'step';
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
}

/** Walk to a tile along an A* path computed at the start of the next tick. */
export interface GotoIntent {
  readonly kind: 'goto';
  readonly x: number;
  readonly y: number;
}

export type Intent = StepIntent | GotoIntent;

/** Outcome of the latest goto intent, for shell feedback. */
export interface GotoRecord {
  readonly x: number;
  readonly y: number;
  /** False when the goal was blocked, out of bounds or unreachable. */
  readonly ok: boolean;
  /** Tick at which the goto was resolved. */
  readonly tick: number;
}

export interface EntitySnapshot {
  id: number;
  archetype: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  stepTick: number;
  moveCooldown: number;
  /** Remaining path cells as [x, y] pairs. */
  path: [number, number][] | null;
  measurements: Record<string, number>;
  /** Active status ids, in definition order. */
  statuses: string[];
}

export interface WorldSnapshot {
  tick: number;
  rng: number;
  player: number;
  intent: Intent | null;
  lastGoto: GotoRecord | null;
  defeat: DefeatRecord | null;
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

const NO_TAGS: ReadonlySet<string> = new Set();

export class World {
  readonly grid: Grid;
  readonly entities: Entity[] = [];
  readonly player: Entity;
  readonly rng: Rng;
  tick = 0;
  /** Expression warnings (e.g. division by zero) with occurrence counts. */
  readonly warnings = new Map<string, number>();

  /** Result of the most recent goto intent (a new object each time). */
  lastGoto: GotoRecord | null = null;
  /** Set once the defeat condition holds; the world is frozen from then on. */
  defeat: DefeatRecord | null = null;

  private intent: Intent | null = null;
  private pathfinder: Pathfinder | null = null;
  private readonly ctx: ExprContext;
  private readonly tagSets: ReadonlySet<string>[];
  private readonly tileTagSets: ReadonlySet<string>[];
  /** Per archetype index: 1 at each measurement index the archetype has. */
  private readonly hasM: Uint8Array[];
  /** Per status: its `rates` term by measurement index (undefined = none). */
  private readonly statusRates: (NumberTerm | undefined)[][];
  /** Scratch for the status update: next flags of every entity, row-major. */
  private statusNext = new Uint8Array(0);

  constructor(
    readonly def: Definition,
    seed: number,
  ) {
    const map = def.maps[def.start.map]!;
    this.grid = new Grid(map, def.tiles);
    this.rng = new Rng(seed);
    this.tagSets = def.archetypes.map((a) => new Set(a.tags));
    this.tileTagSets = def.tiles.map((t) => (t.tags.length ? new Set(t.tags) : NO_TAGS));
    const nm = def.measurements.length;
    this.hasM = def.archetypes.map((a) => {
      const has = new Uint8Array(nm);
      for (const idx of a.measurements) has[idx] = 1;
      return has;
    });
    this.statusRates = def.statuses.map((s) => {
      const by = new Array<NumberTerm | undefined>(nm).fill(undefined);
      for (const r of s.rates) by[r.measurement] = r;
      return by;
    });

    const start = map.playerStart!;
    this.player = this.spawn(def.archetypes[def.start.player]!, start.x, start.y);
    for (const s of map.spawns) this.spawn(def.archetypes[s.archetype]!, s.x, s.y);

    const world = this;
    this.ctx = {
      self: this.player,
      player: this.player,
      tick: 0,
      ticksPerSecond: def.ticksPerSecond,
      clock: def.clock,
      random: () => world.rng.next(),
      tileIdAt: (x, y) => world.grid.tileAt(x, y)?.id ?? '',
      tileTagsAt: (x, y) => (world.grid.inBounds(x, y) ? world.tileTagSets[world.grid.cells[y * world.grid.width + x]!]! : NO_TAGS),
      warn: (msg) => world.warnings.set(msg, (world.warnings.get(msg) ?? 0) + 1),
    };
    for (const e of this.entities) this.clamp(e);
    this.updateStatuses();
  }

  static create(def: Definition, seed: number): World {
    return new World(def, seed);
  }

  get seconds(): number {
    return this.tick / this.def.ticksPerSecond;
  }

  /** In-game calendar time at the current tick. */
  get clock(): ClockTime {
    return clockAt(this.def.clock, this.tick, this.def.ticksPerSecond);
  }

  private spawn(archetype: ArchetypeDef, x: number, y: number): Entity {
    const m = new Float64Array(this.def.measurements.length);
    archetype.measurements.forEach((idx, k) => (m[idx] = archetype.initial[k]!));
    const max = new Float64Array(this.def.measurements.length).fill(Infinity);
    const e: Entity = {
      id: this.entities.length,
      archetype,
      x,
      y,
      m,
      max,
      tags: this.tagSets[archetype.index]!,
      moveCooldown: 0,
      fromX: x,
      fromY: y,
      stepTick: 0,
      path: null,
      pathPos: 0,
      st: new Uint8Array(this.def.statuses.length),
    };
    this.entities.push(e);
    return e;
  }

  /** Queue the player's next move; the latest intent wins until it is applied. */
  queueIntent(intent: Intent): void {
    if (this.defeat) return;
    if (intent.kind === 'step' && intent.dx === 0 && intent.dy === 0) return;
    this.intent = intent;
  }

  /** Goal tile of an entity's active path, or null. */
  pathGoal(e: Entity): { x: number; y: number } | null {
    if (!e.path || e.pathPos >= e.path.length) return null;
    const i = e.path[e.path.length - 1]!;
    return { x: i % this.grid.width, y: Math.floor(i / this.grid.width) };
  }

  /**
   * Advance exactly one tick (1 / ticksPerSecond seconds): intent, drift,
   * due systems, clamp, status update, defeat check, `tick++`. A no-op once
   * defeated.
   */
  step(): void {
    if (this.defeat) return;
    this.ctx.tick = this.tick;
    this.applyIntent();
    this.drift();
    this.runSystems();
    for (const e of this.entities) this.clamp(e);
    this.updateStatuses();
    this.checkDefeat();
    this.tick++;
  }

  /** Measurement drift: `rate` plus the `rates` of the statuses active now. */
  private drift(): void {
    const ms = this.def.measurements;
    const tps = this.def.ticksPerSecond;
    const ns = this.def.statuses.length;
    const ctx = this.ctx;
    for (const e of this.entities) {
      ctx.self = e;
      const m = e.m;
      let any = false;
      for (let k = 0; k < ns; k++) if (e.st[k] === 1) any = true;
      for (const idx of e.archetype.measurements) {
        const md = ms[idx]!;
        let d = md.rateFn ? Number(md.rateFn(ctx)) : md.rateConst;
        if (any) {
          for (let k = 0; k < ns; k++) {
            if (e.st[k] !== 1) continue;
            const r = this.statusRates[k]![idx];
            if (r) d += r.fn ? Number(r.fn(ctx)) : r.constant;
          }
        }
        if (d !== 0) m[idx] = m[idx]! + d / tps;
      }
    }
  }

  /** Run the systems due this tick, in definition order, once per matching entity. */
  private runSystems(): void {
    const t = this.tick + 1;
    const ctx = this.ctx;
    for (const sys of this.def.systems) {
      if (t % sys.period !== 0) continue;
      for (const e of this.entities) {
        ctx.self = e;
        if (sys.forFn && !sys.forFn(ctx)) continue;
        if (sys.whenFn && !sys.whenFn(ctx)) continue;
        const has = this.hasM[e.archetype.index]!;
        for (const eff of sys.effects) {
          const idx = eff.measurement;
          if (has[idx] !== 1) continue;
          const v = eff.fn ? Number(eff.fn(ctx)) : eff.constant;
          e.m[idx] = eff.type === 'apply' ? e.m[idx]! + v : v;
        }
      }
    }
  }

  /**
   * Enter/exit statuses. Every condition sees the flags as they were at the
   * start of the update (next flags go to a scratch buffer first), so the
   * definition order of statuses does not matter.
   */
  private updateStatuses(): void {
    const statuses = this.def.statuses;
    const ns = statuses.length;
    if (ns === 0) return;
    const ctx = this.ctx;
    const n = this.entities.length * ns;
    if (this.statusNext.length < n) this.statusNext = new Uint8Array(n);
    const next = this.statusNext;
    let o = 0;
    for (const e of this.entities) {
      ctx.self = e;
      for (let k = 0; k < ns; k++, o++) {
        const s = statuses[k]!;
        if (s.forFn && !s.forFn(ctx)) next[o] = 0;
        else if (e.st[k] === 1) next[o] = s.untilFn(ctx) ? 0 : 1;
        else next[o] = s.whenFn(ctx) ? 1 : 0;
      }
    }
    o = 0;
    for (const e of this.entities) {
      e.st.set(next.subarray(o, o + ns));
      o += ns;
    }
  }

  private checkDefeat(): void {
    const d = this.def.start.defeat;
    if (!d) return;
    this.ctx.self = this.player;
    if (d.when(this.ctx)) this.defeat = { tick: this.tick, message: d.message };
  }

  /** Whether an entity has a status (by qualified id). */
  hasStatus(e: Entity, statusId: string): boolean {
    const k = this.def.ids.statuses[statusId];
    return k !== undefined && e.st[k] === 1;
  }

  private applyIntent(): void {
    const p = this.player;
    const intent = this.intent;
    if (intent?.kind === 'goto') {
      this.intent = null;
      this.pathfinder ??= new Pathfinder(this.grid);
      const path = this.pathfinder.findPath(p.x, p.y, intent.x, intent.y);
      p.path = path && path.length > 0 ? path : null;
      p.pathPos = 0;
      this.lastGoto = { x: intent.x, y: intent.y, ok: path !== null, tick: this.tick };
    } else if (intent?.kind === 'step') {
      p.path = null;
    }

    if (p.moveCooldown > 0) p.moveCooldown--;
    if (p.moveCooldown > 0) return;
    if (this.intent?.kind === 'step') {
      const { dx, dy } = this.intent;
      this.intent = null;
      this.move(p, dx, dy);
    } else if (p.path) {
      const next = p.path[p.pathPos++]!;
      const w = this.grid.width;
      if (p.pathPos >= p.path.length) p.path = null;
      if (!this.move(p, (next % w) - p.x, Math.floor(next / w) - p.y)) p.path = null;
    }
  }

  /** Take one step if allowed; records the render-facing step state. */
  private move(e: Entity, dx: number, dy: number): boolean {
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || !this.grid.canStep(e.x, e.y, dx, dy)) return false;
    e.fromX = e.x;
    e.fromY = e.y;
    e.stepTick = this.tick + 1;
    e.x += dx;
    e.y += dy;
    e.moveCooldown = e.archetype.ticksPerStep;
    return true;
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
      intent: this.intent,
      lastGoto: this.lastGoto,
      defeat: this.defeat,
      entities: this.entities.map((e) => ({
        id: e.id,
        archetype: e.archetype.id,
        x: e.x,
        y: e.y,
        fromX: e.fromX,
        fromY: e.fromY,
        stepTick: e.stepTick,
        moveCooldown: e.moveCooldown,
        path: e.path
          ? [...e.path.subarray(e.pathPos)].map((i): [number, number] => [i % this.grid.width, Math.floor(i / this.grid.width)])
          : null,
        measurements: Object.fromEntries(e.archetype.measurements.map((idx) => [ms[idx]!.id, e.m[idx]!])),
        statuses: this.def.statuses.filter((s) => e.st[s.index] === 1).map((s) => s.id),
      })),
    };
  }

  hash(): string {
    return fnv1a(JSON.stringify(this.snapshot()));
  }
}
