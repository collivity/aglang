// Swift static analyzer — detects infrastructure flows and server-side routes.
// Covers: Vapor (server), URLSession, Alamofire, Firebase, CoreData, Realm, CloudKit, AWS SDK, gRPC, Apollo (iOS client).

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import type { RouteFact } from './python.ts';

// ── Server-side route extraction (Vapor) ─────────────────────────────────────

// Vapor 4 route syntax:
//   app.get("path", "segment")  →  GET /path/segment
//   app.post("api", "users")    →  POST /api/users
//   routes.get("health")        →  GET /health
// Component identifiers are joined with "/"
// Named params: app.get("users", ":id")  →  /users/:id  →  /users/{}
const VAPOR_ROUTE_RE =
  /(?:app|routes|router)\s*\.\s*(get|post|put|delete|patch)\s*\(([^)]+)\)/gi;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

// Extract string literals from a Vapor route argument list and join as path segments
function parseVaporSegments(args: string): string {
  const segments: string[] = [];
  const strRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(args)) !== null) {
    segments.push(m[1]!);
  }
  return '/' + segments.join('/');
}

export function extractRoutesFromSwift(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  const routeRe = /(?:app|routes|router)\s*\.\s*(get|post|put|delete|patch)\s*\(([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const rawPath = parseVaporSegments(m[2]!);
    if (!rawPath || rawPath === '/') continue;
    const normalized = normalizeRoute(rawPath);
    routes.push({ method, path: rawPath, normalized, file: filePath, line: lineOf(content, m.index) });
  }
  return routes;
}

// ── Infrastructure flow detection ────────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];

  // ── PostgreSQL via Vapor Fluent ──────────────────────────────────────────
  const fluentPg =
    /import\s+FluentPostgresQL|import\s+FluentPostgresQL_Nio|FluentPostgresQL|\.postgres\s*\(|PostgresDatabase|PostgresConfiguration/.test(content);
  if (fluentPg) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'Imports or configures FluentPostgreSQL (Vapor ORM)',
      file: filePath,
    });
  }

  // ── MongoDB via MongoKitten / Vapor Fluent Mongo ─────────────────────────
  const mongoImport = /import\s+MongoKitten|import\s+FluentMongoDriver|MongoDatabase|MongoCollection/.test(content);
  if (mongoImport) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'definite',
      evidence: 'Imports MongoKitten or FluentMongoDriver',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const redisImport = /import\s+Redis|import\s+RediStack|RedisClient|RedisConnection/.test(content);
  if (redisImport) {
    facts.push({
      from: componentName, to: 'redis',
      confidence: 'definite',
      evidence: 'Imports Redis/RediStack client',
      file: filePath,
    });
  }

  // ── Firebase (iOS client — Firestore / Realtime DB / Auth / Storage) ──────
  const firebaseImport =
    /import\s+Firebase|import\s+FirebaseFirestore|import\s+FirebaseDatabase|import\s+FirebaseStorage|import\s+FirebaseAuth/.test(content);
  const firebaseUsage =
    /Firestore\.firestore\(\)|Database\.database\(\)|FirebaseApp\.configure\(\)|Auth\.auth\(\)|Storage\.storage\(\)/.test(content);
  if (firebaseImport && firebaseUsage) {
    facts.push({
      from: componentName, to: 'firebase',
      confidence: 'definite',
      evidence: 'Imports Firebase SDK and calls configure/database/firestore/auth/storage',
      file: filePath,
    });
  } else if (firebaseImport) {
    facts.push({
      from: componentName, to: 'firebase',
      confidence: 'probable',
      evidence: 'Imports Firebase SDK',
      file: filePath,
    });
  }

  // ── AWS SDK for Swift (S3, DynamoDB, Cognito) ────────────────────────────
  const awsS3 = /import\s+AWSS3|import\s+AWSClientRuntime.*S3|S3Client\s*\(|S3\.shared/.test(content);
  if (awsS3) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'definite',
      evidence: 'Imports AWS S3 SDK for Swift',
      file: filePath,
    });
  }
  const awsDynamo = /import\s+AWSDynamoDB|DynamoDBClient\s*\(/.test(content);
  if (awsDynamo) {
    facts.push({
      from: componentName, to: 'dynamodb',
      confidence: 'definite',
      evidence: 'Imports AWS DynamoDB SDK for Swift',
      file: filePath,
    });
  }

  // ── CloudKit ─────────────────────────────────────────────────────────────
  const cloudKitImport = /import\s+CloudKit/.test(content);
  const cloudKitUsage = /CKContainer|CKDatabase|CKRecord|CKQuery/.test(content);
  if (cloudKitImport && cloudKitUsage) {
    facts.push({
      from: componentName, to: 'cloudkit',
      confidence: 'definite',
      evidence: 'Uses CloudKit containers/databases for iCloud storage',
      file: filePath,
    });
  } else if (cloudKitImport) {
    facts.push({
      from: componentName, to: 'cloudkit',
      confidence: 'probable',
      evidence: 'Imports CloudKit',
      file: filePath,
    });
  }

  // ── Alamofire / URLSession (outgoing HTTP) ───────────────────────────────
  const alamofireImport = /import\s+Alamofire/.test(content);
  const alamofireUsage = /AF\.request|Alamofire\.request|Session\.default\.request/.test(content);
  if (alamofireImport && alamofireUsage) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Makes outgoing HTTP calls via Alamofire — target architecture node unknown',
      file: filePath,
    });
  }
  const urlSessionUsage = /URLSession\.(shared|data|download|upload)\.|URLRequest\s*\(url:/.test(content);
  if (!alamofireImport && urlSessionUsage) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Makes outgoing HTTP calls via URLSession — target architecture node unknown',
      file: filePath,
    });
  }

  // ── Apollo (GraphQL client) ───────────────────────────────────────────────
  const apolloImport = /import\s+Apollo/.test(content);
  const apolloUsage = /ApolloClient\s*\(|apollo\.fetch|apollo\.perform/.test(content);
  if (apolloImport && apolloUsage) {
    facts.push({
      from: componentName, to: 'graphql_api',
      confidence: 'probable',
      evidence: 'Uses Apollo iOS GraphQL client',
      file: filePath,
    });
  }

  // ── gRPC Swift ──────────────────────────────────────────────────────────
  const grpcImport = /import\s+GRPC|import\s+GRPCCore|ClientConnection\s*\(|GRPCChannel/.test(content);
  if (grpcImport) {
    facts.push({
      from: componentName, to: 'grpc_api',
      confidence: 'probable',
      evidence: 'Imports gRPC Swift client library',
      file: filePath,
    });
  }

  // ── CoreData (local, but worth flagging as a local_store dependency) ──────
  const coreDataImport = /import\s+CoreData/.test(content);
  const coreDataUsage = /NSPersistentContainer|NSManagedObjectContext|NSFetchRequest/.test(content);
  if (coreDataImport && coreDataUsage) {
    facts.push({
      from: componentName, to: 'local_store',
      confidence: 'definite',
      evidence: 'Uses CoreData persistent store (NSPersistentContainer)',
      file: filePath,
    });
  }

  // ── Realm ────────────────────────────────────────────────────────────────
  const realmImport = /import\s+RealmSwift|import\s+Realm/.test(content);
  const realmUsage = /Realm\s*\(\)|realm\.write|realm\.add|realm\.objects/.test(content);
  if (realmImport && realmUsage) {
    facts.push({
      from: componentName, to: 'local_store',
      confidence: 'definite',
      evidence: 'Uses Realm mobile database',
      file: filePath,
    });
  } else if (realmImport) {
    facts.push({
      from: componentName, to: 'local_store',
      confidence: 'probable',
      evidence: 'Imports RealmSwift',
      file: filePath,
    });
  }

  return facts;
}

export const swiftPlugin: ExtractorPlugin = {
  name: 'Swift regex analyzer',
  extensions: ['.swift'],
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
