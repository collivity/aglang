// TypeScript/JavaScript server-side analyzer — detects Express/NestJS routes and infrastructure.
// Complements typescript.ts (which handles client-side fetch calls).
// Uses tree-sitter AST when available, falls back to regex silently.

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import micromatch from 'micromatch';
import type { ExtractorPlugin, ExtractorInput, FlowFact, GraphFact, ExtractionStrategy, ExtractorDebugSession } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter, describeTreeSitterAvailability } from './ast/loader.ts';
import { groupByRow, parseAndQuery } from './ast/walker.ts';
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

function looksLikeServerRouteReceiver(receiver: string): boolean {
  return /^(app|router|server|fastify)$/.test(receiver)
    || /(Router|Routes|App|Server|Group)$/.test(receiver);
}

function withStrategy(facts: FlowFact[], strategy: ExtractionStrategy): FlowFact[] {
  return facts.map(f => ({ ...f, strategy: f.strategy ?? strategy }));
}

function debugLog(
  debug: ExtractorDebugSession | undefined,
  stage: string,
  message: string,
  file?: string,
  details?: Record<string, unknown>,
): void {
  debug?.log({
    extractor: typescriptServerPlugin.name,
    stage,
    message,
    file,
    details,
  });
}

function componentForPath(mappings: Record<string, string>, absPath: string): string | undefined {
  const normalized = absPath.replace(/\\/g, '/');
  for (const [componentName, glob] of Object.entries(mappings)) {
    if (micromatch.isMatch(normalized, `**/${glob}`) || micromatch.isMatch(normalized, glob)) {
      return componentName;
    }
  }
  return undefined;
}

function resolveRelativeImport(filePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(filePath), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
    resolve(base, 'index.js'),
  ];
  return candidates.find(p => existsSync(p));
}

