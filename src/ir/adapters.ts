import type { GraphFact } from '../analyzers/plugin.ts';
import { agIrEdge, agIrId, agIrNode, emptyAgIrGraph, mergeAgIrGraphs } from './builders.ts';
import type { AgIrEdgeKind, AgIrEvidence, AgIrGraph, AgIrNodeKind } from './types.ts';

const FACT_KIND_TO_EDGE: Record<string, AgIrEdgeKind> = {
  accesses_technology: 'accesses_resource',
  accesses_component: 'depends_on',
  direct_component_access: 'depends_on',
  flow: 'depends_on',
  call: 'calls',
  assignment: 'assigns',
  value: 'assigns',
  operation_event: 'calls',
  event: 'emits_event',
  route: 'handles_route',
  inject: 'depends_on',
  resolve: 'depends_on',
};

function nodeKindForFactTarget(fact: GraphFact, endpoint: 'subject' | 'target'): AgIrNodeKind {
  if (endpoint === 'subject') return 'component';
  if (fact.route) return 'route';
  if (fact.technology || fact.kind === 'accesses_technology') return 'resource';
  if (fact.kind === 'event') return 'event';
  if (fact.kind === 'operation_event' || fact.kind === 'call') return 'operation';
  return 'symbol';
}

function targetLabel(fact: GraphFact): string {
  return fact.target
    ?? fact.technology
    ?? fact.route
    ?? fact.model
    ?? String(fact.properties?.target ?? fact.properties?.method ?? fact.properties?.event ?? fact.kind);
}

function evidenceFromGraphFact(fact: GraphFact): AgIrEvidence {
  return {
    extractor: fact.evidence.extractor ?? 'unknown',
    strategy: fact.evidence.strategy ?? 'graph',
    confidence: fact.confidence,
    language: fact.evidence.ast?.language,
    query: fact.evidence.ast?.query,
    message: fact.evidence.message,
    ...(fact.evidence.file ? {
      span: {
        file: fact.evidence.file,
        startLine: fact.evidence.line,
        startColumn: fact.evidence.ast?.startColumn,
        endLine: fact.evidence.ast?.endLine,
        endColumn: fact.evidence.ast?.endColumn,
        startByte: fact.evidence.ast?.startByte,
        endByte: fact.evidence.ast?.endByte,
      },
    } : {}),
    raw: {
      graphFactId: fact.id,
      graphFactKind: fact.kind,
      properties: fact.properties ?? {},
    },
  };
}

export function graphFactToAgIr(fact: GraphFact): AgIrGraph {
  const graph = emptyAgIrGraph();
  const subjectId = agIrId('component', fact.subject);
  const target = targetLabel(fact);
  const targetKind = nodeKindForFactTarget(fact, 'target');
  const targetId = agIrId(targetKind, target);
  const edgeKind = FACT_KIND_TO_EDGE[fact.kind] ?? 'depends_on';

  graph.nodes.push(agIrNode({
    kind: nodeKindForFactTarget(fact, 'subject'),
    id: subjectId,
    label: fact.subject,
  }));
  graph.nodes.push(agIrNode({
    kind: targetKind,
    id: targetId,
    label: target,
    properties: {
      ...(fact.technology ? { technology: fact.technology } : {}),
      ...(fact.route ? { route: fact.route } : {}),
      ...(fact.model ? { model: fact.model } : {}),
    },
  }));
  graph.edges.push(agIrEdge({
    kind: edgeKind,
    id: agIrId('edge', edgeKind, subjectId, targetId, fact.id),
    from: subjectId,
    to: targetId,
    properties: {
      graphFactKind: fact.kind,
      ...(fact.properties ?? {}),
    },
    evidence: [evidenceFromGraphFact(fact)],
  }));
  return graph;
}

export function graphFactsToAgIr(facts: GraphFact[]): AgIrGraph {
  return mergeAgIrGraphs(facts.map(graphFactToAgIr));
}
