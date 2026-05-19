// Go static analyzer — detects infrastructure flows and server-side routes.
// Handles: Gin, Echo, gorilla/mux, net/http, plus database/sql, GORM, mongo, redis, kafka.
// Uses tree-sitter AST when available, falls back to regex silently.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter } from './ast/loader.ts';
import { parseAndQuery } from './ast/walker.ts';
import { IMPORT_QUERY, CALL_QUERY, ROUTE_QUERY } from './ast/queries/golang.ts';

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

// ── Package → infra node mapping ─────────────────────────────────────────────

const PKG_TO_INFRA: Array<[string, string]> = [
  ['github.com/lib/pq', 'postgres'],
  ['github.com/jackc/pgx', 'postgres'],
  ['github.com/jackc/pgconn', 'postgres'],
  ['go.mongodb.org/mongo-driver', 'mongodb'],
  ['github.com/go-redis/redis', 'redis'],
  ['github.com/redis/go-redis', 'redis'],
  ['github.com/confluentinc/confluent-kafka-go', 'message_queue'],
  ['github.com/segmentio/kafka-go', 'message_queue'],
  ['github.com/IBM/sarama', 'message_queue'],
  ['github.com/Shopify/sarama', 'message_queue'],
  ['github.com/streadway/amqp', 'message_queue'],
  ['github.com/rabbitmq/amqp091-go', 'message_queue'],
  ['github.com/aws/aws-sdk-go', 'object_store'],
  ['github.com/minio/minio-go', 'object_store'],
  ['gorm.io/gorm', 'relational_db'],
  ['database/sql', 'relational_db'],
];

// Function names that elevate confidence (definite usage)
const CALL_TO_INFRA: Record<string, string> = {
  Connect: 'mongodb',
  NewClient: 'mongodb',
  Open: 'relational_db',
  'sql.Open': 'relational_db',
  'mongo.Connect': 'mongodb',
  'mongo.NewClient': 'mongodb',
  'redis.NewClient': 'redis',
  'redis.NewUniversalClient': 'redis',
};

// ── AST-based route extraction ─────────────────────────────────────────────────

function extractRoutesAst(content: string, filePath: string): RouteFact[] {
  const parser = makeParser('golang');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['golang'];
  const routes: RouteFact[] = [];

  const routeCaptures = parseAndQuery(parser, language, content, ROUTE_QUERY);
  for (let i = 0; i < routeCaptures.length; i++) {
    const methodCap = routeCaptures[i];
    const pathCap = routeCaptures[i + 1];
    if (methodCap?.name === 'method' && pathCap?.name === 'route_path') {
      const method = methodCap.text.toUpperCase();
      // Strip surrounding quotes from the string literal
      const rawPath = pathCap.text.replace(/^"|"$/g, '');
      routes.push({ method, path: rawPath, normalized: normalizeRoute(rawPath), file: filePath, line: methodCap.startRow + 1 });
      i++;
    }
  }

  return routes;
}

// ── Regex fallback: route extraction ─────────────────────────────────────────

function hasGoImport(content: string, packageSubstring: string): boolean {
  return content.includes(`"${packageSubstring}`) || content.includes(`_ "${packageSubstring}`);
}

