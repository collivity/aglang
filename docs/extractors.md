# Extractors

aglang ships with built-in extractors for 8 language ecosystems. Each extractor scans source files and extracts:

- **Routes** — HTTP endpoints, gRPC methods, queue consumers
- **Dependencies** — database clients, HTTP clients, SDK calls
- **Components** — service boundaries inferred from project manifests

## Supported languages

| Language | Manifest | What's extracted |
|----------|----------|-----------------|
| **TypeScript / JavaScript** | `package.json` | Express/Fastify/Hapi routes, fetch/axios calls, DB clients (pg, mysql2, mongoose, redis) |
| **C#** | `.csproj` | ASP.NET controllers + minimal API routes, `HttpClient`, EF Core, Dapper, Npgsql, MongoDB, Redis |
| **Python** | `pyproject.toml`, `requirements.txt`, `setup.py` | FastAPI/Flask/Django routes, SQLAlchemy, psycopg2, pymongo, redis-py |
| **Go** | `go.mod` | net/http + gorilla/mux + gin + echo + fiber handlers, database/sql, gorm, mongo-go-driver |
| **Rust** | `Cargo.toml` | Actix-web, Axum, Rocket handlers, diesel, sqlx, tokio-postgres |
| **Java / Kotlin (JVM)** | `build.gradle`, `pom.xml` | Spring MVC/Boot controllers, JDBC, JPA, MyBatis |
| **Swift** | `Package.swift`, `Podfile` | Vapor routes, URLSession, Alamofire, SPM module imports, UIKit MVVM + Combine Input/Output patterns, Keychain, UserDefaults |
| **Terraform** | `*.tf` | Infrastructure resources → `node` declarations (via `aglc import-tf`) |

## How extraction works

1. **Manifest discovery** — `aglc generate` finds project manifests recursively under `projectRoot`
2. **Language detection** — manifest type determines which extractor runs
3. **Code fact extraction** — tree-sitter, AST, and language-specific patterns pull routes, dependencies, DI edges, workflow facts, and semantic graph facts
4. **Semantic query evaluation** — committed `.aglang/extractors/*.agq.yml` files match graph facts and emit reviewed domain facts such as transitions or flows
5. **Emit and check** — extracted and query-emitted facts are checked against the compiled `.ag` model, with provenance in JSON verdicts

## Audited semantic layer

The core verification model separates deterministic graph facts from reviewed semantic interpretation.

- Built-in and plugin extractors produce normalized graph facts with source provenance.
- `.agq.yml` files are committed source artifacts that describe which graph facts matter to the architecture.
- Query-emitted facts carry query id, version, query file, and matched graph fact id when available.
- `aglc check` never calls an LLM. If an LLM helped draft a query, the reviewed query file is what gets executed.

This lets teams audit both sides of the extraction boundary: the raw source evidence and the semantic rule that promoted it into a blocking architecture fact.

## Plugin protocol

You can add custom extractors without forking aglang. Plugins are extension points for stronger repo-specific evidence; they are not required for the core verification loop. Declare plugin packages directly in the `.ag` spec:

```ag
plugin "@collivity/aglc-roslyn"
plugin "aglc-plugin-my-extractor"
```

Each package is discovered by npm package name and must implement the subprocess contract:

```bash
plugin-package --info
plugin-package --component Api --mappings "{\"Api\":\"src/**/*.cs\"}" --files src/OrdersController.cs
```

`--info` returns JSON such as:

```json
{
  "name": "@collivity/aglc-roslyn",
  "extensions": [".cs", ".csx"],
  "version": "0.1.0"
}
```

Extraction prints normalized `FlowFact[]` JSON. Graph-native extractors may also emit `GraphFact[]` with `properties` for deterministic semantic queries. aglang preserves extractor provenance in graph output and prefers plugin facts over duplicate local extractor edges when they describe the same effective flow.

## Auditable semantic queries

Project-specific semantic extraction can live in committed `.aglang/extractors/*.agq.yml` files. These queries match deterministic graph facts and emit domain facts such as state-machine transitions, architecture flows, named operations, value facts, operation before/after facts, or scoped events. LLMs may help author these files, but `aglc check` only runs the reviewed query files.

Root self-spec queries should be scoped to the component that owns the evidence, usually with an exact `subject` filter. Do not target tests, generated site output, or intentional violation fixtures unless the goal is to make those files block normal checks.

### Starter templates

```bash
aglc install-extractors [--project <dir>] [--force]
```

Scaffolds two starter `.agq.yml` files into `<project>/.aglang/extractors/`. They become normal, locally-owned, reviewable files at that point — edit, narrow, or delete them like any other committed source file. Re-running the command skips files that already exist unless `--force` is passed.

- `resolved-calls-as-flow.agq.yml` — promotes a resolved cross-component method call (e.g. `repo.save(order)` resolving into a data-access component) into a `flow` fact, the same way importing a database driver package already does automatically.
- `resolved-internal-imports-as-flow.agq.yml` — does the same for a resolved relative import between components.

