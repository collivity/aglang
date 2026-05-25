---
layout: home

hero:
  name: aglang
  text: Checked Architecture For Agents
  tagline: Write architecture intent once in a `.ag` spec, then let agents, subagents, and git hooks check real code against it while work is still in progress.
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
  - icon: ✅
    title: Checks Real Code
    details: aglang compiles a reviewed `.ag` spec into `architecture.o`, extracts facts from the codebase, and checks those facts against declared rules.

  - icon: 🤖
    title: Useful For Agents And Subagents
    details: The spec becomes shared truth across workers, which reduces architectural drift when parent agents and subagents operate with partial context.

  - icon: 🔁
    title: Works During Coding
    details: Agents can run `aglc check-file` during focused edits and `aglc check --all` before finishing, instead of waiting until commit time.

  - icon: 🧩
    title: Enforces Boundaries
    details: Today the strongest built-in checks are flow, reachability, dataflow, trust, DI, contracts, workflow policies, and change policies.

  - icon: 📦
    title: Bootstraps Existing Repos
    details: `aglc add` and `aglc generate` can create a starter spec, but the best results usually come from reviewing and refining that draft with a human or agent.

  - icon: 🔌
    title: Extraction Is Extensible
    details: Built-in extractors cover multiple languages now, and the plugin protocol lets teams add stronger repo-specific extraction over time.
---

## What aglang is

aglang is an architecture checking layer for real coding workflows.

You describe components, nodes, contracts, and rules in a `.ag` file. `aglc` compiles that into a checked artifact, extracts facts from the repository, and tells you when the implementation contradicts the intended structure.

The important point is that aglang is not just documentation and not just a commit hook:

- it gives agents a machine-readable view of architecture intent
- it lets engineers and agents validate work before merge
- it produces structured verdicts with proof details, not vague style feedback

---

## What it can do today

aglang is already good at a few things that matter in practice:

- **Architecture drift reduction**: a reviewed spec gives parent agents and subagents the same external boundary model, instead of relying on prompt memory.
- **Dependency injection checks**: C# DI extraction is strong enough to catch constructor-injection boundary violations, service-locator usage, and some lifetime issues.
- **Route and workflow checks**: contracts and GitHub Actions policies are checked deterministically when modeled.
- **Work-in-progress validation**: `check-file` and `check --all` make the same architecture visible while the code is still changing.
- **Starter generation**: `generate` and `add` can bootstrap a draft spec for an existing repo.

This is the right mental model:

- `generate` is a starting point
- a reviewed `.ag` is the shared truth
- `check` is the enforcement runtime

---

## What it does not do yet

The limits matter.

- It does **not** infer perfect architecture from source code automatically.
- Some extractors are stronger than others; generated starters still need review.
- Advisory declarations are not hard gates unless a runtime or extractor supports them.
- For large or noisy repos, an agent-authored or engineer-reviewed spec is usually much better than raw auto-generation.

If you want maximum value from aglang, treat the generated spec as a draft and the checked spec as the product.

---

## Practical Workflow

### 1. Bootstrap or write a spec

```bash
aglc add /path/to/project
```

or write `architecture.ag` by hand.

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

### 5. Let commit hooks and CI enforce the same rules

The same checked artifact can run locally and in CI. Humans and agents both hit the same gate.

---

## Enforcement Levels

Not every declaration is enforced the same way.

| Level | Used for | Meaning |
|---|---|---|
| `formal_z3` | `deny flow`, `deny reach`, `deny dataflow`, `data_policy`, `trust_policy`, `di_policy`, `permission`, `change_policy` | Checked with solver-backed constraints when extractors produce definite evidence. |
| `deterministic_policy` | `contract`, `workflow_policy` | Checked by deterministic gates with exact diagnostics. |
| `advisory` | `machine`, `require encryption` | Emitted to docs and agent context, but not blocking by themselves yet. |

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

## Install

```bash
npm install -g @collivity/aglang
aglc install-agent-skill
```

Then bootstrap a project:

```bash
aglc add /path/to/your/project
```

`aglc add` creates a starter architecture spec, compiles it, installs the git hook, and emits the agent manifest files. The next step is review, not blind trust. [Full getting-started guide →](./guide/getting-started)

---

## Where to go next

- [Getting Started](./guide/getting-started)
- [How aglang Works](./how-it-works)
- [Examples](./examples)
- [CLI Reference](./cli/reference)
- [Protocol Draft](./protocol)
