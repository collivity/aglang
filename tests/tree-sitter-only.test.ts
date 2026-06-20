import { describe, expect, it } from 'vitest';
import { getTreeSitter, makeParser } from '../src/analyzers/ast/loader.ts';
import { parseAndQuery } from '../src/analyzers/ast/walker.ts';
import * as pythonQueries from '../src/analyzers/ast/queries/python.ts';
import * as tsQueries from '../src/analyzers/ast/queries/typescript.ts';

type TreeSitterLanguage = Parameters<typeof makeParser>[0];

function requireTreeSitter(languageName: TreeSitterLanguage) {
  const loaded = getTreeSitter();
  expect(loaded, 'tree-sitter native parser must load for this test').not.toBeNull();

  const parser = makeParser(languageName);
  const language = loaded?.[languageName];
  expect(parser, `tree-sitter ${languageName} parser must be available`).not.toBeNull();
  expect(language, `tree-sitter ${languageName} grammar must be available`).toBeTruthy();

  return { parser: parser!, language };
}

describe('tree-sitter only extraction primitives', () => {
  it('captures TypeScript imports, require calls, and constructors without regex fallback', () => {
    const { parser, language } = requireTreeSitter('typescript');
    const source = [
      `// import mongoose from 'mongoose';`,
      `import { MongoClient as MC } from 'mongodb';`,
      `const pg = require('pg');`,
      `const client = new MC();`,
      '',
    ].join('\n');

    const namedImports = parseAndQuery(parser, language, source, tsQueries.IMPORT_NAMED_QUERY);
    const imports = parseAndQuery(parser, language, source, tsQueries.IMPORT_QUERY);
    const requires = parseAndQuery(parser, language, source, tsQueries.REQUIRE_QUERY);
    const constructors = parseAndQuery(parser, language, source, tsQueries.NEW_EXPR_QUERY);

    expect(namedImports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'import_name', text: 'MongoClient', startRow: 1 }),
      expect.objectContaining({ name: 'import_alias', text: 'MC', startRow: 1 }),
      expect.objectContaining({ name: 'module_specifier', text: 'mongodb', startRow: 1 }),
    ]));
    expect(imports).toEqual([
      expect.objectContaining({ name: 'module_specifier', text: 'mongodb', startRow: 1 }),
    ]);
    expect(requires).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'require_fn', text: 'require', startRow: 2 }),
      expect.objectContaining({ name: 'module_specifier', text: 'pg', startRow: 2 }),
    ]));
    expect(constructors).toEqual([
      expect.objectContaining({ name: 'class_name', text: 'MC', startRow: 3 }),
    ]);
    expect([...namedImports, ...imports, ...requires, ...constructors].some(c => c.text === 'mongoose')).toBe(false);
  });

  it('captures Node http route guards without regex fallback', () => {
    const { parser, language } = requireTreeSitter('typescript');
    const source = [
      `if (req.method === 'GET' && url.pathname === '/api/files') res.end('{}');`,
      `else if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) res.end('{}');`,
      '',
    ].join('\n');

    const routes = parseAndQuery(parser, language, source, tsQueries.NODE_HTTP_ROUTE_QUERY);

    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'method', text: 'GET', startRow: 0 }),
      expect.objectContaining({ name: 'route_path', text: '/api/files', startRow: 0 }),
      expect.objectContaining({ name: 'method', text: 'GET', startRow: 1 }),
      expect.objectContaining({ name: 'starts_with', text: 'startsWith', startRow: 1 }),
      expect.objectContaining({ name: 'route_path', text: '/api/runs/', startRow: 1 }),
    ]));
  });

  it('captures Python imports, aliases, from-imports, decorators, and calls without regex fallback', () => {
    const { parser, language } = requireTreeSitter('python');
    const source = [
      `# import redis`,
      `import psycopg2 as db`,
      `from sqlalchemy import create_engine`,
      `@router.post("/orders/{order_id}")`,
      `def create_order():`,
      `    return create_engine("sqlite:///tmp.db")`,
      '',
    ].join('\n');

    const aliases = parseAndQuery(parser, language, source, pythonQueries.IMPORT_ALIAS_QUERY);
    const fromImports = parseAndQuery(parser, language, source, pythonQueries.FROM_IMPORT_QUERY);
    const routes = parseAndQuery(parser, language, source, pythonQueries.DECORATOR_ROUTE_QUERY);
    const calls = parseAndQuery(parser, language, source, pythonQueries.CALL_EXPR_QUERY);

    expect(aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'module_name', text: 'psycopg2', startRow: 1 }),
      expect.objectContaining({ name: 'alias', text: 'db', startRow: 1 }),
    ]));
    expect(fromImports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'module_name', text: 'sqlalchemy', startRow: 2 }),
      expect.objectContaining({ name: 'import_name', text: 'create_engine', startRow: 2 }),
    ]));
    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'decorator_method', text: 'post', startRow: 3 }),
      expect.objectContaining({ name: 'route_path', text: '/orders/{order_id}', startRow: 3 }),
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'fn_name', text: 'create_engine', startRow: 5 }),
    ]));
    expect([...aliases, ...fromImports, ...routes, ...calls].some(c => c.text === 'redis')).toBe(false);
  });
});
