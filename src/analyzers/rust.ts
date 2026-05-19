// Rust static analyzer — detects infrastructure flows and server-side routes.
// Handles: Axum, Actix-web, plus sqlx, diesel, mongodb, redis, rdkafka, reqwest.
// Uses tree-sitter AST when available, falls back to regex silently.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter } from './ast/loader.ts';
import { parseAndQuery } from './ast/walker.ts';
import { USE_QUERY, ROUTE_ATTR_QUERY, CALL_QUERY } from './ast/queries/rust.ts';

export interface RouteFact {
  method: string;
  path: string;
  normalized: string;
  file: string;
  line?: number;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

// ── Crate → infra node mapping ────────────────────────────────────────────────

const CRATE_TO_INFRA: Array<[string, string]> = [
  ['sqlx', 'relational_db'],
  ['diesel', 'relational_db'],
  ['sea_orm', 'relational_db'],
  ['mongodb', 'mongodb'],
  ['redis', 'redis'],
  ['fred', 'redis'],
  ['rdkafka', 'message_queue'],
  ['kafka', 'message_queue'],
  ['aws_sdk_s3', 'object_store'],
  ['rusoto_s3', 'object_store'],
  ['opendal', 'object_store'],
  ['reqwest', 'external_api'],
  ['hyper', 'external_api'],
];

// Scoped function calls that elevate confidence
const SCOPE_CALL_TO_INFRA: Record<string, string> = {
  'PgPool::connect': 'postgres',
  'PgPool::connect_lazy': 'postgres',
  'PgConnection::connect': 'postgres',
  'mongo::Client::with_uri_str': 'mongodb',
  'mongodb::Client::with_uri_str': 'mongodb',
  'Client::with_uri_str': 'mongodb',
  'Client::open': 'redis',
  'redis::Client::open': 'redis',
};

// ── AST-based route extraction ─────────────────────────────────────────────────

function extractRoutesAst(content: string, filePath: string): RouteFact[] {
  const parser = makeParser('rust');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['rust'];
  const routes: RouteFact[] = [];

  const captures = parseAndQuery(parser, language, content, ROUTE_ATTR_QUERY);
  for (let i = 0; i < captures.length; i++) {
    const attrName = captures[i];
    const routePath = captures[i + 1];
    if (attrName?.name === 'attr_name' && routePath?.name === 'route_path') {
      const method = attrName.text.toUpperCase();
      const rawPath = routePath.text.replace(/^"|"$/g, '');
      routes.push({ method, path: rawPath, normalized: normalizeRoute(rawPath), file: filePath, line: attrName.startRow + 1 });
      i++;
    }
  }
  return routes;
}

// ── Regex fallback for route extraction ──────────────────────────────────────

function extractRoutesRegex(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  const actixMacroRe = /#\[(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]+)"\s*\)\]/gi;
  while ((m = actixMacroRe.exec(content)) !== null) {
    routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, normalized: normalizeRoute(m[2]!), file: filePath, line: lineOf(content, m.index) });
  }

  const actixRouteRe = /#\[route\s*\(\s*"([^"]+)"[^)]*method\s*=\s*"(GET|POST|PUT|DELETE|PATCH)"/gi;
  while ((m = actixRouteRe.exec(content)) !== null) {
    routes.push({ method: m[2]!.toUpperCase(), path: m[1]!, normalized: normalizeRoute(m[1]!), file: filePath, line: lineOf(content, m.index) });
  }

  const axumRouteRe = /\.route\s*\(\s*"([^"]+)"\s*,\s*((?:get|post|put|delete|patch)(?:\s*\([^)]+\))*)/gi;
  while ((m = axumRouteRe.exec(content)) !== null) {
    const path = m[1]!;
    const methodsStr = m[2]!;
    const methodMatches = methodsStr.match(/\b(get|post|put|delete|patch)\b/gi) ?? [];
    for (const method of (methodMatches.length ? methodMatches : ['*'])) {
      routes.push({ method: method.toUpperCase(), path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
    }
  }

  const actixAppRouteRe = /\.route\s*\(\s*"([^"]+)"\s*,\s*web::(get|post|put|delete|patch)/gi;
  while ((m = actixAppRouteRe.exec(content)) !== null) {
    routes.push({ method: m[2]!.toUpperCase(), path: m[1]!, normalized: normalizeRoute(m[1]!), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── AST-based infrastructure detection ───────────────────────────────────────

function analyzeFileAst(content: string, filePath: string, componentName: string): FlowFact[] {
  const parser = makeParser('rust');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['rust'];

  // Collect use paths
  const useCaptures = parseAndQuery(parser, language, content, USE_QUERY);
  const usePaths = useCaptures.filter(c => c.name === 'use_path').map(c => c.text);

  // Collect scoped calls for definite usage evidence
  const callCaptures = parseAndQuery(parser, language, content, CALL_QUERY);
  const scopedCalls = new Set<string>();
  for (let i = 0; i < callCaptures.length; i++) {
    const recv = callCaptures[i];
    const fn = callCaptures[i + 1];
    if (recv?.name === 'receiver' && fn?.name === 'fn_name') {
      scopedCalls.add(`${recv.text}::${fn.text}`);
      i++;
    }
  }

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();

  for (const usePath of usePaths) {
    for (const [crate, infraNode] of CRATE_TO_INFRA) {
      if (usePath.startsWith(crate) && !emitted.has(infraNode)) {
        // Check for pg-specific usage
        const isPg = usePath.includes('PgPool') || usePath.includes('PgConnection') || usePath.includes('postgres') || content.includes('PgPool') || content.includes('PgConnection');
        const hasDefiniteCall = [...scopedCalls].some(sc => SCOPE_CALL_TO_INFRA[sc] === infraNode);
        const finalNode = (infraNode === 'relational_db' && (crate === 'sqlx' || crate === 'diesel') && isPg) ? 'postgres' : infraNode;
        facts.push({
          from: componentName,
          to: finalNode,
          confidence: hasDefiniteCall || finalNode === 'postgres' ? 'definite' : 'probable',
          evidence: hasDefiniteCall ? `Uses '${crate}' with explicit client creation` : `Imports '${crate}' crate`,
          file: filePath,
        });
        emitted.add(infraNode);
        break;
      }
    }
  }

  return facts;
}

// ── Regex fallback: infrastructure detection ──────────────────────────────────

function hasRustUse(content: string, crate: string): boolean {
  return new RegExp(`\\buse\\s+${crate.replace(/\//g, '/')}|\\bextern\\s+crate\\s+${crate}`).test(content)
    || content.includes(`${crate}::`);
}

function analyzeFileRegex(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  const hasSqlx = hasRustUse(content, 'sqlx');
  const isPgSpecific = /sqlx::PgPool|sqlx::postgres|PgPool|PgConnection/.test(content);
  const hasDiesel = hasRustUse(content, 'diesel');
  const isDieselPg = /diesel::pg|PgConnection|establish_connection.*postgres/.test(content);

  if (hasSqlx && isPgSpecific) facts.push({ from: componentName, to: 'postgres', confidence: 'definite', evidence: 'Uses sqlx with PgPool/postgres', file: filePath });
  else if (hasSqlx) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses sqlx (dialect unknown)', file: filePath });

  if (hasDiesel && isDieselPg) facts.push({ from: componentName, to: 'postgres', confidence: 'definite', evidence: 'Uses Diesel ORM with PostgreSQL dialect', file: filePath });
  else if (hasDiesel) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses Diesel ORM (dialect unknown)', file: filePath });

  if (hasRustUse(content, 'sea_orm') || content.includes('sea-orm')) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses SeaORM', file: filePath });
  if (hasRustUse(content, 'mongodb')) {
    const mongoUsage = /Client::with_uri_str|mongodb::Client|\.get_database\s*\(/.test(content);
    facts.push({ from: componentName, to: 'mongodb', confidence: mongoUsage ? 'definite' : 'probable', evidence: mongoUsage ? 'Creates MongoDB client' : 'Imports mongodb crate', file: filePath });
  }
  if (hasRustUse(content, 'redis') || hasRustUse(content, 'fred')) {
    const redisUsage = /redis::Client|Client::open|ConnectionManager|RedisPool/.test(content);
    facts.push({ from: componentName, to: 'redis', confidence: redisUsage ? 'definite' : 'probable', evidence: redisUsage ? 'Creates Redis client' : 'Imports redis crate', file: filePath });
  }
  if (hasRustUse(content, 'rdkafka') || hasRustUse(content, 'kafka')) facts.push({ from: componentName, to: 'message_queue', confidence: 'probable', evidence: 'Imports Kafka client (rdkafka)', file: filePath });
  if (hasRustUse(content, 'aws_sdk_s3') || hasRustUse(content, 'rusoto_s3') || hasRustUse(content, 'opendal')) facts.push({ from: componentName, to: 'object_store', confidence: 'probable', evidence: 'Imports S3/object storage client', file: filePath });
  if (hasRustUse(content, 'reqwest') || hasRustUse(content, 'hyper')) facts.push({ from: componentName, to: 'external_api', confidence: 'possible', evidence: 'Uses reqwest/hyper HTTP client', file: filePath });

  return facts;
}

// ── Public exports ─────────────────────────────────────────────────────────────

export function extractRoutesFromRust(content: string, filePath: string): RouteFact[] {
  const astRoutes = extractRoutesAst(content, filePath);
  if (astRoutes.length > 0) return astRoutes;
  return extractRoutesRegex(content, filePath);
}

export const rustPlugin: ExtractorPlugin = {
  name: 'Rust AST/regex analyzer',
  extensions: ['.rs'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      const astFacts = analyzeFileAst(content, filePath, input.componentName);
      facts.push(...(astFacts.length > 0 ? astFacts : analyzeFileRegex(content, filePath, input.componentName)));
    }
    return facts;
  },
};
