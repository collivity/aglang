# CLI Reference

## `aglc add`

One-shot agent bootstrap: generate → compile → hook → skill.json.

```bash
aglc add [projectRoot] [--name <ProjectName>] [--out <file.ag>]
```

| Flag | Description | Default |
|------|-------------|---------|
| `projectRoot` | Directory to scan | `.` (current directory) |
| `--name` | Override the project name in the generated spec | Inferred from manifests |
| `--out` | Output path for the `.ag` file | `<projectRoot>/architecture.ag` |

---

## `aglc compile`

Compile a `.ag` spec file into a binary `architecture.o` artifact.

```bash
aglc compile <file.ag> [--out <file.o>]
```

| Flag | Description | Default |
|------|-------------|---------|
| `file.ag` | Path to the spec file | required |
| `--out` | Output path for `.o` artifact | `architecture.o` alongside `.ag` |

---

## `aglc generate`

Scan a project directory and auto-generate a starter `.ag` spec.

```bash
aglc generate [projectRoot] [--out <file.ag>] [--name <n>]
```

Detects: `package.json`, `.csproj`, `go.mod`, `Cargo.toml`, `build.gradle`, `Podfile`, `Package.swift`, `pyproject.toml`, `requirements.txt`

---

## `aglc check`

Check the current staged git diff against a compiled architecture artifact.

```bash
aglc check --arch <architecture.o> --project <dir> [--json] [--workflow-z3] [--dump-workflow-smt]
```

| Flag | Description |
|------|-------------|
| `--arch` | Path to compiled `.o` artifact |
| `--project` | Git project root to scan |
| `--json` | Output machine-readable JSON verdict to stdout |
| `--workflow-z3` | Include workflow policy SMT debug snippets in workflow violations |
| `--dump-workflow-smt` | Write workflow policy SMT debug snippets to `workflow-debug.smt2` |

**Exit codes:**
- `0` — No violations (commit may proceed)
- `1` — Violations found (commit blocked)

---

## `aglc check-file`

Analyze a specific file against the architecture (useful for CI or IDE integration).

```bash
aglc check-file --arch <architecture.o> --file <path> [--json] [--dump-smt] [--workflow-z3] [--dump-workflow-smt]
```

| Flag | Description |
|------|-------------|
| `--file` | File to analyze |
| `--dump-smt` | Write the SMT-LIB script to `examples/debug.smt2` |
| `--workflow-z3` | Include workflow policy SMT debug snippets in workflow violations |
| `--dump-workflow-smt` | Write workflow policy SMT debug snippets to `workflow-debug.smt2` |

---

## `aglc install`

Install the git pre-commit hook into a project.

```bash
aglc install [--project <dir>] [--arch <architecture.o>]
```

The hook runs `aglc check` before every `git commit`. Writes to `.git/hooks/pre-commit`.

---

## `aglc emit-context`

Generate an `AGENTS.md` file describing the architecture for AI agents.

```bash
aglc emit-context --arch <architecture.o> [--out <path>]
```

Default output: `AGENTS.md` in the current directory.

---

## `aglc emit-skill`

Generate a `skill.json` manifest for AI agent toolchains.

```bash
aglc emit-skill --arch <architecture.o> [--out <path>]
```

Default output: `skill.json` in the current directory.

---

## `aglc import-openapi`

Import an OpenAPI 3.x spec and generate `.ag` contract blocks.

```bash
aglc import-openapi <swagger.json> [--out <file.ag>]
```

---

## `aglc import-tf`

Import a Terraform configuration and generate `.ag` node declarations.

```bash
aglc import-tf <main.tf> [--out <file.ag>]
```

---

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output to stdout; progress to stderr |
| `--dump-smt` | Write Z3 SMT-LIB input to `examples/debug.smt2` |
| `--workflow-z3` | Include workflow policy SMT debug snippets |
| `--dump-workflow-smt` | Write workflow policy SMT debug snippets |