function analyzeInternalImportsAst(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string>,
  debug?: ExtractorDebugSession,
): FlowFact[] {
  const lang: 'typescript' | 'javascript' = filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')
    ? 'javascript' : 'typescript';
  const availability = describeTreeSitterAvailability(lang);
  debugLog(debug, 'ast_availability', availability.grammarLoaded
    ? `tree-sitter ${lang} parser available`
    : `tree-sitter ${lang} parser unavailable`, filePath, availability);
  const parser = makeParser(lang);
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts[lang];
  if (!language) return [];

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();
  const captures = [
    ...parseAndQuery(parser, language, content, IMPORT_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'IMPORT_QUERY', file: filePath }),
    ...parseAndQuery(parser, language, content, IMPORT_NAMED_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'IMPORT_NAMED_QUERY', file: filePath }),
    ...parseAndQuery(parser, language, content, REQUIRE_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'REQUIRE_QUERY', file: filePath }),
  ];
  debugLog(debug, 'ast_capture_summary', `Collected ${captures.length} AST capture(s) for import analysis`, filePath, {
    captures: captures.length,
    component: componentName,
  });

  for (const c of captures) {
    if (c.name !== 'module_specifier') continue;
    const sourceLine = content.split('\n')[c.startRow] ?? '';
    if (/^\s*(?:import|export)\s+type\b/.test(sourceLine)) continue;
    const resolved = resolveRelativeImport(filePath, c.text);
    if (!resolved) continue;
    const targetComponent = componentForPath(mappings, resolved);
    if (!targetComponent || targetComponent === componentName) continue;
    const key = `${targetComponent}:${c.startRow}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    facts.push({
      from: componentName,
      to: targetComponent,
      confidence: 'definite',
      evidence: `Imports internal module '${c.text}' from component '${targetComponent}'`,
      file: filePath,
      line: c.startRow + 1,
      strategy: 'ast',
    });
  }

  debugLog(debug, 'ast_fact_summary', `AST import analysis emitted ${facts.length} fact(s)`, filePath, {
    facts: facts.length,
    component: componentName,
  });

  return facts;
}

function analyzeInternalImportsRegex(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string>,
  debug?: ExtractorDebugSession,
): FlowFact[] {
  const facts: FlowFact[] = [];
  const emitted = new Set<string>();
  const importRe = /(?:import(?:\s+type)?(?:[\s\S]*?\s+from\s+)?|export[\s\S]*?\s+from\s+|require\s*\()\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const lineStart = content.lastIndexOf('\n', m.index) + 1;
    const lineEnd = content.indexOf('\n', m.index);
    const sourceLine = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    if (/^\s*(?:import|export)\s+type\b/.test(sourceLine)) continue;
    const specifier = m[1]!;
    const resolved = resolveRelativeImport(filePath, specifier);
    if (!resolved) continue;
    const targetComponent = componentForPath(mappings, resolved);
    if (!targetComponent || targetComponent === componentName) continue;
    const line = lineOf(content, m.index);
    const key = `${targetComponent}:${line}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    facts.push({
      from: componentName,
      to: targetComponent,
      confidence: 'definite',
      evidence: `Imports internal module '${specifier}' from component '${targetComponent}'`,
      file: filePath,
      line,
      strategy: 'regex',
    });
  }
  debugLog(debug, 'regex_fact_summary', `Regex import analysis emitted ${facts.length} fact(s)`, filePath, {
    facts: facts.length,
    component: componentName,
  });
  return facts;
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
  if (!language) return [];

  const routes: RouteFact[] = [];

  // Express-style: app.get('/path', ...)
  const expressCaptures = parseAndQuery(parser, language, content, EXPRESS_ROUTE_QUERY);
  for (const captures of groupByRow(expressCaptures).values()) {
    const receiverCap = captures.find(c => c.name === 'receiver');
    const methodCap = captures.find(c => c.name === 'method');
    const pathCap = captures.find(c => c.name === 'route_path');
    if (!receiverCap || !methodCap || !pathCap) continue;
    if (!looksLikeServerRouteReceiver(receiverCap.text)) continue;
    const method = methodCap.text.toUpperCase();
    const path = pathCap.text;
    routes.push({ method, path, normalized: normalizeRoute(path), file: filePath, line: methodCap.startRow + 1 });
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

function analyzeFileAst(content: string, filePath: string, componentName: string, debug?: ExtractorDebugSession): FlowFact[] {
  const lang: 'typescript' | 'javascript' = filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')
    ? 'javascript' : 'typescript';
  const availability = describeTreeSitterAvailability(lang);
  debugLog(debug, 'ast_availability', availability.grammarLoaded
    ? `tree-sitter ${lang} parser available`
    : `tree-sitter ${lang} parser unavailable`, filePath, availability);
  const parser = makeParser(lang);
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts[lang];
  if (!language) return [];

  // Build symbol map: importedName → pkg  (handles aliased imports)
  const symbolMap = new Map<string, string>(); // className → pkg
  const importedPkgs = new Set<string>();

  // Named imports: import { MongoClient } from 'mongodb'
  const namedCaptures = parseAndQuery(parser, language, content, IMPORT_NAMED_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'IMPORT_NAMED_QUERY', file: filePath });
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
  const importCaptures = parseAndQuery(parser, language, content, IMPORT_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'IMPORT_QUERY', file: filePath });
  for (const c of importCaptures) {
    if (c.name === 'module_specifier') importedPkgs.add(c.text);
  }

  // require() calls
  const requireCaptures = parseAndQuery(parser, language, content, REQUIRE_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'REQUIRE_QUERY', file: filePath });
  for (const c of requireCaptures) {
    if (c.name === 'module_specifier') importedPkgs.add(c.text);
  }

  // new expressions: new MongoClient(...)
  const newCaptures = parseAndQuery(parser, language, content, NEW_EXPR_QUERY, { debug, extractor: typescriptServerPlugin.name, queryName: 'NEW_EXPR_QUERY', file: filePath });
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

  debugLog(debug, 'ast_fact_summary', `AST infrastructure analysis emitted ${facts.length} fact(s)`, filePath, {
    facts: facts.length,
    component: componentName,
    importedPackages: [...importedPkgs],
  });

  return facts;
}

// ── Regex-based infrastructure detection (fallback) ───────────────────────────

