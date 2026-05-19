# aglang — Project Status Report
*Generated: 2026-05-19*

---

## What Has Been Built

aglang is a **dual-compiler architecture enforcement system**:

1. **Build-time**: A DSL compiler (`aglc compile`) reads `.ag` spec files and produces `architecture.o` — a JSON artifact containing SMT-LIB constraints (Z3 formulas) and component→file mappings.
2. **Commit-time**: A gate (`aglc check`) reads staged git changes, extracts architectural facts from real code (C#, TypeScript, Kotlin), and feeds them into Z3. UNSAT = violation, commit blocked.
3. **Agent context**: `aglc emit-context` generates `AGENTS.md` — a machine-verified markdown file that tells AI agents exactly what is and isn't allowed in the codebase.

### Language Features Implemented
- `node`, `component`, `invariant` — topology and flow rules  
- `enum`, `data` — domain types and data contracts  
- `state machine` — lifecycle modeling  
- `permission` — role-based access rules  
- `contract` — HTTP API surface contracts (implements/consumes)  
- Multi-file import system with cycle detection  
- Z3 UNSAT core attribution (violations linked to source lines)  
- Language extractor plugins (C#, TypeScript, Kotlin)

### CLI Commands
```
aglc compile   <spec.ag>                     → architecture.o
aglc check     --arch architecture.o --project <dir>   (git diff mode)
aglc check-file --arch architecture.o --file <path>    (single file)
aglc emit-context --arch architecture.o      → AGENTS.md
aglc install   --arch architecture.o --project <dir>   → git hook
```

---

## Strict Audit (2026-05-19)

### 🔴 Blocking Issues — Must Fix Before Any Public Release

| # | Issue | File | Impact |
|---|-------|------|--------|
| 1 | `noEmit: true` in tsconfig — `npm run build` emits nothing | `tsconfig.json:7` | Published CLI is dead |
| 2 | Shell injection in hook installer + uses `tsx` (devDep) | `src/index.ts:112-129` | Security + consumers can't run hook |
| 3 | Shared import DAG (A→B→D, A→C→D) throws false "Circular import" | `src/importer.ts:21-31` | Multi-file specs can't be shared |
| 4 | Multi-contract: route valid in ContractA flagged in ContractB | `src/runtime/contract-gate.ts:164-190` | False positives block valid commits |
| 5 | Gate fails OPEN on `git diff` error or Z3 `unknown` | `diff-parser.ts:26-35`, `solver.ts` | Security: bad code silently passes |
| 6 | `RequireEncryption` rules emit SMT but are never enforced | `src/smt/translator.ts:84-88` | Misleading enforcement claim |
| 7 | Zero test files — `npm test` exits 1 | `tests/` (empty) | Any change can break the gate silently |
| 8 | No `README.md`, no `LICENSE` | repo root | OSS publication blocked |

### 🟡 Non-Blocking Bugs

| # | Issue | File |
|---|-------|------|
| 9 | C# analyzer: S3/Blob/Redis clients all map to `postgres_db` | `src/analyzers/csharp.ts:150-158` |
| 10 | `globToFiles` hand-parses globs — breaks on brace patterns, Windows paths | `src/runtime/contract-gate.ts:81-95` |
| 11 | Duplicate declaration names silently overwrite earlier ones | `src/checker.ts:57-76` |
| 12 | `schema_version` alternates 1 vs 2 across CLI output paths | `src/index.ts`, `src/runtime/diagnostic.ts` |
| 13 | Compiled artifacts embed absolute local paths (non-portable) | `src/emitters/artifact.ts` |

### Work Queue (Priority Order)

```
🔴 fix-tsconfig-emit          Fix tsconfig: noEmit blocks dist/ generation
🔴 fix-hook-security          Fix install hook: shell injection + missing binary
🔴 fix-importer-dag           Fix importer: shared import DAG falsely cycles
🔴 fix-multi-contract         Fix contract gate: route flagged across all contracts
🔴 fix-gate-fail-open         Fix gate: fail closed on toolchain errors
🔴 fix-encryption-unimpl      Document/fix RequireEncryption (not actually enforced)
🔴 add-tests-lexer-parser     Add tests: lexer + parser + checker
🔴 add-tests-analyzers        Add tests: csharp + typescript analyzers
🔴 add-tests-gate             Add tests: Z3 gate + contract gate
🔴 add-readme                 Add README.md
🔴 add-license                Add LICENSE file
🔴 fix-package-hygiene        Fix package.json: author, files whitelist, prepublish

🟡 fix-csharp-node-map        Fix C# analyzer: S3/Redis → wrong node
🟡 fix-glob-completeness      Fix globToFiles: use micromatch.scan()
🟡 fix-duplicate-decls        Fix checker: reject duplicate declaration names
🟡 fix-schema-version         Normalize schema_version across all CLI paths
🟡 fix-leaked-paths           Use relative paths in emitted artifacts
```

---

## Does This Project Make Sense?

### The Honest Answer: Yes — and it's early for a real reason.

#### What makes it genuinely novel

Every existing tool addresses part of the problem. Nothing addresses all three together:

| Tool | Spec | Extraction | Formal proof |
|------|------|------------|--------------|
| ArchUnit (Java) | ❌ code only | ✅ | ❌ pattern matching |
| Deptrac (PHP/any) | ❌ YAML rules | ✅ | ❌ graph traversal |
| Structurizr / C4 | ✅ | ❌ diagrams only | ❌ |
| TLA+ / Alloy | ✅ | ❌ | ✅ math only |
| OpenAPI | ✅ (API surface) | partial | ❌ |
| **aglang** | ✅ | ✅ | ✅ Z3 |

The combination — declarative spec + code extraction + Z3 formal proof + git gate — is **genuinely new**. The "AGENTS.md as commit-checked ground truth" pattern is independently useful and has no direct precedent.

#### Why agents make this MORE relevant, not less

The standard argument against formal verification tooling is: "just write good tests." That breaks down under agentic development:

- **Agents write code 24/7 at velocity no human can review**. A CI pipeline that runs 200 times per day needs automated architectural gates, not human review.
- **Agents don't read architecture docs they didn't generate**. AGENTS.md as a machine-verified, compiler-enforced source of truth is exactly what agents need — not wikis, not PRs, not comments.
- **Agents hallucinate across component boundaries**. An agent fixing a bug in a controller will naturally reach for the database directly because it's the simplest path. Z3 blocks that path formally.
- **Context windows limit what agents know**. A 200KLOC codebase doesn't fit in context. `AGENTS.md` is a compressed, verified summary of the rules that do fit.

#### The real competitive threat

Not other tools. The real threat is: **agents get good enough that they reliably follow architectural rules without enforcement**. This would make aglang's Z3 gate unnecessary.

This is unlikely in the near term because:
1. Agents operate across sessions with no persistent memory of past architectural decisions
2. Multiple agents with different system prompts working on the same repo have no shared contract
3. "The agent usually follows the rules" is not the same as "the agent cannot violate the rules"

The value proposition is the **cannot** — formal impossibility, not best-effort compliance.

#### Where the project is genuinely hard

| Challenge | Current state | Path forward |
|-----------|---------------|--------------|
| Extraction quality | Regex-based — fragile on complex patterns | Roslyn (C#), tsc API (TS) for semantic extraction |
| Cross-language flows | Only same-language facts | Inter-service contract blocks (already started) |
| False positive rate | Unknown (no benchmarks) | Test suite with real-world codebases |
| Spec authoring burden | Moderate | LSP/VS Code extension for autocomplete |
| Agent adoption | Zero (no npm publish) | Fix build, publish, add to agent skill manifest |

#### What it is right now

A **working prototype** with a complete and coherent design. The language is expressive and the Z3 integration is real. The contract block feature (commit-time API contract enforcement) is novel and immediately useful even without Z3.

The implementation has 8 blocking bugs that prevent publication — but none of them are design problems. They're all fixable in a focused session.

---

## Tomorrow's Session — Recommended Start Order

1. **Fix `tsconfig.json`** (15 min) — Switch to `tsup` or `tsconfig.build.json`. Verify `node dist/index.js` works.
2. **Fix importer DAG** (20 min) — Two-set DFS. Add a test fixture immediately after.
3. **Fix multi-contract gate** (10 min) — Change inner loop logic to "pass if in any contract".
4. **Fix gate fail-open** (20 min) — `git diff` failure → exit 1. Z3 `unknown` → exit 1 with message.
5. **Fix hook injection** (20 min) — Shell-quote paths, use `node dist/index.js` not `tsx`.
6. **Write tests** (2-3 hours) — Lexer, parser, gate, contract gate. This is the biggest time investment and the biggest risk reducer.
7. **Add README + LICENSE** (30 min) — Prerequisite for `npm publish`.
8. **Fix package.json** (10 min) — `files` whitelist, `prepublishOnly`, author.

After those 8 items: `npm publish` is safe.

---

*Built with: TypeScript, Z3 SMT solver (z3-solver npm), micromatch, vitest*  
*Architecture: Dual-compiler (build-time spec → SMT, commit-time code → delta assertions)*