function extractRoutesRegex(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  const ginRe = /(?:r|router|g|group|api|v\d)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g;
  while ((m = ginRe.exec(content)) !== null) {
    routes.push({ method: m[1]!, path: m[2]!, normalized: normalizeRoute(m[2]!), file: filePath, line: lineOf(content, m.index) });
  }
  const echoRe = /e\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g;
  while ((m = echoRe.exec(content)) !== null) {
    routes.push({ method: m[1]!, path: m[2]!, normalized: normalizeRoute(m[2]!), file: filePath, line: lineOf(content, m.index) });
  }
  const chiRe = /(?:r|router)\.(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g;
  while ((m = chiRe.exec(content)) !== null) {
    routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, normalized: normalizeRoute(m[2]!), file: filePath, line: lineOf(content, m.index) });
  }
  const handleRe = /(?:mux|router|http)\.HandleFunc\s*\(\s*"([^"]+)"/g;
  while ((m = handleRe.exec(content)) !== null) {
    routes.push({ method: '*', path: m[1]!, normalized: normalizeRoute(m[1]!), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── AST-based infrastructure detection ───────────────────────────────────────

function analyzeFileAst(content: string, filePath: string, componentName: string): FlowFact[] {
  const parser = makeParser('golang');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['golang'];

  // Collect imported packages using AST
  const importCaptures = parseAndQuery(parser, language, content, IMPORT_QUERY);
  const importedPkgs = new Set<string>();
  for (const c of importCaptures) {
    if (c.name === 'import_path') {
      // Strip surrounding quotes from interpreted_string_literal
      importedPkgs.add(c.text.replace(/^"|"$/g, ''));
    }
  }

  // Collect call expressions to detect definite usage
  const callCaptures = parseAndQuery(parser, language, content, CALL_QUERY);
  const callSignatures = new Set<string>();
  for (let i = 0; i < callCaptures.length; i++) {
    const recv = callCaptures[i];
    const fn = callCaptures[i + 1];
    if (recv?.name === 'receiver' && fn?.name === 'fn_name') {
      callSignatures.add(`${recv.text}.${fn.text}`);
      i++;
    } else if (recv?.name === 'fn_name') {
      callSignatures.add(recv.text);
    }
  }

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();

  for (const pkg of importedPkgs) {
    for (const [pkgPattern, infraNode] of PKG_TO_INFRA) {
      if (pkg.startsWith(pkgPattern) && !emitted.has(infraNode)) {
        const hasDefiniteCall = [...callSignatures].some(sig => {
          const mapped = CALL_TO_INFRA[sig];
          return mapped === infraNode;
        });
        // postgres:// URL is always definite evidence
        const hasPgUrl = infraNode === 'postgres' && /postgres(?:ql)?:\/\//.test(content);
        facts.push({
          from: componentName,
          to: infraNode,
          confidence: hasDefiniteCall || hasPgUrl ? 'definite' : 'probable',
          evidence: hasDefiniteCall ? `Imports '${pkgPattern}' and invokes client` : `Imports '${pkgPattern}'`,
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

function analyzeFileRegex(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  const hasPgDriver = hasGoImport(content, 'github.com/lib/pq') ||
    hasGoImport(content, 'github.com/jackc/pgx') ||
    content.includes('postgres://') || content.includes('postgresql://');
  const hasSql = hasGoImport(content, 'database/sql');
  const hasGorm = hasGoImport(content, 'gorm.io/gorm');

  if (hasPgDriver) facts.push({ from: componentName, to: 'postgres', confidence: 'definite', evidence: 'Imports PostgreSQL driver (lib/pq or pgx)', file: filePath });
  else if (hasSql && /sql\.Open\s*\(/.test(content)) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses database/sql with sql.Open', file: filePath });
  else if (hasGorm && /gorm\.Open\s*\(/.test(content)) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses GORM ORM', file: filePath });

  const hasMongo = hasGoImport(content, 'go.mongodb.org/mongo-driver');
  if (hasMongo) {
    const mongoUsage = /mongo\.Connect\s*\(|mongo\.NewClient\s*\(|\.Database\s*\(/.test(content);
    facts.push({ from: componentName, to: 'mongodb', confidence: mongoUsage ? 'definite' : 'probable', evidence: mongoUsage ? 'Uses mongo-driver and connects to MongoDB' : 'Imports mongo-driver', file: filePath });
  }

  const hasGoRedis = hasGoImport(content, 'github.com/go-redis/redis') || hasGoImport(content, 'github.com/redis/go-redis');
  if (hasGoRedis) {
    const redisUsage = /redis\.NewClient\s*\(|redis\.NewUniversalClient\s*\(/.test(content);
    facts.push({ from: componentName, to: 'redis', confidence: redisUsage ? 'definite' : 'probable', evidence: redisUsage ? 'Creates Redis client connection' : 'Imports go-redis', file: filePath });
  }

  const hasKafka = hasGoImport(content, 'github.com/confluentinc/confluent-kafka-go') || hasGoImport(content, 'github.com/segmentio/kafka-go') || hasGoImport(content, 'github.com/IBM/sarama') || hasGoImport(content, 'github.com/Shopify/sarama');
  if (hasKafka) facts.push({ from: componentName, to: 'message_queue', confidence: 'probable', evidence: 'Imports Kafka client library', file: filePath });

  const hasRabbit = hasGoImport(content, 'github.com/streadway/amqp') || hasGoImport(content, 'github.com/rabbitmq/amqp091-go');
  if (hasRabbit) facts.push({ from: componentName, to: 'message_queue', confidence: 'probable', evidence: 'Imports RabbitMQ AMQP client', file: filePath });

  const hasS3 = hasGoImport(content, 'github.com/aws/aws-sdk-go') || hasGoImport(content, 'github.com/aws/aws-sdk-go-v2/service/s3') || hasGoImport(content, 'github.com/minio/minio-go');
  if (hasS3) facts.push({ from: componentName, to: 'object_store', confidence: 'probable', evidence: 'Imports AWS SDK / MinIO object storage client', file: filePath });

  const hasHttpOut = /http\.(Get|Post|Do|NewRequest)\s*\(/.test(content) && !extractRoutesFromGo(content, filePath).length;
  if (hasHttpOut && !hasGorm && !hasSql) facts.push({ from: componentName, to: 'external_api', confidence: 'possible', evidence: 'Makes outgoing HTTP calls via net/http', file: filePath });

  return facts;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function extractRoutesFromGo(content: string, filePath: string): RouteFact[] {
  const astRoutes = extractRoutesAst(content, filePath);
  if (astRoutes.length > 0) return astRoutes;
  return extractRoutesRegex(content, filePath);
}

export const goPlugin: ExtractorPlugin = {
  name: 'Go AST/regex analyzer',
  extensions: ['.go'],
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
