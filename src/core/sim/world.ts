/**
 * Mutable, fixed-tick simulation state built from a loaded Definition.
 * Deterministic: same definition + seed + intents ⇒ same state.
 */

import { clockAt, type ClockTime } from '../clock.ts';
import type { ArchetypeDef, BehaviorDef, Definition, EffectDef, MeasurementDef, NumberTerm } from '../definition.ts';
import type { ExprContext, ExprEntity } from '../expr/index.ts';
import { DEFAULT_FACING, facingOfStep, turnToward, type Facing } from '../facing.ts';
import { actionSource, ActivityRunner, isTimed, useSource, type Activity, type ActivitySource, type ActivityStage } from './activity.ts';
import { Pathfinder } from './astar.ts';
import { think, type ThinkEnv } from './behavior.ts';
import { add, countOf, createContainer, fits, remove, type Container, type ContainerKind } from './containers.ts';
import { Grid } from './grid.ts';
import { lineOfSight } from './sight.ts';
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
  /** Direction the entity faces; it turns toward a new direction before stepping. */
  facing: Facing;
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
  /** The entity's inventory (from its archetype's `inventory`), or null. */
  readonly inv: Container | null;
  /** Pending movement intent, applied at the start of the next tick. */
  intent: Intent | null;
  /** Result of the entity's most recent goto intent (a new object each time). */
  lastGoto: GotoRecord | null;
  /** Spawn cell (fixed). */
  readonly homeX: number;
  readonly homeY: number;
  /** Behavior driving the entity (null for the player and archetypes without one). */
  readonly behavior: BehaviorDef | null;
  /** Current state index of `behavior`, or -1 without one. */
  state: number;
  /** Tick at which the current state was entered. */
  stateTick: number;
  /** Cell and tick of the goto the current state last issued (`pursue`/`home`); `planTick` -1 = none yet. */
  planX: number;
  planY: number;
  planTick: number;
  /** Cell and tick of the last heard noise (nearest within its tick); `heardTick` -1 = never. */
  heardX: number;
  heardY: number;
  heardTick: number;
  /** In-progress timed action or item use, or null. */
  activity: Activity | null;
}

/** A noise emitted this tick by a `noise` effect. */
export interface Noise {
  x: number;
  y: number;
  radius: number;
  /** Id of the emitting entity (it does not hear its own noise). */
  source: number;
}

/** Recorded when the pack's `start.defeat` or `start.victory` condition becomes true. */
export interface OutcomeRecord {
  readonly tick: number;
  readonly message: string;
}

/** Recorded when the pack's `start.defeat` condition becomes true. */
export type DefeatRecord = OutcomeRecord;
/** Recorded when the pack's `start.victory` condition becomes true. */
export type VictoryRecord = OutcomeRecord;

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
  /**
   * End on the walkable tile 8-adjacent to the goal (or the goal itself, if
   * walkable) with the shortest path, e.g. to walk up to a fridge.
   */
  readonly adjacent?: boolean;
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

/** Container → player inventory. `count` defaults to the whole stack. */
export interface TakeAction {
  readonly kind: 'take';
  /** Container id (see `containersAt` / `reachableContainers`). */
  readonly container: number;
  /** Qualified item id. */
  readonly item: string;
  readonly count?: number;
}

/** Player inventory → container. */
export interface PutAction {
  readonly kind: 'put';
  readonly container: number;
  readonly item: string;
  readonly count?: number;
}

/** Player inventory → the ground pile on the player's cell (created if missing). */
export interface DropAction {
  readonly kind: 'drop';
  readonly item: string;
  readonly count?: number;
}

/** Run the item's `use` on the player, then remove `consume` units (at completion when timed). */
export interface UseAction {
  readonly kind: 'use';
  readonly item: string;
}

/** Start a pack action (`actions` domain); `x`/`y` are required for tile targets and forbidden for `self`. */
export interface ActAction {
  readonly kind: 'act';
  /** Qualified action id. */
  readonly action: string;
  readonly x?: number;
  readonly y?: number;
}

/** A player action, queued with `queueAction` and applied after the movement intents. */
export type Action = TakeAction | PutAction | DropAction | UseAction | ActAction;

export type ActionFailure =
  | 'out_of_reach'
  | 'too_heavy'
  | 'missing'
  | 'cannot_use'
  | 'no_inventory'
  | 'unknown_container'
  | 'unknown_action'
  | 'invalid_target'
  | 'cannot_act'
  | 'occupied'
  | 'cancelled'
  | 'interrupted';

