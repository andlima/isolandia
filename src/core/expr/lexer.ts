/**
 * Expression lexer. Ported from rogue-engine's hand-written tokenizer, with
 * one addition: `ns:id` (no whitespace around the colon) lexes as a single
 * qualified IDENT token so packs can write `self.pack:stamina`.
 */

export type TokenType = 'NUMBER' | 'STRING' | 'IDENT' | 'OP' | 'LPAREN' | 'RPAREN' | 'DOT' | 'COMMA' | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  /** Numeric value for NUMBER tokens. */
  num?: number;
  pos: number;
}

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
    this.name = 'ExprSyntaxError';
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentPart = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const readIdent = (): string => {
    const start = i;
    while (i < n && isIdentPart(source[i])) i++;
    return source.slice(start, i);
  };

  while (i < n) {
    const ch = source[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      const start = i;
      while (isDigit(source[i])) i++;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i++;
        while (isDigit(source[i])) i++;
      }
      const text = source.slice(start, i);
      tokens.push({ type: 'NUMBER', value: text, num: Number(text), pos: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      let str = '';
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\' && i + 1 < n) i++;
        str += source[i++];
      }
      if (i >= n) throw new ExprSyntaxError(`unterminated string starting at position ${start}`, start);
      i++;
      tokens.push({ type: 'STRING', value: str, pos: start });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      let ident = readIdent();
      // Qualified id: `ns:id` with no whitespace is one token.
      if (source[i] === ':' && isIdentStart(source[i + 1])) {
        i++;
        ident += ':' + readIdent();
      }
      tokens.push({ type: 'IDENT', value: ident, pos: start });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'OP', value: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%<>'.includes(ch)) {
      tokens.push({ type: 'OP', value: ch, pos: i++ });
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'LPAREN', value: ch, pos: i++ }); continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ch, pos: i++ }); continue; }
    if (ch === '.') { tokens.push({ type: 'DOT', value: ch, pos: i++ }); continue; }
    if (ch === ',') { tokens.push({ type: 'COMMA', value: ch, pos: i++ }); continue; }

    throw new ExprSyntaxError(`unexpected character '${ch}' at position ${i}`, i);
  }
  tokens.push({ type: 'EOF', value: '', pos: n });
  return tokens;
}
