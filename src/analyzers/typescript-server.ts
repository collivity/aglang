// TypeScript/JavaScript server-side analyzer — detects Express/NestJS routes and infrastructure.
// Complements typescript.ts (which handles client-side fetch calls).

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

export function extractServerRoutesFromTypeScript(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  // Express/Fastify: app.get('/path', handler)  router.post('/path', handler)
  const expressRe = /(?:app|router|server)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((m = expressRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const path = m[2]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // NestJS: @Get('/path')  @Post('/path')  @Controller('/prefix')
  // First collect class-level @Controller prefix
  let controllerPrefix = '';
  const controllerRe = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/;
  const controllerMatch = controllerRe.exec(content);
  if (controllerMatch) {
    controllerPrefix = controllerMatch[1]!;
  }

  const nestMethodRe = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
  while ((m = nestMethodRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const subPath = m[2] ?? '';
    const path = ('/' + controllerPrefix + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // Hono: app.get('/path', handler)  — same as Express pattern above, already covered

  return routes;
}

// ── Infrastructure flow detection ────────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // ── PostgreSQL ───────────────────────────────────────────────────────────
  const hasPg = /require\s*\(\s*['"]pg['"]\)|from\s+['"]pg['"]|from\s+['"]@prisma\/client['"]/i.test(content) ||
    /new\s+Pool\s*\(|pg\.Pool\s*\(|pgPool/.test(content);
  const hasPrisma = /PrismaClient|from\s+['"]@prisma\/client['"]/.test(content);
  const hasPostgresUrl = /postgres(?:ql)?:\/\//.test(content);

  if (hasPg || hasPostgresUrl) {
    const isExplicit = /new\s+Pool\s*\(|createPool\s*\(|postgres(?:ql)?:\/\//.test(content);
    facts.push({
      from: componentName, to: 'postgres',
      confidence: isExplicit ? 'definite' : 'probable',
      evidence: isExplicit ? 'Creates PostgreSQL connection pool' : 'Imports pg driver',
      file: filePath,
    });
  } else if (hasPrisma) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses Prisma ORM (DB type from schema, not inferred here)',
      file: filePath,
    });
  }

  // Drizzle ORM
  const hasDrizzle = /from\s+['"]drizzle-orm/.test(content);
  if (hasDrizzle) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses Drizzle ORM — relational DB dependency',
      file: filePath,
    });
  }

  // ── MongoDB ──────────────────────────────────────────────────────────────
  const hasMongo = /require\s*\(\s*['"]mongoose['"]\)|from\s+['"]mongoose['"]/.test(content) ||
    /require\s*\(\s*['"]mongodb['"]\)|from\s+['"]mongodb['"]/.test(content);
  const mongoUsage = /mongoose\.connect\s*\(|MongoClient\.connect\s*\(|new\s+MongoClient\s*\(/.test(content);
  if (hasMongo && mongoUsage) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'definite',
      evidence: 'Imports mongoose/mongodb and connects to MongoDB',
      file: filePath,
    });
  } else if (hasMongo) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'probable',
      evidence: 'Imports mongoose/mongodb driver',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const hasRedis = /require\s*\(\s*['"]redis['"]\)|from\s+['"]redis['"]/.test(content) ||
    /require\s*\(\s*['"]ioredis['"]\)|from\s+['"]ioredis['"]/.test(content);
  const redisUsage = /redis\.createClient\s*\(|new\s+Redis\s*\(|createClient\s*\(/.test(content);
  if (hasRedis && redisUsage) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'definite',
      evidence: 'Creates Redis client connection',
      file: filePath,
    });
  } else if (hasRedis) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'probable',
      evidence: 'Imports Redis client library',
      file: filePath,
    });
  }

  // ── Message Queue / Kafka ────────────────────────────────────────────────
  const hasKafkaJs = /require\s*\(\s*['"]kafkajs['"]\)|from\s+['"]kafkajs['"]/.test(content);
  const hasAmqp = /require\s*\(\s*['"]amqplib['"]\)|from\s+['"]amqplib['"]/.test(content);
  if (hasKafkaJs) {
    const kafkaUsage = /new\s+Kafka\s*\(|kafka\.producer\s*\(|kafka\.consumer\s*\(/.test(content);
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: kafkaUsage ? 'definite' : 'probable',
      evidence: kafkaUsage ? 'Creates Kafka producer/consumer' : 'Imports kafkajs',
      file: filePath,
    });
  }
  if (hasAmqp) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Imports amqplib (RabbitMQ)',
      file: filePath,
    });
  }

  // ── Object Storage ───────────────────────────────────────────────────────
  const hasS3 = /from\s+['"]@aws-sdk\/client-s3['"]|require\s*\(\s*['"]aws-sdk['"]\)/.test(content);
  const s3Usage = /new\s+S3Client\s*\(|new\s+S3\s*\(|s3\.upload\s*\(/.test(content);
  if (hasS3 && s3Usage) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'definite',
      evidence: 'Creates AWS S3 client',
      file: filePath,
    });
  } else if (hasS3) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'probable',
      evidence: 'Imports AWS SDK (S3 client)',
      file: filePath,
    });
  }

  // ── External HTTP (outgoing) ─────────────────────────────────────────────
  const hasAxios = /from\s+['"]axios['"]|require\s*\(\s*['"]axios['"]\)/.test(content);
  const hasGot = /from\s+['"]got['"]|from\s+['"]node-fetch['"]|from\s+['"]undici['"]/.test(content);
  if (hasAxios || hasGot) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Uses axios/got/node-fetch — outgoing HTTP calls (target unknown)',
      file: filePath,
    });
  }

  return facts;
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
