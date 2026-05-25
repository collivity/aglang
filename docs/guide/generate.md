# Quick Setup: `aglc add` and `aglc generate`

## `aglc add` — One-shot bootstrap

The `add` command is the recommended way to set up aglang in any project. It does everything in one step:

```bash
aglc add [projectRoot] [--name <ProjectName>] [--out <architecture.ag>] [--max-depth <n>] [--single-file]
```

**What it does:**

1. **Scans** your project for source roots, manifests, and extractor facts
2. **Generates** a deep `architecture.ag` starter with discovered components, routes, and imported sub-specs for oversized areas
3. **Compiles** the spec → `architecture.o`
4. **Installs** a git pre-commit hook
5. **Emits** `skill.json` for AI agent toolchains

**Output:**

```
[aglc add] Scanning /my-project for source roots and extractor facts...
  ✓ Generated spec → /my-project/architecture.ag
    Imported sub-specs: 2
    Components: 3 | Infra nodes: 2 | Contracts: 1
[aglc add] Compiling spec...
  ✓ Compiled → /my-project/architecture.o
[aglc add] Installing git pre-commit hook...
  ✓ Installed hook
  ✓ Emitted skill manifest → /my-project/skill.json

╔══════════════════════════════════════════════════╗
║  aglang setup complete                           ║
╠══════════════════════════════════════════════════╣
║  Next steps:                                     ║
║  1. Use plan mode to review the generated spec   ║
║  2. Add or refine invariants in an agent-guided  ║
║     session                                      ║
║  3. Re-compile approved changes                  ║
║  4. Every git commit is now checked              ║
╚══════════════════════════════════════════════════╝
```

## `aglc generate` — Spec generation only

If you want just the spec without installing the hook:

```bash
aglc generate [projectRoot] [--out architecture.ag] [--name MyApp] [--max-depth 3] [--single-file]
```

This is useful for reviewing the auto-generated spec before committing to it. Generation is deep by default, keeps mixed-language roots, and emits imported component files when the repo is too broad for one flat starter. Use `--single-file` when you want one flat output.

## After setup: Adding invariants

The generated spec has components and flows. The intended workflow is to review that model in a planning/design session, then add invariants to enforce boundaries:

```ag
node app_runtime : server { trust: trusted }
node database : postgres { trust: trusted }

component PublicAPI {
  runs_on: app_runtime
  paths: "src/api/**"
}

invariant NoDirectDBAccess {
  deny flow PublicAPI -> database
}
```

See [Language Reference](./language-reference) for the full invariant syntax.

## For AI Agents

After running `aglc add`, emit the context file so agents understand the boundaries:

```bash
aglc emit-context --arch architecture.o --out AGENTS.md
```

Agents that support the skill protocol can load `skill.json` directly. The `AGENTS.md` file is a plain-English description of all architectural rules suitable for any agent.
