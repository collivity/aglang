import {
  AG_IR_EDGE_KINDS,
  AG_IR_NODE_KINDS,
  AG_IR_SCHEMA_VERSION,
  type AgIrGraph,
  type AgIrValidationResult,
} from './types.ts';

const NODE_KINDS = new Set<string>(AG_IR_NODE_KINDS);
const EDGE_KINDS = new Set<string>(AG_IR_EDGE_KINDS);

export function validateAgIrGraph(graph: AgIrGraph): AgIrValidationResult {
  const errors: string[] = [];
  if (graph.schema_version !== AG_IR_SCHEMA_VERSION) {
    errors.push(`unsupported Ag-IR schema_version ${String(graph.schema_version)}`);
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id) errors.push('node missing id');
    if (!NODE_KINDS.has(node.kind)) errors.push(`node '${node.id}' has invalid kind '${node.kind}'`);
    if (nodeIds.has(node.id)) errors.push(`duplicate node id '${node.id}'`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.id) errors.push('edge missing id');
    if (!EDGE_KINDS.has(edge.kind)) errors.push(`edge '${edge.id}' has invalid kind '${edge.kind}'`);
    if (!nodeIds.has(edge.from)) errors.push(`edge '${edge.id}' references missing from node '${edge.from}'`);
    if (!nodeIds.has(edge.to)) errors.push(`edge '${edge.id}' references missing to node '${edge.to}'`);
    if (edge.evidence.length === 0) errors.push(`edge '${edge.id}' has no evidence`);
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id '${edge.id}'`);
    edgeIds.add(edge.id);
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}
