import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import type { Confidence, FlowFact, GraphFact } from '../analyzers/plugin.ts';

type Scalar = string | number | boolean | string[];

interface SubstitutionResult {
  value: string;
  missing: string[];
}

export interface ExtractionQuery {
  id: string;
  owner: string;
  version: number;
  confidence: Confidence;
  file: string;
  match: Record<string, Scalar>;
  emit:
    | {
        kind: 'transition';
        data: string;
        field: string;
        from?: string;
        to: string;
      }
    | {
        kind: 'flow';
        from: string;
        to: string;
      }
    | {
        kind: 'operation';
        operation: string;
        data?: string;
        component: string;
      }
    | {
        kind: 'auth';
        from: string;
        to: string;
        authenticated: boolean;
      }
    | {
        kind: 'encryption';
        from: string;
        to: string;
        encrypted: boolean;
      }
    | {
        kind: 'dependency';
        from: string;
        to: string;
        interface?: string;
      };
}

export interface TransitionFact {
  data: string;
  field: string;
  from?: string;
  to: string;
  confidence: Confidence;
  file: string;
  line?: number;
  evidence: string;
  graphFactId: string;
  query: {
    id: string;
    version: number;
    file: string;
  };
}

export type QueryFlowFact = FlowFact & {
  query: {
    id: string;
    version: number;
    file: string;
    graphFactId: string;
  };
};

export interface OperationFact {
  operation: string;
  data?: string;
  component: string;
  confidence: Confidence;
  file: string;
  line?: number;
  evidence: string;
  graphFactId: string;
  query: {
    id: string;
    version: number;
    file: string;
  };
}

export interface AuthCounterexampleFact {
  from: string;
  to: string;
  authenticated: false;
  confidence: Confidence;
  file: string;
  line?: number;
  evidence: string;
  graphFactId: string;
  query: { id: string; version: number; file: string };
}

export interface EncryptionCounterexampleFact {
  from: string;
  to: string;
  encrypted: false;
  confidence: Confidence;
  file: string;
  line?: number;
  evidence: string;
  graphFactId: string;
  query: { id: string; version: number; file: string };
}

export interface DependencyFact {
  from: string;
  to: string;
  interface?: string;
  confidence: Confidence;
  file: string;
  line?: number;
  evidence: string;
  graphFactId: string;
  query: { id: string; version: number; file: string };
}

export interface ExtractionQueryFacts {
  transitionFacts: TransitionFact[];
  flowFacts: QueryFlowFact[];
  operationFacts: OperationFact[];
  authFacts: AuthCounterexampleFact[];
  encryptionFacts: EncryptionCounterexampleFact[];
  dependencyFacts: DependencyFact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateConfidence(value: unknown): Confidence {
  if (value === 'definite' || value === 'probable' || value === 'possible') return value;
  throw new Error(`invalid query confidence '${String(value)}'`);
}

function validateScalarMap(value: unknown, label: string): Record<string, Scalar> {
  if (!isRecord(value)) throw new Error(`query ${label} must be an object`);
  const out: Record<string, Scalar> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    } else if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) {
      out[key] = raw;
    } else {
      throw new Error(`query ${label}.${key} must be a scalar or string array`);
    }
  }
  return out;
}

