// Rust static analyzer — detects infrastructure flows and server-side routes.
// Handles: Axum, Actix-web, plus sqlx, diesel, mongodb, redis, rdkafka, reqwest.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';

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

function hasRustUse(content: string, crate: string): boolean {
  // Matches: use crate::..., extern crate crate, use crate:
  return new RegExp(`\\buse\\s+${crate.replace(/\//g, '/')}|\\bextern\\s+crate\\s+${crate}`).test(content)
    || content.includes(`${crate}::`);
}

// ── Server-side route extraction ─────────────────────────────────────────────

export function extractRoutesFromRust(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  // Actix-web attribute macros:
  //   #[get("/path")]  #[post("/path")]  #[put("/path")]  etc.
  const actixMacroRe = /#\[(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]+)"\s*\)\]/gi;
  while ((m = actixMacroRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const path = m[2]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // Actix-web #[route("/path", method="GET", method="POST")]
  const actixRouteRe = /#\[route\s*\(\s*"([^"]+)"[^)]*method\s*=\s*"(GET|POST|PUT|DELETE|PATCH)"/gi;
  while ((m = actixRouteRe.exec(content)) !== null) {
    const path = m[1]!;
    const method = m[2]!.toUpperCase();
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // Axum Router::new().route("/path", get(handler)) or .route("/path", post(handler))
  // Also: .route("/path", get(h).post(h))
  const axumRouteRe = /\.route\s*\(\s*"([^"]+)"\s*,\s*((?:get|post|put|delete|patch|head|options)(?:\s*\([^)]+\)(?:\s*\.\s*(?:get|post|put|delete|patch)\s*\([^)]+\))*)?)/gi;
  while ((m = axumRouteRe.exec(content)) !== null) {
    const path = m[1]!;
    const methodsStr = m[2]!;
    // Extract all method names from the chain
    const methodMatches = methodsStr.match(/\b(get|post|put|delete|patch)\b/gi) ?? [];
    if (methodMatches.length === 0) {
      routes.push({ method: '*', path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
    } else {
      for (const method of methodMatches) {
        routes.push({ method: method.toUpperCase(), path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
      }
    }
  }

  // Actix App::route("/path", web::get().to(handler))
  const actixAppRouteRe = /App::(?:new\(\))?\s*\.route\s*\(\s*"([^"]+)"\s*,\s*web::(get|post|put|delete|patch)/gi;
  while ((m = actixAppRouteRe.exec(content)) !== null) {
    const path = m[1]!;
    const method = m[2]!.toUpperCase();
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── Infrastructure flow detection ────────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // ── PostgreSQL (sqlx with Pg-specific types) ─────────────────────────────
  const hasSqlx = hasRustUse(content, 'sqlx');
  const isPgSpecific = /sqlx::PgPool|sqlx::postgres|PgPool|PgConnection/.test(content);
  const hasDiesel = hasRustUse(content, 'diesel');
  const isDieselPg = /diesel::pg|PgConnection|establish_connection.*postgres/.test(content);

  if (hasSqlx && isPgSpecific) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'Uses sqlx with PgPool/postgres — PostgreSQL dependency',
      file: filePath,
    });
  } else if (hasSqlx) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses sqlx (SQL toolkit) — relational DB dependency (dialect unknown)',
      file: filePath,
    });
  }

  if (hasDiesel && isDieselPg) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'Uses Diesel ORM with PostgreSQL dialect',
      file: filePath,
    });
  } else if (hasDiesel) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses Diesel ORM — relational DB dependency (dialect unknown)',
      file: filePath,
    });
  }

  // SeaORM
  const hasSeaOrm = hasRustUse(content, 'sea_orm') || content.includes('sea-orm');
  if (hasSeaOrm) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses SeaORM — relational DB dependency',
      file: filePath,
    });
  }

  // ── MongoDB ──────────────────────────────────────────────────────────────
  const hasMongo = hasRustUse(content, 'mongodb');
  if (hasMongo) {
    const mongoUsage = /Client::with_uri_str|mongodb::Client|\.get_database\s*\(/.test(content);
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: mongoUsage ? 'definite' : 'probable',
      evidence: mongoUsage ? 'Creates MongoDB client connection' : 'Imports mongodb crate',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const hasRedis = hasRustUse(content, 'redis') || hasRustUse(content, 'fred');
  if (hasRedis) {
    const redisUsage = /redis::Client|Client::open|ConnectionManager|RedisPool/.test(content);
    facts.push({
      from: componentName, to: 'redis',
      confidence: redisUsage ? 'definite' : 'probable',
      evidence: redisUsage ? 'Creates Redis client connection' : 'Imports redis crate',
      file: filePath,
    });
  }

  // ── Message Queue / Kafka ────────────────────────────────────────────────
  const hasKafka = hasRustUse(content, 'rdkafka') || hasRustUse(content, 'kafka');
  if (hasKafka) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Imports Kafka client (rdkafka)',
      file: filePath,
    });
  }

  // ── Object Storage ───────────────────────────────────────────────────────
  const hasS3 = hasRustUse(content, 'aws_sdk_s3') || hasRustUse(content, 'rusoto_s3') || hasRustUse(content, 'opendal');
  if (hasS3) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'probable',
      evidence: 'Imports S3/object storage client (aws_sdk_s3/rusoto_s3)',
      file: filePath,
    });
  }

  // ── External HTTP ────────────────────────────────────────────────────────
  const hasReqwest = hasRustUse(content, 'reqwest') || hasRustUse(content, 'hyper');
  if (hasReqwest) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Uses reqwest/hyper HTTP client — external API dependency (target unknown)',
      file: filePath,
    });
  }

  return facts;
}

export const rustPlugin: ExtractorPlugin = {
  name: 'Rust regex analyzer',
  extensions: ['.rs'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      facts.push(...analyzeFile(content, filePath, input.componentName));
    }
    return facts;
  },
};
