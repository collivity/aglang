# Roadmap

aglang is already useful as a local CLI and CI-friendly architecture verification layer. The next goal is narrower and harder: make it the architecture guardrail protocol that different agents, subagents, editors, and CI systems can all speak consistently.

This roadmap is organized as issue-ready milestones. Each section can be copied directly into a GitHub epic or split into smaller delivery issues.

## `v0.3` - Stable machine interfaces

Focus: make aglang a dependable machine contract instead of only a strong CLI.

### Scope

- Freeze and document the JSON verdict schema.
- Freeze and document the `architecture.o` schema, required fields, and compatibility rules.
- Add capability discovery for:
  - schema version
  - supported policy kinds
  - extractor coverage
  - confidence semantics
- Tighten TypeScript and JavaScript extraction:
  - component imports
  - `fetch` / `axios` / common HTTP clients
  - Express / Fastify / Next route extraction
  - direct DB client detection
- Publish a default agent behavior contract:
  - read `AGENTS.md`
  - use `check-file` while editing
  - use `check --all` before finishing
  - do not mutate `.ag` files without approval

### Exit criteria

- Agents can discover what aglang supports without reading prose docs.
- Verdict JSON is versioned and documented as a stable interface.
- `architecture.o` is treated as a formal contract, not an internal artifact.
- TS/JS users can get credible flow extraction in a normal service or monorepo.

## `v0.4` - Multi-agent integration

Focus: let different agent runtimes share the same guarded view of the repo.

### Scope

- Ship an official MCP server for aglang.
- Add protocol-style operations:
  - `get_rules_for_file`
  - `check_file`
  - `check_project`
  - `graph_project`
  - `get_change_requirements`
  - `explain_violation`
- Add shared task-envelope output:
  - touched components
  - blocking policies
  - required companion changes
  - relevant architecture files
- Improve violation evidence and path summaries for subagent handoff.
- Strengthen authorization extraction:
  - C# policy attributes
  - `RequireAuthorization(...)`
  - authorization handlers
  - common TS middleware patterns where evidence is definite

### Exit criteria

- Codex-style agents, editor agents, and CI can call the same aglang interface.
- Subagents can receive a bounded architecture context instead of rereading the whole repo.
- Violations are explainable enough for automated repair loops.

## `v0.5` - Easier policy authoring

Focus: reduce the cost of adoption for teams that are not architecture-language enthusiasts.

### Scope

- Improve starter generation from real repos.
- Add stack-specific templates:
  - TypeScript monorepo
  - ASP.NET
  - Python service
  - GitHub Actions-heavy repo
- Improve malformed-policy diagnostics and missing-evidence diagnostics.
- Improve editor support:
  - completions
  - validation
  - quick fixes
- Add more public examples and golden demo repos.

### Exit criteria

- A team can adopt aglang without a custom workshop.
- New specs start from credible templates instead of blank files.
- Policy errors are precise enough to fix quickly.

## `v0.6` - Agent protocol and remediation

Focus: make aglang a usable coordination layer for parent agents and subagents, not only a checker.

### Scope

- Publish the first protocol draft for:
  - repository refs
  - normalized facts
  - stable fact and violation IDs
  - scope-aware check operations
  - remediation hints
- Expose protocol operations over a machine interface:
  - `check_file`
  - `check_scope`
  - `check_repo`
  - `graph_component`
  - `trace_violation`
  - `find_related_files`
  - `suggest_fix_targets`
  - `recheck_scope`
- Add fix metadata to violations:
  - suggested files
  - suggested components
  - safe fix class
  - architecture-approval requirement
- Add bounded recheck so subagents can verify only the slice they changed.

### Exit criteria

- Parent agents can assign violations to subagents using stable IDs.
- Subagents can recheck their own scope without forcing a full repo rerun.
- Violation payloads are strong enough to support automated repair loops.

## `v0.7` - Cross-repo compliance graph

Focus: connect multiple repos into one architecture and drift surface.

### Scope

- Add repo registry and repo identity model.
- Add persistent multi-repo graph:
  - components
  - contracts
  - dependencies
  - extracted facts
- Add cross-repo operations:
  - `list_contract_consumers`
  - `list_drift`
  - impact traces across repos
- Add waiver and baseline lifecycle for real environments.

### Exit criteria

- A provider or consumer change can be traced across repos.
- Parent agents can coordinate multi-repo repair tasks from one protocol surface.
- Existing accepted drift can be separated from newly introduced drift.

## `v0.8` - Enterprise readiness and audit evidence

