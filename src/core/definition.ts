/**
 * The immutable, fully resolved output of the pack loader. Runtime code trusts
 * it without re-checking: every reference is an index, every expression is a
 * compiled closure, every id is qualified (`ns:id`).
 */

import type { ClockDef } from './clock.ts';
import type { Compiled } from './expr/index.ts';

export const TICKS_PER_SECOND = 10;

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

/** A single image in a pack (`assets` domain). */
export interface AssetDef {
  readonly id: string;
  readonly index: number;
  /** Namespace of the pack that ships the file. */
  readonly pack: string;
  /** Path relative to the pack root (`.svg` or `.png`). */
  readonly file: string;
  /** Normalized image point placed on the entry's anchor spot; default [0.5, 1]. */
  readonly anchor: readonly [number, number];
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
  /** Asset index, or null for a generated placeholder. */
  readonly sprite: number | null;
  /** Tile tags (separate from archetype tags). */
  readonly tags: readonly string[];
  /** Every map cell with this tile gets its own container; null for none. */
  readonly container: ContainerSpec | null;
}

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

/** `items[].use`: effects run on the user, then `consume` units are removed. */
export interface ItemUseDef {
  /** Verb shown in the UI (default `"Use"`). */
  readonly label: string;
  /** Condition with `self` = the user; null means always. */
  readonly whenFn: Compiled | null;
  readonly effects: readonly EffectDef[];
  /** Units removed per use (0 = reusable). */
  readonly consume: number;
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

/** A map room: a rectangle of cells with room tags. */
export interface RoomDef {
  readonly x: number;
  readonly y: number;
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
  /** Room-set index per cell, row-major. */
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
  /** Asset index, or null for a generated placeholder. */
  readonly sprite: number | null;
  /** Every entity of this archetype gets an inventory; null for none. */
  readonly inventory: InventorySpec | null;
}

export interface SpawnDef {
  readonly x: number;
  readonly y: number;
  readonly archetype: number;
}

export interface MapDef {
  readonly id: string;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** Tile index per cell, row-major. */
  readonly cells: readonly number[];
  readonly spawns: readonly SpawnDef[];
  readonly playerStart: { readonly x: number; readonly y: number } | null;
  readonly rooms: RoomsDef;
}

/** A numeric term: a folded constant, or a closure when `fn` is set. */
export interface NumberTerm {
  readonly constant: number;
  readonly fn: Compiled | null;
}

/** One effect of a system; always acts on `self`. */
export interface EffectDef extends NumberTerm {
  /** `apply` adds the value, `set` replaces the measurement's value. */
  readonly type: 'apply' | 'set';
  readonly measurement: number;
}

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

/** `start.defeat`: the game ends when `when` (with `self` = player) is truthy. */
export interface DefeatDef {
  readonly when: Compiled;
  readonly message: string;
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
  readonly distributions: readonly DistributionDef[];
  /** Every room tag used by any map, in first-seen order (room tags are not namespaced). */
  readonly roomTags: readonly string[];
  readonly start: { readonly map: number; readonly player: number; readonly defeat: DefeatDef | null };
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
  };
}
