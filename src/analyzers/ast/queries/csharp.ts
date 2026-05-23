// Tree-sitter S-expression queries for C# (.cs) files.
// Covers: attribute annotations, constructor parameters, field/property declarations, using directives.

// ── Using directives ──────────────────────────────────────────────────────────
// using MongoDB.Driver;  using Microsoft.EntityFrameworkCore;
export const USING_QUERY = `
(using_directive
  (identifier) @namespace_part)
` as const;

// ── Attribute annotations ─────────────────────────────────────────────────────
// [Route("api/controller")]  [HttpGet("sub")]  [HttpPost]  [ApiController]
export const ATTRIBUTE_QUERY = `
(attribute
  name: (identifier) @attr_name
  (attribute_argument_list
    (attribute_argument
      (string_literal (string_literal_content) @attr_arg)?))?)
` as const;

// Simpler flat attribute capture for names without arguments
export const ATTRIBUTE_NAME_QUERY = `
(attribute
  name: (identifier) @attr_name)
` as const;

// ── Constructor parameters ────────────────────────────────────────────────────
// public MyController(ApplicationDbContext db, IMongoCollection<Bson> col)
// Captures the type identifier (including generic base) of each parameter.
export const CTOR_PARAM_QUERY = `
(constructor_declaration
  parameters: (parameter_list
    (parameter
      type: [
        (identifier) @param_type
        (generic_name name: (identifier) @param_type)
        (nullable_type type: (identifier) @param_type)
        (qualified_name right: (identifier) @param_type)
      ])))
` as const;

// ── Field declarations ────────────────────────────────────────────────────────
// private readonly ApplicationDbContext _db;
export const FIELD_QUERY = `
(field_declaration
  (variable_declaration
    type: [
      (identifier) @field_type
      (generic_name name: (identifier) @field_type)
      (nullable_type type: (identifier) @field_type)
    ]))
` as const;

// ── Auto-properties ──────────────────────────────────────────────────────────
// public DbSet<User> Users { get; set; }
export const PROPERTY_QUERY = `
(property_declaration
  type: [
    (identifier) @property_type
    (generic_name name: (identifier) @property_type)
    (nullable_type type: (identifier) @property_type)
    (qualified_name right: (identifier) @property_type)
  ])
` as const;

// ── Object creation expressions ───────────────────────────────────────────────
// new MongoClient(...)  new AmazonS3Client(...)
export const NEW_OBJECT_QUERY = `
(object_creation_expression
  type: [
    (identifier) @class_name
    (generic_name name: (identifier) @class_name)
    (qualified_name right: (identifier) @class_name)
  ])
` as const;
