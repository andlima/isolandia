/**
 * The immutable, fully resolved output of the pack loader. Runtime code trusts
 * it without re-checking: every reference is an index, every expression is a
 * compiled closure, every id is qualified (`ns:id`).
 */

import { DEFAULT_CLOCK, type ClockDef } from './clock.ts';
import { NO_FACTIONS, type Compiled, type ExprContext, type ExprEntity } from './expr/index.ts';
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
  /** Manifest `kind` (`library` when absent): metadata for tools and the title screen. */
  readonly kind: 'game' | 'mod' | 'library';
  /** Manifest `description` (empty when absent). */
  readonly description: string;
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
  /** HUD hints (presentation only: not saved or hashed). */
  readonly hud: MeasurementHud;
}

/** A measurement's `hud` block: which direction is bad and where the warning levels are. */
export interface MeasurementHud {
  /** Which direction is bad; null for a neutral measurement (no levels). */
  readonly bad: 'high' | 'low' | null;
  /** Absolute warn level; null for the default (50 % of `[min, max]` toward the bad end). */
  readonly warn: number | null;
  /** Absolute danger level; null for the default (75 % toward the bad end). */
  readonly danger: number | null;
  /** Kept out of the HUD in both shells. */
  readonly hide: boolean;
}

/** Fractions of `[min, max]` toward the bad end for the default warn and danger levels. */
export const WARN_FRACTION = 0.5;
export const DANGER_FRACTION = 0.75;

/**
 * A measurement's absolute warn and danger levels for a given max (the
 * entity's current one): the explicit `hud` values, else 50 % / 75 % of the
 * way from the good end of `[min, max]` toward the bad end. A default level
 * is null when `max` is not finite; both are null for a neutral measurement.
 */
export function measurementLevels(md: { readonly min: number; readonly hud: MeasurementHud }, max: number): { warn: number | null; danger: number | null } {
  const { bad, warn, danger } = md.hud;
  if (bad === null) return { warn: null, danger: null };
  const at = (fraction: number): number | null => {
    if (!Number.isFinite(max)) return null;
    const span = max - md.min;
    return bad === 'high' ? md.min + fraction * span : max - fraction * span;
  };
  return { warn: warn ?? at(WARN_FRACTION), danger: danger ?? at(DANGER_FRACTION) };
}

export type StatusTone = 'bad' | 'good' | 'neutral';

/** A status's `hud` block (presentation only: not saved or hashed). */
export interface StatusHud {
  readonly tone: StatusTone;
  /** Free tooltip text; empty when absent. */
  readonly description: string;
  /** Message-log text when the player gains the status (default `You are now <Label>.`; empty: silent). */
  readonly enter: string;
  /** Message-log text when the player loses the status (default `You are no longer <Label>.`; empty: silent). */
  readonly exit: string;
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
  /**
   * An edge tile (a thin wall, door, window or fence): it goes on the edge
   * between two cells, never in a cell. `walkable` means it can be crossed,
   * `opaque` that it blocks sight across it.
   */
  readonly edge: boolean;
}

/** Tile index of an empty map cell: no tile, not walkable, not opaque, not drawn. */
export const EMPTY_TILE = 0xffff;

/**
 * The side of a cell an edge is on: `n` (between (x, y-1) and (x, y)) or `w`
 * (between (x-1, y) and (x, y)). A cell's south and east sides are the `n`
 * of the cell below it and the `w` of the cell to its right.
 */
export type EdgeSide = 'n' | 'w';

/** Both edge sides, in storage order. */
export const EDGE_SIDES: readonly EdgeSide[] = ['n', 'w'];

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

/**
 * An activity's `interrupt`: an expression checked every tick after the
 * start (truthy ends the activity as `interrupted`), or an event: the
 * activity ends on the tick its actor hears a noise, after the start tick,
 * when `whenFn` (if any) is truthy.
 */
export type InterruptDef =
  | { readonly kind: 'expr'; readonly fn: Compiled }
  | { readonly kind: 'event'; readonly on: 'noise'; readonly whenFn: Compiled | null };

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
  /** Ends a timed use early (expression or event); null = never. */
  readonly interrupt: InterruptDef | null;
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
  /** Ends the activity early (expression or event); null = never. */
  readonly interrupt: InterruptDef | null;
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
  /** Ends the recipe early (expression or event); null = never. */
  readonly interrupt: InterruptDef | null;
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
  /** Dialogue index of the archetype's conversation (`talk`), or null; ignored on the player. */
  readonly dialogue: number | null;
  /** Faction index the archetype belongs to, or null. */
  readonly faction: number | null;
  /** The archetype's sight sense (`senses.sight`), or null: entities without one never see anything. */
  readonly senses: SenseDef | null;
}

