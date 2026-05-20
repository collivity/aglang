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
    check_file: string;
    check_project: string;
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
      'Validates code changes against architectural invariants enforced by the Z3 SMT solver. ' +
      'Use check_file before committing code to detect layering violations.',
    context_file: 'AGENTS.md',
    commands: {
      check_file:
        `aglc check-file --arch "${absArch}" --file <absolute_path_to_file> --json`,
      check_project:
        `aglc check --arch "${absArch}" --project <project_root> --all --json`,
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
        violations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type', 'invariant', 'rule', 'detected', 'message'],
            properties: {
              type: { type: 'string', enum: ['flow_violation'] },
              invariant: { type: 'string', description: 'Name of the violated invariant' },
              rule: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  from: { type: 'string', description: 'Source component' },
                  to: { type: 'string', description: 'Target component or node' },
                },
              },
              detected: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  confidence: { type: 'string', enum: ['definite', 'probable', 'possible'] },
                  evidence: { type: 'string', description: 'Human-readable description of the detected pattern' },
                  file: { type: 'string', description: 'Absolute path to the file containing the violation' },
                },
              },
              message: { type: 'string', description: 'Human-readable violation message' },
            },
          },
        },
        contract_violations: {
          type: 'array',
          description: 'API contract violations (route mismatches between implements/consumes components)',
          items: {
            type: 'object',
            properties: {
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
          items: { type: 'object' },
        },
        change_violations: {
          type: 'array',
          description: 'Required companion changes missing from the checked diff',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['change_violation'] },
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
        smt_model: { type: ['string', 'null'], description: 'Z3 SAT model (null when UNSAT/violation)' },
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
      'Enforcement is declaration-specific. Flow deny invariants and change_policy rules are Z3-backed. ' +
      'Contracts and workflow policies are deterministic policy gates. State machines, permissions, and encryption requirements are advisory unless this manifest says otherwise.',
  };
}

export function writeSkillManifest(manifest: SkillManifest, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
}
