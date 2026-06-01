# Language Reference

An `.ag` file is a sequence of top-level declarations. Order does not matter; the compiler resolves references during type checking.

## Enforcement Semantics

aglang declarations have explicit enforcement levels:

| Declaration | Level | Meaning |
|-------------|-------|---------|
| `invariant deny flow` | `formal_z3` | Extracted flow facts are checked against SMT-LIB constraints in Z3. |
| `invariant deny reach` | `formal_z3` | Transitive flow reachability is checked in Z3. |
| `invariant require flow` / `deny path_without_via` | `formal_z3` | Definite source-to-target paths must pass through the required intermediate endpoint. |
| `invariant require dataflow` / `deny data_path_without_via` | `formal_z3` | Definite data paths must pass through the required intermediate endpoint. |
| `invariant require auth/encryption/dependency/operation` | `formal_z3` | Reviewed counterexample facts block when they prove unauthenticated, unencrypted, wrong-interface dependency, or wrong-component operation evidence. |
| `invariant deny dataflow` | `formal_z3` | Dataflow facts inferred from handled data and extracted reachability are checked in Z3. |
| `data_policy` | `formal_z3` | Data classification and jurisdiction rules are checked against propagated data reachability. |
| `trust_policy` | `formal_z3` | Trust-boundary auth and classified data boundary rules are checked from extracted facts and declared node metadata. |
| `change_policy` | `formal_z3` | Touched-component facts are checked against SMT-LIB implication rules in Z3. |
| `di_policy` | `formal_z3` | Definite constructor-injection, lifetime, and service-locator facts are checked in Z3. |
| `machine` | `formal_z3` | Extracted transition facts are checked against declared state-machine transitions. |
| `value_policy` | `formal_z3` | Reviewed scalar and collection value facts are checked against required value predicates. |
| `operation_policy` | `formal_z3` | Reviewed before/after operation facts are checked against preconditions and postconditions. |
| `event_policy` | `formal_z3` | Reviewed event facts are checked against scoped temporal precedence rules. |
| `contract` | `deterministic_policy` | Route facts are compared against declared implements/consumes contracts. |
| `workflow_policy` | `deterministic_policy` | GitHub Actions facts are checked for release, deploy, publish, permission, and step-order rules. |
| `permission` | `formal_z3` | Authorization intent is emitted and can be enforced when extractors produce definite operation and role-check evidence. |

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

`require` rules are the preferred readable syntax for positive architecture intent. Evidence-backed `require` rules compile to deny-counterexample checks, so enforcement blocks only when deterministic extractors or reviewed `.agq.yml` queries emit definite bad evidence. Teams that prefer policy-style authoring can write the equivalent `deny` counterexample form directly.

```ag
invariant EvidenceBacked {
  require flow Api -> Db via Repository
  require dataflow CustomerProfile -> Partner via Scrubber
  require auth on flow Client -> Api
  require encryption on flow Api -> Partner
  require operation serialization on CustomerProfile in Serializer
  require dependency Service -> Repository via interface IOrderRepository

  deny path_without_via Api -> Db via Repository
  deny data_path_without_via CustomerProfile -> Partner via Scrubber
  deny unauthenticated flow Client -> Api
  deny unencrypted flow Api -> Partner
  deny operation serialization on CustomerProfile outside Serializer
  deny dependency Service -> Repository without interface IOrderRepository
}
```

`require contract OrdersApi implemented_by OrdersController` is deterministic: the checker validates that the component declares `implements: OrdersApi`. Auth, encryption, dependency, and operation facts come from deterministic extractors or reviewed `.agq.yml` files; `aglc check` does not call an LLM to infer them.

Flow invariants declare component or node relationships that must not be violated.

```ag
invariant <Name> {
  deny flow <ComponentOrNode> -> <ComponentOrNode>
  deny reach <ComponentOrNode> -> <ComponentOrNode>
  deny flow role <RoleName> -> resource <ResourceNameOrType>
  deny flow layer <LayerName> -> resource <ResourceNameOrType>
  deny dataflow <DataType> -> <ComponentOrNode>
  require flow <ComponentOrNode> -> <ComponentOrNode> via <ComponentOrNode>
  require flow role <RoleName> -> resource <ResourceNameOrType> via <ComponentOrNode>
  require operation <operationName> in <ComponentOrNode>
  require encryption on flow <ComponentOrNode> -> <ComponentOrNode>
}
```

