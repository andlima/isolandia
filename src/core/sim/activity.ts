/**
 * Timed activities: the requirement checks and the lifecycle (start, work,
 * cancel, complete) shared by every "activity source". Pack actions and
 * item uses are sources; a new kind of timed work only has to build one.
 *
 * An activity has no partial progress: effects run and items are consumed
 * only at completion, after every check has passed again.
 */

import { secondsToTicks, type ActionDef, type DurationDef, type EffectDef, type ItemCount, type ItemDef, type TileDef } from '../definition.ts';
import type { Compiled, ExprContext } from '../expr/index.ts';
import { countOf, type Container } from './containers.ts';
import type { Grid } from './grid.ts';
import type { ActionFailure, Entity } from './world.ts';

/** Something an entity can spend time doing. */
export interface ActivitySource {
  /** Action kind it is started with. */
  readonly kind: 'act' | 'use';
  /** Action index, or -1. */
  readonly action: number;
  /** Item index (of an item use), or -1. */
  readonly item: number;
  /** Verb shown in the UI. */
  readonly label: string;
  /** Text shown while in progress. */
  readonly progress: string;
  /** Tile filter (1 per matching tile index) of the target cell; null targets the actor. */
  readonly filter: readonly number[] | null;
  readonly whenFn: Compiled | null;
  /** Reason recorded when `when` is falsy. */
  readonly whenFailure: ActionFailure;
  /** Items (and counts) that must be held at start and at completion. */
  readonly requires: readonly ItemCount[];
  /** Units removed at completion (as many as are held, up to the count). */
  readonly consume: readonly ItemCount[];
  readonly duration: DurationDef;
  readonly interruptFn: Compiled | null;
  readonly effects: readonly EffectDef[];
  /** Tile indices placed by the `set_tile` effects, in order. */
  readonly setTiles: readonly number[];
}

/** An entity's in-progress activity. */
export interface Activity {
  readonly source: ActivitySource;
  /** Same as `source.action` (what `doing()` compares). */
  readonly action: number;
  /** Target cell (the actor's cell at start for `self` targets and item uses). */
  readonly x: number;
  readonly y: number;
  readonly startTick: number;
  /** Tick whose work step completes the activity. */
  readonly endTick: number;
}

export type ActivityStage = 'start' | 'complete';

/** What the lifecycle needs from the world. */
export interface ActivityHost {
  readonly grid: Grid;
  readonly tiles: readonly TileDef[];
  readonly ctx: ExprContext;
  readonly entities: readonly Entity[];
  readonly ticksPerSecond: number;
  /** Run effects on `e` (= `ctx.self`); `set_tile` acts on `target`. */
  runEffects(e: Entity, effects: readonly EffectDef[], target: { x: number; y: number } | null): void;
  /** Remove up to `count` units from `inv`; returns units removed. */
  removeItem(inv: Container, item: number, count: number): number;
  /** Called whenever an activity starts, ends, or fails to start. */
  record(e: Entity, source: ActivitySource, stage: ActivityStage, ok: boolean, reason: ActionFailure | null, moved: number): void;
}

function setTilesOf(effects: readonly EffectDef[]): number[] {
  const out: number[] = [];
  for (const e of effects) if (e.type === 'set_tile') out.push(e.tile);
  return out;
}

/** The source of a pack action. */
export function actionSource(a: ActionDef): ActivitySource {
  return {
    kind: 'act',
    action: a.index,
    item: -1,
    label: a.label,
    progress: a.progress,
    filter: a.target ? a.target.match : null,
    whenFn: a.whenFn,
    whenFailure: 'cannot_act',
    requires: [...a.tools.map((item) => ({ item, count: 1 })), ...a.consume],
    consume: a.consume,
    duration: a.duration,
    interruptFn: a.interruptFn,
    effects: a.effects,
    setTiles: setTilesOf(a.effects),
  };
}

/** The source of an item's `use`, or null when it has none. */
export function useSource(item: ItemDef): ActivitySource | null {
  const use = item.use;
  if (!use) return null;
  return {
    kind: 'use',
    action: -1,
    item: item.index,
    label: use.label,
    progress: use.label,
    filter: null,
    whenFn: use.whenFn,
    whenFailure: 'cannot_use',
    requires: [{ item: item.index, count: 1 }],
    consume: use.consume > 0 ? [{ item: item.index, count: use.consume }] : [],
    duration: use.duration,
    interruptFn: use.interruptFn,
    effects: use.effects,
    setTiles: [],
  };
}

/** Whether a source may take time (its failures at start are recorded as `start`). */
export function isTimed(s: ActivitySource): boolean {
  return s.duration.fn !== null || s.duration.ticks > 0;
}

export class ActivityRunner {
  /** The target cell `tile` is bound to while a tile-targeted source is evaluated. */
  private readonly point = { x: 0, y: 0 };

