// Z3 Gate — loads architecture.o + delta assertions → SAT/UNSAT verdict
import { checkConstraints } from '../smt/solver.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { ArtifactInvariantRule, ArtifactDiPolicyRule } from '../emitters/artifact.ts';
import type { DeltaResult } from './delta-assert.ts';
import type { DiFact } from '../analyzers/csharp.ts';
import type { RuntimeDiFact, ReachFact, TrustPolicyFact } from './delta-assert.ts';
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
  type: 'flow_violation' | 'reach_violation' | 'dataflow_violation' | 'data_policy_violation' | 'trust_policy_violation' | 'di_violation' | 'permission_violation';
  invariant: string;
  rule: ArtifactInvariantRule | ArtifactDiPolicyRule;
  detected: {
    from: string;
    to: string;
    data?: string;
    via?: string;
    path?: string[];
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
  } else if (rule.kind === 'DenyReach') {
    return `(assert (=> (CanReach ${from} ${to}) false))`;
  } else if (rule.kind === 'RequireEncryption') {
    return `(assert (=> (Flow ${from} ${to}) (Encrypted ${from} ${to})))`;
  }
  return `(assert (=> (Flow ${from} ${to}) false))`;
}

function buildDataPermanentConstraint(rule: { kind: 'DenyDataFlow'; data: string; to: string }): string {
  return `(assert (=> (DataCanReach ${smtId(rule.data)} ${smtId(rule.to)}) false))`;
}

function buildDiPermanentConstraint(rule: ArtifactDiPolicyRule): string {
  if (rule.kind === 'DenyInject') {
    return `(assert (=> (Injects ${smtId(rule.from)} ${smtId(rule.to)}) false))`;
  }
  if (rule.kind === 'DenyInjectReach') {
    return `(assert (=> (InjectReach ${smtId(rule.from)} ${smtId(rule.to)}) false))`;
  }
  if (rule.kind === 'DenyLifetime') {
    return `(assert (=> (LifetimeDepends Lifetime__${rule.from} Lifetime__${rule.to}) false))`;
  }
  if (rule.kind === 'DenyLifetimeReach') {
    return `(assert (=> (LifetimeReach Lifetime__${rule.from} Lifetime__${rule.to}) false))`;
  }
  return `(assert (=> (Resolves ${smtId(rule.from)} ${smtId(rule.service)}) false))`;
}

function buildDiDeltaAssertion(fact: DiFact): string {
  const runtimeFact = fact as RuntimeDiFact;
  if (runtimeFact.reachKind === 'inject_reach' && fact.kind === 'inject') {
    return `(assert (InjectReach ${smtId(fact.from)} ${smtId(fact.to)}))`;
  }
  if (runtimeFact.reachKind === 'lifetime_reach' && fact.kind === 'lifetime_dependency') {
    return `(assert (LifetimeReach Lifetime__${fact.fromLifetime} Lifetime__${fact.toLifetime}))`;
  }
  if (fact.kind === 'inject') {
    return `(assert (Injects ${smtId(fact.from)} ${smtId(fact.to)}))`;
  }
  if (fact.kind === 'lifetime_dependency') {
    return `(assert (LifetimeDepends Lifetime__${fact.fromLifetime} Lifetime__${fact.toLifetime}))`;
  }
  return `(assert (Resolves ${smtId(fact.from)} ${smtId(fact.service)}))`;
}

function dataClassification(data: string, artifact: ArchitectureArtifact): string | undefined {
  return (artifact.dataTypes ?? []).find(d => d.name === data)?.classification;
}

function dataJurisdiction(data: string, artifact: ArchitectureArtifact): string | undefined {
  return (artifact.dataTypes ?? []).find(d => d.name === data)?.jurisdiction;
}

