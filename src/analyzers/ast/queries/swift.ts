// Tree-sitter S-expression queries for Swift files.
// These are optional helpers: the Swift analyzer gracefully falls back to
// regex extraction when a Swift grammar is not installed.

export const IMPORT_QUERY = `
(import_declaration
  path: (identifier) @module_name)
` as const;

export const CLASS_DECL_QUERY = `
(class_declaration
  name: (type_identifier) @class_name)
` as const;

export const STRUCT_DECL_QUERY = `
(struct_declaration
  name: (type_identifier) @struct_name)
` as const;

export const CALL_EXPR_QUERY = `
(call_expression
  called_expression: (_) @callee)
` as const;
