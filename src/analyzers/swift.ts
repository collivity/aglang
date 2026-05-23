// Swift static analyzer — detects infrastructure flows, server-side routes,
// and common iOS modular/MVVM/Combine/storage patterns.
// Covers: Vapor (server), URLSession, Alamofire, Firebase, CoreData, Realm,
// CloudKit, AWS SDK, gRPC, Apollo, SPM module imports, UIKit MVVM with
// Combine Input/Output view models, Keychain, and UserDefaults.

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

function stripSwiftComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, match => '\n'.repeat(match.split('\n').length - 1))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
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
  const source = stripSwiftComments(content);
  const routeRe = /(?:app|routes|router)\s*\.\s*(get|post|put|delete|patch)\s*\(([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(source)) !== null) {
    const method = m[1]!.toUpperCase();
    const rawPath = parseVaporSegments(m[2]!);
    if (!rawPath || rawPath === '/') continue;
    const normalized = normalizeRoute(rawPath);
    routes.push({ method, path: rawPath, normalized, file: filePath, line: lineOf(source, m.index) });
  }
  return routes;
}

// ── Infrastructure flow detection ────────────────────────────────────────────

const SWIFT_STDLIB_MODULES = new Set([
  'Foundation', 'UIKit', 'SwiftUI', 'Combine', 'Security', 'CoreData', 'CoreBluetooth',
  'AVFoundation', 'UserNotifications', 'Network', 'CloudKit', 'CoreLocation',
  'PackageDescription', 'XCTest',
]);