Example:

```ag
invariant Layering {
  deny flow PublicApi -> ledger_db
  deny flow role presentation -> resource secure_storage
  require flow PublicApi -> ledger_db via Repository
  require operation serialization in Serializer
}
```

`deny flow` is direct-only for compatibility. Use `deny reach` to block transitive paths such as `UI -> Service -> Db`.

`require flow A -> B via C` blocks when a definite extracted path from `A` to `B` exists and `C` is not an intermediate node on that path. `via` must be between the source and target; using the source or target does not satisfy the requirement. The `from`, `to`, and `via` positions support the same entity, role, layer, and resource selector expansion used by `deny flow`.

`require operation serialization in Serializer` blocks when a definite reviewed `.agq.yml` query emits an operation fact for `serialization` in any other component. Operation placement is query-first; `aglc check` does not call an LLM to infer operation facts.

`require encryption on flow` blocks when deterministic extractors or reviewed `.agq.yml` files emit definite `encrypted: false` evidence. Missing encryption evidence does not block by itself.

`deny dataflow` is also Z3-backed. It blocks when a component that `handles` a data type can reach the denied target through one or more extracted flows.

Operation facts can be emitted by reviewed extraction queries:

```yaml
emit:
  kind: operation
  operation: serialization
  component: "$subject"
```

## Rich Runtime Policies

`value_policy`, `operation_policy`, and `event_policy` cover evidence-backed value invariants, pre/postconditions, and temporal protocols. They block only when deterministic extractors or reviewed `.agq.yml` files emit definite facts.

```ag
enum CartPhase { Empty | SingleItem | MultiItem }
enum OrderStatus { Draft | Submitted }

data Cart {
  phase: CartPhase
  items: List<String>
}

data Order {
  status: OrderStatus
  total: Money
}

data UserSession {
  gdprAccepted: Bool
}

value_policy CartShape {
  require Cart.items.length == 1 when Cart.phase == SingleItem
  require Order.total >= 0
  require UserSession.gdprAccepted == true
}

operation_policy SubmitOrderRules {
  require before submitOrder Cart.phase == SingleItem
  ensure after submitOrder Order.status == Submitted
}

event_policy ConsentProtocol {
  require event AcceptConsent preceded_by ShowConsent by UserSession
}
```

Supported value operators are `==`, `!=`, `>`, `<`, `>=`, and `<=`. Numeric comparisons require numeric fields. Enum comparisons are checked against declared enum values.

Reviewed queries can emit the facts these policies consume:

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
  phase: before
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

Missing value, operation, or event evidence is non-blocking. For conditional value rules, the `when` condition must also be backed by a definite value fact before a contradictory requirement blocks.

## Data Metadata And Policies

Data declarations can carry classification and jurisdiction metadata:

```ag
data CustomerProfile {
  classification: pii
  jurisdiction: eu
  id: UUID
}
```

`data_policy` blocks use those labels over propagated data reachability:

```ag
data_policy Privacy {
  deny classification pii -> untrusted
  deny jurisdiction eu -> NonGdprService
}
```

The first rule blocks classified data reaching any declared entity whose trust metadata is `untrusted`. The second blocks data with a specific jurisdiction from reaching a named component, node, or resource.

## Trust Policy

Trust policies use `trust:` and `auth:` metadata from nodes and resources. Components inherit metadata from their `runs_on` node.

```ag
trust_policy Boundaries {
  require auth untrusted -> trusted
  deny flow trusted -> untrusted when data pii
}
```

`require auth` blocks an extracted path from an untrusted entity to a trusted entity when the target has no declared auth. `deny flow ... when data` blocks classified data crossing the declared trust boundary.

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

## Dependency Injection Policy

`di_policy` blocks enforce dependency injection boundaries when the runtime can extract definite DI facts. The built-in C# extractor currently detects constructor injection, `AddSingleton` / `AddScoped` / `AddTransient` registrations, and `IServiceProvider` / `GetRequiredService<T>` service-locator usage.

