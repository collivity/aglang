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
    path: (identifier) @attr_name
    (#match? @attr_name "^(get|post|put|delete|patch|head|options|route)$")
    arguments: (token_tree
      (literal) @route_path)?))
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
