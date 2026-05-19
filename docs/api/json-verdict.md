# JSON Verdict API

When running with `--json`, all check commands output a machine-readable JSON verdict to stdout. Progress logs go to stderr and can be suppressed.

## Verdict object

```typescript
interface Verdict {
  /** "pass" | "violation" | "error" */
  verdict: 'pass' | 'violation' | 'error'

  /** Present when verdict is "violation" */
  rule?: string

  /** Component name that triggered the violation */
  component?: string

  /** File that contains the offending code */
  file?: string

  /** Line number (1-based) if determinable */
  line?: number

  /** Human-readable explanation */
  message: string

  /** SMT model returned by Z3 (raw, for debugging) */
  smtModel?: Record<string, unknown>
}
```

## Examples

### Pass

```json
{
  "verdict": "pass",
  "message": "No architectural violations detected."
}
```

### Violation

```json
{
  "verdict": "violation",
  "rule": "SecureLedger",
  "component": "PublicGateway",
  "file": "src/api/gateway/checkout.py",
  "line": 44,
  "message": "Direct flow PublicGateway -> LedgerDatabase is denied by invariant SecureLedger"
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
    verdict=$(echo "$result" | jq -r '.verdict')
    if [ "$verdict" != "pass" ]; then
      echo "::error::$(echo "$result" | jq -r '.message')"
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

if (verdict.verdict === 'violation') {
  // Tell the agent exactly what to fix
  console.log(`Fix: ${verdict.message} in ${verdict.file}:${verdict.line}`)
}
```
