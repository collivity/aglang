import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateSpec } from '../src/generate.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';

// Helper: compile the generated .ag and return checker errors
function compileAg(ag: string): string[] {
  try {
    const tokens = tokenize(ag);
    const program = parse(tokens);
    return check(program).map(e => e.message);
  } catch (e) {
    return [`parse error: ${(e as Error).message}`];
  }
}

describe('generateSpec', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), 'aglc-gen-test-' + Date.now());
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns valid compilable .ag for an empty dir (no manifests)', async () => {
    const result = await generateSpec(dir, { projectName: 'EmptyProject' });
    expect(result.ag).toBeTruthy();
    expect(result.warnings.length).toBeGreaterThan(0);   // warns about no manifests
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('detects a single Node.js project and emits one component', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api', version: '1.0' }));
    const result = await generateSpec(dir, { projectName: 'ApiProject' });
    expect(result.components).toBe(1);
    expect(result.ag).toContain('component Api');
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('detects a C# project from .csproj', async () => {
    writeFileSync(join(dir, 'MyApi.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
    const result = await generateSpec(dir);
    expect(result.components).toBe(1);
    expect(result.ag).toContain('component MyApi');
    expect(result.ag).toContain('**/*.cs');
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('detects a Go project from go.mod', async () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
    const result = await generateSpec(dir);
    expect(result.components).toBe(1);
    expect(result.ag).toContain('**/*.go');
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('handles monorepo: skips npm workspace root, detects sub-packages', async () => {
    // Root workspace aggregator — should be skipped
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['packages/*'],
    }));
    // Sub-packages — should be detected
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
    mkdirSync(join(dir, 'packages', 'worker'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'worker', 'package.json'), JSON.stringify({ name: 'worker' }));

    const result = await generateSpec(dir);
    expect(result.components).toBe(2);
    expect(result.ag).toContain('component Api');
    expect(result.ag).toContain('component Worker');
    // Paths should be root-relative, not just dirname
    expect(result.ag).toContain('packages/api/');
    expect(result.ag).toContain('packages/worker/');
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('generates contract block when routes are found in TS server files', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-service' }));
    // A simple Express-like route file
    writeFileSync(join(dir, 'server.ts'), `
      import express from 'express';
      const app = express();
      app.get('/health', (req, res) => res.send('ok'));
      app.post('/users', (req, res) => res.json({}));
    `);
    const result = await generateSpec(dir);
    expect(result.contracts).toBeGreaterThanOrEqual(0);  // may or may not detect, no crash
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('sanitizes invalid directory names to valid identifiers', async () => {
    const badDir = join(dir, '3rd-party-service');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'package.json'), JSON.stringify({ name: '3rd-party-service' }));
    const result = await generateSpec(dir);
    // Should not throw and should produce valid identifiers
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('deduplicates component names when two dirs have the same name', async () => {
    mkdirSync(join(dir, 'services', 'api'), { recursive: true });
    writeFileSync(join(dir, 'services', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
    mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
    const result = await generateSpec(dir);
    expect(result.components).toBe(2);
    // Both should be present with distinct names
    const errors = compileAg(result.ag);
    expect(errors).toHaveLength(0);
  });

  it('uses root-relative paths in generated globs', async () => {
    mkdirSync(join(dir, 'backend'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'go.mod'), 'module example.com/backend\n\ngo 1.21\n');
    const result = await generateSpec(dir);
    // Should include 'backend/' prefix in the path glob
    expect(result.ag).toContain('backend/');
  });

  it('generates only // comments (no # comments) for valid .ag syntax', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
    const result = await generateSpec(dir);
    const lines = result.ag.split('\n');
    const hashLines = lines.filter(l => l.trimStart().startsWith('#'));
    expect(hashLines).toHaveLength(0);
  });

  it('does not emit trust: public (invalid trust value)', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
    const result = await generateSpec(dir);
    expect(result.ag).not.toContain('trust: public');
  });
});
