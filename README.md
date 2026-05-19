# aglang · Architecture Ground Language

**aglang** is a dual-compiler system that enforces architectural rules against real code at git-commit time using Z3 SMT solving. You describe your system's topology, components, invariants, and API contracts in a `.ag` spec file. The compiler turns those rules into mathematical constraints and checks every staged change against them before the commit lands.

---

## How it works

```
[Developer / Agent edits code]
         │
         ▼
  git commit (hook)
         │
         ▼
  aglc check-diff        ← parses staged files, extracts flow facts
         │
         ▼
  Z3 SMT solver          ← evaluates spec constraints against facts
         │
    ┌────┴────┐
  UNSAT      SAT
    │          │
  Allow      Reject + structured JSON proof
```

1. **Build time** — `aglc compile spec.ag` produces `architecture.o` (a JSON artifact with SMT constraints + path mappings).
2. **Commit time** — the installed git hook runs `aglc check-diff`, extracts flow facts from staged C#, TypeScript, or Kotlin files, feeds them and the compiled constraints to Z3, and blocks the commit if any invariant is violated.

---

## Features

| Feature | Description |
|---|---|
| **Topology nodes** | Model edge clients, servers, clusters, databases, caches, queues, object stores |
| **Components** | Map source-code globs to topology nodes |
| **Flow invariants** | Deny illegal data flows between components/nodes — checked by Z3 at every commit |
| **Contracts** | Declare REST/GraphQL API endpoint shapes; enforce that implementing components expose them and consuming components only call declared routes |
| **State machines** | Model entity lifecycle states and allowed transitions |
| **Permissions** | Declare role-based access rules per state |
| **Data & enums** | Define domain types for documentation and future extraction |
| **Multi-file specs** | Split large specs with `import "other.ag"` — shared DAG imports are deduplicated |
| **Agents context** | `aglc emit-context` produces `AGENTS.md` — a precise architectural brief for AI coding agents |
| **Skill manifest** | `aglc emit-skill` produces `skill.json` — a machine-readable skill descriptor for agent tool registries |
| **Structured errors** | All violations include JSON proof blocks with component names, file paths, and Z3 models |

---

## Quick start

```bash
npm install -g aglang          # or: npx aglc
```

### 1 — Write a spec

```ag
// myapp.ag
node web : edge_desktop { trust: untrusted }
node api : server       { trust: trusted }
node db  : postgres     { trust: trusted }

component Frontend {
  runs_on: web
  paths:   "src/frontend/**/*.ts"
}

component Api {
  runs_on: api
  paths:   "src/api/**/*.ts"
}

component Data {
  runs_on: api
  paths:   "src/data/**/*.ts"
}

invariant Layered {
  deny flow Frontend -> db   // frontend must never touch DB directly
  deny flow Api -> db        // API must go through Data layer
}
```

### 2 — Compile

```bash
aglc compile myapp.ag
# ✔ Compiled successfully → architecture.o
#   Components: 3  Invariants: 1  Contracts: 0
```

### 3 — Install the git hook

```bash
aglc install --arch architecture.o
# Installed pre-commit hook → .git/hooks/pre-commit
```

From now on, every `git commit` is checked against your architecture. Violations block the commit:

```
Arch Compilation Error (Rule: Layered)
  deny flow Api -> db

  Detected: ApiService → db (definite)
  Evidence: ApplicationDbContext injected via constructor
  File:     src/api/UserService.ts (line 12)

Commit aborted.
```

---

## API contracts

Enforce that your backend routes match your frontend expectations:

```ag
contract UsersApi {
  GET  "/api/users"       -> User[]
  POST "/api/users"       -> User
  GET  "/api/users/{id}"  -> User
  PUT  "/api/users/{id}"  -> User
}

component Backend {
  runs_on: api
  paths:   "src/api/controllers/**/*.cs"
  implements: UsersApi
}

component Frontend {
  runs_on: web
  paths:   "src/frontend/**/*.ts"
  consumes: UsersApi
}
```

The contract gate checks:
- **implements** — the C# controller exposes every declared route (missing routes = error)
- **consumes** — the TypeScript client only calls declared routes (undeclared fetch calls = warning)

---

## .ag language reference

### Node types (stdlib)

| Category | Types |
|---|---|
| Client | `edge_desktop`, `edge_mobile`, `edge_mobile(android)`, `edge_mobile(ios)` |
| Server | `server`, `cluster(k8s)`, `cluster(ecs)`, `serverless` |
| Database | `postgres`, `mysql`, `sqlite`, `relational_db`, `mongodb`, `dynamodb` |
| Cache | `redis`, `memcached`, `cache` |
| Queue | `rabbitmq`, `kafka`, `sqs`, `queue` |
| Storage | `s3`, `blob_storage`, `object_store` |
| Network | `load_balancer`, `cdn`, `api_gateway` |

