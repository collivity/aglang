// Kotlin static analyzer — detects flow patterns in .kt files
// Implements ExtractorPlugin for batch analysis of Kotlin/Android components.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';

export type { FlowFact };

// Direct HTTP client usage — should only happen in core/network, not feature modules
const DIRECT_HTTP_PATTERNS = [
  /import\s+com\.collivity\.core\.network\.HttpClient/,
  /HttpClient\s*\.\s*(?:getJson|postJson|putJson|deleteJson|putBinary|putFile)\s*\(/,
  /HttpURLConnection/,
  /OkHttpClient/,
  /Retrofit\.Builder/,
];

// Patterns indicating the file is a feature-layer file (not allowed to call backend directly)
const FEATURE_LAYER_PATTERNS = [
  /package\s+com\.\w+\.feature\./,
  /class\s+\w+ViewModel\s*(?::|extends)/,
  /class\s+\w+Activity\s*(?::|extends)/,
  /class\s+\w+Screen/,
  /@Composable/,
];

// Direct database access from mobile (should never happen — use API)
const DIRECT_DB_PATTERNS = [
  /import\s+(?:android\.database|androidx\.room)\./,
  /RoomDatabase/,
  /SupportSQLiteDatabase/,
];

function analyzeFile(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string>,
): FlowFact[] {
  const facts: FlowFact[] = [];

  const isFeatureLayer =
    FEATURE_LAYER_PATTERNS.some(re => re.test(content)) ||
    filePath.includes('/feature/');

  if (isFeatureLayer) {
    for (const pattern of DIRECT_HTTP_PATTERNS) {
      if (pattern.test(content)) {
        facts.push({
          from: componentName,
          to: resolveBackendTarget(mappings),
          confidence: 'definite',
          evidence: `Feature module uses HTTP transport directly (pattern: ${pattern.source.slice(0, 60)})`,
          file: filePath,
        });
        break; // one fact per file is enough
      }
    }
  }

  // Room DB in any component except explicitly data-layer ones
  for (const pattern of DIRECT_DB_PATTERNS) {
    if (pattern.test(content)) {
      facts.push({
        from: componentName,
        to: 'postgres_db',
        confidence: 'probable',
        evidence: `Mobile code imports local DB layer — unexpected in ${componentName}`,
        file: filePath,
      });
      break;
    }
  }

  return facts;
}

export const kotlinPlugin: ExtractorPlugin = {
  name: 'Kotlin regex analyzer',
  extensions: ['.kt', '.kts'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      facts.push(...analyzeFile(content, filePath, input.componentName, input.mappings));
    }
    return facts;
  },
};

// Legacy single-file API (kept for backward compat)
export function analyzeKotlin(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string>,
): FlowFact[] {
  return analyzeFile(content, filePath, componentName, mappings);
}

function resolveBackendTarget(mappings: Record<string, string>): string {
  const backendComponents = Object.keys(mappings).filter(k =>
    k.toLowerCase().includes('backend') || k.toLowerCase().includes('api')
  );
  return backendComponents[0] ?? 'api_backend';
}
