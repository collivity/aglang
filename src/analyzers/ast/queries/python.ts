// Tree-sitter S-expression queries for Python files.
// Covers: import statements, FastAPI/Flask/Django route decorators,
// infrastructure call expressions (MongoClient, create_engine, etc.).

// ── Imports ──────────────────────────────────────────────────────────────────
// import psycopg2  →  module_name = psycopg2
export const IMPORT_QUERY = `
(import_statement
  name: (dotted_name) @module_name)
` as const;

// import psycopg2 as psy  →  module_name = psycopg2, alias = psy
export const IMPORT_ALIAS_QUERY = `
(import_statement
  name: (aliased_import
    name: (dotted_name) @module_name
    alias: (identifier) @alias))
` as const;

// from sqlalchemy import create_engine  →  module_name = sqlalchemy
export const FROM_IMPORT_QUERY = `
(import_from_statement
  module_name: (dotted_name) @module_name
  name: (dotted_name) @import_name)
` as const;

// ── Route decorators ──────────────────────────────────────────────────────────
// @app.get("/path")   @router.post("/path")
// Captures: decorator_method (get/post/..) and route_path
export const DECORATOR_ROUTE_QUERY = `
(decorated_definition
  (decorator
    (call
      function: (attribute
        attribute: (identifier) @decorator_method
        (#match? @decorator_method "^(get|post|put|delete|patch|head|options)$"))
      arguments: (argument_list
        (string (string_content) @route_path)))))
` as const;

// @app.route("/path", methods=["GET","POST"])
export const FLASK_ROUTE_QUERY = `
(decorated_definition
  (decorator
    (call
      function: (attribute
        attribute: (identifier) @decorator_name
        (#eq? @decorator_name "route"))
      arguments: (argument_list
        (string (string_content) @route_path)))))
` as const;

// ── Django path() / re_path() ─────────────────────────────────────────────────
export const DJANGO_PATH_QUERY = `
(call
  function: (identifier) @fn_name
  (#match? @fn_name "^(path|re_path)$")
  arguments: (argument_list
    (string (string_content) @route_path) .))
` as const;

// ── Infrastructure call expressions ──────────────────────────────────────────
// MongoClient(uri)  redis.Redis(...)  create_engine(...)
export const CALL_EXPR_QUERY = `
(call
  function: [
    (identifier) @fn_name
    (attribute attribute: (identifier) @fn_name)
  ])
` as const;
