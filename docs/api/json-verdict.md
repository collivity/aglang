# JSON Verdict API

When running with `--json`, all check commands output a machine-readable JSON verdict to stdout. Progress logs go to stderr and can be suppressed.

## Verdict object

```typescript
interface Verdict {
  schema_version: 2
  passed: boolean
  timestamp: string
  artifact: string

  violations: ArchitectureViolation[]
  contract_violations: ContractViolation[]
  workflow_violations: WorkflowViolation[]
  change_violations: ChangeViolation[]

  warnings: FlowWarning[]
  contract_warnings: ContractViolation[]
  workflow_warnings: WorkflowWarning[]

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

Dependency-injection policy failures include the violated `di_policy` name, the detected constructor/lifetime/service-locator evidence, and a Z3 proof. Reach-based DI failures may include `detected.path`.

```json
{
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

### Change policy violation

```json
{
  "schema_version": 2,
  "passed": false,
  "change_violations": [
    {
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