function parseQuery(raw: unknown, file: string): ExtractionQuery {
  if (!isRecord(raw)) throw new Error(`query file '${file}' must contain an object`);
  if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error(`query '${file}' missing id`);
  if (typeof raw.owner !== 'string' || raw.owner.length === 0) throw new Error(`query '${raw.id}' missing owner`);
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new Error(`query '${raw.id}' version must be a positive integer`);
  }
  const emit = raw.emit;
  if (!isRecord(emit)) throw new Error(`query '${raw.id}' missing emit`);
  if (emit.kind !== 'transition' && emit.kind !== 'flow' && emit.kind !== 'operation' && emit.kind !== 'auth' && emit.kind !== 'encryption' && emit.kind !== 'dependency') {
    throw new Error(`query '${raw.id}' only supports emit.kind=transition, emit.kind=flow, emit.kind=operation, emit.kind=auth, emit.kind=encryption, or emit.kind=dependency`);
  }
  if (raw.match === undefined) throw new Error(`query '${raw.id}' missing match`);
  if (raw.confidence === undefined) throw new Error(`query '${raw.id}' missing confidence`);
  const confidence = validateConfidence(raw.confidence);
  const match = validateScalarMap(raw.match, 'match');
  if (emit.kind === 'flow') {
    for (const field of ['from', 'to'] as const) {
      if (typeof emit[field] !== 'string' || emit[field].length === 0) {
        throw new Error(`query '${raw.id}' missing emit.${field}`);
      }
    }
    return {
      id: raw.id,
      owner: raw.owner,
      version: raw.version,
      confidence,
      file,
      match,
      emit: {
        kind: 'flow',
        from: emit.from as string,
        to: emit.to as string,
      },
    };
  }
  if (emit.kind === 'operation') {
    for (const field of ['operation', 'component'] as const) {
      if (typeof emit[field] !== 'string' || emit[field].length === 0) {
        throw new Error(`query '${raw.id}' missing emit.${field}`);
      }
    }
    return {
      id: raw.id,
      owner: raw.owner,
      version: raw.version,
      confidence,
      file,
      match,
      emit: {
        kind: 'operation',
        operation: emit.operation as string,
        ...(typeof emit.data === 'string' && emit.data.length > 0 ? { data: emit.data } : {}),
        component: emit.component as string,
      },
    };
  }
  if (emit.kind === 'auth') {
    for (const field of ['from', 'to'] as const) {
      if (typeof emit[field] !== 'string' || emit[field].length === 0) throw new Error(`query '${raw.id}' missing emit.${field}`);
    }
    if (emit.authenticated !== false) throw new Error(`query '${raw.id}' emit.authenticated must be false`);
    return { id: raw.id, owner: raw.owner, version: raw.version, confidence, file, match, emit: { kind: 'auth', from: emit.from as string, to: emit.to as string, authenticated: false } };
  }
  if (emit.kind === 'encryption') {
    for (const field of ['from', 'to'] as const) {
      if (typeof emit[field] !== 'string' || emit[field].length === 0) throw new Error(`query '${raw.id}' missing emit.${field}`);
    }
    if (emit.encrypted !== false) throw new Error(`query '${raw.id}' emit.encrypted must be false`);
    return { id: raw.id, owner: raw.owner, version: raw.version, confidence, file, match, emit: { kind: 'encryption', from: emit.from as string, to: emit.to as string, encrypted: false } };
  }
  if (emit.kind === 'dependency') {
    for (const field of ['from', 'to'] as const) {
      if (typeof emit[field] !== 'string' || emit[field].length === 0) throw new Error(`query '${raw.id}' missing emit.${field}`);
    }
    if (emit.interface !== undefined && typeof emit.interface !== 'string') throw new Error(`query '${raw.id}' emit.interface must be a string`);
    return { id: raw.id, owner: raw.owner, version: raw.version, confidence, file, match, emit: { kind: 'dependency', from: emit.from as string, to: emit.to as string, ...(emit.interface ? { interface: emit.interface as string } : {}) } };
  }
  for (const field of ['data', 'field', 'to'] as const) {
    if (typeof emit[field] !== 'string' || emit[field].length === 0) {
      throw new Error(`query '${raw.id}' missing emit.${field}`);
    }
  }
  if (emit.from !== undefined && typeof emit.from !== 'string') {
    throw new Error(`query '${raw.id}' emit.from must be a string`);
  }
  const data = emit.data as string;
  const field = emit.field as string;
  const to = emit.to as string;
  const from = emit.from as string | undefined;
  return {
    id: raw.id,
    owner: raw.owner,
    version: raw.version,
    confidence,
    file,
    match,
    emit: {
      kind: 'transition',
      data,
      field,
      ...(from ? { from } : {}),
      to,
    },
  };
}

