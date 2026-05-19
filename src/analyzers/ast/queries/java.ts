// Tree-sitter S-expression queries for Java (.java) files.

// ── Import declarations ───────────────────────────────────────────────────────
// import com.mongodb.client.MongoClient;
// import org.springframework.data.jpa.repository.JpaRepository;
export const IMPORT_QUERY = `
(import_declaration
  (scoped_identifier) @import_path)
` as const;

// ── Annotation (route) detection ──────────────────────────────────────────────
// @GetMapping("/path")  @PostMapping  @RequestMapping(value="/path", method=RequestMethod.GET)
// @RestController  @Controller
export const ANNOTATION_QUERY = `
(annotation
  name: (identifier) @annotation_name
  arguments: (annotation_argument_list
    (_) @annotation_arg)?)
` as const;

// ── Object creation ───────────────────────────────────────────────────────────
// new MongoClient(...)  new JdbcTemplate(...)
export const NEW_OBJECT_QUERY = `
(object_creation_expression
  type: (type_identifier) @class_name)
` as const;

// ── Method invocations ────────────────────────────────────────────────────────
// MongoClients.create(...)  DriverManager.getConnection(...)
export const METHOD_INVOCATION_QUERY = `
(method_invocation
  object: (identifier) @receiver
  name: (identifier) @method_name)
` as const;
