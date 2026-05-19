// Extractor plugin interface — each language analyzer implements this contract
// Plugins are batch-oriented: they analyze a set of files at once (not per-file),
// because semantic analyzers (Roslyn, tsc) need project context.

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
