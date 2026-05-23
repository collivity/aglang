// Z3 Gate — loads architecture.o + delta assertions → SAT/UNSAT verdict
import { checkConstraints } from '../smt/solver.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { ArtifactInvariantRule, ArtifactDiPolicyRule } from '../emitters/artifact.ts';
import type { DeltaResult } from './delta-assert.ts';
import type { DiFact } from '../analyzers/csharp.ts';
import type { ContractViolation } from './contract-gate.ts';
import type { WorkflowViolation } from './workflow-gate.ts';
import type { ChangeViolation } from './change-gate.ts';

export interface Z3Proof {
  // The permanent constraint assertion from the compiled .arch spec
  permanent_constraint: string;
  // The dynamic delta assertion derived from the code change
  delta_assertion: string;
  // Human-readable explanation of what the two assertions mean
  explanation: string;
}

export interface GateViolation {
  type: 'flow_violation' | 'dataflow_violation' | 'di_violation';
  invariant: string;
  rule: ArtifactInvariantRule | ArtifactDiPolicyRule;
  detected: {
    from: string;
    to: string;
    data?: string;
    via?: string;
    confidence: string;
    evidence: string;
    file: string;
  };
  graph_evidence?: {
    graphFactId: string;
    kind: string;
    extractor?: string;
    strategy?: string;
    file?: string;
    line?: number;
    evidence: string;
  };
  message: string;
  // Z3 proof: exact SMT assertions that caused UNSAT — this is the mathematical evidence
  z3_proof: Z3Proof;
}

export interface GateVerdict {
  passed: boolean;
  violations: GateViolation[];
  warnings: Array<{ from: string; to: string; evidence: string; file: string }>;
  contract_violations?: ContractViolation[];
  contract_warnings?: ContractViolation[];
  workflow_violations?: WorkflowViolation[];
  workflow_warnings?: Array<{ workflow: string; file: string; message: string }>;
  change_violations?: ChangeViolation[];
  model?: string;
}

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildPermanentConstraint(rule: { kind: string; from: string; to: string }): string {
  const from = smtId(rule.from);
  const to = smtId(rule.to);
  if (rule.kind === 'DenyFlow') {
    return `(assert (=> (Flow ${from} ${to}) false))`;
  } else if (rule.kind === 'RequireEncryption') {
    return `(assert (=> (Flow ${from} ${to}) (Encrypted ${from} ${to})))`;
  }
  return `(assert (=> (Flow ${from} ${to}) false))`;
}

function buildDataPermanentConstraint(rule: { kind: 'DenyDataFlow'; data: string; to: string }): string {
  return `(assert (=> (DataFlow ${smtId(rule.data)} ${smtId(rule.to)}) false))`;
}

function buildDiPermanentConstraint(rule: ArtifactDiPolicyRule): string {
  if (rule.kind === 'DenyInject') {
    return `(assert (=> (Injects ${smtId(rule.from)} ${smtId(rule.to)}) false))`;
  }
  if (rule.kind === 'DenyLifetime') {
    return `(assert (=> (LifetimeDepends Lifetime__${rule.from} Lifetime__${rule.to}) false))`;
  }
  return `(assert (=> (Resolves ${smtId(rule.from)} ${smtId(rule.service)}) false))`;
}

function buildDiDeltaAssertion(fact: DiFact): string {
  if (fact.kind === 'inject') {
    return `(assert (Injects ${smtId(fact.from)} ${smtId(fact.to)}))`;
  }
  if (fact.kind === 'lifetime_dependency') {
    return `(assert (LifetimeDepends Lifetime__${fact.fromLifetime} Lifetime__${fact.toLifetime}))`;
  }
  return `(assert (Resolves ${smtId(fact.from)} ${smtId(fact.service)}))`;
}

