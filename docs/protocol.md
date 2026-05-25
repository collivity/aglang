# Agent Protocol Draft

This document defines the next protocol surface for aglang as an agent-first architecture and compliance service. The goal is to let parent agents, subagents, editors, and CI all consume the same normalized repository facts and policy verdicts instead of rebuilding context from raw code on every task.

This is a draft for the `v0.5` to `v1.0` transition. It is intentionally narrower than a full hosted service spec: it focuses on the contract agents need to coordinate bounded work safely.

## Goals

- Give agents a stable machine interface above the CLI.
- Separate semantic indexing from policy evaluation.
- Preserve provenance on every extracted fact.
- Make violation payloads strong enough for automated repair loops.
- Support single-repo and multi-repo workflows with the same core schema.

## Non-goals

- Defining transport. These operations can be exposed over MCP, HTTP, RPC, or a local daemon.
- Replacing the CLI immediately. `aglc` remains the reference implementation surface.
- Standardizing auth or tenancy yet. Those belong in a later hosted-service spec.

## Versioning

The protocol should be explicitly versioned.

```json
{
  "protocol_version": "0.1",
  "schema_version": 1
}
```

Compatibility rules:

- Minor protocol additions may add optional fields or new endpoint options.
- Existing required fields must not change semantics inside the same major protocol version.
- Fact and violation IDs must remain stable for the same repo snapshot and extraction result.

## Core Object Model

### RepositoryRef

```json
{
  "repo_id": "collivity/web-api",
  "root": "C:\\Users\\pante\\Codespaces\\collivity\\web\\api",
  "ref": {
    "kind": "working_tree",
    "branch": "master",
    "commit": "abc123def456"
  }
}
```

Fields:

- `repo_id`: stable logical repo identity
- `root`: checkout or workspace root
- `ref.kind`: `working_tree`, `commit`, or `branch`
- `ref.branch`: optional branch name
- `ref.commit`: optional commit SHA

### Component

```json
{
  "component_id": "ApiControllers",
  "repo_id": "collivity/web-api",
  "runs_on": "api_backend",
  "paths": "web/api/Controllers/**/*.cs"
}
```

### Fact

This extends the current normalized `GraphFact` / projected `FlowFact` model.

```json
{
  "fact_id": "fact:collivity/web-api:ApiControllers:postgres_db:fact-1",
  "kind": "accesses_technology",
  "subject": "ApiControllers",
  "target": "postgres_db",
  "technology": "postgres",
  "confidence": "definite",
  "provenance": {
    "extractor": "@collivity/aglc-roslyn",
    "strategy": "graph",
    "file": "web/api/Controllers/OrdersController.cs",
    "line": 18,
    "evidence": "Roslyn plugin resolved constructor dependency 'ApplicationDbContext'"
  }
}
```

Required fields:

- `fact_id`
- `kind`
- `subject`
- `confidence`
- `provenance.extractor`
- `provenance.strategy`
- `provenance.file`
- `provenance.evidence`

Optional fields:

- `target`
- `technology`
- `route`
- `model`
- `provenance.line`

### Violation

This extends the current JSON verdict contract with a stable ID and optional fix hints.

```json
{
  "violation_id": "viol:collivity/web-api:DataBoundary:Api:Data:src/api/orders.ts:1",
  "type": "flow_violation",
  "invariant": "DataBoundary",
  "rule_id": "DataBoundary:DenyFlow:Api:Data",
  "rule": {
    "kind": "DenyFlow",
    "from": "Api",
    "to": "Data"
  },
  "detected": {
    "from": "Api",
    "to": "Data",
    "confidence": "definite",
    "evidence": "Imports internal module '../data/store' from component 'Data'",
    "file": "src/api/orders.ts"
  },
  "graph_evidence": {
    "graphFactId": "legacy-flow:0:Api:Data:src/api/orders.ts:1",
    "kind": "accesses_technology",
    "extractor": "TypeScript AST/regex analyzer",
    "strategy": "ast",
    "file": "src/api/orders.ts",
    "line": 1,
    "evidence": "Imports internal module '../data/store' from component 'Data'"
  },
  "message": "Component 'Api' must NOT directly access 'Data' (invariant: DataBoundary)",
  "z3_proof": {
    "permanent_constraint": "(assert (=> (Flow Api Data) false))",
    "delta_assertion": "(assert (Flow Api Data))",
    "explanation": "Z3 returned UNSAT because the permanent deny-flow constraint contradicts the extracted delta assertion."
  },
  "fix_hints": {
    "safe_fix_class": "move_dependency",
    "suggested_components": ["Api", "Data"],
    "suggested_files": ["src/api/orders.ts", "src/data/store.ts"],
    "requires_architecture_approval": false
  }
}
```

