/**
 * The immutable, fully resolved output of the pack loader. Runtime code trusts
 * it without re-checking: every reference is an index, every expression is a
 * compiled closure, every id is qualified (`ns:id`).
 */

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

export interface TileDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly glyph: string;
  readonly color: string;
  readonly walkable: boolean;
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

export interface Definition {
  readonly ticksPerSecond: number;
  readonly packs: readonly PackInfo[];
  readonly measurements: readonly MeasurementDef[];
  readonly tiles: readonly TileDef[];
  readonly archetypes: readonly ArchetypeDef[];
  readonly maps: readonly MapDef[];
  readonly start: { readonly map: number; readonly player: number };
  /** Qualified id → index lookups. */
  readonly ids: {
    readonly measurements: Readonly<Record<string, number>>;
    readonly tiles: Readonly<Record<string, number>>;
    readonly archetypes: Readonly<Record<string, number>>;
    readonly maps: Readonly<Record<string, number>>;
  };
}