/** Outcome of the latest action, for shell feedback. */
export interface ActionRecord {
  readonly kind: Action['kind'];
  /** Qualified item id (take/put/drop/use); empty for `act`. */
  readonly item: string;
  /** Qualified action id (`act` only). */
  readonly action?: string;
  /** Units moved (take/put/drop) or consumed (use/act). */
  readonly moved: number;
  readonly ok: boolean;
  /**
   * `start` when a timed activity starts (or fails to); `complete` when an
   * action is applied instantly or an activity ends (completed, cancelled,
   * interrupted, or failed its re-check).
   */
  readonly stage: ActivityStage;
  readonly reason?: ActionFailure;
  /** Tick at which the action was applied. */
  readonly tick: number;
}

/** An entry of `world.availableActions()`. */
export interface AvailableAction {
  readonly kind: 'act' | 'use';
  /** Qualified action id (`act`). */
  readonly action?: string;
  /** Qualified item id (`use`). */
  readonly item?: string;
  /** Target cell of a tile-targeted action. */
  readonly x?: number;
  readonly y?: number;
  readonly label: string;
  /** False when tools, consumed items, the inventory or `when` fail now. */
  readonly ok: boolean;
  readonly reason?: ActionFailure;
}

/** `world.activityProgress()`: what is being done and how far along it is. */
export interface ActivityProgress {
  readonly label: string;
  /** In [0, 1]. */
  readonly fraction: number;
}

/** An activity in a snapshot (ids qualified). */
export interface ActivitySnapshot {
  kind: 'act' | 'use';
  action?: string;
  item?: string;
  x: number;
  y: number;
  startTick: number;
  endTick: number;
}

export interface ContainerSnapshot {
  id: number;
  kind: ContainerKind;
  /** Cell of a tile container or ground pile. */
  cell?: [number, number];
  /** Owner entity id of an inventory. */
  owner?: number;
  /** Stacks as [qualified item id, count], in order. */
  stacks: [string, number][];
}

export interface EntitySnapshot {
  id: number;
  archetype: string;
  x: number;
  y: number;
  facing: Facing;
  fromX: number;
  fromY: number;
  stepTick: number;
  moveCooldown: number;
  /** Remaining path cells as [x, y] pairs. */
  path: [number, number][] | null;
  measurements: Record<string, number>;
  /** Active status ids, in definition order. */
  statuses: string[];
  intent: Intent | null;
  lastGoto: GotoRecord | null;
  home: [number, number];
  /** Current behavior state (name), when it was entered, and its last planned goto. */
  behavior: { state: string; since: number; plan: [number, number, number] | null } | null;
  /** Last heard noise, or null if never. */
  heard: { x: number; y: number; tick: number } | null;
  activity: ActivitySnapshot | null;
}

