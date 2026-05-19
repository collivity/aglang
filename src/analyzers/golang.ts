// Go static analyzer — detects infrastructure flows and server-side routes.
// Handles: Gin, Echo, gorilla/mux, net/http, plus database/sql, GORM, mongo, redis, kafka.

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

// ── Import block parser ───────────────────────────────────────────────────────
// Go imports can be: import "x"  OR  import ( "x" \n "y" )
// We need to detect which packages are imported before pattern-matching usage.

function hasGoImport(content: string, packageSubstring: string): boolean {
  // Matches inside import blocks and single-line imports
  return content.includes(`"${packageSubstring}`) || content.includes(`_ "${packageSubstring}`);
}

// ── Server-side route extraction ─────────────────────────────────────────────

const GIN_ROUTE_RE = /(?:r|router|g|group|v\d?)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g;
const ECHO_ROUTE_RE = /e\.(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g;
const GORILLA_ROUTE_RE = /(?:r|router|mux)\.(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/g;
const NETHTTP_ROUTE_RE = /http\.HandleFunc\s*\(\s*"([^"]+)"/g;
const CHI_ROUTE_RE = /(?:r|router)\.(?:Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*"([^"]+)"/g;

export function extractRoutesFromGo(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  // Gin: r.GET("/path", handler)
  const ginRe = /(?:r|router|g|group|api|v\d)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g;
  while ((m = ginRe.exec(content)) !== null) {
    const method = m[1]!;
    const path = m[2]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // Echo: e.GET("/path", handler)
  const echoRe = /e\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g;
  while ((m = echoRe.exec(content)) !== null) {
    const method = m[1]!;
    const path = m[2]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // chi: r.Get("/path", handler)
  const chiRe = /(?:r|router)\.(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g;
  while ((m = chiRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const path = m[2]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // gorilla/mux and net/http HandleFunc: no method info
  const handleRe = /(?:mux|router|http)\.HandleFunc\s*\(\s*"([^"]+)"/g;
  while ((m = handleRe.exec(content)) !== null) {
    const path = m[1]!;
    routes.push({ method: '*', path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── Infrastructure flow detection ────────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // ── PostgreSQL ───────────────────────────────────────────────────────────
  const hasPgDriver = hasGoImport(content, 'github.com/lib/pq') ||
    hasGoImport(content, 'github.com/jackc/pgx') ||
    content.includes('postgres://') || content.includes('postgresql://');
  const hasSql = hasGoImport(content, 'database/sql');
  const hasGorm = hasGoImport(content, 'gorm.io/gorm');

  if (hasPgDriver) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'Imports PostgreSQL-specific driver (lib/pq or pgx)',
      file: filePath,
    });
  } else if (hasSql && /sql\.Open\s*\(/.test(content)) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses database/sql with sql.Open — relational DB dependency (driver unknown)',
      file: filePath,
    });
  } else if (hasGorm && /gorm\.Open\s*\(/.test(content)) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses GORM ORM — relational DB dependency (driver unknown from import alone)',
      file: filePath,
    });
  }

  // ── MongoDB ──────────────────────────────────────────────────────────────
  const hasMongo = hasGoImport(content, 'go.mongodb.org/mongo-driver');
  if (hasMongo) {
    const mongoUsage = /mongo\.Connect\s*\(|mongo\.NewClient\s*\(|\.Database\s*\(/.test(content);
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: mongoUsage ? 'definite' : 'probable',
      evidence: mongoUsage
        ? 'Uses mongo-driver and connects to MongoDB'
        : 'Imports mongo-driver',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const hasGoRedis = hasGoImport(content, 'github.com/go-redis/redis') ||
    hasGoImport(content, 'github.com/redis/go-redis');
  if (hasGoRedis) {
    const redisUsage = /redis\.NewClient\s*\(|redis\.NewUniversalClient\s*\(|redis\.NewClusterClient\s*\(/.test(content);
    facts.push({
      from: componentName, to: 'redis',
      confidence: redisUsage ? 'definite' : 'probable',
      evidence: redisUsage ? 'Creates Redis client connection' : 'Imports go-redis client',
      file: filePath,
    });
  }

  // ── Message Queue / Kafka ────────────────────────────────────────────────
  const hasKafka = hasGoImport(content, 'github.com/confluentinc/confluent-kafka-go') ||
    hasGoImport(content, 'github.com/segmentio/kafka-go') ||
    hasGoImport(content, 'github.com/IBM/sarama') ||
    hasGoImport(content, 'github.com/Shopify/sarama');
  if (hasKafka) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Imports Kafka client library',
      file: filePath,
    });
  }

  const hasRabbit = hasGoImport(content, 'github.com/streadway/amqp') ||
    hasGoImport(content, 'github.com/rabbitmq/amqp091-go');
  if (hasRabbit) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Imports RabbitMQ AMQP client',
      file: filePath,
    });
  }

  // ── Object Storage ───────────────────────────────────────────────────────
  const hasS3 = hasGoImport(content, 'github.com/aws/aws-sdk-go') ||
    hasGoImport(content, 'github.com/aws/aws-sdk-go-v2/service/s3') ||
    hasGoImport(content, 'github.com/minio/minio-go');
  if (hasS3) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'probable',
      evidence: 'Imports AWS SDK / MinIO object storage client',
      file: filePath,
    });
  }

  // ── External HTTP (outgoing) ─────────────────────────────────────────────
  // net/http is part of stdlib, so we check for outgoing usage patterns specifically
  const hasHttpOut = /http\.(Get|Post|Do|NewRequest)\s*\(/.test(content) && !extractRoutesFromGo(content, filePath).length;
  if (hasHttpOut && !hasGorm && !hasSql) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Makes outgoing HTTP calls via net/http — target unknown',
      file: filePath,
    });
  }

  return facts;
}

export const goPlugin: ExtractorPlugin = {
  name: 'Go regex analyzer',
  extensions: ['.go'],
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
