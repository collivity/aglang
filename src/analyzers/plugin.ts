// Extractor plugin interface — each language analyzer implements this contract
// Plugins are batch-oriented: they analyze a set of files at once (not per-file),
// because semantic analyzers (Roslyn, tsc) need project context.

import { spawnSync } from 'child_process';

export type Confidence = 'definite' | 'probable' | 'possible';

export interface FlowFact {
  from: string;       // component name (aglang identifier)
  to: string;         // component or node name (aglang identifier)
  confidence: Confidence;
  evidence: string;   // human-readable description of what was detected
  file: string;       // absolute path to the file containing the evidence
  line?: number;      // line number (if known)
}

export interface ExtractorInput {
  componentName: string;
  files: string[];
  mappings: Record<string, string>;  // component name → path glob
}

export interface ExtractorPlugin {
  /** File extensions this plugin handles, e.g. ['.cs', '.csx'] */
  extensions: string[];
  /** Name shown in diagnostics */
  name: string;
  /**
   * Analyze a batch of files (same component) and return flow facts.
   * Files are guaranteed to match the plugin's extensions.
   * Implementations should batch-load project context if needed.
   */
  extract(input: ExtractorInput): Promise<FlowFact[]> | FlowFact[];
}

// ─── Subprocess plugin protocol ───────────────────────────────────────────────
//
// External extractor packages (e.g. aglc-roslyn) must implement this CLI:
//
//   Capability query:
//     $ <executable> --info
//     → stdout: { "name": "aglc-roslyn", "extensions": [".cs"], "version": "1.0.0" }
//
//   Extraction:
//     $ <executable> --component <name> --mappings <json> --files <f1> <f2> ...
//     → stdout: FlowFact[] as JSON array
//     → exit 0 = success, non-zero = error (treated as empty + warning)
//
// The executable is resolved in order:
//   1. npx --no <packageName>  (works if installed in project or globally)
//   2. Direct PATH lookup via `<packageName>` as executable name

export interface SubprocessPluginInfo {
  name: string;
  extensions: string[];
  version?: string;
}

export class SubprocessPlugin implements ExtractorPlugin {
  name: string;
  extensions: string[];
  private executable: string;

  constructor(packageName: string, info: SubprocessPluginInfo) {
    this.name = info.name;
    this.extensions = info.extensions;
    this.executable = packageName;
  }

  async extract(input: ExtractorInput): Promise<FlowFact[]> {
    const args = [
      '--component', input.componentName,
      '--mappings', JSON.stringify(input.mappings),
      '--files', ...input.files,
    ];
    const result = spawnSync('npx', ['--no', this.executable, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    if (result.error || result.status !== 0) {
      const err = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
      console.warn(`[aglc] plugin '${this.name}' extraction failed: ${err}`);
      return [];
    }
    try {
      const facts = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(facts)) {
        console.warn(`[aglc] plugin '${this.name}': expected JSON array, got ${typeof facts}`);
        return [];
      }
      return facts as FlowFact[];
    } catch {
      console.warn(`[aglc] plugin '${this.name}': could not parse output as JSON`);
      return [];
    }
  }
}

/**
 * Query a subprocess plugin for its capability info (--info flag).
 * Throws if the plugin is not installed or returns invalid JSON.
 */
export function querySubprocessPluginInfo(packageName: string): SubprocessPluginInfo {
  const result = spawnSync('npx', ['--no', packageName, '--info'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Plugin '${packageName}' not found or failed --info query: ` +
      (result.stderr?.trim() || result.error?.message || `exit ${result.status}`),
    );
  }
  try {
    const info = JSON.parse(result.stdout) as SubprocessPluginInfo;
    if (!info.name || !Array.isArray(info.extensions)) {
      throw new Error('missing name or extensions field');
    }
    return info;
  } catch (e) {
    throw new Error(`Plugin '${packageName}' --info returned invalid JSON: ${(e as Error).message}`);
  }
}

/**
 * Discover and instantiate subprocess plugins declared in the architecture artifact.
 * Plugins that are not installed are silently skipped with a warning.
 */
export function discoverPlugins(pluginPackageNames: string[]): ExtractorPlugin[] {
  const discovered: ExtractorPlugin[] = [];
  for (const pkg of pluginPackageNames) {
    try {
      const info = querySubprocessPluginInfo(pkg);
      discovered.push(new SubprocessPlugin(pkg, info));
      console.error(`[aglc] Loaded external plugin: ${info.name} v${info.version ?? '?'} (${info.extensions.join(', ')})`);
    } catch (err) {
      console.warn(`[aglc] Skipping plugin '${pkg}': ${(err as Error).message}`);
    }
  }
  return discovered;
}

// Gate confidence policy:
//   definite → blocking (fails commit, reported as error)
//   probable → soft-fail (reported as warning, commit allowed unless --strict)
//   possible → informational only (reported, never blocks)
export const CONFIDENCE_LEVELS: Record<Confidence, number> = {
  definite: 3,
  probable: 2,
  possible: 1,
};

export function isBlocking(fact: FlowFact, strict = false): boolean {
  if (fact.confidence === 'definite') return true;
  if (fact.confidence === 'probable' && strict) return true;
  return false;
}
