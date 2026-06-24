import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { TransitionFact, ValueFact } from './extraction-query.ts';
import { isBlocking } from '../analyzers/plugin.ts';
import { factSatisfies, conditionObservedAssertion } from '../smt/smt-ids.ts';

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

// A guarded deny rule only counts as matching when some ValueFact in the same check-run batch
// satisfies its guard (reusing value_policy.when's exact subject+path correlation pattern via
// factSatisfies) -- without guardFacts (or with no satisfying fact), a guarded rule is treated as
// not matching, i.e. fail-closed. This deliberately does not disambiguate multiple instances of
// the same data type in one batch; see docs/extractors.md for the documented limitation.
export function guardSatisfied(rule: { guard?: { subject: string; path: string[]; relation: string; value: unknown } }, guardFacts: ValueFact[] | undefined): boolean {
  if (!rule.guard) return true;
  if (!guardFacts) return false;
  return guardFacts.some(f => factSatisfies(f, rule.guard!));
}

export function transitionAllowed(
  machine: ArchitectureArtifact['stateMachines'][number],
  fact: { from?: string; to: string },
  guardFacts?: ValueFact[],
): boolean {
  if (fact.from) {
    if (machine.transitions.some(t => t.kind === 'deny' && transitionRuleMatches(t, fact) && guardSatisfied(t, guardFacts))) {
      return false;
    }
  } else if (machine.transitions.some(t => t.kind === 'deny' && t.from === '*' && (t.to === '*' || t.to === fact.to) && guardSatisfied(t, guardFacts))) {
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
  guardFacts?: ValueFact[],
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
  return !transitionAllowed(machine, fact, guardFacts);
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

/** Emit one delta assertion per illegal source state when the extracted transition's previous
 * value couldn't be resolved (unrelated to machine `when` guards — "guard" here means the fact's
 * own from-state is unknown, the pre-existing sense of the word in this function). */
/** For each guarded deny rule matching this transition with a satisfying correlated ValueFact,
 * pin that fact's observed value to the guard's FieldValueInt/Real (or ValueFact atom) term —
 * without this, the permanent constraint's guard term stays unconstrained and the conjunction
 * can never go UNSAT, by design (fail-closed: no evidence, no block). */
// Always called with a resolved `from` (both call sites in buildTransitionDeltaAssertions below
// resolve it before calling), so a plain transitionRuleMatches check is sufficient.
function buildGuardConditionAssertions(
  artifact: ArchitectureArtifact,
  fact: { data: string; field: string; from: string; to: string },
  guardFacts: ValueFact[] | undefined,
): string[] {
  if (!guardFacts) return [];
  const machine = findMachineForTransition(artifact, fact);
  if (!machine) return [];
  const out: string[] = [];
  for (const rule of machine.transitions) {
    if (rule.kind !== 'deny' || !rule.guard) continue;
    if (!transitionRuleMatches(rule, fact)) continue;
    const conditionFact = guardFacts.find(f => factSatisfies(f, rule.guard!));
    if (!conditionFact) continue;
    out.push(conditionObservedAssertion(rule.guard, conditionFact));
  }
  return out;
}

export function buildTransitionDeltaAssertions(
  artifact: ArchitectureArtifact,
  fact: { data: string; field: string; from?: string; to: string },
  guardFacts?: ValueFact[],
): string[] {
  if (fact.from) {
    return [buildTransitionDeltaAssertion(artifact, fact), ...buildGuardConditionAssertions(artifact, { ...fact, from: fact.from }, guardFacts)];
  }
  const machine = findMachineForTransition(artifact, fact);
  if (!machine) return [];
  const illegalFroms = enumValuesForField(artifact, fact.data, fact.field).filter(
    from => !transitionAllowed(machine, { from, to: fact.to }, guardFacts),
  );
  return illegalFroms.flatMap(from => [
    buildTransitionDeltaAssertion(artifact, { ...fact, from }),
    ...buildGuardConditionAssertions(artifact, { ...fact, from }, guardFacts),
  ]);
}
