import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SubprocessPlugin,
  querySubprocessPluginInfo,
  discoverPlugins,
} from '../src/analyzers/plugin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PLUGIN_PATH = path.resolve(__dirname, 'fixtures', 'mock-plugin.mjs');

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