export async function runGate(
  artifact: ArchitectureArtifact,
  delta: DeltaResult,
): Promise<GateVerdict> {
  const warnings = delta.warningFacts.map(f => ({
    from: f.from, to: f.to, evidence: f.evidence, file: f.file,
  }));

  const blockingDataFlowFacts = delta.blockingDataFlowFacts ?? [];
  const blockingDiFacts = delta.blockingDiFacts ?? [];

  if (delta.blockingFacts.length === 0 && blockingDataFlowFacts.length === 0 && blockingDiFacts.length === 0) {
    return { passed: true, violations: [], warnings };
  }

  // Combine permanent constraints with dynamic delta assertions (blocking only)
  const allStatements = [
    ...artifact.constraints,
    '',
    ...delta.smtAssertions,
  ];

  const result = await checkConstraints(allStatements);

  if (result.sat) {
    // SAT = no contradiction → no violation
    return { passed: true, violations: [], warnings };
  }

  // UNSAT = delta flow assertion contradicts a deny-flow constraint
  // Collect ALL matching violations (one per blocking fact × matching rule)
  const violations: GateViolation[] = [];

  for (const fact of delta.blockingFacts) {
    const deltaAssertion = delta.factSmtMap.get(`${fact.from}::${fact.to}`) ??
      `(assert (Flow ${smtId(fact.from)} ${smtId(fact.to)}))`;
    let matched = false;
    for (const invariant of artifact.invariants) {
      for (const rule of invariant.rules) {
        if (rule.kind !== 'DenyDataFlow' && rule.from === fact.from && rule.to === fact.to) {
          // RequireEncryption: not enforced by Z3 (no extractor emits Encrypted facts).
          // Move to warnings so agents see them but commits aren't blocked.
          if (rule.kind === 'RequireEncryption') {
            warnings.push({
              from: fact.from,
              to: fact.to,
              evidence: `[Advisory] RequireEncryption invariant '${invariant.name}' — encryption cannot be verified from static analysis`,
              file: fact.file,
            });
            matched = true;
            continue;
          }
          const permanentConstraint = buildPermanentConstraint(rule);
          violations.push({
            type: 'flow_violation',
            invariant: invariant.name,
            rule,
            detected: {
              from: fact.from,
              to: fact.to,
              confidence: fact.confidence,
              evidence: fact.evidence,
              file: fact.file,
            },
            ...(fact.graphEvidence ? { graph_evidence: fact.graphEvidence } : {}),
            message: `Component '${fact.from}' must NOT directly access '${fact.to}' (invariant: ${invariant.name})`,
            z3_proof: {
              permanent_constraint: permanentConstraint,
              delta_assertion: deltaAssertion,
              explanation:
                `Z3 returned UNSAT because '${permanentConstraint}' (from invariant '${invariant.name}') ` +
                `contradicts '${deltaAssertion}' (derived from code in ${fact.file}). ` +
                `Both cannot be true simultaneously — this is the formal proof of violation.`,
            },
          });
          matched = true;
        }
      }
    }
    // Generic violation only when no dataflow rule could explain UNSAT.
    if (!matched && blockingDataFlowFacts.length === 0 && blockingDiFacts.length === 0) {
      violations.push({
        type: 'flow_violation',
        invariant: 'unknown',
        rule: { kind: 'DenyFlow', from: fact.from, to: fact.to },
        detected: {
          from: fact.from,
          to: fact.to,
          confidence: fact.confidence,
          evidence: fact.evidence,
          file: fact.file,
        },
        ...(fact.graphEvidence ? { graph_evidence: fact.graphEvidence } : {}),
        message: `Component '${fact.from}' flow to '${fact.to}' violates architectural constraints`,
        z3_proof: {
          permanent_constraint: `(assert (=> (Flow ${smtId(fact.from)} ${smtId(fact.to)}) false))`,
          delta_assertion: deltaAssertion,
          explanation:
            `Z3 returned UNSAT: a deny-flow constraint for '${fact.from}→${fact.to}' contradicts ` +
            `the detected flow in ${fact.file}.`,
        },
      });
    }
  }

  for (const fact of blockingDataFlowFacts) {
    const deltaAssertion = `(assert (DataFlow ${smtId(fact.data)} ${smtId(fact.to)}))`;
    let matched = false;
    for (const invariant of artifact.invariants) {
      for (const rule of invariant.rules) {
        if (rule.kind === 'DenyDataFlow' && rule.data === fact.data && rule.to === fact.to) {
          const permanentConstraint = buildDataPermanentConstraint(rule);
          violations.push({
            type: 'dataflow_violation',
            invariant: invariant.name,
            rule,
            detected: {
              from: fact.via,
              to: fact.to,
              data: fact.data,
              via: fact.via,
              confidence: fact.confidence,
              evidence: fact.evidence,
              file: fact.file,
            },
            message: `Data '${fact.data}' must NOT flow to '${fact.to}' (invariant: ${invariant.name})`,
            z3_proof: {
              permanent_constraint: permanentConstraint,
              delta_assertion: deltaAssertion,
              explanation:
                `Z3 returned UNSAT because '${permanentConstraint}' (from invariant '${invariant.name}') ` +
                `contradicts '${deltaAssertion}' (derived from code/config in ${fact.file}).`,
            },
          });
          matched = true;
        }
      }
    }
    if (!matched) {
      violations.push({
        type: 'dataflow_violation',
        invariant: 'unknown',
        rule: { kind: 'DenyDataFlow', data: fact.data, to: fact.to },
        detected: {
          from: fact.via,
          to: fact.to,
          data: fact.data,
          via: fact.via,
          confidence: fact.confidence,
          evidence: fact.evidence,
          file: fact.file,
        },
        message: `Data '${fact.data}' flow to '${fact.to}' violates architectural constraints`,
        z3_proof: {
          permanent_constraint: `(assert (=> (DataFlow ${smtId(fact.data)} ${smtId(fact.to)}) false))`,
          delta_assertion: deltaAssertion,
          explanation: `Z3 returned UNSAT: a deny-dataflow constraint for '${fact.data}→${fact.to}' contradicts the detected dataflow in ${fact.file}.`,
        },
      });
    }
  }

  for (const fact of blockingDiFacts) {
    let matched = false;
    for (const policy of artifact.diPolicies ?? []) {
      for (const rule of policy.rules) {
        const matches =
          (fact.kind === 'inject' && rule.kind === 'DenyInject' && fact.from === rule.from && fact.to === rule.to) ||
          (fact.kind === 'lifetime_dependency' && rule.kind === 'DenyLifetime' && fact.fromLifetime === rule.from && fact.toLifetime === rule.to) ||
          (fact.kind === 'resolve' && rule.kind === 'DenyResolve' && fact.from === rule.from && fact.service === rule.service);
        if (!matches) continue;

        const permanentConstraint = buildDiPermanentConstraint(rule);
        const deltaAssertion = fact.kind === 'resolve'
          ? delta.diFactSmtMap.get(`${fact.kind}:${fact.from}::${fact.service}`) ?? buildDiDeltaAssertion(fact)
          : fact.kind === 'inject'
            ? delta.diFactSmtMap.get(`${fact.kind}:${fact.from}::${fact.to}`) ?? buildDiDeltaAssertion(fact)
            : delta.diFactSmtMap.get(`${fact.kind}:${fact.fromLifetime}::${fact.toLifetime}:${fact.from}::${fact.to}`) ?? buildDiDeltaAssertion(fact);
        const target = fact.kind === 'resolve' ? fact.service : fact.to;
        violations.push({
          type: 'di_violation',
          invariant: policy.name,
          rule,
          detected: {
            from: fact.from,
            to: target,
            confidence: fact.confidence,
            evidence: fact.evidence,
            file: fact.file,
          },
          message: fact.kind === 'lifetime_dependency'
            ? `DI lifetime '${fact.fromLifetime}' must NOT depend on '${fact.toLifetime}' (policy: ${policy.name})`
            : fact.kind === 'resolve'
              ? `Component '${fact.from}' must NOT resolve '${fact.service}' via service locator (policy: ${policy.name})`
              : `Component '${fact.from}' must NOT inject '${fact.to}' (policy: ${policy.name})`,
          z3_proof: {
            permanent_constraint: permanentConstraint,
            delta_assertion: deltaAssertion,
            explanation:
              `Z3 returned UNSAT because '${permanentConstraint}' (from di_policy '${policy.name}') ` +
              `contradicts '${deltaAssertion}' (derived from C# DI evidence in ${fact.file}).`,
          },
        });
        matched = true;
      }
    }

    if (!matched) {
      violations.push({
        type: 'di_violation',
        invariant: 'unknown',
        rule: fact.kind === 'lifetime_dependency'
          ? { kind: 'DenyLifetime', from: fact.fromLifetime, to: fact.toLifetime }
          : fact.kind === 'resolve'
            ? { kind: 'DenyResolve', service: fact.service, from: fact.from }
            : { kind: 'DenyInject', from: fact.from, to: fact.to },
        detected: {
          from: fact.from,
          to: fact.kind === 'resolve' ? fact.service : fact.to,
          confidence: fact.confidence,
          evidence: fact.evidence,
          file: fact.file,
        },
        message: `Dependency injection fact violates architectural constraints`,
        z3_proof: {
          permanent_constraint: '(di_policy constraint)',
          delta_assertion: buildDiDeltaAssertion(fact),
          explanation: `Z3 returned UNSAT for a dependency injection policy fact derived from ${fact.file}.`,
        },
      });
    }
  }

  return {
    passed: false,
    violations,
    warnings,
    model: result.model,
  };
}
