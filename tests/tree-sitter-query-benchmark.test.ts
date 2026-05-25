import { describe, expect, it } from 'vitest';
import { createExtractorDebugSession } from '../src/analyzers/plugin.ts';
import { getTreeSitter, isTreeSitterLanguageAvailable, makeParser } from '../src/analyzers/ast/loader.ts';
import { parseAndQuery } from '../src/analyzers/ast/walker.ts';
import * as csharpQueries from '../src/analyzers/ast/queries/csharp.ts';
import * as goQueries from '../src/analyzers/ast/queries/golang.ts';
import * as javaQueries from '../src/analyzers/ast/queries/java.ts';
import * as pythonQueries from '../src/analyzers/ast/queries/python.ts';
import * as rustQueries from '../src/analyzers/ast/queries/rust.ts';
import * as swiftQueries from '../src/analyzers/ast/queries/swift.ts';
import * as tsQueries from '../src/analyzers/ast/queries/typescript.ts';

type LangKey = 'typescript' | 'python' | 'csharp' | 'golang' | 'rust' | 'java' | 'swift';

type QueryCase = {
  language: LangKey;
  queryName: string;
  querySource: string;
  snippet: string;
  minCaptures: number;
};

const cases: QueryCase[] = [
  { language: 'typescript', queryName: 'IMPORT_QUERY', querySource: tsQueries.IMPORT_QUERY, snippet: `import { store } from '../data/store';`, minCaptures: 1 },
  { language: 'typescript', queryName: 'IMPORT_NAMED_QUERY', querySource: tsQueries.IMPORT_NAMED_QUERY, snippet: `import { store } from '../data/store';`, minCaptures: 2 },
  { language: 'typescript', queryName: 'EXPRESS_ROUTE_QUERY', querySource: tsQueries.EXPRESS_ROUTE_QUERY, snippet: `app.get('/health', handler);`, minCaptures: 4 },
  { language: 'typescript', queryName: 'NESTJS_CONTROLLER_QUERY', querySource: tsQueries.NESTJS_CONTROLLER_QUERY, snippet: `@Controller('/api/items')\nexport class ItemsController {}`, minCaptures: 2 },
  { language: 'typescript', queryName: 'NESTJS_METHOD_QUERY', querySource: tsQueries.NESTJS_METHOD_QUERY, snippet: `export class ItemsController {\n  @Get(':id')\n  getOne() {}\n}`, minCaptures: 2 },
  { language: 'typescript', queryName: 'NEW_EXPR_QUERY', querySource: tsQueries.NEW_EXPR_QUERY, snippet: `const client = new MongoClient();`, minCaptures: 1 },
  { language: 'typescript', queryName: 'REQUIRE_QUERY', querySource: tsQueries.REQUIRE_QUERY, snippet: `const pg = require('pg');`, minCaptures: 2 },

  { language: 'python', queryName: 'IMPORT_QUERY', querySource: pythonQueries.IMPORT_QUERY, snippet: `import psycopg2`, minCaptures: 1 },
  { language: 'python', queryName: 'IMPORT_ALIAS_QUERY', querySource: pythonQueries.IMPORT_ALIAS_QUERY, snippet: `import psycopg2 as db`, minCaptures: 2 },
  { language: 'python', queryName: 'FROM_IMPORT_QUERY', querySource: pythonQueries.FROM_IMPORT_QUERY, snippet: `from sqlalchemy import create_engine`, minCaptures: 2 },
  { language: 'python', queryName: 'DECORATOR_ROUTE_QUERY', querySource: pythonQueries.DECORATOR_ROUTE_QUERY, snippet: `@app.get("/items")\ndef get_item():\n    pass`, minCaptures: 2 },
  { language: 'python', queryName: 'FLASK_ROUTE_QUERY', querySource: pythonQueries.FLASK_ROUTE_QUERY, snippet: `@app.route("/orders", methods=["POST"])\ndef create_order():\n    pass`, minCaptures: 2 },
  { language: 'python', queryName: 'DJANGO_PATH_QUERY', querySource: pythonQueries.DJANGO_PATH_QUERY, snippet: `path("orders/", orders_view)`, minCaptures: 3 },
  { language: 'python', queryName: 'CALL_EXPR_QUERY', querySource: pythonQueries.CALL_EXPR_QUERY, snippet: `create_engine("sqlite:///")`, minCaptures: 1 },

  { language: 'csharp', queryName: 'USING_QUERY', querySource: csharpQueries.USING_QUERY, snippet: `using MongoDB.Driver;`, minCaptures: 1 },
  { language: 'csharp', queryName: 'ATTRIBUTE_QUERY', querySource: csharpQueries.ATTRIBUTE_QUERY, snippet: `[HttpGet("items")]\npublic void Get() {}`, minCaptures: 2 },
  { language: 'csharp', queryName: 'ATTRIBUTE_NAME_QUERY', querySource: csharpQueries.ATTRIBUTE_NAME_QUERY, snippet: `[ApiController]\npublic class OrdersController {}`, minCaptures: 1 },
  { language: 'csharp', queryName: 'CTOR_PARAM_QUERY', querySource: csharpQueries.CTOR_PARAM_QUERY, snippet: `public class OrdersController { public OrdersController(ApplicationDbContext db) {} }`, minCaptures: 1 },
  { language: 'csharp', queryName: 'FIELD_QUERY', querySource: csharpQueries.FIELD_QUERY, snippet: `public class Repo { private readonly ApplicationDbContext _db; }`, minCaptures: 1 },
  { language: 'csharp', queryName: 'PROPERTY_QUERY', querySource: csharpQueries.PROPERTY_QUERY, snippet: `public class AppDb { public DbSet<User> Users { get; set; } }`, minCaptures: 1 },
  { language: 'csharp', queryName: 'NEW_OBJECT_QUERY', querySource: csharpQueries.NEW_OBJECT_QUERY, snippet: `var client = new MongoClient();`, minCaptures: 1 },

  { language: 'golang', queryName: 'IMPORT_QUERY', querySource: goQueries.IMPORT_QUERY, snippet: `package main\nimport "database/sql"`, minCaptures: 1 },
  { language: 'golang', queryName: 'CALL_QUERY', querySource: goQueries.CALL_QUERY, snippet: `package main\nfunc main() { sql.Open("postgres", dsn) }`, minCaptures: 3 },
  { language: 'golang', queryName: 'ROUTE_QUERY', querySource: goQueries.ROUTE_QUERY, snippet: `package main\nfunc main() { r.GET("/health", handler) }`, minCaptures: 4 },

  { language: 'java', queryName: 'IMPORT_QUERY', querySource: javaQueries.IMPORT_QUERY, snippet: `import com.mongodb.client.MongoClient;`, minCaptures: 1 },
  { language: 'java', queryName: 'ANNOTATION_QUERY', querySource: javaQueries.ANNOTATION_QUERY, snippet: `@GetMapping("/items")\nclass OrdersController {}`, minCaptures: 2 },
  { language: 'java', queryName: 'NEW_OBJECT_QUERY', querySource: javaQueries.NEW_OBJECT_QUERY, snippet: `class App { void go() { var c = new MongoClient(); } }`, minCaptures: 1 },
  { language: 'java', queryName: 'METHOD_INVOCATION_QUERY', querySource: javaQueries.METHOD_INVOCATION_QUERY, snippet: `class App { void go() { MongoClients.create(); } }`, minCaptures: 2 },

  { language: 'rust', queryName: 'USE_QUERY', querySource: rustQueries.USE_QUERY, snippet: `use sqlx::PgPool;`, minCaptures: 1 },
  { language: 'rust', queryName: 'ROUTE_ATTR_QUERY', querySource: rustQueries.ROUTE_ATTR_QUERY, snippet: `#[get("/items")]\nasync fn list_items() {}`, minCaptures: 2 },
  { language: 'rust', queryName: 'CALL_QUERY', querySource: rustQueries.CALL_QUERY, snippet: `fn main() { PgPool::connect(); }`, minCaptures: 2 },

  { language: 'swift', queryName: 'IMPORT_QUERY', querySource: swiftQueries.IMPORT_QUERY, snippet: `import Foundation`, minCaptures: 1 },
  { language: 'swift', queryName: 'CLASS_DECL_QUERY', querySource: swiftQueries.CLASS_DECL_QUERY, snippet: `class HomeViewController {}`, minCaptures: 1 },
  { language: 'swift', queryName: 'STRUCT_DECL_QUERY', querySource: swiftQueries.STRUCT_DECL_QUERY, snippet: `struct ItemView {}`, minCaptures: 1 },
  { language: 'swift', queryName: 'CALL_EXPR_QUERY', querySource: swiftQueries.CALL_EXPR_QUERY, snippet: `client.get()`, minCaptures: 1 },
];

