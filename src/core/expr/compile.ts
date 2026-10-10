/**
 * Expression compiler: turns an AST into a closure at load time. The runtime
 * never parses or walks an AST, and member paths such as `self.pack:stamina`
 * are resolved here to a measurement index, so evaluation is `ctx.self.m[7]`.
 */

import { dayAt, isDayAt, minuteOfDay, type ClockDef } from '../clock.ts';
import { countOf, type Container } from '../sim/containers.ts';
import type { Ast } from './parser.ts';

/** An entity as seen by expressions. */
export interface ExprEntity {
  readonly x: number;
  readonly y: number;
  /** Floor. */
  readonly z: number;
  /** Measurement values, indexed by the definition's measurement index. */
  readonly m: Float64Array;
  readonly tags: ReadonlySet<string>;
  /** Active statuses: 1 at a status index when that status is active. */
  readonly st: Uint8Array;
  /** The entity's inventory, or null. */
  readonly inv: Container | null;
  /** Tick at which the entity last heard a noise; -1 = never. */
  readonly heardTick: number;
  /** 1 at each measurement index the entity has; absent means it has every measurement. */
  readonly hasM?: Uint8Array;
  /** In-progress activity (`action` = action index, -1 for an item use); null or absent when idle. */
  readonly activity?: { readonly action: number } | null;
  /** Faction index of the entity's archetype; -1 or absent for none. */
  readonly faction?: number;
  /** Id (index into `ExprContext.entities`) of the entity this one currently sees; -1 or absent for none. */
  readonly seen?: number;
}

/** A tile reference: position, qualified tile id and the tile's tags. */
export interface TileRef {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly id: string;
  readonly tags: ReadonlySet<string>;
}

/** `null` is `none`: the entity value of `seen` when nothing is seen (see `CompiledExpr.nullable`). */
export type Value = number | boolean | string | ExprEntity | TileRef | null;

/** Faction state as seen by expressions (`reputation`, `attitude`, `hostile`, `friendly`). */
export interface FactionTable {
  /** Number of factions. */
  readonly n: number;
  /** The player's standing per faction. */
  readonly rep: Float64Array;
  /** Relations, row = the regarding faction: `rel[f * n + g]` is how f regards g (0 when unset). */
  readonly rel: Float64Array;
  /** Per faction: `hostile` threshold. */
  readonly hostileBelow: Float64Array;
  /** Per faction: `friendly` threshold. */
  readonly friendlyFrom: Float64Array;
}

/** A table with no factions. */
export const NO_FACTIONS: FactionTable = { n: 0, rep: new Float64Array(0), rel: new Float64Array(0), hostileBelow: new Float64Array(0), friendlyFrom: new Float64Array(0) };

/** How `a` regards `b`, in [-100, 100] (the rules of `attitude(a, b)`; the player's own faction plays no part). */
export function attitude(t: FactionTable, player: ExprEntity, a: ExprEntity, b: ExprEntity): number {
  if (a === b) return 100;
  const fb = b.faction ?? -1;
  if (a === player) return fb < 0 ? 0 : t.rep[fb]!;
  const fa = a.faction ?? -1;
  if (fa < 0) return 0;
  if (b === player) return t.rep[fa]!;
  if (fb < 0) return 0;
  return fa === fb ? 100 : t.rel[fa * t.n + fb]!;
}

/** The faction whose thresholds `hostile(a, b)` / `friendly(a, b)` use: `a`'s, or `b`'s when `a` is the player; -1 for none. */
export function regardingFaction(player: ExprEntity, a: ExprEntity, b: ExprEntity): number {
  if (a !== player) return a.faction ?? -1;
  return b === player ? -1 : (b.faction ?? -1);
}

/**
 * Evaluation context. The simulation owns one of these and mutates `self`
 * between evaluations, so evaluating an expression allocates nothing.
 */
export interface ExprContext {
  self: ExprEntity;
  /**
   * Cell that `tile` refers to while a tile-targeted action is evaluated;
   * null or absent means the cell under `self`. With a `side`, `tile` is the
   * edge on that side of the cell (`tile.id` and its tags are the edge's).
   */
  target?: { readonly x: number; readonly y: number; readonly z: number; readonly side?: 'n' | 'w' | null } | null;
  player: ExprEntity;
  /** The NPC being talked to, set only while a dialogue's expressions run (see `CompileSymbols.npc`). */
  npc?: ExprEntity | null;
  tick: number;
  ticksPerSecond: number;
  /** Calendar constants; `world.day`, `world.hour`, … are computed from `tick`. */
  clock: ClockDef;
  /** Seeded RNG returning floats in [0, 1). */
  random(): number;
  /**
   * Qualified id of the tile at (x, y, z), or of its edge on `side` when
   * given; `""` out of bounds or where there is no tile.
   */
  tileIdAt(x: number, y: number, z: number, side?: 'n' | 'w' | null): string;
  /** Tags of the tile at (x, y, z), or of its edge on `side`; empty out of bounds or where there is no tile. */
  tileTagsAt(x: number, y: number, z: number, side?: 'n' | 'w' | null): ReadonlySet<string>;
  /** Whether the cell at (x, y, z) is in a room with the room tag of that index. */
  inRoom(x: number, y: number, z: number, tag: number): boolean;
  /** Tile line of sight between two cells; false across floors (see `lineOfSight`). */
  los(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): boolean;
  warn(message: string): void;
  /** Every entity by id, for `seen` (one array read). */
  entities: readonly ExprEntity[];
  /** World var values, by var index. */
  vars: Float64Array;
  /** Current stage index per quest (-1 = not started); an ended quest keeps its final stage. */
  questStage: Int32Array;
  /** Per quest: 0 = not ended, 1 = ended in success, 2 = ended in failure. */
  questEnd: Uint8Array;
  /** 1 at each journal entry index that has been added. */
  journalHas: Uint8Array;
  /** Standings, relations and thresholds of the factions. */
  factions: FactionTable;
}

export type Compiled = (ctx: ExprContext) => Value;

export type ValueType = 'number' | 'boolean' | 'string' | 'entity' | 'tile' | 'any';