export function loadExtractionQueries(projectRoot?: string): ExtractionQuery[] {
  if (!projectRoot) return [];
  const dir = join(projectRoot, '.aglang', 'extractors');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(name => /\.agq\.ya?ml$/i.test(name))
    .map(name => join(dir, name));
  const queries = files.map(file => {
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`failed to parse extraction query '${file}': ${(err as Error).message}`);
    }
    return parseQuery(raw, file);
  });
  const ids = new Set<string>();
  for (const query of queries) {
    if (ids.has(query.id)) throw new Error(`duplicate extraction query id '${query.id}'`);
    ids.add(query.id);
  }
  return queries;
}

function graphValue(fact: GraphFact, key: string): Scalar | undefined {
  if (key === 'kind') return fact.kind;
  if (key === 'subject') return fact.subject;
  if (key === 'target') return fact.target;
  if (key === 'technology') return fact.technology;
  if (key === 'model') return fact.model;
  if (key === 'route') return fact.route;
  if (key === 'extractor') return fact.evidence.extractor;
  if (key === 'strategy') return fact.evidence.strategy;
  return fact.properties?.[key];
}

function valueMatches(expected: Scalar, actual: Scalar | undefined): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(expected)) {
    return expected.some(item => Array.isArray(actual) ? actual.includes(item) : actual === item);
  }
  if (Array.isArray(actual)) return actual.includes(String(expected));
  return actual === expected;
}

function substitute(template: string | undefined, fact: GraphFact): SubstitutionResult | undefined {
  if (!template) return undefined;
  const missing: string[] = [];
  const value = template.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = graphValue(fact, key);
    if (Array.isArray(value)) return value[0] ?? '';
    if (value === undefined || value === '') {
      missing.push(key);
      return '';
    }
    return String(value);
  });
  return { value, missing };
}

function queryMatches(query: ExtractionQuery, fact: GraphFact): boolean {
  return Object.entries(query.match).every(([key, expected]) => valueMatches(expected, graphValue(fact, key)));
}

