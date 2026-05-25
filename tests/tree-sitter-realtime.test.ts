import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact, writeArtifact } from '../src/emitters/artifact.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'tree-sitter-realtime.ag');
}

function logStage(label: string, value: unknown): void {
  console.log(`\n[tree-sitter realtime] ${label}`);
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function runCli(args: string[], cwd: string) {
  const cli = resolve(process.cwd(), 'build', 'aglc.js');
  if (!existsSync(cli)) {
    throw new Error(`Built CLI not found at ${cli}. Run npm run build before this test.`);
  }
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const dirs: string[] = [];

describe('tree-sitter realtime indexing pipeline', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = join(tmpdir(), `aglang-tree-sitter-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('re-indexes a rewritten TypeScript file and carries the new fact through graph output and aglang verdicts', () => {
    const dir = tempDir();
    const apiDir = join(dir, 'src', 'api');
    const dataDir = join(dir, 'src', 'data');
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const apiFile = join(apiDir, 'orders.ts');
    const dataFile = join(dataDir, 'store.ts');
    const archFile = join(dir, 'architecture.o');

    writeFileSync(dataFile, `export const store = { findAll: () => [] };\n`, 'utf8');
    writeArtifact(compile(`
      node api_runtime : server { trust: trusted auth: jwt }
      node data_runtime : server { trust: trusted auth: mtls }

      component Api {
        runs_on: api_runtime
        paths: "src/api/**/*.ts"
      }

      component Data {
        runs_on: data_runtime
        paths: "src/data/**/*.ts"
      }

      invariant DataBoundary {
        deny flow Api -> Data
      }
    `), archFile);

    writeFileSync(apiFile, `export const noop = 1;\n`, 'utf8');

    const initialGraph = runCli(['graph', '--arch', archFile, '--file', apiFile, '--json', '--debug-extractors'], dir);
    const initialGraphJson = JSON.parse(initialGraph.stdout);
    const initialCheck = runCli(['check-file', '--arch', archFile, '--file', apiFile, '--json', '--debug-extractors'], dir);
    const initialCheckJson = JSON.parse(initialCheck.stdout);

    logStage('initial.graph.stderr', initialGraph.stderr);
    logStage('initial.graph.stdout', initialGraphJson);
    logStage('initial.check.stderr', initialCheck.stderr);
    logStage('initial.check.stdout', initialCheckJson);

    expect(initialGraph.status).toBe(0);
    expect(initialGraphJson.facts).toHaveLength(0);
    expect(initialGraphJson.projections.flow).toHaveLength(0);
    expect(Array.isArray(initialGraphJson.extractor_debug)).toBe(true);
    expect(initialCheck.status).toBe(0);
    expect(initialCheckJson.passed).toBe(true);
    expect(initialCheckJson.violations).toHaveLength(0);

    writeFileSync(
      apiFile,
      [
        `import { store } from '../data/store';`,
        `export async function readOrders() {`,
        `  return store.findAll();`,
        `}`,
        '',
      ].join('\n'),
      'utf8',
    );

    const updatedGraph = runCli(['graph', '--arch', archFile, '--file', apiFile, '--json', '--debug-extractors'], dir);
    const updatedGraphJson = JSON.parse(updatedGraph.stdout);
    const updatedCheck = runCli(['check-file', '--arch', archFile, '--file', apiFile, '--json', '--debug-extractors'], dir);
    const updatedCheckJson = JSON.parse(updatedCheck.stdout);
    const extractionStrategy = updatedGraphJson.facts[0]!.evidence.strategy;
    const astCaptureEvent = updatedGraphJson.extractor_debug.find(
      (event: { stage: string; message: string }) =>
        event.stage === 'ast_capture_summary' && event.message.includes('Collected 3 AST capture'),
    );

    logStage('updated.graph.stderr', updatedGraph.stderr);
    logStage('updated.graph.stdout', updatedGraphJson);
    logStage('updated.check.stderr', updatedCheck.stderr);
    logStage('updated.check.stdout', updatedCheckJson);
    logStage('updated.strategy', { extractionStrategy });

    expect(updatedGraphJson.facts).toHaveLength(1);
    expect(extractionStrategy).toBe('ast');
    expect(astCaptureEvent).toBeTruthy();
    expect(updatedGraphJson.projections.flow[0]!).toMatchObject({
      from: 'Api',
      to: 'Data',
      confidence: 'definite',
      line: 1,
    });

    expect(updatedCheck.status).toBe(1);
    expect(updatedCheck.stderr).toContain('[aglc] Analyzing');
    expect(updatedCheck.stderr).toContain('[aglc] Detected flows:');
    expect(updatedCheckJson.passed).toBe(false);
    expect(updatedCheckJson.violations[0]!).toMatchObject({
      type: 'flow_violation',
      invariant: 'DataBoundary',
      detected: {
        from: 'Api',
        to: 'Data',
      },
      graph_evidence: {
        strategy: extractionStrategy,
      },
    });

    const strictCheck = runCli(['check-file', '--arch', archFile, '--file', apiFile, '--json', '--debug-extractors', '--require-ast'], dir);
    const strictCheckJson = JSON.parse(strictCheck.stdout);
    logStage('strict.check.stderr', strictCheck.stderr);
    logStage('strict.check.stdout', strictCheckJson);

    expect(strictCheck.status).toBe(1);
    expect(strictCheckJson.passed).toBe(false);
    expect(strictCheckJson.extractor_error).toBeUndefined();
    expect(strictCheckJson.violations[0]!.graph_evidence.strategy).toBe('ast');
  });
});
