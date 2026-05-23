---
layout: home

hero:
  name: aglang
  text: Architecture Guardrails for Coding Agents
  tagline: Give agents a live interface to your architecture rules, so they can validate work in progress while coding and still get solver-backed enforcement before commits land.
  image:
    src: /hero.svg
    alt: aglang architecture pipeline diagram
  actions:
    - theme: brand
      text: Get Started →
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /how-it-works
    - theme: alt
      text: Examples
      link: /examples
    - theme: alt
      text: View on GitHub
      link: https://github.com/collivity/aglang

features:
  - icon: 🤖
    title: Packaged Agent Skill
    details: Install the aglang Codex skill so agents know when to read AGENTS.md, run aglc checks, and treat architecture verdicts as coding feedback.

  - icon: 🔁
    title: Work-in-progress Validation
    details: Agents can run check-file during focused edits and check --all before finishing, long before a pre-commit hook fires.

  - icon: 🧩
    title: Enterprise Graph Policies
    details: Model transitive reachability, data classification propagation, trust boundaries, DI closure, and lifetime hazards as enforceable architecture rules.

  - icon: 🏗️
    title: Architecture as Code
    details: Write human-readable .ag files with explicit enforcement levels for formal Z3 rules, deterministic policies, and advisory guidance.

  - icon: 🔒
    title: Solver-backed Commit Enforcement
    details: Pre-commit hooks and CI checks run deterministic constraint solving against real extracted code behavior. Violations are rejected with precise diagnostics.

  - icon: 📚
    title: Docs Freshness Policies
    details: Use change_policy rules to require docs, skills, package metadata, and implementation surfaces to move together in the same checked diff.

  - icon: 🌐
    title: 8 Language Extractors
    details: Automatically extract routes, dependencies, and infrastructure from C#, Python, TypeScript, Go, Rust, Java/Kotlin, Swift, and more.

  - icon: 🔌
    title: Pluggable & Extensible
    details: Add custom extractors via the plugin protocol. Import from OpenAPI or Terraform.
---

## Install

Install the CLI and the packaged agent skill:

```bash
npm install -g @collivity/aglang
aglc install-agent-skill
```

Then bootstrap a project:

```bash
aglc add /path/to/your/project
```

`aglc add` creates the starter architecture spec, compiled artifact, git hook, and project-specific agent manifest. [Full getting-started guide →](./guide/getting-started)

---

## How agents should use aglang

The packaged skill gives agents generic aglang behavior; the project repo supplies its own rules through `AGENTS.md`, `skill.json`, and `architecture.o`.

1. Read `AGENTS.md` before coding.
2. Validate focused edits with `aglc check-file --arch architecture.o --file <path> --json`.
3. Validate the whole guarded project before finishing with `aglc check --arch architecture.o --project . --all --json`.
4. Ask before creating, editing, regenerating, or compiling `.ag` architecture specs or generated architecture artifacts.
5. Use planning/design sessions for architecture authoring, where engineers can review intended spec changes.

---

## How it works — at a glance

aglang is a **dual-compiler system** exposed as an agent workflow. Your `.ag` spec compiles to SMT-LIB math formulas; during coding or commit checks, a second compiler extracts what changed code actually does and feeds it to the solver:

```
Your .ag spec                 Your codebase (file or project)
      │                                    │
      ▼                                    ▼
[aglc compile]              [AST extractors — 8 languages]
      │                                    │
      ▼                                    ▼
 architecture.o              FlowFact[]  (what code talks to what)
(SMT constraints)                         │
      │                                   │
      └────────────── solver-backed check ────────┘
                             │
                    SAT → pass ✓  │  UNSAT → reject with proof ✗
```

Agents use the same interface while code is still in progress; pre-commit hooks and CI use it as the final enforcement point. The solver is deterministic math — no LLM guesses. [Full pipeline walkthrough →](./how-it-works)
