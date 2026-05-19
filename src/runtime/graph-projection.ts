import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { Confidence, FlowFact, GraphFact } from '../analyzers/plugin.ts';
import { isBlocking } from '../analyzers/plugin.ts';
import { resolveCategoryToNodes } from '../analyzers/node-resolver.ts';

export interface GraphProjectionWarning {
  graphFactId: string;
  message: string;
}

export interface FlowProjectionResult {
  flowFacts: FlowFact[];
  blockingFacts: FlowFact[];
  warningFacts: FlowFact[];
  smtAssertions: string[];
  factSmtMap: Map<string, string>;
  unresolvedTargets: string[];
  warnings: GraphProjectionWarning[];
}

export interface GraphReport {
  facts: GraphFact[];
  projections: {
    flow: FlowFact[];
  };
  smt: {
    assertions: string[];
    reservedPredicates?: string[];
  };
  unresolvedTargets: string[];
  warnings: GraphProjectionWarning[];
}

const FLOW_KINDS = new Set([
  'accesses_technology',
  'direct_component_access',
  'accesses_component',
  'flow',
]);

export const RESERVED_GRAPH_PREDICATES = [
  '(declare-fun ReadsModel (Entity DataModel) Bool)',
  '(declare-fun WritesModel (Entity DataModel) Bool)',
  '(declare-fun CarriesModel (Entity Entity DataModel) Bool)',
  '(declare-fun RouteReturns (Entity Route DataModel) Bool)',
];

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function evidenceText(fact: GraphFact): string {
  return fact.evidence.message ?? `${fact.kind} detected`;
}

function flowEvidence(fact: GraphFact): FlowFact['graphEvidence'] {
  return {
    graphFactId: fact.id,
    kind: fact.kind,
    extractor: fact.evidence.extractor,
    file: fact.evidence.file,
    line: fact.evidence.line,
    evidence: evidenceText(fact),
  };
}

function targetsForGraphFact(
  fact: GraphFact,
  artifact: ArchitectureArtifact,
): { targets: string[]; unresolved?: string } {
  const declaredNodes = new Set((artifact.nodes ?? []).map(n => n.name));
  const declaredComponents = new Set(Object.keys(artifact.mappings ?? {}));

  if (fact.kind === 'accesses_technology') {
    const technology = fact.technology ?? fact.target;
    if (!technology) {
      return { targets: [], unresolved: '(missing technology)' };
    }
    if (declaredNodes.has(technology) || declaredComponents.has(technology)) {
      return { targets: [technology] };
    }
    const resolved = resolveCategoryToNodes(technology, artifact.nodes ?? []);
    const unresolved = resolved.length === 1 && resolved[0] === technology && !declaredNodes.has(technology)
      ? technology
      : undefined;
    return { targets: resolved, unresolved };
  }

  const target = fact.target ?? fact.technology;
  if (!target) {
    return { targets: [], unresolved: '(missing target)' };
  }
  if (declaredNodes.has(target) || declaredComponents.has(target)) {
    return { targets: [target] };
  }

  const resolved = resolveCategoryToNodes(target, artifact.nodes ?? []);
  const unresolved = resolved.length === 1 && resolved[0] === target && !declaredNodes.has(target)
    ? target
    : undefined;
  return { targets: resolved, unresolved };
}

export function flowFactToGraphFact(
  fact: FlowFact,
  index: number,
  extractor?: string,
): GraphFact {
  return {
    id: `legacy-flow:${index}:${fact.from}:${fact.to}:${fact.file}:${fact.line ?? 0}`,
    kind: 'accesses_technology',
    subject: fact.from,
    technology: fact.to,
    confidence: fact.confidence,
    evidence: {
      extractor,
      file: fact.file,
      line: fact.line,
      message: fact.evidence,
    },
  };
}

export function projectGraphToFlows(
  graphFacts: GraphFact[],
  artifact: ArchitectureArtifact,
  options: { strict?: boolean } = {},
): FlowProjectionResult {
  const strict = options.strict ?? false;
  const flowFacts: FlowFact[] = [];
  const unresolvedTargets: string[] = [];
  const warnings: GraphProjectionWarning[] = [];

  for (const fact of graphFacts) {
    if (!FLOW_KINDS.has(fact.kind)) {
      continue;
    }

    const { targets, unresolved } = targetsForGraphFact(fact, artifact);
    if (unresolved) {
      unresolvedTargets.push(unresolved);
      warnings.push({
        graphFactId: fact.id,
        message: `Could not resolve graph target '${unresolved}' for ${fact.kind}`,
      });
    }

    for (const target of targets) {
      flowFacts.push({
        from: fact.subject,
        to: target,
        confidence: fact.confidence,
        evidence: evidenceText(fact),
        file: fact.evidence.file ?? '',
        line: fact.evidence.line,
        graphEvidence: flowEvidence(fact),
      });
    }
  }

  const uniqueFacts: FlowFact[] = [];
  const seen = new Set<string>();
  for (const fact of flowFacts) {
    const key = `${fact.from}::${fact.to}::${fact.confidence}::${fact.graphEvidence?.graphFactId ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFacts.push(fact);
    }
  }

  const blockingFacts = uniqueFacts.filter(f => isBlocking(f, strict));
  const warningFacts = uniqueFacts.filter(f => !isBlocking(f, strict) && f.confidence === 'probable');

  const smtAssertions: string[] = ['; === delta assertions from graph projections ==='];
  const factSmtMap = new Map<string, string>();
  for (const fact of blockingFacts) {
    const assertion = `(assert (Flow ${smtId(fact.from)} ${smtId(fact.to)}))`;
    smtAssertions.push(`; [${fact.confidence}] ${fact.evidence}`);
    smtAssertions.push(`; GraphFact: ${fact.graphEvidence?.graphFactId ?? 'unknown'}`);
    smtAssertions.push(`; File: ${fact.file}`);
    smtAssertions.push(assertion);
    factSmtMap.set(`${fact.from}::${fact.to}`, assertion);
  }

  return {
    flowFacts: uniqueFacts,
    blockingFacts,
    warningFacts,
    smtAssertions,
    factSmtMap,
    unresolvedTargets: [...new Set(unresolvedTargets)],
    warnings,
  };
}

export function buildGraphReport(
  facts: GraphFact[],
  projection: FlowProjectionResult,
  options: { includeReservedPredicates?: boolean } = {},
): GraphReport {
  return {
    facts,
    projections: {
      flow: projection.flowFacts,
    },
    smt: {
      assertions: projection.smtAssertions,
      ...(options.includeReservedPredicates ? { reservedPredicates: RESERVED_GRAPH_PREDICATES } : {}),
    },
    unresolvedTargets: projection.unresolvedTargets,
    warnings: projection.warnings,
  };
}
