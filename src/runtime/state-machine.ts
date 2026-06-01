import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { TransitionFact } from './extraction-query.ts';
import { isBlocking } from '../analyzers/plugin.ts';

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function stateSmtId(artifact: ArchitectureArtifact, data: string, fieldName: string, value: string): string {
  const dataDecl = (artifact.dataTypes ?? []).find(d => d.name === data);
  const field = dataDecl?.fields.find(f => f.key === fieldName);
  const enumName = field?.typeExpr.replace(/^Optional<(.+)>$/, '$1').trim();
  return enumName ? `State__${smtId(enumName)}__${smtId(value)}` : `State__${smtId(data)}__${smtId(fieldName)}__${smtId(value)}`;
}

export function transitionRuleMatches(rule: { from: string; to: string }, fact: { from?: string; to: string }): boolean {
  return (rule.from === '*' || rule.from === fact.from) && (rule.to === '*' || rule.to === fact.to);
}

export function findMachineForTransition(
  artifact: ArchitectureArtifact,
  fact: { data: string; field: string },
): ArchitectureArtifact['stateMachines'][number] | undefined {
  return (artifact.stateMachines ?? []).find(sm => sm.onType === fact.data && sm.onField === fact.field);
}

export function transitionAllowed(
  machine: ArchitectureArtifact['stateMachines'][number],
  fact: { from?: string; to: string },
): boolean {
  if (fact.from) {
    if (machine.transitions.some(t => t.kind === 'deny' && transitionRuleMatches(t, fact))) {
      return false;
    }
  } else if (machine.transitions.some(t => t.kind === 'deny' && t.from === '*' && (t.to === '*' || t.to === fact.to))) {
    return false;
  }
  const allowRules = machine.transitions.filter(t => t.kind === 'allow');
  if (allowRules.length === 0) return true;
  if (!fact.from) {
    return allowRules.some(t => transitionRuleMatches(t, { from: '*', to: fact.to }));
  }
  return allowRules.some(t => transitionRuleMatches(t, fact));
}

function enumValuesForField(artifact: ArchitectureArtifact, data: string, field: string): string[] {
  const dataDecl = (artifact.dataTypes ?? []).find(d => d.name === data);
  const fieldDecl = dataDecl?.fields.find(f => f.key === field);
  const enumName = fieldDecl?.typeExpr.replace(/^Optional<(.+)>$/, '$1').trim();
  if (!enumName) return [];
  return (artifact.enums ?? []).find(e => e.name === enumName)?.values ?? [];
}

export function shouldBlockTransitionFact(
  fact: TransitionFact,
  artifact: ArchitectureArtifact,
  strict: boolean,
): boolean {
  if (!isBlocking({
    from: fact.data,
    to: fact.to,
    confidence: fact.confidence,
    evidence: fact.evidence,
    file: fact.file,
  }, strict)) {
    return false;
  }
  const machine = findMachineForTransition(artifact, fact);
  if (!machine) return Boolean(fact.from);
  return !transitionAllowed(machine, fact);
}

export function buildTransitionDeltaAssertion(
  artifact: ArchitectureArtifact,
  fact: { data: string; field: string; from?: string; to: string },
): string {
  if (!fact.from) {
    throw new Error('buildTransitionDeltaAssertion requires a resolved from state; use buildTransitionDeltaAssertions');
  }
  return `(assert (Transition ${smtId(fact.data)} Field__${smtId(fact.data)}__${smtId(fact.field)} ${stateSmtId(artifact, fact.data, fact.field, fact.from)} ${stateSmtId(artifact, fact.data, fact.field, fact.to)}))`;
}

/** Emit one delta assertion per illegal source state when the extracted transition has no guard. */
export function buildTransitionDeltaAssertions(
  artifact: ArchitectureArtifact,
  fact: { data: string; field: string; from?: string; to: string },
): string[] {
  if (fact.from) {
    return [buildTransitionDeltaAssertion(artifact, fact)];
  }
  const machine = findMachineForTransition(artifact, fact);
  if (!machine) return [];
  const illegalFroms = enumValuesForField(artifact, fact.data, fact.field).filter(
    from => !transitionAllowed(machine, { from, to: fact.to }),
  );
  return illegalFroms.map(from => buildTransitionDeltaAssertion(artifact, { ...fact, from }));
}