### Blocks

```ag
// Node
node <name> : <type> {
  trust:        trusted | untrusted | semi_trusted
  connectivity: always_on | intermittent | offline_first   // optional
  protocol:     https | grpc | ws | mqtt                   // optional
}

// Component
component <name> {
  runs_on:    <node>
  paths:      "<glob>"
  implements: <ContractName>   // optional
  consumes:   <ContractName>   // optional
}

// Invariant
invariant <name> {
  deny flow <ComponentOrNode> -> <ComponentOrNode>
  require encryption <Component>                   // advisory (emits warning only)
}

// API contract
contract <name> {
  GET  "/api/path/{param}"  -> ResponseType
  POST "/api/path"          -> ResponseType
  // PUT, DELETE, PATCH also supported
}

// State machine
statemachine <EntityName> {
  states: Draft | Active | Archived
  transitions {
    Draft -> Active    { by: Admin | Editor }
    Active -> Archived { by: Admin }
  }
}

// Permissions
permission <name> {
  <Role> can <action> <Entity> when state = <State>
}

// Data types
data <Name> {
  field: Type
}

enum <Name> { Variant | Variant }

// Import
import "relative/path/other.ag"
```

---

## CLI commands

| Command | Description |
|---|---|
| `aglc compile <file.ag>` | Compile spec → `architecture.o` |
| `aglc check-diff --arch <arch.o>` | Check git staged files (used by hook) |
| `aglc check-file --arch <arch.o> --file <path>` | Check a single file (dev/debug) |
| `aglc emit-context --arch <arch.o>` | Write `AGENTS.md` (agent context brief) |
| `aglc emit-skill --arch <arch.o>` | Write `skill.json` (agent skill manifest) |
| `aglc install --arch <arch.o>` | Install pre-commit git hook |

**Flags:**
- `--json` — output structured JSON verdict (for CI/agent consumption)
- `--dump-smt` — print the raw SMT-LIB2 constraints (debugging)

---

## JSON verdict schema (v2)

All commands that check code emit a JSON object when `--json` is passed:

```jsonc
{
  "schema_version": 2,
  "passed": false,
  "timestamp": "2026-05-19T09:00:00.000Z",
  "artifact": "architecture.o",
  "violations": [
    {
      "type": "flow_violation",
      "invariant": "Layered",
      "rule": { "kind": "deny_flow", "from": "Api", "to": "db" },
      "detected": {
        "from": "Api",
        "to": "db",
        "confidence": "definite",
        "evidence": "ApplicationDbContext injected via constructor",
        "file": "/abs/path/to/file.cs"
      },
      "message": "..."
    }
  ],
  "contract_violations": [
    {
      "type": "implements_undeclared",
      "severity": "error",
      "contract": "UsersApi",
      "component": "Backend",
      "role": "implements",
      "extracted": "DELETE /api/users/{}",
      "declared": null
    }
  ],
  "warnings": [],
  "contract_warnings": [],
  "agent_context": "Human-readable summary for agent consumption"
}
```

---

## Agents & AI integration

aglang is designed as a first-class tool for AI coding agents:

- **`AGENTS.md`** — generated by `aglc emit-context`, gives the agent a precise brief: topology, component paths, allowed flows, contracts, state machines, and permission rules.
- **`skill.json`** — a machine-readable skill descriptor that agents can register as a tool.
- **Structured JSON errors** — every Z3 violation includes exact file paths, component names, and a proof object so agents can locate and fix the violation without hallucinating.
- **Fail-closed** — git diff failures and Z3 `unknown` results block the commit rather than silently allowing it.

---

## Supported extractors

| Language | What is extracted |
|---|---|
| **C# (.cs)** | Constructor injection, `new` instantiation, HttpClient base URLs, EF Core DbContext, Dapper, Redis, S3, Azure Blob, MongoDB, Kafka, RabbitMQ, SignalR |
| **TypeScript / TSX** | `fetch()` calls (method + URL extraction), Axios (planned) |
| **Kotlin (.kt)** | Retrofit annotations, OkHttp, Room, WorkManager |

---

## Development

```bash
git clone https://github.com/your-org/aglang
cd aglang
npm install
npm run build     # produces dist/index.js
npm test          # vitest — 41 tests
```

```bash
# Try the bundled Collivity example
node dist/index.js compile examples/collivity.ag
node dist/index.js check-file --arch examples/architecture.o --file examples/BadController.cs
```

---

## License

ISC — see [LICENSE](LICENSE).