export interface CompiledExpr {
  fn: Compiled;
  type: ValueType;
  /** Set when the expression is a numeric constant. */
  constant?: number;
  /** Set when the expression is exactly `self.has_tag("<tag>")`: it depends only on `self`'s archetype. */
  selfTag?: string;
  /**
   * Set on an entity expression that may evaluate to `none` (`null`) at
   * runtime: one derived from `seen`. Built-ins and members compile a null
   * check only for such operands, so `self.<measurement>` and `player.x` stay plain reads.
   */
  nullable?: boolean;
}

export interface CompileError {
  message: string;
  pos: number;
}

/** Symbol lookups the compiler needs from the loader. */
export interface CompileSymbols {
  /** Resolve a (short or qualified) measurement reference to its index. */
  resolveMeasurement(ref: string): { index: number } | { error: string };
  /** Resolve a status reference to its index; without it, `has_status` is an error. */
  resolveStatus?(ref: string): { index: number } | { error: string };
  /** Resolve an item reference to its index; without it, `count_item`/`has_item` are errors. */
  resolveItem?(ref: string): { index: number } | { error: string };
  /** Resolve a room tag to its index; without it, `in_room` is an error. */
  resolveRoomTag?(tag: string): { index: number } | { error: string };
  /** Resolve an action reference to its index; without it, `doing` is an error. */
  resolveAction?(ref: string): { index: number } | { error: string };
  /** Resolve a var reference to its index; without it, `var` is an error. */
  resolveVar?(ref: string): { index: number } | { error: string };
  /** Resolve a journal entry reference to its index; without it, `in_journal` is an error. */
  resolveEntry?(ref: string): { index: number } | { error: string };
  /** Resolve a quest reference to its index; without it, the `quest_*` built-ins are errors. */
  resolveQuest?(ref: string): { index: number } | { error: string };
  /** Resolve a stage id of a quest (by quest index) to its stage index. */
  resolveStage?(quest: number, stage: string): { index: number } | { error: string };
  /** Resolve a faction reference to its index; without it, the faction built-ins are errors. */
  resolveFaction?(ref: string): { index: number } | { error: string };
  /**
   * Resolve an item tag to a per-item flag (1 at each item index carrying
   * it); without it, `count_tagged`/`has_tagged` are errors. A tag no item
   * carries is the caller's warning, not an error.
   */
  resolveItemTag?(tag: string): { flags: Uint8Array } | { error: string };
  /**
   * Resolve a measurement for `fraction`: its index and its bounds (read at
   * call time, so they may be filled after compilation). A measurement with
   * no `max` is the caller's error.
   */
  resolveBounds?(ref: string): { index: number; bounds(): MeasurementBounds } | { error: string };
  /** Whether `npc` (the NPC being talked to) is in scope: dialogue expressions only. */
  npc?: boolean;
  /**
   * Load-time cell filter (a populate `where`): only `tile` is in scope.
   * `self`, `player`, `npc`, `world`, `random`, `roll` and every built-in that
   * reads an entity or world state are errors naming the field.
   */
  tileOnly?: boolean;
}

/** A measurement's bounds as `fraction` reads them (a `MeasurementDef` fits). */
export interface MeasurementBounds {
  readonly min: number;
  /** Constant upper bound; `Infinity` when unbounded or when `maxFn` is set. */
  readonly maxConst: number;
  /** Per-entity upper bound, evaluated with `self` = the entity. */
  readonly maxFn: Compiled | null;
}

export const SCOPE_NAMES = ['self', 'player', 'tile', 'world'] as const;

interface Builtin {
  min: number;
  max: number;
  /** Validates argument types; returns an error message or null. */
  check?: (types: ValueType[]) => string | null;
  ret: ValueType;
  impl: (args: Value[], ctx: ExprContext) => Value;
  /** The result when an entity argument is `none` (built-ins that take entities). */
  none?: Value;
}

/** An entity closure; `nullable` when it may yield `none` (`null`). */
interface EntityFn {
  fn: (c: ExprContext) => ExprEntity | null;
  nullable: boolean;
}

/** `body` over the entity, or `dflt` when a nullable operand is `none`; plain operands compile no check. */
function guarded(t: EntityFn, dflt: Value, body: (e: ExprEntity, c: ExprContext) => Value): Compiled {
  const f = t.fn;
  if (!t.nullable) return (c) => body(f(c) as ExprEntity, c);
  return (c) => {
    const e = f(c);
    return e === null ? dflt : body(e, c);
  };
}

/** Whether the entity sees a target (`seen` set). */
const sees = (e: ExprEntity): boolean => (e.seen ?? -1) >= 0;
/** The entity's seen entity, or `none`. */
const seenOf = (e: ExprEntity, c: ExprContext): ExprEntity | null => {
  const k = e.seen ?? -1;
  return k < 0 ? null : c.entities[k]!;
};

type Point = { x: number; y: number; z: number };

/** Whether a value of this type has a position (`x`, `y`, `z`). */
export function isPointType(t: ValueType): boolean {
  return t === 'entity' || t === 'tile' || t === 'any';
}

function isNumericType(t: ValueType): boolean {
  return t === 'number' || t === 'boolean' || t === 'any';
}

function allNumeric(name: string) {
  return (types: ValueType[]): string | null =>
    types.every(isNumericType) ? null : `${name}() expects numeric arguments`;
}

function distanceCheck(name: string) {
  return (types: ValueType[]): string | null => {
    if (types.length === 2) return types.every(isPointType) ? null : `${name}(a, b) expects two entities or tiles`;
    if (types.length === 4) return types.every(isNumericType) ? null : `${name}(x1, y1, x2, y2) expects numbers`;
    return `${name}() takes 2 or 4 arguments, got ${types.length}`;
  };
}

/** Coordinate deltas of a distance call; one floor counts as one tile (`dz` is 0 for the 4-number form). */
function deltas(args: Value[]): [number, number, number] {
  if (args.length === 2) {
    const a = args[0] as Point;
    const b = args[1] as Point;
    return [b.x - a.x, b.y - a.y, b.z - a.z];
  }
  return [(args[2] as number) - (args[0] as number), (args[3] as number) - (args[1] as number), 0];
}

