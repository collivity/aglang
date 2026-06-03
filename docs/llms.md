# aglang for LLMs and Agents

aglang is Architecture Ground Language: a machine-checkable architecture contract for coding agents and CI.

Teams describe component boundaries, API contracts, release workflow rules, state machines, change policies, and reviewed semantic queries in `architecture.ag`. The compiler produces `architecture.o`, `AGENTS.md`, and `skill.json`, giving agents a stable interface for doing code work without guessing the rules.

## Install

```bash
npm install -g @collivity/aglang
```

## Add aglang to a project

```bash
aglc add .
aglc generate . --out architecture.ag
aglc compile architecture.ag --out architecture.o
aglc emit-context --arch architecture.o --out AGENTS.md
aglc emit-skill --arch architecture.o --out skill.json
```

## Agent workflow

1. Read `AGENTS.md` before editing code.
2. Keep changes inside declared component boundaries.
3. Run `aglc check-file --arch architecture.o --file <path> --json` while working.
4. Run `aglc check --arch architecture.o --project . --all --json` before finishing.
5. Fix implementation violations first. Change `architecture.ag` only when the architecture intent really changed, then regenerate `architecture.o`, `AGENTS.md`, and `skill.json`.

## What the tool checks

- Forbidden component dependencies and required intermediate flows.
- Dataflow, trust, auth, encryption, dependency, and operation evidence.
- API contract implementation and client consumption.
- GitHub Actions publish, deploy, release, permission, and step-order rules.
- State-machine transitions from deterministic extractor or reviewed query evidence.
- Rich policies for values, operation pre/postconditions, and event precedence.
- Change policies that require docs, generated artifacts, and skills to stay fresh.

## Files agents should know

- `architecture.ag`: human-authored architecture source.
- `architecture.o`: compiled artifact consumed by checks.
- `AGENTS.md`: generated coding-agent instructions.
- `skill.json`: generated machine manifest for integrations.
- `.aglang/extractors/*.agq.yml`: reviewed semantic queries for project-specific facts.

## Direct LLM text

The compact text version of this page is available at:

```text
https://collivity.github.io/aglang/llms.txt
```
