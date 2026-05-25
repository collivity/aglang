// Tree-sitter S-expression queries for TypeScript and TSX files.
// Covers: import declarations, route call expressions, NestJS decorators, new expressions.

// ── Imports ──────────────────────────────────────────────────────────────────
// Captures the module specifier string of every import declaration.
// named   : import { X, Y } from 'module'  → module_specifier = 'module'
// default : import X from 'module'          → module_specifier = 'module'
// namespace: import * as X from 'module'    → module_specifier = 'module'
export const IMPORT_QUERY = `
(import_statement
  source: (string (string_fragment) @module_specifier))
` as const;

// Also captures the imported name or alias so we can build a symbol map.
// e.g. import { MongoClient } from 'mongodb' → name=MongoClient, module=mongodb
export const IMPORT_NAMED_QUERY = `
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import_name
        alias: (identifier)? @import_alias)))
  source: (string (string_fragment) @module_specifier))
` as const;

// ── Express/Fastify/Hono route calls ──────────────────────────────────────────
// Matches: app.get('/path', handler)  router.post('/path')
// Captures method name and path string.
export const EXPRESS_ROUTE_QUERY = `
(call_expression
  function: (member_expression
    object: (identifier) @receiver
    property: (property_identifier) @method
    (#match? @method "^(get|post|put|delete|patch|head|options)$"))
  arguments: (arguments
    (string (string_fragment) @route_path)
    (_) @route_handler))
` as const;

// ── NestJS class-level @Controller decorator ──────────────────────────────────
// @Controller('prefix')  or  @Controller()
export const NESTJS_CONTROLLER_QUERY = `
(decorator
  (call_expression
    function: (identifier) @decorator_name
    (#eq? @decorator_name "Controller")
    arguments: (arguments
      (string (string_fragment) @controller_prefix)?)))
` as const;

// NestJS method-level HTTP verb decorators: @Get('/path')  @Post()  @Delete(':id')
export const NESTJS_METHOD_QUERY = `
(decorator
  (call_expression
    function: (identifier) @http_method
    (#match? @http_method "^(Get|Post|Put|Delete|Patch)$")
    arguments: (arguments
      (string (string_fragment) @route_suffix)?)))
` as const;

// ── New expressions (infrastructure instantiation) ───────────────────────────
// new MongoClient(...)  new Pool(...)  new Redis(...)
export const NEW_EXPR_QUERY = `
(new_expression
  constructor: (identifier) @class_name)
` as const;

// ── require() calls ──────────────────────────────────────────────────────────
// const pg = require('pg')  → module_specifier = 'pg'
export const REQUIRE_QUERY = `
(call_expression
  function: (identifier) @require_fn
  (#eq? @require_fn "require")
  arguments: (arguments
    (string (string_fragment) @module_specifier)))
` as const;