function analyzeFileRegex(content: string, filePath: string, componentName: string, debug?: ExtractorDebugSession): FlowFact[] {
  const facts: FlowFact[] = [];
  const searchable = content
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');

  const hasPg = /require\s*\(\s*['"]pg['"]\)|from\s+['"]pg['"]|from\s+['"]@prisma\/client['"]/i.test(searchable) ||
    /new\s+Pool\s*\(|pg\.Pool\s*\(|pgPool/.test(searchable);
  const hasPrisma = /PrismaClient|from\s+['"]@prisma\/client['"]/.test(searchable);
  const hasPostgresUrl = /postgres(?:ql)?:\/\//.test(searchable);

  if (hasPg || hasPostgresUrl) {
    const isExplicit = /new\s+Pool\s*\(|createPool\s*\(|postgres(?:ql)?:\/\//.test(searchable);
    facts.push({ from: componentName, to: 'postgres', confidence: isExplicit ? 'definite' : 'probable', evidence: isExplicit ? 'Creates PostgreSQL connection pool' : 'Imports pg driver', file: filePath });
  } else if (hasPrisma) {
    facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses Prisma ORM (DB type from schema, not inferred here)', file: filePath });
  }

  const hasDrizzle = /from\s+['"]drizzle-orm/.test(searchable);
  if (hasDrizzle) facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: 'Uses Drizzle ORM — relational DB dependency', file: filePath });

  const hasMongo = /require\s*\(\s*['"]mongoose['"]\)|from\s+['"]mongoose['"]/.test(searchable) || /require\s*\(\s*['"]mongodb['"]\)|from\s+['"]mongodb['"]/.test(searchable);
  const mongoUsage = /mongoose\.connect\s*\(|MongoClient\.connect\s*\(|new\s+MongoClient\s*\(/.test(searchable);
  if (hasMongo && mongoUsage) facts.push({ from: componentName, to: 'mongodb', confidence: 'definite', evidence: 'Imports mongoose/mongodb and connects to MongoDB', file: filePath });
  else if (hasMongo) facts.push({ from: componentName, to: 'mongodb', confidence: 'probable', evidence: 'Imports mongoose/mongodb driver', file: filePath });

  const hasRedis = /require\s*\(\s*['"]redis['"]\)|from\s+['"]redis['"]/.test(searchable) || /require\s*\(\s*['"]ioredis['"]\)|from\s+['"]ioredis['"]/.test(searchable);
  const redisUsage = /redis\.createClient\s*\(|new\s+Redis\s*\(|createClient\s*\(/.test(searchable);
  if (hasRedis && redisUsage) facts.push({ from: componentName, to: 'redis', confidence: 'definite', evidence: 'Creates Redis client connection', file: filePath });
  else if (hasRedis) facts.push({ from: componentName, to: 'redis', confidence: 'probable', evidence: 'Imports Redis client library', file: filePath });

  const hasKafkaJs = /require\s*\(\s*['"]kafkajs['"]\)|from\s+['"]kafkajs['"]/.test(searchable);
  const hasAmqp = /require\s*\(\s*['"]amqplib['"]\)|from\s+['"]amqplib['"]/.test(searchable);
  if (hasKafkaJs) {
    const kafkaUsage = /new\s+Kafka\s*\(|kafka\.producer\s*\(|kafka\.consumer\s*\(/.test(searchable);
    facts.push({ from: componentName, to: 'message_queue', confidence: kafkaUsage ? 'definite' : 'probable', evidence: kafkaUsage ? 'Creates Kafka producer/consumer' : 'Imports kafkajs', file: filePath });
  }
  if (hasAmqp) facts.push({ from: componentName, to: 'message_queue', confidence: 'probable', evidence: 'Imports amqplib (RabbitMQ)', file: filePath });

  const hasS3 = /from\s+['"]@aws-sdk\/client-s3['"]|require\s*\(\s*['"]aws-sdk['"]\)/.test(searchable);
  const s3Usage = /new\s+S3Client\s*\(|new\s+S3\s*\(|s3\.upload\s*\(/.test(searchable);
  if (hasS3 && s3Usage) facts.push({ from: componentName, to: 'object_store', confidence: 'definite', evidence: 'Creates AWS S3 client', file: filePath });
  else if (hasS3) facts.push({ from: componentName, to: 'object_store', confidence: 'probable', evidence: 'Imports AWS SDK (S3 client)', file: filePath });

  const hasAxios = /from\s+['"]axios['"]|require\s*\(\s*['"]axios['"]\)/.test(searchable);
  const hasGot = /from\s+['"]got['"]|from\s+['"]node-fetch['"]|from\s+['"]undici['"]/.test(searchable);
  if (hasAxios || hasGot) facts.push({ from: componentName, to: 'external_api', confidence: 'possible', evidence: 'Uses axios/got/node-fetch — outgoing HTTP calls (target unknown)', file: filePath });

  debugLog(debug, 'regex_fact_summary', `Regex infrastructure analysis emitted ${facts.length} fact(s)`, filePath, {
    facts: facts.length,
    component: componentName,
  });

  return facts;
}

// ── Unified infrastructure analysis ──────────────────────────────────────────

function analyzeFile(content: string, filePath: string, componentName: string, debug?: ExtractorDebugSession, requireAst = false): FlowFact[] {
  const astFacts = analyzeFileAst(content, filePath, componentName, debug);
  if (astFacts.length > 0) return withStrategy(astFacts, 'ast');
  const regexFacts = analyzeFileRegex(content, filePath, componentName, debug);
  if (requireAst && regexFacts.length > 0) {
    throw new Error(`AST extraction emitted 0 facts for ${filePath}, but regex emitted ${regexFacts.length} fact(s)`);
  }
  if (regexFacts.length > 0) {
    debugLog(debug, 'fallback', `Falling back to regex infrastructure extraction because AST emitted 0 facts`, filePath, {
      regexFacts: regexFacts.length,
      requireAst,
    });
  }
  return withStrategy(regexFacts, 'regex');
}

function extractSemanticGraphFacts(content: string, filePath: string, componentName: string): GraphFact[] {
  const facts: GraphFact[] = [];
  const emitted = new Set<string>();
  const add = (kind: string, index: number, properties: GraphFact['properties'], message: string): void => {
    const line = lineOf(content, index);
    const id = `typescript-semantic:${filePath}:${line}:${kind}:${JSON.stringify(properties)}`;
    if (emitted.has(id)) return;
    emitted.add(id);
    facts.push({
      id,
      kind,
      subject: componentName,
      properties,
      confidence: 'definite',
      evidence: {
        extractor: typescriptServerPlugin.name,
        strategy: 'regex',
        file: filePath,
        line,
        message,
      },
    });
  };

  const callRe = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
  let call: RegExpExecArray | null;
  while ((call = callRe.exec(content)) !== null) {
    add('call', call.index, {
      receiver: call[1]!,
      callee: call[2]!,
      argumentEnum: call[3]!,
      argumentMember: call[4]!,
    }, `${call[1]}.${call[2]}(${call[3]}.${call[4]})`);
  }

  const assignmentRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
  let assignment: RegExpExecArray | null;
  while ((assignment = assignmentRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, assignment.index - 300), assignment.index);
    const guardRe = new RegExp(`${assignment[1]}\\.${assignment[2]}\\s*(?:===|==)\\s*${assignment[3]}\\.([A-Za-z_$][\\w$]*)`);
    const guards = [...before.matchAll(new RegExp(guardRe.source, 'g'))];
    const guard = guards.at(-1);
    add('assignment', assignment.index, {
      object: assignment[1]!,
      property: assignment[2]!,
      valueEnum: assignment[3]!,
      valueMember: assignment[4]!,
      ...(guard ? { previousMember: guard[1]! } : {}),
    }, `${assignment[1]}.${assignment[2]} = ${assignment[3]}.${assignment[4]}`);
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
      facts.push(...analyzeFile(content, filePath, input.componentName, input.debug, input.requireAst));
      const astImports = analyzeInternalImportsAst(content, filePath, input.componentName, input.mappings, input.debug);
      if (astImports.length > 0) {
        facts.push(...astImports);
        continue;
      }
      const regexImports = analyzeInternalImportsRegex(content, filePath, input.componentName, input.mappings, input.debug);
      if (input.requireAst && regexImports.length > 0) {
        throw new Error(`AST import extraction emitted 0 facts for ${filePath}, but regex emitted ${regexImports.length} fact(s)`);
      }
      if (regexImports.length > 0) {
        debugLog(input.debug, 'fallback', `Falling back to regex import extraction because AST emitted 0 facts`, filePath, {
          regexFacts: regexImports.length,
          requireAst: input.requireAst ?? false,
        });
      }
      facts.push(...regexImports);
    }
    return facts;
  },
  async extractGraph(input: ExtractorInput): Promise<GraphFact[]> {
    const graphFacts: GraphFact[] = [];
    const flowFacts = await this.extract(input);
    graphFacts.push(...flowFacts.map((fact, index) => ({
      id: `typescript-flow:${index}:${fact.from}:${fact.to}:${fact.file}:${fact.line ?? 0}`,
      kind: 'accesses_technology',
      subject: fact.from,
      technology: fact.to,
      confidence: fact.confidence,
      evidence: {
        extractor: typescriptServerPlugin.name,
        strategy: fact.strategy ?? 'legacy-flow',
        file: fact.file,
        line: fact.line,
        message: fact.evidence,
      },
    } satisfies GraphFact)));
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      graphFacts.push(...extractSemanticGraphFacts(content, filePath, input.componentName));
    }
    return graphFacts;
  },
};
