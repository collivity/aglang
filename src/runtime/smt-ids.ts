// Shared SMT identifier formatting — used by gate.ts and delta-assert.ts to keep
// permanent constraints and delta assertions naming-compatible with each other.

export function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function relationSmtId(relation: string): string {
  return `Relation__${relation.replace(/[^a-zA-Z0-9_]/g, token => ({ '=': 'eq', '!': 'not', '>': 'gt', '<': 'lt' }[token] ?? '_'))}`;
}

export function scalarSmtId(value: unknown): string {
  if (value === null) return 'Value__null';
  return `Value__${smtId(String(value))}`;
}

export function fieldPathSmtId(subject: string, path: string[]): string {
  return `FieldPath__${smtId(subject)}__${path.map(smtId).join('__')}`;
}

// Real-numeric-literal formatting for the FieldValueInt/Real predicates (Phase 1 of the
// "real arithmetic" work) — emits an actual SMT-LIB Int/Real literal instead of
// an opaque ScalarValue atom. Negative numbers need parens in SMT-LIB: -3 -> (- 3).
export function numericSmtLiteral(value: number, sort: 'Int' | 'Real' = 'Int'): string {
  if (sort === 'Int') {
    return value < 0 ? `(- ${Math.abs(value)})` : String(value);
  }
  // Real literals must contain a decimal point in SMT-LIB (3 is Int, 3.0 is Real).
  const abs = Math.abs(value);
  const text = Number.isInteger(abs) ? `${abs}.0` : String(abs);
  return value < 0 ? `(- ${text})` : text;
}

// '==' -> '=' and '!=' -> 'distinct' are SMT-LIB's actual equality predicates;
// '>=','<=','>','<' are already valid SMT-LIB operator tokens as-is.
export function smtRelationOperator(relation: string): string {
  if (relation === '==') return '=';
  if (relation === '!=') return 'distinct';
  return relation;
}

export type ValueRelation = '==' | '!=' | '>=' | '<=' | '>' | '<';

// Negate a relation so a numeric requirement's *violated* form can be built — needed because the
// (assert (=> X false)) wrapper expects X to mean "this is a violation", matching how
// ValueContradiction is only ever asserted true when a real violation was found.
export function negateRelation(relation: ValueRelation): ValueRelation {
  switch (relation) {
    case '==': return '!=';
    case '!=': return '==';
    case '>=': return '<';
    case '<=': return '>';
    case '>': return '<=';
    case '<': return '>=';
  }
}

export function fieldValueTerm(subject: string, path: string[], sort: 'Int' | 'Real'): string {
  const fn = sort === 'Real' ? 'FieldValueReal' : 'FieldValueInt';
  return `(${fn} ${smtId(subject)} ${fieldPathSmtId(subject, path)})`;
}

export function operationFieldValueTerm(operation: string, phase: string, subject: string, path: string[], sort: 'Int' | 'Real'): string {
  const fn = sort === 'Real' ? 'OperationFieldValueReal' : 'OperationFieldValueInt';
  return `(${fn} Operation__${smtId(operation)} ${phase} ${smtId(subject)} ${fieldPathSmtId(subject, path)})`;
}

