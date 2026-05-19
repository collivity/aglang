// Delta Assertion Generator
// Reads changed source files, dispatches to registered extractor plugins,
// and emits SMT-LIB assertion strings for the Z3 gate.

import { cpus } from 'os';
import { extname } from 'path';
import type { ChangedComponent } from './diff-parser.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { ExtractorPlugin, FlowFact, GraphFact } from '../analyzers/plugin.ts';
import { discoverPlugins } from '../analyzers/plugin.ts';
import { csharpPlugin } from '../analyzers/csharp.ts';
import { kotlinPlugin } from '../analyzers/kotlin.ts';
import { pythonPlugin } from '../analyzers/python.ts';
import { goPlugin } from '../analyzers/golang.ts';
import { rustPlugin } from '../analyzers/rust.ts';
import { javaPlugin, scalaPlugin } from '../analyzers/java.ts';
import { typescriptServerPlugin } from '../analyzers/typescript-server.ts';
import { swiftPlugin } from '../analyzers/swift.ts';
import { ExtractionCache, hashArtifact, extractWithCache } from './extraction-cache.ts';
import {
  buildGraphReport,
  flowFactToGraphFact,
  projectGraphToFlows,
  type GraphReport,
} from './graph-projection.ts';

export type { FlowFact, GraphFact };

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
  graphFacts: GraphFact[];
  blockingFacts: FlowFact[];   // confidence=definite (or probable in strict mode)
  warningFacts: FlowFact[];    // confidence=probable (non-strict)
  smtAssertions: string[];     // only for blocking facts
  // Maps "from::to" → the exact SMT assertion string fed to Z3
  factSmtMap: Map<string, string>;
  graphReport: GraphReport;
  unresolvedTargets: string[];
  graphWarnings: Array<{ graphFactId: string; message: string }>;
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

  const allGraphFacts: GraphFact[] = [];
  let cacheHits = 0;
  const concurrency = cpus().length || 4;
  let graphFactSequence = 0;

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

    await Promise.all(
      Array.from(byExt.entries()).map(async ([ext, batch]) => {
        const plugin = extensionMap.get(ext)!;
        if (plugin.extractGraph) {
          const facts = await plugin.extractGraph({ componentName, files: batch, mappings: artifact.mappings });
          allGraphFacts.push(...facts);
        } else {
          const facts = await extractWithCache(cache, batch, (uncached) =>
            plugin.extract({ componentName, files: uncached, mappings: artifact.mappings }),
          );
          allGraphFacts.push(...facts.map(f =>
            flowFactToGraphFact(f, graphFactSequence++, plugin.name)
          ));
        }
        // Track cache hits: files not run through plugin = batch.length - uncached files
        // (approximated as: total returned facts coming from cache)
      }),
    );

  });

  // Count cache hits by checking which facts are from cached files
  // (Approximate: actual hit counting happens inside extractWithCache)
  cacheHits; // reported as 0 unless we thread it through — kept for future instrumentation

  // Flush cache to disk
  cache?.flush();

  // Deduplicate graph facts by stable ID, then project to flow facts.
  const graphSeen = new Set<string>();
  const uniqueGraphFacts: GraphFact[] = [];
  for (const f of allGraphFacts) {
    if (!graphSeen.has(f.id)) {
      graphSeen.add(f.id);
      uniqueGraphFacts.push(f);
    }
  }

  const projection = projectGraphToFlows(uniqueGraphFacts, artifact, { strict });
  const graphReport = buildGraphReport(uniqueGraphFacts, projection);

  return {
    facts: projection.flowFacts,
    graphFacts: uniqueGraphFacts,
    blockingFacts: projection.blockingFacts,
    warningFacts: projection.warningFacts,
    smtAssertions: projection.smtAssertions,
    factSmtMap: projection.factSmtMap,
    graphReport,
    unresolvedTargets: projection.unresolvedTargets,
    graphWarnings: projection.warnings,
    cacheHits,
  };
}
