// Python static analyzer — detects infrastructure flows and server-side routes.
// Handles: FastAPI, Flask, Django, aiohttp, plus SQLAlchemy, pymongo, redis, celery, etc.
// Uses tree-sitter AST when available, falls back to regex silently.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter } from './ast/loader.ts';
import { parseAndQuery } from './ast/walker.ts';
import {
  IMPORT_QUERY, IMPORT_ALIAS_QUERY, FROM_IMPORT_QUERY,
  DECORATOR_ROUTE_QUERY, FLASK_ROUTE_QUERY, DJANGO_PATH_QUERY, CALL_EXPR_QUERY,
} from './ast/queries/python.ts';

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

// ── Package-to-infra mapping for Python ──────────────────────────────────────

const MODULE_TO_INFRA: Array<[string | RegExp, string]> = [
  [/^(psycopg2|asyncpg|psycopg)/, 'postgres'],
  [/^sqlalchemy/, 'relational_db'],
  [/^(pymongo|motor)/, 'mongodb'],
  [/^(redis|aioredis)/, 'redis'],
  [/^celery/, 'message_queue'],
  [/^(kafka|confluent_kafka)/, 'message_queue'],
  [/^(boto3|minio)/, 'object_store'],
  [/^(requests|httpx|aiohttp)/, 'external_api'],
];

// Function/class names that signal infra usage (called after import tracking)
const CALL_TO_INFRA: Record<string, string> = {
  MongoClient: 'mongodb',
  AsyncIOMotorClient: 'mongodb',
  create_engine: 'relational_db',
  sessionmaker: 'relational_db',
  Session: 'relational_db',
  AsyncSession: 'relational_db',
  Redis: 'redis',
  StrictRedis: 'redis',
  Celery: 'message_queue',
  Producer: 'message_queue',
  Consumer: 'message_queue',
  Minio: 'object_store',
};

// ── AST-based route extraction ────────────────────────────────────────────────

function extractRoutesAst(content: string, filePath: string): RouteFact[] {
  const parser = makeParser('python');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['python'];
  const routes: RouteFact[] = [];

  // FastAPI/Flask method decorators: @app.get("/path")
  const decoratorCaptures = parseAndQuery(parser, language, content, DECORATOR_ROUTE_QUERY);
  for (let i = 0; i < decoratorCaptures.length - 1; i++) {
    const methodCap = decoratorCaptures[i];
    const pathCap = decoratorCaptures[i + 1];
    if (methodCap?.name === 'decorator_method' && pathCap?.name === 'route_path') {
      routes.push({ method: methodCap.text.toUpperCase(), path: pathCap.text, normalized: normalizeRoute(pathCap.text), file: filePath, line: methodCap.startRow + 1 });
      i++;
    }
  }

  // Flask @app.route("/path")
  const flaskCaptures = parseAndQuery(parser, language, content, FLASK_ROUTE_QUERY);
  for (const c of flaskCaptures) {
    if (c.name === 'route_path') {
      routes.push({ method: 'GET', path: c.text, normalized: normalizeRoute(c.text), file: filePath, line: c.startRow + 1 });
    }
  }

  // Django path("/url", view)
  const djangoCaptures = parseAndQuery(parser, language, content, DJANGO_PATH_QUERY);
  for (const c of djangoCaptures) {
    if (c.name === 'route_path') {
      let path = c.text.replace(/\(\?P<[^>]+>[^)]+\)/g, '{}').replace(/\^|\$/g, '');
      if (!path.startsWith('/')) path = '/' + path;
      routes.push({ method: '*', path, normalized: normalizeRoute(path), file: filePath, line: c.startRow + 1 });
    }
  }

  return routes;
}

// ── AST-based infrastructure detection ───────────────────────────────────────

function analyzeFileAst(content: string, filePath: string, componentName: string): FlowFact[] {
  const parser = makeParser('python');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['python'];

  const importedModules = new Set<string>();
  const symbolMap = new Map<string, string>(); // symbol/alias → module
  const calledFunctions = new Set<string>();

  // import X  /  import X as alias
  const importCaptures = parseAndQuery(parser, language, content, IMPORT_QUERY);
  for (const c of importCaptures) {
    if (c.name === 'module_name') importedModules.add(c.text.split('.')[0]!);
  }

  const aliasCaptures = parseAndQuery(parser, language, content, IMPORT_ALIAS_QUERY);
  for (let i = 0; i < aliasCaptures.length - 1; i++) {
    const mod = aliasCaptures[i];
    const alias = aliasCaptures[i + 1];
    if (mod?.name === 'module_name' && alias?.name === 'alias') {
      symbolMap.set(alias.text, mod.text.split('.')[0]!);
      importedModules.add(mod.text.split('.')[0]!);
      i++;
    }
  }

  // from X import Y
  const fromCaptures = parseAndQuery(parser, language, content, FROM_IMPORT_QUERY);
  for (const c of fromCaptures) {
    if (c.name === 'module_name') importedModules.add(c.text.split('.')[0]!);
    if (c.name === 'import_name') calledFunctions.add(c.text.split('.').pop()!);
  }

  // Call expressions to detect infra usage
  const callCaptures = parseAndQuery(parser, language, content, CALL_EXPR_QUERY);
  for (const c of callCaptures) {
    if (c.name === 'fn_name') calledFunctions.add(c.text);
  }

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();

  for (const module of importedModules) {
    for (const [pattern, infraNode] of MODULE_TO_INFRA) {
      const matches = typeof pattern === 'string' ? module === pattern : pattern.test(module);
      if (matches && !emitted.has(infraNode)) {
        const hasUsage = [...calledFunctions].some(fn => CALL_TO_INFRA[fn] === infraNode);
        facts.push({
          from: componentName,
          to: infraNode,
          confidence: hasUsage ? 'definite' : 'probable',
          evidence: hasUsage ? `Imports '${module}' and invokes client` : `Imports '${module}'`,
          file: filePath,
        });
        emitted.add(infraNode);
        break;
      }
    }
  }

  return facts;
}