```ag
component Views {
  runs_on: app_runtime
  paths: "src/**/Views/**/*.xaml.cs"
}

component ViewModels {
  runs_on: app_runtime
  paths: "src/**/ViewModels/**/*.cs"
}

component BleManager {
  runs_on: app_runtime
  paths: "src/**/Infrastructure/Bluetooth/**/*.cs"
}

component Repositories {
  runs_on: app_runtime
  paths: "src/**/Infrastructure/Persistence/**/*.cs"
}

component Application {
  runs_on: app_runtime
  paths: "src/**/Application/**/*.cs"
}

di_policy DependencyInjection {
  deny inject Views -> BleManager
  deny inject_reach Views -> Repositories
  deny inject ViewModels -> Repositories
  deny lifetime singleton -> scoped
  deny lifetime_reach singleton -> scoped
  deny resolve IServiceProvider from Application
}
```

Semantics:

- `deny inject A -> B` blocks a constructor dependency from component `A` to component `B`.
- `deny inject_reach A -> B` blocks a transitive constructor dependency path from component `A` to component `B`.
- `deny lifetime singleton -> scoped` blocks a singleton-registered service depending on a scoped-registered service.
- `deny lifetime_reach singleton -> scoped` blocks a transitive lifetime path from singleton to scoped.
- `deny resolve IServiceProvider from Application` blocks service-locator access from `Application`.

Each blocking DI fact becomes an SMT assertion such as `(assert (Injects Views BleManager))`, `(assert (InjectReach Views Repositories))`, or `(assert (LifetimeReach Lifetime__singleton Lifetime__scoped))`. The compiled `di_policy` contributes the opposite implication, so Z3 returns UNSAT and the JSON verdict reports a `di_violation`.

## State Machine

State machines describe allowed transitions for a data type field. They are enforced when deterministic extractor queries emit transition facts from reviewed `.agq.yml` files.

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

The enforcement path is:

1. The `machine` declaration compiles into allowed and denied transition constraints in `architecture.o`.
2. Built-in or plugin extractors produce deterministic graph facts from source code.
3. Committed `.aglang/extractors/*.agq.yml` files match those graph facts and emit transition facts with query provenance.
4. `aglc check` asserts definite transition facts into Z3 and reports `state_machine_violation` when a transition contradicts the machine.
5. `aglc explain --arch architecture.o --project . --violation <id> --json` re-runs the selected scope and returns the repair-loop explanation for the stable violation id.

Transition query files are auditable source artifacts. LLMs may help draft them when requested, but `aglc check` does not call an LLM.

When a transition fact has no resolved `from` state (unguarded assignment), aglang treats it as an unknown source:

- **Deny rules** with `from: *` block the target state for any unguarded write.
- **Allow-only machines** block unguarded writes unless an `allow transition * -> <target>` rule exists.

This is how consent flows catch `session.consent = Accepted` without a prior `Presented` guard.

### Consent-first UX

Model consent as an enum field, not as a screen route graph (unless you add project-specific navigation `.agq.yml` later):

```ag
enum ConsentStatus { Unknown | Presented | Accepted | Rejected }

data UserSession {
  consent: ConsentStatus
}

machine ConsentLifecycle on UserSession.consent {
  allow transition Unknown -> Presented
  allow transition Presented -> Accepted
  deny transition Unknown -> Accepted
}
```

Pair with `.aglang/extractors/consent-lifecycle.agq.yml` that matches `assignment` graph facts on `consent` and emits `transition` facts. See `examples/consent-and-cart-protocol/`.

### Shared mutable protocol (cart phase)

Prefer a protocol enum over raw collection length:

```ag
enum CartPhase { Empty | SingleItem | MultiItem }

data SharedCart {
  phase: CartPhase
}

machine CartProtocol on SharedCart.phase {
  allow transition Empty -> SingleItem
  allow transition SingleItem -> MultiItem
  deny transition Empty -> MultiItem
}
```

Use `.agq.yml` to emit transitions from `phase` assignments. This catches workflows that skip `SingleItem` even when they share one array in memory.

### Compliance via imports

`require flow Checkout -> ApiClient via Compliance` works with component import facts: checkout must import the compliance module before reaching the API client component. UI navigation graphs still need custom `.agq.yml` `flow` emit rules per framework.

A blocking JSON verdict includes the machine name, transition edge, source file, evidence, query id/version/file, graph fact id when available, stable violation id, and conflicting Z3 assertions.

## Permission

Permissions describe role/action rules. They are formal when extractors provide definite authorization evidence; otherwise they remain agent-visible intent.

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
  classification: pii
  jurisdiction: eu
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
