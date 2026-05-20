# JSON Verdict API

When running with `--json`, all check commands output a machine-readable JSON verdict to stdout. Progress logs go to stderr and can be suppressed.

## Verdict object

```typescript
interface Verdict {
  schema_version: 2
  passed: boolean
  timestamp: string
  artifact: string

  violations: FlowViolation[]
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

Flow violations may also have `"type": "dataflow_violation"` when a `deny dataflow` invariant is violated. These include the denied data type in `detected.data` and the component that carried it in `detected.via`.

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
