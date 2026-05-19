# Quick Setup: `aglc add` and `aglc generate`

## `aglc add` — One-shot bootstrap

The `add` command is the recommended way to set up aglang in any project. It does everything in one step:

```bash
aglc add [projectRoot] [--name <ProjectName>] [--out <architecture.ag>]
```

**What it does:**

1. **Scans** your project for manifests (`package.json`, `.csproj`, `go.mod`, `Cargo.toml`, `build.gradle`, etc.)
2. **Generates** a starter `architecture.ag` spec with discovered components and routes
3. **Compiles** the spec → `architecture.o`
4. **Installs** a git pre-commit hook
5. **Emits** `skill.json` for AI agent toolchains

**Output:**

```
[aglc add] Scanning /my-project for project manifests...
  ✓ Generated spec → /my-project/architecture.ag
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
║  1. Open architecture.ag and add invariants      ║
║  2. Re-compile: aglc compile architecture.ag     ║
║  3. Every git commit is now checked              ║
╚══════════════════════════════════════════════════╝
```

## `aglc generate` — Spec generation only

If you want just the spec without installing the hook:

```bash
aglc generate [projectRoot] [--out architecture.ag] [--name MyApp]
```

This is useful for reviewing the auto-generated spec before committing to it.

## After setup: Adding invariants

The generated spec has components and flows — you add invariants to enforce boundaries:

```ag
component PublicAPI {
  path: "src/api/**"
  tier: "public"
}

component Database {
  path: "src/db/**"
  tier: "internal"
}

invariant NoDirectDBAccess {
  deny flow PublicAPI -> Database
}
```

See [Language Reference](./language-reference) for the full invariant syntax.

## For AI Agents

After running `aglc add`, emit the context file so agents understand the boundaries:

```bash
aglc emit-context --arch architecture.o --out AGENTS.md
```

Agents that support the skill protocol can load `skill.json` directly. The `AGENTS.md` file is a plain-English description of all architectural rules suitable for any agent.