Both match on the `resolved: true` property that the extractor stamps on `calls`/`imports` edges once it has traced the call or import to its target across files. **That cross-file resolution exists for TypeScript, JavaScript, C#** (`src/ir/semantic-index.ts`) **and Python, Go, Rust, Java, Swift** (`src/ir/cross-file-linker.ts`). The two resolvers cover different shapes of the same problem: `semantic-index.ts` resolves arbitrary symbol references (including instance-method calls when traceable) for the first group; `cross-file-linker.ts` resolves in-project imports and free-function/package-or-module-qualified calls (Go's `pkg.Func()`, Python's `module.func()`, Java's `ClassName.staticMethod()`, Rust's `module::func()`, Swift's `Target.func()`) for the second group, but not instance-variable-mediated calls (`x := New(); x.Method()`) in any language — that needs real type inference, not call-graph resolution, and is out of scope for both resolvers today. Both ship with `confidence: probable`, which `aglc check` treats as non-blocking evidence rather than a violation (only `confidence: definite` facts block by default) — review what they surface in your own call graph before tightening the confidence level.

### Abstraction (extends/implements) resolution

A class/struct/protocol/trait relationship — `class X extends Y implements Z`, Rust's `impl Trait for Type`, Swift's conformance list — is extracted as an `extends`/`implements` Ag-IR edge and resolved against the project's declared symbols the same way `calls`/`imports` are, for **TypeScript/JavaScript/C#** (`src/ir/semantic-index.ts`) and **Python/Java/Rust/Swift** (`src/ir/abstraction-resolver.ts`). Once resolved, it carries `resolved: true`/`targetComponent` just like the starter templates above, so the same pattern works today with no new code: `match: { kind: [extends, implements], resolved: true }`.

**Go is structurally different and handled separately**: Go interfaces are satisfied implicitly — a struct never references the interface it satisfies anywhere in its own syntax, so there's nothing to read like the other languages' explicit clauses. `abstraction-resolver.ts` instead compares method **name+arity** sets project-wide (not real type checking — no parameter/return type comparison, no embedded-interface handling) and emits a `probable`-confidence `implements` edge when a struct's methods are a superset of an interface's. Interfaces with fewer than 2 required methods are skipped entirely to avoid false matches on common single-method interfaces (`Close() error`, `String() string`-style) that would otherwise match unrelated structs by name alone.

This layer deliberately does not resolve calls through an interface-typed field or parameter (`this.repo.save()` where `repo: IRepository`) — that needs tracking a variable's *declared* type first, which is a separate, not-yet-built piece. What's built today is the relationship graph and an interface-to-implementors index (`buildImplementorIndex` in `abstraction-resolver.ts`), ready for that future work to consume.

```yaml
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
```

Queries can also turn semantic graph evidence into a normal `flow` fact:

```yaml
id: SharedPersistenceAuthFlow
owner: platform
version: 1
confidence: definite
match:
  kind: di_registration
  service: IAuthTokenValidator
emit:
  kind: flow
  from: "$subject"
  to: SharedAuth
```

Operation facts support placement requirements such as `require operation serialization in Serializer`:

```yaml
id: SerializationOperations
owner: platform
version: 1
confidence: definite
match:
  kind: call
  method: serialize
emit:
  kind: operation
  operation: serialization
  component: "$subject"
```

When a query emits a blocking fact, JSON verdicts include the query id, version, query file, and matched graph fact id when available so the extraction result is auditable. Transition facts without a resolved `from` state are warning-only: they are reported as evidence, but are not asserted into Z3.

A query can match the abstraction-resolution edges from the section above directly — no new code, just a `match` clause on `kind` and `resolved`:

```yaml
id: RepositoryInterfaceFlow
owner: platform
version: 1
confidence: probable
match:
  kind: [extends, implements]
  resolved: true
emit:
  kind: flow
  from: "$subject"
  to: "$targetComponent"
```

## Testing a query before wiring it in

Real bugs have shipped in this project's *own* `.agq.yml` queries — a typo'd capture variable, a `match` clause that looked right but never matched a real fact — because there was no way to check a query in isolation. `aglc query-test` closes that gap: it runs one query against hand-written fixture facts and reports, per fact, whether it matched, what it would emit, or exactly why it didn't.

A fixture is a short YAML list — only `kind` and `properties` are required, everything else (id, subject, evidence) gets a sensible default:

```yaml
# facts.yml
- kind: calls
  properties:
    resolved: true
    component: ApiControllers
    targetComponent: DataLayer
```

```bash
aglc query-test --query resolved-calls-as-flow.agq.yml --fixture facts.yml
```

```
Query: ResolvedCallsAsFlow (resolved-calls-as-flow.agq.yml)

✓ fixture-0: matched, emits flow — from=ApiControllers, to=DataLayer

1/1 fixture fact(s) matched and emitted.
```

