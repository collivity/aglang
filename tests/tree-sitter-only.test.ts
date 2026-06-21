import { describe, expect, it } from 'vitest';
import { getTreeSitter, makeParser } from '../src/analyzers/ast/loader.ts';
import { parseAndQuery } from '../src/analyzers/ast/walker.ts';
import * as pythonQueries from '../src/analyzers/ast/queries/python.ts';
import * as tsQueries from '../src/analyzers/ast/queries/typescript.ts';
import * as goQueries from '../src/analyzers/ast/queries/golang.ts';
import * as rustQueries from '../src/analyzers/ast/queries/rust.ts';
import * as javaQueries from '../src/analyzers/ast/queries/java.ts';

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

  it('captures Python relative from-imports without regex fallback', () => {
    const { parser, language } = requireTreeSitter('python');
    const source = [
      `from . import models`,
      `from .models import User`,
      `from ..shared import util`,
      '',
    ].join('\n');

    const relative = parseAndQuery(parser, language, source, pythonQueries.FROM_IMPORT_RELATIVE_QUERY);

    expect(relative).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'module_name', text: '.', startRow: 0 }),
      expect.objectContaining({ name: 'import_name', text: 'models', startRow: 0 }),
      expect.objectContaining({ name: 'module_name', text: '.models', startRow: 1 }),
      expect.objectContaining({ name: 'import_name', text: 'User', startRow: 1 }),
      expect.objectContaining({ name: 'module_name', text: '..shared', startRow: 2 }),
      expect.objectContaining({ name: 'import_name', text: 'util', startRow: 2 }),
    ]));
  });

  it('captures Rust use declarations (plain and aliased) without regex fallback', () => {
    const { parser, language } = requireTreeSitter('rust');
    const source = [
      `use sqlx::PgPool;`,
      `use crate::data::store;`,
      `use super::utils;`,
      `use redis::Client as RedisClient;`,
      '',
    ].join('\n');

    const plain = parseAndQuery(parser, language, source, rustQueries.USE_QUERY);
    const aliased = parseAndQuery(parser, language, source, rustQueries.USE_ALIASED_QUERY);

    expect(plain).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'import_path', text: 'sqlx::PgPool', startRow: 0 }),
      expect.objectContaining({ name: 'import_path', text: 'crate::data::store', startRow: 1 }),
      expect.objectContaining({ name: 'import_path', text: 'super::utils', startRow: 2 }),
    ]));
    expect(plain.some(c => c.startRow === 3)).toBe(false);
    expect(aliased).toEqual([
      expect.objectContaining({ name: 'import_path', text: 'redis::Client', startRow: 3 }),
      expect.objectContaining({ name: 'import_alias', text: 'RedisClient', startRow: 3 }),
    ]);
  });

  it('captures Go imports (plain, blank, and aliased) and method-style calls without regex fallback', () => {
    const { parser, language } = requireTreeSitter('golang');
    const source = [
      `package main`,
      `import (`,
      `  db "myapp/internal/database"`,
      `  _ "github.com/lib/pq"`,
      `  "fmt"`,
      `)`,
      `func f() { db.SaveOrder() }`,
      '',
    ].join('\n');

    const plain = parseAndQuery(parser, language, source, goQueries.IMPORT_QUERY);
    const aliased = parseAndQuery(parser, language, source, goQueries.IMPORT_ALIASED_QUERY);
    const calls = parseAndQuery(parser, language, source, goQueries.CALL_QUERY);

    expect(plain).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'import_path', text: '"github.com/lib/pq"' }),
      expect.objectContaining({ name: 'import_path', text: '"fmt"' }),
    ]));
    expect(plain.some(c => c.text === '"myapp/internal/database"')).toBe(false);
    expect(aliased).toEqual([
      expect.objectContaining({ name: 'import_alias', text: 'db' }),
      expect.objectContaining({ name: 'import_path', text: '"myapp/internal/database"' }),
    ]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'receiver', text: 'db' }),
      expect.objectContaining({ name: 'fn_name', text: 'SaveOrder' }),
    ]));
  });

  it('captures Java method invocations, package declarations, and wildcard imports without regex fallback', () => {
    const { parser, language } = requireTreeSitter('java');
    const source = [
      `package com.acme.orders;`,
      `import com.acme.data.*;`,
      `import com.acme.data.OrderRepository;`,
      `class X {`,
      `  void f() {`,
      `    repo.save(order);`,
      `    OrderRepository.create();`,
      `  }`,
      `}`,
      '',
    ].join('\n');

    const pkg = parseAndQuery(parser, language, source, javaQueries.PACKAGE_DECLARATION_QUERY);
    const imports = parseAndQuery(parser, language, source, javaQueries.IMPORT_QUERY);
    const methodCalls = parseAndQuery(parser, language, source, javaQueries.METHOD_INVOCATION_QUERY);

    expect(pkg).toEqual([
      expect.objectContaining({ name: 'package_name', text: 'com.acme.orders' }),
    ]);
    expect(imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'import_path', text: 'com.acme.data' }),
      expect.objectContaining({ name: 'import_path', text: 'com.acme.data.OrderRepository' }),
    ]));
    expect(methodCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'receiver', text: 'repo' }),
      expect.objectContaining({ name: 'method', text: 'save' }),
      expect.objectContaining({ name: 'receiver', text: 'OrderRepository' }),
      expect.objectContaining({ name: 'method', text: 'create' }),
    ]));
  });

  it('captures declaration names for python/go/rust/java without regex fallback', () => {
    const py = requireTreeSitter('python');
    const pyDecls = parseAndQuery(py.parser, py.language, 'class OrderRepository:\n    def save(self, order):\n        pass\n', pythonQueries.DECL_QUERY);
    expect(pyDecls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'type_name', text: 'OrderRepository' }),
      expect.objectContaining({ name: 'type_name', text: 'save' }),
    ]));

    const go = requireTreeSitter('golang');
    const goDecls = parseAndQuery(go.parser, go.language, 'package data\ntype OrderRepository struct {}\nfunc SaveOrder() {}\n', goQueries.DECL_QUERY);
    expect(goDecls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'type_name', text: 'OrderRepository' }),
      expect.objectContaining({ name: 'type_name', text: 'SaveOrder' }),
    ]));

    const rust = requireTreeSitter('rust');
    const rustDecls = parseAndQuery(rust.parser, rust.language, 'struct OrderRepository {}\nfn save_order() {}\n', rustQueries.DECL_QUERY);
    expect(rustDecls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'type_name', text: 'OrderRepository' }),
      expect.objectContaining({ name: 'type_name', text: 'save_order' }),
    ]));

    const java = requireTreeSitter('java');
    const javaDecls = parseAndQuery(java.parser, java.language, 'class OrderRepository {\n  void save() {}\n}\n', javaQueries.DECL_QUERY);
    expect(javaDecls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'type_name', text: 'OrderRepository' }),
      expect.objectContaining({ name: 'type_name', text: 'save' }),
    ]));
  });
});
