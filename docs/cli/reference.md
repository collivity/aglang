# CLI Reference

## `aglc request-scan`

Emit a machine-readable task packet that asks an agent to perform architecture discovery and proposal work. This command does not infer architecture intent and does not edit `.ag` files.

```bash
aglc request-scan [--project <dir>] [--out <task.json>]
```

Default output: `.aglang/tasks/architecture-discovery.json`.

The task packet instructs the agent to inspect the repo semantically, separate observed facts from intended rules, draft `architecture.proposed.ag`, draft `.agq.yml` query proposals when useful, and ask for human approval before enforcement.

---

## `aglc request-review`

Emit a machine-readable task packet that asks an agent to review proposed architecture artifacts before compile/check enforcement.

```bash
aglc request-review [--project <dir>] [--out <task.json>]
```

Default output: `.aglang/tasks/architecture-review.json`.

The task packet tells the agent to review `.ag`, `.agq.yml`, generated context, weak evidence, empty query matches, ownership gaps, and approval questions. It does not approve or compile architecture changes.

---

## `aglc add`

Legacy one-shot starter workflow: generate a draft architecture spec, compile it, and emit agent context. Prefer `aglc request-scan` for agent-assisted semantic discovery when adopting a real repo.

```bash
aglc add [projectRoot] [--name <ProjectName>] [--out <file.ag>] [--max-depth <n>] [--single-file]
```

| Flag | Description | Default |
|------|-------------|---------|
| `projectRoot` | Directory used for deterministic starter synthesis | `.` (current directory) |
| `--name` | Override the project name in the generated spec | Inferred from manifests |
| `--out` | Output path for the `.ag` file | `<projectRoot>/architecture.ag` |
| `--max-depth` | Maximum recursive component-synthesis depth | `3` |
| `--single-file` | Inline all generated components instead of writing imported sub-specs | `false` |

---

## `aglc compile`

Compile a `.ag` spec file into a binary `architecture.o` artifact.

```bash
aglc compile <file.ag> [--out <file.o>]
```

| Flag | Description | Default |
|------|-------------|---------|
| `file.ag` | Path to the spec file | required |
| `--out` | Output path for `.o` artifact | `architecture.o` alongside `.ag` |

Plugin declarations are compiled into the artifact's `plugins[]` list:

```ag
plugin "@collivity/aglc-roslyn"
```

---

## `aglc generate`

Generate a draft `.ag` starter from deterministic repo evidence. This is not architecture intent inference; review the output with a human or agent before using it as enforcement truth.

```bash
aglc generate [projectRoot] [--out <file.ag>] [--name <n>] [--max-depth <n>] [--single-file]
```

By default, generation is extractor-guided and deep:

- keeps mixed-language roots instead of collapsing to a single manifest
- splits oversized areas into imported `.ag` sub-specs
- uses manifests as hints, but synthesizes components from real source layout and extracted facts

Use `--single-file` when you need stdout-friendly output or want one flat starter file.

For agent-native adoption, use `aglc request-scan` to create an architecture discovery task instead of relying on generated starter structure as truth.

---

## `aglc check`

Check the current staged git diff, or the whole guarded project, against a compiled architecture artifact.

```bash
aglc check --arch <architecture.o> --project <dir> [--diff <ref>] [--all] [--json] [--debug-extractors] [--require-ast] [--workflow-z3] [--dump-workflow-smt]
```

| Flag | Description |
|------|-------------|
| `--arch` | Path to compiled `.o` artifact |
| `--project` | Git project root to scan |
| `--diff <ref>` | Scan files changed in `<ref>...HEAD` instead of the staged diff |
| `--all` | Scan all tracked component files instead of only staged changes |
| `--json` | Output machine-readable JSON verdict to stdout |
| `--debug-extractors` | Include extractor trace events and fallback reasons in JSON output |
| `--require-ast` | Fail when an AST-capable extractor falls back to regex for a detected fact |
| `--workflow-z3` | Include workflow policy SMT debug snippets in workflow violations |
| `--dump-workflow-smt` | Write workflow policy SMT debug snippets to `workflow-debug.smt2` |
| `--ui` | Persist the selected check scope under `.aglang/ui/runs/<run-id>` and launch the local UI workbench |

`aglc check` also evaluates reachability, propagated dataflow, `data_policy`, `trust_policy`, `di_policy`, `machine`, `value_policy`, `operation_policy`, `event_policy`, and `change_policy` blocks against the staged diff, against `<ref>...HEAD` when `--diff` is used, or against every tracked component file when `--all` is used. Reachability and trust failures appear as `reach_violation`, `data_policy_violation`, or `trust_policy_violation` entries in `violations[]`; dependency-injection failures appear as `di_violation`; state-machine failures appear as `state_machine_violation`; rich policy failures appear as `value_policy_violation`, `operation_policy_violation`, or `event_policy_violation`; change policy failures appear in `change_violations[]`.

In JSON mode, project checks include `diff.changed_files`, `diff.changed_components`, `diff.mode`, and `rule_coverage[]`. Violations include stable `id` values; when `--diff <ref>` is used, returned violations are marked with `status: "new"` because the check scope is limited to files changed in the selected comparison.

The gate also checks rule-sized SMT slices before the full solver script. JSON output includes `solver_diagnostics[]` with per-slice status, elapsed time, source file, contributing components, path depth, fanout, and suggested refactor text when a slice returns `unknown` or gets expensive. This is the path-explosion escape hatch: AGLang reports the rule and source evidence that made the solver struggle instead of only reporting a global Z3 failure.

**Exit codes:**
- `0` — No violations (commit may proceed)
- `1` — Violations found (commit blocked)

---

## `aglc check-file`

Analyze a specific file against the architecture. Coding agents should use this during focused edits before running broader project or CI checks.

