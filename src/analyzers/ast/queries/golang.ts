// Tree-sitter S-expression queries for Go (.go) files.

// ── Import declarations ───────────────────────────────────────────────────────
// Both single: import "pkg"  and grouped: import ( "pkg" \n "pkg2" )
export const IMPORT_QUERY = `
(import_spec
  path: (interpreted_string_literal) @import_path)
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
      field: (identifier) @fn_name)
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
    field: (identifier) @method
    (#match? @method "^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|HandleFunc|Handle)$"))
  arguments: (argument_list
    (interpreted_string_literal) @route_path .))
` as const;
