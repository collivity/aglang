// Tree-sitter S-expression queries for Rust (.rs) files.

// ── Use declarations ──────────────────────────────────────────────────────────
// use sqlx::PgPool;  use mongodb::Client;  use crate::data::store;  use super::utils;
// Excludes use_as_clause (see USE_ALIASED_QUERY) so the captured path text never
// includes a trailing " as alias".
export const USE_QUERY = `
(use_declaration
  argument: [
    (scoped_identifier) @import_path
    (identifier) @import_path
  ])
` as const;

// use redis::Client as RedisClient;
export const USE_ALIASED_QUERY = `
(use_declaration
  argument: (use_as_clause
    path: (_) @import_path
    alias: (identifier) @import_alias))
` as const;

// ── Declarations (functions/types/traits this file defines) ──────────────────
export const DECL_QUERY = `
(function_item name: (identifier) @type_name)
(struct_item name: (type_identifier) @type_name)
(enum_item name: (type_identifier) @type_name)
(trait_item name: (type_identifier) @type_name)
` as const;

// impl Repo for OrderRepository {}  →  interface_name = Repo (trait), type_name = OrderRepository
// Inherent impls (`impl OrderRepository {}`, no trait) have no `trait:` field — excluded,
// since they're not a conformance relationship.
export const INHERITANCE_QUERY = `
(impl_item
  trait: (type_identifier) @interface_name
  type: (type_identifier) @type_name)
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
