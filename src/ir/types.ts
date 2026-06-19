import type { Confidence, ExtractionStrategy } from '../analyzers/plugin.ts';

export const AG_IR_SCHEMA_VERSION = 1;

export const AG_IR_NODE_KINDS = [
  'project',
  'file',
  'component',
  'symbol',
  'type',
  'field',
  'enum',
  'enum_member',
  'route',
  'operation',
  'event',
  'data_model',
  'resource',
] as const;

export const AG_IR_EDGE_KINDS = [
  'contains',
  'declares',
  'imports',
  'exports',
  'calls',
  'reads',
  'writes',
  'assigns',
  'transitions',
  'emits_event',
  'handles_route',
  'depends_on',
  'runs_on',
  'accesses_resource',
  'carries_data',
] as const;

export type AgIrNodeKind = typeof AG_IR_NODE_KINDS[number];
export type AgIrEdgeKind = typeof AG_IR_EDGE_KINDS[number];

export interface AgIrSourceSpan {
  file: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  startByte?: number;
  endByte?: number;
}

export interface AgIrEvidence {
  extractor: string;
  strategy: ExtractionStrategy;
  confidence: Confidence;
  language?: string;
  query?: string;
  capture?: string;
  message?: string;
  span?: AgIrSourceSpan;
  raw?: Record<string, unknown>;
}

export interface AgIrNode {
  id: string;
  kind: AgIrNodeKind;
  label: string;
  properties?: Record<string, string | number | boolean | string[]>;
  evidence?: AgIrEvidence[];
}

export interface AgIrEdge {
  id: string;
  kind: AgIrEdgeKind;
  from: string;
  to: string;
  properties?: Record<string, string | number | boolean | string[]>;
  evidence: AgIrEvidence[];
}

export interface AgIrGraph {
  schema_version: typeof AG_IR_SCHEMA_VERSION;
  nodes: AgIrNode[];
  edges: AgIrEdge[];
}

export interface AgIrValidationResult {
  passed: boolean;
  errors: string[];
}
