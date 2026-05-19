// Extraction result cache — avoids re-extracting files whose content hasn't changed.
//
// Cache key per entry: sha256 of the file's UTF-8 content
// Cache store:         .aglang-cache/extraction.json in the project root
// Invalidation:        entire cache is discarded when architecture.o changes
//                      (detected via sha256 of the artifact JSON)
//
// Because extractor plugins are batch-oriented (one call per extension group),
// we split each batch into cached + uncached files, run the plugin on uncached
// only, then group output facts by their `file` field to store per-file.

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { FlowFact } from '../analyzers/plugin.ts';

const CACHE_VERSION = 1;

interface CacheStore {
  version: number;
  artifactHash: string;
  entries: Record<string, FlowFact[]>;  // sha256(fileContent) → FlowFact[]
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hashArtifact(artifactJson: string): string {
  return createHash('sha256').update(artifactJson).digest('hex');
}

export class ExtractionCache {
  private store: CacheStore;
  private dirty = false;

  constructor(
    private readonly cacheFile: string,
    artifactHash: string,
  ) {
    this.store = this.load(artifactHash);
  }

  static forProject(projectRoot: string, artifactHash: string): ExtractionCache {
    const cacheFile = join(projectRoot, '.aglang-cache', 'extraction.json');
    return new ExtractionCache(cacheFile, artifactHash);
  }

  private load(artifactHash: string): CacheStore {
    try {
      if (existsSync(this.cacheFile)) {
        const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as CacheStore;
        if (raw.version === CACHE_VERSION && raw.artifactHash === artifactHash) {
          return raw;
        }
        // Artifact changed or cache version bumped — discard stale entries
      }
    } catch {
      // corrupt or missing — start fresh
    }
    return { version: CACHE_VERSION, artifactHash, entries: {} };
  }

  /** Return cached facts for a file identified by its content hash, or undefined if not cached. */
  get(fileHash: string): FlowFact[] | undefined {
    return this.store.entries[fileHash];
  }

  /** Store facts for a file identified by its content hash. */
  set(fileHash: string, facts: FlowFact[]): void {
    this.store.entries[fileHash] = facts;
    this.dirty = true;
  }

  /** Write cache to disk. Non-fatal — failure just means next run re-extracts. */
  flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.store), 'utf8');
    } catch {
      // swallow — cache write failure is non-fatal
    }
    this.dirty = false;
  }
}

/**
 * Run an extractor plugin with caching.
 *
 * Steps:
 * 1. Read each file and compute its hash.
 * 2. Split into cached (facts already known) and uncached files.
 * 3. Run the plugin on uncached files only.
 * 4. Group new facts by their `file` field and store per-file in cache.
 * 5. Return the union of cached + new facts.
 */
export async function extractWithCache(
  cache: ExtractionCache | null,
  files: string[],
  run: (uncachedFiles: string[]) => Promise<FlowFact[]> | FlowFact[],
): Promise<FlowFact[]> {
  if (!cache) {
    // No cache — run plugin on all files
    return run(files);
  }

  const cachedFacts: FlowFact[] = [];
  const uncachedFiles: string[] = [];
  const hashByFile = new Map<string, string>();

  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;  // unreadable — skip
    }
    const hash = hashContent(content);
    hashByFile.set(f, hash);
    const cached = cache.get(hash);
    if (cached !== undefined) {
      cachedFacts.push(...cached);
    } else {
      uncachedFiles.push(f);
    }
  }

  if (uncachedFiles.length === 0) {
    return cachedFacts;
  }

  // Run plugin on uncached files
  const newFacts = await run(uncachedFiles);

  // Group new facts by file so we can cache per-file
  const factsByFile = new Map<string, FlowFact[]>();
  for (const f of uncachedFiles) factsByFile.set(f, []);
  for (const fact of newFacts) {
    const bucket = factsByFile.get(fact.file);
    if (bucket) bucket.push(fact);
    // Facts whose `file` doesn't match an uncached file are not cached (edge case)
  }

  // Store each file's facts in cache
  for (const [f, facts] of factsByFile) {
    const hash = hashByFile.get(f);
    if (hash) cache.set(hash, facts);
  }

  return [...cachedFacts, ...newFacts];
}
