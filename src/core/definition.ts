/**
 * The immutable, fully resolved output of the pack loader. Runtime code trusts
 * it without re-checking: every reference is an index, every expression is a
 * compiled closure, every id is qualified (`ns:id`).
 */

import type { ClockDef } from './clock.ts';
import type { Compiled } from './expr/index.ts';
import type { Facing, FacingImage } from './facing.ts';

export const TICKS_PER_SECOND = 10;

/**
 * A duration in sim seconds → whole ticks, rounded up (negative or NaN ⇒ 0).
 * A tiny epsilon absorbs float noise, so `0.3 s` is 3 ticks, not 4.
 */
export function secondsToTicks(seconds: number, ticksPerSecond = TICKS_PER_SECOND): number {
  const t = seconds * ticksPerSecond;
  return t > 0 ? Math.ceil(t - 1e-9) : 0;
}

export interface PackInfo {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly depends: readonly string[];
}

export interface MeasurementDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly min: number;
  /** Constant upper bound; `Infinity` when unbounded or when `maxFn` is set. */
  readonly maxConst: number;
  /** Per-entity upper bound (measurement reference or expression). */
  readonly maxFn: Compiled | null;
  readonly initial: number;
  /** Constant per-second drift; ignored when `rateFn` is set. */
  readonly rateConst: number;
  /** Per-second drift evaluated per entity each tick. */
  readonly rateFn: Compiled | null;
}

/** One image file of an asset. */
export interface AssetImage {
  /** Path relative to the pack root (`.svg` or `.png`). */
  readonly file: string;
  /** Normalized image point placed on the entry's anchor spot; default [0.5, 1]. */
  readonly anchor: readonly [number, number];
}

/** An image, or one image per direction, in a pack (`assets` domain). */
export interface AssetDef {
  readonly id: string;
  readonly index: number;
  /** Namespace of the pack that ships the files. */
  readonly pack: string;
  /** The distinct image files (one for a `file` asset). */
  readonly images: readonly AssetImage[];
  /** 1 for a `file` asset, else 4 or 8 (`directions` with a diagonal key). */
  readonly ways: 1 | 4 | 8;
  /**
   * Image per facing, indexed like `FACINGS` (see `facingTable`). Null only
   * for the diagonals of a 4-way asset, which snap via `resolveFacing`. A
   * `file` asset uses image 0 unmirrored for every facing.
   */
  readonly byFacing: readonly (FacingImage | null)[];
}

export interface TileDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly glyph: string;
  readonly color: string;
  readonly walkable: boolean;
  /** Rendered as a raised block (depth-sorted with entities) instead of flat ground. */
  readonly raised: boolean;
  /** Blocks line of sight (default: not walkable). */
  readonly opaque: boolean;
  /** Asset index, or null for a generated placeholder. */
  readonly sprite: number | null;
  /** Tile tags (separate from archetype tags). */
  readonly tags: readonly string[];
  /** Every map cell with this tile gets its own container; null for none. */
  readonly container: ContainerSpec | null;
  /** Link to the same (x, y) one floor up (`up`) or down (`down`); null for none. */
  readonly climb: 'up' | 'down' | null;
}

/** Tile index of an empty map cell: no tile, not walkable, not opaque, not drawn. */
export const EMPTY_TILE = 0xffff;

/** A weight-capped container declaration. */
export interface ContainerSpec {
  /** Capacity in hundredths of a weight unit (integer). */
  readonly capacity: number;
}

/** A stack of items as declared in pack data (item index + count). */
export interface ItemCount {
  readonly item: number;
  readonly count: number;
}

/** `archetypes[].inventory`: capacity plus starting items, in written order. */
export interface InventorySpec extends ContainerSpec {
  readonly items: readonly ItemCount[];
}

/**
 * A duration in sim seconds: a constant (already in ticks) or an expression
 * evaluated once, when the activity starts.
 */
export interface DurationDef {
  /** Ticks when `fn` is null (≥ 0). */
  readonly ticks: number;
  /** Seconds, rounded up to whole ticks at start (negative ⇒ 0). */
  readonly fn: Compiled | null;
}

