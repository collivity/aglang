# AI Agents

aglang is designed as an **agent-first** language. AI coding agents (GitHub Copilot, Claude, Cursor, Devin, etc.) can operate autonomously for long stretches — aglang acts as formal guardrails they cannot bypass.

## Why agents need architectural guardrails

When an AI agent refactors code, it may:
- Introduce a direct connection between tiers that should be isolated
- Add a database call in a public-facing handler
- Bypass an auth layer "for simplicity"

Traditional code review catches these eventually. aglang catches them **at commit time**, with mathematical proof of the violation, before any code lands.

## Setup for agents

### 1. One-shot bootstrap

```bash
aglc add /path/to/project --name MyApp
```

This creates:
- `architecture.ag` — the spec (agents should read this)
- `architecture.o` — the compiled artifact
- `skill.json` — agent skill manifest
- `.git/hooks/pre-commit` — enforcement hook

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

## The enforcement loop

```
Agent writes code → git commit → pre-commit hook → aglc check
                                                        │
                                          Z3 UNSAT → commit passes ✓
                                          Z3 SAT   → commit rejected ✗
                                                        │
                                               Precise diagnostic printed
                                               with component names and
                                               file paths for the agent
                                               to act on
```

## JSON mode for programmatic integration

All check commands support `--json` for machine-readable output:

```bash
aglc check --arch architecture.o --project . --json
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

1. **Agent bootstraps** with `aglc add` on first run
2. **Agent reads** `AGENTS.md` before making architectural changes
3. **Agent commits** — the hook runs automatically, blocking violations
4. **On violation** — the agent receives structured JSON feedback and self-corrects
5. **Architecture evolves** — when expanding the system, the agent updates `architecture.ag` and re-compiles

## Recommended AGENTS.md placement

Place `AGENTS.md` in the project root. Most agent frameworks automatically inject root-level context files into the agent's system prompt.

```
my-project/
├── AGENTS.md          ← agent reads this
├── architecture.ag    ← source of truth (agent may edit)
├── architecture.o     ← compiled artifact (do not edit)
├── skill.json         ← agent skill manifest
└── src/
```
