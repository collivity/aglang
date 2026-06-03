---
layout: home

hero:
  name: aglang
  text: Verifiable specifications for agents and humans
  tagline: "Write architecture intent once, compile it into machine-checkable artifacts, and let humans, agents, and CI use the same truth. Install: npm install -g @collivity/aglang"
  image:
    src: /hero.svg
    alt: aglang architecture pipeline diagram
  actions:
    - theme: brand
      text: Install →
      link: '#install'
    - theme: alt
      text: Agent Guide
      link: /llms
    - theme: alt
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
  - icon: ✅
    title: Verifiable Spec Language
    details: "aglang turns reviewed architecture specifications into artifacts that humans can read and agents can execute against."

  - icon: 🔎
    title: Reviews Semantic Queries
    details: "Committed `.agq.yml` query files turn deterministic graph facts into domain facts such as transitions and flows without calling an LLM during checks."

  - icon: 🔁
    title: Explains Violations
    details: "`aglc check`, JSON verdicts, and `aglc explain` connect a failed rule to source evidence, query provenance, and solver proof details."

  - icon: 🧩
    title: Enforces Boundaries
    details: "Today the strongest built-in checks cover flow, reachability, dataflow, trust/auth, DI, contracts, workflows, change policies, state machines, value policies, operation policies, and event policies."

  - icon: 🗂️
    title: Coordinates Multi-Repo Work
    details: "One architecture contract can govern services, CI workflows, docs, package metadata, and agent work across repository boundaries."

  - icon: 🤖
    title: Gives Agents Shared Truth
    details: "Agents are a primary workflow because they benefit from machine-readable architecture context, but the same checks serve humans and CI."
---

## Install

```bash
npm install -g @collivity/aglang
aglc install-agent-skill
```

Then create or refresh the architecture interface for a repo:

```bash
aglc add .
aglc generate . --out architecture.ag
aglc compile architecture.ag --out architecture.o
aglc emit-context --arch architecture.o --out AGENTS.md
aglc emit-skill --arch architecture.o --out skill.json
```

After that, agents and humans use the same checks:

```bash
aglc check-file --arch architecture.o --file src/foo.ts --json
aglc check --arch architecture.o --project . --all --json
```

---

## What aglang is

aglang is a verifiable specification language for agents and humans.

You describe components, nodes, contracts, state machines, and rules in a `.ag` file. `aglc` compiles that specification into `architecture.o`, extracts deterministic facts from the repository, applies reviewed semantic queries from `.agq.yml`, and checks the resulting model with Z3-backed rules and deterministic policy gates.

The important point is that aglang is not just documentation, not just a CI check, and not just an agent helper:

- it gives engineers, agents, and CI the same machine-readable architecture truth
- it separates extracted facts from reviewed semantic interpretation
- it produces structured verdicts with source evidence, stable ids, and proof details

---

## How the check works

The first-page model is intentionally simple:

1. **Extract facts** from source code, manifests, workflows, and optional plugin output.
2. **Review semantic queries and specs** in `.ag`, `.agq.yml`, and generated context before trusting them.
3. **Check the model** with Z3-backed rules and deterministic contract/workflow policy evaluators.
4. **Explain violations** with JSON verdicts, query provenance, solver diagnostics, and `aglc explain --violation <id> --json`.

`aglc check` does not call an LLM. Humans and agents can help author the spec or semantic queries, but the verification run uses committed source artifacts.

---

## What is verified

aglang is strongest where architecture intent can be stated as facts and rules:

- **Flows and reachability**: direct and transitive component or node paths.
- **Data policies**: classification and jurisdiction reachability.
- **Trust and auth boundaries**: declared trust zones, auth metadata, and classified data crossings.
- **Dependency injection**: constructor injection, lifetime relationships, and service-locator usage where extractors produce definite evidence.
- **Contracts**: implemented and consumed routes checked against declared API contracts.
- **Workflows**: GitHub Actions publish, deploy, release, permissions, and step order.
- **Change policies**: required companion changes such as docs, package metadata, or generated agent context.
- **State machines**: query-emitted transitions checked against declared `machine` blocks.