export interface WorldSnapshot {
  tick: number;
  rng: number;
  player: number;
  /** Pending actions, in queue order. */
  actions: Action[];
  lastAction: ActionRecord | null;
  defeat: DefeatRecord | null;
  victory: VictoryRecord | null;
  entities: EntitySnapshot[];
  /** Every container, in id order. */
  containers: ContainerSnapshot[];
  /** Cells whose tile differs from the map, as [cell index, qualified tile id], by cell index. */
  tiles: [number, string][];
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

/** Seed of the loot RNG: derived from the world seed, independent of `world.rng`. */
const LOOT_SALT = 0x6c6f6f74;

/** 32-bit integer hash of two values (murmur3 finalizer). */
function mix(a: number, b: number): number {
  let h = Math.imul((a ^ b) >>> 0, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class World {
  readonly grid: Grid;
  readonly entities: Entity[] = [];
  readonly player: Entity;
  readonly rng: Rng;
  tick = 0;
  /** Expression warnings (e.g. division by zero) with occurrence counts. */
  readonly warnings = new Map<string, number>();

  /** Set once the defeat condition holds; the world is frozen from then on. */
  defeat: DefeatRecord | null = null;
  /** Set once the victory condition holds (and defeat did not); the world is frozen from then on. */
  victory: VictoryRecord | null = null;
  /** Result of the most recent action (a new object each time). */
  lastAction: ActionRecord | null = null;
  /** Every container by id (tile containers, inventories, ground piles), in id order. */
  readonly containers = new Map<number, Container>();
  /** Bumped whenever any container's contents change or a pile appears/disappears (for renderers). */
  containerVersion = 0;

  private actions: Action[] = [];
  private nextContainerId = 0;
  /** Cell index → ids of the tile containers and ground piles on it, ascending. */
  private readonly cellContainers = new Map<number, number[]>();
  /** Room-set index per cell. */
  private readonly roomCell: Uint16Array;
  /** 1 at `set * roomTags.length + tag` when the room set has the tag. */
  private readonly roomHas: Uint8Array;
  private readonly itemWeights: readonly number[];
  private pathfinder: Pathfinder | null = null;
  /** Noises emitted this tick, in emission order; reused (cleared, not reallocated). */
  private readonly pending: Noise[] = [];
  /** Number of valid entries of `pending`. */
  private pendingCount = 0;
  private readonly ctx: ExprContext;
  private readonly thinkEnv: ThinkEnv;
  private readonly tagSets: ReadonlySet<string>[];
  private readonly tileTagSets: ReadonlySet<string>[];
  /** Per archetype index: 1 at each measurement index the archetype has. */
  private readonly hasM: Uint8Array[];
  /** Per status: its `rates` term by measurement index (undefined = none). */
  private readonly statusRates: (NumberTerm | undefined)[][];
  /** Scratch for the status update: next flags of every entity, row-major. */
  private statusNext = new Uint8Array(0);
  /** Activity source per action index. */
  private readonly actionSources: readonly ActivitySource[];
  /** Activity source per item index (null without a `use`). */
  private readonly useSources: readonly (ActivitySource | null)[];
  private readonly runner: ActivityRunner;

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

    const nt = def.roomTags.length;
    this.roomCell = Uint16Array.from(map.rooms.cellSet);
    this.roomHas = new Uint8Array(map.rooms.sets.length * nt);
    map.rooms.sets.forEach((set, k) => {
      for (const t of set) this.roomHas[k * nt + t] = 1;
    });
    this.itemWeights = def.items.map((i) => i.weight);

    // Container ids: tile containers in row-major order, then inventories in entity order.
    for (let i = 0; i < map.cells.length; i++) {
      const tile = def.tiles[map.cells[i]!]!;
      if (!tile.container) continue;
      const x = i % map.width;
      const y = (i - x) / map.width;
      this.addContainer(createContainer(this.nextContainerId++, 'tile', tile.container.capacity, { x, y, tile: tile.index }));
    }
    const start = map.playerStart!;
    this.player = this.spawn(def.archetypes[def.start.player]!, start.x, start.y, false);
    for (const s of map.spawns) this.spawn(def.archetypes[s.archetype]!, s.x, s.y);
    this.rollLoot(seed);

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
      inRoom: (x, y, tag) => world.grid.inBounds(x, y) && world.roomHas[world.roomCell[y * world.grid.width + x]! * nt + tag] === 1,
      los: (x0, y0, x1, y1) => lineOfSight(world.grid, x0, y0, x1, y1),
      warn: (msg) => world.warnings.set(msg, (world.warnings.get(msg) ?? 0) + 1),
    };
    this.thinkEnv = { grid: this.grid, rng: this.rng, ctx: this.ctx };
    this.actionSources = def.actions.map(actionSource);
    this.useSources = def.items.map(useSource);
    this.runner = new ActivityRunner({
      grid: this.grid,
      tiles: def.tiles,
      ctx: this.ctx,
      entities: this.entities,
      ticksPerSecond: def.ticksPerSecond,
      runEffects: (e, effects, target) => this.runEffects(e, effects, target),
      removeItem: (inv, item, count) => remove(inv, item, count, this.itemWeights[item]!),
      record: (e, source, stage, ok, reason, moved) => this.recordActivity(e, source, stage, ok, reason, moved),
    });
    for (const e of this.entities) this.clamp(e);
    this.updateStatuses();
  }

  static create(def: Definition, seed: number): World {
    return new World(def, seed);
  }

  /** Result of the player's most recent goto intent (a new object each time). */
  get lastGoto(): GotoRecord | null {
    return this.player.lastGoto;
  }

  get seconds(): number {
    return this.tick / this.def.ticksPerSecond;
  }

  /** In-game calendar time at the current tick. */
  get clock(): ClockTime {
    return clockAt(this.def.clock, this.tick, this.def.ticksPerSecond);
  }

  /** Add an entity; `driven` = run its archetype's behavior (false for the player). */
  private spawn(archetype: ArchetypeDef, x: number, y: number, driven = true): Entity {
    const id = this.entities.length;
    let inv: Container | null = null;
    if (archetype.inventory) {
      inv = createContainer(this.nextContainerId++, 'inventory', archetype.inventory.capacity, { owner: id });
      for (const s of archetype.inventory.items) add(inv, s.item, s.count, this.itemWeights[s.item]!);
      this.containers.set(inv.id, inv);
    }
    const m = new Float64Array(this.def.measurements.length);
    archetype.measurements.forEach((idx, k) => (m[idx] = archetype.initial[k]!));
    const max = new Float64Array(this.def.measurements.length).fill(Infinity);
    const behavior = driven && archetype.behavior !== null ? this.def.behaviors[archetype.behavior]! : null;
    const e: Entity = {
      id,
      archetype,
      x,
      y,
      m,
      max,
      tags: this.tagSets[archetype.index]!,
      moveCooldown: 0,
      facing: DEFAULT_FACING,
      fromX: x,
      fromY: y,
      stepTick: 0,
      path: null,
      pathPos: 0,
      st: new Uint8Array(this.def.statuses.length),
      inv,
      intent: null,
      lastGoto: null,
      homeX: x,
      homeY: y,
      behavior,
      state: behavior ? behavior.initial : -1,
      stateTick: 0,
      planX: 0,
      planY: 0,
      planTick: -1,
      heardX: 0,
      heardY: 0,
      heardTick: -1,
      activity: null,
    };
    this.entities.push(e);
    return e;
  }

  // ── Containers ──────────────────────────────────────────────────────────

  private addContainer(c: Container): void {
    this.containers.set(c.id, c);
    const cell = c.y * this.grid.width + c.x;
    const ids = this.cellContainers.get(cell);
    if (ids) ids.push(c.id);
    else this.cellContainers.set(cell, [c.id]);
  }

  /** Remove a ground pile once it is empty. */
  private pruneGround(c: Container): void {
    if (c.kind !== 'ground' || c.stacks.length > 0) return;
    this.containers.delete(c.id);
    const cell = c.y * this.grid.width + c.x;
    const ids = this.cellContainers.get(cell)!;
    ids.splice(ids.indexOf(c.id), 1);
    if (ids.length === 0) this.cellContainers.delete(cell);
  }

  /** Tile containers and ground piles on a cell, in id order. */
  containersAt(x: number, y: number): Container[] {
    if (!this.grid.inBounds(x, y)) return [];
    const ids = this.cellContainers.get(y * this.grid.width + x);
    return ids ? ids.map((id) => this.containers.get(id)!) : [];
  }

  /** Every container the player can reach now (its cell or the 8 around it), in id order. */
  reachableContainers(): Container[] {
    const { x, y } = this.player;
    const out: Container[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...this.containersAt(x + dx, y + dy));
    return out.sort((a, b) => a.id - b.id);
  }

  /** Room tag indices of a cell (empty outside rooms or out of bounds). */
  roomTagsAt(x: number, y: number): readonly number[] {
    if (!this.grid.inBounds(x, y)) return [];
    return this.def.maps[this.def.start.map]!.rooms.sets[this.roomCell[y * this.grid.width + x]!]!;
  }

  /** Fill tile containers from their distributions, with a dedicated RNG (never `this.rng`). */
  private rollLoot(seed: number): void {
    const def = this.def;
    if (def.distributions.length === 0) return;
    const rng = new Rng(mix(seed, LOOT_SALT));
    const w = this.grid.width;
    const chosen = new Map<number, number>(); // tile * sets + roomSet → table (-1 = none)
    const nsets = def.maps[def.start.map]!.rooms.sets.length;
    for (const c of this.containers.values()) {
      if (c.kind !== 'tile') break; // tile containers come first
      const set = this.roomCell[c.y * w + c.x]!;
      const key = c.tile * nsets + set;
      let table = chosen.get(key);
      if (table === undefined) {
        table = this.distributionFor(c.tile, set);
        chosen.set(key, table);
      }
      if (table >= 0) this.rollTable(table, c, rng);
    }
  }

  /** First most specific distribution: a matching `room` beats no `room`; ties go to the first. */
  private distributionFor(tile: number, set: number): number {
    const nt = this.def.roomTags.length;
    let fallback = -1;
    for (const d of this.def.distributions) {
      if (d.container !== tile) continue;
      if (d.room === null) {
        if (fallback < 0) fallback = d.table;
      } else if (this.roomHas[set * nt + d.room] === 1) return d.table;
    }
    return fallback;
  }

  private rollTable(t: number, c: Container, rng: Rng): void {
    const table = this.def.loot[t]!;
    const between = (lo: number, hi: number) => (lo === hi ? lo : lo + Math.floor(rng.next() * (hi - lo + 1)));
    const rolls = between(table.rollsMin, table.rollsMax);
    for (let r = 0; r < rolls; r++) {
      const pick = rng.next() * table.total;
      let k = 0;
      while (table.cumulative[k]! <= pick) k++;
      const e = table.entries[k]!;
      if (e.kind === 'item') {
        const weight = this.itemWeights[e.item]!;
        add(c, e.item, fits(c, weight, between(e.countMin, e.countMax)), weight);
      } else if (e.kind === 'table') this.rollTable(e.table, c, rng);
    }
  }

  /** Queue a player action (FIFO; applied after the movement intents). Ignored once the game has ended. */
  queueAction(action: Action): void {
    if (this.ended) return;
    this.actions.push(action);
  }

  /**
   * Queue an entity's next move (the player by default); the latest intent
   * wins until it is applied. Throws for an entity of another world.
   */
  queueIntent(intent: Intent, entity: Entity = this.player): void {
    if (this.entities[entity.id] !== entity) throw new Error(`entity ${entity.id} does not belong to this world`);
    if (this.ended) return;
    if (intent.kind === 'step' && intent.dx === 0 && intent.dy === 0) return;
    entity.intent = intent;
  }

  /** True once the game has ended (defeat or victory): the world is frozen. */
  get ended(): boolean {
    return this.defeat !== null || this.victory !== null;
  }

  /** Goal tile of an entity's active path, or null. */
  pathGoal(e: Entity): { x: number; y: number } | null {
    if (!e.path || e.pathPos >= e.path.length) return null;
    const i = e.path[e.path.length - 1]!;
    return { x: i % this.grid.width, y: Math.floor(i / this.grid.width) };
  }

  /** Bumped on every map edit (`set_tile`), so renderers can redraw changed cells. */
  get tileVersion(): number {
    return this.grid.version;
  }

  /** This tick's noises (after `step`, the last stepped tick's), in emission order. */
  get noises(): readonly Readonly<Noise>[] {
    return this.pending.slice(0, this.pendingCount);
  }

  /**
   * Advance exactly one tick (1 / ticksPerSecond seconds): behaviors think
   * (id order), every entity's movement intent (id order), player actions,
   * activity work (id order), drift, due systems, hearing, clamp, status
   * update, defeat then victory check, `tick++`.
   * A no-op once the game has ended.
   */
  step(): void {
    if (this.ended) return;
    this.ctx.tick = this.tick;
    this.pendingCount = 0;
    this.think();
    for (const e of this.entities) {
      if (e.intent || e.path) this.applyIntent(e);
      else if (e.moveCooldown > 0) e.moveCooldown--;
    }
    if (this.actions.length > 0) this.applyActions();
    for (const e of this.entities) if (e.activity) this.runner.advance(e, this.tick);
    this.drift();
    this.runSystems();
    if (this.pendingCount > 0) this.hear();
    for (const e of this.entities) this.clamp(e);
    this.updateStatuses();
    this.checkOutcome();
    this.tick++;
  }

  /** Phase 0: each behavior-driven entity switches state at most once, then issues its activity's intent. */
  private think(): void {
    const env = this.thinkEnv;
    for (const e of this.entities) if (e.state >= 0) think(e, env);
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
        this.runEffects(e, sys.effects);
      }
    }
  }

  /**
   * Run effects on `e` (= `ctx.self`), in order; measurement effects skip
   * measurements it lacks. `set_tile` replaces the tile at `target`.
   */
  private runEffects(e: Entity, effects: readonly EffectDef[], target: { x: number; y: number } | null = null): void {
    const ctx = this.ctx;
    const has = this.hasM[e.archetype.index]!;
    for (const eff of effects) {
      if (eff.type === 'noise') {
        this.emitNoise(e, eff.fn ? Number(eff.fn(ctx)) : eff.constant);
        continue;
      }
      if (eff.type === 'set_tile') {
        if (target) this.grid.setTile(target.y * this.grid.width + target.x, eff.tile);
        continue;
      }
      const idx = eff.measurement;
      if (has[idx] !== 1) continue;
      const v = eff.fn ? Number(eff.fn(ctx)) : eff.constant;
      e.m[idx] = eff.type === 'apply' ? e.m[idx]! + v : v;
    }
  }

  /** Queue a noise at the source's cell; a radius ≤ 0 (or NaN) emits nothing. */
  private emitNoise(source: Entity, radius: number): void {
    if (!(radius > 0)) return;
    const n = this.pendingCount++;
    const slot = this.pending[n];
    if (slot) {
      slot.x = source.x;
      slot.y = source.y;
      slot.radius = radius;
      slot.source = source.id;
    } else this.pending.push({ x: source.x, y: source.y, radius, source: source.id });
  }

  /**
   * Phase 4: every entity except the source hears a noise within its radius
   * (euclidean, inclusive, walls ignored) and keeps this tick's nearest one
   * (ties: the earlier emission). O(noises × entities), no allocation.
   */
  private hear(): void {
    const k = this.pendingCount;
    const noises = this.pending;
    for (const e of this.entities) {
      let best = Infinity;
      let pick = -1;
      for (let i = 0; i < k; i++) {
        const n = noises[i]!;
        if (n.source === e.id) continue;
        const dx = n.x - e.x;
        const dy = n.y - e.y;
        const d = dx * dx + dy * dy;
        if (d <= n.radius * n.radius && d < best) {
          best = d;
          pick = i;
        }
      }
      if (pick < 0) continue;
      const n = noises[pick]!;
      e.heardX = n.x;
      e.heardY = n.y;
      e.heardTick = this.tick;
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

  /** Phase 7: defeat first; victory only when defeat did not trigger. */
  private checkOutcome(): void {
    const { defeat, victory } = this.def.start;
    if (!defeat && !victory) return;
    this.ctx.self = this.player;
    if (defeat && defeat.when(this.ctx)) this.defeat = { tick: this.tick, message: defeat.message };
    else if (victory && victory.when(this.ctx)) this.victory = { tick: this.tick, message: victory.message };
  }

  /** Whether an entity has a status (by qualified id). */
  hasStatus(e: Entity, statusId: string): boolean {
    const k = this.def.ids.statuses[statusId];
    return k !== undefined && e.st[k] === 1;
  }

  /**
   * Resolve an entity's pending intent (which cancels its activity), count
   * its cooldown down, then step or advance its path.
   */
  private applyIntent(p: Entity): void {
    const intent = p.intent;
    if (intent && p.activity) this.runner.end(p, 'cancelled');
    if (intent?.kind === 'goto') {
      p.intent = null;
      this.pathfinder ??= new Pathfinder(this.grid);
      const path = intent.adjacent
        ? this.pathfinder.findPathAdjacent(p.x, p.y, intent.x, intent.y)
        : this.pathfinder.findPath(p.x, p.y, intent.x, intent.y);
      p.path = path && path.length > 0 ? path : null;
      p.pathPos = 0;
      p.lastGoto = { x: intent.x, y: intent.y, ok: path !== null, tick: this.tick };
    } else if (intent?.kind === 'step') {
      p.path = null;
    }

    if (p.moveCooldown > 0) p.moveCooldown--;
    if (p.moveCooldown > 0) return;
    const w = this.grid.width;
    let dx: number;
    let dy: number;
    if (p.intent?.kind === 'step') ({ dx, dy } = p.intent);
    else if (p.path) {
      const next = p.path[p.pathPos]!;
      dx = (next % w) - p.x;
      dy = Math.floor(next / w) - p.y;
    } else return;

    // Turn toward the step first; the intent and path stay pending meanwhile.
    const want = facingOfStep(dx, dy);
    if (want && p.facing !== want) {
      if (p.archetype.ticksPerTurn > 0) {
        p.facing = turnToward(p.facing, want);
        p.moveCooldown = p.archetype.ticksPerTurn;
        return;
      }
      p.facing = want;
    }

    if (p.intent?.kind === 'step') {
      p.intent = null;
      this.move(p, dx, dy);
    } else if (p.path) {
      p.pathPos++;
      if (p.pathPos >= p.path.length) p.path = null;
      if (!this.move(p, dx, dy)) p.path = null;
    }
  }

  /** Each queued action first cancels the player's activity, then is applied (FIFO). */
  private applyActions(): void {
    const queue = this.actions;
    this.actions = [];
    this.ctx.tick = this.tick;
    for (const a of queue) {
      this.runner.end(this.player, 'cancelled');
      const r = this.applyAction(a);
      if (r) this.lastAction = r;
    }
  }

  /** Record of an activity source's start or end (the player's becomes `lastAction`). */
  private recordActivity(e: Entity, s: ActivitySource, stage: ActivityStage, ok: boolean, reason: ActionFailure | null, moved: number): void {
    if (ok && stage === 'complete') this.containerVersion++;
    if (e !== this.player) return;
    this.lastAction = {
      kind: s.kind,
      item: s.item >= 0 ? this.def.items[s.item]!.id : '',
      ...(s.action >= 0 ? { action: this.def.actions[s.action]!.id } : {}),
      moved,
      ok,
      stage,
      ...(reason ? { reason } : {}),
      tick: this.tick,
    };
  }

  /** Apply one action; `act`/`use` that reach the activity runner record themselves (null). */
  private applyAction(a: Action): ActionRecord | null {
    const tick = this.tick;
    const p = this.player;
    const inv = p.inv;

    if (a.kind === 'act') {
      const fail = (reason: ActionFailure, stage: ActivityStage): ActionRecord => ({ kind: 'act', item: '', action: a.action, moved: 0, ok: false, stage, reason, tick });
      const k = this.def.ids.actions[a.action];
      if (k === undefined) return fail('unknown_action', 'complete');
      const s = this.actionSources[k]!;
      const stage = isTimed(s) ? 'start' : 'complete';
      if (s.requires.length > 0 && !inv) return fail('no_inventory', stage);
      const hasXY = a.x !== undefined || a.y !== undefined;
      if (s.filter ? !(Number.isInteger(a.x) && Number.isInteger(a.y)) : hasXY) return fail('invalid_target', stage);
      this.runner.start(s, p, s.filter ? a.x! : p.x, s.filter ? a.y! : p.y, tick);
      return null;
    }

    const fail = (reason: ActionFailure): ActionRecord => ({ kind: a.kind, item: a.item, moved: 0, ok: false, stage: 'complete', reason, tick });
    const done = (moved: number): ActionRecord => {
      this.containerVersion++;
      return { kind: a.kind, item: a.item, moved, ok: true, stage: 'complete', tick };
    };
    if (!inv) return fail('no_inventory');
    const item = this.def.ids.items[a.item];
    if (item === undefined) return fail('missing');
    const weight = this.itemWeights[item]!;
    const want = a.kind === 'use' || a.count === undefined ? Infinity : Math.floor(a.count);
    if (!(want >= 1)) return fail('missing');

    if (a.kind === 'use') {
      const s = this.useSources[item];
      if (countOf(inv, item) === 0) return fail('missing');
      if (!s) return fail('cannot_use');
      this.runner.start(s, p, p.x, p.y, tick);
      return null;
    }

    if (a.kind === 'drop') {
      const n = Math.min(want, countOf(inv, item));
      if (n === 0) return fail('missing');
      let pile = this.containersAt(p.x, p.y).find((c) => c.kind === 'ground');
      if (!pile) {
        pile = createContainer(this.nextContainerId++, 'ground', Infinity, { x: p.x, y: p.y });
        this.addContainer(pile);
      }
      remove(inv, item, n, weight);
      add(pile, item, n, weight);
      return done(n);
    }

    const c = this.containers.get(a.container);
    if (!c || c.kind === 'inventory') return fail('unknown_container');
    if (Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) > 1) return fail('out_of_reach');
    const [from, to] = a.kind === 'take' ? [c, inv] : [inv, c];
    const have = Math.min(want, countOf(from, item));
    if (have === 0) return fail('missing');
    const n = fits(to, weight, have);
    if (n === 0) return fail('too_heavy');
    remove(from, item, n, weight);
    add(to, item, n, weight);
    this.pruneGround(c);
    return done(n);
  }

  /** Take one step if allowed (the caller has already turned to face it); records the step for rendering. */
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
    const items = this.def.items;
    return {
      tick: this.tick,
      rng: this.rng.state,
      player: this.player.id,
      actions: [...this.actions],
      lastAction: this.lastAction,
      defeat: this.defeat,
      victory: this.victory,
      entities: this.entities.map((e) => ({
        id: e.id,
        archetype: e.archetype.id,
        x: e.x,
        y: e.y,
        facing: e.facing,
        fromX: e.fromX,
        fromY: e.fromY,
        stepTick: e.stepTick,
        moveCooldown: e.moveCooldown,
        path: e.path
          ? [...e.path.subarray(e.pathPos)].map((i): [number, number] => [i % this.grid.width, Math.floor(i / this.grid.width)])
          : null,
        measurements: Object.fromEntries(e.archetype.measurements.map((idx) => [ms[idx]!.id, e.m[idx]!])),
        statuses: this.def.statuses.filter((s) => e.st[s.index] === 1).map((s) => s.id),
        intent: e.intent,
        lastGoto: e.lastGoto,
        home: [e.homeX, e.homeY],
        behavior: e.behavior
          ? { state: e.behavior.states[e.state]!.name, since: e.stateTick, plan: e.planTick >= 0 ? [e.planX, e.planY, e.planTick] : null }
          : null,
        heard: e.heardTick >= 0 ? { x: e.heardX, y: e.heardY, tick: e.heardTick } : null,
        activity: e.activity ? this.activitySnapshot(e.activity) : null,
      })),
      containers: [...this.containers.values()].map((c) => {
        const out: ContainerSnapshot = { id: c.id, kind: c.kind, stacks: c.stacks.map((s): [string, number] => [items[s.item]!.id, s.count]) };
        if (c.kind === 'inventory') out.owner = c.owner;
        else out.cell = [c.x, c.y];
        return out;
      }),
      tiles: [...this.grid.changed].sort((a, b) => a[0] - b[0]).map(([i, t]): [number, string] => [i, this.def.tiles[t]!.id]),
    };
  }

  private activitySnapshot(a: Activity): ActivitySnapshot {
    const s = a.source;
    return {
      kind: s.kind,
      ...(s.action >= 0 ? { action: this.def.actions[s.action]!.id } : {}),
      ...(s.item >= 0 ? { item: this.def.items[s.item]!.id } : {}),
      x: a.x,
      y: a.y,
      startTick: a.startTick,
      endTick: a.endTick,
    };
  }

  /**
   * Everything the player could start now: every `self` action, every tile
   * action on each matching cell in reach (row-major), then each inventory
   * stack with a `use`. Entries that match but fail on items, the inventory
   * or `when` are included with `ok: false`. Pure: `random` in a `when` draws
   * from a throwaway copy of the RNG, so `hash()` never changes.
   */
  availableActions(): AvailableAction[] {
    const p = this.player;
    const ctx = this.ctx;
    const { random, warn } = ctx;
    const rng = new Rng(this.rng.state);
    ctx.random = () => rng.next();
    ctx.warn = () => {};
    ctx.tick = this.tick;
    const out: AvailableAction[] = [];
    const entry = (base: Omit<AvailableAction, 'ok' | 'reason'>, reason: ActionFailure | null): AvailableAction =>
      reason ? { ...base, ok: false, reason } : { ...base, ok: true };
    try {
      for (const s of this.actionSources) {
        if (s.filter) continue;
        out.push(entry({ kind: 'act', action: this.def.actions[s.action]!.id, label: s.label }, this.runner.check(s, p, p.x, p.y)));
      }
      const { grid } = this;
      for (const s of this.actionSources) {
        if (!s.filter) continue;
        for (let y = p.y - 1; y <= p.y + 1; y++) {
          for (let x = p.x - 1; x <= p.x + 1; x++) {
            if (!grid.inBounds(x, y) || s.filter[grid.cells[y * grid.width + x]!] !== 1) continue;
            const reason = this.runner.check(s, p, x, y);
            if (reason === 'out_of_reach' || reason === 'invalid_target') continue;
            out.push(entry({ kind: 'act', action: this.def.actions[s.action]!.id, x, y, label: s.label }, reason));
          }
        }
      }
      for (const st of p.inv?.stacks ?? []) {
        const s = this.useSources[st.item];
        if (s) out.push(entry({ kind: 'use', item: this.def.items[st.item]!.id, label: s.label }, this.runner.check(s, p, p.x, p.y)));
      }
    } finally {
      ctx.random = random;
      ctx.warn = warn;
    }
    return out;
  }

  /** The entity's activity (the player's by default): its progress text and how far along it is, or null. */
  activityProgress(e: Entity = this.player): ActivityProgress | null {
    const fraction = ActivityRunner.fraction(e, this.tick);
    return fraction === null ? null : { label: e.activity!.source.progress, fraction };
  }

  hash(): string {
    return fnv1a(JSON.stringify(this.snapshot()));
  }
}
