import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ExtractionCache, extractWithCache, hashContent, hashArtifact } from '../src/runtime/extraction-cache.ts';
import type { FlowFact } from '../src/analyzers/plugin.ts';

const fakeFact = (file: string): FlowFact => ({
  from: 'Api', to: 'Db', confidence: 'definite',
  evidence: 'direct db call', file,
});

describe('ExtractionCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), 'aglc-cache-test-' + Date.now());
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it('starts empty and returns undefined for unknown hashes', () => {
    const cache = new ExtractionCache(join(dir, '.aglang-cache', 'extraction.json'), 'abc123');
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves facts by file hash', () => {
    const cache = new ExtractionCache(join(dir, '.aglang-cache', 'extraction.json'), 'abc123');
    const facts = [fakeFact('/tmp/x.cs')];
    cache.set('hash1', facts);
    expect(cache.get('hash1')).toEqual(facts);
  });

  it('flushes to disk and reloads on construction', () => {
    const cacheFile = join(dir, '.aglang-cache', 'extraction.json');
    const cache1 = new ExtractionCache(cacheFile, 'abc123');
    cache1.set('hash1', [fakeFact('/tmp/x.cs')]);
    cache1.flush();

    expect(existsSync(cacheFile)).toBe(true);

    const cache2 = new ExtractionCache(cacheFile, 'abc123');
    expect(cache2.get('hash1')).toEqual([fakeFact('/tmp/x.cs')]);
  });

  it('discards stale cache when artifact hash changes', () => {
    const cacheFile = join(dir, '.aglang-cache', 'extraction.json');
    const cache1 = new ExtractionCache(cacheFile, 'artifact-v1');
    cache1.set('hash1', [fakeFact('/tmp/x.cs')]);
    cache1.flush();

    // Different artifact hash → cache should be empty
    const cache2 = new ExtractionCache(cacheFile, 'artifact-v2');
    expect(cache2.get('hash1')).toBeUndefined();
  });

  it('forProject() creates cache at expected path', () => {
    const cache = ExtractionCache.forProject(dir, 'abc123');
    cache.set('h', []);
    cache.flush();
    expect(existsSync(join(dir, '.aglang-cache', 'extraction.json'))).toBe(true);
  });
});

describe('hashContent / hashArtifact', () => {
  it('produces a stable 64-char hex hash for the same content', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('produces different hashes for different content', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  it('hashArtifact produces 64-char hex string', () => {
    expect(hashArtifact('{"schema":1}')).toHaveLength(64);
  });
});

describe('extractWithCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), 'aglc-ewc-test-' + Date.now());
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it('calls plugin for uncached files', async () => {
    const file = join(dir, 'foo.cs');
    writeFileSync(file, 'content here');
    let callCount = 0;

    const result = await extractWithCache(null, [file], async (files) => {
      callCount++;
      return files.map(f => fakeFact(f));
    });

    expect(callCount).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe(file);
  });

  it('uses cache on second call and skips plugin', async () => {
    const file = join(dir, 'bar.cs');
    writeFileSync(file, 'cached content');
    const cacheFile = join(dir, '.aglang-cache', 'extraction.json');
    const cache = new ExtractionCache(cacheFile, 'v1');

    let callCount = 0;
    const run = async (files: string[]) => {
      callCount++;
      return files.map(f => fakeFact(f));
    };

    // First call — populates cache
    await extractWithCache(cache, [file], run);
    cache.flush();
    expect(callCount).toBe(1);

    // Second call — should hit cache, plugin not called
    const cache2 = new ExtractionCache(cacheFile, 'v1');
    const result2 = await extractWithCache(cache2, [file], run);
    expect(callCount).toBe(1);  // still 1
    expect(result2).toHaveLength(1);
  });

  it('re-runs plugin when file content changes', async () => {
    const file = join(dir, 'baz.cs');
    writeFileSync(file, 'version 1');
    const cacheFile = join(dir, '.aglang-cache', 'extraction.json');
    const cache1 = new ExtractionCache(cacheFile, 'v1');

    let callCount = 0;
    const run = async (files: string[]) => {
      callCount++;
      return files.map(f => fakeFact(f));
    };

    await extractWithCache(cache1, [file], run);
    cache1.flush();

    // Mutate the file — hash changes
    writeFileSync(file, 'version 2 changed content');
    const cache2 = new ExtractionCache(cacheFile, 'v1');
    await extractWithCache(cache2, [file], run);
    expect(callCount).toBe(2);  // plugin called again
  });
});
