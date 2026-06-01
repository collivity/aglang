# aglc Debug Report

- Artifact: `C:\Users\pante\Codespaces\aglang\architecture.o`
- Project: `C:\Users\pante\Codespaces\aglang`
- Scope: `all`
- Passed: `true`

## Files And Components

- DocsWorkflow: .github/workflows/docs.yml
- ReleaseWorkflow: .github/workflows/release.yml
- AgentContext: AGENTS.md
- ArchitectureSpec: architecture.ag
- CompiledArchitecture: architecture.o
- DocsSite: docs/agents.md, docs/api/json-verdict.md, docs/cli/reference.md, docs/examples.md, docs/extractors.md, docs/guide/contracts.md, docs/guide/generate.md, docs/guide/getting-started.md, docs/guide/language-reference.md, docs/guide/multi-repo.md, docs/how-it-works.md, docs/index.md, docs/protocol.md, docs/roadmap.md, scripts/build-docs.mjs, scripts/postinstall-agent-skill.mjs, scripts/tree-sitter-corpus-probe.ts, site/assets/agents.md.BF2w0j21.js, site/assets/agents.md.BF2w0j21.lean.js, site/assets/api_json-verdict.md.Xl3g7L8P.js, site/assets/api_json-verdict.md.Xl3g7L8P.lean.js, site/assets/app.CvTwPWEG.js, site/assets/chunks/@localSearchIndexroot.kvSsMKsX.js, site/assets/chunks/framework.OPxAocOb.js, site/assets/chunks/theme.CiP2pfYG.js, site/assets/chunks/VPLocalSearchBox.B-OfAW9O.js, site/assets/cli_reference.md.DMlQpCor.js, site/assets/cli_reference.md.DMlQpCor.lean.js, site/assets/extractors.md.CbRhfkeT.js, site/assets/extractors.md.CbRhfkeT.lean.js, site/assets/guide_contracts.md.CCAcBYEm.js, site/assets/guide_contracts.md.CCAcBYEm.lean.js, site/assets/guide_generate.md.CziSNJP3.js, site/assets/guide_generate.md.CziSNJP3.lean.js, site/assets/guide_getting-started.md.C9KG8MeS.js, site/assets/guide_getting-started.md.C9KG8MeS.lean.js, site/assets/guide_language-reference.md.BOB2phZ_.js, site/assets/guide_language-reference.md.BOB2phZ_.lean.js, site/assets/guide_multi-repo.md.JVlZPtZl.js, site/assets/guide_multi-repo.md.JVlZPtZl.lean.js, site/assets/how-it-works.md.CBNJDOxj.js, site/assets/how-it-works.md.CBNJDOxj.lean.js, site/assets/index.md.CxmJTvjQ.js, site/assets/index.md.CxmJTvjQ.lean.js
- PublicDocs: docs/agents.md, docs/api/json-verdict.md, docs/cli/reference.md, docs/examples.md, docs/extractors.md, docs/guide/contracts.md, docs/guide/generate.md, docs/guide/getting-started.md, docs/guide/language-reference.md, docs/guide/multi-repo.md, docs/how-it-works.md, docs/index.md, docs/protocol.md, docs/roadmap.md
- CliReferenceDocs: docs/cli/reference.md
- VscodeExtension: editors/vscode-aglang/src/extension.ts, editors/vscode-aglang/src/server.ts
- PackageMetadata: package-lock.json, package.json
- ReadmeDocs: README.md
- AgentSkillInstaller: scripts/postinstall-agent-skill.mjs
- SkillManifest: skill.json
- AgentSkill: skills/aglang/SKILL.md
- ExtractorAnalyzers: src/analyzers/ast/loader.ts, src/analyzers/ast/queries/csharp.ts, src/analyzers/ast/queries/golang.ts, src/analyzers/ast/queries/java.ts, src/analyzers/ast/queries/python.ts, src/analyzers/ast/queries/rust.ts, src/analyzers/ast/queries/swift.ts, src/analyzers/ast/queries/typescript.ts, src/analyzers/ast/walker.ts, src/analyzers/csharp.ts, src/analyzers/github-actions.ts, src/analyzers/golang.ts, src/analyzers/java.ts, src/analyzers/kotlin.ts, src/analyzers/load-balancer.ts, src/analyzers/node-resolver.ts, src/analyzers/plugin.ts, src/analyzers/python.ts, src/analyzers/routes.ts, src/analyzers/rust.ts, src/analyzers/swift.ts, src/analyzers/typescript-server.ts, src/analyzers/typescript.ts
- LanguageFrontend: src/ast.ts, src/checker.ts, src/import-openapi.ts, src/import-tf.ts, src/importer.ts, src/lexer.ts, src/parser.ts
- Emitters: src/emitters/agents.ts, src/emitters/artifact.ts, src/emitters/skill.ts
- SpecGenerator: src/generate.ts
- CliCompiler: src/index.ts
- RuntimeGate: src/runtime/contract-gate.ts, src/runtime/delta-assert.ts, src/runtime/diagnostic.ts, src/runtime/diff-parser.ts, src/runtime/extraction-cache.ts, src/runtime/gate.ts, src/runtime/state-machine.ts
- GraphProjection: src/runtime/graph-projection.ts
- SmtBackend: src/smt/solver.ts, src/smt/translator.ts
- Tests: tests/analyzers.test.ts, tests/ast-extractors.test.ts, tests/cache.test.ts, tests/change-policy.test.ts, tests/compiler.test.ts, tests/consent-cart-protocol.test.ts, tests/contract-gate.test.ts, tests/contract-syntax.test.ts, tests/di-policy.test.ts, tests/enterprise-z3-hardening.test.ts, tests/extraction-query.test.ts, tests/extractors.test.ts, tests/gdpr-dataflow.test.ts, tests/generate.test.ts, tests/graph-projection.test.ts, tests/lexer.test.ts, tests/plugin-protocol.test.ts, tests/project-check.test.ts, tests/rich-policy.test.ts, tests/state-machine-wildcard.test.ts, tests/tree-sitter-query-benchmark.test.ts, tests/tree-sitter-realtime.test.ts, tests/workflow-policy.test.ts

## Evidence Summary

- Flow facts: 18
- Graph facts: 679
- Reach facts: 22
- DI facts: 0
- Blocking transition facts: 0
- Warnings: 8

## Rule Surface

- Components: 24
- Invariants: 5
- Data policies: 0
- Trust policies: 0
- DI policies: 0
- Change policies: 1
- Workflow policies: 1
- State machines: 0

## Violations

- None

## Solver Diagnostics

- None

## Agent Tasks

- explain_blocking_violations: For each stable violation id, run aglc explain with the same scope and summarize the implementation repair before editing.
- review_weak_or_missing_evidence: Review warnings, empty graph projections, and unmapped files. Ask the engineer before changing .ag or .agq.yml.
- report_scope_to_engineer: Show the engineer which files mapped to which components, which rules were checked, and which evidence was extracted.

## Files Written

- `debug.json` - complete structured packet
- `graph.json` - extracted graph/projection evidence
- `query-traces.json` - semantic query matches, substitutions, and skipped captures
- `verdict.json` - check verdict for the selected scope
- `rules.json` - architecture rules and component mappings
- `agent-tasks.json` - suggested agent follow-up tasks
