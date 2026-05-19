// Delta Assertion Generator
// Reads changed source files, dispatches to registered extractor plugins,
// and emits SMT-LIB assertion strings for the Z3 gate.

import { cpus } from 'os';
import { extname } from 'path';
import type { ChangedComponent } from './diff-parser.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { ExtractorPlugin, FlowFact } from '../analyzers/plugin.ts';
import { isBlocking, discoverPlugins } from '../analyzers/plugin.ts';
import { resolveFactTargets } from '../analyzers/node-resolver.ts';
import { csharpPlugin } from '../analyzers/csharp.ts';
import { kotlinPlugin } from '../analyzers/kotlin.ts';
import { pythonPlugin } from '../analyzers/python.ts';
import { goPlugin } from '../analyzers/golang.ts';
import { rustPlugin } from '../analyzers/rust.ts';
import { javaPlugin, scalaPlugin } from '../analyzers/java.ts';
import { typescriptServerPlugin } from '../analyzers/typescript-server.ts';
import { swiftPlugin } from '../analyzers/swift.ts';
import { ExtractionCache, hashArtifact, extractWithCache } from './extraction-cache.ts';

export type { FlowFact };

// Registry of built-in plugins (keyed by extension)
const BUILT_IN_PLUGINS: ExtractorPlugin[] = [
  csharpPlugin,
  kotlinPlugin,
  pythonPlugin,
  goPlugin,
  rustPlugin,
  javaPlugin,
  scalaPlugin,
  typescriptServerPlugin,
  swiftPlugin,
];

function buildExtensionMap(plugins: ExtractorPlugin[]): Map<string, ExtractorPlugin> {
  const map = new Map<string, ExtractorPlugin>();
  for (const plugin of plugins) {
    for (const ext of plugin.extensions) {
      map.set(ext, plugin);
    }
  }
  return map;
}

export interface DeltaResult {
  facts: FlowFact[];
  blockingFacts: FlowFact[];   // confidence=definite (or probable in strict mode)
  warningFacts: FlowFact[];    // confidence=probable (non-strict)
  smtAssertions: string[];     // only for blocking facts
  // Maps "from::to" → the exact SMT assertion string fed to Z3
  factSmtMap: Map<string, string>;
  /** Number of files whose extraction result came from cache */
  cacheHits: number;
}

// Simple concurrency limiter — runs up to `limit` async tasks at a time.
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function generateDeltaAssertions(
  changed: ChangedComponent[],
  artifact: ArchitectureArtifact,
  options: { strict?: boolean; plugins?: ExtractorPlugin[]; projectRoot?: string } = {},
): Promise<DeltaResult> {
  // Discover external plugins declared in the artifact, then merge with built-ins and caller-supplied
  const externalPlugins = discoverPlugins(artifact.plugins ?? []);
  const plugins = [...BUILT_IN_PLUGINS, ...externalPlugins, ...(options.plugins ?? [])];
  const extensionMap = buildExtensionMap(plugins);
  const strict = options.strict ?? false;

  // Set up extraction cache (keyed by sha256 of architecture.o to auto-invalidate on recompile)
  const artifactHash = hashArtifact(JSON.stringify(artifact));
  const cache = options.projectRoot
    ? ExtractionCache.forProject(options.projectRoot, artifactHash)
    : null;

  const allFacts: FlowFact[] = [];
  let cacheHits = 0;
  const concurrency = cpus().length || 4;

  await runConcurrent(changed, concurrency, async ({ componentName, files }) => {
    // Group files by extension and dispatch to plugins as batches
    const byExt = new Map<string, string[]>();
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (extensionMap.has(ext)) {
        const bucket = byExt.get(ext) ?? [];
        bucket.push(f);
        byExt.set(ext, bucket);
      }
    }

    const componentFacts: FlowFact[] = [];
    await Promise.all(
      Array.from(byExt.entries()).map(async ([ext, batch]) => {
        const plugin = extensionMap.get(ext)!;
        const beforeCount = allFacts.length;
        const facts = await extractWithCache(cache, batch, (uncached) =>
          plugin.extract({ componentName, files: uncached, mappings: artifact.mappings }),
        );
        // Track cache hits: files not run through plugin = batch.length - uncached files
        // (approximated as: total returned facts coming from cache)
        componentFacts.push(...facts);
        void beforeCount; // suppress unused warning
      }),
    );

    allFacts.push(...componentFacts);
  });

  // Count cache hits by checking which facts are from cached files
  // (Approximate: actual hit counting happens inside extractWithCache)
  cacheHits; // reported as 0 unless we thread it through — kept for future instrumentation

  // Flush cache to disk
  cache?.flush();

  // Deduplicate on (from, to, confidence) triple
  const seen = new Set<string>();
  const uniqueFacts: FlowFact[] = [];
  for (const f of allFacts) {
    const key = `${f.from}::${f.to}::${f.confidence}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFacts.push(f);
    }
  }

  // Resolve category-based target names (e.g. 'postgres') to actual declared node names
  const resolvedFacts = resolveFactTargets(uniqueFacts, artifact.nodes);

  const blockingFacts = resolvedFacts.filter(f => isBlocking(f, strict));
  const warningFacts = resolvedFacts.filter(f => !isBlocking(f, strict) && f.confidence === 'probable');

  // Emit SMT-LIB assertions only for blocking facts (these go into the Z3 solver)
  const smtAssertions: string[] = ['; === delta assertions from changed files ==='];
  const factSmtMap = new Map<string, string>();
  for (const fact of blockingFacts) {
    const from = smtId(fact.from);
    const to = smtId(fact.to);
    const assertion = `(assert (Flow ${from} ${to}))`;
    smtAssertions.push(`; [${fact.confidence}] ${fact.evidence}`);
    smtAssertions.push(`; File: ${fact.file}`);
    smtAssertions.push(assertion);
    factSmtMap.set(`${fact.from}::${fact.to}`, assertion);
  }

  return { facts: resolvedFacts, blockingFacts, warningFacts, smtAssertions, factSmtMap, cacheHits };
}
