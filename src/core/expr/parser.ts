/**
 * Recursive-descent parser for the expression language.
 *
 *   expr        = or_expr
 *   or_expr     = and_expr ("or" and_expr)*
 *   and_expr    = not_expr ("and" not_expr)*
 *   not_expr    = "not" not_expr | comparison
 *   comparison  = addition (("==" | "!=" | "<=" | ">=" | "<" | ">") addition)?
 *   addition    = multiply (("+" | "-") multiply)*
 *   multiply    = unary (("*" | "/" | "%") unary)*
 *   unary       = "-" unary | postfix
 *   postfix     = primary ( "(" args ")" | "." IDENT )*
 *   primary     = NUMBER | STRING | "true" | "false" | IDENT | "(" expr ")"
 */

import { ExprSyntaxError, tokenize, type Token, type TokenType } from './lexer.ts';

export type BinaryOp = 'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

export type Ast =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'boolean'; value: boolean; pos: number }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'unary'; op: '-' | 'not'; operand: Ast; pos: number }
  | { kind: 'binary'; op: BinaryOp; left: Ast; right: Ast; pos: number }
  | { kind: 'call'; callee: Ast; args: Ast[]; pos: number }
  | { kind: 'member'; object: Ast; property: string; pos: number };

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.i]!;
  }

  private advance(): Token {
    return this.tokens[this.i++]!;
  }

  private match(type: TokenType, value?: string): Token | null {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) return this.advance();
    return null;
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) throw new ExprSyntaxError(`expected ${what} but got ${describe(t)} at position ${t.pos}`, t.pos);
    return this.advance();
  }

  parseExpr(): Ast {
    return this.parseOr();
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    let t: Token | null;
    while ((t = this.match('IDENT', 'or'))) left = { kind: 'binary', op: 'or', left, right: this.parseAnd(), pos: t.pos };
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseNot();
    let t: Token | null;
    while ((t = this.match('IDENT', 'and'))) left = { kind: 'binary', op: 'and', left, right: this.parseNot(), pos: t.pos };
    return left;
  }

  private parseNot(): Ast {
    const t = this.match('IDENT', 'not');
    if (t) return { kind: 'unary', op: 'not', operand: this.parseNot(), pos: t.pos };
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const left = this.parseAddition();
    const t = this.peek();
    if (t.type === 'OP' && COMPARISONS.has(t.value)) {
      this.advance();
      return { kind: 'binary', op: t.value as BinaryOp, left, right: this.parseAddition(), pos: t.pos };
    }
    return left;
  }

  private parseAddition(): Ast {
    let left = this.parseMultiply();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'OP' || (t.value !== '+' && t.value !== '-')) return left;
      this.advance();
      left = { kind: 'binary', op: t.value, left, right: this.parseMultiply(), pos: t.pos };
    }
  }

  private parseMultiply(): Ast {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'OP' || (t.value !== '*' && t.value !== '/' && t.value !== '%')) return left;
      this.advance();
      left = { kind: 'binary', op: t.value, left, right: this.parseUnary(), pos: t.pos };
    }
  }

  private parseUnary(): Ast {
    const t = this.match('OP', '-');
    if (t) return { kind: 'unary', op: '-', operand: this.parseUnary(), pos: t.pos };
    return this.parsePostfix();
  }

  private parsePostfix(): Ast {
    let node = this.parsePrimary();
    for (;;) {
      let t: Token | null;
      if ((t = this.match('DOT'))) {
        const prop = this.expect('IDENT', 'a property name');
        node = { kind: 'member', object: node, property: prop.value, pos: t.pos };
      } else if ((t = this.match('LPAREN'))) {
        const args: Ast[] = [];
        if (this.peek().type !== 'RPAREN') {
          args.push(this.parseExpr());
          while (this.match('COMMA')) args.push(this.parseExpr());
        }
        this.expect('RPAREN', "')'");
        node = { kind: 'call', callee: node, args, pos: node.pos };
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): Ast {
    const t = this.peek();
    switch (t.type) {
      case 'NUMBER':
        this.advance();
        return { kind: 'number', value: t.num!, pos: t.pos };
      case 'STRING':
        this.advance();
        return { kind: 'string', value: t.value, pos: t.pos };
      case 'IDENT':
        if (t.value === 'true' || t.value === 'false') {
          this.advance();
          return { kind: 'boolean', value: t.value === 'true', pos: t.pos };
        }
        if (KEYWORDS.has(t.value)) throw new ExprSyntaxError(`unexpected keyword '${t.value}' at position ${t.pos}`, t.pos);
        this.advance();
        return { kind: 'ident', name: t.value, pos: t.pos };
      case 'LPAREN': {
        this.advance();
        const e = this.parseExpr();
        this.expect('RPAREN', "')'");
        return e;
      }
      default:
        throw new ExprSyntaxError(`unexpected ${describe(t)} at position ${t.pos}`, t.pos);
    }
  }
}

function describe(t: Token): string {
  return t.type === 'EOF' ? 'end of expression' : `'${t.value}'`;
}

/** Parse an expression string into an AST. Throws ExprSyntaxError. */
export function parse(source: string): Ast {
  const p = new Parser(tokenize(source));
  const ast = p.parseExpr();
  const t = p.peek();
  if (t.type !== 'EOF') throw new ExprSyntaxError(`unexpected ${describe(t)} at position ${t.pos}`, t.pos);
  return ast;
}
