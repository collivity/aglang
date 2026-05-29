---
name: aglang
description: Use when working with aglang architecture specs, the aglc CLI, architecture.o artifacts, AGENTS.md context, skill.json manifests, GitHub Actions workflow policies, npm package metadata, release safety, or architecture/contract/workflow validation in projects that use Architecture Ground Language.
---

# aglang

aglang is an auditable architecture verification layer for code facts, policies, and agent workflows. Use `aglc` while coding, not only at commit time. Prefer local project files over memory: read `AGENTS.md`, `skill.json`, `architecture.o`, `architecture.ag`, and committed `.aglang/extractors/*.agq.yml` files when present.

Product docs: https://collivity.github.io/aglang

Install:

```bash
npm install -g @collivity/aglang
aglc install-agent-skill
```

## Core Workflow For Coding Agents

1. Read `AGENTS.md` first for project-specific architecture rules.
2. During focused edits, run `aglc check-file --arch architecture.o --file <path> --json` on files you are changing.
3. Before finishing, run `aglc check --arch architecture.o --project . --all --json`.
4. Treat failed JSON verdicts as blocking feedback. Use `aglc explain --arch architecture.o --project . --violation <id> --json` as the deterministic repair-loop entrypoint, then fix the reported implementation and re-run the check.
5. Keep project-specific behavior delegated to `AGENTS.md` and `skill.json`; this packaged skill only explains the generic aglang interface.

## Architecture Source Rules

`.ag` files are engineer-guided architecture source, not normal implementation files. Do not create, edit, regenerate, import into, or compile changes to `.ag` specs unless the engineer explicitly asks for architecture/spec work.

Semantic query files are architecture source too. `.aglang/extractors/*.agq.yml` files are reviewed artifacts that map deterministic graph facts into domain facts such as architecture flows or state-machine transitions. LLMs may help author them when requested, but `aglc check` never calls an LLM; it runs the committed `.ag`, `.agq.yml`, and source facts deterministically.

Generated architecture artifacts are also permissioned:

- Do not run `aglc generate`, `aglc add`, `aglc import-openapi`, or `aglc import-tf` to write `.ag` files without explicit permission.
- Do not run `aglc compile` to update `architecture.o` after `.ag` changes unless that architecture update was requested.
- Do not run `aglc emit-context` or `aglc emit-skill` to update generated `AGENTS.md` or `skill.json` unless requested.
- Do not create or change `.agq.yml`, generated context, or generated skill manifests unless the engineer explicitly asks for architecture/spec/query work.
- Prefer planning or design sessions for `.ag` authoring, where the engineer can review intended architecture changes before files are modified.

## Main Commands

```bash
aglc add [projectRoot] [--name <ProjectName>] [--out <file.ag>]
aglc generate [projectRoot] [--out <file.ag>] [--name <ProjectName>]
aglc compile <file.ag> [--out architecture.o]
aglc check --arch architecture.o --project . [--all] [--json]
aglc check --arch architecture.o --project . --diff <ref> [--json]
aglc check-file --arch architecture.o --file <path> [--json] [--dump-smt]
aglc explain --arch architecture.o --project . --violation <id> [--json] [--diff <ref>] [--all]
aglc emit-context --arch architecture.o --out AGENTS.md
aglc emit-skill --arch architecture.o --out skill.json
aglc import-openapi <swagger.json> [--out <file.ag>]
aglc import-tf <main.tf> [--out <file.ag>]
```

## Semantic Queries And State Machines

State machines and other semantic rules are enforced from extracted facts, not from prose. A typical state-machine path is:

1. A `.ag` file declares `machine OrderLifecycle on Order.status`.
2. A reviewed `.agq.yml` query matches deterministic graph facts such as assignments and emits a transition fact.
3. `aglc check` asserts definite transitions into Z3 and blocks transitions not allowed by the machine.
4. The JSON violation includes `type: "state_machine_violation"`, stable `id`, source evidence, query id/version/file, graph fact id when available, and the Z3 proof.

Transitions without a resolved `from` state are warning-only. Do not "fix" these by weakening the machine unless the requested architecture change is explicit.

## Workflow Policies

GitHub Actions workflows can be modeled as components and checked with `workflow_policy`.

```ag
node github_actions : ci_runner { trust: trusted }
node npm_registry : package_registry { trust: trusted auth: api_key }

component ReleaseWorkflow {
  runs_on: github_actions
  paths: ".github/workflows/release.yml"
}

workflow_policy ReleaseSafety {
  allow publish ReleaseWorkflow -> npm_registry when tag "v*.*.*"
  deny publish * -> npm_registry when pull_request
  require before ReleaseWorkflow "npm test" -> "npm publish"
  deny permission * contents: write when pull_request
}
```

Use `--workflow-z3` to include workflow SMT debug snippets in JSON verdicts. Use `--dump-workflow-smt` to write `workflow-debug.smt2`.

## JSON Verdicts

Check commands return schema version 2. Important fields:

- `passed`: overall result.
- `diff`: checked scope metadata when running staged, `--diff`, or `--all` checks.
- `violations`: architecture flow, reachability, data, trust, DI, and permission violations with proof details.
- `state_machine_violation`: a violation type inside `violations[]` for query-extracted transitions that violate a `machine` declaration.
- `reach_violation`: a violation type inside `violations[]` for a transitive `deny reach` path; inspect `detected.path`.
- `dataflow_violation`: a violation type inside `violations[]` for data reaching a denied component or node.
- `data_policy_violation`: a violation type inside `violations[]` for classification or jurisdiction rules.
- `trust_policy_violation`: a violation type inside `violations[]` for auth/trust-boundary rules.
- `di_violation`: a violation type inside `violations[]` for `di_policy` failures such as forbidden constructor injection, singleton-to-scoped lifetime dependency, or denied service-locator access.
- `contract_violations`: API contract mismatches.
- `workflow_violations`: GitHub Actions policy violations.
- `change_violations`: required companion changes, such as docs or skill updates, missing from the checked diff.
- `rule_coverage`: optional evidence summary for checked rules.
- `solver_diagnostics`: rule-sized solver slices. `unknown`, `error`, or expensive slices identify path-explosion/refactor hotspots with `suggested_refactor` text when available.
- `warnings`, `contract_warnings`, `workflow_warnings`: non-blocking findings.
- `agent_context`: concise explanation for agents.

If `passed` is false, fix the reported files/rules before committing.

For any blocking violation with an `id`, run:

```bash
aglc explain --arch architecture.o --project . --violation <id> --json
```

Use the explanation's `fix_class`, `suggested_fix`, source evidence, graph fact chain, diff metadata, and proof fields to make the smallest implementation repair.

When `change_violations` are present, update the required component in the same change instead of bypassing the policy. Common examples are CLI changes requiring CLI docs, package metadata changes requiring README or skill updates, and agent skill changes requiring public docs.

## When To Ask The Engineer

Ask before changing architecture intent, including component boundaries, file globs, trust zones, topology nodes, invariants, contracts, workflow policies, state machines, semantic queries, generated context, or generated skill manifests. If implementation code appears to require an architecture change, stop and explain the mismatch instead of editing `.ag` or `.agq.yml` files yourself.

## Package And Release Checks

Before release or package metadata changes:

1. Keep `LICENSE`, root `package.json`, README license text, and extension package metadata consistent. For this repo, the root license is `Apache-2.0`.
2. Verify package contents with `npm pack --dry-run --json`.
3. Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run arch:check`.
4. For docs changes, run `npm run docs:build`.
