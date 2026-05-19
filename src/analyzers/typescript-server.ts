// TypeScript/JavaScript server-side analyzer — detects Express/NestJS routes and infrastructure.
// Complements typescript.ts (which handles client-side fetch calls).
// Uses tree-sitter AST when available, falls back to regex silently.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter } from './ast/loader.ts';
import { parseAndQuery } from './ast/walker.ts';
import {
  IMPORT_QUERY, IMPORT_NAMED_QUERY, EXPRESS_ROUTE_QUERY,
  NESTJS_CONTROLLER_QUERY, NESTJS_METHOD_QUERY, NEW_EXPR_QUERY, REQUIRE_QUERY,
} from './ast/queries/typescript.ts';

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

// Maps npm package name (or substring) to the logical infrastructure node name.
const PKG_TO_INFRA: Array<[string | RegExp, string]> = [
  ['pg', 'postgres'],
  ['@prisma/client', 'relational_db'],
  ['drizzle-orm', 'relational_db'],
  ['mongoose', 'mongodb'],
  ['mongodb', 'mongodb'],
  ['redis', 'redis'],
  ['ioredis', 'redis'],
  ['kafkajs', 'message_queue'],
  ['amqplib', 'message_queue'],
  ['@aws-sdk/client-s3', 'object_store'],
  ['aws-sdk', 'object_store'],
  ['axios', 'external_api'],
  ['got', 'external_api'],
  ['node-fetch', 'external_api'],
  ['undici', 'external_api'],
];

// Constructor / class names that signal infra usage (resolved from symbol map).
const CLASS_TO_INFRA: Record<string, string> = {
  Pool: 'postgres',
  Client: 'postgres', // pg.Client
  PrismaClient: 'relational_db',
  MongoClient: 'mongodb',
  Db: 'mongodb',
  Redis: 'redis',
  Kafka: 'message_queue',
  Producer: 'message_queue',
  Consumer: 'message_queue',
  S3Client: 'object_store',
  S3: 'object_store',
};

// ── AST-based route extraction ───────────────────────────────────────────────

function extractRoutesAst(content: string, filePath: string, lang: 'typescript' | 'javascript'): RouteFact[] {
  const parser = makeParser(lang);
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts[lang];

  const routes: RouteFact[] = [];

  // Express-style: app.get('/path', ...)
  const expressCaptures = parseAndQuery(parser, language, content, EXPRESS_ROUTE_QUERY);
  for (let i = 0; i < expressCaptures.length - 1; i++) {
    const methodCap = expressCaptures[i];
    const pathCap = expressCaptures[i + 1];
    if (methodCap?.name === 'method' && pathCap?.name === 'route_path') {
      const method = methodCap.text.toUpperCase();
      const path = pathCap.text;
      routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: methodCap.startRow + 1 });
      i++; // skip pathCap
    }
  }

  // NestJS: gather controller prefix then method decorators
  const ctrlCaptures = parseAndQuery(parser, language, content, NESTJS_CONTROLLER_QUERY);
  const controllerPrefix = ctrlCaptures.find(c => c.name === 'controller_prefix')?.text ?? '';

  const methodCaptures = parseAndQuery(parser, language, content, NESTJS_METHOD_QUERY);
  for (let i = 0; i < methodCaptures.length; i++) {
    const cap = methodCaptures[i]!;
    if (cap.name === 'http_method') {
      const method = cap.text.toUpperCase();
      const nextCap = methodCaptures[i + 1];
      const subPath = (nextCap?.name === 'route_suffix') ? nextCap.text : '';
      if (nextCap?.name === 'route_suffix') i++;
      const path = ('/' + controllerPrefix + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: cap.startRow + 1 });
    }
  }

  return routes;
}

// ── Regex-based route extraction (fallback) ───────────────────────────────────