describe('tree-sitter query benchmark', () => {
  it('runs every exported query against representative syntax and reports failures explicitly', () => {
    const ts = getTreeSitter();
    expect(ts).not.toBeNull();

    const results: Array<{ language: string; query: string; captures: number; status: string }> = [];
    const failures: string[] = [];

    for (const entry of cases) {
      if (!isTreeSitterLanguageAvailable(entry.language)) {
        results.push({ language: entry.language, query: entry.queryName, captures: 0, status: 'skipped:no-grammar' });
        continue;
      }

      const parser = makeParser(entry.language);
      const language = getTreeSitter()?.[entry.language];
      if (!parser || !language) {
        results.push({ language: entry.language, query: entry.queryName, captures: 0, status: 'skipped:no-parser' });
        continue;
      }

      const debug = createExtractorDebugSession(true, false);
      const captures = parseAndQuery(parser, language, entry.snippet, entry.querySource, {
        debug,
        extractor: `${entry.language}:${entry.queryName}`,
        queryName: entry.queryName,
        file: `${entry.language}.fixture`,
      });
      const queryError = debug.events.find(event => event.stage === 'ast_query_error');

      results.push({
        language: entry.language,
        query: entry.queryName,
        captures: captures.length,
        status: queryError ? 'error' : captures.length >= entry.minCaptures ? 'ok' : 'zero-or-low',
      });

      if (queryError) {
        failures.push(`${entry.language}.${entry.queryName}: ${(queryError.details?.error as string) ?? queryError.message}`);
        continue;
      }
      if (captures.length < entry.minCaptures) {
        failures.push(`${entry.language}.${entry.queryName}: expected >= ${entry.minCaptures} captures, got ${captures.length}`);
      }
    }

    console.table(results);
    console.log('\n[tree-sitter query benchmark] failures');
    console.log(JSON.stringify(failures, null, 2));
    expect(failures).toEqual([]);
  });

  it('keeps the Express route query scoped to server/router registration patterns', () => {
    if (!isTreeSitterLanguageAvailable('typescript')) return;

    const parser = makeParser('typescript');
    const language = getTreeSitter()?.typescript;
    expect(parser).not.toBeNull();
    expect(language).toBeTruthy();

    const captures = parseAndQuery(parser!, language, `api.get('/x')`, tsQueries.EXPRESS_ROUTE_QUERY, {
      debug: createExtractorDebugSession(true, false),
      extractor: 'typescript:EXPRESS_ROUTE_QUERY',
      queryName: 'EXPRESS_ROUTE_QUERY',
      file: 'typescript.negative.fixture',
    });

    expect(captures).toHaveLength(0);
  });
});
