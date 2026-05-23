import { describe, it, expect } from 'vitest';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { projectGraphToFlows } from '../src/runtime/graph-projection.ts';
import { generateDeltaAssertions } from '../src/runtime/delta-assert.ts';
import { runGate } from '../src/runtime/gate.ts';
import type { ExtractorPlugin, GraphFact } from '../src/analyzers/plugin.ts';

function compileSpec(source: string) {
  const tokens = tokenize(source);
  const program = parse(tokens);
  return emitArtifact(program, 'test-spec.ag');
}

function graphFact(overrides: Partial<GraphFact> = {}): GraphFact {
  return {
    id: 'fact-1',
    kind: 'accesses_technology',
    subject: 'ApiControllers',
    technology: 'postgres',
    confidence: 'definite',
    evidence: {
      extractor: 'test-graph',
      file: 'Controller.cs',
      line: 7,
      message: 'Npgsql connection detected',
    },
    ...overrides,
  };
}

describe('graph to flow projection', () => {
  it('resolves accesses_technology(ApiControllers, postgres) to Flow(ApiControllers, postgres_db)', () => {
    const artifact = compileSpec(`
      node postgres_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "web/api/Controllers/**/*.cs" }
    `);

    const result = projectGraphToFlows([graphFact()], artifact);

    expect(result.flowFacts).toHaveLength(1);
    expect(result.flowFacts[0]!.from).toBe('ApiControllers');
    expect(result.flowFacts[0]!.to).toBe('postgres_db');
  });

  it('projects one graph fact to multiple concrete nodes when the technology matches multiple nodes', () => {
    const artifact = compileSpec(`
      node primary_db : postgres { trust: trusted }
      node analytics_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "web/api/Controllers/**/*.cs" }
    `);

    const result = projectGraphToFlows([graphFact()], artifact);
    const targets = result.flowFacts.map(f => f.to).sort();

    expect(targets).toEqual(['analytics_db', 'primary_db']);
  });

  it('treats probable facts as warnings outside strict mode', () => {
    const artifact = compileSpec(`
      node postgres_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "web/api/Controllers/**/*.cs" }
    `);

    const result = projectGraphToFlows([graphFact({ confidence: 'probable' })], artifact);

    expect(result.blockingFacts).toHaveLength(0);
    expect(result.warningFacts).toHaveLength(1);
    expect(result.smtAssertions.filter(s => s.startsWith('(assert'))).toHaveLength(0);
  });

  it('emits SMT assertions for definite projected facts', () => {
    const artifact = compileSpec(`
      node postgres_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "web/api/Controllers/**/*.cs" }
    `);

    const result = projectGraphToFlows([graphFact()], artifact);

    expect(result.blockingFacts).toHaveLength(1);
    expect(result.smtAssertions).toContain('(assert (Flow ApiControllers postgres_db))');
  });

  it('resolves technology facts to declared resources before nodes', () => {
    const artifact = compileSpec(`
      node ios : edge_mobile { trust: semi_trusted }
      resource SecureStorage : secure_storage { trust: trusted }
      component HomeScreen {
        runs_on: ios
        paths: "**/*.swift"
        role: presentation
      }
    `);

    const result = projectGraphToFlows([
      graphFact({ subject: 'HomeScreen', technology: 'secure_storage', evidence: { file: 'Home.swift', message: 'Keychain access' } }),
    ], artifact);

    expect(result.flowFacts).toHaveLength(1);
    expect(result.flowFacts[0]!.to).toBe('SecureStorage');
  });

  it('blocks selector-expanded role to resource invariants', async () => {
    const artifact = compileSpec(`
      node ios : edge_mobile { trust: semi_trusted }
      resource SecureStorage : secure_storage { trust: trusted }
      component HomeScreen {
        runs_on: ios
        paths: "**/*.swift"
        role: presentation
      }
      invariant StrictBoundaries {
        deny flow role presentation -> resource secure_storage
      }
    `);
    const fact = graphFact({
      subject: 'HomeScreen',
      technology: 'secure_storage',
      evidence: { extractor: 'swift', file: 'HomeViewController.swift', message: 'Keychain access' },
    });
    const projection = projectGraphToFlows([fact], artifact);
    const verdict = await runGate(artifact, {
      facts: projection.flowFacts,
      graphFacts: [fact],
      blockingFacts: projection.blockingFacts,
      warningFacts: projection.warningFacts,
      smtAssertions: projection.smtAssertions,
      factSmtMap: projection.factSmtMap,
      graphReport: {
        facts: [fact],
        projections: { flow: projection.flowFacts },
        smt: { assertions: projection.smtAssertions },
        unresolvedTargets: projection.unresolvedTargets,
        warnings: projection.warnings,
      },
      unresolvedTargets: projection.unresolvedTargets,
      graphWarnings: projection.warnings,
      cacheHits: 0,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.detected).toMatchObject({ from: 'HomeScreen', to: 'SecureStorage' });
  });

  it('preserves graph evidence in flow violation diagnostics', async () => {
    const artifact = compileSpec(`
      node postgres_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "web/api/Controllers/**/*.cs" }
      invariant LayeredBackend {
        deny flow ApiControllers -> postgres_db
      }
    `);

    const projection = projectGraphToFlows([graphFact()], artifact);
    const verdict = await runGate(artifact, {
      facts: projection.flowFacts,
      graphFacts: [graphFact()],
      blockingFacts: projection.blockingFacts,
      warningFacts: projection.warningFacts,
      smtAssertions: projection.smtAssertions,
      factSmtMap: projection.factSmtMap,
      graphReport: {
        facts: [graphFact()],
        projections: { flow: projection.flowFacts },
        smt: { assertions: projection.smtAssertions },
        unresolvedTargets: projection.unresolvedTargets,
        warnings: projection.warnings,
      },
      unresolvedTargets: projection.unresolvedTargets,
      graphWarnings: projection.warnings,
      cacheHits: 0,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.graph_evidence?.graphFactId).toBe('fact-1');
    expect(verdict.violations[0]!.graph_evidence?.extractor).toBe('test-graph');
  });
});

describe('graph-backed extractor path', () => {
  it('produces the same flow verdict shape as the legacy extractor path', async () => {
    const artifact = compileSpec(`
      node postgres_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "**/*.mock" }
      invariant LayeredBackend {
        deny flow ApiControllers -> postgres_db
      }
    `);

    const plugin: ExtractorPlugin = {
      name: 'graph-mock',
      extensions: ['.mock'],
      extract: () => [],
      extractGraph: () => [graphFact({ id: 'graph-mock-1', evidence: { extractor: 'graph-mock', file: 'x.mock', message: 'postgres client' } })],
    };

    const delta = await generateDeltaAssertions(
      [{ componentName: 'ApiControllers', files: ['x.mock'] }],
      artifact,
      { plugins: [plugin] },
    );
    const verdict = await runGate(artifact, delta);

    expect(delta.graphFacts).toHaveLength(1);
    expect(delta.facts[0]!.to).toBe('postgres_db');
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.detected.from).toBe('ApiControllers');
    expect(verdict.violations[0]!.detected.to).toBe('postgres_db');
  });

  it('graph report includes facts, flow projections, SMT assertions, unresolved targets, and warnings', async () => {
    const artifact = compileSpec(`
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "**/*.mock" }
    `);
    const plugin: ExtractorPlugin = {
      name: 'graph-mock',
      extensions: ['.mock'],
      extract: () => [],
      extractGraph: () => [graphFact({ technology: 'postgres' })],
    };

    const delta = await generateDeltaAssertions(
      [{ componentName: 'ApiControllers', files: ['x.mock'] }],
      artifact,
      { plugins: [plugin] },
    );

    expect(delta.graphReport.facts).toHaveLength(1);
    expect(delta.graphReport.projections.flow).toHaveLength(0);
    expect(delta.graphReport.smt.assertions).toEqual(delta.smtAssertions);
    expect(delta.graphReport.unresolvedTargets).toContain('postgres');
    expect(delta.graphReport.warnings[0]!.message).toContain('Could not resolve');
  });

  it('graph report preserves legacy extractor strategy metadata', async () => {
    const artifact = compileSpec(`
      node postgres_db : postgres { trust: trusted }
      node api_backend : server { trust: trusted }
      component ApiControllers { runs_on: api_backend paths: "**/*.mock" }
    `);
    const plugin: ExtractorPlugin = {
      name: 'mock regex analyzer',
      extensions: ['.mock'],
      extract: () => [{
        from: 'ApiControllers',
        to: 'postgres',
        confidence: 'definite',
        evidence: 'postgres client',
        file: 'x.mock',
        strategy: 'regex',
      }],
    };

    const delta = await generateDeltaAssertions(
      [{ componentName: 'ApiControllers', files: ['x.mock'] }],
      artifact,
      { plugins: [plugin] },
    );

    expect(delta.graphReport.facts[0]!.evidence.strategy).toBe('regex');
    expect(delta.graphReport.projections.flow[0]!.graphEvidence?.strategy).toBe('regex');
  });
});
