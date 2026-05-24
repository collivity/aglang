# Roadmap

aglang is already useful as a local CLI and commit-time guard. The next goal is narrower and harder: make it the architecture guardrail protocol that different agents, subagents, editors, and CI systems can all speak consistently.

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
2. Official MCP server
3. Better TS extraction
4. Proper agent behavior spec
5. Conformance tests

## Suggested issue split

Use this roadmap as the top-level epic set:

- `Epic: v0.3 stable machine interfaces`
- `Epic: v0.4 multi-agent integration`
- `Epic: v0.5 policy authoring ergonomics`
- `Epic: v1.0 protocol standardization`

Then split each epic into bounded delivery issues with one implementation surface each:

- schema / artifact
- CLI / MCP surface
- extractor work
- docs / examples
- conformance / tests
