# aglang · Architecture Ground Language

**aglang** is a dual-compiler system that enforces architectural rules against real code at git-commit time using Z3 SMT solving. Describe your system's topology, components, invariants, and API contracts in a `.ag` spec file. The compiler turns those rules into mathematical constraints and checks every staged change against them before the commit lands.

Designed as an **agent-first guardrail**: `aglc generate` scans your codebase and produces a starter `.ag` file — AI agents can then refine the rules and every future commit (human or agent) is gated against them.

---

## How it works

```
[Developer / Agent edits code]
         │
         ▼
  git commit (pre-commit hook)
         │
         ▼
  aglc check              ← git diff → extracts flow facts from staged files
         │
         ▼
  Z3 SMT solver           ← evaluates spec constraints against delta facts
         │
    ┌────┴────┐
  UNSAT      SAT
    │          │
  Allow      Reject + structured JSON proof
```

1. **Build time** — `aglc compile spec.ag` produces `architecture.o` (a JSON artifact with SMT-LIB2 constraints + component→path mappings).
2. **Commit time** — the pre-commit hook runs `aglc check`, extracts flow facts from staged files (8 languages supported), feeds them with the compiled constraints to Z3, and blocks the commit if any invariant is violated.
3. **Agent bootstrap** — `aglc generate` scans any codebase, detects manifests (`package.json`, `*.csproj`, `go.mod`, `Cargo.toml`, …), extracts routes, and emits a compilable starter `.ag` file an agent can immediately extend with invariant rules.

---

## Requirements

- **Node.js ≥ 18** (WASM-based Z3 solver requires async/WASM support)
- Git (for the pre-commit hook and `aglc check`)

---

## Installation

```bash
# Global install from npm registry
npm install -g @collivity/aglang

# Install directly from GitHub (public repo, no registry needed)
npm install github:collivity/aglang

# Run without installing
npx @collivity/aglang --help
```

---

## Quick start

### Option A — Agent bootstrap (recommended for existing codebases)

```bash
# 1. Scan your project and generate a starter spec (one-shot setup)
npx @collivity/aglang add ./my-project --name MyProject

# The add command runs: generate → compile → install git hook → emit skill.json
# Review my-project/architecture.ag and add invariant rules, then re-run:
aglc compile my-project/architecture.ag
```

### Option B — Write a spec by hand

```ag
// myapp.ag
node web : edge_desktop { trust: untrusted }
node api : server       { trust: trusted   }
node db  : postgres     { trust: trusted   }

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
  deny flow Api -> db        // API layer must go through Data layer
}
```

```bash
aglc compile myapp.ag
# ✔ Compiled → architecture.o
#   Components: 3  Invariants: 1  Contracts: 0

aglc install --project . --arch architecture.o
# ✔ Installed pre-commit hook → .git/hooks/pre-commit
```

Every `git commit` is now checked. Violations are blocked with evidence:

```
Arch Compilation Error (Rule: Layered)
  deny flow Api -> db

  Detected: Api → db (definite)
  Evidence: ApplicationDbContext injected via constructor
  File:     src/api/UserService.cs

Commit aborted.
```

---

## Features

| Feature | Status | Description |
|---|---|---|
| **Topology nodes** | ✅ | Model edge clients, servers, clusters, databases, caches, queues, object stores |
| **Components** | ✅ | Map source-code globs to topology nodes |
| **Flow invariants** | ✅ | Deny illegal data flows — checked by Z3 at every commit |
| **Contracts** | ✅ | Declare REST/GraphQL API endpoint shapes; enforce implements + consumes at commit time |
| **State machines** | ✅ | Model entity lifecycle states and allowed transitions |
| **Permissions** | ✅ | Declare role-based access rules per state |
| **Data & enums** | ✅ | Define domain types for documentation |
| **Multi-file specs** | ✅ | Split large specs with `import "other.ag"` — shared DAG imports are deduplicated |
| **`aglc generate`** | ✅ | Scan any codebase and auto-emit a starter `.ag` spec (agent bootstrap) |
| **Import OpenAPI** | ✅ | `aglc import-openapi swagger.json` → `.ag` contract blocks |
| **Import Terraform** | ✅ | `aglc import-tf main.tf` → `.ag` node declarations |
| **Plugin protocol** | ✅ | Extend extraction via npm packages implementing the `aglc-plugin` protocol |
| **Agent context** | ✅ | `aglc emit-context` produces `AGENTS.md` — machine-verified architectural brief |
| **Skill manifest** | ✅ | `aglc emit-skill` produces `skill.json` for agent tool registries |
| **JSON verdicts** | ✅ | All check commands emit structured JSON with Z3 proofs (`--json`) |
| **Extraction cache** | ✅ | SHA-256 keyed file cache in `.aglang-cache/` — skips re-analysing unchanged files |
| **Parallel extraction** | ✅ | All extractors run concurrently (CPU-capped pool) |

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
- **implements** — every declared route must be exposed by the component (missing routes = error)
- **consumes** — the client may only call declared routes (undeclared `fetch` calls = warning)

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
  require encryption <Component>  // advisory — emits warning, does not block commit
}

// API contract
contract <name> {
  GET    "/api/path/{param}"  -> ResponseType
  POST   "/api/path"          -> ResponseType
  PUT    "/api/path/{id}"     -> ResponseType
  DELETE "/api/path/{id}"     -> ResponseType
  PATCH  "/api/path/{id}"     -> ResponseType
}

