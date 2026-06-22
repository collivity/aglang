# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning follows
[Semantic Versioning](https://semver.org/).

Entries below 0.3.0 are not retroactively documented — see git history for changes prior to this version.

## [0.3.0]

### Added
- `aglc install-extractors [--project <dir>] [--force]` — scaffolds two starter `.agq.yml` templates (`resolved-calls-as-flow`, `resolved-internal-imports-as-flow`) into a project's `.aglang/extractors/`, promoting resolved cross-component calls/imports into `flow` facts with zero project-specific code.
- `aglc query-test --query <file.agq.yml> [--fixture <facts.yml>] [--init-fixture] [--json]` — validates a single `.agq.yml` query against hand-written fixture facts before wiring it into a real check, reporting per-fact match/skip-reason/emitted-preview. Closes a real gap: this project's own queries had shipped with capture-name and match-clause bugs that nothing could catch before a query was already live.
- Cross-file import and call resolution for **Python, Go, Rust, Java, and Swift** (`src/ir/cross-file-linker.ts`, `src/ir/specifier-resolvers.ts`), bringing those languages to parity with the existing TypeScript/JavaScript/C# resolver (`src/ir/semantic-index.ts`). Covers in-project imports and free-function/package-or-module-qualified calls (Go's `pkg.Func()`, Python's `module.func()`, Java's `ClassName.staticMethod()`, Rust's `module::func()`, Swift's `Target.func()`).
- State-machine transition detection (`machine X on Type.field { allow/deny transition }`) for the same five languages (`src/analyzers/assignment-guard.ts`), via the same guarded-assignment regex pattern already used for TypeScript/Kotlin/C#.
- Swift wired into real tree-sitter extraction for the first time — previously regex-only (`src/analyzers/ast/loader.ts`, `src/analyzers/ast/queries/swift.ts`, `src/analyzers/ast/ir-extractor.ts`).
- Extends/implements/conformance graph (`src/ir/abstraction-resolver.ts`) for Python, Java, Rust, and Swift, resolved against the project's declared symbols the same way imports/calls are. Go has no syntactic `implements` clause to read (interfaces are satisfied structurally), so it gets a separate name+arity method-set heuristic instead — always `probable` confidence, with a 2-method minimum to suppress false matches on common single-method interfaces.
- CI now runs a diff-aware `change_policy` check (`.github/workflows/ci.yml`) in addition to the existing whole-repo `--all` check, so this repo's own self-hosted `architecture.ag` rules are actually enforced per change, not just locally.

### Changed
- `tree-sitter` core dependency bumped `^0.21.1` → `^0.22.1` to allow `tree-sitter-swift`. Verified compatible with all existing language bindings at their pinned versions before bumping.

### Fixed
- Rust's `imports` edges were never emitted at all (tree-sitter capture-name mismatch between the query and the extractor).
- Java's `object.method()` calls were never emitted as `calls` edges — only `new X()` construction calls worked (same class of capture-name mismatch).
- Python's call-expression query never captured a receiver for `module.func()`-style calls, only bare function names.
- A tree-sitter row-grouping limitation silently dropped every relationship after the first in a multi-target clause (e.g. `implements A, B, C` would only ever see `A`).
- Java's and Rust's declaration queries never captured `interface`/`trait` declarations, only classes/structs/functions — meaning `implements`/`impl Trait for` clauses had nothing to resolve against.
- `examples/collivity-split/collivity.ag` failed to compile standalone (missing `CaptureSessionsApi` contract declaration present in the non-split `collivity-full.ag`).