/** `items[].use`: effects run on the user, then `consume` units are removed. */
export interface ItemUseDef {
  /** Verb shown in the UI (default `"Use"`). */
  readonly label: string;
  /** Condition with `self` = the user; null means always. */
  readonly whenFn: Compiled | null;
  readonly effects: readonly EffectDef[];
  /** Units removed per use (0 = reusable). */
  readonly consume: number;
  /** 0 ticks (the default) keeps the use instant. */
  readonly duration: DurationDef;
  /** Cancels a timed use when truthy (checked every tick after the start); null = never. */
  readonly interruptFn: Compiled | null;
}

/**
 * A tile filter `{ tiles?, tags? }`: a cell matches when its tile is listed
 * or has any of the tags. Compiled to one flag per tile index.
 */
export interface TileFilterDef {
  /** Listed tile indices. */
  readonly tiles: readonly number[];
  /** Listed tile tags. */
  readonly tags: readonly string[];
  /** 1 at each matching tile index (length = all tiles). */
  readonly match: readonly number[];
}

/** A pack-defined action (`actions` domain), started with `{ kind: 'act' }`. */
export interface ActionDef {
  readonly id: string;
  readonly index: number;
  /** Verb shown in the UI. */
  readonly label: string;
  /** Text shown while in progress (defaults to `label`). */
  readonly progress: string;
  /** Tile filter of the target cell, or null for a `self` target. */
  readonly target: TileFilterDef | null;
  /** Checked at start and at completion; null means always. */
  readonly whenFn: Compiled | null;
  /** UI text shown when `when` is falsy, or null for the default. */
  readonly unavailable: string | null;
  /** Item indices that must be held (never consumed). */
  readonly tools: readonly number[];
  /** Items that must be held, removed at completion. */
  readonly consume: readonly ItemCount[];
  readonly duration: DurationDef;
  /** Cancels the activity when truthy (checked every tick after the start); null = never. */
  readonly interruptFn: Compiled | null;
  /** Run once, at completion. */
  readonly effects: readonly EffectDef[];
}

/**
 * A pack-defined recipe (`recipes` domain), started with `{ kind: 'craft' }`:
 * consumes items, needs tools, produces items, optionally at a station cell.
 */
export interface RecipeDef {
  readonly id: string;
  readonly index: number;
  /** Name of the result, e.g. `Hot beans`. */
  readonly label: string;
  /** Shown as `<verb>: <label>` in menus (default `Craft`). */
  readonly verb: string;
  /** Grouping in the crafting panel (default `General`). */
  readonly category: string;
  /** Text shown while in progress (defaults to `<verb>: <label>`). */
  readonly progress: string;
  /** Item indices that must be held (never consumed). */
  readonly tools: readonly number[];
  /** Items removed at completion (non-empty). */
  readonly consume: readonly ItemCount[];
  /** Items added at completion, in written order (non-empty); overflow goes to the ground. */
  readonly produce: readonly ItemCount[];
  /** Tile filter of the station cell, or null when the recipe needs none. */
  readonly station: TileFilterDef | null;
  /** Checked at start and at completion; null means always. */
  readonly whenFn: Compiled | null;
  /** UI text shown when `when` is falsy, or null for the default. */
  readonly unavailable: string | null;
  readonly duration: DurationDef;
  /** Cancels the activity when truthy (checked every tick after the start); null = never. */
  readonly interruptFn: Compiled | null;
  /** Extra effects on the crafter, run last at completion (never `set_tile`). */
  readonly effects: readonly EffectDef[];
}

/** An item kind (`items` domain). Items are plain data inside containers. */
export interface ItemDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly glyph: string;
  readonly color: string;
  /** Weight per unit, in integer hundredths. */
  readonly weight: number;
  /** Item tags (separate from tile and archetype tags). */
  readonly tags: readonly string[];
  /** Asset index for the iso ground pile, or null for a placeholder. */
  readonly sprite: number | null;
  readonly use: ItemUseDef | null;
}

/** One entry of a loot table: exactly one of an item, a nested table, or nothing. */
export type LootEntryDef =
  | { readonly kind: 'item'; readonly item: number; readonly weight: number; readonly countMin: number; readonly countMax: number }
  | { readonly kind: 'table'; readonly table: number; readonly weight: number }
  | { readonly kind: 'nothing'; readonly weight: number };

/** A loot table (`loot` domain). */
export interface LootTableDef {
  readonly id: string;
  readonly index: number;
  readonly rollsMin: number;
  readonly rollsMax: number;
  readonly entries: readonly LootEntryDef[];
  /** Running sum of entry weights (same order as `entries`). */
  readonly cumulative: readonly number[];
  /** Sum of entry weights. */
  readonly total: number;
}

