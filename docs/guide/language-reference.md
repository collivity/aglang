# Language Reference

An `.ag` file is a sequence of top-level declarations. Order does not matter; the compiler resolves references during type checking.

## Enforcement Semantics

aglang declarations have explicit enforcement levels:

| Declaration | Level | Meaning |
|-------------|-------|---------|
| `invariant deny flow` | `formal_z3` | Extracted flow facts are checked against SMT-LIB constraints in Z3. |
| `invariant deny dataflow` | `formal_z3` | Dataflow facts inferred from handled data and extracted flows are checked in Z3. |
| `change_policy` | `formal_z3` | Touched-component facts are checked against SMT-LIB implication rules in Z3. |
| `contract` | `deterministic_policy` | Route facts are compared against declared implements/consumes contracts. |
| `workflow_policy` | `deterministic_policy` | GitHub Actions facts are checked for release, deploy, publish, permission, and step-order rules. |
| `invariant require encryption` | `advisory` | Reported as a warning because static extraction does not yet prove encryption. |
| `machine` | `advisory` | Emitted to agent context; transition extraction is not enforced yet. |
| `permission` | `advisory` | Emitted to agent context; access-control extraction is not enforced yet. |

`formal_z3` and `deterministic_policy` violations block checks. `advisory` declarations guide agents and docs, but do not block by themselves unless a future extractor/gate promotes them.

## Infrastructure Node

Declares an infrastructure or runtime entity that components run on or interact with.

```ag
node <name> : <node_type> {
  trust: trusted | untrusted | semi_trusted
  protocol: https | grpc | ws       // optional
  auth: none | jwt | oauth2 | api_key // optional
}
```

Example:

```ag
node api_runtime : server { trust: trusted protocol: https }
node ledger_db : postgres { trust: trusted auth: mtls }
```

Node types come from the stdlib, including `server`, `ci_runner`, `package_registry`, `static_host`, `release_host`, `postgres`, `redis`, `s3_bucket`, and `agent_runtime`.

## Component

Declares a logical code component and maps it to source files.

```ag
component <Name> {
  runs_on: <node_name>
  paths: "<glob>"
  role: presentation | application | domain | data_access | infrastructure | integration | test // optional
  layer: <LayerName>        // optional
  implements: <ContractName> // optional, comma-separated
  consumes: <ContractName>   // optional, comma-separated
  handles: <DataType>        // optional, comma-separated
  repo: <RepoName>           // optional
}
```

Example:

```ag
component PublicApi {
  runs_on: api_runtime
  paths: "src/api/**/*.ts"
  implements: UsersApi
}
```

## Resource

Declares an architectural capability that components may access, such as secure storage, local preferences, platform hardware, or external APIs.

```ag
resource <name> : <resource_type> {
  trust: trusted | untrusted | semi_trusted
  protocol: https | grpc | ws          // optional
  auth: none | jwt | oauth2 | api_key  // optional
}
```

Built-in resource types include `secure_storage`, `local_preferences`, `external_api`, `local_database`, `reactive_stream`, `message_bus`, `file_system`, `sensor`, and `device_hardware`.

Example:

```ag
resource SecureStorage : secure_storage { trust: trusted }
resource LocalPreferences : local_preferences { trust: semi_trusted }
resource ExternalNetwork : external_api { trust: untrusted protocol: https }
```

## Invariant

Flow invariants declare component or node relationships that must not be violated.

```ag
invariant <Name> {
  deny flow <ComponentOrNode> -> <ComponentOrNode>
  deny flow role <RoleName> -> resource <ResourceNameOrType>
  deny flow layer <LayerName> -> resource <ResourceNameOrType>
  deny dataflow <DataType> -> <ComponentOrNode>
  require encryption on flow <ComponentOrNode> -> <ComponentOrNode>
}
```

Example:

```ag
invariant Layering {
  deny flow PublicApi -> ledger_db
  deny flow role presentation -> resource secure_storage
}
```

`deny flow` is Z3-backed. `require encryption on flow` is currently advisory because extractors do not yet prove encrypted transport.

`deny dataflow` is also Z3-backed. It blocks when a component that `handles` a data type has an extracted flow to the denied target.

## Contract

Contracts define interface shapes between components.

```ag
contract UsersApi {
  GET  "/api/users"      -> User[]
  POST "/api/users"      -> User
  query viewer()         -> User
  rpc GetUser(UserId)    -> User
  publishes: "user.created"
  subscribes: "user.deleted"
}
```

Components opt into contract enforcement with `implements:` or `consumes:`.

## Workflow Policy

`workflow_policy` blocks enforce GitHub Actions release and deployment safety. Workflow YAML files are modeled as components, and publish/deploy/release targets are modeled as CI/CD nodes.

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

Supported actions are `publish`, `deploy`, and `release`. Conditions support `when tag "<glob>"`, `when branch "<glob>"`, and `when pull_request`.

## Change Policy

`change_policy` blocks enforce that related components are updated together in the same checked diff.

```ag
change_policy DocsFreshness {
  require touched CliReferenceDocs when touched CliCompiler
  require touched ReadmeDocs when touched CliCompiler
}
```

Semantics: if any staged file maps to the trigger component, at least one staged file must map to the required component. The gate emits Z3-backed `change_violations[]` when the implication cannot be satisfied.

Change policies prove that declared surfaces changed together; they do not prove that prose is semantically complete.

## State Machine

State machines describe allowed transitions for a data type field. They are advisory in the current runtime.

```ag
enum OrderStatus { Draft | Active | Archived }

data Order {
  status: OrderStatus
}

machine OrderLifecycle on Order.status {
  allow transition Draft -> Active
  deny transition Active -> Draft
}
```

## Permission

Permissions describe role/action rules. They are advisory in the current runtime.

```ag
enum Role { Admin | Member }

permission ProjectAccess on Project {
  allow Role.Admin -> *
  deny Role.Member -> delete
}
```

## Data And Enum

```ag
data User {
  id: UUID
  email: String
  roles: List<Role>
}

enum Role { Admin | Member }
```

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
```
