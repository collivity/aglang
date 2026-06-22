import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphFact } from '../src/analyzers/plugin.ts';
import { extractTreeSitterIrForFiles } from '../src/analyzers/ast/ir-extractor.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { graphFactToAgIr } from '../src/ir/adapters.ts';
import { agIrEdge, agIrNode, emptyAgIrGraph, mergeAgIrGraphs } from '../src/ir/builders.ts';
import { derivePolicyFactsFromAgIr } from '../src/ir/lowerer.ts';
import { buildProjectSemanticIr } from '../src/ir/semantic-index.ts';
import { validateAgIrGraph } from '../src/ir/validate.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

describe('Ag-IR graph foundation', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = join(tmpdir(), `aglang-ir-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('validates closed node and edge kinds', () => {
    const graph = emptyAgIrGraph();
    const file = agIrNode({ kind: 'file', id: 'file:test.ts', label: 'test.ts' });
    const symbol = agIrNode({ kind: 'symbol', id: 'symbol:mongodb', label: 'mongodb' });
    graph.nodes.push(file, symbol);
    graph.edges.push(agIrEdge({
      kind: 'imports',
      from: file.id,
      to: symbol.id,
      evidence: [{ extractor: 'test', strategy: 'ast', confidence: 'definite' }],
    }));

    expect(validateAgIrGraph(graph)).toEqual({ passed: true, errors: [] });
  });

  it('merges duplicate nodes and edges while preserving evidence', () => {
    const left = graphFactToAgIr(graphFact('fact-1', 'Api', 'postgres'));
    const right = graphFactToAgIr(graphFact('fact-1', 'Api', 'postgres'));
    const merged = mergeAgIrGraphs([left, right]);

    expect(merged.nodes.length).toBe(left.nodes.length);
    expect(merged.edges).toHaveLength(1);
    expect(merged.edges[0]!.evidence).toHaveLength(2);
    expect(validateAgIrGraph(merged).passed).toBe(true);
  });

  it('extracts generic tree-sitter IR from multiple languages', () => {
    const dir = tempDir();
    const tsFile = join(dir, 'orders.ts');
    const goFile = join(dir, 'server.go');
    writeFileSync(tsFile, [
      `import { MongoClient } from 'mongodb';`,
      `const client = new MongoClient();`,
      `app.get('/orders', handler);`,
      '',
    ].join('\n'));
    writeFileSync(goFile, [
      `package main`,
      `import "database/sql"`,
      `func main() { sql.Open("postgres", dsn) }`,
      '',
    ].join('\n'));

    const graph = extractTreeSitterIrForFiles([tsFile, goFile], 'Api');
    const edgeKinds = graph.edges.map(edge => edge.kind);

    expect(edgeKinds).toContain('contains');
    expect(edgeKinds).toContain('imports');
    expect(edgeKinds).toContain('calls');
    expect(edgeKinds).toContain('handles_route');
    expect(graph.edges.some(edge => edge.evidence.some(e => e.language === 'typescript'))).toBe(true);
    expect(graph.edges.some(edge => edge.evidence.some(e => e.language === 'golang'))).toBe(true);
    expect(validateAgIrGraph(graph).passed).toBe(true);
  });

  it('lowers a relative import to a component flow fact', () => {
    const dir = tempDir();
    const apiFile = join(dir, 'src', 'api', 'orders.ts');
    const dataFile = join(dir, 'src', 'data', 'store.ts');
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    mkdirSync(join(dir, 'src', 'data'), { recursive: true });
    writeFileSync(apiFile, `import { store } from '../data/store';\n`);
    writeFileSync(dataFile, `export const store = {};\n`);
    const artifact = compileSpec(`
      node runtime : node_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "src/api/**/*.ts" }
      component Data { runs_on: runtime paths: "src/data/**/*.ts" }
    `);

    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([apiFile], 'Api'),
      extractTreeSitterIrForFiles([dataFile], 'Data'),
    ]);
    for (const edge of graph.edges) {
      if (edge.kind === 'imports') edge.properties = { ...(edge.properties ?? {}), policyFlow: true };
    }
    const lowered = derivePolicyFactsFromAgIr(graph, artifact);

    expect(lowered.flowFacts).toContainEqual(expect.objectContaining({ from: 'Api', to: 'Data' }));
    expect(lowered.unresolvedEdges.some(edge => edge.kind === 'imports')).toBe(false);
  });

  it('lowers a package import to a declared resource target', () => {
    const dir = tempDir();
    const apiFile = join(dir, 'src', 'api', 'orders.ts');
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    writeFileSync(apiFile, `import pg from 'pg';\n`);
    const artifact = compileSpec(`
      node runtime : node_runtime { trust: trusted }
      node orders_db : postgres { trust: trusted }
      component Api { runs_on: runtime paths: "src/api/**/*.ts" }
    `);

    const graph = extractTreeSitterIrForFiles([apiFile], 'Api');
    const lowered = derivePolicyFactsFromAgIr(graph, artifact);

    expect(lowered.flowFacts).toContainEqual(expect.objectContaining({ from: 'Api', to: 'orders_db' }));
  });

  it('reports unresolved imports as warnings without lowering a violation fact', () => {
    const dir = tempDir();
    const apiFile = join(dir, 'src', 'api', 'orders.ts');
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    writeFileSync(apiFile, `import missing from './missing';\n`);
    const artifact = compileSpec(`
      node runtime : node_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "src/api/**/*.ts" }
    `);

    const graph = extractTreeSitterIrForFiles([apiFile], 'Api');
    const lowered = derivePolicyFactsFromAgIr(graph, artifact);

    expect(lowered.flowFacts).toHaveLength(0);
    expect(lowered.warnings.some(warning => warning.message.includes('./missing'))).toBe(true);
  });

  it('emits semantic extends and implements relations resolved across barrels', () => {
    const dir = tempDir();
    const modelsDir = join(dir, 'src', 'models');
    const apiDir = join(dir, 'src', 'api');
    mkdirSync(modelsDir, { recursive: true });
    mkdirSync(apiDir, { recursive: true });
    const baseFile = join(modelsDir, 'base.ts');
    const modelFile = join(modelsDir, 'user.ts');
    const barrelFile = join(modelsDir, 'index.ts');
    const apiFile = join(apiDir, 'handler.ts');
    writeFileSync(baseFile, [
      'export interface Serializable {}',
      'export class BaseModel {}',
      '',
    ].join('\n'));
    writeFileSync(modelFile, [
      "import { BaseModel, Serializable } from './index';",
      'export class User extends BaseModel implements Serializable {}',
      '',
    ].join('\n'));
    writeFileSync(barrelFile, "export * from './base';\nexport { User } from './user';\n");
    writeFileSync(apiFile, "import { User } from '../models';\nconst CurrentUser = User;\n");

    const graph = buildProjectSemanticIr([
      { componentName: 'Models', files: [baseFile, modelFile, barrelFile] },
      { componentName: 'Api', files: [apiFile] },
    ]);

    expect(validateAgIrGraph(graph).passed).toBe(true);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'extends', properties: expect.objectContaining({ baseType: 'BaseModel', resolved: true, targetComponent: 'Models' }) }),
      expect.objectContaining({ kind: 'implements', properties: expect.objectContaining({ interface: 'Serializable', resolved: true, targetComponent: 'Models' }) }),
      expect.objectContaining({ kind: 'alias_of', properties: expect.objectContaining({ local: 'CurrentUser', resolved: true, targetComponent: 'Models' }) }),
    ]));
  });

  it('keeps semantic calls observational until policy-mapped through reviewed evidence', () => {
    const dir = tempDir();
    const apiDir = join(dir, 'src', 'api');
    const dataDir = join(dir, 'src', 'data');
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const apiFile = join(apiDir, 'orders.ts');
    const dataFile = join(dataDir, 'store.ts');
    const barrelFile = join(dataDir, 'index.ts');
    writeFileSync(dataFile, 'export function loadOrder() { return db.order; }\n');
    writeFileSync(barrelFile, "export { loadOrder } from './store';\n");
    writeFileSync(apiFile, "import { loadOrder } from '../data';\nexport function handler() { return loadOrder(); }\n");
    const artifact = compileSpec(`
      node runtime : node_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "src/api/**/*.ts" }
      component Data { runs_on: runtime paths: "src/data/**/*.ts" }
    `);

    const graph = buildProjectSemanticIr([
      { componentName: 'Api', files: [apiFile] },
      { componentName: 'Data', files: [dataFile, barrelFile] },
    ]);
    const observed = derivePolicyFactsFromAgIr(graph, artifact);

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'calls', properties: expect.objectContaining({ function: 'loadOrder', resolved: true, targetComponent: 'Data' }) }),
      expect.objectContaining({ kind: 'returns', properties: expect.objectContaining({ value: 'loadOrder()' }) }),
    ]));
    expect(observed.flowFacts).not.toContainEqual(expect.objectContaining({ from: 'Api', to: 'Data' }));
    expect(observed.unresolvedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'calls', reason: expect.stringContaining('observational') }),
    ]));
    expect(observed.warnings.some(warning => warning.message.includes('not policy-mapped'))).toBe(true);

    for (const edge of graph.edges) {
      if (edge.kind === 'calls' && edge.properties?.function === 'loadOrder') {
        edge.properties = { ...(edge.properties ?? {}), policyFlow: true };
      }
    }
    const lowered = derivePolicyFactsFromAgIr(graph, artifact);

    expect(lowered.flowFacts).toContainEqual(expect.objectContaining({ from: 'Api', to: 'Data' }));
  });

  it('emits assignment, write, and unresolved dynamic import semantic facts conservatively', () => {
    const dir = tempDir();
    const apiFile = join(dir, 'src', 'api', 'orders.ts');
    mkdirSync(join(dir, 'src', 'api'), { recursive: true });
    writeFileSync(apiFile, [
      'if (order.status === OrderStatus.Created) {',
      '  order.status = OrderStatus.Paid;',
      '}',
      'const moduleName = process.env.PLUGIN;',
      'await import(moduleName);',
      '',
    ].join('\n'));

    const graph = buildProjectSemanticIr([{ componentName: 'Api', files: [apiFile] }]);

    expect(validateAgIrGraph(graph).passed).toBe(true);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'assigns', properties: expect.objectContaining({ object: 'order', property: 'status', valueEnum: 'OrderStatus', valueMember: 'Paid', previousMember: 'Created' }) }),
      expect.objectContaining({ kind: 'writes', properties: expect.objectContaining({ object: 'order', property: 'status' }) }),
      expect.objectContaining({ kind: 'imports', properties: expect.objectContaining({ dynamic: true, unresolved: true, expression: 'moduleName' }) }),
    ]));
  });
});

function compileSpec(source: string) {
  const tokens = tokenize(source);
  const program = parse(tokens);
  return emitArtifact(program, 'test-spec.ag');
}

function graphFact(id: string, subject: string, technology: string): GraphFact {
  return {
    id,
    kind: 'accesses_technology',
    subject,
    technology,
    confidence: 'definite',
    evidence: {
      extractor: 'test',
      strategy: 'graph',
      file: 'api.ts',
      line: 1,
      message: `${subject} accesses ${technology}`,
    },
  };
}