/**
 * A sight sense: a target within `notice` (euclidean, inclusive, tile line
 * of sight, same floor, not concealed) is noticed; a seen target is kept
 * out to `lose`. Ranges squared are precomputed for the hot loop.
 */
export interface SenseDef {
  readonly notice: number;
  readonly lose: number;
  readonly notice2: number;
  readonly lose2: number;
  /** Archetype tags of what the sense looks for: entities whose archetype has any of them. */
  readonly targetTags: readonly string[];
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

/**
 * A behavior-level (any-state) transition: checked before the current
 * state's own, skipped while the entity is in `to` or in a state flagged in
 * `except` (1 at that state's index).
 */
export interface AnyTransitionDef extends TransitionDef {
  readonly except: Uint8Array;
}

/** A declarative state machine (`behaviors` domain). */
export interface BehaviorDef {
  readonly id: string;
  readonly index: number;
  readonly initial: number;
  /** Any-state transitions, in order (see `AnyTransitionDef`). */
  readonly on: readonly AnyTransitionDef[];
  readonly states: readonly BehaviorStateDef[];
}

export interface SpawnDef {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly archetype: number;
}

/**
 * A `populate` entry, resolved to the map it is used in: an entry of a part
 * map is offset by the part's `at` (once per placement). Candidate cells are
 * computed from it (see `populateCandidates`).
 */
export interface PopulateDef {
  readonly archetype: number;
  /** Fixed count, or null for a `density` entry. */
  readonly count: number | null;
  /** Entities per 100 candidate cells, or null for a `count` entry (see `populateCount`). */
  readonly density: number | null;
  /** Compiled `where` filter over the candidate cell (`tile`), or null for all. */
  readonly where: Compiled | null;
  /** Rectangle in this map's coordinates (already clipped to a part's area). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  /** Room tag index, or null for any cell. */
  readonly room: number | null;
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
   * Edge tile on the north side of each cell (`EMPTY_TILE` for none), by cell
   * index; only edge tiles (`TileDef.edge`).
   */
  readonly edgeN: readonly number[];
  /** Edge tile on the west side of each cell, like `edgeN`. */
  readonly edgeW: readonly number[];
  /**
   * Legend `facing` per cell, by cell index; null where the legend does not set
   * one (shown as the default `s`). Render-only: the simulation ignores it.
   */
  readonly facings: readonly (Facing | null)[];
  /** Ordered by `z`, then row-major. */
  readonly spawns: readonly SpawnDef[];
  readonly playerStart: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly rooms: RoomsDef;
  /** Seeded scatter zones, applied in order at world creation (parts first, then the map's own). */
  readonly populate: readonly PopulateDef[];
  /** True for a map composed of part maps (`parts`). */
  readonly composite: boolean;
}

/** An entity no load-time expression reads (populate `where` sees only `tile`). */
const NO_ENTITY: ExprEntity = { x: 0, y: 0, z: 0, m: new Float64Array(0), tags: new Set(), st: new Uint8Array(0), inv: null, heardTick: -1, seen: -1 };

/**
 * Expression context of a populate `where`: `tile` is the cell set by
 * `at()`; there is no world yet, so everything else is inert (the compiler
 * rejects the names that would read it).
 */
function tileContext(map: MapDef, tiles: readonly TileDef[]): { ctx: ExprContext; at(x: number, y: number, z: number): void } {
  const tagSets = new Map<number, ReadonlySet<string>>();
  const tagsOf = (t: number): ReadonlySet<string> => {
    let set = tagSets.get(t);
    if (!set) tagSets.set(t, (set = new Set(tiles[t]?.tags ?? [])));
    return set;
  };
  const target = { x: 0, y: 0, z: 0 };
  const { width, height } = map;
  const index = (x: number, y: number, z: number): number => (x >= 0 && y >= 0 && z >= 0 && x < width && y < height && z < map.floors ? (z * height + y) * width + x : -1);
  const EMPTY: ReadonlySet<string> = new Set();
  const ctx: ExprContext = {
    self: NO_ENTITY,
    player: NO_ENTITY,
    target,
    tick: 0,
    ticksPerSecond: 1,
    clock: DEFAULT_CLOCK,
    random: () => 0,
    tileIdAt: (x, y, z) => {
      const i = index(x, y, z);
      const t = i < 0 ? EMPTY_TILE : map.cells[i]!;
      return t === EMPTY_TILE ? '' : (tiles[t]?.id ?? '');
    },
    tileTagsAt: (x, y, z) => {
      const i = index(x, y, z);
      const t = i < 0 ? EMPTY_TILE : map.cells[i]!;
      return t === EMPTY_TILE ? EMPTY : tagsOf(t);
    },
    inRoom: (x, y, z, tag) => {
      const i = index(x, y, z);
      return i >= 0 && map.rooms.sets[map.rooms.cellSet[i]!]!.includes(tag);
    },
    los: () => false,
    warn: () => {},
    entities: [],
    vars: new Float64Array(0),
    questStage: new Int32Array(0),
    questEnd: new Uint8Array(0),
    journalHas: new Uint8Array(0),
    factions: NO_FACTIONS,
  };
  return {
    ctx,
    at(x, y, z) {
      target.x = x;
      target.y = y;
      target.z = z;
    },
  };
}

/**
 * Candidate cells of a populate entry, ascending cell index: walkable, inside
 * the rect, on its floor, in its room (when set), not a container tile, not
 * the player start, and where the entry's `where` holds. Independent of the
 * seed.
 */
export function populateCandidates(map: MapDef, tiles: readonly TileDef[], p: PopulateDef): number[] {
  const out: number[] = [];
  const { width, height } = map;
  if (p.z < 0 || p.z >= map.floors) return out;
  const start = map.playerStart;
  const sets = map.rooms.sets;
  let inRoom: Uint8Array | null = null;
  if (p.room !== null) {
    inRoom = new Uint8Array(sets.length);
    sets.forEach((set, k) => (inRoom![k] = set.includes(p.room!) ? 1 : 0));
  }
  const where = p.where;
  const scope = where ? tileContext(map, tiles) : null;
  const x1 = Math.min(width, p.x + p.w);
  const y1 = Math.min(height, p.y + p.h);
  for (let y = Math.max(0, p.y); y < y1; y++) {
    for (let x = Math.max(0, p.x); x < x1; x++) {
      const i = (p.z * height + y) * width + x;
      const t = map.cells[i]!;
      if (t === EMPTY_TILE) continue;
      const tile = tiles[t]!;
      if (!tile.walkable || tile.container) continue;
      if (inRoom && inRoom[map.rooms.cellSet[i]!] !== 1) continue;
      if (start && start.x === x && start.y === y && start.z === p.z) continue;
      if (where) {
        scope!.at(x, y, p.z);
        if (!where(scope!.ctx)) continue;
      }
      out.push(i);
    }
  }
  return out;
}

/**
 * Entities a populate entry places: its `count`, or `round(density ×
 * candidates / 100)` for a density entry (0 places nothing). `candidates` is
 * the entry's own candidate count, before earlier entries take cells.
 */
export function populateCount(p: PopulateDef, candidates: number): number {
  return p.count !== null ? p.count : Math.round((p.density! * candidates) / 100);
}

/** What a populate entry places on a map, as checked at load (see `populatePlan`). */
export interface PopulatePlan {
  /** Candidate cells (see `populateCandidates`). */
  readonly candidates: number[];
  /** Entities placed (see `populateCount`). */
  readonly count: number;
  /** Candidates that earlier overlapping entries can take, so `candidates.length - taken` are sure to be free. */
  readonly taken: number;
}

/**
 * Candidates, count and the cells earlier entries may take, for every
 * populate entry of `map` in application order. Shared by the load check,
 * world creation and `check --populate`, so they agree by construction.
 */
export function populatePlan(map: MapDef, tiles: readonly TileDef[]): PopulatePlan[] {
  const plans: PopulatePlan[] = [];
  const mark = new Int32Array(map.cells.length).fill(-1);
  map.populate.forEach((p, k) => {
    const candidates = populateCandidates(map, tiles, p);
    for (const i of candidates) mark[i] = k;
    let taken = 0;
    for (let j = 0; j < k; j++) {
      const q = map.populate[j]!;
      if (q.z !== p.z || q.x >= p.x + p.w || p.x >= q.x + q.w || q.y >= p.y + p.h || p.y >= q.y + q.h) continue;
      let shared = 0;
      for (const i of plans[j]!.candidates) if (mark[i] === k) shared++;
      taken += Math.min(plans[j]!.count, shared);
    }
    plans.push({ candidates, count: populateCount(p, candidates.length), taken });
  });
  return plans;
}

/** A numeric term: a folded constant, or a closure when `fn` is set. */
export interface NumberTerm {
  readonly constant: number;
  readonly fn: Compiled | null;
}

/** A measurement effect; acts on `self`, or on the NPC being talked to with `on: npc` (dialogues only). */
export interface MeasurementEffectDef extends NumberTerm {
  /** `apply` adds the value, `set` replaces the measurement's value. */
  readonly type: 'apply' | 'set';
  readonly measurement: number;
  /** Set (`'npc'`) when the effect acts on the NPC of the open conversation instead of `self`. */
  readonly on?: 'npc';
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

/**
 * Writes a world var (`set_var`) or adds to it (`add_var`), clamped to the
 * var's range. Touches no entity: `self` matters only inside the term.
 */
export interface VarEffectDef extends NumberTerm {
  readonly type: 'set_var' | 'add_var';
  /** Var index. */
  readonly var: number;
}

/** Moves a quest forward to a stage (a no-op for an earlier or equal stage, or an ended quest). */
export interface QuestEffectDef {
  readonly type: 'quest';
  /** Quest index. */
  readonly quest: number;
  /** Stage index within the quest. */
  readonly stage: number;
}

/** Adds a journal entry (a no-op when it is already there). */
export interface JournalEffectDef {
  readonly type: 'journal';
  /** Journal entry index. */
  readonly entry: number;
}

/**
 * Changes the player's standing with a faction by the term (clamped to
 * [-100, 100]); optionally only when a member sees `self`, and optionally
 * spreading to the factions that have a relation to it.
 */
export interface ReputationEffectDef extends NumberTerm {
  readonly type: 'reputation';
  /** Faction index. */
  readonly faction: number;
  /** Euclidean range (tiles, > 0) within which a member must see `self`; null = always applies. */
  readonly witnessed: number | null;
  /** Also change every faction G with `G.relations[faction] = r ≠ 0` by `delta × r / 100` (one step). */
  readonly spread: boolean;
}

/** One effect of a system, item use, action, recipe, quest stage or dialogue. */
export type EffectDef = MeasurementEffectDef | NoiseEffectDef | SetTileEffectDef | VarEffectDef | QuestEffectDef | JournalEffectDef | ReputationEffectDef;

/** Lowest and highest standing and relation. */
export const REPUTATION_MIN = -100;
export const REPUTATION_MAX = 100;

/** A named band of standing: from `from` up to the next tier's `from`. */
export interface FactionTierDef {
  readonly from: number;
  readonly label: string;
}

/** Tiers of a faction without `tiers`. */
export const DEFAULT_TIERS: readonly FactionTierDef[] = [
  { from: -100, label: 'Hostile' },
  { from: -50, label: 'Wary' },
  { from: -10, label: 'Neutral' },
  { from: 10, label: 'Liked' },
  { from: 50, label: 'Trusted' },
];

/** A faction a spread reaches: faction index and its relation to the changed faction. */
export interface SpreadTarget {
  readonly faction: number;
  readonly relation: number;
}

/** A group of archetypes sharing an opinion of the player (`factions` domain). */
export interface FactionDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  /** The player's starting standing, in [-100, 100]. */
  readonly reputation: number;
  /**
   * How this faction regards each faction, by faction index (0 when unset;
   * the entry for itself is unused: members regard each other at 100).
   */
  readonly relations: readonly number[];
  /** `hostile` holds below this attitude. */
  readonly hostileBelow: number;
  /** `friendly` holds from this attitude (> `hostileBelow`). */
  readonly friendlyFrom: number;
  /** Ascending `from`; the first is -100. */
  readonly tiers: readonly FactionTierDef[];
  /** Not shown in the journal's Standing section (and no tier events). */
  readonly hidden: boolean;
  /** Whether any archetype belongs to it (a faction without members never witnesses). */
  readonly members: boolean;
  /** Factions with a non-zero relation to this one, ascending index: where a `spread` change goes. */
  readonly spread: readonly SpreadTarget[];
}

/** Label of the tier `value` falls in. */
export function tierOf(f: FactionDef, value: number): string {
  const tiers = f.tiers;
  let k = 0;
  while (k + 1 < tiers.length && tiers[k + 1]!.from <= value) k++;
  return tiers[k]!.label;
}

/** A world-level number (`vars` domain): one value per world, clamped to `[min, max]` on every write. */
export interface VarDef {
  readonly id: string;
  readonly index: number;
  /** For tools and debugging only; never shown to players. */
  readonly label: string;
  readonly initial: number;
  readonly min: number;
  readonly max: number;
}

/** A one-time journal entry (`journal` domain). */
export interface JournalEntryDef {
  readonly id: string;
  readonly index: number;
  readonly text: string;
  /** Grouping in the journal view (default `Notes`). */
  readonly category: string;
}

/** One stage of a quest. */
export interface QuestStageDef {
  /** Stage id, unique within the quest. */
  readonly name: string;
  readonly index: number;
  /** What the journal shows while the quest is at this stage. */
  readonly journal: string;
  /** Enters the stage automatically (quest phase), with `self` = the player; null = only by a `quest` effect. */
  readonly whenFn: Compiled | null;
  /** Entering this stage ends the quest. */
  readonly end: 'success' | 'failure' | null;
  /** Run once on entering, with `self` = the player. */
  readonly effects: readonly EffectDef[];
}

/** A quest (`quests` domain): ordered stages that only move forward. */
export interface QuestDef {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  /** Not shown in the journal view until it ends. */
  readonly hidden: boolean;
  /** Non-empty; order is also priority order for the quest phase. */
  readonly stages: readonly QuestStageDef[];
  /** Indices of the stages with a `when`, ascending (the quest phase's work list). */
  readonly watched: readonly number[];
}

/** Node index of a dialogue choice's `to: end`: the choice ends the conversation. */
export const DIALOGUE_END = -1;

/** Most choices a dialogue node can show (they are numbered 1–9). */
export const MAX_DIALOGUE_CHOICES = 9;

/** One choice of a dialogue node. Expressions run with `self` = `player` = the player and `npc` = the NPC. */
export interface DialogueChoiceDef {
  readonly text: string;
  /** Node index, or `DIALOGUE_END`. */
  readonly to: number;
  /** Null means always. */
  readonly whenFn: Compiled | null;
  /** Shown (disabled) when `when` is falsy; null hides the choice instead. */
  readonly unavailable: string | null;
  /** Removed from the player when chosen; missing items disable the choice. */
  readonly consume: readonly ItemCount[];
  /** Added to the player when chosen (overflow goes to the ground pile at the player's cell). */
  readonly give: readonly ItemCount[];
  /** Run when chosen, after `consume` and `give`. */
  readonly effects: readonly EffectDef[];
  /** Hidden for good once chosen (world-level, recorded by `id`). */
  readonly once: boolean;
  /** Choice id, unique within the dialogue; `''` when none. */
  readonly id: string;
  /** Synthesized from a node's `next`: choosing it is not a player choice for the loop guard. */
  readonly auto: boolean;
}

/** Who a node's line is from: the NPC's or player's archetype label, or a fixed name. */
export type DialogueSpeaker = { readonly kind: 'npc' | 'player' } | { readonly kind: 'name'; readonly name: string };

/** One node of a dialogue: a line and the choices that answer it. */
export interface DialogueNodeDef {
  readonly name: string;
  readonly index: number;
  readonly speaker: DialogueSpeaker;
  readonly text: string;
  /** Run each time the node is entered. */
  readonly effects: readonly EffectDef[];
  /** Non-empty (`next` and a node without choices are synthesized choices), at most `MAX_DIALOGUE_CHOICES`. */
  readonly choices: readonly DialogueChoiceDef[];
  /** False forbids leaving (Escape) at this node. */
  readonly leave: boolean;
}

/** An entry of a dialogue's `start` list: the first one whose `when` holds picks the opening node. */
export interface DialogueStartDef {
  /** Null means always. */
  readonly whenFn: Compiled | null;
  readonly node: number;
}

/** A conversation tree (`dialogues` domain), attached to archetypes with `dialogue`. */
export interface DialogueDef {
  readonly id: string;
  readonly index: number;
  /** Whether the NPC will talk at all; null means always. */
  readonly whenFn: Compiled | null;
  /** Shown when `when` is falsy, or null for the default. */
  readonly unavailable: string | null;
  readonly start: readonly DialogueStartDef[];
  readonly nodes: readonly DialogueNodeDef[];
}

/**
 * A rule (`systems` domain), run once per matching entity: periodically
 * (`every`), or on an event (`on`): the tick an entity lands on a cell
 * (`step`) or hears a noise (`noise`).
 */
export interface SystemDef {
  readonly id: string;
  readonly index: number;
  /** Event the system fires on, or null for a periodic system. */
  readonly on: 'step' | 'noise' | null;
  /** Period in sim seconds, as written (0 for an event system). */
  readonly every: number;
  /** Period in ticks (≥ 1); fires on ticks where `(tick + 1) % period === 0` (0 for an event system). */
  readonly period: number;
  /** Fire at most once per entity: after its effects run for an entity, never again for it (saved state). */
  readonly once: boolean;
  /** Dense index among the `once` systems (the bit per entity), or -1. */
  readonly onceIndex: number;
  /** Entity filter; null means always true. */
  readonly forFn: Compiled | null;
  /** Set when `for` is exactly `self.has_tag("<tag>")`, so it is decided once per archetype. */
  readonly forTag: string | null;
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
  /** Set when `for` is exactly `self.has_tag("<tag>")`, so it is decided once per archetype. */
  readonly forTag: string | null;
  readonly whenFn: Compiled;
  /** Exit condition (defaults to `not when`). */
  readonly untilFn: Compiled;
  readonly rates: readonly StatusRate[];
  /** While active, no sense notices the entity and a sense that had it loses it. */
  readonly conceals: boolean;
  readonly hud: StatusHud;
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

/** `start.simulation`: scale settings. */
export interface SimulationDef {
  /** Chebyshev tiles from the player beyond which NPCs go dormant; null = never. */
  readonly activeRadius: number | null;
  /** A* node budget of an NPC search. */
  readonly npcPathBudget: number;
  /** A* node budget of the player's searches. */
  readonly playerPathBudget: number;
}

export const DEFAULT_SIMULATION: SimulationDef = { activeRadius: 64, npcPathBudget: 4000, playerPathBudget: 60000 };

/** A domain a mod can patch: a list domain, or a singleton. */
export type PatchDomain =
  | 'measurements'
  | 'assets'
  | 'tiles'
  | 'archetypes'
  | 'maps'
  | 'systems'
  | 'statuses'
  | 'items'
  | 'loot'
  | 'behaviors'
  | 'actions'
  | 'recipes'
  | 'vars'
  | 'quests'
  | 'journal'
  | 'dialogues'
  | 'factions'
  | 'start'
  | 'clock'
  | 'lighting';

/** One applied `override: true` / `remove: true` patch (diagnostic only). */
export interface PatchDef {
  readonly domain: PatchDomain;
  /** Qualified id of the patched entry; null for a singleton. */
  readonly id: string | null;
  /** Namespace of the patching pack. */
  readonly pack: string;
  readonly op: 'override' | 'remove';
  /** Top-level fields the override wrote (`[]` for a removal). */
  readonly fields: readonly string[];
}

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
  readonly vars: readonly VarDef[];
  readonly quests: readonly QuestDef[];
  readonly journal: readonly JournalEntryDef[];
  readonly dialogues: readonly DialogueDef[];
  readonly factions: readonly FactionDef[];
  readonly distributions: readonly DistributionDef[];
  /** Every room tag used by any map, in first-seen order (room tags are not namespaced). */
  readonly roomTags: readonly string[];
  readonly start: {
    readonly map: number;
    readonly player: number;
    readonly defeat: DefeatDef | null;
    readonly victory: VictoryDef | null;
    readonly simulation: SimulationDef;
  };
  /** In-game calendar; engine defaults when no pack defines `clock`. */
  readonly clock: ClockDef;
  /** Day/night tint; null when no pack defines `lighting` (no tint). */
  readonly lighting: LightingDef | null;
  /**
   * Every applied override/removal, in application order. Diagnostic only:
   * not part of snapshots, hashes or saves.
   */
  readonly patches: readonly PatchDef[];
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
    readonly vars: Readonly<Record<string, number>>;
    readonly quests: Readonly<Record<string, number>>;
    readonly journal: Readonly<Record<string, number>>;
    readonly dialogues: Readonly<Record<string, number>>;
    readonly factions: Readonly<Record<string, number>>;
  };
}
