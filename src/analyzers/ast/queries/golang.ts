// Tree-sitter S-expression queries for Go (.go) files.

// ── Import declarations ───────────────────────────────────────────────────────
// Both single: import "pkg"  and grouped: import ( "pkg" \n "pkg2" )
// Side-effect-only: import _ "pkg" (blank_identifier — not a real alias).
// Excludes aliased specs (see IMPORT_ALIASED_QUERY) to avoid emitting a duplicate
// edge for the same import_spec.
export const IMPORT_QUERY = `
(import_spec
  !name
  path: (interpreted_string_literal) @import_path)
(import_spec
  name: (blank_identifier)
  path: (interpreted_string_literal) @import_path)
` as const;

// import db "myapp/internal/database"
export const IMPORT_ALIASED_QUERY = `
(import_spec
  name: (package_identifier) @import_alias
  path: (interpreted_string_literal) @import_path)
` as const;

// ── Declarations (functions/types this file defines) ─────────────────────────
export const DECL_QUERY = `
(function_declaration name: (identifier) @type_name)
(method_declaration name: (field_identifier) @type_name)
(type_spec name: (type_identifier) @type_name)
` as const;

// ── Call expressions ──────────────────────────────────────────────────────────
// sql.Open("postgres", dsn)  mongo.Connect(...)  redis.NewClient(...)
// Captures: receiver (optional), function name, and first string argument if present.
export const CALL_QUERY = `
(call_expression
  function: [
    (identifier) @fn_name
    (selector_expression
      operand: (identifier) @receiver
      field: (field_identifier) @fn_name)
  ]
  arguments: (argument_list
    (interpreted_string_literal) @first_arg)?)
` as const;

// ── Route registrations ───────────────────────────────────────────────────────
// Gin: r.GET("/path", handler)   r.POST(...)
// Echo: e.GET("/path", handler)
// chi: r.Get("/path", handler)   net/http: http.HandleFunc("/path", handler)
export const ROUTE_QUERY = `
(call_expression
  function: (selector_expression
    operand: (identifier) @receiver
    field: (field_identifier) @method
    (#match? @method "^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|HandleFunc|Handle)$"))
  arguments: (argument_list
    (interpreted_string_literal) @route_path
    (_) @route_handler))
` as const;
