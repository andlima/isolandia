export { tokenize, ExprSyntaxError, type Token } from './lexer.ts';
export { parse, type Ast } from './parser.ts';
export {
  compile,
  levenshtein,
  nearMiss,
  isPointType,
  BUILTIN_NAMES,
  SCOPE_NAMES,
  NO_FACTIONS,
  attitude,
  regardingFaction,
  type FactionTable,
  type Compiled,
  type CompiledExpr,
  type CompileError,
  type CompileSymbols,
  type ExprContext,
  type ExprEntity,
  type MeasurementBounds,
  type TileRef,
  type Value,
  type ValueType,
} from './compile.ts';

import { compile, type CompiledExpr, type CompileError, type CompileSymbols } from './compile.ts';
import { ExprSyntaxError } from './lexer.ts';
import { parse } from './parser.ts';

/** Parse + compile in one step; syntax errors are returned, not thrown. */
export function compileSource(
  source: string,
  symbols: CompileSymbols,
): { expr: CompiledExpr; errors: CompileError[]; syntax: boolean } {
  try {
    return { ...compile(parse(source), symbols), syntax: false };
  } catch (e) {
    if (e instanceof ExprSyntaxError) {
      return { expr: { fn: () => 0, type: 'any' }, errors: [{ message: e.message, pos: e.pos }], syntax: true };
    }
    throw e;
  }
}