export async function runGate(
  artifact: ArchitectureArtifact,
  delta: DeltaResult,
): Promise<GateVerdict> {
  const warnings = delta.warningFacts.map(f => ({
    from: f.from, to: f.to, evidence: f.evidence, file: f.file,
  }));

  const blockingDataFlowFacts = delta.blockingDataFlowFacts ?? [];
  const blockingReachFacts = delta.blockingReachFacts ?? [];
  const blockingTrustPolicyFacts = delta.blockingTrustPolicyFacts ?? [];
  const blockingDiFacts = delta.blockingDiFacts ?? [];
  const blockingPermissionFacts = delta.blockingPermissionFacts ?? [];

  if (delta.blockingFacts.length === 0 && blockingReachFacts.length === 0 && blockingDataFlowFacts.length === 0 && blockingTrustPolicyFacts.length === 0 && blockingDiFacts.length === 0 && blockingPermissionFacts.length === 0) {
    return { passed: true, violations: [], warnings };
  }

  // Combine permanent constraints with dynamic delta assertions (blocking only)
  const allStatements = [
    ...artifact.constraints,
    '',
    ...delta.smtAssertions,
  ];

  const result = await checkConstraints(allStatements);

  const hasRuntimePolicyBlocks =
    blockingTrustPolicyFacts.length > 0 ||
    blockingPermissionFacts.length > 0 ||
    blockingDataFlowFacts.some(f => (artifact.dataPolicies ?? []).some(policy => policy.rules.some(rule =>
      rule.kind === 'DenyClassification'
        ? dataClassification(f.data, artifact) === rule.classification
        : dataJurisdiction(f.data, artifact) === rule.jurisdiction && f.to === rule.to,
    )));

  if (result.sat && !hasRuntimePolicyBlocks) {
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
    if (!matched && blockingReachFacts.length === 0 && blockingDataFlowFacts.length === 0 && blockingTrustPolicyFacts.length === 0 && blockingDiFacts.length === 0) {
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

  for (const fact of blockingReachFacts) {
    const deltaAssertion = `(assert (CanReach ${smtId(fact.from)} ${smtId(fact.to)}))`;
    for (const invariant of artifact.invariants) {
      for (const rule of invariant.rules) {
        if (rule.kind === 'DenyReach' && rule.from === fact.from && rule.to === fact.to) {
          const permanentConstraint = buildPermanentConstraint(rule);
          violations.push({
            type: 'reach_violation',
            invariant: invariant.name,
            rule,
            detected: {
              from: fact.from,
              to: fact.to,
              path: fact.path,
              confidence: fact.confidence,
              evidence: fact.evidence,
              file: fact.file,
            },
            ...(fact.graphEvidence ? { graph_evidence: fact.graphEvidence } : {}),
            message: `Component '${fact.from}' must NOT reach '${fact.to}' via ${fact.path.join(' -> ')} (invariant: ${invariant.name})`,
            z3_proof: {
              permanent_constraint: permanentConstraint,
              delta_assertion: deltaAssertion,
              explanation:
                `Z3 returned UNSAT because '${permanentConstraint}' (from invariant '${invariant.name}') ` +
                `contradicts '${deltaAssertion}' (derived from transitive flow evidence in ${fact.file}).`,
            },
          });
        }
      }
    }
  }

  for (const fact of blockingDataFlowFacts) {
    const deltaAssertion = `(assert (DataCanReach ${smtId(fact.data)} ${smtId(fact.to)}))`;
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
              path: fact.path,
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
    for (const policy of artifact.dataPolicies ?? []) {
      for (const rule of policy.rules) {
        const matches = rule.kind === 'DenyClassification'
          ? dataClassification(fact.data, artifact) === rule.classification
          : dataJurisdiction(fact.data, artifact) === rule.jurisdiction && fact.to === rule.to;
        if (!matches) continue;
        const permanentConstraint = rule.kind === 'DenyClassification'
          ? `(assert (=> (and (ClassifiedAs ${smtId(fact.data)} Classification__${smtId(rule.classification)}) (DataCanReach ${smtId(fact.data)} ${smtId(fact.to)})) false))`
          : `(assert (=> (and (JurisdictionOf ${smtId(fact.data)} Jurisdiction__${smtId(rule.jurisdiction)}) (DataCanReach ${smtId(fact.data)} ${smtId(rule.to)})) false))`;
        violations.push({
          type: 'data_policy_violation',
          invariant: policy.name,
          rule: { kind: 'DenyDataFlow', data: fact.data, to: fact.to },
          detected: {
            from: fact.via,
            to: fact.to,
            data: fact.data,
            via: fact.via,
            path: fact.path,
            confidence: fact.confidence,
            evidence: fact.evidence,
            file: fact.file,
          },
          message: `Data '${fact.data}' violates data_policy '${policy.name}' while reaching '${fact.to}'`,
          z3_proof: {
            permanent_constraint: permanentConstraint,
            delta_assertion: deltaAssertion,
            explanation: `Z3 returned UNSAT for data policy '${policy.name}' using classified/jurisdictional data reachability evidence from ${fact.file}.`,
          },
        });
        matched = true;
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
          permanent_constraint: `(assert (=> (DataCanReach ${smtId(fact.data)} ${smtId(fact.to)}) false))`,
          delta_assertion: deltaAssertion,
          explanation: `Z3 returned UNSAT: a deny-dataflow constraint for '${fact.data}→${fact.to}' contradicts the detected dataflow in ${fact.file}.`,
        },
      });
    }
  }

  for (const fact of blockingTrustPolicyFacts) {
    const permanentConstraint = fact.rule.kind === 'RequireAuth'
      ? `require auth ${fact.rule.fromTrust} -> ${fact.rule.toTrust}`
      : `deny flow ${fact.rule.fromTrust} -> ${fact.rule.toTrust} when data ${fact.rule.classification}`;
    const deltaAssertion = fact.data
      ? `(assert (DataCanReach ${smtId(fact.data)} ${smtId(fact.to)}))`
      : `(assert (CanReach ${smtId(fact.from)} ${smtId(fact.to)}))`;
    violations.push({
      type: 'trust_policy_violation',
      invariant: fact.policy,
      rule: fact.data
        ? { kind: 'DenyDataFlow', data: fact.data, to: fact.to }
        : { kind: 'DenyReach', from: fact.from, to: fact.to },
      detected: {
        from: fact.from,
        to: fact.to,
        data: fact.data,
        path: fact.path,
        confidence: fact.confidence,
        evidence: fact.evidence,
        file: fact.file,
      },
      message: fact.rule.kind === 'RequireAuth'
        ? `Trust boundary '${fact.from}' -> '${fact.to}' requires declared auth (policy: ${fact.policy})`
        : `Classified data must NOT flow from ${fact.rule.fromTrust} to ${fact.rule.toTrust} trust boundary (policy: ${fact.policy})`,
      z3_proof: {
        permanent_constraint: permanentConstraint,
        delta_assertion: deltaAssertion,
        explanation: `The runtime trust gate found extracted reachability/data evidence that violates trust_policy '${fact.policy}'.`,
      },
    });
  }

  for (const fact of blockingPermissionFacts) {
    const deltaAssertion = `(assert (Performs ${smtId(fact.component)} Operation__${smtId(fact.operation)} ${smtId(fact.data)}))`;
    violations.push({
      type: 'permission_violation',
      invariant: fact.permission,
      rule: { kind: 'DenyDataFlow', data: fact.data, to: fact.component },
      detected: {
        from: fact.component,
        to: fact.component,
        data: fact.data,
        confidence: fact.confidence,
        evidence: fact.evidence,
        file: fact.file,
      },
      message: `Component '${fact.component}' performs '${fact.operation}' on '${fact.data}' without matching authorization evidence (permission: ${fact.permission})`,
      z3_proof: {
        permanent_constraint: `permission ${fact.permission} requires a matching ChecksRole fact for protected operation '${fact.operation}'`,
        delta_assertion: deltaAssertion,
        explanation: `The C# authorization extractor found a protected operation in ${fact.file} without a matching role check or role attribute.`,
      },
    });
  }

  for (const fact of blockingDiFacts) {
    let matched = false;
    for (const policy of artifact.diPolicies ?? []) {
      for (const rule of policy.rules) {
        const runtimeFact = fact as RuntimeDiFact;
        const matches =
          (fact.kind === 'inject' && rule.kind === 'DenyInject' && !runtimeFact.reachKind && fact.from === rule.from && fact.to === rule.to) ||
          (fact.kind === 'inject' && rule.kind === 'DenyInjectReach' && runtimeFact.reachKind === 'inject_reach' && fact.from === rule.from && fact.to === rule.to) ||
          (fact.kind === 'lifetime_dependency' && rule.kind === 'DenyLifetime' && !runtimeFact.reachKind && fact.fromLifetime === rule.from && fact.toLifetime === rule.to) ||
          (fact.kind === 'lifetime_dependency' && rule.kind === 'DenyLifetimeReach' && runtimeFact.reachKind === 'lifetime_reach' && fact.fromLifetime === rule.from && fact.toLifetime === rule.to) ||
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
            path: (fact as RuntimeDiFact).path,
            confidence: fact.confidence,
            evidence: fact.evidence,
            file: fact.file,
          },
          message: fact.kind === 'lifetime_dependency'
            ? `DI lifetime '${fact.fromLifetime}' must NOT ${((fact as RuntimeDiFact).reachKind ? 'reach' : 'depend on')} '${fact.toLifetime}' (policy: ${policy.name})`
            : fact.kind === 'resolve'
              ? `Component '${fact.from}' must NOT resolve '${fact.service}' via service locator (policy: ${policy.name})`
              : `Component '${fact.from}' must NOT ${((fact as RuntimeDiFact).reachKind ? 'reach' : 'inject')} '${fact.to}' through DI (policy: ${policy.name})`,
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
