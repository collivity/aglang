---
layout: home

hero:
  name: aglang
  text: Architectural Guardrails for AI Agents
  tagline: Define your system architecture once. Enforce it automatically at every git commit — for humans and AI agents alike.
  image:
    src: /aglang/hero.svg
    alt: aglang architecture pipeline diagram
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/collivity/aglang

features:
  - icon: 🏗️
    title: Architecture as Code
    details: Write human-readable `.ag` files that describe your system's components, data flows, and invariants.

  - icon: 🤖
    title: Agent-First Design
    details: Run `aglc add` once — AI agents get a `skill.json` manifest and `AGENTS.md` context so they understand your rules automatically.

  - icon: 🔒
    title: Git-Commit Enforcement
    details: A pre-commit hook runs Z3 SMT solving against every staged change. Violations are rejected with precise diagnostics — before the commit lands.

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
