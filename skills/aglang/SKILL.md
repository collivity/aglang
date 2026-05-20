---
name: aglang
description: Use when working with aglang architecture specs, the aglc CLI, architecture.o artifacts, AGENTS.md context, skill.json manifests, GitHub Actions workflow policies, npm package metadata, release safety, or architecture/contract/workflow validation in projects that use Architecture Ground Language.
---

# aglang

aglang is an agent-facing architecture validation interface. Use `aglc` while coding, not only at commit time. Prefer local project files over memory: read `AGENTS.md`, `skill.json`, `architecture.o`, and `architecture.ag` when present.

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
4. Treat failed JSON verdicts as blocking feedback. Fix the reported implementation, then re-run the check.
5. Keep project-specific behavior delegated to `AGENTS.md` and `skill.json`; this packaged skill only explains the generic aglang interface.

## Architecture Source Rules

`.ag` files are engineer-guided architecture source, not normal implementation files. Do not create, edit, regenerate, import into, or compile changes to `.ag` specs unless the engineer explicitly asks for architecture/spec work.

Generated architecture artifacts are also permissioned:

- Do not run `aglc generate`, `aglc add`, `aglc import-openapi`, or `aglc import-tf` to write `.ag` files without explicit permission.
- Do not run `aglc compile` to update `architecture.o` after `.ag` changes unless that architecture update was requested.
- Do not run `aglc emit-context` or `aglc emit-skill` to update generated `AGENTS.md` or `skill.json` unless requested.
- Prefer planning or design sessions for `.ag` authoring, where the engineer can review intended architecture changes before files are modified.

## Main Commands

```bash
aglc add [projectRoot] [--name <ProjectName>] [--out <file.ag>]
aglc generate [projectRoot] [--out <file.ag>] [--name <ProjectName>]
aglc compile <file.ag> [--out architecture.o]
aglc check --arch architecture.o --project . [--all] [--json]
aglc check-file --arch architecture.o --file <path> [--json] [--dump-smt]
aglc emit-context --arch architecture.o --out AGENTS.md
aglc emit-skill --arch architecture.o --out skill.json
aglc import-openapi <swagger.json> [--out <file.ag>]
aglc import-tf <main.tf> [--out <file.ag>]
```

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
- `violations`: architecture flow violations with Z3 proof details.
- `dataflow_violation`: a violation type inside `violations[]` for classified data flowing to a denied component or node.
- `contract_violations`: API contract mismatches.
- `workflow_violations`: GitHub Actions policy violations.
- `change_violations`: required companion changes, such as docs or skill updates, missing from the checked diff.
- `warnings`, `contract_warnings`, `workflow_warnings`: non-blocking findings.
- `agent_context`: concise explanation for agents.

If `passed` is false, fix the reported files/rules before committing.

When `change_violations` are present, update the required component in the same change instead of bypassing the policy. Common examples are CLI changes requiring CLI docs, package metadata changes requiring README or skill updates, and agent skill changes requiring public docs.

## When To Ask The Engineer

Ask before changing architecture intent, including component boundaries, file globs, trust zones, topology nodes, invariants, contracts, workflow policies, generated context, or generated skill manifests. If implementation code appears to require an architecture change, stop and explain the mismatch instead of editing `.ag` files yourself.

## Package And Release Checks

Before release or package metadata changes:

1. Keep `LICENSE`, root `package.json`, README license text, and extension package metadata consistent.
2. Verify package contents with `npm pack --dry-run --json`.
3. Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run arch:check`.
4. For docs changes, run `npm run docs:build`.
