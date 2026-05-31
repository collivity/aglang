# How aglang Works

aglang is a **dual-compiler system with explicit enforcement semantics**. Unlike a traditional language compiler (like `gcc` or `tsc`) that turns source code into machine code or JavaScript, aglang compiles high-level system rules into a checked artifact, while runtime gates extract facts from code, workflows, and diffs. Some hard rules are proven with solver-backed checks; others are deterministic policy checks; advisory declarations are emitted to agent context without blocking by themselves.

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

The compiler strips away the developer-friendly words and translates formal rules into standard **SMT-LIB** formulas that a solver can evaluate precisely.

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

The compiler outputs a compiled JSON artifact (`architecture.o`). This file contains:

- **Mathematical constraints** — the SMT-LIB deny-flow formulas
- **Static string mappings** — e.g. `component PublicGateway` maps to directory glob `src/api/gateway/*`
- **Invariant metadata** — names, descriptions, confidence thresholds
- **Enforcement taxonomy** — whether each declaration kind is `formal_z3`, `deterministic_policy`, or `advisory`

---

## Phase 2: The Check Gate

This is what happens when an agent, human, or CI job runs `aglc check`.

```
   [Human/Agent edits code]
             │
             ▼
        aglc check
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
       SAT          UNSAT
  (no violation)  (violation found)
        │            │
        ▼            ▼
  Allow commit    Reject + proof
```

## Enforcement Levels

| Level | Used for | Meaning |
|---|---|---|
| `formal_z3` | `deny flow`, `deny reach`, `require flow`, `require operation`, `deny dataflow`, `data_policy`, `trust_policy`, `di_policy`, `permission`, `change_policy`, `machine` | Facts are asserted into SMT and checked by Z3 when extractors or reviewed queries produce definite evidence. |
| `deterministic_policy` | `contract`, `workflow_policy` | Extracted facts are checked by deterministic code paths with exact diagnostics. |
| `formal_z3` | `require encryption` / `deny unencrypted flow` | Rules block when deterministic extractors or reviewed `.agq.yml` files emit definite unencrypted-flow evidence. |

This distinction is part of the product contract: aglang should not imply that advisory declarations are formally enforced.

### Step 1 — Parsing the Git Diff

The runtime scans the staging area with `git diff --cached`. For each changed file (e.g. `src/api/gateway/checkout.py`), it consults the `architecture.o` mapping dictionary and tags the delta as belonging to the `PublicGateway` component.

### Step 2 — AST-Based Code Extraction

Each changed file is passed through a lightweight **language-specific extractor**. aglang ships extractors for 8 languages — all powered by [tree-sitter](https://tree-sitter.github.io/tree-sitter/) AST parsing (regex fallback for environments where the native binary is unavailable):

| Language | Detection examples |
|---|---|
| **TypeScript / JS** | `mongoose`, `pg`, `kafkajs`, `ioredis`, `@aws-sdk/client-s3`, Express/NestJS routes |
| **Python** | `psycopg2`, `pymongo`, `redis`, `sqlalchemy`, `boto3`, FastAPI/Flask routes |
| **C#** | Constructor injection, DI lifetimes, `IServiceProvider`, `MongoClient`, `DbContext`, `IConnectionMultiplexer`, ASP.NET MVC routes |
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

For dependency-injection policies, C# constructor/lifetime/service-locator facts are serialized into predicates such as:

```smt2
(assert (Injects Views BleManager))
(assert (LifetimeDepends Lifetime__singleton Lifetime__scoped))
(assert (Resolves Application IServiceProvider))
```

### Step 4 — The Solver Checks the Combined State

The aglang runtime opens an in-memory solver context and loads **two things**:

1. **Permanent constraints** compiled from the `.ag` file — `(Flow(A,B) ⟹ Violation)`
2. **Dynamic assertions** extracted from the current diff — `(assert (Flow PublicGateway LedgerDatabase))`

Then it runs `solver.check()`:

- **SAT** — the extracted facts do not contradict any hard rule. The check passes (`exit 0`).
- **UNSAT** — at least one extracted fact contradicts a hard rule. The check is blocked with the conflicting assertions as proof.

### Step 5 — Human-Readable Diagnostics

If a gate finds a violation, the diagnostic layer maps the extracted fact back to your source file and the specific rule name:

```
aglang Architecture Compilation Error (Rule: SecureLedger):

Your changes in src/api/gateway/checkout.py attempt to establish
a direct connection to LedgerDatabase. This component is explicitly
isolated from the PublicGateway tier.

Commit aborted.
```

---

## Why This Architecture?

| Property | How it's achieved |
|---|---|
| **Un-hallucinate-able** | The solver is deterministic math, not an LLM guess |
| **Blazing fast** | Only the _changed_ files are extracted; the solver runs in-process via WASM |
| **Language-agnostic** | SMT-LIB is the intermediate representation; extractors are pluggable |
| **No false negatives** | `fail-close`: if the solver returns `unknown`, the commit is blocked |
| **Actionable errors** | Violations include the file, line, component name, and rule — not just "blocked" |

By decoupling the high-level design specification from the micro-analysis of Git diffs — using SMT formulas as the intermediate byte-code — aglang remains automated, precise, and auditable.

---

## Key Files

| File | Purpose |
|---|---|
| `architecture.ag` | Your human-readable spec |
| `architecture.o` | Compiled JSON artifact with SMT constraints + component mappings |
| `skill.json` | AI agent manifest — describes the architectural rules in agent-readable form |
| `AGENTS.md` | Context file — agents read this to understand boundaries before coding |
