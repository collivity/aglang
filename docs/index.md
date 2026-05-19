---
layout: home

hero:
  name: aglang
  text: Architectural Guardrails for AI Agents
  tagline: Define your system architecture once. Enforce it automatically at every git commit — for humans and AI agents alike.
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
      text: View on GitHub
      link: https://github.com/collivity/aglang

features:
  - icon: 🏗️
    title: Architecture as Code
    details: Write human-readable .ag files that describe your system components, data flows, and invariants.

  - icon: 🤖
    title: Agent-First Design
    details: Run aglc add once — AI agents get a skill.json manifest and AGENTS.md context so they understand your rules automatically.

  - icon: 🔒
    title: Git-Commit Enforcement
    details: A pre-commit hook runs Z3 SMT solving against every staged change. Violations are rejected with precise diagnostics before the commit lands.

  - icon: 🌐
    title: 8 Language Extractors
    details: Automatically extract routes, dependencies, and infrastructure from C#, Python, TypeScript, Go, Rust, Java/Kotlin, Swift, and more.

  - icon: 📐
    title: Formal Verification
    details: Architectural rules compile to SMT-LIB formulas. Z3 provides mathematical proof of violations — not heuristics, not guesses.

  - icon: 🔌
    title: Pluggable & Extensible
    details: Add custom extractors via the plugin protocol. Import from OpenAPI or Terraform. Works with any codebase, any team size.
---

## Install

```bash
npm install -g @collivity/aglang
```

Then bootstrap any project with one command:

```bash
aglc add /path/to/your/project
```

Architecture spec, compiled artifact, git hook, and AI agent manifest — all set up automatically. [Full getting-started guide →](./guide/getting-started)

---

## How it works — at a glance

aglang is a **Dual-Compiler System**. Your `.ag` spec compiles to SMT-LIB math formulas; every `git commit` triggers a second compiler that extracts what your changed code actually does and feeds it to Z3:

```
Your .ag spec                    Your codebase (git diff)
      │                                    │
      ▼                                    ▼
[aglc compile]              [AST extractors — 8 languages]
      │                                    │
      ▼                                    ▼
 architecture.o              FlowFact[]  (what code talks to what)
(SMT constraints)                         │
      │                                   │
      └─────────────── Z3 Solver ─────────┘
                             │
                    UNSAT → pass ✓  │  SAT → reject with proof ✗
```

Z3 is deterministic math — there are no heuristics, no LLM guesses, and no false negatives. [Full pipeline walkthrough →](./how-it-works)
