// Z3 Gate — loads architecture.o + delta assertions → SAT/UNSAT verdict
import { checkConstraintsDetailed } from '../smt/solver.ts';
import { createHash } from 'crypto';
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
  id?: string;
  type: 'flow_violation' | 'reach_violation' | 'dataflow_violation' | 'data_policy_violation' | 'trust_policy_violation' | 'di_violation' | 'permission_violation' | 'state_machine_violation';
  invariant: string;
  rule: ArtifactInvariantRule | ArtifactDiPolicyRule | { kind: 'Transition'; from: string; to: string; data: string; field: string };
  detected: {
    from: string;
    to: string;
    data?: string;
    via?: string;
    path?: string[];
    confidence: string;
    evidence: string;
    file: string;
    query?: {
      id: string;
      version: number;
      file: string;
      graphFactId: string;
    };
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
  solver_diagnostics?: SolverSliceDiagnostic[];
  model?: string;
}

export interface SolverSliceDiagnostic {
  id: string;
  status: 'sat' | 'unsat' | 'unknown' | 'error';
  elapsed_ms: number;
  rule: string;
  declaration: string;
  source_file?: string;
  line?: number;
  components: string[];
  data?: string;
  fact_count: number;
  path_depth?: number;
  fanout?: number;
  reason?: string;
  suggested_refactor?: string;
}

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function stableId(parts: Array<string | number | undefined>): string {
  const body = parts.map(p => p ?? '').join('|');
  return `viol_${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
}

function violationId(input: {
  type: string;
  ruleName: string;
  ruleKind: string;
  from?: string;
  to?: string;
  data?: string;
  file?: string;
  line?: number;
}): string {
  return stableId([
    input.type,
    input.ruleName,
    input.ruleKind,
    input.from,
    input.to,
    input.data,
    input.file,
    input.line,
  ]);
}

function withStableViolationIds(violations: GateViolation[]): GateViolation[] {
  return violations.map(v => ({
    ...v,
    id: v.id ?? violationId({
      type: v.type,
      ruleName: v.invariant,
      ruleKind: (v.rule as { kind?: string }).kind ?? 'unknown',
      from: v.detected.from,
      to: v.detected.to,
      data: v.detected.data,
      file: v.detected.file,
      line: v.graph_evidence?.line,
    }),
  }));
}

interface SolverSlice {
  id: string;
  rule: string;
  declaration: string;
  permanent: string;
  delta: string;
  source_file?: string;
  line?: number;
  components: string[];
  data?: string;
  fact_count: number;
  path_depth?: number;
  fanout?: number;
}

function constraintPrelude(artifact: ArchitectureArtifact): string[] {
  return artifact.constraints.filter(statement => {
    const trimmed = statement.trim();
    return trimmed.length === 0 ||
      trimmed.startsWith(';') ||
      trimmed.startsWith('(declare-') ||
      trimmed.startsWith('(define-') ||
      trimmed.startsWith('(set-') ||
      trimmed.startsWith('(assert (ClassifiedAs ') ||
      trimmed.startsWith('(assert (JurisdictionOf ');
  });
}

function sliceId(slice: Omit<SolverSlice, 'id'>): string {
  return stableId([slice.declaration, slice.rule, ...slice.components, slice.data, slice.source_file, slice.line]);
}

function refactorSuggestion(slice: SolverSlice): string {
  if (slice.declaration === 'machine') {
    return 'Reduce ambiguous state writes by routing this state field through a small transition helper or command handler.';
  }
  if (slice.declaration === 'di_policy') {
    return 'Split broad composition-root registrations or move this service registration behind a narrower component boundary.';
  }
  if ((slice.path_depth ?? 0) > 2) {
    return 'Break the long dependency path with an interface owned by the upstream component or move the downstream call into an allowed adapter.';
  }
  if ((slice.fanout ?? 0) > 10) {
    return 'Reduce fanout from this component by isolating external calls or state writes into smaller dedicated services.';
  }
  return 'Narrow this rule slice by moving the dependency or fact-producing code behind an explicit allowed component boundary.';
}

function buildSolverSlices(
  artifact: ArchitectureArtifact,
  delta: DeltaResult,
  runtime: {
    blockingReachFacts: ReachFact[];
    blockingDataFlowFacts: DeltaResult['blockingDataFlowFacts'];
    blockingDiFacts: RuntimeDiFact[];
    blockingTransitionFacts: DeltaResult['blockingTransitionFacts'];
  },
): SolverSlice[] {
  const slices: SolverSlice[] = [];
  const fanoutByComponent = new Map<string, number>();
  for (const fact of delta.facts) {
    fanoutByComponent.set(fact.from, (fanoutByComponent.get(fact.from) ?? 0) + 1);
  }

  const push = (slice: Omit<SolverSlice, 'id'>) => {
    slices.push({ ...slice, id: sliceId(slice) });
  };

  for (const fact of delta.blockingFacts) {
    const deltaAssertion = delta.factSmtMap.get(`${fact.from}::${fact.to}`) ?? `(assert (Flow ${smtId(fact.from)} ${smtId(fact.to)}))`;
    for (const invariant of artifact.invariants) {
      for (const rule of invariant.rules) {
        if (rule.kind === 'DenyFlow' && rule.from === fact.from && rule.to === fact.to) {
          push({
            rule: invariant.name,
            declaration: 'invariant deny flow',
            permanent: buildPermanentConstraint(rule),
            delta: deltaAssertion,
            source_file: fact.file,
            line: fact.line ?? fact.graphEvidence?.line,
            components: [fact.from, fact.to],
            fact_count: 1,
            fanout: fanoutByComponent.get(fact.from),
          });
        }
      }
    }
  }

  for (const fact of runtime.blockingReachFacts) {
    for (const invariant of artifact.invariants) {
      for (const rule of invariant.rules) {
        if (rule.kind === 'DenyReach' && rule.from === fact.from && rule.to === fact.to) {
          push({
            rule: invariant.name,
            declaration: 'invariant deny reach',
            permanent: buildPermanentConstraint(rule),
            delta: `(assert (CanReach ${smtId(fact.from)} ${smtId(fact.to)}))`,
            source_file: fact.file,
            line: fact.line ?? fact.graphEvidence?.line,
            components: fact.path,
            fact_count: Math.max(1, fact.path.length - 1),
            path_depth: fact.path.length,
            fanout: fanoutByComponent.get(fact.from),
          });
        }
      }
    }
  }

  for (const fact of runtime.blockingDataFlowFacts) {
    for (const invariant of artifact.invariants) {
      for (const rule of invariant.rules) {
        if (rule.kind === 'DenyDataFlow' && rule.data === fact.data && rule.to === fact.to) {
          push({
            rule: invariant.name,
            declaration: 'invariant deny dataflow',
            permanent: buildDataPermanentConstraint(rule),
            delta: `(assert (DataCanReach ${smtId(fact.data)} ${smtId(fact.to)}))`,
            source_file: fact.file,
            components: [fact.via, fact.to],
            data: fact.data,
            fact_count: fact.path?.length ?? 1,
            path_depth: fact.path?.length,
            fanout: fanoutByComponent.get(fact.via),
          });
        }
      }
    }
  }

  for (const fact of runtime.blockingDiFacts) {
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
        push({
          rule: policy.name,
          declaration: 'di_policy',
          permanent: buildDiPermanentConstraint(rule),
          delta: buildDiDeltaAssertion(fact),
          source_file: fact.file,
          components: [fact.from, fact.kind === 'resolve' ? fact.service : fact.to],
          fact_count: (fact as RuntimeDiFact).path?.length ?? 1,
          path_depth: (fact as RuntimeDiFact).path?.length,
        });
      }
    }
  }

  for (const fact of runtime.blockingTransitionFacts) {
    const machine = (artifact.stateMachines ?? []).find(sm => sm.onType === fact.data && sm.onField === fact.field);
    if (!machine || transitionAllowed(machine, fact)) continue;
    const denied = machine.transitions.find(t => t.kind === 'deny' && transitionRuleMatches(t, fact));
    push({
      rule: machine.name,
      declaration: 'machine',
      permanent: denied
        ? `(assert (=> (Transition ${smtId(fact.data)} Field__${smtId(fact.data)}__${smtId(fact.field)} ${stateSmtId(artifact, fact.data, fact.field, fact.from ?? denied.from)} ${stateSmtId(artifact, fact.data, fact.field, fact.to)}) false))`
        : `; machine ${machine.name} permits only declared allow transitions`,
      delta: buildTransitionDeltaAssertionForArtifact(artifact, fact),
      source_file: fact.file,
      line: fact.line,
      components: [fact.data],
      data: `${fact.data}.${fact.field}`,
      fact_count: 1,
    });
  }

  return slices;
}

async function runSolverSlices(artifact: ArchitectureArtifact, slices: SolverSlice[]): Promise<SolverSliceDiagnostic[]> {
  const prelude = constraintPrelude(artifact);
  const diagnostics: SolverSliceDiagnostic[] = [];
  for (const slice of slices) {
    const result = await checkConstraintsDetailed([...prelude, slice.permanent, slice.delta], { timeoutMs: 750 });
    if (result.status === 'error') {
      diagnostics.push({
        ...slice,
        status: result.status,
        elapsed_ms: result.elapsed_ms,
        reason: result.reason,
        suggested_refactor: refactorSuggestion(slice),
      });
      continue;
    }
    diagnostics.push({
      ...slice,
      status: result.status,
      elapsed_ms: result.elapsed_ms,
      reason: result.reason,
      suggested_refactor: result.status === 'unknown' || result.elapsed_ms > 250 ? refactorSuggestion(slice) : undefined,
    });
  }
  return diagnostics;
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

function buildTransitionDeltaAssertion(fact: { data: string; field: string; from?: string; to: string }): string {
  return `(assert (Transition ${smtId(fact.data)} Field__${smtId(fact.data)}__${smtId(fact.field)} State__${smtId(fact.from ?? '*')} State__${smtId(fact.to)}))`;
}

function stateSmtId(artifact: ArchitectureArtifact, data: string, fieldName: string, value: string): string {
  const dataDecl = (artifact.dataTypes ?? []).find(d => d.name === data);
  const field = dataDecl?.fields.find(f => f.key === fieldName);
  const enumName = field?.typeExpr.replace(/^Optional<(.+)>$/, '$1').trim();
  return enumName ? `State__${smtId(enumName)}__${smtId(value)}` : `State__${smtId(data)}__${smtId(fieldName)}__${smtId(value)}`;
}

function buildTransitionDeltaAssertionForArtifact(
  artifact: ArchitectureArtifact,
  fact: { data: string; field: string; from?: string; to: string },
): string {
  if (!fact.from) return buildTransitionDeltaAssertion(fact);
  return `(assert (Transition ${smtId(fact.data)} Field__${smtId(fact.data)}__${smtId(fact.field)} ${stateSmtId(artifact, fact.data, fact.field, fact.from)} ${stateSmtId(artifact, fact.data, fact.field, fact.to)}))`;
}

function transitionRuleMatches(rule: { from: string; to: string }, fact: { from?: string; to: string }): boolean {
  return (rule.from === '*' || rule.from === fact.from) && (rule.to === '*' || rule.to === fact.to);
}

function transitionAllowed(machine: ArchitectureArtifact['stateMachines'][number], fact: { from?: string; to: string }): boolean {
  if (!fact.from) return true;
  if (machine.transitions.some(t => t.kind === 'deny' && transitionRuleMatches(t, fact))) return false;
  const allowRules = machine.transitions.filter(t => t.kind === 'allow');
  return allowRules.length === 0 || allowRules.some(t => transitionRuleMatches(t, fact));
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
  const warnings = [
    ...delta.warningFacts.map(f => ({
    from: f.from, to: f.to, evidence: f.evidence, file: f.file,
    })),
    ...(delta.transitionWarningFacts ?? []).map(f => ({
      from: `${f.data}.${f.field}`,
      to: f.to,
      evidence: f.evidence,
      file: f.file,
    })),
  ];

  const blockingDataFlowFacts = delta.blockingDataFlowFacts ?? [];
  const blockingReachFacts = delta.blockingReachFacts ?? [];
  const blockingTrustPolicyFacts = delta.blockingTrustPolicyFacts ?? [];
  const blockingDiFacts = delta.blockingDiFacts ?? [];
  const blockingPermissionFacts = delta.blockingPermissionFacts ?? [];
  const blockingTransitionFacts = delta.blockingTransitionFacts ?? [];
  const solverSlices = buildSolverSlices(artifact, delta, {
    blockingReachFacts,
    blockingDataFlowFacts,
    blockingDiFacts,
    blockingTransitionFacts,
  });
  const solverDiagnostics = await runSolverSlices(artifact, solverSlices);
  const solverHotspots = solverDiagnostics.filter(d => d.status === 'unknown' || d.status === 'error');

  if (delta.blockingFacts.length === 0 && blockingReachFacts.length === 0 && blockingDataFlowFacts.length === 0 && blockingTrustPolicyFacts.length === 0 && blockingDiFacts.length === 0 && blockingPermissionFacts.length === 0 && blockingTransitionFacts.length === 0) {
    return { passed: true, violations: [], warnings, ...(solverDiagnostics.length > 0 ? { solver_diagnostics: solverDiagnostics } : {}) };
  }

  if (solverHotspots.length > 0) {
    return {
      passed: false,
      violations: [],
      warnings,
      solver_diagnostics: solverDiagnostics,
      model: solverHotspots.map(d =>
        `${d.status.toUpperCase()} in ${d.declaration} '${d.rule}' from ${d.source_file ?? 'unknown source'}: ${d.reason ?? 'solver could not finish slice'}`,
      ).join('\n'),
    };
  }

  // Combine permanent constraints with dynamic delta assertions (blocking only)
  const allStatements = [
    ...artifact.constraints,
    '',
    ...delta.smtAssertions,
  ];

  const result = await checkConstraintsDetailed(allStatements);
  if (result.status === 'unknown' || result.status === 'error') {
    return {
      passed: false,
      violations: [],
      warnings,
      solver_diagnostics: [
        ...solverDiagnostics,
        {
          id: stableId(['full_solver', allStatements.length]),
          status: result.status,
          elapsed_ms: result.elapsed_ms,
          rule: 'full_check',
          declaration: 'solver',
          components: [],
          fact_count: delta.smtAssertions.length,
          reason: result.reason,
          suggested_refactor: 'Use rule-specific solver diagnostics to split the largest reported rule or component slice.',
        },
      ],
      model: result.reason,
    };
  }

  const hasRuntimePolicyBlocks =
    blockingTrustPolicyFacts.length > 0 ||
    blockingPermissionFacts.length > 0 ||
    blockingTransitionFacts.some(f => {
      const machine = (artifact.stateMachines ?? []).find(sm => sm.onType === f.data && sm.onField === f.field);
      return machine ? !transitionAllowed(machine, f) : false;
    }) ||
    blockingDataFlowFacts.some(f => (artifact.dataPolicies ?? []).some(policy => policy.rules.some(rule =>
      rule.kind === 'DenyClassification'
        ? dataClassification(f.data, artifact) === rule.classification
        : dataJurisdiction(f.data, artifact) === rule.jurisdiction && f.to === rule.to,
    )));

  if (result.sat && !hasRuntimePolicyBlocks) {
    // SAT = no contradiction → no violation
    return { passed: true, violations: [], warnings, ...(solverDiagnostics.length > 0 ? { solver_diagnostics: solverDiagnostics } : {}) };
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
    if (!matched && blockingReachFacts.length === 0 && blockingDataFlowFacts.length === 0 && blockingTrustPolicyFacts.length === 0 && blockingDiFacts.length === 0 && blockingTransitionFacts.length === 0) {
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

  for (const fact of blockingTransitionFacts) {
    const machine = (artifact.stateMachines ?? []).find(sm => sm.onType === fact.data && sm.onField === fact.field);
    if (!machine || transitionAllowed(machine, fact)) continue;
    const denied = machine.transitions.find(t => t.kind === 'deny' && transitionRuleMatches(t, fact));
    const permanentConstraint = denied
      ? `(assert (=> (Transition ${smtId(fact.data)} Field__${smtId(fact.data)}__${smtId(fact.field)} ${stateSmtId(artifact, fact.data, fact.field, fact.from ?? denied.from)} ${stateSmtId(artifact, fact.data, fact.field, fact.to)}) false))`
      : `machine ${machine.name} permits only declared allow transitions`;
    const deltaAssertion = buildTransitionDeltaAssertionForArtifact(artifact, fact);
    violations.push({
      type: 'state_machine_violation',
      invariant: machine.name,
      rule: {
        kind: 'Transition',
        from: fact.from ?? '*',
        to: fact.to,
        data: fact.data,
        field: fact.field,
      },
      detected: {
        from: fact.from ?? '*',
        to: fact.to,
        data: fact.data,
        confidence: fact.confidence,
        evidence: fact.evidence,
        file: fact.file,
        query: {
          id: fact.query.id,
          version: fact.query.version,
          file: fact.query.file,
          graphFactId: fact.graphFactId,
        },
      },
      message: `Transition '${fact.data}.${fact.field}' from '${fact.from ?? '*'}' to '${fact.to}' violates machine '${machine.name}'`,
      z3_proof: {
        permanent_constraint: permanentConstraint,
        delta_assertion: deltaAssertion,
        explanation: `Z3 returned UNSAT because the extracted transition fact from query '${fact.query.id}' contradicts state machine '${machine.name}'.`,
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
    violations: withStableViolationIds(violations),
    warnings,
    ...(solverDiagnostics.length > 0 ? { solver_diagnostics: solverDiagnostics } : {}),
    model: result.model,
  };
}
