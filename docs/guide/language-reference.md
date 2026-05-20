# Language Reference

An `.ag` file is a sequence of top-level declarations. Order does not matter — the compiler resolves references.

## Component

Declares a logical unit of your system and maps it to a file-path footprint.

```ag
component <Name> {
  path: "<glob>"          # required — file paths this component owns
  tier: "<string>"        # optional — logical tier (e.g. "public", "internal", "data")
  language: "<string>"    # optional — hint for the extractor (e.g. "csharp", "python")
}
```

**Example:**

```ag
component PaymentService {
  path: "src/services/payment/**"
  tier: "internal"
}
```

## Infrastructure Node

Declares an external system (database, queue, cache, etc.) that is not a component in your codebase.

```ag
node <Name> {
  kind: "database" | "queue" | "cache" | "external" | "storage"
  host: "<string>"        # optional — connection host/URL hint
}
```

**Example:**

```ag
node LedgerDatabase {
  kind: "database"
}
```

## Flow

Declares a data-flow relationship between components or nodes.

```ag
flow <Name> {
  from: <ComponentOrNode>
  to:   <ComponentOrNode>
}
```

Flows can also be inline inside invariants:

```ag
invariant X {
  deny flow PublicGateway -> LedgerDatabase
}
```

## Invariant

The core enforcement primitive. An invariant declares a rule that must never be violated.

```ag
invariant <Name> {
  <rule>
}
```

### Rule types

| Rule | Description |
|------|-------------|
| `deny flow A -> B` | No code path may go from A to B |
| `require flow A -> B` | A must have a path to B |
| `deny tier <t1> -> <t2>` | No component in tier t1 may access tier t2 |
| `require encryption A -> B` | All flows A→B must use encrypted channels |
| `require auth A` | Component A must require authentication |

**Examples:**

```ag
# Deny direct public-to-database access
invariant SecureLedger {
  deny flow PublicGateway -> LedgerDatabase
}

# Enforce tier boundaries
invariant TierBoundary {
  deny tier "public" -> "data"
}

# Require auth on the admin panel
invariant AdminAuth {
  require auth AdminPanel
}
```

## Contract

Contracts define agreed-upon interface shapes between components, optionally imported from OpenAPI specs.

```ag
contract <Name> {
  GET  "/users/{id}" -> User
  POST "/orders"     -> Order
}
```

See [Contracts](./contracts) for details.

## Workflow Policy

`workflow_policy` blocks enforce GitHub Actions release and deployment safety. Workflow YAML files are modeled as regular components, and publish/deploy/release targets are modeled as CI/CD nodes.

```ag
node github_actions : ci_runner { trust: trusted }
node npm_registry : package_registry { trust: trusted auth: api_key }
node github_pages : static_host { trust: trusted auth: oauth2 }

component ReleaseWorkflow {
  runs_on: github_actions
  paths: ".github/workflows/release.yml"
}

workflow_policy ReleaseSafety {
  allow publish ReleaseWorkflow -> npm_registry when tag "v*.*.*"
  deny publish * -> npm_registry when pull_request
  require before ReleaseWorkflow "npm test" -> "npm publish"
  deny permission * contents: write when pull_request
}
```

Supported actions in v1 are `publish`, `deploy`, `release`, `permission`, and `before`. Conditions support `when tag "<glob>"`, `when branch "<glob>"`, and `when pull_request`.

CI/CD node types are `ci_runner`, `package_registry`, `container_registry`, `static_host`, and `release_host`.

## Change Policy

`change_policy` blocks enforce that related components are updated together in the same checked diff. This is useful for docs freshness, package metadata reviews, generated agent context, and release-safety workflows.

```ag
component CliCompiler {
  runs_on: node_runtime
  paths: "src/index.ts"
}

component CliReferenceDocs {
  runs_on: node_runtime
  paths: "docs/cli/reference.md"
}

component ReadmeDocs {
  runs_on: node_runtime
  paths: "README.md"
}

change_policy DocsFreshness {
  require touched CliReferenceDocs when touched CliCompiler
  require touched ReadmeDocs when touched CliCompiler
}
```

Semantics: if any staged file maps to the trigger component, at least one staged file must map to the required component. The gate emits Z3-backed `change_violations[]` in JSON verdicts when the implication cannot be satisfied.

Change policies prove that declared surfaces changed together; they do not prove that prose is semantically complete.

## Import

Import another `.ag` file to compose large specs:

```ag
import "./shared/base.ag"
import "./services/auth.ag"
```

Cyclic imports are detected and rejected at compile time.

## Comments

```ag
// Single-line comment

// There are no block comments
```
