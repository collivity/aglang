# AI Agents

aglang is designed as an **agent-facing architecture validation interface**. AI coding agents can use it continuously while they work: read the local architecture context, validate focused edits with JSON verdicts, and rely on the same Z3-backed checks that run at commit time.

## Why agents need architectural guardrails

When an AI agent refactors code, it may:
- Introduce a direct connection between tiers that should be isolated
- Add a database call in a public-facing handler
- Bypass an auth layer "for simplicity"
- Inject infrastructure into UI code, create singleton-to-scoped DI bugs, or use `IServiceProvider` as a service locator

Traditional code review catches these eventually. aglang catches them while the agent is still coding, then enforces the same rules at commit time with mathematical proof of the violation.

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

This creates:
- `architecture.ag` — the spec (agents should read this)
- `architecture.o` — the compiled artifact
- `skill.json` — agent skill manifest
- `.git/hooks/pre-commit` — enforcement hook

`.ag` files are engineer-guided architecture source. Coding agents should not create, edit, regenerate, or compile changes to `.ag` specs unless the engineer explicitly asks for architecture/spec work, ideally in a planning or design session.

### 2. Emit agent context

```bash
aglc emit-context --arch architecture.o --out AGENTS.md
```

`AGENTS.md` is a plain-English description of your architecture rules, suitable for any agent's context window. Commit it to your repo so agents discover it automatically.

### 3. Emit skill manifest

```bash
aglc emit-skill --arch architecture.o --out skill.json
```

`skill.json` follows the emerging AI skill/tool manifest format. Agents that support it can load architectural constraints as part of their toolchain.

## Continuous validation loop

```
Agent reads AGENTS.md → edits code → aglc check-file --json
                                  → aglc check --all --json
                                  → git commit hook runs same gate
                                                        │
                                          Z3 SAT   → pass ✓
                                          Z3 UNSAT → fix reported code ✗
```

## JSON mode for programmatic integration

All check commands support `--json` for machine-readable output:

```bash
aglc check-file --arch architecture.o --file src/api/gateway/checkout.py --json
aglc check --arch architecture.o --project . --all --json
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

Agents can parse this JSON and decide how to fix the violation rather than reading terminal output.

## Workflow for agent-managed projects

1. **Setup** — an engineer or authorized setup agent runs `aglc add` and reviews the generated `.ag` spec.
2. **Agent reads** — coding agents read `AGENTS.md` and `skill.json` before making implementation changes.
3. **Agent validates while coding** — run `aglc check-file --json` for focused edits.
4. **Agent validates before finishing** — run `aglc check --all --json` for the guarded project.
5. **Architecture evolves deliberately** — agents ask before changing `.ag`, `architecture.o`, `AGENTS.md`, or `skill.json`.

When `reach_violation`, `data_policy_violation`, or `trust_policy_violation` entries appear in `violations[]`, use `detected.path`, `detected.data`, and the Z3 proof to remove the forbidden path or add the declared auth/trust boundary the architecture requires.

When `di_violation` entries appear in `violations[]`, fix the implementation dependency graph. Reach-based DI failures may include a transitive `detected.path`. Do not work around the gate by editing `.ag` unless the engineer explicitly asks to change the intended architecture.

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
