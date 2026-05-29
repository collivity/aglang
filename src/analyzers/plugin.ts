// Extractor plugin interface — each language analyzer implements this contract
// Plugins are batch-oriented: they analyze a set of files at once (not per-file),
// because semantic analyzers (Roslyn, tsc) need project context.

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

export type Confidence = 'definite' | 'probable' | 'possible';
export type ExtractionStrategy = 'ast' | 'regex' | 'graph' | 'legacy-flow';

export interface ExtractorDebugEvent {
  extractor: string;
  stage: string;
  message: string;
  file?: string;
  details?: Record<string, unknown>;
}

export interface ExtractorDebugSession {
  enabled: boolean;
  requireAst: boolean;
  events: ExtractorDebugEvent[];
  log(event: ExtractorDebugEvent): void;
}

export function createExtractorDebugSession(enabled = false, requireAst = false): ExtractorDebugSession {
  return {
    enabled,
    requireAst,
    events: [],
    log(event: ExtractorDebugEvent) {
      if (!enabled) return;
      this.events.push(event);
    },
  };
}

export interface FlowFact {
  from: string;       // component name (aglang identifier)
  to: string;         // component or node name (aglang identifier)
  confidence: Confidence;
  evidence: string;   // human-readable description of what was detected
  file: string;       // absolute path to the file containing the evidence
  line?: number;      // line number (if known)
  strategy?: ExtractionStrategy;
  graphEvidence?: {
    graphFactId: string;
    kind: string;
    extractor?: string;
    strategy?: ExtractionStrategy;
    file?: string;
    line?: number;
    evidence: string;
  };
}

export interface GraphFactEvidence {
  extractor?: string;
  strategy?: ExtractionStrategy;
  file?: string;
  line?: number;
  message?: string;
}

export interface GraphFact {
  id: string;
  kind: string;
  subject: string;
  target?: string;
  technology?: string;
  model?: string;
  route?: string;
  properties?: Record<string, string | number | boolean | string[]>;
  confidence: Confidence;
  evidence: GraphFactEvidence;
}

export interface ExtractorInput {
  componentName: string;
  files: string[];
  mappings: Record<string, string>;  // component name → path glob
  debug?: ExtractorDebugSession;
  requireAst?: boolean;
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
  /**
   * Optional graph-native extraction path. New extractors should prefer this.
   * The runtime still falls back to extract() and normalizes legacy FlowFact[]
   * into graph facts for compatibility.
   */
  extractGraph?(input: ExtractorInput): Promise<GraphFact[]> | GraphFact[];
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

interface SubprocessInvocation {
  command: string;
  args: string[];
}

function findLocalPackageRoot(packageName: string): string | undefined {
  const roots = [process.cwd(), resolve(process.cwd(), '..')];
  for (const root of roots) {
    for (const container of ['plugins', 'packages']) {
      const containerPath = join(root, container);
      if (!existsSync(containerPath)) continue;
      for (const entry of readdirSync(containerPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packageRoot = join(containerPath, entry.name);
        const packageJsonPath = join(packageRoot, 'package.json');
        if (!existsSync(packageJsonPath)) continue;
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
          if (pkg.name === packageName) return packageRoot;
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}

function resolvePackageBin(packageRoot: string, packageName: string): string | undefined {
  const packageJsonPath = join(packageRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  if (typeof pkg.bin === 'string') return join(packageRoot, pkg.bin);
  if (pkg.bin && typeof pkg.bin === 'object') {
    const matching = pkg.bin[packageName] ?? Object.values(pkg.bin)[0];
    if (matching) return join(packageRoot, matching);
  }
  return undefined;
}

function resolveSubprocessInvocation(packageName: string): SubprocessInvocation[] {
  const invocations: SubprocessInvocation[] = [];
  const localPackageRoot = findLocalPackageRoot(packageName);
  if (localPackageRoot) {
    const localBin = resolvePackageBin(localPackageRoot, packageName);
    if (localBin) {
      invocations.push({
        command: process.execPath,
        args: [localBin],
      });
    }
  }
  invocations.push({
    command: 'npx',
    args: ['--no', packageName],
  });
  return invocations;
}

function runInvocation(invocations: SubprocessInvocation[], extraArgs: string[]): ReturnType<typeof spawnSync> {
  let lastResult: ReturnType<typeof spawnSync> | undefined;
  for (const invocation of invocations) {
    const result = spawnSync(invocation.command, [...invocation.args, ...extraArgs], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!result.error && result.status === 0) return result;
    lastResult = result;
  }
  return lastResult ?? spawnSync('npx', ['--no', 'definitely-missing-package'], { encoding: 'utf8' });
}

function outputText(output: string | Buffer | null | undefined): string {
  if (typeof output === 'string') return output;
  if (!output) return '';
  return output.toString('utf8');
}

export class SubprocessPlugin implements ExtractorPlugin {
  name: string;
  extensions: string[];
  private invocations: SubprocessInvocation[];

  constructor(packageName: string, info: SubprocessPluginInfo) {
    this.name = info.name;
    this.extensions = info.extensions;
    this.invocations = resolveSubprocessInvocation(packageName);
  }

  async extract(input: ExtractorInput): Promise<FlowFact[]> {
    const args = [
      '--component', input.componentName,
      '--mappings', JSON.stringify(input.mappings),
      '--files', ...input.files,
    ];
    const result = runInvocation(this.invocations, args);
    if (result.error || result.status !== 0) {
      const err = outputText(result.stderr).trim() || result.error?.message || `exit ${result.status}`;
      console.warn(`[aglc] plugin '${this.name}' extraction failed: ${err}`);
      return [];
    }
    try {
      const facts = JSON.parse(outputText(result.stdout)) as unknown;
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
  const result = runInvocation(resolveSubprocessInvocation(packageName), ['--info']);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Plugin '${packageName}' not found or failed --info query: ` +
      (outputText(result.stderr).trim() || result.error?.message || `exit ${result.status}`),
    );
  }
  try {
    const info = JSON.parse(outputText(result.stdout)) as SubprocessPluginInfo;
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
