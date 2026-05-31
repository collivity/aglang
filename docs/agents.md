# AI Agents

aglang is an **auditable architecture verification layer** that agents can consume while they work. AI coding agents are a primary workflow because they benefit from machine-readable architecture truth, but the same checked `.ag`, `.agq.yml`, `architecture.o`, and JSON verdicts are useful to engineers and CI.

## Why agents need architectural guardrails

When an AI agent refactors code, it may:
- Introduce a direct connection between tiers that should be isolated
- Add a database call in a public-facing handler
- Bypass an auth layer "for simplicity"
- Inject infrastructure into UI code, create singleton-to-scoped DI bugs, or use `IServiceProvider` as a service locator

Traditional code review catches these eventually. aglang catches them while the agent is still coding, then enforces the same rules at commit time with source evidence, deterministic policy checks, and Z3-backed proof details.

## Setup for agents

### 0. Install the generic skill interface

```bash
aglc install-agent-skill
```

This installs the packaged `aglang` Codex skill into `${CODEX_HOME:-~/.codex}/skills/aglang`, so agents know the CLI workflows after npm install. This is generic product knowledge; project-specific rules still come from `AGENTS.md` and `skill.json`.

When installed from npm, aglang also attempts this step automatically during `postinstall`. Set `AGLANG_SKIP_AGENT_SKILL_INSTALL=1` to opt out.

### 1. One-shot bootstrap

```bash
aglc add /path/to/project --name MyApp
```

This legacy starter command creates:
- `architecture.ag` — the spec (agents should read this)
- `architecture.o` — the compiled artifact
- `skill.json` — agent skill manifest

`.ag` files are engineer-guided architecture source. Coding agents should not create, edit, regenerate, or compile changes to `.ag` specs unless the engineer explicitly asks for architecture/spec work, ideally in a planning or design session.

Semantic query files in `.aglang/extractors/*.agq.yml` are also reviewed architecture source. They translate deterministic graph facts into domain facts such as state-machine transitions, architecture flows, or named operations. Agents may inspect them to understand provenance, but should ask before creating or changing them.

For agent-native adoption, prefer task packets:

```bash
aglc request-scan --project . --out .aglang/tasks/architecture-discovery.json
aglc request-review --project . --out .aglang/tasks/architecture-review.json
```

These commands notify the agent what work is requested. The agent performs semantic scanning, proposal, and review; aglc remains the deterministic compiler/checker for approved artifacts.

### 2. Emit agent context

```bash
aglc emit-context --arch architecture.o --out AGENTS.md
```

`AGENTS.md` is a plain-English description of your architecture rules, suitable for any agent's context window. Commit it to your repo so agents discover it automatically.

### 3. Emit skill manifest

```bash
aglc emit-skill --arch architecture.o --out skill.json
```

`skill.json` follows the emerging AI skill/tool manifest format. Agents that support it can load architectural constraints, command templates, violation schema fields, query provenance, diff metadata, and solver diagnostics as part of their toolchain.

## Continuous validation loop

```
Agent reads AGENTS.md → edits code → aglc check-file --json
                                  → aglc check --all --json
                                  → aglc explain --violation <id> --json
                                  → CI can run the same gate
                                                        │
                                          Z3 SAT   → pass ✓
                                          Z3 UNSAT → fix reported code ✗
```

## JSON mode for programmatic integration

All check commands support `--json` for machine-readable output:

```bash
aglc check-file --arch architecture.o --file src/api/gateway/checkout.py --json
aglc check --arch architecture.o --project . --all --json
aglc explain --arch architecture.o --project . --violation viol_4d72958c9c079a2f --json
```

```json
{
  "verdict": "violation",
  "rule": "SecureLedger",
  "component": "PublicGateway",
  "file": "src/api/gateway/checkout.py",
  "line": 44,
  "message": "Direct flow to LedgerDatabase is denied by invariant SecureLedger"
}
```

Agents can parse this JSON and decide how to fix the violation rather than reading terminal output. For blocking verdicts, the stable `id` should be passed to `aglc explain --violation <id> --json` to get the deterministic repair-loop explanation.

## Workflow for agent-managed projects

1. **Setup** — an engineer requests `aglc request-scan`, then an authorized agent proposes architecture artifacts for review.
2. **Agent reads** — coding agents read `AGENTS.md` and `skill.json` before making implementation changes.
3. **Agent validates while coding** — run `aglc check-file --json` for focused edits.
4. **Agent validates before finishing** — run `aglc check --all --json` for the guarded project.
5. **Architecture evolves deliberately** — agents ask before changing `.ag`, `.agq.yml`, `architecture.o`, `AGENTS.md`, `skill.json`, or generated context.

When `reach_violation`, `data_policy_violation`, or `trust_policy_violation` entries appear in `violations[]`, use `detected.path`, `detected.data`, and the Z3 proof to remove the forbidden path or add the declared auth/trust boundary the architecture requires.

When `require_flow_violation` or `require_operation_violation` entries appear in `violations[]`, fix the implementation so the required path or operation placement is satisfied. Operation facts come from reviewed `.agq.yml` files; do not edit `.ag` or `.agq.yml` to satisfy a require violation unless the engineer explicitly approves an architecture/query change.

When `di_violation` entries appear in `violations[]`, fix the implementation dependency graph. Reach-based DI failures may include a transitive `detected.path`. Do not work around the gate by editing `.ag` unless the engineer explicitly asks to change the intended architecture.

When `state_machine_violation` entries appear in `violations[]`, use the machine name, transition edge, source evidence, and `detected.query` provenance to fix the invalid state write. `aglc check` never calls an LLM; it evaluates committed source, compiled architecture, and reviewed query files.

When `solver_diagnostics[]` contains `unknown`, `error`, or `suggested_refactor`, treat it as a path-explosion or modeling hotspot. Prefer simplifying the implementation path, state write, or dependency graph before asking to change architecture rules.

When `change_violations[]` appear, update the required companion component in the same change. For example, a CLI or package metadata change may require README, CLI reference, or agent skill updates.

## Recommended AGENTS.md placement

Place `AGENTS.md` in the project root. Most agent frameworks automatically inject root-level context files into the agent's system prompt.

```
my-project/
├── AGENTS.md          ← agent reads this
├── architecture.ag    ← source of truth (engineer-guided edits)
├── architecture.o     ← compiled artifact (do not edit)
├── skill.json         ← agent skill manifest
└── src/
```
## Architecture Source Changes

Agents must ask before changing `.ag`, `.agq.yml`, `architecture.o`, `AGENTS.md`, or `skill.json` to satisfy a violation. These files encode architecture intent or generated architecture surfaces, so fixes should normally change implementation code unless the engineer explicitly approves an architecture/query update.

Evidence-backed `require` rules compile to deny-counterexample checks. Auth, encryption, dependency, and operation facts come from deterministic extractors or reviewed `.agq.yml` files during `check`; they are not inferred by LLM calls.
