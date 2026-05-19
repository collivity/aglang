// Python static analyzer — detects infrastructure flows and server-side routes.
// Handles: FastAPI, Flask, Django, aiohttp, plus SQLAlchemy, pymongo, redis, celery, etc.

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

// ── Server-side route extraction ─────────────────────────────────────────────

// FastAPI / Flask style:
//   @app.get("/path")   @router.post("/path/{id}")   @app.route("/path", methods=["GET"])
const DECORATOR_ROUTE_RE = /@(?:\w+\.)?(?:get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/gi;

// @app.route("/path", methods=["GET", "POST"])
const ROUTE_METHODS_RE = /@(?:\w+\.)?route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gi;

// Django: path("api/users/", view)  re_path(r"^api/users/$", view)
const DJANGO_PATH_RE = /(?:^|\s)(?:re_)?path\s*\(\s*r?["']([^"']+)["']/gm;

export function extractRoutesFromPython(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];

  // FastAPI-style method decorators
  let m: RegExpExecArray | null;
  const decoratorRe = /@(?:\w+\.)?(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  while ((m = decoratorRe.exec(content)) !== null) {
    const methodMatch = m[0].match(/\.(get|post|put|delete|patch)/i);
    const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'GET';
    const path = m[1]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // @app.route("/path", methods=["GET", "POST"])
  const routeMethodsRe = /@(?:\w+\.)?route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gi;
  while ((m = routeMethodsRe.exec(content)) !== null) {
    const path = m[1]!;
    const methodsRaw = m[2]!;
    const methods = [...methodsRaw.matchAll(/["'](\w+)["']/g)].map(mm => mm[1]!.toUpperCase());
    for (const method of methods.length > 0 ? methods : ['GET']) {
      routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
    }
  }

  // Django path() / re_path() — no method info available, emit as '*'
  const djangoRe = /(?:^|\s)(?:re_)?path\s*\(\s*r?["']([^"']+)["']/gm;
  while ((m = djangoRe.exec(content)) !== null) {
    let path = m[1]!;
    // Convert Django named captures (?P<name>...) → {}
    path = path.replace(/\(\?P<[^>]+>[^)]+\)/g, '{}').replace(/\^|\$/g, '');
    if (!path.startsWith('/')) path = '/' + path;
    routes.push({ method: '*', path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── Infrastructure flow detection ────────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // ── PostgreSQL ───────────────────────────────────────────────────────────
  const pgImport =
    /import\s+psycopg2|import\s+asyncpg|from\s+asyncpg|from\s+psycopg|sqlalchemy.*postgresql|postgresql\+psycopg|asyncpg:\/\//.test(content);
  const sqlalchemyImport = /from\s+sqlalchemy|import\s+sqlalchemy/.test(content);
  const sqlalchemyUsage = /create_engine\s*\(|Session\s*\(|sessionmaker\s*\(|AsyncSession/.test(content);

  if (pgImport) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'Imports Postgres-specific driver (psycopg2/asyncpg)',
      file: filePath,
    });
  } else if (sqlalchemyImport && sqlalchemyUsage) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Imports SQLAlchemy and creates session/engine — relational DB dependency',
      file: filePath,
    });
  }

  // ── MongoDB ──────────────────────────────────────────────────────────────
  const mongoImport = /import\s+pymongo|from\s+pymongo|from\s+motor|import\s+motor/.test(content);
  const mongoUsage = /MongoClient\s*\(|AsyncIOMotorClient\s*\(|\.get_database\s*\(/.test(content);
  if (mongoImport && mongoUsage) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'definite',
      evidence: 'Imports pymongo/motor and connects to MongoDB',
      file: filePath,
    });
  } else if (mongoImport) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'probable',
      evidence: 'Imports pymongo/motor',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const redisImport = /import\s+redis|from\s+redis|import\s+aioredis|from\s+aioredis/.test(content);
  const redisUsage = /redis\.Redis\s*\(|redis\.from_url\s*\(|aioredis\.from_url\s*\(|StrictRedis\s*\(/.test(content);
  if (redisImport && redisUsage) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'definite',
      evidence: 'Imports Redis client and creates connection',
      file: filePath,
    });
  } else if (redisImport) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'probable',
      evidence: 'Imports Redis client library',
      file: filePath,
    });
  }

  // ── Message Queue / Celery / Kafka ───────────────────────────────────────
  const celeryImport = /from\s+celery|import\s+celery/.test(content);
  const celeryUsage = /Celery\s*\(|@(?:celery_app|app|shared_task)\.task|\.delay\s*\(|\.apply_async\s*\(/.test(content);
  if (celeryImport && celeryUsage) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'definite',
      evidence: 'Uses Celery task queue',
      file: filePath,
    });
  }

  const kafkaImport = /from\s+kafka|import\s+kafka|from\s+confluent_kafka|import\s+confluent_kafka/.test(content);
  if (kafkaImport) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Imports Kafka client library',
      file: filePath,
    });
  }

  // ── Object Storage ───────────────────────────────────────────────────────
  const s3Import = /import\s+boto3|from\s+boto3|import\s+minio|from\s+minio/.test(content);
  const s3Usage = /boto3\.client\s*\(\s*['"]s3['"]|boto3\.resource\s*\(\s*['"]s3['"]|Minio\s*\(/.test(content);
  if (s3Import && s3Usage) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'definite',
      evidence: 'Uses boto3/minio object storage client',
      file: filePath,
    });
  } else if (s3Import) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'probable',
      evidence: 'Imports boto3/minio (object storage)',
      file: filePath,
    });
  }

  // ── External HTTP (outgoing) ─────────────────────────────────────────────
  const httpImport = /import\s+requests|from\s+requests|import\s+httpx|from\s+httpx/.test(content);
  const httpUsage = /requests\.(get|post|put|delete|patch|request)\s*\(|httpx\.(get|post|put|delete|AsyncClient|Client)\s*\(/.test(content);
  if (httpImport && httpUsage) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Makes outgoing HTTP calls via requests/httpx — target architecture node unknown',
      file: filePath,
    });
  }

  return facts;
}

export const pythonPlugin: ExtractorPlugin = {
  name: 'Python regex analyzer',
  extensions: ['.py', '.pyw'],
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