```bash
aglc check-file --arch <architecture.o> --file <path> [--json] [--debug-extractors] [--require-ast] [--dump-smt] [--workflow-z3] [--dump-workflow-smt]
```

| Flag | Description |
|------|-------------|
| `--file` | File to analyze |
| `--debug-extractors` | Include extractor trace events and fallback reasons in JSON output |
| `--require-ast` | Fail when an AST-capable extractor falls back to regex for a detected fact |
| `--dump-smt` | Write the SMT-LIB script to `examples/debug.smt2` |
| `--workflow-z3` | Include workflow policy SMT debug snippets in workflow violations |
| `--dump-workflow-smt` | Write workflow policy SMT debug snippets to `workflow-debug.smt2` |

When debugging tree-sitter extraction, use:

```bash
aglc check-file --arch architecture.o --file src/api/orders.ts --json --debug-extractors
```

The JSON payload will include `extractor_debug[]` with parser availability, AST query counts, and fallback events. Add `--require-ast` to turn a silent fallback into a failing extractor error.

If a declared extractor plugin fails before emitting facts, JSON mode returns `extractor_error` in the verdict envelope.

---

## `aglc explain`

Explain a current violation by stable ID without editing files.

```bash
aglc explain --arch <architecture.o> --project <dir> --violation <id> [--json] [--diff <ref>] [--all]
```

The command re-runs the selected check scope, finds the matching violation, and reports the violated rule, source evidence, graph fact chain when available, proof details, `fix_class`, and suggested fix text. Use the same `--diff` or `--all` scope that produced the violation ID.

---

## `aglc debug`

Write a debug bundle for both agents and engineers. The command runs the same extraction and gates as `check`, then writes structured evidence plus a readable report.

```bash
aglc debug --arch <architecture.o> --project <dir> [--file <path>] [--diff <ref>] [--all] [--out <dir>] [--debug-extractors] [--require-ast]
```

Default output: `.aglang/debug`.

The bundle contains:

- `debug.json` — complete structured packet for agent consumption.
- `engineer.md` — human-readable report showing scope, evidence counts, checked rules, violations, solver diagnostics, and suggested agent tasks.
- `graph.json` — extracted graph facts and projections.
- `verdict.json` — check verdict for the selected scope.
- `rules.json` — architecture rules and component mappings.
- `agent-tasks.json` — suggested follow-up tasks for an agent.
- `query-traces.json` — `.agq.yml` matches, substitutions, emitted fact ids, and skipped-match reasons.

Use this when a check result is unclear, a file maps unexpectedly, extractors emit weak evidence, or an agent needs the graph/rule context before proposing a fix.

Add `--ui` to write the bundle as a UI run and launch the local workbench:

```bash
aglc debug --arch architecture.o --project . --all --ui
```

---

## `aglc ui`

Launch a local read-only workbench backed by `aglc debug` evidence bundles.

```bash
aglc ui --arch <architecture.o> --project <dir> [--all|--diff <ref>|--file <path>] [--port <n>] [--no-open]
```

Defaults: `--all`, an ephemeral available port, and automatic browser open only in an interactive local terminal. The server binds to `127.0.0.1`, always prints its URL, stores run history under `.aglang/ui/runs`, and writes local UI config to `.aglang/ui/config.json`.

The workbench exposes:

- `GET /api/config` — architecture, project root, declared repos, and local path status.
- `GET /api/runs` and `GET /api/runs/:id` — persisted run list and run payloads.
- `POST /api/runs` — execute a new debug-backed run for `all`, `diff`, or `file` scope.
- `GET /api/files?path=...&line=...` — read-only source snippets scoped to the project root.

---

## `aglc install-agent-skill`

Install the generic aglang Codex skill shipped in the npm package.

```bash
aglc install-agent-skill [--path <skills-dir>]
```

Default output is `${CODEX_HOME:-~/.codex}/skills/aglang`. This gives agents a reusable interface to aglang commands and workflows. Project-specific architecture rules still come from `AGENTS.md` and `skill.json`.

Use `--path <skills-dir>` to install into a custom skill directory:

```bash
aglc install-agent-skill --path ./tmp-skills
```

The npm package also runs a best-effort `postinstall` step that copies the same skill into `${CODEX_HOME:-~/.codex}/skills/aglang`. This postinstall never fails the npm installation if the copy cannot be completed.

Opt out of postinstall skill installation:

```bash
AGLANG_SKIP_AGENT_SKILL_INSTALL=1 npm install -g @collivity/aglang
```

---

## `aglc emit-context`

Generate an `AGENTS.md` file describing the architecture for AI agents.

```bash
aglc emit-context --arch <architecture.o> [--out <path>]
```

Default output: `AGENTS.md` in the current directory.

---

## `aglc emit-skill`

Generate a `skill.json` manifest for AI agent toolchains.

```bash
aglc emit-skill --arch <architecture.o> [--out <path>]
```

Default output: `skill.json` in the current directory.

---

## `aglc import-openapi`

Import an OpenAPI 3.x spec and generate `.ag` contract blocks.

```bash
aglc import-openapi <swagger.json> [--out <file.ag>]
```

---

## `aglc import-tf`

Import a Terraform configuration and generate `.ag` node declarations.

```bash
aglc import-tf <main.tf> [--out <file.ag>]
```

---

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output to stdout; progress to stderr |
| `--debug-extractors` | Include extractor trace output and fallback reasons |
| `--require-ast` | Fail when an AST-capable extractor falls back to regex for a detected fact |
| `--dump-smt` | Write Z3 SMT-LIB input to `examples/debug.smt2` |
| `--workflow-z3` | Include workflow policy SMT debug snippets |
| `--dump-workflow-smt` | Write workflow policy SMT debug snippets |
