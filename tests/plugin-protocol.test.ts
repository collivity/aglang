import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  SubprocessPlugin,
  querySubprocessPluginInfo,
  discoverPlugins,
} from '../src/analyzers/plugin.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { generateDeltaAssertions } from '../src/runtime/delta-assert.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PLUGIN_PATH = path.resolve(__dirname, 'fixtures', 'mock-plugin.mjs');
const ROSLYN_PLUGIN_PATH = path.resolve(process.cwd(), 'plugins', 'aglc-roslyn', 'bin', 'aglc-roslyn.mjs');

// Helper: spawn mock plugin directly (bypass npx for tests)
async function runMockPlugin(args: string[]): Promise<string> {
  return execFileSync(process.execPath, [MOCK_PLUGIN_PATH, ...args], {
    encoding: 'utf8',
  });
}

describe('mock-plugin --info', () => {
  it('returns valid plugin info JSON', async () => {
    const raw = await runMockPlugin(['--info']);
    const info = JSON.parse(raw);
    expect(info.name).toBe('mock-extractor');
    expect(info.extensions).toContain('.mock');
    expect(typeof info.version).toBe('string');
  });
});

describe('@collivity/aglc-roslyn --info', () => {
  it('returns valid plugin info JSON', () => {
    const raw = execFileSync(process.execPath, [ROSLYN_PLUGIN_PATH, '--info'], {
      encoding: 'utf8',
    });
    const info = JSON.parse(raw);
    expect(info.name).toBe('@collivity/aglc-roslyn');
    expect(info.extensions).toEqual(['.cs', '.csx']);
  });
});

describe('mock-plugin --files extraction', () => {
  it('returns FlowFact[] for provided files', async () => {
    const raw = await runMockPlugin([
      '--component', 'MyComponent',
      '--mappings', '{}',
      '--files', '/path/to/foo.mock', '/path/to/bar.mock',
    ]);
    const facts = JSON.parse(raw);
    expect(Array.isArray(facts)).toBe(true);
    expect(facts).toHaveLength(2);
    expect(facts[0].from).toBe('MyComponent');
    expect(facts[0].to).toBe('MockDatabase');
    expect(facts[0].confidence).toBe('definite');
    expect(facts[0].file).toBe('/path/to/foo.mock');
  });

  it('returns empty array when no files given', async () => {
    const raw = await runMockPlugin([
      '--component', 'X',
      '--mappings', '{}',
      '--files',
    ]);
    const facts = JSON.parse(raw);
    expect(Array.isArray(facts)).toBe(true);
    expect(facts).toHaveLength(0);
  });
});

describe('SubprocessPlugin class (direct node invocation via custom executable)', () => {
  // We construct the plugin manually pointing to the mock script via node executable
  // so we don't need npx in the test environment

  class MockSubprocessPlugin extends SubprocessPlugin {
    // Override extract to use `node mock-plugin.mjs` instead of `npx --no <pkg>`
    async extract(input: Parameters<SubprocessPlugin['extract']>[0]) {
      const { spawnSync } = await import('child_process');
      const args = [
        MOCK_PLUGIN_PATH,
        '--component', input.componentName,
        '--mappings', JSON.stringify(input.mappings),
        '--files', ...input.files,
      ];
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`status ${result.status}`);
      return JSON.parse(result.stdout) as ReturnType<typeof JSON.parse>;
    }
  }

  it('extracts flow facts from mock plugin', async () => {
    const plugin = new MockSubprocessPlugin('mock-package', {
      name: 'mock-extractor',
      extensions: ['.mock'],
      version: '1.0.0',
    });
    const facts = await plugin.extract({
      componentName: 'ApiGateway',
      files: ['/src/a.mock'],
      mappings: { ApiGateway: 'src/**/*.mock' },
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].from).toBe('ApiGateway');
    expect(facts[0].confidence).toBe('definite');
  });
});

describe('discoverPlugins graceful degradation', () => {
  it('discovers the local Roslyn plugin by package name', () => {
    const info = querySubprocessPluginInfo('@collivity/aglc-roslyn');
    expect(info.name).toBe('@collivity/aglc-roslyn');
    const result = discoverPlugins(['@collivity/aglc-roslyn']);
    expect(result).toHaveLength(1);
  });

  it('skips plugins that are not installed', () => {
    // 'definitely-not-a-real-package-xyz-999' will fail --info
    const result = discoverPlugins(['definitely-not-a-real-package-xyz-999']);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when no plugins declared', () => {
    const result = discoverPlugins([]);
    expect(result).toHaveLength(0);
  });
});

describe('runtime plugin discovery from artifact declarations', () => {
  it('uses Roslyn plugin facts ahead of local C# extractor facts for the same edge', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aglang-roslyn-plugin-'));
    try {
      const file = path.join(dir, 'OrdersController.cs');
      writeFileSync(file, [
        'using Microsoft.EntityFrameworkCore;',
        'public class OrdersController : ControllerBase {',
        '  private readonly ApplicationDbContext _db;',
        '  public OrdersController(ApplicationDbContext db) { _db = db; }',
        '}',
        '',
      ].join('\n'), 'utf8');

      const source = `
        node node_runtime : server { trust: trusted }
        node relational_db : relational_db { trust: trusted }

        component Api {
          runs_on: node_runtime
          paths: "*.cs"
        }

        plugin "@collivity/aglc-roslyn"
      `;

      const program = parse(tokenize(source));
      expect(check(program)).toEqual([]);
      const artifact = emitArtifact(program, 'roslyn-plugin-test.ag');
      expect(artifact.plugins).toContain('@collivity/aglc-roslyn');

      const delta = await generateDeltaAssertions([
        { componentName: 'Api', files: [file] },
      ], artifact, { projectRoot: dir });

      expect(delta.facts.some(f => f.to === 'relational_db')).toBe(true);
      const relation = delta.facts.find(f => f.to === 'relational_db')!;
      expect(relation.graphEvidence?.extractor).toBe('@collivity/aglc-roslyn');
      expect(relation.graphEvidence?.strategy).toBe('graph');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
