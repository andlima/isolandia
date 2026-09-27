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
  };
}
