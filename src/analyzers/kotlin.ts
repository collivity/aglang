// Kotlin static analyzer — detects flow patterns in .kt files
// Implements ExtractorPlugin for batch analysis of Kotlin/Android components.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact, GraphFact } from './plugin.ts';

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

function lineOf(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function extractSemanticGraphFacts(content: string, filePath: string, componentName: string): GraphFact[] {
  const facts: GraphFact[] = [];
  const emitted = new Set<string>();
  const add = (kind: string, index: number, properties: GraphFact['properties'], message: string): void => {
    const line = lineOf(content, index);
    const id = `kotlin-semantic:${filePath}:${line}:${kind}:${JSON.stringify(properties)}`;
    if (emitted.has(id)) return;
    emitted.add(id);
    facts.push({
      id,
      kind,
      subject: componentName,
      properties,
      confidence: 'definite',
      evidence: {
        extractor: kotlinPlugin.name,
        strategy: 'regex',
        file: filePath,
        line,
        message,
      },
    });
  };

  const assignmentRe = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  let assignment: RegExpExecArray | null;
  while ((assignment = assignmentRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, assignment.index - 300), assignment.index);
    const guardRe = new RegExp(`${assignment[1]}\\.${assignment[2]}\\s*(?:==|===)\\s*${assignment[3]}\\.([A-Za-z_]\\w*)`);
    const guards = [...before.matchAll(new RegExp(guardRe.source, 'g'))];
    const guard = guards.at(-1);
    add('assignment', assignment.index, {
      object: assignment[1]!,
      property: assignment[2]!,
      valueEnum: assignment[3]!,
      valueMember: assignment[4]!,
      ...(guard ? { previousMember: guard[1]! } : {}),
    }, `${assignment[1]}.${assignment[2]} = ${assignment[3]}.${assignment[4]}`);
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
  async extractGraph(input: ExtractorInput): Promise<GraphFact[]> {
    const graphFacts: GraphFact[] = [];
    const flowFacts = await this.extract(input);
    graphFacts.push(...flowFacts.map((fact, index) => ({
      id: `kotlin-flow:${index}:${fact.from}:${fact.to}:${fact.file}:${fact.line ?? 0}`,
      kind: 'accesses_technology',
      subject: fact.from,
      technology: fact.to,
      confidence: fact.confidence,
      evidence: {
        extractor: kotlinPlugin.name,
        strategy: fact.strategy ?? 'legacy-flow',
        file: fact.file,
        line: fact.line,
        message: fact.evidence,
      },
    } satisfies GraphFact)));
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      graphFacts.push(...extractSemanticGraphFacts(content, filePath, input.componentName));
    }
    return graphFacts;
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
