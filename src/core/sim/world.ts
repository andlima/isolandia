/**
 * Mutable, fixed-tick simulation state built from a loaded Definition.
 * Deterministic: same definition + seed + intents ⇒ same state.
 */

import type { ArchetypeDef, Definition, MeasurementDef } from '../definition.ts';
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
}

export interface WorldSnapshot {
  tick: number;
  rng: number;
  player: number;
  intent: Intent | null;
  lastGoto: GotoRecord | null;
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

  /** Result of the most recent goto intent (a new object each time). */
  lastGoto: GotoRecord | null = null;

  private intent: Intent | null = null;
  private pathfinder: Pathfinder | null = null;
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
    };
    this.entities.push(e);
    return e;
  }

  /** Queue the player's next move; the latest intent wins until it is applied. */
  queueIntent(intent: Intent): void {
    if (intent.kind === 'step' && intent.dx === 0 && intent.dy === 0) return;
    this.intent = intent;
  }

  /** Goal tile of an entity's active path, or null. */
  pathGoal(e: Entity): { x: number; y: number } | null {
    if (!e.path || e.pathPos >= e.path.length) return null;
    const i = e.path[e.path.length - 1]!;
    return { x: i % this.grid.width, y: Math.floor(i / this.grid.width) };
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
      })),
    };
  }

  hash(): string {
    return fnv1a(JSON.stringify(this.snapshot()));
  }
}
