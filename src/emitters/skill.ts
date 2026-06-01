// Skill manifest emitter — generates skill.json for AI agent consumption
// The skill manifest tells agents how to invoke aglang and what the output schema is.
import type { ArchitectureArtifact } from './artifact.ts';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

export interface SkillManifest {
  skill: string;
  version: string;
  description: string;
  context_file: string;
  commands: {
    request_scan: string;
    request_review: string;
    check_file: string;
    check_project: string;
    check_project_diff: string;
    explain_violation: string;
    debug_scope: string;
    emit_context: string;
  };
  violation_schema: object;
  enforcement: Array<{
    declaration: string;
    level: string;
    mechanism: string;
  }>;
  confidence_levels: Record<string, string>;
  advisory_note: string;
}

export function emitSkillManifest(artifact: ArchitectureArtifact, archPath: string): SkillManifest {
  const absArch = resolve(archPath);

  return {
    skill: 'aglang-architecture-guard',
    version: '1.0',
    description:
      'Verifies extracted and reviewed architecture facts against Z3-backed rules and deterministic policies. ' +
      'Use check_file or check_project_diff while coding, then explain_violation to repair failed checks from stable ids.',
    context_file: 'AGENTS.md',
    commands: {
      request_scan:
        `aglc request-scan --project <project_root> --out .aglang/tasks/architecture-discovery.json`,
      request_review:
        `aglc request-review --project <project_root> --out .aglang/tasks/architecture-review.json`,
      check_file:
        `aglc check-file --arch "${absArch}" --file <absolute_path_to_file> --json`,
      check_project:
        `aglc check --arch "${absArch}" --project <project_root> --all --json`,
      check_project_diff:
        `aglc check --arch "${absArch}" --project <project_root> --diff <git_ref> --json`,
      explain_violation:
        `aglc explain --arch "${absArch}" --project <project_root> --violation <violation_id> --json`,
      debug_scope:
        `aglc debug --arch "${absArch}" --project <project_root> --all --out .aglang/debug`,
      emit_context:
        `aglc emit-context --arch "${absArch}" --out AGENTS.md`,
    },
    violation_schema: {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['schema_version', 'passed', 'timestamp', 'artifact', 'violations', 'contract_violations', 'workflow_violations', 'change_violations', 'warnings', 'contract_warnings'],
      properties: {
        schema_version: { type: 'integer', enum: [2] },
        passed: { type: 'boolean', description: 'true = commit allowed, false = violations detected' },
        timestamp: { type: 'string', format: 'date-time' },
        artifact: { type: 'string', description: 'Path to the architecture.o file used' },
        diff: {
          type: 'object',
          description: 'Checked diff scope metadata for staged, --diff, or --all checks',
          properties: {
            base: { type: 'string' },
            mode: { type: 'string', enum: ['git_ref', 'staged', 'all'] },
            changed_files: { type: 'array', items: { type: 'string' } },
            changed_components: { type: 'array', items: { type: 'string' } },
          },
        },
        violations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type', 'invariant', 'rule', 'detected'],
            properties: {
              id: {
                type: 'string',
                description: 'Stable violation id; pass to explain_violation for the deterministic repair loop',
              },
              status: {
                type: 'string',
                enum: ['new', 'unchanged'],
                description: 'Diff-relative status when available',
              },
              type: {
                type: 'string',
                enum: [
                  'flow_violation',
                  'reach_violation',
                  'require_flow_violation',
                  'require_operation_violation',
                  'dataflow_violation',
                  'data_policy_violation',
                  'trust_policy_violation',
                  'di_violation',
                  'permission_violation',
                  'state_machine_violation',
                  'value_policy_violation',
                  'operation_policy_violation',
                  'event_policy_violation',
                ],
              },
              invariant: { type: 'string', description: 'Name of the violated invariant' },
              rule: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  from: { type: 'string', description: 'Source component' },
                  to: { type: 'string', description: 'Target component or node' },
                  via: { type: 'string', description: 'Required intermediate component for require-flow violations' },
                  operation: { type: 'string', description: 'Operation name for require-operation violations' },
                  component: { type: 'string', description: 'Required component for require-operation rules' },
                  data: { type: 'string', description: 'Data type for data policy violations' },
                  field: { type: 'string', description: 'Data field for state-machine violations' },
                },
              },
              detected: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  data: { type: 'string' },
                  via: { type: 'string' },
                  path: { type: 'array', items: { type: 'string' } },
                  confidence: { type: 'string', enum: ['definite', 'probable', 'possible'] },
                  evidence: { type: 'string', description: 'Human-readable description of the detected pattern' },
                  file: { type: 'string', description: 'Absolute path to the file containing the violation' },
                  query: {
                    type: 'object',
                    description: 'Reviewed semantic query provenance when the fact came from .agq.yml',
                    properties: {
                      id: { type: 'string' },
                      version: { type: ['number', 'string'] },
                      file: { type: 'string' },
                      graphFactId: { type: 'string' },
                    },
                  },
                  operation: { type: 'string', description: 'Detected operation name for require-operation violations' },
                  required_component: { type: 'string', description: 'Required component for detected operation placement' },
                },
              },
              message: { type: 'string', description: 'Human-readable violation message' },
              z3_proof: { type: 'object', description: 'Conflicting permanent constraint and extracted delta assertion' },
            },
          },
        },
        contract_violations: {
          type: 'array',
          description: 'API contract violations (route mismatches between implements/consumes components)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable violation id when available' },
              status: { type: 'string', enum: ['new', 'unchanged'] },
              type: { type: 'string', enum: ['implements_undeclared', 'consumes_undeclared', 'consumes_method_mismatch'] },
              severity: { type: 'string', enum: ['error', 'warning'] },
              contract: { type: 'string' },
              component: { type: 'string' },
              role: { type: 'string', enum: ['implements', 'consumes'] },
              declared: { type: ['string', 'null'] },
              extracted: { type: ['string', 'null'] },
              proof: { type: 'object' },
            },
          },
        },
        workflow_violations: {
          type: 'array',
          description: 'GitHub Actions workflow policy violations',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable violation id when available' },
              status: { type: 'string', enum: ['new', 'unchanged'] },
              type: { type: 'string' },
              policy: { type: 'string' },
              workflow: { type: 'string' },
              file: { type: 'string' },
              message: { type: 'string' },
              evidence: { type: 'string' },
              proof: { type: 'object' },
            },
          },
        },
        change_violations: {
          type: 'array',
          description: 'Required companion changes missing from the checked diff',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['change_violation'] },
              id: { type: 'string', description: 'Stable violation id' },
              status: { type: 'string', enum: ['new', 'unchanged'] },
              policy: { type: 'string' },
              trigger: { type: 'string' },
              required: { type: 'string' },
              message: { type: 'string' },
              trigger_files: { type: 'array', items: { type: 'string' } },
              required_glob: { type: 'string' },
              z3_proof: { type: 'object' },
            },
          },
        },
        rule_coverage: {
          type: 'array',
          description: 'Optional summary of rules checked and source evidence used',
          items: {
            type: 'object',
            properties: {
              rule: { type: 'string' },
              declaration: { type: 'string' },
              components: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        warnings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              evidence: { type: 'string' },
              file: { type: 'string' },
            },
          },
        },
        contract_warnings: {
          type: 'array',
          description: 'Non-blocking contract observations (undeclared fetch calls, advisory encryption rules)',
          items: { type: 'object' },
        },
        workflow_warnings: {
          type: 'array',
          description: 'Non-blocking workflow observations',
          items: { type: 'object' },
        },
        smt_model: { type: ['string', 'null'], description: 'Z3 SAT model (null when UNSAT/violation)' },
        solver_diagnostics: {
          type: 'array',
          description: 'Rule-sized solver slice results with provenance and refactor suggestions for path-explosion or expensive checks',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['sat', 'unsat', 'unknown', 'error'] },
              elapsed_ms: { type: 'number' },
              rule: { type: 'string' },
              declaration: { type: 'string' },
              source_file: { type: 'string' },
              line: { type: 'number' },
              components: { type: 'array', items: { type: 'string' } },
              data: { type: 'string' },
              fact_count: { type: 'number' },
              path_depth: { type: 'number' },
              fanout: { type: 'number' },
              reason: { type: 'string' },
              suggested_refactor: { type: 'string' },
            },
          },
        },
        agent_context: { type: 'string', description: 'Plain-text summary for agent consumption' },
      },
    },
    enforcement: artifact.enforcement ?? [],
    confidence_levels: {
      definite: 'BLOCKING — Pattern is definitively detected (e.g. DI constructor injection). Will fail the gate.',
      probable:  'WARNING — Pattern is likely present (e.g. new-instantiation) but not certain. Non-blocking.',
      possible:  'INFO — Pattern may be present. Informational only. Never blocks.',
    },
    advisory_note:
      'Enforcement is declaration-specific. Flow deny invariants, state machines, and change_policy rules are Z3-backed. ' +
      'Reachability, require-flow paths, require-operation placement, propagated dataflow, trust boundary, DI, contract, workflow, value, operation, and event policies are enforced when extractors or reviewed queries produce definite evidence. ' +
      'Auth, encryption, dependency, operation, value, operation_event, and event facts must come from deterministic extractors or reviewed .agq.yml files, not LLM calls during check. Ask before changing .ag or .agq.yml files to satisfy a require or rich policy violation.',
  };
}

export function writeSkillManifest(manifest: SkillManifest, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
}
