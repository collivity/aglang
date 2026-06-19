import {
  AG_IR_SCHEMA_VERSION,
  type AgIrEdge,
  type AgIrEdgeKind,
  type AgIrEvidence,
  type AgIrGraph,
  type AgIrNode,
  type AgIrNodeKind,
} from './types.ts';

type Properties = Record<string, string | number | boolean | string[]>;

export function agIrId(...parts: Array<string | number | boolean | string[] | undefined>): string {
  return parts
    .filter(part => part !== undefined)
    .map(part => String(part).replace(/[^a-zA-Z0-9_.:-]+/g, '_'))
    .join(':');
}

export function emptyAgIrGraph(): AgIrGraph {
  return {
    schema_version: AG_IR_SCHEMA_VERSION,
    nodes: [],
    edges: [],
  };
}

export function agIrNode(input: {
  kind: AgIrNodeKind;
  id?: string;
  label: string;
  properties?: Properties;
  evidence?: AgIrEvidence[];
}): AgIrNode {
  return {
    id: input.id ?? agIrId('node', input.kind, input.label),
    kind: input.kind,
    label: input.label,
    ...(input.properties ? { properties: input.properties } : {}),
    ...(input.evidence?.length ? { evidence: input.evidence } : {}),
  };
}

export function agIrEdge(input: {
  kind: AgIrEdgeKind;
  id?: string;
  from: string;
  to: string;
  properties?: Properties;
  evidence: AgIrEvidence[];
}): AgIrEdge {
  return {
    id: input.id ?? agIrId('edge', input.kind, input.from, input.to, JSON.stringify(input.properties ?? {})),
    kind: input.kind,
    from: input.from,
    to: input.to,
    ...(input.properties ? { properties: input.properties } : {}),
    evidence: input.evidence,
  };
}

export function mergeAgIrGraphs(graphs: AgIrGraph[]): AgIrGraph {
  const nodes = new Map<string, AgIrNode>();
  const edges = new Map<string, AgIrEdge>();

  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const existing = nodes.get(node.id);
      if (!existing) {
        nodes.set(node.id, node);
        continue;
      }
      nodes.set(node.id, {
        ...existing,
        properties: { ...(existing.properties ?? {}), ...(node.properties ?? {}) },
        evidence: [...(existing.evidence ?? []), ...(node.evidence ?? [])],
      });
    }
    for (const edge of graph.edges) {
      const existing = edges.get(edge.id);
      if (!existing) {
        edges.set(edge.id, edge);
        continue;
      }
      edges.set(edge.id, {
        ...existing,
        properties: { ...(existing.properties ?? {}), ...(edge.properties ?? {}) },
        evidence: [...existing.evidence, ...edge.evidence],
      });
    }
  }

  return {
    schema_version: AG_IR_SCHEMA_VERSION,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}
