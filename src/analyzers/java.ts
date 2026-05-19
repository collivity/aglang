// JVM static analyzer — detects infrastructure flows and server-side routes.
// Handles: Java/Spring Boot, Scala/Play, Kotlin (supplement to kotlin.ts for Spring).
// File extensions: .java, .scala (kotlin.ts handles .kt)

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

// Spring Boot: @GetMapping("/path"), @PostMapping, @RequestMapping(value="/path", method=RequestMethod.GET)
// Also detects class-level @RequestMapping prefix and combines with method-level.

export function extractRoutesFromJava(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  let m: RegExpExecArray | null;

  // Class-level @RequestMapping prefix
  const classBaseRe = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
  let classBase = '';
  const classBaseMatch = classBaseRe.exec(content);
  if (classBaseMatch) {
    classBase = classBaseMatch[1]!;
  }

  // Method-level mappings
  const methodMappingRe = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?(?:["']([^"']*)["']|)\s*\)/g;
  while ((m = methodMappingRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const subPath = m[2] ?? '';
    const path = ('/' + classBase + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: lineOf(content, m.index) });
  }

  // @RequestMapping(value="/path", method=RequestMethod.GET)
  const requestMappingRe = /@RequestMapping\s*\(([^)]+)\)/g;
  while ((m = requestMappingRe.exec(content)) !== null) {
    const args = m[1]!;
    const valueMat = args.match(/(?:value\s*=\s*)?["']([^"']+)["']/);
    const methodMat = args.match(/method\s*=\s*RequestMethod\.(\w+)/);
    if (valueMat) {
      const subPath = valueMat[1]!;
      const method = methodMat ? methodMat[1]!.toUpperCase() : '*';
      const path = ('/' + classBase + '/' + subPath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      // Skip class-level annotation (already captured above)
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

// ── Infrastructure flow detection ────────────────────────────────────────────

function analyzeJavaFile(content: string, filePath: string, componentName: string): FlowFact[] {
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
  name: 'Java/Spring regex analyzer',
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
