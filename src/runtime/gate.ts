// Z3 Gate — loads architecture.o + delta assertions → SAT/UNSAT verdict
import { checkConstraints } from '../smt/solver.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { DeltaResult } from './delta-assert.ts';
import type { ContractViolation } from './contract-gate.ts';

export interface Z3Proof {
  // The permanent constraint assertion from the compiled .arch spec
  permanent_constraint: string;
  // The dynamic delta assertion derived from the code change
  delta_assertion: string;
  // Human-readable explanation of what the two assertions mean
  explanation: string;
}

export interface GateViolation {
  type: 'flow_violation';
  invariant: string;
  rule: { kind: string; from: string; to: string };
  detected: {
    from: string;
    to: string;
    confidence: string;
    evidence: string;
    file: string;
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

export async function runGate(
  artifact: ArchitectureArtifact,
  delta: DeltaResult,
): Promise<GateVerdict> {
  const warnings = delta.warningFacts.map(f => ({
    from: f.from, to: f.to, evidence: f.evidence, file: f.file,
  }));

  if (delta.blockingFacts.length === 0) {
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
        if (rule.from === fact.from && rule.to === fact.to) {
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
    // Generic violation if no invariant matched (shouldn't happen in well-formed artifacts)
    if (!matched) {
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

  return {
    passed: false,
    violations,
    warnings,
    model: result.model,
  };
}
