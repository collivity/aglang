import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { installExtractorTemplates } from '../src/runtime/install-extractors.ts';
import { loadExtractionQueries } from '../src/runtime/extraction-query.ts';

describe('installExtractorTemplates', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(name: string): string {
    const dir = join(tmpdir(), `aglang-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  const templatesDir = resolve(import.meta.dirname, '..', 'templates', 'extractors');

  it('throws when the packaged templates directory is missing', () => {
    const target = tempDir('target');
    expect(() => installExtractorTemplates(join(tempDir('missing-source'), 'nope'), target)).toThrow(/templates not found/);
  });

  it('copies all shipped .agq.yml templates into a fresh target directory', () => {
    const target = join(tempDir('project'), '.aglang', 'extractors');

    const result = installExtractorTemplates(templatesDir, target);

    expect(result.installed.sort()).toEqual(['resolved-calls-as-flow.agq.yml', 'resolved-internal-imports-as-flow.agq.yml']);
    expect(result.skipped).toEqual([]);
    for (const name of result.installed) {
      expect(existsSync(join(target, name))).toBe(true);
    }
  });

  it('skips an existing file without --force and reports it as skipped', () => {
    const target = join(tempDir('project'), '.aglang', 'extractors');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'resolved-calls-as-flow.agq.yml'), '# locally edited\n');

    const result = installExtractorTemplates(templatesDir, target, false);

    expect(result.skipped).toContain('resolved-calls-as-flow.agq.yml');
    expect(result.installed).toContain('resolved-internal-imports-as-flow.agq.yml');
    expect(readFileSync(join(target, 'resolved-calls-as-flow.agq.yml'), 'utf8')).toBe('# locally edited\n');
  });

  it('overwrites an existing file when --force is passed', () => {
    const target = join(tempDir('project'), '.aglang', 'extractors');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'resolved-calls-as-flow.agq.yml'), '# locally edited\n');

    const result = installExtractorTemplates(templatesDir, target, true);

    expect(result.installed).toContain('resolved-calls-as-flow.agq.yml');
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(target, 'resolved-calls-as-flow.agq.yml'), 'utf8')).not.toBe('# locally edited\n');
  });

  it('scaffolded templates round-trip through loadExtractionQueries without error', () => {
    const project = tempDir('roundtrip');
    const target = join(project, '.aglang', 'extractors');

    installExtractorTemplates(templatesDir, target);
    const queries = loadExtractionQueries(project);

    expect(queries.map(q => q.id).sort()).toEqual(['ResolvedCallsAsFlow', 'ResolvedInternalImportsAsFlow']);
  });
});
