// Lexer for aglang source files

export type TokenKind =
  | 'KEYWORD' | 'IDENT' | 'STRING' | 'NUMBER' | 'UNIT'
  | 'LBRACE' | 'RBRACE' | 'LPAREN' | 'RPAREN'
  | 'LBRACKET' | 'RBRACKET'
  | 'COLON' | 'SEMICOLON' | 'COMMA' | 'PIPE' | 'DOT' | 'ARROW'
  | 'LT' | 'GT' | 'EQ' | 'AT' | 'STAR'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  'node', 'component', 'data', 'enum', 'service', 'invariant', 'test',
  'deny', 'allow', 'flow', 'require', 'encryption', 'on',
  'runs_on', 'paths', 'trust', 'connectivity', 'latency', 'failure_mode',
  'protocol', 'auth', 'rate_limit',
  'where', 'no', 'every', 'some',
  'assert', 'p99', 'p95', 'p50',
  'degrade', 'never', 'eventual', 'always',
  // State machine + permission keywords
  'machine', 'permission', 'transition', 'when',
  // Contract block
  'contract',
  // External extractor plugin declaration
  'plugin',
]);

// Matches numbers optionally followed by a time/rate unit: 100ms, 5s, 1000rps
const UNIT_RE = /^\d+(\.\d+)?(ms|s|rps|rpm|mb|gb|kb)$/i;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const col = () => i - lineStart + 1;

  while (i < src.length) {
    // Newline
    if (src[i] === '\n') {
      line++;
      lineStart = i + 1;
      i++;
      continue;
    }

    // Whitespace
    if (/\s/.test(src[i])) { i++; continue; }

    // Line comment
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // Arrow ->
    if (src[i] === '-' && src[i + 1] === '>') {
      tokens.push({ kind: 'ARROW', value: '->', line, col: col() });
      i += 2; continue;
    }

    // Single-char tokens
    const single: Record<string, TokenKind> = {
      '{': 'LBRACE', '}': 'RBRACE',
      '(': 'LPAREN', ')': 'RPAREN',
      '[': 'LBRACKET', ']': 'RBRACKET',
      ':': 'COLON', ';': 'SEMICOLON',
      ',': 'COMMA', '|': 'PIPE', '.': 'DOT',
      '<': 'LT', '>': 'GT', '@': 'AT', '*': 'STAR',
    };
    if (src[i] in single) {
      tokens.push({ kind: single[src[i]]!, value: src[i], line, col: col() });
      i++; continue;
    }

    // == (two chars)
    if (src[i] === '=' && src[i + 1] === '=') {
      tokens.push({ kind: 'EQ', value: '==', line, col: col() });
      i += 2; continue;
    }

    // String literal
    if (src[i] === '"') {
      const start = col();
      i++;
      let str = '';
      while (i < src.length && src[i] !== '"') { str += src[i++]; }
      i++; // closing "
      tokens.push({ kind: 'STRING', value: str, line, col: start });
      continue;
    }

    // Number or unit (e.g. 100ms, 5s, 1000)
    if (/\d/.test(src[i])) {
      const start = col();
      let num = '';
      while (i < src.length && /[\d.a-zA-Z]/.test(src[i])) { num += src[i++]; }
      const kind: TokenKind = UNIT_RE.test(num) ? 'UNIT' : 'NUMBER';
      tokens.push({ kind, value: num, line, col: start });
      continue;
    }

    // Identifier or keyword (allows _ in names)
    if (/[a-zA-Z_]/.test(src[i])) {
      const start = col();
      let ident = '';
      while (i < src.length && /[\w]/.test(src[i])) { ident += src[i++]; }
      const kind: TokenKind = KEYWORDS.has(ident) ? 'KEYWORD' : 'IDENT';
      tokens.push({ kind, value: ident, line, col: start });
      continue;
    }

    throw new Error(`Unexpected character '${src[i]}' at line ${line}:${col()}`);
  }

  tokens.push({ kind: 'EOF', value: '', line, col: col() });
  return tokens;
}