function extractRoutesRegex(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  const expressRe = /(?:app|router|server)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((m = expressRe.exec(content)) !== null) {
    routes.push({ method: m[1]!.toUpperCase(), path: m[2]!, normalized: normalizeRoute(m[2]!), file: filePath, line: lineOf(content, m.index) });
  }

  let controllerPrefix = '';
  const controllerMatch = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/.exec(content);
  if (controllerMatch) controllerPrefix = controllerMatch[1]!;

  const nestMethodRe = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
  while ((m = nestMethodRe.exec(content)) !== null) {
    const subPath = m[2] ?? '';
    const path = ('/' + controllerPrefix + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    routes.push({ method: m[1]!.toUpperCase(), path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  return routes;
}

// ── Public: route extraction ──────────────────────────────────────────────────

export function extractServerRoutesFromTypeScript(content: string, filePath: string): RouteFact[] {
  const lang = filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')
    ? 'javascript' : 'typescript';
  const astRoutes = extractRoutesAst(content, filePath, lang);
  if (astRoutes.length > 0) return astRoutes;
  // Fall back to regex if AST produced nothing (tree-sitter unavailable or empty file)
  return extractRoutesRegex(content, filePath);
}

// ── AST-based infrastructure detection ───────────────────────────────────────

function analyzeFileAst(content: string, filePath: string, componentName: string): FlowFact[] {
  const lang: 'typescript' | 'javascript' = filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')
    ? 'javascript' : 'typescript';
  const parser = makeParser(lang);
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts[lang];

  // Build symbol map: importedName → pkg  (handles aliased imports)
  const symbolMap = new Map<string, string>(); // className → pkg
  const importedPkgs = new Set<string>();

  // Named imports: import { MongoClient } from 'mongodb'
  const namedCaptures = parseAndQuery(parser, language, content, IMPORT_NAMED_QUERY);
  for (let i = 0; i < namedCaptures.length; i++) {
    const c = namedCaptures[i]!;
    if (c.name === 'import_name') {
      const alias = namedCaptures[i + 1];
      const moduleCap = alias?.name === 'import_alias' ? namedCaptures[i + 2] : namedCaptures[i + 1];
      const symbolName = alias?.name === 'import_alias' ? alias.text : c.text;
      if (moduleCap?.name === 'module_specifier') {
        symbolMap.set(symbolName, moduleCap.text);
        importedPkgs.add(moduleCap.text);
      }
    }
  }

  // All imports (including default + namespace)
  const importCaptures = parseAndQuery(parser, language, content, IMPORT_QUERY);
  for (const c of importCaptures) {
    if (c.name === 'module_specifier') importedPkgs.add(c.text);
  }

  // require() calls
  const requireCaptures = parseAndQuery(parser, language, content, REQUIRE_QUERY);
  for (const c of requireCaptures) {
    if (c.name === 'module_specifier') importedPkgs.add(c.text);
  }

  // new expressions: new MongoClient(...)
  const newCaptures = parseAndQuery(parser, language, content, NEW_EXPR_QUERY);
  const instantiatedClasses = new Set(newCaptures.filter(c => c.name === 'class_name').map(c => c.text));

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();

  // Check imported packages against PKG_TO_INFRA
  for (const pkg of importedPkgs) {
    for (const [pattern, infraNode] of PKG_TO_INFRA) {
      const matches = typeof pattern === 'string' ? pkg === pattern || pkg.startsWith(pattern + '/') : pattern.test(pkg);
      if (matches && !emitted.has(infraNode)) {
        // Determine confidence: if a known class from this pkg was also instantiated, it's definite
        const classesFromPkg = [...symbolMap.entries()].filter(([, p]) => p === pkg).map(([k]) => k);
        const hasInstantiation = classesFromPkg.some(cls => instantiatedClasses.has(cls)) ||
          [...instantiatedClasses].some(cls => CLASS_TO_INFRA[cls] === infraNode);
        const isUrlPattern = /postgres(?:ql)?:\/\//.test(content);
        facts.push({
          from: componentName,
          to: infraNode,
          confidence: hasInstantiation || isUrlPattern ? 'definite' : 'probable',
          evidence: hasInstantiation
            ? `Imports '${pkg}' and instantiates client class`
            : `Imports '${pkg}'`,
          file: filePath,
        });
        emitted.add(infraNode);
        break;
      }
    }
  }

  return facts;
}

// ── Regex-based infrastructure detection (fallback) ───────────────────────────

function analyzeFileRegex(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  const hasPg = /require\s*\(\s*['"]pg['"]\)|from\s+['"]pg['"]|from\s+['"]@prisma\/client['"]/i.test(content) ||
    /new\s+Pool\s*\(|pg\.Pool\s*\(|pgPool/.test(content);
  const hasPrisma = /PrismaClient|from\s+['"]@prisma\/client['"]/.test(content);
  const hasPostgresUrl = /postgres(?:ql)?:\/\//.test(content);

  if (hasPg || hasPostgresUrl) {
    const isExplicit = /new\s+Pool\s*\(|createPool\s*\(|postgres(?:ql)?:\/\//.test(content);
    facts.push({ from: componentName, to: 'postgres', confidence: isExplicit ? 'definite' : 'probable', evidence: isExplicit ? 'Creates PostgreSQL connection pool' : 'Imports pg driver', file: filePath });
  } else if (hasPrisma) {
    facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses Prisma ORM (DB type from schema, not inferred here)', file: filePath });
  }

  const hasDrizzle = /from\s+['"]drizzle-orm/.test(content);
  if (hasDrizzle) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses Drizzle ORM — relational DB dependency', file: filePath });

  const hasMongo = /require\s*\(\s*['"]mongoose['"]\)|from\s+['"]mongoose['"]/.test(content) || /require\s*\(\s*['"]mongodb['"]\)|from\s+['"]mongodb['"]/.test(content);
  const mongoUsage = /mongoose\.connect\s*\(|MongoClient\.connect\s*\(|new\s+MongoClient\s*\(/.test(content);
  if (hasMongo && mongoUsage) facts.push({ from: componentName, to: 'mongodb', confidence: 'definite', evidence: 'Imports mongoose/mongodb and connects to MongoDB', file: filePath });
  else if (hasMongo) facts.push({ from: componentName, to: 'mongodb', confidence: 'probable', evidence: 'Imports mongoose/mongodb driver', file: filePath });

  const hasRedis = /require\s*\(\s*['"]redis['"]\)|from\s+['"]redis['"]/.test(content) || /require\s*\(\s*['"]ioredis['"]\)|from\s+['"]ioredis['"]/.test(content);
  const redisUsage = /redis\.createClient\s*\(|new\s+Redis\s*\(|createClient\s*\(/.test(content);
  if (hasRedis && redisUsage) facts.push({ from: componentName, to: 'redis', confidence: 'definite', evidence: 'Creates Redis client connection', file: filePath });
  else if (hasRedis) facts.push({ from: componentName, to: 'redis', confidence: 'probable', evidence: 'Imports Redis client library', file: filePath });

  const hasKafkaJs = /require\s*\(\s*['"]kafkajs['"]\)|from\s+['"]kafkajs['"]/.test(content);
  const hasAmqp = /require\s*\(\s*['"]amqplib['"]\)|from\s+['"]amqplib['"]/.test(content);
  if (hasKafkaJs) {
    const kafkaUsage = /new\s+Kafka\s*\(|kafka\.producer\s*\(|kafka\.consumer\s*\(/.test(content);
    facts.push({ from: componentName, to: 'message_queue', confidence: kafkaUsage ? 'definite' : 'probable', evidence: kafkaUsage ? 'Creates Kafka producer/consumer' : 'Imports kafkajs', file: filePath });
  }
  if (hasAmqp) facts.push({ from: componentName, to: 'message_queue', confidence: 'probable', evidence: 'Imports amqplib (RabbitMQ)', file: filePath });

  const hasS3 = /from\s+['"]@aws-sdk\/client-s3['"]|require\s*\(\s*['"]aws-sdk['"]\)/.test(content);
  const s3Usage = /new\s+S3Client\s*\(|new\s+S3\s*\(|s3\.upload\s*\(/.test(content);
  if (hasS3 && s3Usage) facts.push({ from: componentName, to: 'object_store', confidence: 'definite', evidence: 'Creates AWS S3 client', file: filePath });
  else if (hasS3) facts.push({ from: componentName, to: 'object_store', confidence: 'probable', evidence: 'Imports AWS SDK (S3 client)', file: filePath });

  const hasAxios = /from\s+['"]axios['"]|require\s*\(\s*['"]axios['"]\)/.test(content);
  const hasGot = /from\s+['"]got['"]|from\s+['"]node-fetch['"]|from\s+['"]undici['"]/.test(content);
  if (hasAxios || hasGot) facts.push({ from: componentName, to: 'external_api', confidence: 'possible', evidence: 'Uses axios/got/node-fetch — outgoing HTTP calls (target unknown)', file: filePath });

  return facts;
}

// ── Unified infrastructure analysis ──────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const astFacts = analyzeFileAst(content, filePath, componentName);
  if (astFacts.length > 0) return astFacts;
  return analyzeFileRegex(content, filePath, componentName);
}

export const typescriptServerPlugin: ExtractorPlugin = {
  name: 'TypeScript/Node.js server analyzer',
  extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'],
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
