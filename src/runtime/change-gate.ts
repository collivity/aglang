import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { ChangedComponent } from './diff-parser.ts';
import { checkConstraints } from '../smt/solver.ts';
import { createHash } from 'crypto';

export interface ChangeViolation {
  id: string;
  type: 'change_violation';
  policy: string;
  trigger: string;
  required: string;
  message: string;
  trigger_files: string[];
  required_glob: string;
  z3_proof: {
    policy_constraint: string;
    trigger_assertion: string;
    missing_assertion: string;
    explanation: string;
  };
}

export interface ChangeGateResult {
  violations: ChangeViolation[];
  smt: string[];
}

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function touchedSymbol(component: string): string {
  return `Touched_${smtId(component)}`;
}

function changeViolationId(policy: string, trigger: string, required: string, files: string[]): string {
  const body = ['change_violation', policy, trigger, required, ...files].join('|');
  return `viol_${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
}

export async function runChangeGate(
  artifact: ArchitectureArtifact,
  changed: ChangedComponent[],
): Promise<ChangeGateResult> {
  const policies = artifact.changePolicies ?? [];
  if (policies.length === 0 || changed.length === 0) {
    return { violations: [], smt: [] };
  }

  const touched = new Map(changed.map(c => [c.componentName, c.files]));
  const referenced = new Set<string>();
  for (const policy of policies) {
    for (const rule of policy.rules) {
      referenced.add(rule.trigger);
      referenced.add(rule.required);
    }
  }

  const smt: string[] = ['; === aglang change policy SMT ==='];
  for (const component of referenced) {
    smt.push(`(declare-const ${touchedSymbol(component)} Bool)`);
  }
  for (const policy of policies) {
    for (const rule of policy.rules) {
      smt.push(`; ${policy.name}: require touched ${rule.required} when touched ${rule.trigger}`);
      smt.push(`(assert (=> ${touchedSymbol(rule.trigger)} ${touchedSymbol(rule.required)}))`);
    }
  }
  for (const component of referenced) {
    smt.push(`(assert ${touched.has(component) ? touchedSymbol(component) : `(not ${touchedSymbol(component)})`})`);
  }

  const solverResult = await checkConstraints(smt);
  if (solverResult.sat) {
    return { violations: [], smt };
  }

  const violations: ChangeViolation[] = [];
  for (const policy of policies) {
    for (const rule of policy.rules) {
      const triggerFiles = touched.get(rule.trigger);
      if (triggerFiles && !touched.has(rule.required)) {
        const policyConstraint = `(assert (=> ${touchedSymbol(rule.trigger)} ${touchedSymbol(rule.required)}))`;
        const triggerAssertion = `(assert ${touchedSymbol(rule.trigger)})`;
        const missingAssertion = `(assert (not ${touchedSymbol(rule.required)}))`;
        violations.push({
          id: changeViolationId(policy.name, rule.trigger, rule.required, triggerFiles),
          type: 'change_violation',
          policy: policy.name,
          trigger: rule.trigger,
          required: rule.required,
          message: `${policy.name} requires ${rule.required} when ${rule.trigger} changes`,
          trigger_files: triggerFiles,
          required_glob: artifact.mappings[rule.required] ?? '',
          z3_proof: {
            policy_constraint: policyConstraint,
            trigger_assertion: triggerAssertion,
            missing_assertion: missingAssertion,
            explanation:
              `Z3 returned UNSAT because '${policyConstraint}' requires '${rule.required}' to be touched ` +
              `when '${rule.trigger}' is touched, but the checked change includes '${triggerAssertion}' ` +
              `and '${missingAssertion}'.`,
          },
        });
      }
    }
  }

  return { violations, smt };
}