function dedupeFacts(facts: FlowFact[]): FlowFact[] {
  const seen = new Set<string>();
  return facts.filter(f => {
    const key = `${f.from}:${f.to}:${f.file}:${f.line ?? 0}:${f.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveImportedModule(moduleName: string, mappings: Record<string, string>, componentName: string): string | null {
  if (SWIFT_STDLIB_MODULES.has(moduleName)) return null;
  const normalizedImport = moduleName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const candidate of Object.keys(mappings)) {
    if (candidate === componentName) continue;
    const normalizedCandidate = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      normalizedCandidate === normalizedImport ||
      normalizedCandidate === `${normalizedImport}module` ||
      `${normalizedCandidate}module` === normalizedImport
    ) {
      return candidate;
    }
  }
  return null;
}

function extractImportedModules(content: string): Array<{ moduleName: string; line: number }> {
  const imports: Array<{ moduleName: string; line: number }> = [];
  const re = /^\s*import\s+(?:(?:class|struct|enum|protocol|func|var)\s+)?([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    imports.push({ moduleName: m[1]!, line: lineOf(content, m.index) });
  }
  return imports;
}

function analyzeFile(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];
  const source = stripSwiftComments(content);

  // ── PostgreSQL via Vapor Fluent ──────────────────────────────────────────
  const fluentPg =
    /import\s+FluentPostgresQL|import\s+FluentPostgresQL_Nio|FluentPostgresQL|\.postgres\s*\(|PostgresDatabase|PostgresConfiguration/.test(source);
  if (fluentPg) {
    facts.push({
      from: componentName, to: 'postgres',
      confidence: 'definite',
      evidence: 'Imports or configures FluentPostgreSQL (Vapor ORM)',
      file: filePath,
    });
  }

  // ── MongoDB via MongoKitten / Vapor Fluent Mongo ─────────────────────────
  const mongoImport = /import\s+MongoKitten|import\s+FluentMongoDriver|MongoDatabase|MongoCollection/.test(source);
  if (mongoImport) {
    facts.push({
      from: componentName, to: 'mongodb',
      confidence: 'definite',
      evidence: 'Imports MongoKitten or FluentMongoDriver',
      file: filePath,
    });
  }

  // ── Redis ────────────────────────────────────────────────────────────────
  const redisImport = /import\s+Redis|import\s+RediStack|RedisClient|RedisConnection/.test(source);
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
    /import\s+Firebase|import\s+FirebaseFirestore|import\s+FirebaseDatabase|import\s+FirebaseStorage|import\s+FirebaseAuth/.test(source);
  const firebaseUsage =
    /Firestore\.firestore\(\)|Database\.database\(\)|FirebaseApp\.configure\(\)|Auth\.auth\(\)|Storage\.storage\(\)/.test(source);
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
  const awsS3 = /import\s+AWSS3|import\s+AWSClientRuntime.*S3|S3Client\s*\(|S3\.shared/.test(source);
  if (awsS3) {
    facts.push({
      from: componentName, to: 'object_store',
      confidence: 'definite',
      evidence: 'Imports AWS S3 SDK for Swift',
      file: filePath,
    });
  }
  const awsDynamo = /import\s+AWSDynamoDB|DynamoDBClient\s*\(/.test(source);
  if (awsDynamo) {
    facts.push({
      from: componentName, to: 'dynamodb',
      confidence: 'definite',
      evidence: 'Imports AWS DynamoDB SDK for Swift',
      file: filePath,
    });
  }

  // ── CloudKit ─────────────────────────────────────────────────────────────
  const cloudKitImport = /import\s+CloudKit/.test(source);
  const cloudKitUsage = /CKContainer|CKDatabase|CKRecord|CKQuery/.test(source);
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
  const alamofireImport = /import\s+Alamofire/.test(source);
  const alamofireUsage = /AF\.request|Alamofire\.request|Session\.default\.request/.test(source);
  if (alamofireImport && alamofireUsage) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Makes outgoing HTTP calls via Alamofire — target architecture node unknown',
      file: filePath,
    });
  }
  const urlSessionUsage = /URLSession\.(shared|data|download|upload)\.|URLRequest\s*\(url:/.test(source);
  if (!alamofireImport && urlSessionUsage) {
    facts.push({
      from: componentName, to: 'external_api',
      confidence: 'possible',
      evidence: 'Makes outgoing HTTP calls via URLSession — target architecture node unknown',
      file: filePath,
    });
  }

  // ── Apollo (GraphQL client) ───────────────────────────────────────────────
  const apolloImport = /import\s+Apollo/.test(source);
  const apolloUsage = /ApolloClient\s*\(|apollo\.fetch|apollo\.perform/.test(source);
  if (apolloImport && apolloUsage) {
    facts.push({
      from: componentName, to: 'graphql_api',
      confidence: 'probable',
      evidence: 'Uses Apollo iOS GraphQL client',
      file: filePath,
    });
  }

  // ── gRPC Swift ──────────────────────────────────────────────────────────
  const grpcImport = /import\s+GRPC|import\s+GRPCCore|ClientConnection\s*\(|GRPCChannel/.test(source);
  if (grpcImport) {
    facts.push({
      from: componentName, to: 'grpc_api',
      confidence: 'probable',
      evidence: 'Imports gRPC Swift client library',
      file: filePath,
    });
  }

  // ── CoreData (local, but worth flagging as a local_store dependency) ──────
  const coreDataImport = /import\s+CoreData/.test(source);
  const coreDataUsage = /NSPersistentContainer|NSManagedObjectContext|NSFetchRequest/.test(source);
  if (coreDataImport && coreDataUsage) {
    facts.push({
      from: componentName, to: 'local_store',
      confidence: 'definite',
      evidence: 'Uses CoreData persistent store (NSPersistentContainer)',
      file: filePath,
    });
  }

  // ── Realm ────────────────────────────────────────────────────────────────
  const realmImport = /import\s+RealmSwift|import\s+Realm/.test(source);
  const realmUsage = /Realm\s*\(\)|realm\.write|realm\.add|realm\.objects/.test(source);
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

  // ── iOS secure/local storage ─────────────────────────────────────────────
  const keychainMatch = source.match(/SecItem(?:Add|CopyMatching|Update|Delete)|KeychainHelper\.(?:save|load|delete)|\b(?:save|load)\w*ToKeychain\b|\b(?:save|load)\w*FromKeychain\b|deleteFromKeyChain/);
  if (keychainMatch) {
    facts.push({
      from: componentName,
      to: 'secure_storage',
      confidence: 'definite',
      evidence: 'Uses iOS Keychain APIs or Keychain helper for persisted sensitive data',
      file: filePath,
      line: lineOf(source, keychainMatch.index ?? 0),
      strategy: 'regex',
    });
  }

  const defaultsMatch = source.match(/UserDefaults\.standard\.(?:set|object|string|bool|double|integer|register|removeObject)\s*\(/);
  if (defaultsMatch) {
    facts.push({
      from: componentName,
      to: 'local_preferences',
      confidence: 'definite',
      evidence: 'Uses UserDefaults for local app preferences/state',
      file: filePath,
      line: lineOf(source, defaultsMatch.index ?? 0),
      strategy: 'regex',
    });
  }

  // ── Combine and strict MVVM conventions ─────────────────────────────────
  const combineMatch = source.match(/import\s+Combine|AnyPublisher\s*<|PassthroughSubject\s*<|CurrentValueSubject\s*<|@Published\b|\.eraseToAnyPublisher\(\)|\.sink\s*\{|\.store\s*\(/);
  if (combineMatch) {
    facts.push({
      from: componentName,
      to: 'reactive_stream',
      confidence: 'possible',
      evidence: 'Uses Combine publishers/subjects for reactive iOS flows',
      file: filePath,
      line: lineOf(source, combineMatch.index ?? 0),
      strategy: 'regex',
    });
  }

  const viewModelMatch = source.match(/class\s+([A-Za-z_][A-Za-z0-9_]*ViewModel)\b[\s\S]{0,240}ViewModelBlueprint/);
  const hasInputOutput = /\bstruct\s+Input\b[\s\S]*\bstruct\s+Output\b/.test(source);
  const hasConvert = /func\s+convert\s*\(\s*input\s*:\s*Input\s*\)\s*->\s*Output/.test(source);
  if (viewModelMatch && hasInputOutput && hasConvert) {
    facts.push({
      from: componentName,
      to: 'mvvm_viewmodel',
      confidence: 'possible',
      evidence: `${viewModelMatch[1]} follows ViewModelBlueprint Input/Output convert(input:) pattern`,
      file: filePath,
      line: lineOf(source, viewModelMatch.index ?? 0),
      strategy: 'regex',
    });
  }

  const controllerMatch = source.match(/class\s+([A-Za-z_][A-Za-z0-9_]*ViewController)\b[\s\S]{0,260}ViewController\s*<\s*([A-Za-z_][A-Za-z0-9_]*ViewModel)\s*>/);
  const bindsOutput = /let\s+output\s*=\s*viewModel\.convert\s*\(\s*input\s*:/.test(source);
  if (controllerMatch && bindsOutput) {
    facts.push({
      from: componentName,
      to: 'mvvm_viewcontroller',
      confidence: 'possible',
      evidence: `${controllerMatch[1]} binds ${controllerMatch[2]} through convert(input:)`,
      file: filePath,
      line: lineOf(source, controllerMatch.index ?? 0),
      strategy: 'regex',
    });
  }

  const isViewController = /class\s+[A-Za-z_][A-Za-z0-9_]*ViewController\b[\s\S]{0,260}(?:UIViewController|ViewController\s*<)/.test(source);
  const directControllerSideEffect = /(?:URLSession\.|AF\.request|UserDefaults\.standard|KeychainHelper\.|SettingsGeneralCD\.shared\.(?:save|load)\w*(?:To|From)Keychain)/.test(source);
  if (isViewController && directControllerSideEffect) {
    facts.push({
      from: componentName,
      to: 'mvvm_violation',
      confidence: 'probable',
      evidence: 'ViewController performs direct networking/storage instead of routing side effects through a ViewModel',
      file: filePath,
      line: lineOf(source, source.search(/URLSession\.|AF\.request|UserDefaults\.standard|KeychainHelper\.|SettingsGeneralCD\.shared\.(?:save|load)\w*(?:To|From)Keychain/)),
      strategy: 'regex',
    });
  }
  const directControllerNetwork = source.match(/URLSession\.|AF\.request|Alamofire\.request|Session\.default\.request/);
  if (isViewController && directControllerNetwork) {
    facts.push({
      from: componentName,
      to: 'external_api',
      confidence: 'definite',
      evidence: 'ViewController performs direct networking instead of routing through an application component',
      file: filePath,
      line: lineOf(source, directControllerNetwork.index ?? 0),
      strategy: 'regex',
    });
  }

  // ── Swift Package Manager modularity ─────────────────────────────────────
  if (/import\s+PackageDescription/.test(source) && /let\s+package\s*=\s*Package\s*\(/.test(source)) {
    facts.push({
      from: componentName,
      to: 'swift_package',
      confidence: 'possible',
      evidence: 'Defines a Swift Package Manager module with products/targets/dependencies',
      file: filePath,
      line: lineOf(source, source.search(/let\s+package\s*=\s*Package\s*\(/)),
      strategy: 'regex',
    });
  }

  return facts;
}

function analyzeSwiftModuleImports(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string>,
): FlowFact[] {
  const facts: FlowFact[] = [];
  const source = stripSwiftComments(content);
  for (const { moduleName, line } of extractImportedModules(source)) {
    const target = resolveImportedModule(moduleName, mappings, componentName);
    if (!target) continue;
    facts.push({
      from: componentName,
      to: target,
      confidence: 'probable',
      evidence: `Imports Swift module '${moduleName}'`,
      file: filePath,
      line,
      strategy: 'regex',
    });
  }
  return facts;
}

export function analyzeSwift(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string> = {},
): FlowFact[] {
  return dedupeFacts([
    ...analyzeFile(content, filePath, componentName),
    ...analyzeSwiftModuleImports(content, filePath, componentName, mappings),
  ]);
}

export const swiftPlugin: ExtractorPlugin = {
  name: 'Swift iOS AST/regex analyzer',
  extensions: ['.swift'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      facts.push(...analyzeSwift(content, filePath, input.componentName, input.mappings));
    }
    return dedupeFacts(facts);
  },
};
