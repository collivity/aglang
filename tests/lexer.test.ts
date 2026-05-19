import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/lexer.ts';

describe('lexer', () => {
  it('tokenizes keywords', () => {
    const tokens = tokenize('node component invariant');
    const kinds = tokens.filter(t => t.kind !== 'EOF').map(t => t.kind);
    expect(kinds).toEqual(['KEYWORD', 'KEYWORD', 'KEYWORD']);
    const values = tokens.filter(t => t.kind !== 'EOF').map(t => t.value);
    expect(values).toEqual(['node', 'component', 'invariant']);
  });

  it('tokenizes identifiers', () => {
    const tokens = tokenize('MyNode ApiGateway');
    const ids = tokens.filter(t => t.kind === 'IDENT').map(t => t.value);
    expect(ids).toEqual(['MyNode', 'ApiGateway']);
  });

  it('tokenizes string literals', () => {
    const tokens = tokenize('"src/**/*.ts"');
    const str = tokens.find(t => t.kind === 'STRING');
    expect(str?.value).toBe('src/**/*.ts');
  });

  it('tokenizes punctuation', () => {
    const tokens = tokenize('{ } : -> |');
    const kinds = tokens.filter(t => t.kind !== 'EOF').map(t => t.kind);
    expect(kinds).toEqual(['LBRACE', 'RBRACE', 'COLON', 'ARROW', 'PIPE']);
  });

  it('tokenizes bracket tokens', () => {
    const tokens = tokenize('[]');
    const kinds = tokens.filter(t => t.kind !== 'EOF').map(t => t.kind);
    expect(kinds).toEqual(['LBRACKET', 'RBRACKET']);
  });

  it('skips line comments', () => {
    const tokens = tokenize('node // this is a comment\ncomponent');
    const values = tokens.filter(t => t.kind !== 'EOF').map(t => t.value);
    expect(values).toEqual(['node', 'component']);
  });

  it('handles empty input', () => {
    const tokens = tokenize('');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe('EOF');
  });

  it('tokenizes contract keyword', () => {
    const tokens = tokenize('contract MyApi');
    const kinds = tokens.filter(t => t.kind !== 'EOF').map(t => t.kind);
    expect(kinds[0]).toBe('KEYWORD');
    expect(tokens[0]!.value).toBe('contract');
  });
});