  constructor(private readonly host: ActivityHost) {}

  /** Point `ctx.self` at the actor and `tile` at the target cell (tile targets only). */
  private bind(s: ActivitySource, e: Entity, x: number, y: number): ExprContext {
    const ctx = this.host.ctx;
    ctx.self = e;
    if (s.filter) {
      this.point.x = x;
      this.point.y = y;
      ctx.target = this.point;
    } else ctx.target = null;
    return ctx;
  }

  private unbind(): void {
    this.host.ctx.target = null;
  }

  /**
   * Checks 2–5 (inventory, reach and filter, held items, `when`) for `e`
   * acting on (x, y). Returns the first failure, or null when all pass.
   */
  check(s: ActivitySource, e: Entity, x: number, y: number): ActionFailure | null {
    if (s.requires.length > 0 && !e.inv) return 'no_inventory';
    if (s.filter) {
      const { grid } = this.host;
      if (!grid.inBounds(x, y) || Math.max(Math.abs(x - e.x), Math.abs(y - e.y)) > 1) return 'out_of_reach';
      const tile = grid.cells[y * grid.width + x]!;
      if (s.filter[tile] !== 1) return 'invalid_target';
      if (s.setTiles.length > 0 && this.host.tiles[tile]!.container) return 'invalid_target';
    }
    const inv = e.inv;
    if (inv) for (const r of s.requires) if (countOf(inv, r.item) < r.count) return 'missing';
    if (s.whenFn) {
      const ok = s.whenFn(this.bind(s, e, x, y));
      this.unbind();
      if (!ok) return s.whenFailure;
    }
    return null;
  }

  /**
   * Start `s` for `e` on (x, y) at `tick`: check, evaluate the duration once,
   * then complete at once (0 ticks) or begin an activity, which clears the
   * entity's path and pending intent. Records the outcome.
   */
  start(s: ActivitySource, e: Entity, x: number, y: number, tick: number): void {
    const failure = this.check(s, e, x, y);
    if (failure) return this.host.record(e, s, isTimed(s) ? 'start' : 'complete', false, failure, 0);
    let n = s.duration.ticks;
    if (s.duration.fn) {
      n = secondsToTicks(Number(s.duration.fn(this.bind(s, e, x, y))), this.host.ticksPerSecond);
      this.unbind();
    }
    if (n === 0) return this.finish(e, s, x, y);
    e.activity = { source: s, action: s.action, x, y, startTick: tick, endTick: tick + n };
    e.path = null;
    e.pathPos = 0;
    e.intent = null;
    this.host.record(e, s, 'start', true, null, 0);
  }

  /** End `e`'s activity without effects (`cancelled` or `interrupted`). */
  end(e: Entity, reason: 'cancelled' | 'interrupted'): void {
    const a = e.activity;
    if (!a) return;
    e.activity = null;
    this.host.record(e, a.source, 'complete', false, reason, 0);
  }

  /**
   * Work step: from the tick after the start, the interrupt check, then on
   * `endTick` the completion (every start check again, then `occupied`).
   */
  advance(e: Entity, tick: number): void {
    const a = e.activity;
    if (!a || tick <= a.startTick) return;
    const s = a.source;
    if (s.interruptFn) {
      const hit = s.interruptFn(this.bind(s, e, a.x, a.y));
      this.unbind();
      if (hit) return this.end(e, 'interrupted');
    }
    if (tick < a.endTick) return;
    e.activity = null;
    const failure = this.check(s, e, a.x, a.y);
    if (failure) return this.host.record(e, s, 'complete', false, failure, 0);
    this.finish(e, s, a.x, a.y);
  }

  /** Completion after the checks: `occupied`, then effects in order, then consumption. */
  private finish(e: Entity, s: ActivitySource, x: number, y: number): void {
    const { tiles, entities } = this.host;
    for (const t of s.setTiles) {
      if (tiles[t]!.walkable) continue;
      for (const o of entities) if (o.x === x && o.y === y) return this.host.record(e, s, 'complete', false, 'occupied', 0);
    }
    this.bind(s, e, x, y);
    this.host.runEffects(e, s.effects, s.filter ? this.point : null);
    this.unbind();
    let moved = 0;
    const inv = e.inv;
    if (inv) for (const c of s.consume) moved += this.host.removeItem(inv, c.item, c.count);
    this.host.record(e, s, 'complete', true, null, moved);
  }

  /** Fraction of `e`'s activity done at `tick`, in [0, 1], or null when idle. */
  static fraction(e: Entity, tick: number): number | null {
    const a = e.activity;
    if (!a) return null;
    return Math.min(1, Math.max(0, (tick - a.startTick) / (a.endTick - a.startTick)));
  }
}
