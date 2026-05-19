# How aglang Works

aglang is a **Dual-Compiler System**. Unlike a traditional language compiler (like `gcc` or `tsc`) that turns source code into machine code or JavaScript, aglang compiles your high-level system rules into mathematical equations, while a secondary extraction tool compiles incoming Git diffs into the exact same mathematical format. Z3, an industry-grade SMT solver from Microsoft Research, checks whether the two sides are compatible.

Here is the step-by-step breakdown of how an `.ag` file goes from a clean text specification to a live, real-time mathematical gate.

---

## The Compilation Pipeline

The process divides into two main phases:

- **Phase 1 — Build-Time Compilation** sets up the structural rules (you run this once per change to your spec)
- **Phase 2 — Commit-Time Evaluation** checks every incoming code change against those rules in real time

---

## Phase 1: Compiling the `.ag` Blueprint (Build-Time)

When you run `aglc compile`, the engine transforms your human-readable architectural descriptions into an intermediate logic representation.

### Step 1 — Lexing and Parsing (The AST)

The compiler reads your `.ag` file and parses it into an **Architecture Abstract Syntax Tree**. This tree identifies all components, flows, and invariants.

### Step 2 — Translating to First-Order Logic (SMT-LIB Format)

The compiler strips away the developer-friendly words and translates the invariants into standard **SMT-LIB** formulas — the universal language of math solvers like Z3.

For example, this invariant rule:

```ag
invariant SecureLedger {
  deny flow PublicGateway -> LedgerDatabase;
}
```

Gets compiled to a pure logical implication formula:

```
Flow(PublicGateway, LedgerDatabase) ⟹ Violation
```

### Step 3 — Emitting `architecture.o`

The compiler outputs a highly optimised, compiled JSON artifact (`architecture.o`). This file contains:

- **Mathematical constraints** — the SMT-LIB deny-flow formulas
- **Static string mappings** — e.g. `component PublicGateway` maps to directory glob `src/api/gateway/*`
- **Invariant metadata** — names, descriptions, confidence thresholds

---

## Phase 2: The Commit-Time Gate (Real-Time)

This is what happens the moment an agent or human types `git commit`. The Arch runtime springs into action.

```
   [Human/Agent edits code]
             │
             ▼
      (git commit hook)
             │
             ▼
  ┌──────────────────────┐
  │  Step 1: Parse Diff  │  git diff --cached → changed file paths
  └──────────┬───────────┘
             │
             ▼
  ┌───────────────────────────┐
  │  Step 2: AST Extraction   │  tree-sitter parses each changed file;
  │  (8 language extractors)  │  detects DB calls, imports, HTTP routes
  └──────────┬────────────────┘
             │  FlowFact[]
             ▼
  ┌──────────────────────────────┐
  │  Step 3: Delta Assertions    │  facts → (assert (Flow A B)) SMT-LIB
  └──────────┬───────────────────┘
             │
             ▼
  ┌──────────────────────────────┐
  │  Step 4: Load architecture.o │  permanent deny-flow constraints
  └──────────┬───────────────────┘
             │
             ▼
       ┌─────────────┐
       │  Z3 Solver  │  solver.check()
       └──────┬──────┘
              │
        ┌─────┴──────┐
        ▼            ▼
     UNSAT           SAT
  (no violation)  (violation found)
        │            │
        ▼            ▼
  Allow commit    Reject + proof
```

### Step 1 — Parsing the Git Diff

The runtime scans the staging area with `git diff --cached`. For each changed file (e.g. `src/api/gateway/checkout.py`), it consults the `architecture.o` mapping dictionary and tags the delta as belonging to the `PublicGateway` component.

### Step 2 — AST-Based Code Extraction

Each changed file is passed through a lightweight **language-specific extractor**. aglang ships extractors for 8 languages — all powered by [tree-sitter](https://tree-sitter.github.io/tree-sitter/) AST parsing (regex fallback for environments where the native binary is unavailable):

| Language | Detection examples |
|---|---|
| **TypeScript / JS** | `mongoose`, `pg`, `kafkajs`, `ioredis`, `@aws-sdk/client-s3`, Express/NestJS routes |
| **Python** | `psycopg2`, `pymongo`, `redis`, `sqlalchemy`, `boto3`, FastAPI/Flask routes |
| **C#** | `MongoClient`, `DbContext`, `IConnectionMultiplexer`, ASP.NET MVC routes |
| **Go** | `lib/pq`, `mongo-driver`, `go-redis`, Gin/chi/Fiber routes |
| **Rust** | `sqlx`, `mongodb`, `redis`, `rdkafka`, Actix-web/Axum routes |
| **Java** | `JpaRepository`, `MongoRepository`, `KafkaTemplate`, Spring MVC routes |
| **Kotlin** | Spring Boot annotations, Exposed/Ktor patterns |
| **Swift** | Vapor routes, Foundation URLSession calls |

The extractor answers: **"does this code talk to any infrastructure node?"** and emits a typed `FlowFact`:

```ts
{ from: 'PublicGateway', to: 'LedgerDatabase', confidence: 'definite', evidence: '...' }
```

### Step 3 — Emitting Delta Assertions

Each `FlowFact` is serialised into a dynamic SMT-LIB assertion:

```smt2
(assert (Flow PublicGateway LedgerDatabase))
```

### Step 4 — Z3 Checks the Combined State

The Arch runtime opens an in-memory Z3 context and loads **two things**:

1. **Permanent constraints** compiled from the `.ag` file — `(Flow(A,B) ⟹ Violation)`
2. **Dynamic assertions** extracted from the current diff — `(assert (Flow PublicGateway LedgerDatabase))`

Then it runs `solver.check()`:

- **UNSAT** — the assertions _cannot_ logically produce a violation. The commit passes (`exit 0`).
- **SAT** — a violation _is_ mathematically possible. The commit is blocked.

### Step 5 — Human-Readable Diagnostics

If Z3 returns SAT, it provides a raw model: `[src_tier = "public", tgt_tier = "internal", violation = true]`. The diagnostic layer maps those tokens back to your source file and the specific invariant name:

```
Arch Compilation Error (Rule: SecureLedger):

Your changes in src/api/gateway/checkout.py attempt to establish
a direct connection to LedgerDatabase. This component is explicitly
isolated from the PublicGateway tier.

Commit aborted.
```

---

## Why This Architecture?

| Property | How it's achieved |
|---|---|
| **Un-hallucinate-able** | Z3 is deterministic math, not an LLM guess |
| **Blazing fast** | Only the _changed_ files are extracted; Z3 runs in-process via WASM |
| **Language-agnostic** | SMT-LIB is the intermediate representation; extractors are pluggable |
| **No false negatives** | `fail-close`: if Z3 returns `unknown`, the commit is blocked |
| **Actionable errors** | Violations include the file, line, component name, and rule — not just "blocked" |

By decoupling the high-level design specification from the micro-analysis of Git diffs — using SMT formulas as the intermediate byte-code — aglang remains automated, precise, and auditable.

---

## Key Files

| File | Purpose |
|---|---|
| `architecture.ag` | Your human-readable spec |
| `architecture.o` | Compiled JSON artifact with SMT constraints + component mappings |
| `.git/hooks/pre-commit` | The gate that runs at every `git commit` |
| `skill.json` | AI agent manifest — describes the architectural rules in agent-readable form |
| `AGENTS.md` | Context file — agents read this to understand boundaries before coding |