// ── Regex fallback: route extraction ─────────────────────────────────────────

function extractRoutesRegex(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  const decoratorRe = /@(?:\w+\.)?(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  while ((m = decoratorRe.exec(content)) !== null) {
    const methodMatch = m[0].match(/\.(get|post|put|delete|patch)/i);
    const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'GET';
    const path = m[1]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  const routeMethodsRe = /@(?:\w+\.)?route\s*\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gi;
  while ((m = routeMethodsRe.exec(content)) !== null) {
    const path = m[1]!;
    const methods = [...m[2]!.matchAll(/["'](\w+)["']/g)].map(mm => mm[1]!.toUpperCase());
    for (const method of methods.length > 0 ? methods : ['GET']) {
      routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
    }
  }

  const djangoRe = /(?:^|\s)(?:re_)?path\s*\(\s*r?["']([^"']+)["']/gm;
  while ((m = djangoRe.exec(content)) !== null) {
    let path = m[1]!.replace(/\(\?P<[^>]+>[^)]+\)/g, '{}').replace(/\^|\$/g, '');
    if (!path.startsWith('/')) path = '/' + path;
    routes.push({ method: '*', path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── Regex fallback: infrastructure detection ──────────────────────────────────

function analyzeFileRegex(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  const pgImport = /import\s+psycopg2|import\s+asyncpg|from\s+asyncpg|from\s+psycopg|sqlalchemy.*postgresql|postgresql\+psycopg|asyncpg:\/\//.test(content);
  const sqlalchemyImport = /from\s+sqlalchemy|import\s+sqlalchemy/.test(content);
  const sqlalchemyUsage = /create_engine\s*\(|Session\s*\(|sessionmaker\s*\(|AsyncSession/.test(content);

  if (pgImport) facts.push({ from: componentName, to: 'postgres', confidence: 'definite', evidence: 'Imports Postgres-specific driver (psycopg2/asyncpg)', file: filePath });
  else if (sqlalchemyImport && sqlalchemyUsage) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Imports SQLAlchemy and creates session/engine', file: filePath });

  const mongoImport = /import\s+pymongo|from\s+pymongo|from\s+motor|import\s+motor/.test(content);
  const mongoUsage = /MongoClient\s*\(|AsyncIOMotorClient\s*\(|\.get_database\s*\(/.test(content);
  if (mongoImport && mongoUsage) facts.push({ from: componentName, to: 'mongodb', confidence: 'definite', evidence: 'Imports pymongo/motor and connects to MongoDB', file: filePath });
  else if (mongoImport) facts.push({ from: componentName, to: 'mongodb', confidence: 'probable', evidence: 'Imports pymongo/motor', file: filePath });

  const redisImport = /import\s+redis|from\s+redis|import\s+aioredis|from\s+aioredis/.test(content);
  const redisUsage = /redis\.Redis\s*\(|redis\.from_url\s*\(|aioredis\.from_url\s*\(|StrictRedis\s*\(/.test(content);
  if (redisImport && redisUsage) facts.push({ from: componentName, to: 'redis', confidence: 'definite', evidence: 'Creates Redis connection', file: filePath });
  else if (redisImport) facts.push({ from: componentName, to: 'redis', confidence: 'probable', evidence: 'Imports Redis client library', file: filePath });

  const celeryImport = /from\s+celery|import\s+celery/.test(content);
  const celeryUsage = /Celery\s*\(|@(?:celery_app|app|shared_task)\.task|\.delay\s*\(|\.apply_async\s*\(/.test(content);
  if (celeryImport && celeryUsage) facts.push({ from: componentName, to: 'message_queue', confidence: 'definite', evidence: 'Uses Celery task queue', file: filePath });

  const kafkaImport = /from\s+kafka|import\s+kafka|from\s+confluent_kafka|import\s+confluent_kafka/.test(content);
  if (kafkaImport) facts.push({ from: componentName, to: 'message_queue', confidence: 'probable', evidence: 'Imports Kafka client library', file: filePath });

  const s3Import = /import\s+boto3|from\s+boto3|import\s+minio|from\s+minio/.test(content);
  const s3Usage = /boto3\.client\s*\(\s*['"]s3['"]|boto3\.resource\s*\(\s*['"]s3['"]|Minio\s*\(/.test(content);
  if (s3Import && s3Usage) facts.push({ from: componentName, to: 'object_store', confidence: 'definite', evidence: 'Uses boto3/minio object storage client', file: filePath });
  else if (s3Import) facts.push({ from: componentName, to: 'object_store', confidence: 'probable', evidence: 'Imports boto3/minio (object storage)', file: filePath });

  const httpImport = /import\s+requests|from\s+requests|import\s+httpx|from\s+httpx/.test(content);
  const httpUsage = /requests\.(get|post|put|delete|patch|request)\s*\(|httpx\.(get|post|put|delete|AsyncClient|Client)\s*\(/.test(content);
  if (httpImport && httpUsage) facts.push({ from: componentName, to: 'external_api', confidence: 'possible', evidence: 'Makes outgoing HTTP calls via requests/httpx', file: filePath });

  return facts;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function extractRoutesFromPython(content: string, filePath: string): RouteFact[] {
  const astRoutes = extractRoutesAst(content, filePath);
  if (astRoutes.length > 0) return astRoutes;
  return extractRoutesRegex(content, filePath);
}

export const pythonPlugin: ExtractorPlugin = {
  name: 'Python AST/regex analyzer',
  extensions: ['.py', '.pyw'],
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