### Scope

```json
{
  "scope": {
    "kind": "files",
    "files": [
      "src/api/orders.ts",
      "src/data/store.ts"
    ]
  }
}
```

Supported scope kinds:

- `file`
- `files`
- `component`
- `components`
- `diff`
- `repo`

## Endpoint Set

Each endpoint below is a logical operation. The transport can later map these to CLI commands, MCP tools, or service methods.

### `check_file`

Purpose:

- validate a single file inside the repo architecture context
- provide extractor trace output for agent edit loops

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "file_path": "src/api/orders.ts",
  "options": {
    "json": true,
    "debug_extractors": true,
    "require_ast": true,
    "strict": false
  }
}
```

Response:

```json
{
  "passed": false,
  "violations": [
    {
      "violation_id": "viol:collivity/web-api:DataBoundary:Api:Data:src/api/orders.ts:1",
      "type": "flow_violation",
      "message": "Component 'Api' must NOT directly access 'Data' (invariant: DataBoundary)"
    }
  ],
  "facts": [
    {
      "fact_id": "fact:collivity/web-api:Api:Data:src/api/orders.ts:1",
      "kind": "flow",
      "subject": "Api",
      "target": "Data",
      "confidence": "definite"
    }
  ],
  "extractor_debug": [
    {
      "extractor": "TypeScript AST/regex analyzer",
      "stage": "ast_query",
      "message": "Query 'IMPORT_QUERY' returned 1 capture(s)"
    }
  ]
}
```

### `check_scope`

Purpose:

- validate a bounded edit slice without rescanning the entire repo

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "scope": {
    "kind": "components",
    "components": ["Api", "Data"]
  },
  "options": {
    "debug_extractors": false,
    "strict": true
  }
}
```

Response:

```json
{
  "passed": false,
  "summary": {
    "files_checked": 12,
    "facts_emitted": 19,
    "violations": 2
  },
  "violations": [],
  "warnings": [],
  "affected_components": ["Api", "Data"]
}
```

### `check_repo`

Purpose:

- run a full repo compliance check
- power CI and baseline snapshots

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": {
      "kind": "commit",
      "commit": "abc123def456"
    }
  },
  "mode": "full"
}
```

Response:

```json
{
  "passed": false,
  "summary": {
    "violations_by_type": {
      "flow_violation": 3,
      "reach_violation": 1,
      "workflow_violation": 0
    },
    "components_touched": ["Api", "Data", "ReleaseWorkflow"]
  },
  "violations": [],
  "workflow_violations": [],
  "change_violations": []
}
```

### `graph_component`

Purpose:

- return the architecture-relevant neighborhood around a component

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "component_id": "Api",
  "options": {
    "direction": "both",
    "depth": 2,
    "include_provenance": true
  }
}
```

Response:

```json
{
  "component": {
    "component_id": "Api",
    "runs_on": "api_backend"
  },
  "facts": [],
  "nodes": ["Api", "Data", "postgres_db"],
  "warnings": []
}
```

### `trace_violation`

Purpose:

- expand one violation into the exact causal chain an agent needs to fix

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "violation_id": "viol:collivity/web-api:Layered:UI:Db"
}
```

Response:

```json
{
  "violation": {
    "violation_id": "viol:collivity/web-api:Layered:UI:Db",
    "type": "reach_violation"
  },
  "trace": {
    "path": ["UI", "Service", "Db"],
    "facts": [
      "fact:collivity/web-api:UI:Service:1",
      "fact:collivity/web-api:Service:Db:2"
    ],
    "files": [
      "src/ui/orders.ts",
      "src/service/orders-service.ts"
    ]
  },
  "z3_proof": {
    "permanent_constraint": "(assert (=> (CanReach UI Db) false))",
    "delta_assertion": "(assert (CanReach UI Db))"
  }
}
```

### `explain_violation`

Purpose:

- produce a repair-oriented explanation for parent-agent handoff

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "violation_id": "viol:collivity/web-api:DataBoundary:Api:Data:src/api/orders.ts:1"
}
```

Response:

```json
{
  "violation_id": "viol:collivity/web-api:DataBoundary:Api:Data:src/api/orders.ts:1",
  "summary": "Api imports a Data component file directly, violating DataBoundary.",
  "likely_fix_area": [
    "src/api/orders.ts",
    "src/data/store.ts"
  ],
  "safe_fix_class": "move_dependency",
  "requires_architecture_approval": false
}
```

### `list_facts`

Purpose:

