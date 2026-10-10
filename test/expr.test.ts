import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO_FACTIONS,
  compile,
  compileSource,
  parse,
  tokenize,
  type CompileSymbols,
  type ExprContext,
  type ExprEntity,
} from '../src/core/expr/index.ts';
import { DEFAULT_CLOCK } from '../src/core/clock.ts';

const IDS: Record<string, number> = { 'a:hp': 0, 'a:mp': 1, 'b:blood': 2 };

const symbols: CompileSymbols = {
  resolveMeasurement(ref) {
    const id = ref.includes(':') ? ref : `a:${ref}`;
    const index = IDS[id];
    return index === undefined ? { error: `unknown measurement '${ref}'` } : { index };
  },
};

function entity(x: number, y: number, m: number[], tags: string[] = [], statuses: number[] = [], z = 0): ExprEntity {
  return { x, y, z, m: Float64Array.from(m), tags: new Set(tags), st: Uint8Array.from(statuses), inv: null, heardTick: -1 };
}

function context(overrides: Partial<ExprContext> = {}): ExprContext & { warnings: string[] } {
  const warnings: string[] = [];
  let s = 42;
  return {
    self: entity(1, 2, [10, 20, 30], ['undead']),
    player: entity(4, 6, [7, 8, 9]),
    tick: 25,
    ticksPerSecond: 10,
    clock: DEFAULT_CLOCK,
    random: () => ((s = (s * 16807) % 2147483647) / 2147483647),
    tileIdAt: (x, y) => (x === 1 && y === 2 ? 't:floor' : 't:wall'),
    tileTagsAt: (x, y) => new Set(x === 1 && y === 2 ? ['shade'] : []),
    inRoom: () => false,
    los: () => true,
    warn: (m) => warnings.push(m),
    entities: [],
    vars: new Float64Array(0),
    questStage: new Int32Array(0),
    questEnd: new Uint8Array(0),
    journalHas: new Uint8Array(0),
    factions: NO_FACTIONS,
    warnings,
    ...overrides,
  };
}

function run(src: string, ctx = context()): unknown {
  const r = compileSource(src, symbols);
  assert.deepEqual(r.errors, [], `unexpected errors for ${src}`);
  return r.expr.fn(ctx);
}

function errorsOf(src: string): string[] {
  return compileSource(src, symbols).errors.map((e) => e.message);
}

test('lexer: qualified ids are single tokens; spaced colons are not', () => {
  const toks = tokenize('self.vamp:blood + 1.5');
  assert.deepEqual(
    toks.map((t) => [t.type, t.value]),
    [
      ['IDENT', 'self'],
      ['DOT', '.'],
      ['IDENT', 'vamp:blood'],
      ['OP', '+'],
      ['NUMBER', '1.5'],
      ['EOF', ''],
    ],
  );
  assert.throws(() => tokenize('self.vamp :blood'), /unexpected character ':'/);
  assert.throws(() => tokenize('"abc'), /unterminated string/);
});

test('parser: precedence and associativity', () => {
  const show = (src: string): string => {
    const s = (n: ReturnType<typeof parse>): string => {
      switch (n.kind) {
        case 'number':
          return String(n.value);
        case 'ident':
          return n.name;
        case 'binary':
          return `(${s(n.left)} ${n.op} ${s(n.right)})`;
        case 'unary':
          return `(${n.op} ${s(n.operand)})`;
        case 'member':
          return `${s(n.object)}.${n.property}`;
        case 'call':
          return `${s(n.callee)}(${n.args.map(s).join(', ')})`;
        default:
          return JSON.stringify(n.value);
      }
    };
    return s(parse(src));
  };
  assert.equal(show('1 + 2 * 3'), '(1 + (2 * 3))');
  assert.equal(show('1 - 2 - 3'), '((1 - 2) - 3)');
  assert.equal(show('-a.x * 2'), '((- a.x) * 2)');
  assert.equal(show('a or b and not c'), '(a or (b and (not c)))');
  assert.equal(show('1 + 2 < 4 and x == 1'), '(((1 + 2) < 4) and (x == 1))');
  assert.equal(show('max(1, 2 + 3)'), 'max(1, (2 + 3))');
  assert.throws(() => parse('1 +'), /unexpected end of expression/);
  assert.throws(() => parse('(1 + 2'), /expected '\)'/);
  assert.throws(() => parse('1 2'), /unexpected '2'/);
});

test('compile: arithmetic, precedence, float division', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('7 / 2'), 3.5);
  assert.equal(run('-7 / 2'), -3.5);
  assert.equal(run('7 % 3'), 1);
  assert.equal(run('2 - -1'), 3);
});

