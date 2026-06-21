// Tree-sitter S-expression queries for Swift files.
// Shapes verified directly against the installed tree-sitter-swift grammar
// (no `path:` field on import_declaration; class/struct/extension all share
// the class_declaration node type; call_expression has no called_expression
// field — see round 4 plan for the verified probe output).

// import Foundation   @testable import MyApp
export const IMPORT_QUERY = `
(import_declaration
  (identifier
    (simple_identifier) @module_name))
` as const;

// class X {}  struct X {}  extension X {}  func f() {}  protocol P {}
export const DECL_QUERY = `
(class_declaration
  name: [
    (type_identifier) @type_name
    (user_type (type_identifier) @type_name)
  ])
(function_declaration
  name: (simple_identifier) @type_name)
(protocol_declaration
  name: (type_identifier) @type_name)
` as const;

// repo.save(order)   OrderRepository.create()   save()
export const CALL_EXPR_QUERY = `
(call_expression
  (navigation_expression
    target: (simple_identifier) @receiver
    suffix: (navigation_suffix
      suffix: (simple_identifier) @method)))
(call_expression
  (simple_identifier) @fn_name)
` as const;
