# JSON Verdict API

When running with `--json`, all check commands output a machine-readable JSON verdict to stdout. Progress logs go to stderr and can be suppressed.

## Verdict object

```typescript
interface Verdict {
  schema_version: 2
  passed: boolean
  timestamp: string
  artifact: string

  diff?: {
    base: string
    mode: "git_ref" | "staged" | "all"
    changed_files: string[]
    changed_components: string[]
  }

  violations: ArchitectureViolation[]
  contract_violations: ContractViolation[]
  workflow_violations: WorkflowViolation[]
  change_violations: ChangeViolation[]

  warnings: FlowWarning[]
  contract_warnings: ContractViolation[]
  workflow_warnings: WorkflowWarning[]

  rule_coverage?: Array<{
    rule: string
    declaration: string
    components: string[]
    evidence: string[]
  }>

  solver_diagnostics: Array<{
    id: string
    status: "sat" | "unsat" | "unknown" | "error"
    elapsed_ms: number
    rule: string
    declaration: string
    source_file?: string
    line?: number
    components: string[]
    data?: string
    fact_count: number
    path_depth?: number
    fanout?: number
    reason?: string
    suggested_refactor?: string
  }>

  smt_model: string | null
  agent_context: string
}
```

## Examples

### Pass

```json
{
  "schema_version": 2,
  "passed": true,
  "violations": [],
  "contract_violations": [],
  "workflow_violations": [],
  "change_violations": [],
  "warnings": [],
  "contract_warnings": [],
  "workflow_warnings": []
}
```

### Violation

```json
{
  "schema_version": 2,
  "passed": false,
  "workflow_violations": [
    {
      "type": "workflow_violation",
      "policy": "ReleaseSafety",
      "workflow": "DocsWorkflow",
      "file": ".github/workflows/docs.yml",
      "message": "publish to npm_registry is not covered by any matching allow rule",
      "evidence": "run: npm publish"
    }
  ]
}
```

Architecture violations use these `type` values:

- `flow_violation` for direct `deny flow`.
- `reach_violation` for transitive `deny reach`; `detected.path` contains the proof path.
- `dataflow_violation` for `deny dataflow`; `detected.data` and `detected.via` identify the propagated data.
- `data_policy_violation` for `data_policy` classification or jurisdiction rules.
- `trust_policy_violation` for `trust_policy` auth or classified trust-boundary rules.
- `di_violation` for dependency-injection policy failures.
- `permission_violation` for protected operations missing matching authorization evidence when an extractor can prove the operation.
- `state_machine_violation` for query-extracted transitions that violate a `machine` declaration.

Blocking violations include a stable `id` field derived from the rule, fact kind, components or data, and source evidence. In `aglc check --diff <ref> --json` output, violations are marked with `status: "new"` because the check scope is the changed file set for `<ref>...HEAD`; staged and `--all` scopes use `status: "unchanged"` when status is present.

`solver_diagnostics[]` reports the rule-specific solver slices checked before the full SMT script. Each slice is a small proof obligation with provenance. `unsat` slices identify the exact rule/fact contradiction; `unknown` or `error` slices fail closed and include `suggested_refactor` text based on path depth, fanout, declaration type, and source evidence.

Dependency-injection policy failures include the violated `di_policy` name, the detected constructor/lifetime/service-locator evidence, and a Z3 proof. Reach-based DI failures may include `detected.path`.

```json
{
  "id": "viol_1d2c2dcf56af9a92",
  "type": "di_violation",
  "invariant": "DependencyInjection",
  "rule": { "kind": "DenyLifetime", "from": "singleton", "to": "scoped" },
  "detected": {
    "from": "BleManager",
    "to": "Repositories",
    "confidence": "definite",
    "evidence": "BleManager (singleton) constructor-injects Repositories (scoped)",
    "file": "src/Infrastructure/Bluetooth/BleManager.cs"
  },
  "z3_proof": {
    "permanent_constraint": "(assert (=> (LifetimeDepends Lifetime__singleton Lifetime__scoped) false))",
    "delta_assertion": "(assert (LifetimeDepends Lifetime__singleton Lifetime__scoped))"
  }
}
```

State-machine failures include the violated machine, the transition edge, the source file, the query that emitted the transition, and the graph fact id that was matched:

```json
{
  "id": "viol_4d72958c9c079a2f",
  "type": "state_machine_violation",
  "invariant": "OrderLifecycle",
  "rule": {
    "kind": "Transition",
    "from": "PendingPayment",
    "to": "Fulfilled",
    "data": "Order",
    "field": "status"
  },
  "detected": {
    "from": "PendingPayment",
    "to": "Fulfilled",
    "data": "Order",
    "confidence": "definite",
    "evidence": "Extraction query 'StripeOrderLifecycleKotlinAssignments' matched assignment: order.status = OrderStatus.Fulfilled",
    "file": "examples/stripe-order-workflow/android/CheckoutViewModel.kt",
    "query": {
      "id": "StripeOrderLifecycleKotlinAssignments",
      "version": 1,
      "file": "examples/stripe-order-workflow/.aglang/extractors/order-lifecycle-kotlin.agq.yml",
      "graphFactId": "kotlin-semantic:...CheckoutViewModel.kt:19:assignment:..."
    }
  },
  "z3_proof": {
    "permanent_constraint": "(assert (=> (Transition Order Field__Order__status State__OrderStatus__PendingPayment State__OrderStatus__Fulfilled) false))",
    "delta_assertion": "(assert (Transition Order Field__Order__status State__OrderStatus__PendingPayment State__OrderStatus__Fulfilled))"
  }
}
```

The equivalent human-readable log prints the same fields: machine name, transition, source file, evidence, query id/version, query file, graph fact id, and conflicting SMT assertions.

### Solver diagnostics

```json
{
  "solver_diagnostics": [
    {
      "id": "viol_8ef9d7c21f6f2a90",
      "status": "unsat",
      "elapsed_ms": 4,
      "rule": "Layers",
      "declaration": "invariant deny reach",
      "source_file": "src/ui/orders.ts",
      "components": ["UI", "Service", "Db"],
      "fact_count": 2,
      "path_depth": 3,
      "fanout": 7
    },
    {
      "id": "viol_6cb47bbfb077d4da",
      "status": "unknown",
      "elapsed_ms": 750,
      "rule": "OrderLifecycle",
      "declaration": "machine",
      "source_file": "CheckoutService.cs",
      "components": ["Order"],
      "data": "Order.status",
      "fact_count": 1,
      "reason": "timeout or resource limit",
      "suggested_refactor": "Reduce ambiguous state writes by routing this state field through a small transition helper or command handler."
    }
  ]
}
```

When any rule slice returns `unknown` or `error`, the check fails closed even if the full script has not run. This gives agents a smaller refactoring target than a whole-repository solver failure.

### Change policy violation

```json
{
  "schema_version": 2,
  "passed": false,
  "change_violations": [
    {
      "id": "viol_b10e9ab8b87cdb34",
      "type": "change_violation",
      "policy": "DocsFreshness",
      "trigger": "CliCompiler",
      "required": "CliReferenceDocs",
      "message": "DocsFreshness requires CliReferenceDocs when CliCompiler changes",
      "trigger_files": ["src/index.ts"],
      "required_glob": "docs/cli/reference.md",
      "z3_proof": {
        "policy_constraint": "(assert (=> Touched_CliCompiler Touched_CliReferenceDocs))",
        "trigger_assertion": "(assert Touched_CliCompiler)",
        "missing_assertion": "(assert (not Touched_CliReferenceDocs))"
      }
    }
  ]
}
```

## Explain output

`aglc explain --arch architecture.o --project . --violation <id> --json` re-runs the selected scope and returns a deterministic explanation:

```json
{
  "schema_version": 2,
  "found": true,
  "violation_id": "viol_4d72958c9c079a2f",
  "type": "state_machine_violation",
  "rule": "OrderLifecycle",
  "spec_citation": "architecture.ag",
  "source": {
    "file": "CheckoutViewModel.kt",
    "evidence": "Extraction query 'OrderLifecycleTransitions' matched assignment"
  },
  "graph_fact_chain": [],
  "z3_proof": {
    "permanent_constraint": "(assert ...)",
    "delta_assertion": "(assert ...)"
  },
  "fix_class": "fix_state_transition",
  "suggested_fix": "Move the state assignment ...",
  "diff": {
    "base": "staged",
    "mode": "staged",
    "changed_files": ["CheckoutViewModel.kt"],
    "changed_components": ["AndroidCheckout"]
  }
}
```

### Error (config/parse problem)

```json
{
  "verdict": "error",
  "message": "Could not load architecture.o: file not found. Run aglc compile first."
}
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Pass — no violations |
| `1` | Violation — commit blocked |
| `2` | Error — check could not complete |

## Using the API in CI

```yaml
# .github/workflows/arch-check.yml
- name: Architecture check
  run: |
    result=$(aglc check --arch architecture.o --project . --json)
    echo "$result"
    passed=$(echo "$result" | jq -r '.passed')
    if [ "$passed" != "true" ]; then
      echo "::error::aglang policy violation"
      exit 1
    fi
```

## Using the API with agents

```typescript
import { execSync } from 'child_process'

const result = execSync('aglc check --arch architecture.o --project . --json', {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe']
})

const verdict = JSON.parse(result)

if (!verdict.passed) {
  // Tell the agent exactly what to fix
  console.log(verdict.agent_context)
}
```