test('compile: member paths resolve to measurement indices', () => {
  assert.equal(run('self.hp'), 10);
  assert.equal(run('self.a:mp'), 20);
  assert.equal(run('self.b:blood / 2'), 15);
  assert.equal(run('player.hp + player.b:blood'), 16);
  assert.equal(run('self.x + self.y * 10'), 21);
  assert.equal(run('tile.id'), 't:floor');
  assert.equal(run('tile.x'), 1);
  assert.equal(run('world.tick'), 25);
  assert.equal(run('world.seconds'), 2.5);
  // Reads the live value at evaluation time (closure over an index).
  const r = compileSource('self.mp', symbols);
  const ctx = context();
  (ctx.self.m as Float64Array)[1] = 99;
  assert.equal(r.expr.fn(ctx), 99);
});

test('compile: world clock fields at a known tick', () => {
  // Defaults: 1 sim second = 1 game minute, start 08:00. Tick 25 = 08:02.5.
  assert.equal(run('world.day'), 1);
  assert.equal(run('world.hour'), 8);
  assert.equal(run('world.minute'), 2);
  assert.ok(Math.abs((run('world.time_of_day') as number) - (8 + 2.5 / 60)) < 1e-12);
  assert.equal(run('world.is_day'), true);
  assert.equal(run('1 + world.is_day'), 2);
  // 16 game hours later (57 600 ticks) it is 00:00:02.5 on day 2: night.
  const night = context({ tick: 25 + 16 * 60 * 10 });
  assert.equal(run('world.day', night), 2);
  assert.equal(run('world.hour', night), 0);
  assert.equal(run('world.minute', night), 2);
  assert.equal(run('world.is_day', night), false);
  assert.equal(run('1 + world.is_day', night), 1);
  // A custom calendar in the context: 10-minute days starting at dusk.
  const custom = context({ tick: 0, clock: { dayLength: 600, start: 20 * 60, dawn: 6 * 60, dusk: 20 * 60 } });
  assert.equal(run('world.is_day', custom), false);
  assert.equal(run('world.hour', custom), 20);
});

test('compile: division and modulo by zero return 0 and warn', () => {
  const ctx = context();
  assert.equal(run('self.hp / (self.mp - 20)', ctx), 0);
  assert.equal(run('5 % 0', ctx), 0);
  assert.deepEqual(ctx.warnings, ['Division by zero', 'Modulo by zero']);
});

test('compile: short-circuit booleans', () => {
  const ctx = context();
  assert.equal(run('false and 1 / 0 > 0', ctx), false);
  assert.equal(run('true or 1 / 0 > 0', ctx), true);
  assert.deepEqual(ctx.warnings, []);
  assert.equal(run('not (1 < 2)'), false);
  assert.equal(run('1 < 2 and 3 >= 3'), true);
  assert.equal(run('0 or 5'), 5);
});

test('compile: built-ins', () => {
  assert.equal(run('min(3, 5) + max(3, 5)'), 8);
  assert.equal(run('clamp(15, 0, 10)'), 10);
  assert.equal(run('abs(-2) + floor(1.7) + ceil(1.2)'), 5);
  assert.equal(run('manhattan(self, player)'), 7);
  assert.equal(run('chebyshev(self, player)'), 4);
  assert.equal(run('euclidean(0, 0, 3, 4)'), 5);
  assert.equal(run('manhattan(tile, player)'), 7);
  // One floor counts as one tile.
  const up = context({ player: entity(4, 6, [7, 8, 9], [], [], 2) });
  assert.equal(run('manhattan(self, player)', up), 9);
  assert.equal(run('chebyshev(self, player)', up), 4);
  assert.equal(run('chebyshev(self, player)', context({ player: entity(1, 2, [0], [], [], 3) })), 3);
  assert.equal(run('euclidean(self, player)', context({ player: entity(1, 2, [0], [], [], 2) })), 2);
  assert.equal(run('self.z + player.z * 10 + tile.z', up), 20);
  assert.equal(run('has_tag(self, "undead")'), true);
  assert.equal(run("self.has_tag('undead')"), true);
  assert.equal(run('player.has_tag("undead")'), false);
  const r = run('random(1, 6)') as number;
  assert.ok(Number.isInteger(r) && r >= 1 && r <= 6);
  const d = run('roll(3, 6)') as number;
  assert.ok(d >= 3 && d <= 18);
});

