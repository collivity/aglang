import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyExtractionQueries, applyExtractionQueryFacts, loadExtractionQueries } from '../src/runtime/extraction-query.ts';
import type { GraphFact } from '../src/analyzers/plugin.ts';

describe('extraction query files', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempProject(): string {
    const dir = join(tmpdir(), `aglang-query-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function writeQuery(project: string, name: string, content: string): void {
    writeFileSync(join(project, '.aglang', 'extractors', name), content);
  }

  function graphFact(properties: GraphFact['properties']): GraphFact {
    return {
      id: 'graph-1',
      kind: 'assignment',
      subject: 'Orders',
      properties,
      confidence: 'definite',
      evidence: {
        extractor: 'test',
        strategy: 'graph',
        file: 'orders.ts',
        line: 12,
        message: 'order.status assignment',
      },
    };
  }

  const validQuery = `
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: "$property"
  from: "$previousMember"
  to: "$valueMember"
`;

  it('loads valid auditable query files', () => {
    const project = tempProject();
    writeQuery(project, 'order.agq.yml', validQuery);

    const queries = loadExtractionQueries(project);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.id).toBe('OrderLifecycleTransitions');
    expect(queries[0]!.file.endsWith('order.agq.yml')).toBe(true);
  });

  it.each([
    ['id', validQuery.replace('id: OrderLifecycleTransitions\n', '')],
    ['owner', validQuery.replace('owner: payments\n', '')],
    ['version', validQuery.replace('version: 1\n', '')],
    ['confidence', validQuery.replace('confidence: definite\n', '')],
    ['match', validQuery.replace(/match:\n  kind: assignment\n  property: status\n  valueEnum: OrderStatus\n/, '')],
    ['emit', validQuery.replace(/emit:\n  kind: transition\n  data: Order\n  field: "\$property"\n  from: "\$previousMember"\n  to: "\$valueMember"\n/, '')],
  ])('rejects query files missing %s', (_field, content) => {
    const project = tempProject();
    writeQuery(project, 'bad.agq.yml', content);

    expect(() => loadExtractionQueries(project)).toThrow(/missing|must be/);
  });

  it.each([
    ['invalid confidence', validQuery.replace('confidence: definite', 'confidence: certain')],
    ['invalid emit kind', validQuery.replace('kind: transition', 'kind: dataflow')],
    ['malformed match map', validQuery.replace('  property: status', '  property:\n    nested: status')],
  ])('rejects %s', (_label, content) => {
    const project = tempProject();
    writeQuery(project, 'bad.agq.yml', content);

    expect(() => loadExtractionQueries(project)).toThrow();
  });

  it('rejects duplicate query ids', () => {
    const project = tempProject();
    writeQuery(project, 'a.agq.yml', validQuery);
    writeQuery(project, 'b.agq.yml', validQuery);

    expect(() => loadExtractionQueries(project)).toThrow(/duplicate extraction query id 'OrderLifecycleTransitions'/);
  });

  it('rejects malformed YAML with the query file path', () => {
    const project = tempProject();
    writeQuery(project, 'broken.agq.yml', 'id: [unterminated\n');

    expect(() => loadExtractionQueries(project)).toThrow(/failed to parse extraction query '.*broken\.agq\.yml'/);
  });

  it('matches top-level fields and properties, then substitutes captures', () => {
    const project = tempProject();
    writeQuery(project, 'order.agq.yml', validQuery);
    const queries = loadExtractionQueries(project);

    const facts = applyExtractionQueries(queries, [graphFact({
      property: 'status',
      valueEnum: 'OrderStatus',
      valueMember: 'Archived',
      previousMember: 'Active',
    })]);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      data: 'Order',
      field: 'status',
      from: 'Active',
      to: 'Archived',
      graphFactId: 'graph-1',
    });
  });

  it('skips facts when the to capture is missing', () => {
    const project = tempProject();
    writeQuery(project, 'order.agq.yml', validQuery);
    const queries = loadExtractionQueries(project);

    const facts = applyExtractionQueries(queries, [graphFact({
      property: 'status',
      valueEnum: 'OrderStatus',
      previousMember: 'Active',
    })]);

    expect(facts).toHaveLength(0);
  });

  it('emits warning-only transition evidence when the from capture is missing', () => {
    const project = tempProject();
    writeQuery(project, 'order.agq.yml', validQuery);
    const queries = loadExtractionQueries(project);

    const facts = applyExtractionQueries(queries, [graphFact({
      property: 'status',
      valueEnum: 'OrderStatus',
      valueMember: 'Archived',
    })]);

    expect(facts).toHaveLength(1);
    expect(facts[0]!.from).toBeUndefined();
    expect(facts[0]!.to).toBe('Archived');
  });

  it('emits query-derived flow facts', () => {
    const project = tempProject();
    writeQuery(project, 'flow.agq.yml', `
id: SharedPersistenceAuthFlow
owner: platform
version: 1
confidence: definite
match:
  kind: di_registration
  service: IAuthTokenValidator
emit:
  kind: flow
  from: "$subject"
  to: SharedAuth
`);
    const queries = loadExtractionQueries(project);

    const facts = applyExtractionQueryFacts(queries, [{
      id: 'graph-2',
      kind: 'di_registration',
      subject: 'SharedPersistence',
      properties: { service: 'IAuthTokenValidator' },
      confidence: 'definite',
      evidence: {
        extractor: 'test',
        strategy: 'graph',
        file: 'Program.cs',
        line: 22,
        message: 'DI registration',
      },
    }]);

    expect(facts.flowFacts).toHaveLength(1);
    expect(facts.flowFacts[0]).toMatchObject({
      from: 'SharedPersistence',
      to: 'SharedAuth',
      graphEvidence: { graphFactId: 'graph-2' },
      query: { id: 'SharedPersistenceAuthFlow' },
    });
  });
});