export function applyExtractionQueryFacts(queries: ExtractionQuery[], graphFacts: GraphFact[]): ExtractionQueryFacts {
  const transitionFacts: TransitionFact[] = [];
  const flowFacts: QueryFlowFact[] = [];
  const operationFacts: OperationFact[] = [];
  const authFacts: AuthCounterexampleFact[] = [];
  const encryptionFacts: EncryptionCounterexampleFact[] = [];
  const dependencyFacts: DependencyFact[] = [];
  for (const query of queries) {
    for (const graphFact of graphFacts) {
      if (!queryMatches(query, graphFact)) continue;
      if (query.emit.kind === 'flow') {
        const from = substitute(query.emit.from, graphFact);
        const to = substitute(query.emit.to, graphFact);
        if (!from || !to || !from.value || !to.value || from.missing.length > 0 || to.missing.length > 0) continue;
        flowFacts.push({
          from: from.value,
          to: to.value,
          confidence: query.confidence,
          file: graphFact.evidence.file ?? '',
          line: graphFact.evidence.line,
          evidence: `Extraction query '${query.id}' emitted flow from ${graphFact.kind}: ${graphFact.evidence.message ?? graphFact.id}`,
          strategy: 'graph',
          graphEvidence: {
            graphFactId: graphFact.id,
            kind: graphFact.kind,
            extractor: graphFact.evidence.extractor,
            strategy: graphFact.evidence.strategy,
            file: graphFact.evidence.file,
            line: graphFact.evidence.line,
            evidence: graphFact.evidence.message ?? graphFact.id,
          },
          query: {
            id: query.id,
            version: query.version,
            file: query.file,
            graphFactId: graphFact.id,
          },
        });
        continue;
      }
      if (query.emit.kind === 'operation') {
        const operation = substitute(query.emit.operation, graphFact) ?? { value: query.emit.operation, missing: [] };
        const data = substitute(query.emit.data, graphFact);
        const component = substitute(query.emit.component, graphFact);
        if (!component || !component.value || component.missing.length > 0 || operation.missing.length > 0 || !operation.value || (data && data.missing.length > 0)) continue;
        operationFacts.push({
          operation: operation.value,
          ...(data?.value ? { data: data.value } : {}),
          component: component.value,
          confidence: query.confidence,
          file: graphFact.evidence.file ?? '',
          line: graphFact.evidence.line,
          evidence: `Extraction query '${query.id}' emitted operation from ${graphFact.kind}: ${graphFact.evidence.message ?? graphFact.id}`,
          graphFactId: graphFact.id,
          query: {
            id: query.id,
            version: query.version,
            file: query.file,
          },
        });
        continue;
      }
      if (query.emit.kind === 'auth' || query.emit.kind === 'encryption' || query.emit.kind === 'dependency') {
        const from = substitute(query.emit.from, graphFact);
        const to = substitute(query.emit.to, graphFact);
        if (!from || !to || !from.value || !to.value || from.missing.length > 0 || to.missing.length > 0) continue;
        const base = {
          from: from.value,
          to: to.value,
          confidence: query.confidence,
          file: graphFact.evidence.file ?? '',
          line: graphFact.evidence.line,
          graphFactId: graphFact.id,
          query: { id: query.id, version: query.version, file: query.file },
        };
        if (query.emit.kind === 'auth') {
          authFacts.push({ ...base, authenticated: false, evidence: `Extraction query '${query.id}' emitted unauthenticated flow from ${graphFact.kind}: ${graphFact.evidence.message ?? graphFact.id}` });
        } else if (query.emit.kind === 'encryption') {
          encryptionFacts.push({ ...base, encrypted: false, evidence: `Extraction query '${query.id}' emitted unencrypted flow from ${graphFact.kind}: ${graphFact.evidence.message ?? graphFact.id}` });
        } else {
          const iface = substitute(query.emit.interface, graphFact);
          if (iface && iface.missing.length > 0) continue;
          dependencyFacts.push({ ...base, ...(iface?.value ? { interface: iface.value } : {}), evidence: `Extraction query '${query.id}' emitted dependency from ${graphFact.kind}: ${graphFact.evidence.message ?? graphFact.id}` });
        }
        continue;
      }
      const data = substitute(query.emit.data, graphFact) ?? { value: query.emit.data, missing: [] };
      const field = substitute(query.emit.field, graphFact) ?? { value: query.emit.field, missing: [] };
      const to = substitute(query.emit.to, graphFact);
      if (!to || !to.value || to.missing.length > 0 || data.missing.length > 0 || field.missing.length > 0 || !data.value || !field.value) continue;
      const from = substitute(query.emit.from, graphFact);
      transitionFacts.push({
        data: data.value,
        field: field.value,
        ...(from && from.value && from.missing.length === 0 ? { from: from.value } : {}),
        to: to.value,
        confidence: query.confidence,
        file: graphFact.evidence.file ?? '',
        line: graphFact.evidence.line,
        evidence: `Extraction query '${query.id}' matched ${graphFact.kind}: ${graphFact.evidence.message ?? graphFact.id}`,
        graphFactId: graphFact.id,
        query: {
          id: query.id,
          version: query.version,
          file: query.file,
        },
      });
    }
  }
  return { transitionFacts, flowFacts, operationFacts, authFacts, encryptionFacts, dependencyFacts };
}

export function applyExtractionQueries(queries: ExtractionQuery[], graphFacts: GraphFact[]): TransitionFact[] {
  return applyExtractionQueryFacts(queries, graphFacts).transitionFacts;
}