- query normalized facts directly

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "filters": {
    "subject": "Api",
    "strategy": "ast",
    "extractor": "TypeScript AST/regex analyzer"
  }
}
```

Response:

```json
{
  "facts": []
}
```

### `find_related_files`

Purpose:

- identify the likely edit set around a violation or component

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "violation_id": "viol:collivity/web-api:DocsFreshness:CliCompiler"
}
```

Response:

```json
{
  "ranked_files": [
    {
      "file": "src/index.ts",
      "reason": "trigger component evidence"
    },
    {
      "file": "docs/cli/reference.md",
      "reason": "required companion change"
    },
    {
      "file": "README.md",
      "reason": "required companion change"
    }
  ]
}
```

### `suggest_fix_targets`

Purpose:

- turn a violation into a bounded repair assignment

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "violation_id": "viol:collivity/web-api:LayeredBackend:ApiControllers:postgres_db"
}
```

Response:

```json
{
  "safe_fix_class": "introduce_boundary_service",
  "suggested_components": [
    "ApiControllers",
    "Repositories"
  ],
  "suggested_files": [
    "web/api/Controllers/OrdersController.cs",
    "web/api/Repositories/OrdersRepository.cs"
  ],
  "confidence": "medium"
}
```

### `recheck_scope`

Purpose:

- revalidate after a patch using prior fact and violation context

Request:

```json
{
  "repo": {
    "repo_id": "collivity/web-api",
    "ref": { "kind": "working_tree" }
  },
  "changed_files": [
    "src/api/orders.ts"
  ],
  "previous_violation_ids": [
    "viol:collivity/web-api:DataBoundary:Api:Data:src/api/orders.ts:1"
  ]
}
```

Response:

```json
{
  "resolved_violations": [
    "viol:collivity/web-api:DataBoundary:Api:Data:src/api/orders.ts:1"
  ],
  "remaining_violations": [],
  "new_violations": []
}
```

### `list_contract_consumers`

Purpose:

- support cross-repo provider and consumer analysis

Request:

```json
{
  "contract_id": "UsersApi"
}
```

Response:

```json
{
  "implementers": [
    {
      "repo_id": "collivity/web-api",
      "component_id": "Backend"
    }
  ],
  "consumers": [
    {
      "repo_id": "collivity/creator-ui",
      "component_id": "Frontend"
    }
  ]
}
```

### `list_drift`

Purpose:

- compare current state against a stored baseline

Request:

```json
{
  "repo_id": "collivity/web-api",
  "baseline_ref": "release-2026-05-01",
  "current_ref": "master"
}
```

Response:

```json
{
  "new_drift": [],
  "existing_drift": [],
  "resolved_drift": []
}
```

### `manage_waiver`

Purpose:

- record a temporary exception with ownership and expiry

Request:

```json
{
  "repo_id": "collivity/web-api",
  "violation_id": "viol:collivity/web-api:LayeredBackend:ApiControllers:postgres_db",
  "owner": "platform-team",
  "reason": "repository split in progress",
  "expires_at": "2026-06-30T00:00:00Z"
}
```

Response:

```json
{
  "waiver_id": "waiver:collivity/web-api:LayeredBackend:ApiControllers:postgres_db",
  "status": "active"
}
```

## Parent / Subagent Workflow

The protocol is designed so a parent agent can decompose work without forcing each subagent to reconstruct the repo architecture by itself.

Example flow:

1. Parent agent calls `check_repo`.
2. Parent agent groups violations by component or fix class.
3. Parent agent delegates one violation or one scope per subagent.
4. Each subagent calls `trace_violation`, `find_related_files`, and `check_file`.
5. After edits, each subagent calls `recheck_scope`.
6. Parent agent calls `check_scope` or `check_repo` to verify the integrated result.

This is why stable IDs matter:

- `repo_id`
- `component_id`
- `fact_id`
- `violation_id`
- `contract_id`
- `rule_id`

Without stable IDs, coordination becomes prompt-only and brittle.

## Indexing vs Policy Evaluation

The protocol assumes two layers:

- an indexing layer that stores parsed semantic state and normalized facts
- a policy layer that evaluates those facts against `architecture.o`

That separation is important:

- indexing can be incremental and expensive
- policy evaluation should stay deterministic and reproducible
- local fallback should still be possible when the managed index is unavailable

## Roadmap Alignment

Recommended implementation order:

1. Freeze and document the core object model.
2. Add stable IDs for facts, violations, and components.
3. Expose single-repo endpoints over a local service or MCP server.
4. Add remediation metadata and bounded recheck.
5. Add persistent multi-repo graph and contract endpoints.
6. Add waivers, baselines, and tenancy.

This matches the roadmap in [roadmap.md](./roadmap.md) and gives aglang a path from strong local CLI to a real agent-first architecture protocol.
