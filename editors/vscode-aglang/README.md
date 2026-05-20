# aglang VS Code Extension

Language support for [aglang](https://github.com/collivity/aglang) `.ag` files — architectural guardrails enforced via Z3 SMT solving.

## Features

- **Syntax highlighting** — keywords, component names, HTTP methods, strings, comments
- **Snippets** — `component`, `invariant`, `contract`, `flow`, `machine`, `permission`, `plugin`
- **Inline diagnostics** — real-time parse errors as you type via Language Server
- **Hover documentation** — descriptions for every keyword on hover
- **Completions** — keyword and property completions
- **Commands** (Command Palette → `aglang:`):
  - **aglang: Compile architecture spec** — runs `aglc compile` on your `.ag` file
  - **aglang: Check current file** — saves and validates the current file
  - **aglang: Generate spec from project** — runs `aglc add` to bootstrap a spec from your codebase

## Requirements

Install the `aglc` CLI from npm:

```bash
npm install -g @collivity/aglang
```

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `aglang.executablePath` | `aglc` | Path to the aglc binary |
| `aglang.validateOnSave` | `true` | Validate on save |
| `aglang.validateOnType` | `true` | Validate as you type |

## Quick example

```ag
component PublicAPI {
  directory: "src/api/**"
}

node Database(database) {
  directory: "src/db/**"
}

invariant NoDirectAccess {
  deny flow PublicAPI -> Database;
}
```

Save this as `architecture.ag`. The extension will highlight syntax and show parse errors instantly.

## License

ISC — see [LICENSE](./LICENSE).