// Resolves the observed numeric value for a fact whose field is known (from the policy's resolved
// valueType) to be numeric. Prefers an already-typed numericValue (e.g. a real number captured
// straight from a GraphFact property); falls back to parsing the extracted fact's string value,
// since most .agq.yml captures arrive as text (`value: "$actualLength"`) even when semantically
// numeric. Returns undefined if the string genuinely isn't a number — callers should fall back to
// the non-numeric atom encoding rather than silently mismatching permanent vs. delta assertions.
export function resolveNumericFactValue(numericValue: number | undefined, stringValue: string): number | undefined {
  if (numericValue !== undefined) return numericValue;
  if (stringValue.trim() === '') return undefined;
  const parsed = Number(stringValue);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface ValueExprLike {
  subject: string;
  path: string[];
  relation: ValueRelation;
  value: unknown;
  valueType?: 'Int' | 'Real';
}

interface ValueFactLike {
  subject: string;
  path: string[];
  value: string;
  numericValue?: number;
}

// Single source of truth for the *delta* (runtime-observed) SMT-LIB assertions for a value_policy
// violation — used identically by delta-assert.ts (the actual solver input) and gate.ts (the
// z3_proof display), so they can never drift out of sync the way the pre-numeric code did.
export function valuePolicyDeltaAssertions(
  requirement: ValueExprLike,
  fact: ValueFactLike,
  when?: ValueExprLike,
  conditionFact?: ValueFactLike,
): string[] {
  const out: string[] = [];
  if (when && conditionFact) {
    const observed = when.valueType ? resolveNumericFactValue(conditionFact.numericValue, conditionFact.value) : undefined;
    out.push(
      when.valueType && observed !== undefined
        ? `(assert (= ${fieldValueTerm(conditionFact.subject, conditionFact.path, when.valueType)} ${numericSmtLiteral(observed, when.valueType)}))`
        : `(assert (ValueFact ${smtId(conditionFact.subject)} ${fieldPathSmtId(conditionFact.subject, conditionFact.path)} ${relationSmtId(when.relation)} ${scalarSmtId(when.value)}))`,
    );
  }
  const reqObserved = requirement.valueType ? resolveNumericFactValue(fact.numericValue, fact.value) : undefined;
  out.push(
    requirement.valueType && reqObserved !== undefined
      ? `(assert (= ${fieldValueTerm(fact.subject, fact.path, requirement.valueType)} ${numericSmtLiteral(reqObserved, requirement.valueType)}))`
      : `(assert (ValueContradiction ${smtId(fact.subject)} ${fieldPathSmtId(fact.subject, fact.path)} ${relationSmtId(requirement.relation)} ${scalarSmtId(requirement.value)}))`,
  );
  return out;
}

// Same idea for operation_policy's single requirement-only delta assertion.
export function operationPolicyDeltaAssertion(
  operation: string,
  phase: 'Phase__before' | 'Phase__after',
  requirement: ValueExprLike,
  fact: ValueFactLike,
): string {
  const observed = requirement.valueType ? resolveNumericFactValue(fact.numericValue, fact.value) : undefined;
  if (requirement.valueType && observed !== undefined) {
    return `(assert (= ${operationFieldValueTerm(operation, phase, fact.subject, fact.path, requirement.valueType)} ${numericSmtLiteral(observed, requirement.valueType)}))`;
  }
  return `(assert (OperationStateContradiction Operation__${smtId(operation)} ${phase} ${smtId(fact.subject)} ${fieldPathSmtId(fact.subject, fact.path)} ${relationSmtId(requirement.relation)} ${scalarSmtId(requirement.value)}))`;
}

// Mirrors translator.ts's permanent-constraint shape, for gate.ts's z3_proof display so it never
// drifts from what's actually compiled into architecture.o's constraints.
export function valuePolicyPermanentConstraint(requirement: ValueExprLike, when?: ValueExprLike): string {
  const reqViolation = requirement.valueType
    ? `(${smtRelationOperator(negateRelation(requirement.relation))} ${fieldValueTerm(requirement.subject, requirement.path, requirement.valueType)} ${numericSmtLiteral(requirement.value as number, requirement.valueType)})`
    : `(ValueContradiction ${smtId(requirement.subject)} ${fieldPathSmtId(requirement.subject, requirement.path)} ${relationSmtId(requirement.relation)} ${scalarSmtId(requirement.value)})`;
  if (!when) return `(assert (=> ${reqViolation} false))`;
  const whenObserved = when.valueType
    ? `(${smtRelationOperator(when.relation)} ${fieldValueTerm(when.subject, when.path, when.valueType)} ${numericSmtLiteral(when.value as number, when.valueType)})`
    : `(ValueFact ${smtId(when.subject)} ${fieldPathSmtId(when.subject, when.path)} ${relationSmtId(when.relation)} ${scalarSmtId(when.value)})`;
  return `(assert (=> (and ${whenObserved} ${reqViolation}) false))`;
}

export function operationPolicyPermanentConstraint(
  operation: string,
  phase: 'Phase__before' | 'Phase__after',
  requirement: ValueExprLike,
): string {
  const reqViolation = requirement.valueType
    ? `(${smtRelationOperator(negateRelation(requirement.relation))} ${operationFieldValueTerm(operation, phase, requirement.subject, requirement.path, requirement.valueType)} ${numericSmtLiteral(requirement.value as number, requirement.valueType)})`
    : `(OperationStateContradiction Operation__${smtId(operation)} ${phase} ${smtId(requirement.subject)} ${fieldPathSmtId(requirement.subject, requirement.path)} ${relationSmtId(requirement.relation)} ${scalarSmtId(requirement.value)})`;
  return `(assert (=> ${reqViolation} false))`;
}
