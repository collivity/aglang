// Tree-sitter S-expression queries for Rust (.rs) files.

// ── Use declarations ──────────────────────────────────────────────────────────
// use sqlx::PgPool;  use mongodb::Client;  use redis::Client as RedisClient;
export const USE_QUERY = `
(use_declaration
  argument: (_) @use_path)
` as const;

// ── Attribute macros (Actix-web / Axum routes) ────────────────────────────────
// #[get("/path")]  #[post("/path")]  #[put("/path")]
export const ROUTE_ATTR_QUERY = `
(attribute_item
  (attribute
    (identifier) @attr_name
    (#match? @attr_name "^(get|post|put|delete|patch|head|options|route)$")
    arguments: (token_tree
      (string_literal (string_content) @route_path))))

(attribute_item
  (attribute
    (identifier) @attr_name
    (#eq? @attr_name "route")
    arguments: (token_tree
      (string_literal (string_content) @route_path)
      (identifier)
      (string_literal (string_content) @http_method))))
` as const;

// ── Struct / function instantiation ──────────────────────────────────────────
// PgPool::connect(...)  MongoClient::with_options(...)  Client::open(...)
export const CALL_QUERY = `
(call_expression
  function: [
    (identifier) @fn_name
    (scoped_identifier
      path: (identifier) @receiver
      name: (identifier) @fn_name)
  ])
` as const;