Don't already know what fields to put in the fixture? `aglc query-test --query <file> --init-fixture` scaffolds a starter fixture from the query's own `match` clause.

**Here's the exact bug class this catches**, shown deliberately broken. This query has a typo — `propery` instead of `property` — that's easy to miss reading the YAML:

```yaml
# typo-transition.agq.yml — note "propery", not "property"
id: OrderLifecycleTransitionsBroken
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  propery: status
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
```

```yaml
# facts.yml
- kind: assignment
  properties:
    property: status
    valueEnum: OrderStatus
    valueMember: Archived
    previousMember: Active
```

```bash
aglc query-test --query typo-transition.agq.yml --fixture facts.yml
```

```
Query: OrderLifecycleTransitionsBroken (typo-transition.agq.yml)

✗ fixture-0: match criteria did not match graph fact

0/1 fixture fact(s) matched and emitted.
```

The `match` clause asked for a field called `propery`, which doesn't exist on the fact, so the match silently fails — exactly the kind of mistake that, without this command, would only surface as "the query isn't catching anything in real code," with no indication of why. `aglc query-test` turns that into an immediate, specific answer before the query is ever wired into `.aglang/extractors/`.

## OpenAPI import

If you have an existing OpenAPI 3.x spec, skip extraction entirely:

```bash
aglc import-openapi swagger.json --out contracts.ag
```

This generates contract blocks for all paths, which you can merge into your main `.ag` file.
## Counterexample Emit Kinds

Reviewed `.aglang/extractors/*.agq.yml` files can emit counterexample facts for evidence-backed `require` rules. `aglc check` evaluates committed query files deterministically; it does not call an LLM.

```yaml
emit:
  kind: auth
  from: "$caller"
  to: "$target"
  authenticated: false
```

```yaml
emit:
  kind: encryption
  from: "$caller"
  to: "$target"
  encrypted: false
```

```yaml
emit:
  kind: operation
  operation: serialization
  data: CustomerProfile # optional
  component: "$subject"
```

```yaml
emit:
  kind: dependency
  from: "$subject"
  to: "$target"
  interface: IOrderRepository # optional
```

Only definite bad evidence blocks by default. Missing auth, encryption, dependency, or operation evidence is not treated as a violation.

## Rich Policy Emit Kinds

`value_policy`, `operation_policy`, and `event_policy` consume reviewed semantic query facts.

```yaml
emit:
  kind: value
  subject: Cart
  path: items.length
  relation: "=="
  value: "$actualLength"
```

```yaml
emit:
  kind: operation_event
  operation: submitOrder
  phase: before # or after
  subject: Cart
  path: phase
  relation: "=="
  value: "$phase"
```

```yaml
emit:
  kind: event
  event: "$eventName"
  scope: UserSession
```

These facts carry the same provenance fields as transitions: query id, version, query file, source file, line, and matched graph fact id.

### Numeric requirements get real Z3 arithmetic, not symbol matching

When a `value_policy`/`operation_policy` requirement's field resolves to a numeric `data` type (`Int`, `Float`, or `Money`), the compiled check uses real SMT-LIB `Int`/`Real` comparisons instead of treating the relation and value as opaque atoms:

```ag
data Order {
  total: Int
}

value_policy OrderShape {
  require Order.total <= 1000
}
```

```yaml
# .aglang/extractors/order-total.agq.yml
id: ObservedOrderTotal
owner: checkout
version: 1
confidence: definite
match:
  kind: value
emit:
  kind: value
  subject: "$subject"
  path: "$path"
  relation: "$relation"
  value: "$value"
```

You can check the query alone first with `aglc query-test` (see above) using a fixture like:

```yaml
- kind: value
  subject: Order
  properties:
    subject: Order
    path: total
    relation: "=="
    value: 1500
```

Once wired into a real check, an extracted fact reporting an observed total of `1500` makes the JSON verdict's `z3_proof` show a real arithmetic derivation, not a restated decision:

```jsonc
{
  "type": "value_policy_violation",
  "z3_proof": {
    "permanent_constraint": "(assert (=> (> (FieldValueInt Order FieldPath__Order__total) 1000) false))",
    "delta_assertion": "(assert (= (FieldValueInt Order FieldPath__Order__total) 1500))",
    "explanation": "Z3 returned UNSAT because reviewed value evidence from query 'ObservedOrderTotal' contradicts value_policy 'OrderShape'."
  }
}
```

Z3 genuinely derives `1500 > 1000`; it isn't told the answer. String/bool/enum comparisons (`require Cart.phase == SingleItem`) are unaffected and still use the original symbolic model, since there's no arithmetic to do there. Numeric-ness is detected automatically — from the field's declared type, and from whether the captured value is a bare `$capture` (no surrounding text in the `value:` template) — so no `.agq.yml` authoring changes are needed either way.
