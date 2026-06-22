import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { agIrGraphToExtractionQueryFacts, applyExtractionQueries, applyExtractionQueryFacts, loadExtractionQueries, parseQuery } from '../src/runtime/extraction-query.ts';
import type { GraphFact } from '../src/analyzers/plugin.ts';
import { agIrEdge, agIrId, agIrNode, emptyAgIrGraph } from '../src/ir/builders.ts';
import { installExtractorTemplates } from '../src/runtime/install-extractors.ts';

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

  function graphFact(properties: GraphFact['properties'], subject = 'Orders', kind = 'assignment'): GraphFact {
    return {
      id: 'graph-1',
      kind,
      subject,
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

  it('emits query-derived operation facts', () => {
    const project = tempProject();
    writeQuery(project, 'operation.agq.yml', `
id: SerializationOperations
owner: platform
version: 1
confidence: definite
match:
  kind: call
  method: serialize
emit:
  kind: operation
  operation: serialization
  component: "$subject"
`);
    const queries = loadExtractionQueries(project);

    const facts = applyExtractionQueryFacts(queries, [{
      id: 'graph-3',
      kind: 'call',
      subject: 'Api',
      properties: { method: 'serialize' },
      confidence: 'definite',
      evidence: {
        extractor: 'test',
        strategy: 'graph',
        file: 'api.ts',
        line: 8,
        message: 'serialize call',
      },
    }]);

    expect(facts.operationFacts).toHaveLength(1);
    expect(facts.operationFacts[0]).toMatchObject({
      operation: 'serialization',
      component: 'Api',
      graphFactId: 'graph-3',
      query: { id: 'SerializationOperations' },
    });
  });

  it('matches Ag-IR edge facts with node and edge properties', () => {
    const project = tempProject();
    writeQuery(project, 'ir-flow.agq.yml', `
id: IrImportFlow
owner: platform
version: 1
confidence: definite
match:
  edge: imports
  fromKind: file
  to: "../data/store"
emit:
  kind: flow
  from: "$component"
  to: Data
`);
    const queries = loadExtractionQueries(project);
    const graph = emptyAgIrGraph();
    const component = agIrNode({ kind: 'component', id: agIrId('component', 'Api'), label: 'Api' });
    const file = agIrNode({ kind: 'file', id: agIrId('file', 'api.ts'), label: 'api.ts', properties: { component: 'Api' } });
    const imported = agIrNode({ kind: 'symbol', id: agIrId('symbol', '../data/store'), label: '../data/store' });
    graph.nodes.push(component, file, imported);
    graph.edges.push(
      agIrEdge({ kind: 'contains', from: component.id, to: file.id, evidence: [{ extractor: 'test', strategy: 'ast', confidence: 'definite', span: { file: 'api.ts' } }] }),
      agIrEdge({ kind: 'imports', from: file.id, to: imported.id, properties: { moduleKind: 'relative' }, evidence: [{ extractor: 'test', strategy: 'ast', confidence: 'definite', span: { file: 'api.ts', startLine: 1 }, message: 'import' }] }),
    );

    const facts = applyExtractionQueryFacts(queries, agIrGraphToExtractionQueryFacts(graph));

    expect(facts.flowFacts).toHaveLength(1);
    expect(facts.flowFacts[0]).toMatchObject({
      from: 'Api',
      to: 'Data',
      graphEvidence: { graphFactId: expect.stringContaining('ag-ir:') },
      query: { id: 'IrImportFlow' },
    });
  });

  it('shipped resolved-calls/imports templates promote resolved edges and ignore unresolved ones', () => {
    const project = tempProject();
    installExtractorTemplates(resolve(import.meta.dirname, '..', 'templates', 'extractors'), join(project, '.aglang', 'extractors'));
    const queries = loadExtractionQueries(project);
    expect(queries.map(q => q.id).sort()).toEqual(['ResolvedCallsAsFlow', 'ResolvedInternalImportsAsFlow']);

    const graph = emptyAgIrGraph();
    const api = agIrNode({ kind: 'component', id: agIrId('component', 'OrdersService'), label: 'OrdersService' });
    const apiFile = agIrNode({ kind: 'file', id: agIrId('file', 'orders/service.ts'), label: 'orders/service.ts' });
    const resolvedCallTarget = agIrNode({ kind: 'symbol', id: agIrId('symbol', 'DataAccess.save'), label: 'save' });
    const unresolvedCallTarget = agIrNode({ kind: 'operation', id: agIrId('operation', 'unknownFn'), label: 'unknownFn' });
    const resolvedImportTarget = agIrNode({ kind: 'file', id: agIrId('file', 'data/repo.ts'), label: 'data/repo.ts' });
    const unresolvedImportTarget = agIrNode({ kind: 'symbol', id: agIrId('symbol', 'left-pad'), label: 'left-pad' });
    graph.nodes.push(api, apiFile, resolvedCallTarget, unresolvedCallTarget, resolvedImportTarget, unresolvedImportTarget);

    const ev = (message: string) => [{ extractor: 'test', strategy: 'ast' as const, confidence: 'definite' as const, span: { file: 'orders/service.ts', startLine: 1 }, message }];
    graph.edges.push(
      agIrEdge({ kind: 'contains', from: api.id, to: apiFile.id, evidence: ev('contains') }),
      agIrEdge({ kind: 'calls', from: apiFile.id, to: resolvedCallTarget.id, properties: { resolved: true, targetComponent: 'DataAccess' }, evidence: ev('repo.save(order)') }),
      agIrEdge({ kind: 'calls', from: apiFile.id, to: unresolvedCallTarget.id, properties: { unresolved: true }, evidence: ev('unknownFn()') }),
      agIrEdge({ kind: 'imports', from: apiFile.id, to: resolvedImportTarget.id, properties: { resolved: true, targetComponent: 'DataAccess' }, evidence: ev("import { OrderRepository } from '../data/repo'") }),
      agIrEdge({ kind: 'imports', from: apiFile.id, to: unresolvedImportTarget.id, properties: { moduleKind: 'package' }, evidence: ev("import padStart from 'left-pad'") }),
    );

    const facts = applyExtractionQueryFacts(queries, agIrGraphToExtractionQueryFacts(graph));

    expect(facts.flowFacts).toHaveLength(2);
    expect(facts.flowFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'OrdersService', to: 'DataAccess', query: expect.objectContaining({ id: 'ResolvedCallsAsFlow' }) }),
      expect.objectContaining({ from: 'OrdersService', to: 'DataAccess', query: expect.objectContaining({ id: 'ResolvedInternalImportsAsFlow' }) }),
    ]));
  });

  it('loads the root self-spec extraction queries', () => {
    const queries = loadExtractionQueries(resolve('.'));

    expect(queries.map(query => query.id)).toEqual(expect.arrayContaining([
      'ConsentExampleConsentTransitions',
      'ConsentExampleCartTransitions',
      'StripeExampleOrderTransitions',
      'ConsentExampleReviewedValueFacts',
      'ConsentExampleReviewedOperationEvents',
      'ConsentExampleReviewedEvents',
    ]));
  });

  it('emits lifecycle transition facts only from scoped example components', () => {
    const queries = loadExtractionQueries(resolve('.'));
    const facts = applyExtractionQueryFacts(queries, [
      graphFact({
        property: 'consent',
        valueEnum: 'ConsentStatus',
        previousMember: 'Presented',
        valueMember: 'Accepted',
      }, 'ConsentExampleConsentModule'),
      graphFact({
        property: 'phase',
        valueEnum: 'CartPhase',
        previousMember: 'Empty',
        valueMember: 'SingleItem',
      }, 'ConsentExampleCartModule'),
      graphFact({
        property: 'status',
        valueEnum: 'OrderStatus',
        previousMember: 'Paid',
        valueMember: 'FulfillmentQueued',
      }, 'StripeExampleFulfillmentWorker'),
      graphFact({
        property: 'status',
        valueEnum: 'OrderStatus',
        previousMember: 'Created',
        valueMember: 'Paid',
      }, 'Tests'),
      graphFact({
        property: 'phase',
        valueEnum: 'CartPhase',
        previousMember: 'Empty',
        valueMember: 'MultiItem',
      }, 'GeneratedDocsSite'),
      graphFact({
        property: 'consent',
        valueEnum: 'ConsentStatus',
        valueMember: 'Accepted',
      }, 'ExampleViolationFixtures'),
    ]);

    expect(facts.transitionFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: 'ConsentExampleUserSession', field: 'consent', from: 'Presented', to: 'Accepted' }),
      expect.objectContaining({ data: 'ConsentExampleSharedCart', field: 'phase', from: 'Empty', to: 'SingleItem' }),
      expect.objectContaining({ data: 'StripeOrder', field: 'status', from: 'Paid', to: 'FulfillmentQueued' }),
    ]));
    expect(facts.transitionFacts).toHaveLength(3);
  });

  it('bridges reviewed rich policy graph facts from scoped example components', () => {
    const queries = loadExtractionQueries(resolve('.'));
    const facts = applyExtractionQueryFacts(queries, [
      graphFact({
        dataSubject: 'ConsentExampleSharedCart',
        path: 'items.length',
        relation: '==',
        value: '1',
      }, 'ConsentExampleCartModule', 'value'),
      graphFact({
        operation: 'submitOrder',
        phase: 'before',
        dataSubject: 'ConsentExampleSharedCart',
        path: 'phase',
        relation: '==',
        value: 'SingleItem',
      }, 'ConsentExampleCheckout', 'operation_event'),
      graphFact({
        eventName: 'AcceptConsent',
        scope: 'ConsentExampleUserSession',
      }, 'ConsentExampleConsentModule', 'event'),
      graphFact({
        dataSubject: 'ConsentExampleSharedCart',
        path: 'items.length',
        relation: '==',
        value: '2',
      }, 'Tests', 'value'),
    ]);

    expect(facts.valueFacts).toHaveLength(1);
    expect(facts.valueFacts[0]).toMatchObject({
      subject: 'ConsentExampleSharedCart',
      path: ['items', 'length'],
      relation: '==',
      value: '1',
    });
    expect(facts.operationEventFacts).toHaveLength(1);
    expect(facts.operationEventFacts[0]).toMatchObject({
      operation: 'submitOrder',
      phase: 'before',
      subject: 'ConsentExampleSharedCart',
      path: ['phase'],
      value: 'SingleItem',
    });
    expect(facts.eventFacts).toHaveLength(1);
    expect(facts.eventFacts[0]).toMatchObject({
      event: 'AcceptConsent',
      scope: 'ConsentExampleUserSession',
    });
  });

  it('preserves numericValue when a value capture is a bare "$capture" of a JS number', () => {
    const query = parseQuery({
      id: 'NumericCapture',
      owner: 'test',
      version: 1,
      confidence: 'definite',
      match: { kind: 'value' },
      emit: { kind: 'value', subject: '$subject', path: '$path', relation: '$relation', value: '$value' },
    }, 'inline.agq.yml');
    const facts = applyExtractionQueryFacts([query], [
      graphFact({ subject: 'Order', path: 'total', relation: '<=', value: 1000 }, 'Tests', 'value'),
    ]);
    expect(facts.valueFacts).toHaveLength(1);
    expect(facts.valueFacts[0]!.value).toBe('1000');
    expect(facts.valueFacts[0]!.numericValue).toBe(1000);
  });

  it('does not set numericValue when the value capture is embedded in surrounding text', () => {
    const query = parseQuery({
      id: 'TemplatedCapture',
      owner: 'test',
      version: 1,
      confidence: 'definite',
      match: { kind: 'value' },
      emit: { kind: 'value', subject: '$subject', path: '$path', relation: '$relation', value: 'observed:$value' },
    }, 'inline.agq.yml');
    const facts = applyExtractionQueryFacts([query], [
      graphFact({ subject: 'Order', path: 'total', relation: '<=', value: 1000 }, 'Tests', 'value'),
    ]);
    expect(facts.valueFacts).toHaveLength(1);
    expect(facts.valueFacts[0]!.value).toBe('observed:1000');
    expect(facts.valueFacts[0]!.numericValue).toBeUndefined();
  });

  it('does not set numericValue when the captured property is already a non-numeric string', () => {
    const query = parseQuery({
      id: 'StringCapture',
      owner: 'test',
      version: 1,
      confidence: 'definite',
      match: { kind: 'value' },
      emit: { kind: 'value', subject: '$subject', path: '$path', relation: '$relation', value: '$value' },
    }, 'inline.agq.yml');
    const facts = applyExtractionQueryFacts([query], [
      graphFact({ subject: 'Cart', path: 'phase', relation: '==', value: 'SingleItem' }, 'Tests', 'value'),
    ]);
    expect(facts.valueFacts).toHaveLength(1);
    expect(facts.valueFacts[0]!.value).toBe('SingleItem');
    expect(facts.valueFacts[0]!.numericValue).toBeUndefined();
  });
});