test('compile: can_see with entities, tiles and an inclusive euclidean range', () => {
  const calls: number[][] = [];
  const ctx = context({
    los: (x0, y0, x1, y1) => {
      calls.push([x0, y0, x1, y1]);
      return x1 !== 9;
    },
  });
  // self (1,2), player (4,6): euclidean distance 5.
  assert.equal(run('can_see(self, player)', ctx), true);
  assert.deepEqual(calls.pop(), [1, 2, 4, 6]);
  assert.equal(run('can_see(tile, player)', ctx), true);
  assert.deepEqual(calls.pop(), [1, 2, 4, 6]);
  assert.equal(run('can_see(player, tile, 5)', ctx), true);
  assert.deepEqual(calls.pop(), [4, 6, 1, 2]);
  // Out of range: false without walking the line.
  assert.equal(run('can_see(self, player, 4.9)', ctx), false);
  assert.equal(calls.length, 0);
  assert.equal(run('can_see(self, player, self.hp)', ctx), true);
  assert.equal(run('1 + can_see(self, player)', ctx), 2);
  assert.equal(run('1 + can_see(self, player, 1)', ctx), 1);
  // The line walk decides once in range.
  const far = context({ player: entity(9, 2, [0, 0, 0]), los: (_a, _b, x1) => x1 !== 9 });
  assert.equal(run('can_see(self, player, 10)', far), false);
  // Across floors: the floors go to the line of sight; with a range, false without walking the line.
  const zs: number[][] = [];
  const upstairs = context({ player: entity(1, 3, [0], [], [], 1), los: (_a, _b, _c, _d, z0, z1) => (zs.push([z0, z1]), z0 === z1) });
  assert.equal(run('can_see(self, player)', upstairs), false);
  assert.deepEqual(zs.pop(), [0, 1]);
  assert.equal(run('can_see(self, player, 10)', upstairs), false);
  assert.equal(zs.length, 0);
});

test('compile: can_see errors are load errors', () => {
  assert.deepEqual(errorsOf('can_see(self)'), ['can_see() takes 2 or 3 arguments, got 1']);
  assert.deepEqual(errorsOf('can_see(self, player, 1, 2)'), ['can_see() takes 2 or 3 arguments, got 4']);
  assert.deepEqual(errorsOf('can_see(self, 3)'), ['can_see(a, b) expects two entities or tiles']);
  assert.deepEqual(errorsOf('can_see(self, player, "far")'), ['can_see(a, b, range) expects a numeric range']);
  assert.deepEqual(errorsOf('can_se(self, player)'), ["unknown function 'can_se' (did you mean 'can_see'?)"]);
  assert.deepEqual(errorsOf('self.can_see(player)'), ['only built-in functions can be called']);
});

test('compile: random/roll use the context RNG (deterministic)', () => {
  const a = compileSource('random(1, 100) + roll(2, 6)', symbols).expr;
  const seq = (): unknown[] => {
    const ctx = context();
    return [a.fn(ctx), a.fn(ctx), a.fn(ctx)];
  };
  assert.deepEqual(seq(), seq());
});

test('compile: numeric constants fold', () => {
  assert.equal(compileSource('-0.8', symbols).expr.constant, -0.8);
  assert.equal(compileSource('1 / 4', symbols).expr.constant, 0.25);
  assert.equal(compileSource('self.hp', symbols).expr.constant, undefined);
});

test('compile errors: unknown identifiers, functions, members, arity, types', () => {
  assert.deepEqual(errorsOf('slef.hp'), ["unknown identifier 'slef' (did you mean 'self'?)"]);
  assert.deepEqual(errorsOf('self.hpp'), ["self.hpp: unknown measurement 'hpp'"]);
  assert.deepEqual(errorsOf('maxx(1, 2)'), ["unknown function 'maxx' (did you mean 'max'?)"]);
  assert.deepEqual(errorsOf('clamp(1, 2)'), ['clamp() takes 3 arguments, got 2']);
  assert.deepEqual(errorsOf('world.tik'), ["unknown property 'world.tik' (did you mean 'world.tick'?)"]);
  assert.deepEqual(errorsOf('world.hours'), ["unknown property 'world.hours' (did you mean 'world.hour'?)"]);
  assert.deepEqual(errorsOf('self + 1'), ["operator '+' expects numbers, got entity and number"]);
  // Collects all errors in one expression.
  assert.equal(errorsOf('foo + bar(1)').length, 2);
  const syntax = compileSource('1 +* 2', symbols);
  assert.equal(syntax.syntax, true);
  assert.match(syntax.errors[0]!.message, /unexpected '\*' at position 3/);
});

test('compile: an AST compiles once and never re-parses', () => {
  const ast = parse('self.hp * 2');
  const { expr } = compile(ast, symbols);
  assert.equal(expr.fn(context()), 20);
  assert.equal(expr.type, 'number');
});
