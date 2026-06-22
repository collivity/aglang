import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import {
  loadExtractionQueryFile,
  normalizeFixtureFacts,
  traceExtractionQueries,
} from '../src/runtime/extraction-query.ts';

describe('aglc query-test building blocks', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = join(tmpdir(), `aglang-query-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  const flowQuery = `
id: ResolvedCallsAsFlowTest
owner: test
version: 1
confidence: probable
match:
  kind: calls
  resolved: true
emit:
  kind: flow
  from: "$component"
  to: "$targetComponent"
`;

  it('loads and parses a single query file', () => {
    const dir = tempDir();
    const file = join(dir, 'q.agq.yml');
    writeFileSync(file, flowQuery);
    const query = loadExtractionQueryFile(file);
    expect(query.id).toBe('ResolvedCallsAsFlowTest');
    expect(query.emit.kind).toBe('flow');
  });

  it('rejects a malformed query file with a clear error', () => {
    const dir = tempDir();
    const file = join(dir, 'bad.agq.yml');
    writeFileSync(file, 'id: NoOwnerOrEmit\nversion: 1\n');
    expect(() => loadExtractionQueryFile(file)).toThrow(/missing owner/);
  });

  it('normalizes a minimal fixture entry into a full GraphFact with defaults', () => {
    const facts = normalizeFixtureFacts(
      [{ kind: 'calls', properties: { resolved: true, component: 'Api', targetComponent: 'Data' } }],
      'fixture.yml',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      id: 'fixture-0',
      kind: 'calls',
      subject: 'FixtureSubject',
      confidence: 'definite',
      properties: { resolved: true, component: 'Api', targetComponent: 'Data' },
    });
    expect(facts[0].evidence.extractor).toBe('query-test');
  });

  it('rejects a fixture that is not an array', () => {
    expect(() => normalizeFixtureFacts({ kind: 'calls' }, 'fixture.yml')).toThrow(/must be an array/);
  });

  it('rejects a fixture entry missing kind', () => {
    expect(() => normalizeFixtureFacts([{ properties: {} }], 'fixture.yml')).toThrow(/missing kind/);
  });

  it('traces a fixture fact that matches and emits cleanly', () => {
    const dir = tempDir();
    const file = join(dir, 'q.agq.yml');
    writeFileSync(file, flowQuery);
    const query = loadExtractionQueryFile(file);
    const facts = normalizeFixtureFacts(
      [{ kind: 'calls', properties: { resolved: true, component: 'ApiControllers', targetComponent: 'DataLayer' } }],
      'fixture.yml',
    );
    const [trace] = traceExtractionQueries([query], facts);
    expect(trace.matched).toBe(true);
    expect(trace.emitted).toEqual({ kind: 'flow', id: `${query.id}:${facts[0].id}` });
    expect(trace.substitutions).toEqual({ from: 'ApiControllers', to: 'DataLayer' });
  });

  it('traces a fixture fact that matches but is missing a captured property', () => {
    const dir = tempDir();
    const file = join(dir, 'q.agq.yml');
    writeFileSync(file, flowQuery);
    const query = loadExtractionQueryFile(file);
    const facts = normalizeFixtureFacts(
      [{ kind: 'calls', properties: { resolved: true, component: 'ApiControllers' } }],
      'fixture.yml',
    );
    const [trace] = traceExtractionQueries([query], facts);
    expect(trace.matched).toBe(true);
    expect(trace.emitted).toBeUndefined();
    expect(trace.skipped_reason).toBe('missing capture(s): targetComponent');
  });

  it('traces a fixture fact that does not match the query at all', () => {
    const dir = tempDir();
    const file = join(dir, 'q.agq.yml');
    writeFileSync(file, flowQuery);
    const query = loadExtractionQueryFile(file);
    const facts = normalizeFixtureFacts([{ kind: 'calls', properties: { resolved: false } }], 'fixture.yml');
    const [trace] = traceExtractionQueries([query], facts);
    expect(trace.matched).toBe(false);
    expect(trace.skipped_reason).toBe('match criteria did not match graph fact');
  });
});

describe('aglc query-test CLI end-to-end', () => {
  const dirs: string[] = [];
  const CLI = resolve(import.meta.dirname, '..', 'build', 'aglc.js');

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = join(tmpdir(), `aglang-query-test-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  it('runs end-to-end against a real template query and reports match/skip counts', () => {
    const dir = tempDir();
    const queryFile = join(dir, 'q.agq.yml');
    writeFileSync(
      queryFile,
      `
id: CliFlowTest
owner: test
version: 1
confidence: probable
match:
  kind: calls
  resolved: true
emit:
  kind: flow
  from: "$component"
  to: "$targetComponent"
`,
    );
    const fixtureFile = join(dir, 'facts.yml');
    writeFileSync(
      fixtureFile,
      `
- kind: calls
  properties:
    resolved: true
    component: ApiControllers
    targetComponent: DataLayer
- kind: calls
  properties:
    resolved: false
`,
    );
    const result = spawnSync(process.execPath, [CLI, 'query-test', '--query', queryFile, '--fixture', fixtureFile], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('matched, emits flow');
    expect(result.stdout).toContain('1/2 fixture fact(s) matched and emitted.');
  });

  it('scaffolds a starter fixture with --init-fixture', () => {
    const dir = tempDir();
    const queryFile = join(dir, 'q.agq.yml');
    writeFileSync(
      queryFile,
      `
id: InitFixtureTest
owner: test
version: 1
confidence: probable
match:
  kind: calls
  resolved: true
emit:
  kind: flow
  from: "$component"
  to: "$targetComponent"
`,
    );
    const result = spawnSync(process.execPath, [CLI, 'query-test', '--query', queryFile, '--init-fixture'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kind: calls');
    expect(result.stdout).toContain('resolved: true');
  });
});
