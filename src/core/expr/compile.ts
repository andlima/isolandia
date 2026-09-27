/**
 * Expression compiler: turns an AST into a closure at load time. The runtime
 * never parses or walks an AST, and member paths such as `self.pack:stamina`
 * are resolved here to a measurement index, so evaluation is `ctx.self.m[7]`.
 */

import { dayAt, isDayAt, minuteOfDay, type ClockDef } from '../clock.ts';
import type { Ast } from './parser.ts';

/** An entity as seen by expressions. */
export interface ExprEntity {
  readonly x: number;
  readonly y: number;
  /** Measurement values, indexed by the definition's measurement index. */
  readonly m: Float64Array;
  readonly tags: ReadonlySet<string>;
  /** Active statuses: 1 at a status index when that status is active. */
  readonly st: Uint8Array;
}

/** A tile reference: position, qualified tile id and the tile's tags. */
export interface TileRef {
  readonly x: number;
  readonly y: number;
  readonly id: string;
  readonly tags: ReadonlySet<string>;
}

export type Value = number | boolean | string | ExprEntity | TileRef;

/**
 * Evaluation context. The simulation owns one of these and mutates `self`
 * between evaluations, so evaluating an expression allocates nothing.
 */
export interface ExprContext {
  self: ExprEntity;
  player: ExprEntity;
  tick: number;
  ticksPerSecond: number;
  /** Calendar constants; `world.day`, `world.hour`, … are computed from `tick`. */
  clock: ClockDef;
  /** Seeded RNG returning floats in [0, 1). */
  random(): number;
  tileIdAt(x: number, y: number): string;
  /** Tags of the tile at (x, y); empty out of bounds. */
  tileTagsAt(x: number, y: number): ReadonlySet<string>;
  warn(message: string): void;
}

export type Compiled = (ctx: ExprContext) => Value;

export type ValueType = 'number' | 'boolean' | 'string' | 'entity' | 'tile' | 'any';

export interface CompiledExpr {
  fn: Compiled;
  type: ValueType;
  /** Set when the expression is a numeric constant. */
  constant?: number;
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
}

export const SCOPE_NAMES = ['self', 'player', 'tile', 'world'] as const;

interface Builtin {
  min: number;
  max: number;
  /** Validates argument types; returns an error message or null. */
  check?: (types: ValueType[]) => string | null;
  ret: ValueType;
  impl: (args: Value[], ctx: ExprContext) => Value;
}

type Point = { x: number; y: number };

function isPointType(t: ValueType): boolean {
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

function deltas(args: Value[]): [number, number] {
  if (args.length === 2) {
    const a = args[0] as Point;
    const b = args[1] as Point;
    return [b.x - a.x, b.y - a.y];
  }
  return [(args[2] as number) - (args[0] as number), (args[3] as number) - (args[1] as number)];
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
    check: distanceCheck('manhattan'),
    impl: (a) => {
      const [dx, dy] = deltas(a);
      return Math.abs(dx) + Math.abs(dy);
    },
  },
  chebyshev: {
    min: 2,
    max: 4,
    ret: 'number',
    check: distanceCheck('chebyshev'),
    impl: (a) => {
      const [dx, dy] = deltas(a);
      return Math.max(Math.abs(dx), Math.abs(dy));
    },
  },
  euclidean: {
    min: 2,
    max: 4,
    ret: 'number',
    check: distanceCheck('euclidean'),
    impl: (a) => {
      const [dx, dy] = deltas(a);
      return Math.sqrt(dx * dx + dy * dy);
    },
  },
  has_tag: {
    min: 2,
    max: 2,
    ret: 'boolean',
    check: (t) =>
      isPointType(t[0]!) && (t[1] === 'string' || t[1] === 'any')
        ? null
        : 'has_tag(x, tag) expects an entity or a tile and a string',
    impl: (a) => (a[0] as ExprEntity | TileRef).tags.has(a[1] as string),
  },
};

/** Built-ins compiled specially (their id argument is resolved at load time). */
const SPECIAL_NAMES = ['has_status'];

/** Functions that also have a method form: `x.f(a)` ≡ `f(x, a)`. */
const METHODS = new Set(['has_tag', 'has_status']);

export const BUILTIN_NAMES: readonly string[] = [...Object.keys(BUILTINS), ...SPECIAL_NAMES];

const TILE_FIELDS = ['x', 'y', 'id'];
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

  function entityRoot(name: 'self' | 'player'): (ctx: ExprContext) => ExprEntity {
    return name === 'self' ? (c) => c.self : (c) => c.player;
  }

  function member(node: Extract<Ast, { kind: 'member' }>): CompiledExpr {
    const obj = node.object;
    if (obj.kind !== 'ident') return err(`property access '.${node.property}' is only allowed on ${SCOPE_NAMES.join(', ')}`, node.pos);
    const prop = node.property;
    switch (obj.name) {
      case 'self':
      case 'player': {
        const root = entityRoot(obj.name);
        if (prop === 'x') return { fn: (c) => root(c).x, type: 'number' };
        if (prop === 'y') return { fn: (c) => root(c).y, type: 'number' };
        const r = symbols.resolveMeasurement(prop);
        if ('error' in r) return err(`${obj.name}.${prop}: ${r.error}`, node.pos);
        const idx = r.index;
        return obj.name === 'self'
          ? { fn: (c) => c.self.m[idx]!, type: 'number' }
          : { fn: (c) => c.player.m[idx]!, type: 'number' };
      }
      case 'tile':
        if (prop === 'x') return { fn: (c) => c.self.x, type: 'number' };
        if (prop === 'y') return { fn: (c) => c.self.y, type: 'number' };
        if (prop === 'id') return { fn: (c) => c.tileIdAt(c.self.x, c.self.y), type: 'string' };
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

  function ident(node: Extract<Ast, { kind: 'ident' }>): CompiledExpr {
    switch (node.name) {
      case 'self':
        return { fn: (c) => c.self, type: 'entity' };
      case 'player':
        return { fn: (c) => c.player, type: 'entity' };
      case 'tile':
        return {
          fn: (c) => ({ x: c.self.x, y: c.self.y, id: c.tileIdAt(c.self.x, c.self.y), tags: c.tileTagsAt(c.self.x, c.self.y) }),
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
    if (name === 'has_status') return hasStatus(argNodes, node.pos);
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
        return { type: 'boolean', fn: (c) => c.self.tags.has(tag) };
      case 'player':
        return { type: 'boolean', fn: (c) => c.player.tags.has(tag) };
      case 'tile':
        return { type: 'boolean', fn: (c) => c.tileTagsAt(c.self.x, c.self.y).has(tag) };
      default:
        return null;
    }
  }

  /** `has_status(entity, "id")`: the id is resolved now, so runtime is one array read. */
  function hasStatus(argNodes: Ast[], pos: number): CompiledExpr {
    if (argNodes.length !== 2) return err(`has_status() takes 2 arguments, got ${argNodes.length}`, pos);
    const idNode = argNodes[1]!;
    if (idNode.kind !== 'string') return err('has_status() expects a string literal status id, e.g. has_status(self, "hungry")', idNode.pos);
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
    const f = t.fn;
    return { type: 'boolean', fn: (c) => (f(c) as ExprEntity).st[k] === 1 };
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