// State machine
statemachine <EntityName> {
  states: Draft | Active | Archived
  transitions {
    Draft  -> Active   { by: Admin | Editor }
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

// Multi-file
import "relative/path/other.ag"
```

---

## CLI commands

| Command | Description |
|---|---|
| `aglc compile <file.ag>` | Compile spec → `architecture.o` |
| `aglc generate [dir] [--out <file.ag>] [--name <n>]` | Scan codebase → starter `.ag` spec |
| `aglc check --arch <arch.o> --project <dir>` | Check staged git diff (used by hook) |
| `aglc check-file --arch <arch.o> --file <path>` | Check a single file (dev/debug) |
| `aglc emit-context --arch <arch.o> [--out <path>]` | Write `AGENTS.md` (agent context brief) |
| `aglc emit-skill --arch <arch.o> [--out <path>]` | Write `skill.json` (agent skill manifest) |
| `aglc install [--project <dir>] [--arch <arch.o>]` | Install pre-commit git hook |
| `aglc import-openapi <swagger.json> [--out <f.ag>]` | Import OpenAPI 3.x → `.ag` contracts |
| `aglc import-tf <main.tf> [--out <f.ag>]` | Import Terraform → `.ag` node declarations |

**Flags:**
- `--json` — machine-readable JSON to stdout (progress logs go to stderr)
- `--dump-smt` — write the raw SMT-LIB2 script to `examples/debug.smt2`

---

## JSON verdict schema (v2)

All check commands emit a JSON object when `--json` is passed:

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
      "rule": { "kind": "DenyFlow", "from": "Api", "to": "db" },
      "detected": {
        "from": "Api",
        "to": "db",
        "confidence": "definite",
        "evidence": "ApplicationDbContext injected via constructor",
        "file": "/abs/path/to/file.cs"
      },
      "message": "...",
      "z3_proof": {
        "permanent_constraint": "(assert (=> (Flow Api db) false))",
        "delta_assertion": "(assert (Flow Api db))",
        "explanation": "Z3 returned UNSAT — both assertions cannot be simultaneously true"
      }
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

- **`aglc generate`** — a setup agent runs this once to bootstrap guardrails for any codebase; outputs a compilable `.ag` file to review and extend.
- **`AGENTS.md`** — generated by `aglc emit-context`, gives agents a precise brief: topology, component paths, allowed flows, contracts, state machines, and permission rules. Fits in any context window.
- **`skill.json`** — a machine-readable skill descriptor agents can register as a tool.
- **Structured JSON errors** — every Z3 violation includes exact file paths, component names, and the Z3 proof object so agents can locate and fix violations without hallucinating.
- **Fail-closed** — git diff failures and Z3 `unknown` results block the commit; nothing is silently allowed.

### Typical agent workflow

```
1. Setup agent: aglc generate . --out arch.ag
   → reviews, adds invariant rules, runs: aglc compile arch.ag
   → runs: aglc install --arch architecture.o

2. Coding agents: edit code → git commit
   → pre-commit hook fires: aglc check --arch architecture.o --project .
   → Z3 blocks commit if invariant is violated
   → agent reads the structured JSON error, fixes the violation, recommits
```

---

## Supported extractors

| Language | Extensions | What is extracted |
|---|---|---|
| **C#** | `.cs` | Constructor injection (DI), EF Core DbContext, HttpClient, Redis, S3/Blob, MongoDB, Kafka, RabbitMQ, SignalR |
| **TypeScript / JS** | `.ts`, `.tsx`, `.js`, `.jsx` | `fetch()` calls (method + URL), Express/Fastify route declarations |
| **Python** | `.py` | SQLAlchemy, Django ORM, psycopg2, Redis, Celery, requests/httpx calls |
| **Go** | `.go` | `database/sql`, GORM, Redis, Kafka, HTTP client calls |
| **Rust** | `.rs` | `sqlx`, `diesel`, `redis`, `reqwest`, `tokio` |
| **Java / Scala** | `.java`, `.scala` | Spring Data, Hibernate, JDBC, Kafka, Redis, RestTemplate |
| **Kotlin** | `.kt` | Retrofit, OkHttp, Room, WorkManager, Ktor |
| **Swift / iOS** | `.swift` | URLSession, Alamofire, CoreData, CloudKit, Combine network calls |

All extractors run in parallel with a CPU-capped concurrency pool. Results are cached by file SHA-256 in `.aglang-cache/` — unchanged files are never re-analysed.

### Plugin protocol

Third-party extractors can be loaded as npm packages:

```ag
// In your .ag spec file
plugin "aglc-plugin-my-extractor"
```

Any npm package that exports `{ info(), extract(input) }` and responds to `--info` / `--extract` CLI flags qualifies. Run `npx aglc` — the plugin is auto-discovered and invoked for each file batch matching its declared extensions.

---

## Development

```bash
git clone https://github.com/collivity/aglang
cd aglang
npm install
npm run build    # tsup → dist/index.js (~160KB, bundles z3-solver WASM)
npm test         # vitest — 127 tests across 9 test files
```

```bash
# Try the bundled Collivity example
node dist/index.js compile examples/collivity.ag
node dist/index.js check-file --arch examples/architecture.o --file examples/BadController.cs
node dist/index.js emit-context --arch examples/architecture.o
```

---

## What's left before publishing

The codebase is production-grade in design but still a pre-release (`0.1.0`). What to do before `npm publish`:

1. **Set a GitHub remote** — `git remote add origin https://github.com/your-org/aglang`
2. **Add `"repository"` to `package.json`** — required by npm
3. **Benchmark extraction accuracy** — measure false-positive rate against real codebases
4. **LSP / VS Code extension** — `.ag` syntax highlighting and autocomplete
5. **Semantic extraction** (stretch goal) — replace regex with Roslyn (C#) / tsc API (TS) for deeper accuracy

---

## License

ISC — see [LICENSE](LICENSE).