/** `distributions` entry: which loot table fills a tile container (optionally only in a room). */
export interface DistributionDef {
  /** Tile index (a tile with `container`). */
  readonly container: number;
  /** Room tag index into `Definition.roomTags`, or null for any room. */
  readonly room: number | null;
  readonly table: number;
}

/** A map room: a rectangle of cells on one floor with room tags. */
export interface RoomDef {
  readonly x: number;
  readonly y: number;
  /** Floor of the rectangle. */
  readonly z: number;
  readonly w: number;
  readonly h: number;
  /** Indices into `Definition.roomTags`. */
  readonly tags: readonly number[];
}

/** Resolved `maps[].rooms`. */
export interface RoomsDef {
  readonly rects: readonly RoomDef[];
  /** Unique room-tag combinations (tag indices, sorted); set 0 is always the empty set. */
  readonly sets: readonly (readonly number[])[];
  /** Room-set index per cell (cell index order). */
  readonly cellSet: readonly number[];
}

export interface ArchetypeDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly glyph: string;
  readonly color: string;
  readonly tags: readonly string[];
  /** Measurement indices this archetype has, in definition order. */
  readonly measurements: readonly number[];
  /** Initial value per entry of `measurements` (same order). */
  readonly initial: readonly number[];
  readonly ticksPerStep: number;
  /** Ticks per 45° turn before stepping in a new direction (0 = instant). */
  readonly ticksPerTurn: number;
  /** Asset index, or null for a generated placeholder. */
  readonly sprite: number | null;
  /** Every entity of this archetype gets an inventory; null for none. */
  readonly inventory: InventorySpec | null;
  /** Behavior index driving non-player entities of this archetype, or null. */
  readonly behavior: number | null;
}

/** Built-in activity of a behavior state. */
export type ActivityKind = 'idle' | 'wander' | 'pursue' | 'flee' | 'home' | 'investigate';

/** `on` entry: switch to state `to` when `when` is truthy. */
export interface TransitionDef {
  readonly when: Compiled;
  readonly to: number;
}

/** One state of a behavior (indices refer to `BehaviorDef.states`). */
export interface BehaviorStateDef {
  readonly name: string;
  readonly index: number;
  readonly activity: ActivityKind;
  /** Point expression (entity or tile) with `self` = the entity; set for `pursue`/`flee` only. */
  readonly target: Compiled | null;
  /** `wander`: maximum Chebyshev distance from home; null = unbounded. */
  readonly radius: number | null;
  /** `pursue`/`investigate`: minimum ticks between A* re-plans (≥ 1). */
  readonly repath: number;
  /** Checked in order; the first truthy `when` wins. */
  readonly on: readonly TransitionDef[];
  readonly timeout: { readonly afterTicks: number; readonly to: number } | null;
  /** `home`/`investigate`: state to switch to once arrived (or when the path fails). */
  readonly done: number | null;
}

/** A declarative state machine (`behaviors` domain). */
export interface BehaviorDef {
  readonly id: string;
  readonly index: number;
  readonly initial: number;
  readonly states: readonly BehaviorStateDef[];
}

export interface SpawnDef {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly archetype: number;
}

export interface MapDef {
  readonly id: string;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** Number of stacked floors (≥ 1), `z = 0, 1, …`. */
  readonly floors: number;
  /**
   * Tile index per cell (`EMPTY_TILE` for none), by cell index
   * `(z * height + y) * width + x`.
   */
  readonly cells: readonly number[];
  /**
   * Legend `facing` per cell, by cell index; null where the legend does not set
   * one (shown as the default `s`). Render-only: the simulation ignores it.
   */
  readonly facings: readonly (Facing | null)[];
  /** Ordered by `z`, then row-major. */
  readonly spawns: readonly SpawnDef[];
  readonly playerStart: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly rooms: RoomsDef;
}

/** A numeric term: a folded constant, or a closure when `fn` is set. */
export interface NumberTerm {
  readonly constant: number;
  readonly fn: Compiled | null;
}

/** A measurement effect; always acts on `self`. */
export interface MeasurementEffectDef extends NumberTerm {
  /** `apply` adds the value, `set` replaces the measurement's value. */
  readonly type: 'apply' | 'set';
  readonly measurement: number;
}