Focus: make aglang credible for enterprise adoption by improving evidence quality, repeatable audit artifacts, CI integration, governance, and security posture.

### Scope

- Improve evidence quality:
  - publish extractor capability matrices per language and framework
  - attach source, extractor, confidence, strategy, and extractor version to every emitted fact
  - add golden fixture suites for ASP.NET, Spring, Express/Nest, FastAPI, Go HTTP, Kotlin Android, Swift, Terraform, and GitHub Actions
  - add `aglc query-test` for `.agq.yml` fixtures
- Add audit artifacts:
  - emit hash-linked reports covering `.ag`, `.agq.yml`, `architecture.o`, CLI version, git SHA, changed files, verdict, and plugin metadata
  - add `aglc report --json --html --sarif`
  - support SARIF output for GitHub code scanning
  - persist stable violation IDs and `aglc explain` output in report form
- Strengthen CI/CD integration:
  - ship official GitHub Actions, GitLab CI, and Azure DevOps examples
  - add baseline mode so known violations can be accepted while new violations still fail
  - add `--severity-threshold`
  - document clean machine setup for monorepos and multi-repos
- Improve spec governance:
  - add owner metadata for rules, components, semantic queries, and generated context
  - add `aglc review` to show the semantic impact of `.ag` and `.agq.yml` edits
  - add drift detection for unmapped code, stale components, and rules with no evidence
  - treat generated query/spec changes as privileged architecture changes in docs and machine output
- Mature the query layer:
  - add stricter `.agq.yml` schema validation and diagnostics
  - add query dry-run output showing matched graph facts before emitting blocking facts
  - add query coverage showing which rules had evidence and which did not
  - support versioned query packs for common frameworks
- Improve performance and scale:
  - benchmark large repos and publish baseline numbers
  - improve extractor cache invalidation
  - parallelize extractor execution safely
  - make solver slice diagnostics first-class with timeout budgets, hotspot ranking, and suggested decomposition
- Improve developer UX:
  - make `aglc explain` the primary repair loop
  - add `aglc doctor`
  - add `aglc init-ci`
  - improve diagnostics for no matched files, no rule evidence, empty query matches, and missing architecture artifacts
  - add examples that show complete violation-to-repair workflows
- Harden security and trust:
  - pin and record plugin versions
  - sandbox external plugins where practical
  - record plugin binary/package hashes in verdicts and reports
  - support offline and locked execution
  - document review requirements for generated specs and queries
- Add enterprise reporting surfaces:
  - rule coverage over time
  - violations by repo/team
  - stale specs and unmapped files
  - slow solver slices and path-explosion hotspots
  - unowned rules/components

### Exit criteria

- An enterprise can see exactly which facts were extracted, by which extractor/query, from which source, and under which tool version.
- CI can fail only on new or severe violations while retaining a durable audit trail.
- `.ag` and `.agq.yml` changes have reviewable semantic impact summaries.
- Reports are suitable for security, platform, and compliance review without requiring raw CLI logs.
- Large-repo failure modes are diagnosable instead of looking like generic solver or extractor failures.

## `v1.0` - Protocol status

Focus: standardize the interface and make third-party integrations realistic.

### Scope

- Publish a standalone protocol specification.
- Guarantee backward compatibility for:
  - verdict JSON
  - `architecture.o`
  - MCP methods
- Add reference integrations for:
  - GitHub Actions
  - GitLab CI
  - one local agent runtime
  - one editor agent runtime
- Raise extractor credibility in common stacks.
- Ship conformance tests for external integrations.

### Exit criteria

- aglang is no longer just a repo tool; it is a stable architecture protocol.
- Third-party runtimes can implement against published contracts with confidence.
- Compatibility promises are explicit and test-backed.

## Highest-leverage priorities

If only a few things move next, they should be these:

1. Stable schema and capability discovery
2. Evidence and query testing
3. Official MCP server
4. Better TS extraction
5. CI/reporting outputs
6. Conformance tests

## Suggested issue split

Use this roadmap as the top-level epic set:

- `Epic: v0.3 stable machine interfaces`
- `Epic: v0.4 multi-agent integration`
- `Epic: v0.5 policy authoring ergonomics`
- `Epic: v0.6 agent protocol and remediation`
- `Epic: v0.7 cross-repo compliance graph`
- `Epic: v0.8 enterprise readiness and audit evidence`
- `Epic: v1.0 protocol standardization`

Then split each epic into bounded delivery issues with one implementation surface each:

- schema / artifact
- CLI / MCP surface
- extractor work
- docs / examples
- reports / CI integrations
- security / plugin trust
- conformance / tests
