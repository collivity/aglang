// JVM static analyzer — detects infrastructure flows and server-side routes.
// Handles: Java/Spring Boot, Scala/Play, Kotlin (supplement to kotlin.ts for Spring).
// File extensions: .java, .scala (kotlin.ts handles .kt)
// Uses tree-sitter AST for Java when available, falls back to regex silently.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter } from './ast/loader.ts';
import { parseAndQuery } from './ast/walker.ts';
import { IMPORT_QUERY, ANNOTATION_QUERY, NEW_OBJECT_QUERY, METHOD_INVOCATION_QUERY } from './ast/queries/java.ts';

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

// ── Import → infra mapping ─────────────────────────────────────────────────────

const IMPORT_TO_INFRA: Array<[string, string]> = [
  ['org.postgresql', 'postgres'],
  ['com.mysql', 'relational_db'],
  ['org.mariadb', 'relational_db'],
  ['org.springframework.data.jpa', 'relational_db'],
  ['javax.persistence', 'relational_db'],
  ['jakarta.persistence', 'relational_db'],
  ['org.hibernate', 'relational_db'],
  ['org.jooq', 'relational_db'],
  ['org.springframework.data.mongodb', 'mongodb'],
  ['com.mongodb', 'mongodb'],
  ['org.springframework.data.redis', 'redis'],
  ['io.lettuce', 'redis'],
  ['io.jedis', 'redis'],
  ['org.redisson', 'redis'],
  ['org.springframework.kafka', 'message_queue'],
  ['org.apache.kafka', 'message_queue'],
  ['org.springframework.amqp', 'message_queue'],
  ['com.rabbitmq', 'message_queue'],
  ['com.amazonaws.services.s3', 'object_store'],
  ['software.amazon.awssdk.services.s3', 'object_store'],
  ['io.minio', 'object_store'],
];

// Annotation names that indicate a class is a Spring controller
const CONTROLLER_ANNOTATIONS = new Set(['RestController', 'Controller']);

// ── AST-based route extraction ─────────────────────────────────────────────────