/** Emits a noise at `self`'s cell; the term is the hearing radius in tiles. */
export interface NoiseEffectDef extends NumberTerm {
  readonly type: 'noise';
}

/** Replaces the tile at an action's target cell (tile-targeted actions only). */
export interface SetTileEffectDef {
  readonly type: 'set_tile';
  /** Tile index (never a tile with a container). */
  readonly tile: number;
}

/** One effect of a system, item use or action. */
export type EffectDef = MeasurementEffectDef | NoiseEffectDef | SetTileEffectDef;

/** A periodic rule (`systems` domain), run once per matching entity. */
export interface SystemDef {
  readonly id: string;
  readonly index: number;
  /** Period in sim seconds, as written. */
  readonly every: number;
  /** Period in ticks (≥ 1); fires on ticks where `(tick + 1) % period === 0`. */
  readonly period: number;
  /** Entity filter; null means always true. */
  readonly forFn: Compiled | null;
  /** Extra condition, evaluated after `for`; null means always true. */
  readonly whenFn: Compiled | null;
  readonly effects: readonly EffectDef[];
}

/** Extra per-second drift of one measurement while a status is active. */
export interface StatusRate extends NumberTerm {
  readonly measurement: number;
}

/** A derived entity state (`statuses` domain) with enter/exit conditions. */
export interface StatusDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  /** Which entities can have the status; null means always true. */
  readonly forFn: Compiled | null;
  readonly whenFn: Compiled;
  /** Exit condition (defaults to `not when`). */
  readonly untilFn: Compiled;
  readonly rates: readonly StatusRate[];
}

export interface TintKeyframe {
  /** Minutes since midnight. */
  readonly at: number;
  /** 0xRRGGBB. */
  readonly color: number;
}

/** Resolved `lighting` domain: a day/night tint for renderers (visual only). */
export interface LightingDef {
  /** Non-empty, sorted by `at`, no duplicate times. */
  readonly tint: readonly TintKeyframe[];
}

/** `start.defeat` / `start.victory`: the game ends when `when` (with `self` = player) is truthy. */
export interface OutcomeDef {
  readonly when: Compiled;
  readonly message: string;
}

/** `start.defeat`: the game is lost when `when` holds. */
export type DefeatDef = OutcomeDef;
/** `start.victory`: the game is won when `when` holds. */
export type VictoryDef = OutcomeDef;

export interface Definition {
  readonly ticksPerSecond: number;
  readonly packs: readonly PackInfo[];
  readonly measurements: readonly MeasurementDef[];
  readonly assets: readonly AssetDef[];
  readonly tiles: readonly TileDef[];
  readonly archetypes: readonly ArchetypeDef[];
  readonly maps: readonly MapDef[];
  readonly systems: readonly SystemDef[];
  readonly statuses: readonly StatusDef[];
  readonly items: readonly ItemDef[];
  readonly loot: readonly LootTableDef[];
  readonly behaviors: readonly BehaviorDef[];
  readonly actions: readonly ActionDef[];
  readonly recipes: readonly RecipeDef[];
  readonly distributions: readonly DistributionDef[];
  /** Every room tag used by any map, in first-seen order (room tags are not namespaced). */
  readonly roomTags: readonly string[];
  readonly start: {
    readonly map: number;
    readonly player: number;
    readonly defeat: DefeatDef | null;
    readonly victory: VictoryDef | null;
  };
  /** In-game calendar; engine defaults when no pack defines `clock`. */
  readonly clock: ClockDef;
  /** Day/night tint; null when no pack defines `lighting` (no tint). */
  readonly lighting: LightingDef | null;
  /** Qualified id → index lookups. */
  readonly ids: {
    readonly measurements: Readonly<Record<string, number>>;
    readonly assets: Readonly<Record<string, number>>;
    readonly tiles: Readonly<Record<string, number>>;
    readonly archetypes: Readonly<Record<string, number>>;
    readonly maps: Readonly<Record<string, number>>;
    readonly systems: Readonly<Record<string, number>>;
    readonly statuses: Readonly<Record<string, number>>;
    readonly items: Readonly<Record<string, number>>;
    readonly loot: Readonly<Record<string, number>>;
    readonly behaviors: Readonly<Record<string, number>>;
    readonly actions: Readonly<Record<string, number>>;
    readonly recipes: Readonly<Record<string, number>>;
  };
}
