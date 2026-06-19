import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { parseProjectFiles } from '../src/runtime/diff-parser.ts';
import { generateDeltaAssertions } from '../src/runtime/delta-assert.ts';
import { runGate } from '../src/runtime/gate.ts';
import { validateAgIrGraph } from '../src/ir/validate.ts';

function compileSpec(source: string) {
  const tokens = tokenize(source);
  const program = parse(tokens);
  return emitArtifact(program, 'test-spec.ag');
}

describe('project-wide check file discovery', () => {
  it('maps all component files from architecture.o without staged git changes', () => {
    const tmpDir = join(tmpdir(), `aglang-all-check-${Date.now()}`);
    mkdirSync(join(tmpDir, 'src', 'cli'), { recursive: true });
    mkdirSync(join(tmpDir, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'cli', 'index.ts'), 'export const cli = true;\n');
    writeFileSync(join(tmpDir, 'src', 'runtime', 'gate.ts'), 'export const gate = true;\n');
    writeFileSync(join(tmpDir, 'README.md'), '# ignored\n');

    try {
      const artifact = compileSpec(`
        node n : node_runtime { trust: trusted }
        component CliCompiler { runs_on: n paths: "src/cli/**/*.ts" }
        component RuntimeGate { runs_on: n paths: "src/runtime/**/*.ts" }
      `);

      const changed = parseProjectFiles(tmpDir, artifact);
      const byComponent = new Map(changed.map(c => [c.componentName, c.files]));

      expect(byComponent.get('CliCompiler')).toHaveLength(1);
      expect(byComponent.get('RuntimeGate')).toHaveLength(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('builds Ag-IR and runs the Z3 gate for a whole-project scan', async () => {
    const tmpDir = join(tmpdir(), `aglang-ir-z3-all-${Date.now()}`);
    mkdirSync(join(tmpDir, 'src', 'api'), { recursive: true });
    mkdirSync(join(tmpDir, 'src', 'data'), { recursive: true });
    const apiFile = join(tmpDir, 'src', 'api', 'orders.ts');
    const dataFile = join(tmpDir, 'src', 'data', 'store.ts');
    writeFileSync(dataFile, `export const store = { findAll: () => [] };\n`);
    writeFileSync(apiFile, [
      `import { store } from '../data/store';`,
      `export function readOrders() {`,
      `  return store.findAll();`,
      `}`,
      '',
    ].join('\n'));

    try {
      const artifact = compileSpec(`
        node runtime : node_runtime { trust: trusted }
        component Api { runs_on: runtime paths: "src/api/**/*.ts" }
        component Data { runs_on: runtime paths: "src/data/**/*.ts" }
        invariant DataBoundary { deny flow Api -> Data }
      `);

      const changed = parseProjectFiles(tmpDir, artifact);
      const delta = await generateDeltaAssertions(changed, artifact, { projectRoot: tmpDir, requireAst: true });
      const verdict = await runGate(artifact, delta);

      expect(changed.map(component => component.componentName).sort()).toEqual(['Api', 'Data']);
      expect(validateAgIrGraph(delta.irGraph).passed).toBe(true);
      expect(delta.irGraph.nodes.some(node => node.kind === 'component' && node.label === 'Api')).toBe(true);
      expect(delta.irGraph.edges.some(edge => edge.kind === 'contains')).toBe(true);
      expect(delta.irGraph.edges.some(edge => edge.kind === 'imports')).toBe(true);
      expect(delta.graphFacts.some(fact => fact.evidence.strategy === 'ast')).toBe(true);
      expect(verdict.passed).toBe(false);
      expect(verdict.violations[0]!).toMatchObject({
        type: 'flow_violation',
        invariant: 'DataBoundary',
        detected: {
          from: 'Api',
          to: 'Data',
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