## What is audited

The verification surface is made of reviewable files and machine-readable outputs:

- `.ag` is the architecture source of truth.
- `architecture.o` is the compiled checked artifact.
- `.agq.yml` files are the semantic layer over deterministic graph facts.
- `AGENTS.md` and `skill.json` are generated context for coding agents.
- JSON verdicts contain stable violation ids, diff metadata, rule coverage, query provenance, proof details, and solver diagnostics.

## Why multi-repo matters

Real architecture drift rarely stays inside one package. A release workflow, public API, generated docs, package metadata, and service implementation can live in different repositories while still representing one architecture decision.

aglang lets a reviewed architecture contract coordinate those surfaces. Components can carry `repo:` metadata, change policies can require related files to move together, and the same `architecture.o` can be used by humans, CI, and agents working on different slices of a system.

---

## What it does not do yet

The limits matter.

- It does **not** prove arbitrary program correctness.
- It does **not** infer perfect architecture from source code automatically.
- It verifies extracted and reviewed architecture facts against declared rules; weak extraction means weak evidence.
- Some extractors are stronger than others, and generated starters still need review.
- Advisory declarations are not hard gates unless a runtime or extractor supports them.

If you want maximum value from aglang, treat generated specs and queries as drafts. The reviewed `.ag`, `.agq.yml`, and generated verification artifacts are the product.

---

## Practical Workflow

### 1. Ask for architecture discovery or write a spec

```bash
aglc request-scan --project /path/to/project
```

An agent can use the emitted task packet to inspect the repo, propose `architecture.proposed.ag`, propose `.agq.yml` semantic queries, and write review notes. Humans approve architecture intent before enforcement. You can also write `architecture.ag` by hand.

### 2. Review the architecture draft

Refine component boundaries, runtime nodes, contracts, and invariants so they match the real system rather than only the file tree.

### 3. Compile the checked artifact

```bash
aglc compile architecture.ag
```

### 4. Validate edits while coding

```bash
aglc check-file --arch architecture.o --file src/foo.cs --json
aglc check --arch architecture.o --project . --all --json
```

### 5. Let local checks and CI enforce the same rules

The same checked artifact can run locally and in CI. Humans and agents both hit the same gate.

---

## Enforcement Levels

Not every declaration is enforced the same way.

| Level | Used for | Meaning |
|---|---|---|
| `formal_z3` | `deny flow`, `deny reach`, `require flow`, `require operation`, `deny dataflow`, `data_policy`, `trust_policy`, `di_policy`, `permission`, `change_policy`, `machine`, `value_policy`, `operation_policy`, `event_policy` | Checked with solver-backed constraints when extractors or reviewed queries produce definite evidence. |
| `deterministic_policy` | `contract`, `workflow_policy` | Checked by deterministic gates with exact diagnostics. |
| `formal_z3` | `require encryption` / `deny unencrypted flow` | Blocks only when deterministic extractors or reviewed `.agq.yml` files emit definite unencrypted-flow evidence. |

That distinction is part of the contract with users: aglang should say clearly what is proven, what is policy-checked, and what is only guidance.

---

## Why agents benefit

Agents drift when they optimize locally and forget system intent. Subagents drift even faster because they usually operate with less context.

aglang helps by moving architecture intent out of the prompt and into a checked artifact:

- agents can read `AGENTS.md` and `architecture.o`
- workers can validate their own slice with `check-file`
- the shared spec catches boundary drift across parallel work
- structured verdicts make failures precise enough to fix

This does not remove the need for architecture review. It gives that review an executable form.

---

## Agent-assisted discovery

Request a repository scan:

```bash
aglc request-scan --project /path/to/your/project
```

`aglc request-scan` writes an agent task packet. The agent does semantic scanning and proposal work; aglc validates only approved `.ag` and `.agq.yml` artifacts. [Full getting-started guide →](./guide/getting-started)

---

## Where to go next

- [Getting Started](./guide/getting-started)
- [How aglang Works](./how-it-works)
- [Examples](./examples)
- [CLI Reference](./cli/reference)
- [Protocol Draft](./protocol)