const BUILTINS: Record<string, Builtin> = {
  min: { min: 2, max: 2, ret: 'number', check: allNumeric('min'), impl: (a) => Math.min(a[0] as number, a[1] as number) },
  max: { min: 2, max: 2, ret: 'number', check: allNumeric('max'), impl: (a) => Math.max(a[0] as number, a[1] as number) },
  clamp: {
    min: 3,
    max: 3,
    ret: 'number',
    check: allNumeric('clamp'),
    impl: (a) => Math.min(Math.max(a[0] as number, a[1] as number), a[2] as number),
  },
  abs: { min: 1, max: 1, ret: 'number', check: allNumeric('abs'), impl: (a) => Math.abs(a[0] as number) },
  floor: { min: 1, max: 1, ret: 'number', check: allNumeric('floor'), impl: (a) => Math.floor(a[0] as number) },
  ceil: { min: 1, max: 1, ret: 'number', check: allNumeric('ceil'), impl: (a) => Math.ceil(a[0] as number) },
  random: {
    min: 2,
    max: 2,
    ret: 'number',
    check: allNumeric('random'),
    impl: (a, ctx) => {
      const lo = Math.floor(a[0] as number);
      const hi = Math.floor(a[1] as number);
      return lo + Math.floor(ctx.random() * (hi - lo + 1));
    },
  },
  roll: {
    min: 2,
    max: 2,
    ret: 'number',
    check: allNumeric('roll'),
    impl: (a, ctx) => {
      const n = Math.floor(a[0] as number);
      const sides = Math.floor(a[1] as number);
      let total = 0;
      for (let i = 0; i < n; i++) total += 1 + Math.floor(ctx.random() * sides);
      return total;
    },
  },
  manhattan: {
    min: 2,
    max: 4,
    ret: 'number',
    none: Infinity,
    check: distanceCheck('manhattan'),
    impl: (a) => {
      const [dx, dy, dz] = deltas(a);
      return Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    },
  },
  chebyshev: {
    min: 2,
    max: 4,
    ret: 'number',
    none: Infinity,
    check: distanceCheck('chebyshev'),
    impl: (a) => {
      const [dx, dy, dz] = deltas(a);
      return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    },
  },
  euclidean: {
    min: 2,
    max: 4,
    ret: 'number',
    none: Infinity,
    check: distanceCheck('euclidean'),
    impl: (a) => {
      const [dx, dy, dz] = deltas(a);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
  },
  has_tag: {
    min: 2,
    max: 2,
    ret: 'boolean',
    none: false,
    check: (t) =>
      isPointType(t[0]!) && (t[1] === 'string' || t[1] === 'any')
        ? null
        : 'has_tag(x, tag) expects an entity or a tile and a string',
    impl: (a) => (a[0] as ExprEntity | TileRef).tags.has(a[1] as string),
  },
};

/** Built-ins compiled specially (their id argument is resolved at load time). */
const SPECIAL_NAMES = [
  'has_status',
  'count_item',
  'has_item',
  'count_tagged',
  'has_tagged',
  'fraction',
  'in_room',
  'can_see',
  'heard',
  'sees',
  'seen',
  'busy',
  'doing',
  'var',
  'in_journal',
  'quest_active',
  'quest_reached',
  'quest_succeeded',
  'quest_failed',
  'in_faction',
  'reputation',
  'attitude',
  'hostile',
  'friendly',
];

/** Functions that also have a method form: `x.f(a)` ≡ `f(x, a)`. */
const METHODS = new Set(['has_tag', 'has_status', 'count_item', 'has_item', 'count_tagged', 'has_tagged', 'fraction', 'in_room', 'heard', 'sees', 'seen', 'doing', 'in_faction']);

export const BUILTIN_NAMES: readonly string[] = [...Object.keys(BUILTINS), ...SPECIAL_NAMES];

const TILE_FIELDS = ['x', 'y', 'z', 'id'];
/** Entity members other than measurements (`self.<field>`); they take precedence over measurement ids. */
const ENTITY_FIELDS = ['x', 'y', 'z', 'carry_weight', 'carry_capacity', 'busy', 'sees', 'seen'];

/** Cell `tile` refers to: the context's target override, else `self`'s cell (on `self`'s floor). */
const tileX = (c: ExprContext): number => (c.target ? c.target.x : c.self.x);
const tileY = (c: ExprContext): number => (c.target ? c.target.y : c.self.y);
const tileZ = (c: ExprContext): number => (c.target ? c.target.z : c.self.z);
/** Edge side of the target (null for a cell). */
const tileSide = (c: ExprContext): 'n' | 'w' | null => c.target?.side ?? null;
const WORLD_FIELDS = ['tick', 'seconds', 'day', 'hour', 'minute', 'time_of_day', 'is_day'];

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Closest candidate within edit distance 2, if any. */
export function nearMiss(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function hint(name: string, candidates: Iterable<string>): string {
  const s = nearMiss(name, candidates);
  return s ? ` (did you mean '${s}'?)` : '';
}

const fail: CompiledExpr = { fn: () => 0, type: 'any' };

/**
 * Compile an AST. Errors are collected (not thrown) so one expression can
 * report every unknown name at once; if any are returned, the closure must
 * not be used.
 */
export function compile(ast: Ast, symbols: CompileSymbols): { expr: CompiledExpr; errors: CompileError[] } {
  const errors: CompileError[] = [];
  const err = (message: string, pos: number): CompiledExpr => {
    errors.push({ message, pos });
    return fail;
  };

  function entityRoot(name: 'self' | 'player' | 'npc'): (ctx: ExprContext) => ExprEntity {
    return name === 'self' ? (c) => c.self : name === 'player' ? (c) => c.player : (c) => c.npc!;
  }

  const NPC_ONLY = `'npc' is only available in dialogues`;
  /** Error for a name a `tileOnly` expression cannot use. */
  const tileOnly = (name: string): string => `populate 'where' sees only 'tile': '${name}' is not available at load`;

  function member(node: Extract<Ast, { kind: 'member' }>): CompiledExpr {
    const obj = node.object;
    const prop = node.property;
    if (obj.kind !== 'ident') {
      // A member of an entity-valued expression, `self.seen.x`: total on `none`.
      const t = walk(obj);
      if (t === fail) return fail;
      if (t.type !== 'entity' && t.type !== 'any') return err(`property access '.${prop}' is only allowed on an entity or on ${SCOPE_NAMES.join(', ')}`, node.pos);
      return entityMember({ fn: t.fn as EntityFn['fn'], nullable: t.nullable === true }, prop, 'entity', node.pos);
    }
    if (symbols.tileOnly && (obj.name === 'self' || obj.name === 'player' || obj.name === 'npc' || obj.name === 'world')) return err(tileOnly(obj.name), obj.pos);
    switch (obj.name) {
      case 'self':
      case 'player':
      case 'npc': {
        if (obj.name === 'npc' && !symbols.npc) return err(NPC_ONLY, obj.pos);
        const root = entityRoot(obj.name);
        if (!ENTITY_FIELDS.includes(prop)) {
          const r = symbols.resolveMeasurement(prop);
          if ('error' in r) return err(`${obj.name}.${prop}: ${r.error}`, node.pos);
          const idx = r.index;
          if (obj.name === 'npc') return { fn: (c) => c.npc!.m[idx]!, type: 'number' };
          return obj.name === 'self'
            ? { fn: (c) => c.self.m[idx]!, type: 'number' }
            : { fn: (c) => c.player.m[idx]!, type: 'number' };
        }
        return entityMember({ fn: root, nullable: false }, prop, obj.name, node.pos);
      }
      case 'tile':
        if (prop === 'x') return { fn: tileX, type: 'number' };
        if (prop === 'y') return { fn: tileY, type: 'number' };
        if (prop === 'z') return { fn: tileZ, type: 'number' };
        if (prop === 'id') return { fn: (c) => c.tileIdAt(tileX(c), tileY(c), tileZ(c), tileSide(c)), type: 'string' };
        return err(`unknown property 'tile.${prop}'${hint(`tile.${prop}`, TILE_FIELDS.map((f) => `tile.${f}`))}`, node.pos);
      case 'world':
        if (prop === 'tick') return { fn: (c) => c.tick, type: 'number' };
        if (prop === 'seconds') return { fn: (c) => c.tick / c.ticksPerSecond, type: 'number' };
        if (prop === 'day') return { fn: (c) => dayAt(c.clock, c.tick, c.ticksPerSecond), type: 'number' };
        if (prop === 'hour') return { fn: (c) => Math.floor(minuteOfDay(c.clock, c.tick, c.ticksPerSecond) / 60), type: 'number' };
        if (prop === 'minute') return { fn: (c) => Math.floor(minuteOfDay(c.clock, c.tick, c.ticksPerSecond) % 60), type: 'number' };
        if (prop === 'time_of_day') return { fn: (c) => minuteOfDay(c.clock, c.tick, c.ticksPerSecond) / 60, type: 'number' };
        if (prop === 'is_day') return { fn: (c) => isDayAt(c.clock, c.tick, c.ticksPerSecond), type: 'boolean' };
        return err(`unknown property 'world.${prop}'${hint(`world.${prop}`, WORLD_FIELDS.map((f) => `world.${f}`))}`, node.pos);
      default:
        return ident(obj);
    }
  }

  /** `<entity>.<prop>` for the fields of `ENTITY_FIELDS` and measurements; `none` reads `0`, `false` or `none`. */
  function entityMember(t: EntityFn, prop: string, what: string, pos: number): CompiledExpr {
    if (prop === 'x') return { fn: guarded(t, 0, (e) => e.x), type: 'number' };
    if (prop === 'y') return { fn: guarded(t, 0, (e) => e.y), type: 'number' };
    if (prop === 'z') return { fn: guarded(t, 0, (e) => e.z), type: 'number' };
    if (prop === 'carry_weight') return { fn: guarded(t, 0, (e) => (e.inv?.load ?? 0) / 100), type: 'number' };
    if (prop === 'carry_capacity') return { fn: guarded(t, 0, (e) => (e.inv?.capacity ?? 0) / 100), type: 'number' };
    if (prop === 'busy') return { fn: guarded(t, false, (e) => (e.activity ?? null) !== null), type: 'boolean' };
    if (prop === 'sees') return { fn: guarded(t, false, sees), type: 'boolean' };
    if (prop === 'seen') return { fn: guarded(t, null, seenOf), type: 'entity', nullable: true };
    const r = symbols.resolveMeasurement(prop);
    if ('error' in r) return err(`${what}.${prop}: ${r.error}`, pos);
    const idx = r.index;
    return { fn: guarded(t, 0, (e) => e.m[idx]!), type: 'number' };
  }

  function ident(node: Extract<Ast, { kind: 'ident' }>): CompiledExpr {
    if (symbols.tileOnly && (node.name === 'self' || node.name === 'player' || node.name === 'npc' || node.name === 'world')) return err(tileOnly(node.name), node.pos);
    switch (node.name) {
      case 'self':
        return { fn: (c) => c.self, type: 'entity' };
      case 'player':
        return { fn: (c) => c.player, type: 'entity' };
      case 'npc':
        return symbols.npc ? { fn: (c) => c.npc!, type: 'entity' } : err(NPC_ONLY, node.pos);
      case 'tile':
        return {
          fn: (c) => {
            const x = tileX(c);
            const y = tileY(c);
            const z = tileZ(c);
            const side = tileSide(c);
            return { x, y, z, id: c.tileIdAt(x, y, z, side), tags: c.tileTagsAt(x, y, z, side) };
          },
          type: 'tile',
        };
      case 'world':
        return err(`'world' is not a value; use one of ${WORLD_FIELDS.map((f) => `world.${f}`).join(', ')}`, node.pos);
      default:
        return err(`unknown identifier '${node.name}'${hint(node.name, SCOPE_NAMES)}`, node.pos);
    }
  }

  function call(node: Extract<Ast, { kind: 'call' }>): CompiledExpr {
    let name: string;
    let argNodes = node.args;
    if (node.callee.kind === 'ident') {
      name = node.callee.name;
    } else if (node.callee.kind === 'member' && METHODS.has(node.callee.property)) {
      // Method form: `self.has_tag("x")` ≡ `has_tag(self, "x")`.
      name = node.callee.property;
      argNodes = [node.callee.object, ...node.args];
    } else {
      return err('only built-in functions can be called', node.pos);
    }
    // A load-time cell filter: `random`/`roll` and everything that reads an entity or the world are out.
    if (symbols.tileOnly && (name === 'random' || name === 'roll' || (SPECIAL_NAMES.includes(name) && name !== 'in_room'))) return err(tileOnly(name), node.pos);
    if (name === 'has_status') return hasStatus(argNodes, node.pos);
    if (name === 'count_item' || name === 'has_item') return itemCount(name, argNodes, node.pos);
    if (name === 'count_tagged' || name === 'has_tagged') return taggedCount(name, argNodes, node.pos);
    if (name === 'fraction') return fraction(argNodes, node.pos);
    if (name === 'in_room') return inRoom(argNodes, node.pos);
    if (name === 'can_see') return canSee(argNodes, node.pos);
    if (name === 'heard') return heard(argNodes, node.pos);
    if (name === 'sees' || name === 'seen') return sense(name, argNodes, node.pos);
    if (name === 'busy') return busy(argNodes, node.pos);
    if (name === 'doing') return doing(argNodes, node.pos);
    if (name === 'in_faction') return inFaction(argNodes, node.pos);
    if (node.callee.kind === 'ident') {
      if (name === 'var') return worldVar(argNodes, node.pos);
      if (name === 'in_journal') return inJournal(argNodes, node.pos);
      if (name === 'quest_active' || name === 'quest_succeeded' || name === 'quest_failed') return questState(name, argNodes, node.pos);
      if (name === 'quest_reached') return questReached(argNodes, node.pos);
      if (name === 'reputation') return reputation(argNodes, node.pos);
      if (name === 'attitude' || name === 'hostile' || name === 'friendly') return regard(name, argNodes, node.pos);
    }
    if (name === 'has_tag' && argNodes.length === 2) {
      const fast = hasTagFast(argNodes[0]!, argNodes[1]!);
      if (fast) return fast;
    }
    const b = BUILTINS[name];
    if (!b) return err(`unknown function '${name}'${hint(name, BUILTIN_NAMES)}`, node.pos);
    if (argNodes.length < b.min || argNodes.length > b.max) {
      const range = b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`;
      return err(`${name}() takes ${range} arguments, got ${argNodes.length}`, node.pos);
    }
    const before = errors.length;
    const args = argNodes.map(walk);
    if (errors.length > before) return fail;
    const msg = b.check?.(args.map((a) => a.type));
    if (msg) return err(msg, node.pos);
    const fns = args.map((a) => a.fn);
    const impl = b.impl;
    const n = fns.length;
    if (args.some((a) => a.nullable === true)) {
      // An entity argument derived from `seen`: `none` gives the built-in's total value.
      const none = b.none ?? 0;
      return {
        type: b.ret,
        fn: (c) => {
          const vals = new Array<Value>(n);
          for (let i = 0; i < n; i++) if ((vals[i] = fns[i]!(c)) === null) return none;
          return impl(vals, c);
        },
      };
    }
    return {
      type: b.ret,
      fn: (c) => {
        const vals = new Array<Value>(n);
        for (let i = 0; i < n; i++) vals[i] = fns[i]!(c);
        return impl(vals, c);
      },
    };
  }

  /** `has_tag(self|player|tile, "literal")` without allocating a tile or argument array. */
  function hasTagFast(target: Ast, tagNode: Ast): CompiledExpr | null {
    if (target.kind !== 'ident' || tagNode.kind !== 'string') return null;
    const tag = tagNode.value;
    switch (target.name) {
      case 'self':
        return { type: 'boolean', fn: (c) => c.self.tags.has(tag), selfTag: tag };
      case 'player':
        return { type: 'boolean', fn: (c) => c.player.tags.has(tag) };
      case 'tile':
        return { type: 'boolean', fn: (c) => c.tileTagsAt(tileX(c), tileY(c), tileZ(c), tileSide(c)).has(tag) };
      default:
        return null;
    }
  }

  /** `has_status(entity, "id")`: the id is resolved now, so runtime is one array read. */
  function hasStatus(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`has_status() takes 2 arguments, got ${argNodes.length}`, pos);
    const idNode = argNodes[1]!;
    if (idNode.kind !== 'string') return err('has_status() expects a string literal status id, e.g. has_status(self, "stunned")', idNode.pos);
    if (!symbols.resolveStatus) return err('has_status() is not available here', pos);
    const r = symbols.resolveStatus(idNode.value);
    if ('error' in r) return err(`has_status: ${r.error}`, idNode.pos);
    const k = r.index;
    const target = argNodes[0]!;
    if (target.kind === 'ident' && target.name === 'self') return { type: 'boolean', fn: (c) => c.self.st[k] === 1 };
    if (target.kind === 'ident' && target.name === 'player') return { type: 'boolean', fn: (c) => c.player.st[k] === 1 };
    const t = walk(target);
    if (t === fail) return fail;
    if (t.type !== 'entity' && t.type !== 'any') return err(`has_status(entity, id) expects an entity, got ${t.type}`, pos);
    return { type: 'boolean', fn: guarded({ fn: t.fn as EntityFn['fn'], nullable: t.nullable === true }, false, (e) => e.st[k] === 1) };
  }

  /** Entity argument of a special built-in: `self`/`player` without a closure call, else any entity expression (nullable when derived from `seen`). */
  function entityArg(name: string, target: Ast, pos: number, sig = 'entity, id'): EntityFn | null {
    if (target.kind === 'ident' && target.name === 'self') return { fn: (c) => c.self, nullable: false };
    if (target.kind === 'ident' && target.name === 'player') return { fn: (c) => c.player, nullable: false };
    const t = walk(target);
    if (t === fail) return null;
    if (t.type !== 'entity' && t.type !== 'any') {
      err(`${name}(${sig}) expects an entity, got ${t.type}`, pos);
      return null;
    }
    return { fn: t.fn as EntityFn['fn'], nullable: t.nullable === true };
  }

  /** `count_item(entity, "id")` / `has_item(entity, "id")`: the item id is resolved now; runtime scans one inventory. */
  function itemCount(name: 'count_item' | 'has_item', argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`${name}() takes 2 arguments, got ${argNodes.length}`, pos);
    const idNode = argNodes[1]!;
    if (idNode.kind !== 'string') return err(`${name}() expects a string literal item id, e.g. ${name}(self, "bandage")`, idNode.pos);
    if (!symbols.resolveItem) return err(`${name}() is not available here`, pos);
    const r = symbols.resolveItem(idNode.value);
    if ('error' in r) return err(`${name}: ${r.error}`, idNode.pos);
    const k = r.index;
    const target = entityArg(name, argNodes[0]!, pos);
    if (!target) return fail;
    if (name === 'has_item') {
      return {
        type: 'boolean',
        fn: guarded(target, false, (e) => {
          const inv = e.inv;
          return inv !== null && countOf(inv, k) > 0;
        }),
      };
    }
    return {
      type: 'number',
      fn: guarded(target, 0, (e) => {
        const inv = e.inv;
        return inv === null ? 0 : countOf(inv, k);
      }),
    };
  }

  /**
   * `count_tagged(entity, "tag")` / `has_tagged(entity, "tag")`: the tag is
   * resolved now to a per-item flag; runtime scans one inventory's stacks.
   */
  function taggedCount(name: 'count_tagged' | 'has_tagged', argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`${name}() takes 2 arguments, got ${argNodes.length}`, pos);
    const tagNode = argNodes[1]!;
    if (tagNode.kind !== 'string') return err(`${name}() expects a string literal item tag, e.g. ${name}(self, "food")`, tagNode.pos);
    if (!symbols.resolveItemTag) return err(`${name}() is not available here`, pos);
    const r = symbols.resolveItemTag(tagNode.value);
    if ('error' in r) return err(`${name}: ${r.error}`, tagNode.pos);
    const flags = r.flags;
    const target = entityArg(name, argNodes[0]!, pos, 'entity, tag');
    if (!target) return fail;
    if (name === 'has_tagged') {
      return {
        type: 'boolean',
        fn: guarded(target, false, (e) => {
          const inv = e.inv;
          if (inv === null) return false;
          const st = inv.stacks;
          for (let i = 0; i < st.length; i++) if (flags[st[i]!.item] === 1 && st[i]!.count > 0) return true;
          return false;
        }),
      };
    }
    return {
      type: 'number',
      fn: guarded(target, 0, (e) => {
        const inv = e.inv;
        if (inv === null) return 0;
        const st = inv.stacks;
        let n = 0;
        for (let i = 0; i < st.length; i++) if (flags[st[i]!.item] === 1) n += st[i]!.count;
        return n;
      }),
    };
  }

  /**
   * `fraction(entity, "measurement")`: `(value − min) / (max − min)` in
   * [0, 1]; 0 when the entity lacks the measurement or its resolved max is
   * not finite or not above min. A per-entity `max` is evaluated for that
   * entity (with `self` swapped in and back; nothing is allocated).
   */
  function fraction(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`fraction() takes 2 arguments, got ${argNodes.length}`, pos);
    const idNode = argNodes[1]!;
    if (idNode.kind !== 'string') return err('fraction() expects a string literal measurement id, e.g. fraction(self, "energy")', idNode.pos);
    if (!symbols.resolveBounds) return err('fraction() is not available here', pos);
    const r = symbols.resolveBounds(idNode.value);
    if ('error' in r) return err(`fraction: ${r.error}`, idNode.pos);
    const k = r.index;
    const bounds = r.bounds;
    const target = entityArg('fraction', argNodes[0]!, pos, 'entity, measurement');
    if (!target) return fail;
    return {
      type: 'number',
      fn: guarded(target, 0, (e, c) => {
        const has = e.hasM;
        if (has !== undefined && has[k] !== 1) return 0;
        const b = bounds();
        const min = b.min;
        let max: number;
        if (b.maxFn === null) max = b.maxConst;
        else if (e === c.self) max = Number(b.maxFn(c));
        else {
          const saved = c.self;
          c.self = e;
          max = Number(b.maxFn(c));
          c.self = saved;
        }
        if (!(max > min) || max === Infinity) return 0;
        const v = (e.m[k]! - min) / (max - min);
        return v < 0 ? 0 : v > 1 ? 1 : v;
      }),
    };
  }

  /** `busy(entity)`: the entity has an in-progress activity. */
  function busy(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 1) return err(`busy() takes 1 argument, got ${argNodes.length}`, pos);
    const target = entityArg('busy', argNodes[0]!, pos, 'entity');
    if (!target) return fail;
    return { type: 'boolean', fn: guarded(target, false, (e) => (e.activity ?? null) !== null) };
  }

  /** `sees(entity)` / `seen(entity)` (and the method forms): one read of the entity's `seen`; `seen` may be `none`. */
  function sense(name: 'sees' | 'seen', argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 1) return err(`${name}() takes 1 argument, got ${argNodes.length}`, pos);
    const target = entityArg(name, argNodes[0]!, pos, 'entity');
    if (!target) return fail;
    if (name === 'sees') return { type: 'boolean', fn: guarded(target, false, sees) };
    return { type: 'entity', nullable: true, fn: guarded(target, null, seenOf) };
  }

  /** `doing(entity, "action")`: the action id is resolved now, so runtime is one comparison. */
  function doing(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`doing() takes 2 arguments, got ${argNodes.length}`, pos);
    const idNode = argNodes[1]!;
    if (idNode.kind !== 'string') return err('doing() expects a string literal action id, e.g. doing(self, "rest")', idNode.pos);
    if (!symbols.resolveAction) return err('doing() is not available here', pos);
    const r = symbols.resolveAction(idNode.value);
    if ('error' in r) return err(`doing: ${r.error}`, idNode.pos);
    const k = r.index;
    const target = entityArg('doing', argNodes[0]!, pos);
    if (!target) return fail;
    return {
      type: 'boolean',
      fn: guarded(target, false, (e) => {
        const a = e.activity;
        return a !== undefined && a !== null && a.action === k;
      }),
    };
  }

  /** The string literal id argument of a world built-in, resolved now; null after reporting. */
  function literalId(
    name: string,
    node: Ast,
    what: string,
    example: string,
    resolve: ((ref: string) => { index: number } | { error: string }) | undefined,
  ): number | null {
    if (node.kind !== 'string') {
      err(`${name}() expects a string literal ${what} id, e.g. ${example}`, node.pos);
      return null;
    }
    if (!resolve) {
      err(`${name}() is not available here`, node.pos);
      return null;
    }
    const r = resolve(node.value);
    if ('error' in r) {
      err(`${name}: ${r.error}`, node.pos);
      return null;
    }
    return r.index;
  }

  /** `var("id")`: the var's current value; runtime is one array read. */
  function worldVar(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 1) return err(`var() takes 1 argument, got ${argNodes.length}`, pos);
    const k = literalId('var', argNodes[0]!, 'var', 'var("clues_found")', symbols.resolveVar);
    if (k === null) return fail;
    return { type: 'number', fn: (c) => c.vars[k]! };
  }

  /** `in_journal("id")`: whether the entry has been added. */
  function inJournal(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 1) return err(`in_journal() takes 1 argument, got ${argNodes.length}`, pos);
    const k = literalId('in_journal', argNodes[0]!, 'journal entry', 'in_journal("torn_letter")', symbols.resolveEntry);
    if (k === null) return fail;
    return { type: 'boolean', fn: (c) => c.journalHas[k] === 1 };
  }

  /** `quest_active("q")` (started, not ended), `quest_succeeded("q")`, `quest_failed("q")`. */
  function questState(name: 'quest_active' | 'quest_succeeded' | 'quest_failed', argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 1) return err(`${name}() takes 1 argument, got ${argNodes.length}`, pos);
    const k = literalId(name, argNodes[0]!, 'quest', `${name}("escape")`, symbols.resolveQuest);
    if (k === null) return fail;
    if (name === 'quest_active') return { type: 'boolean', fn: (c) => c.questStage[k]! >= 0 && c.questEnd[k] === 0 };
    const want = name === 'quest_succeeded' ? 1 : 2;
    return { type: 'boolean', fn: (c) => c.questEnd[k] === want };
  }

  /** `quest_reached("q", "stage")`: the quest's stage index is that stage's or higher (positional). */
  function questReached(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`quest_reached() takes 2 arguments, got ${argNodes.length}`, pos);
    const q = literalId('quest_reached', argNodes[0]!, 'quest', 'quest_reached("escape", "battery")', symbols.resolveQuest);
    if (q === null) return fail;
    const resolveStage = symbols.resolveStage;
    const s = literalId('quest_reached', argNodes[1]!, 'stage', 'quest_reached("escape", "battery")', resolveStage && ((ref) => resolveStage(q, ref)));
    if (s === null) return fail;
    return { type: 'boolean', fn: (c) => c.questStage[q]! >= s };
  }

  /** `in_faction(entity, "f")` / `self.in_faction("f")`: one read of the archetype's faction index. */
  function inFaction(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`in_faction() takes 2 arguments, got ${argNodes.length}`, pos);
    const k = literalId('in_faction', argNodes[1]!, 'faction', 'in_faction(self, "police")', symbols.resolveFaction);
    if (k === null) return fail;
    const target = entityArg('in_faction', argNodes[0]!, pos, 'entity, faction');
    if (!target) return fail;
    return { type: 'boolean', fn: guarded(target, false, (e) => e.faction === k) };
  }

  /** `reputation("f")`: the player's standing with the faction; one array read. */
  function reputation(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 1) return err(`reputation() takes 1 argument, got ${argNodes.length}`, pos);
    const k = literalId('reputation', argNodes[0]!, 'faction', 'reputation("police")', symbols.resolveFaction);
    if (k === null) return fail;
    return { type: 'number', fn: (c) => c.factions.rep[k]! };
  }

  /** `attitude(a, b)`, `hostile(a, b)`, `friendly(a, b)`: entity arguments, at most two array reads. */
  function regard(name: 'attitude' | 'hostile' | 'friendly', argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`${name}() takes 2 arguments, got ${argNodes.length}`, pos);
    const before = errors.length;
    const A = entityArg(name, argNodes[0]!, pos, 'a, b');
    const B = entityArg(name, argNodes[1]!, pos, 'a, b');
    if (errors.length > before || !A || !B) return fail;
    const fa = A.fn;
    const fb = B.fn;
    // `none` on either side: attitude 0, neither hostile nor friendly.
    const nullable = A.nullable || B.nullable;
    if (name === 'attitude') {
      return {
        type: 'number',
        fn: nullable
          ? (c) => {
              const a = fa(c);
              const b = fb(c);
              return a === null || b === null ? 0 : attitude(c.factions, c.player, a, b);
            }
          : (c) => attitude(c.factions, c.player, fa(c)!, fb(c)!),
      };
    }
    const hostile = name === 'hostile';
    return {
      type: 'boolean',
      fn: (c) => {
        const a = fa(c);
        const b = fb(c);
        if (nullable && (a === null || b === null)) return false;
        const f = regardingFaction(c.player, a!, b!);
        if (f < 0) return false;
        const v = attitude(c.factions, c.player, a!, b!);
        return hostile ? v < c.factions.hostileBelow[f]! : v >= c.factions.friendlyFrom[f]!;
      },
    };
  }

  /** `in_room(tile, "tag")` / `tile.in_room("tag")`: room tags of the cell `tile` refers to. */
  function inRoom(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`in_room() takes 2 arguments, got ${argNodes.length}`, pos);
    const target = argNodes[0]!;
    if (target.kind !== 'ident' || target.name !== 'tile') return err('in_room(tile, tag) expects `tile` as its first argument', pos);
    const tagNode = argNodes[1]!;
    if (tagNode.kind !== 'string') return err('in_room() expects a string literal room tag, e.g. tile.in_room("kitchen")', tagNode.pos);
    if (!symbols.resolveRoomTag) return err('in_room() is not available here', pos);
    const r = symbols.resolveRoomTag(tagNode.value);
    if ('error' in r) return err(`in_room: ${r.error}`, tagNode.pos);
    const k = r.index;
    return { type: 'boolean', fn: (c) => c.inRoom(tileX(c), tileY(c), tileZ(c), k) };
  }

  /** Point argument without allocating: `tile` reads as the target cell, or `self` (same position) without one. */
  function pointArg(node: Ast): CompiledExpr {
    if (node.kind === 'ident' && node.name === 'self') return { type: 'entity', fn: (c) => c.self };
    if (node.kind === 'ident' && node.name === 'tile') return { type: 'tile', fn: (c) => (c.target ?? c.self) as ExprEntity };
    if (node.kind === 'ident' && node.name === 'player') return { type: 'entity', fn: (c) => c.player };
    return walk(node);
  }

  /** `can_see(a, b[, range])`: euclidean range check first, then tile line of sight (false across floors); no argument array. */
  function canSee(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2 && argNodes.length !== 3) return err(`can_see() takes 2 or 3 arguments, got ${argNodes.length}`, pos);
    const before = errors.length;
    const a = pointArg(argNodes[0]!);
    const b = pointArg(argNodes[1]!);
    const r = argNodes.length === 3 ? walk(argNodes[2]!) : null;
    if (errors.length > before) return fail;
    if (!isPointType(a.type) || !isPointType(b.type)) return err('can_see(a, b) expects two entities or tiles', pos);
    if (r && !isNumericType(r.type)) return err('can_see(a, b, range) expects a numeric range', pos);
    const A = a.fn as (c: ExprContext) => Point | null;
    const B = b.fn as (c: ExprContext) => Point | null;
    // `none` (a `seen` operand) is never seen; plain operands compile no check.
    const nullable = a.nullable === true || b.nullable === true;
    if (!r) {
      return {
        type: 'boolean',
        fn: (c) => {
          const p = A(c);
          const q = B(c);
          if (nullable && (p === null || q === null)) return false;
          return c.los(p!.x, p!.y, q!.x, q!.y, p!.z, q!.z);
        },
      };
    }
    const R = r.fn as (c: ExprContext) => number;
    return {
      type: 'boolean',
      fn: (c) => {
        const p = A(c);
        const q = B(c);
        if (nullable && (p === null || q === null)) return false;
        if (p!.z !== q!.z) return false;
        const dx = q!.x - p!.x;
        const dy = q!.y - p!.y;
        if (Math.sqrt(dx * dx + dy * dy) > Number(R(c))) return false;
        return c.los(p!.x, p!.y, q!.x, q!.y, p!.z, q!.z);
      },
    };
  }

  /** `heard(entity, seconds)`: the entity heard a noise less than `seconds` ago; no argument array. */
  function heard(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`heard() takes 2 arguments, got ${argNodes.length}`, pos);
    const before = errors.length;
    const target = entityArg('heard', argNodes[0]!, pos, 'entity, seconds');
    const s = walk(argNodes[1]!);
    if (errors.length > before || !target) return fail;
    if (!isNumericType(s.type)) return err('heard(entity, seconds) expects numeric seconds', pos);
    const S = s.fn as (c: ExprContext) => number;
    return {
      type: 'boolean',
      fn: guarded(target, false, (e, c) => {
        const t = e.heardTick;
        return t >= 0 && c.tick - t < Number(S(c)) * c.ticksPerSecond;
      }),
    };
  }

  function binary(node: Extract<Ast, { kind: 'binary' }>): CompiledExpr {
    const l = walk(node.left);
    const r = walk(node.right);
    if (l === fail || r === fail) return fail;
    const lf = l.fn;
    const rf = r.fn;
    const op = node.op;
    if (op === 'and') return { type: l.type === r.type ? l.type : 'any', fn: (c) => lf(c) && rf(c) };
    if (op === 'or') return { type: l.type === r.type ? l.type : 'any', fn: (c) => lf(c) || rf(c) };
    if (op === '==' || op === '!=') {
      return op === '==' ? { type: 'boolean', fn: (c) => lf(c) === rf(c) } : { type: 'boolean', fn: (c) => lf(c) !== rf(c) };
    }
    if (!isNumericType(l.type) || !isNumericType(r.type)) {
      return err(`operator '${op}' expects numbers, got ${l.type} and ${r.type}`, node.pos);
    }
    const L = lf as (c: ExprContext) => number;
    const R = rf as (c: ExprContext) => number;
    let out: CompiledExpr;
    switch (op) {
      case '+': out = { type: 'number', fn: (c) => L(c) + R(c) }; break;
      case '-': out = { type: 'number', fn: (c) => L(c) - R(c) }; break;
      case '*': out = { type: 'number', fn: (c) => L(c) * R(c) }; break;
      case '/':
        out = {
          type: 'number',
          fn: (c) => {
            const d = R(c);
            if (d === 0) {
              c.warn('Division by zero');
              return 0;
            }
            return L(c) / d;
          },
        };
        break;
      case '%':
        out = {
          type: 'number',
          fn: (c) => {
            const d = R(c);
            if (d === 0) {
              c.warn('Modulo by zero');
              return 0;
            }
            return L(c) % d;
          },
        };
        break;
      case '<': out = { type: 'boolean', fn: (c) => L(c) < R(c) }; break;
      case '<=': out = { type: 'boolean', fn: (c) => L(c) <= R(c) }; break;
      case '>': out = { type: 'boolean', fn: (c) => L(c) > R(c) }; break;
      case '>=': out = { type: 'boolean', fn: (c) => L(c) >= R(c) }; break;
    }
    // Fold constant arithmetic (e.g. `-1 / 2`); skip when it would warn.
    if (l.constant !== undefined && r.constant !== undefined && out.type === 'number' && !((op === '/' || op === '%') && r.constant === 0)) {
      const v = out.fn(undefined as unknown as ExprContext) as number;
      return { type: 'number', fn: () => v, constant: v };
    }
    return out;
  }

  function walk(node: Ast): CompiledExpr {
    switch (node.kind) {
      case 'number': {
        const v = node.value;
        return { fn: () => v, type: 'number', constant: v };
      }
      case 'string': {
        const v = node.value;
        return { fn: () => v, type: 'string' };
      }
      case 'boolean': {
        const v = node.value;
        return { fn: () => v, type: 'boolean' };
      }
      case 'ident':
        return ident(node);
      case 'member':
        return member(node);
      case 'call':
        return call(node);
      case 'binary':
        return binary(node);
      case 'unary': {
        const o = walk(node.operand);
        if (o === fail) return fail;
        const f = o.fn;
        if (node.op === 'not') return { type: 'boolean', fn: (c) => !f(c) };
        if (!isNumericType(o.type)) return err(`unary '-' expects a number, got ${o.type}`, node.pos);
        if (o.constant !== undefined) {
          const v = -o.constant;
          return { fn: () => v, type: 'number', constant: v };
        }
        return { type: 'number', fn: (c) => -(f(c) as number) };
      }
    }
  }

  const expr = walk(ast);
  return { expr, errors };
}