function extractRoutesAst(content: string, filePath: string): RouteFact[] {
  const parser = makeParser('java');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['java'];
  const routes: RouteFact[] = [];

  const captures = parseAndQuery(parser, language, content, ANNOTATION_QUERY);
  // Two-pass: first collect class base path, then method routes
  let classBase = '';
  const METHOD_MAPPINGS = new Set(['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping']);

  for (let i = 0; i < captures.length; i++) {
    const nameCap = captures[i];
    const argCap = captures[i + 1];
    if (nameCap?.name !== 'annotation_name') continue;

    const annName = nameCap.text;
    const argText = argCap?.name === 'annotation_arg' ? argCap.text.replace(/^["']|["']$/g, '') : '';
    if (i + 1 < captures.length && argCap?.name === 'annotation_arg') i++;

    if (annName === 'RequestMapping' && !classBase && argText) {
      classBase = argText;
      continue;
    }
    if (METHOD_MAPPINGS.has(annName)) {
      const httpMethod = annName === 'RequestMapping' ? '*' : annName.replace('Mapping', '').toUpperCase();
      const fullPath = ('/' + classBase + '/' + argText).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      routes.push({ method: httpMethod, path: fullPath, normalized: normalizeRoute(fullPath), file: filePath, line: nameCap.startRow + 1 });
    }
  }

  return routes;
}

// ── AST-based infrastructure detection ───────────────────────────────────────

function analyzeJavaFileAst(content: string, filePath: string, componentName: string): FlowFact[] {
  const parser = makeParser('java');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['java'];

  const importCaptures = parseAndQuery(parser, language, content, IMPORT_QUERY);
  const imports = importCaptures.filter(c => c.name === 'import_path').map(c => c.text);

  const newObjCaptures = parseAndQuery(parser, language, content, NEW_OBJECT_QUERY);
  const newClasses = new Set(newObjCaptures.filter(c => c.name === 'class_name').map(c => c.text));

  const methodCaptures = parseAndQuery(parser, language, content, METHOD_INVOCATION_QUERY);
  const methodCalls = new Set<string>();
  for (let i = 0; i < methodCaptures.length; i++) {
    const recv = methodCaptures[i];
    const fn = methodCaptures[i + 1];
    if (recv?.name === 'receiver' && fn?.name === 'method_name') {
      methodCalls.add(`${recv.text}.${fn.text}`);
      i++;
    }
  }

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();

  for (const imp of imports) {
    for (const [prefix, infraNode] of IMPORT_TO_INFRA) {
      if (imp.startsWith(prefix) && !emitted.has(infraNode)) {
        const hasDefiniteUsage =
          [...newClasses].some(cls => /JdbcTemplate|MongoTemplate|RedisTemplate|KafkaTemplate/.test(cls)) ||
          [...methodCalls].some(mc => /getConnection|connect|newClient|createClient/.test(mc));
        facts.push({
          from: componentName,
          to: infraNode,
          confidence: hasDefiniteUsage ? 'definite' : 'probable',
          evidence: `Imports '${prefix}' package`,
          file: filePath,
        });
        emitted.add(infraNode);
        break;
      }
    }
  }

  return facts;
}

// ── Server-side route extraction (regex fallback) ─────────────────────────────

export function extractRoutesFromJava(content: string, filePath: string): RouteFact[] {
  const astRoutes = extractRoutesAst(content, filePath);
  if (astRoutes.length > 0) return astRoutes;
  return extractRoutesFromJavaRegex(content, filePath);
}

function extractRoutesFromJavaRegex(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  const classBaseRe = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
  let classBase = '';
  const classBaseMatch = classBaseRe.exec(content);
  if (classBaseMatch) classBase = classBaseMatch[1]!;

  const methodMappingRe = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?(?:["']([^"']*)["']|)\s*\)/g;
  while ((m = methodMappingRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const subPath = m[2] ?? '';
    const path = ('/' + classBase + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  const requestMappingRe = /@RequestMapping\s*\(([^)]+)\)/g;
  while ((m = requestMappingRe.exec(content)) !== null) {
    const args = m[1]!;
    const valueMat = args.match(/(?:value\s*=\s*)?["']([^"']+)["']/);
    const methodMat = args.match(/method\s*=\s*RequestMethod\.(\w+)/);
    if (valueMat) {
      const subPath = valueMat[1]!;
      const method = methodMat ? methodMat[1]!.toUpperCase() : '*';
      const path = ('/' + classBase + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      if (methodMat || !classBaseMatch || m.index !== classBaseMatch.index) {
        routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
      }
    }
  }

  return routes;
}

// Scala Play Framework routes file (routes file, not .scala — but we parse .scala for Akka HTTP)
// Play routes: GET /path  controllers.App.method
export function extractRoutesFromScala(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  // Play routes file embedded in .scala or routes file parsed here
  const playRoutesRe = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s]+)/gm;
  while ((m = playRoutesRe.exec(content)) !== null) {
    const method = m[1]!;
    const path = m[2]!;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // Akka HTTP directives: path("segment") { get { ... } }
  // Too complex to reliably extract HTTP method + path from nested DSL — skip for now

  return routes;
}

// ── Regex fallback: Java infrastructure detection ─────────────────────────────

function analyzeJavaFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const astFacts = analyzeJavaFileAst(content, filePath, componentName);
  if (astFacts.length > 0) return astFacts;
  return analyzeJavaFileRegex(content, filePath, componentName);
}

function analyzeJavaFileRegex(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // ── PostgreSQL / Relational ──────────────────────────────────────────────
  const hasPgUrl = /jdbc:postgresql:\/\/|datasource\.url.*postgresql/.test(content);
  const hasJdbc = /JdbcTemplate|NamedParameterJdbcTemplate|DataSource/.test(content);
  const hasJpa = /EntityManager|@Repository|JpaRepository|CrudRepository/.test(content);
  const hasHibernate = /import\s+org\.hibernate/.test(content);

  if (hasPgUrl) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'JDBC URL contains postgresql — explicit PostgreSQL dependency',
      file: filePath,
    });
  } else if (hasJdbc || hasJpa || hasHibernate) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: `Uses JPA/JDBC (${[hasJdbc && 'JdbcTemplate', hasJpa && 'JpaRepository', hasHibernate && 'Hibernate'].filter(Boolean).join(', ')})`,
      file: filePath,
    });
  }

  // ── MongoDB ──────────────────────────────────────────────────────────────
  const hasMongo = /import\s+org\.springframework\.data\.mongodb/.test(content) ||
    /MongoTemplate|MongoRepository|MongoDatabase/.test(content);
  if (hasMongo) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'probable',
      evidence: 'Uses Spring Data MongoDB / MongoTemplate',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const hasRedis = /import\s+org\.springframework\.data\.redis/.test(content) ||
    /RedisTemplate|StringRedisTemplate|RedissonClient|LettuceConnectionFactory/.test(content);
  if (hasRedis) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'probable',
      evidence: 'Uses Spring Data Redis / RedisTemplate',
      file: filePath,
    });
  }

  // ── Message Queue / Kafka / RabbitMQ ────────────────────────────────────
  const hasKafka = /import\s+org\.springframework\.kafka/.test(content) ||
    /KafkaTemplate|@KafkaListener|ProducerFactory/.test(content);
  if (hasKafka) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Uses Spring Kafka / KafkaTemplate',
      file: filePath,
    });
  }

  const hasRabbit = /import\s+org\.springframework\.amqp/.test(content) ||
    /RabbitTemplate|@RabbitListener|AmqpTemplate/.test(content);
  if (hasRabbit) {
    facts.push({
      from: componentName, to: 'message_queue',
      confidence: 'probable',
      evidence: 'Uses Spring AMQP / RabbitMQ',
      file: filePath,
    });
  }

  // ── Object Storage ───────────────────────────────────────────────────────
  const hasS3 = /import\s+com\.amazonaws\.services\.s3/.test(content) ||
    /AmazonS3|S3Client|S3Presigner|AmazonS3ClientBuilder/.test(content);
  if (hasS3) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'probable',
      evidence: 'Uses AWS S3 SDK',
      file: filePath,
    });
  }

  // ── External HTTP ────────────────────────────────────────────────────────
  const hasRestTemplate = /RestTemplate|WebClient|FeignClient|OpenFeign/.test(content);
  if (hasRestTemplate) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Uses RestTemplate/WebClient/Feign — outgoing HTTP calls (target unknown)',
      file: filePath,
    });
  }

  return facts;
}

function analyzeScalaFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // Slick (Scala relational DB toolkit)
  const hasSlick = /import\s+slick\.|Database\.forConfig|TableQuery/.test(content);
  if (hasSlick) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses Slick database library',
      file: filePath,
    });
  }

  // Doobie (Scala functional JDBC)
  const hasDoobie = /import\s+doobie\.|Transactor\.fromDriverManager|sql"/.test(content);
  if (hasDoobie) {
    facts.push({
      from: componentName, to: 'relational_db',
      confidence: 'probable',
      evidence: 'Uses Doobie JDBC library',
      file: filePath,
    });
  }

  // Reactive Mongo (Scala)
  const hasMongo = /import\s+reactivemongo\.|ReactiveMongoApi|MongoCollection/.test(content);
  if (hasMongo) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'probable',
      evidence: 'Uses ReactiveMongo',
      file: filePath,
    });
  }

  // Scala Redis (sedis, rediscala, etc.)
  const hasRedis = /import\s+com\.redis\.|RedisClient|RedisPool/.test(content);
  if (hasRedis) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'probable',
      evidence: 'Uses Scala Redis client',
      file: filePath,
    });
  }

  // sttp / Akka HTTP client (outgoing)
  const hasHttp = /import\s+sttp\.|SttpBackend|basicRequest|HttpResponse\[/.test(content);
  if (hasHttp) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Uses sttp/Akka HTTP client — outgoing HTTP (target unknown)',
      file: filePath,
    });
  }

  return facts;
}

export const javaPlugin: ExtractorPlugin = {
  name: 'Java/Spring AST/regex analyzer',
  extensions: ['.java'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      facts.push(...analyzeJavaFile(content, filePath, input.componentName));
    }
    return facts;
  },
};

export const scalaPlugin: ExtractorPlugin = {
  name: 'Scala regex analyzer',
  extensions: ['.scala'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      facts.push(...analyzeScalaFile(content, filePath, input.componentName));
    }
    return facts;
  },
};
