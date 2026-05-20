// C# static analyzer — detects flow patterns in .cs files
// Implements ExtractorPlugin for batch analysis of C# components.
// Uses tree-sitter AST when available, falls back to regex silently.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact, ExtractionStrategy } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';
import { makeParser, getTreeSitter } from './ast/loader.ts';
import { parseAndQuery } from './ast/walker.ts';
import {
  ATTRIBUTE_QUERY, ATTRIBUTE_NAME_QUERY, CTOR_PARAM_QUERY,
  FIELD_QUERY, NEW_OBJECT_QUERY, USING_QUERY,
} from './ast/queries/csharp.ts';

// Re-export FlowFact for backward compatibility
export type { FlowFact };

export interface RouteFact {
  method: string;    // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string;      // raw path from attributes
  normalized: string;
  file: string;
}

function withStrategy(facts: FlowFact[], strategy: ExtractionStrategy): FlowFact[] {
  return facts.map(f => ({ ...f, strategy: f.strategy ?? strategy }));
}

// Types that signal direct database access (bypassing the service layer)
const DB_CONTEXT_TYPES = new Set(['ApplicationDbContext', 'DbContext', 'MongoDatabase', 'IMongoCollection']);
// Types that signal direct object storage access
const STORAGE_TYPES = new Set(['IObjectStorageService', 'ObjectStorageService', 'IAmazonS3', 'BlobServiceClient', 'MinioClient']);
// Types that signal external HTTP calls
const EXTERNAL_HTTP_TYPES = new Set(['HttpClient', 'IHttpClientFactory', 'RestClient']);
// Types that signal direct cache access
const CACHE_TYPES = new Set(['IDistributedCache', 'IConnectionMultiplexer']);

// Using-directive prefixes that identify infrastructure packages
const USING_TO_INFRA: Array<[RegExp, string]> = [
  [/MongoDB/, 'mongodb'],
  [/StackExchange\.Redis|Microsoft\.Extensions\.Caching/, 'cache'],
  [/Amazon\.S3|Azure\.Storage\.Blobs|Minio/, 'object_store'],
  [/Microsoft\.EntityFrameworkCore|Npgsql|MySql/, 'relational_db'],
];

// ── AST-based route extraction ────────────────────────────────────────────────

function extractRoutesAst(content: string, filePath: string): RouteFact[] {
  const parser = makeParser('csharp');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['csharp'];
  if (!language) return [];
  const routes: RouteFact[] = [];

  const attrCaptures = parseAndQuery(parser, language, content, ATTRIBUTE_QUERY);

  let classRoute = '';
  const httpMethods: Array<{ method: string; subPath: string }> = [];

  for (let i = 0; i < attrCaptures.length; i++) {
    const nameCap = attrCaptures[i];
    if (nameCap?.name === 'attr_name') {
      const nextCap = attrCaptures[i + 1];
      const arg = nextCap?.name === 'attr_arg' ? nextCap.text : undefined;
      if (nameCap.text === 'Route' && arg) {
        classRoute = arg;
        if (arg) i++;
      } else {
        const match = /^Http(Get|Post|Put|Delete|Patch)$/.exec(nameCap.text);
        if (match) {
          httpMethods.push({ method: match[1]!.toUpperCase(), subPath: arg ?? '' });
          if (arg) i++;
        }
      }
    }
  }

  for (const { method, subPath } of httpMethods) {
    let fullPath = classRoute
      ? '/' + classRoute + (subPath ? '/' + subPath : '')
      : subPath ? '/' + subPath : '/';
    fullPath = fullPath.replace(/\/+/g, '/');
    routes.push({ method, path: fullPath, normalized: normalizeRoute(fullPath), file: filePath });
  }

  return routes;
}

// ── Regex fallback: route extraction ─────────────────────────────────────────

function extractRoutesRegex(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];
  const classRouteMatch = content.match(/\[Route\s*\(\s*"([^"]+)"\s*\)\]/);
  const classRoute = classRouteMatch ? classRouteMatch[1]! : '';
  const methodRouteRe = /\[Http(Get|Post|Put|Delete|Patch)(?:\s*\(\s*"([^"]*)"\s*\))?\]/g;
  let m: RegExpExecArray | null;
  while ((m = methodRouteRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const subPath = m[2] ?? '';
    let fullPath = classRoute ? '/' + classRoute + (subPath ? '/' + subPath : '') : subPath ? '/' + subPath : '/';
    fullPath = fullPath.replace(/\/+/g, '/');
    routes.push({ method, path: fullPath, normalized: normalizeRoute(fullPath), file: filePath });
  }
  return routes;
}

// ── AST-based infrastructure detection ───────────────────────────────────────

function analyzeFileAst(content: string, filePath: string, componentName: string): FlowFact[] {
  const parser = makeParser('csharp');
  if (!parser) return [];
  const ts = getTreeSitter()!;
  const language = ts['csharp'];
  if (!language) return [];

  const facts: FlowFact[] = [];
  const emitted = new Set<string>();

  const attrNameCaptures = parseAndQuery(parser, language, content, ATTRIBUTE_NAME_QUERY);
  const attrNames = new Set(attrNameCaptures.map(c => c.text));
  const isController = attrNames.has('ApiController') || attrNames.has('Controller') ||
    /class\s+\w+Controller/.test(content) || filePath.includes('Controller');

  const usingCaptures = parseAndQuery(parser, language, content, USING_QUERY);
  const usingText = usingCaptures.map(c => c.text).join(' ');
  for (const [pattern, infraNode] of USING_TO_INFRA) {
    if (pattern.test(usingText) && !emitted.has(infraNode)) {
      facts.push({ from: componentName, to: infraNode, confidence: 'probable', evidence: `Using directive indicates ${infraNode} dependency`, file: filePath });
      emitted.add(infraNode);
    }
  }

  const ctorCaptures = parseAndQuery(parser, language, content, CTOR_PARAM_QUERY);
  for (const c of ctorCaptures) {
    const typeName = c.text;
    if ((DB_CONTEXT_TYPES.has(typeName) || typeName === 'DbContext') && !emitted.has('relational_db')) {
      facts.push({ from: componentName, to: 'relational_db', confidence: 'definite', evidence: `Constructor injects '${typeName}'`, file: filePath });
      emitted.add('relational_db');
    }
    if (typeName.includes('Mongo') && !emitted.has('mongodb')) {
      facts.push({ from: componentName, to: 'mongodb', confidence: 'definite', evidence: `Constructor injects '${typeName}'`, file: filePath });
      emitted.add('mongodb');
    }
    if (STORAGE_TYPES.has(typeName) && !emitted.has('object_store')) {
      facts.push({ from: componentName, to: 'object_store', confidence: 'definite', evidence: `Constructor injects '${typeName}'`, file: filePath });
      emitted.add('object_store');
    }
    if (CACHE_TYPES.has(typeName) && !emitted.has('cache')) {
      facts.push({ from: componentName, to: 'cache', confidence: 'definite', evidence: `Constructor injects '${typeName}'`, file: filePath });
      emitted.add('cache');
    }
    if (EXTERNAL_HTTP_TYPES.has(typeName) && !emitted.has('external_api') && isController) {
      facts.push({ from: componentName, to: 'external_api', confidence: 'definite', evidence: `Constructor injects '${typeName}'`, file: filePath });
      emitted.add('external_api');
    }
  }

  const fieldCaptures = parseAndQuery(parser, language, content, FIELD_QUERY);
  for (const c of fieldCaptures) {
    const typeName = c.text;
    if (DB_CONTEXT_TYPES.has(typeName) && !emitted.has('relational_db')) {
      facts.push({ from: componentName, to: 'relational_db', confidence: 'definite', evidence: `Field of type '${typeName}'`, file: filePath });
      emitted.add('relational_db');
    }
    if (CACHE_TYPES.has(typeName) && !emitted.has('cache')) {
      facts.push({ from: componentName, to: 'cache', confidence: 'definite', evidence: `Field of type '${typeName}'`, file: filePath });
      emitted.add('cache');
    }
  }

  const newCaptures = parseAndQuery(parser, language, content, NEW_OBJECT_QUERY);
  for (const c of newCaptures) {
    const className = c.text;
    if (className === 'MongoClient' && !emitted.has('mongodb')) {
      facts.push({ from: componentName, to: 'mongodb', confidence: 'probable', evidence: `new ${className}(...)`, file: filePath });
      emitted.add('mongodb');
    }
    if ((className === 'AmazonS3Client' || className === 'BlobServiceClient') && !emitted.has('object_store')) {
      facts.push({ from: componentName, to: 'object_store', confidence: 'probable', evidence: `new ${className}(...)`, file: filePath });
      emitted.add('object_store');
    }
    if (className === 'ApplicationDbContext' && !emitted.has('relational_db')) {
      facts.push({ from: componentName, to: 'relational_db', confidence: 'probable', evidence: `new ${className}(...)`, file: filePath });
      emitted.add('relational_db');
    }
  }

  return facts;
}

// ── Regex fallback: infrastructure detection ──────────────────────────────────

function analyzeFileRegex(content: string, filePath: string, componentName: string): FlowFact[] {
  const facts: FlowFact[] = [];
  const isController = /class\s+\w+Controller/.test(content) || filePath.includes('Controller') || /\[ApiController\]/.test(content);
  const ctorParamRe = /(?:public\s+\w+\s*\(([^)]+)\))/g;
  let m: RegExpExecArray | null;
  while ((m = ctorParamRe.exec(content)) !== null) {
    const params = m[1]!;
    for (const dbType of DB_CONTEXT_TYPES) {
      if (params.includes(dbType)) facts.push({ from: componentName, to: 'postgres_db', confidence: 'definite', evidence: `Constructor injects '${dbType}'`, file: filePath });
    }
    for (const st of STORAGE_TYPES) {
      if (params.includes(st) && isController) facts.push({ from: componentName, to: 'object_store', confidence: 'definite', evidence: `Constructor injects '${st}'`, file: filePath });
    }
    for (const ct of CACHE_TYPES) {
      if (params.includes(ct) && isController) facts.push({ from: componentName, to: 'cache', confidence: 'definite', evidence: `Constructor injects '${ct}'`, file: filePath });
    }
  }
  const fieldRe = /private\s+(?:readonly\s+)?(\w+)(?:<[^>]+>)?\s+_\w+\s*;/g;
  while ((m = fieldRe.exec(content)) !== null) {
    const typeName = m[1]!;
    if (DB_CONTEXT_TYPES.has(typeName) && isController) facts.push({ from: componentName, to: 'postgres_db', confidence: 'definite', evidence: `Field of type '${typeName}'`, file: filePath });
    if (CACHE_TYPES.has(typeName) && isController) facts.push({ from: componentName, to: 'cache', confidence: 'definite', evidence: `Field of type '${typeName}'`, file: filePath });
  }
  const newInst: Array<[RegExp, string]> = [
    [/new\s+ApplicationDbContext\s*\(/g, 'postgres_db'],
    [/new\s+MongoClient\s*\(/g, 'mongodb'],
    [/new\s+AmazonS3Client\s*\(/g, 'object_store'],
    [/new\s+BlobServiceClient\s*\(/g, 'object_store'],
    [/new\s+ConnectionMultiplexer\s*\(/g, 'cache'],
  ];
  for (const [re, targetNode] of newInst) {
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      facts.push({ from: componentName, to: targetNode, confidence: 'probable', evidence: `Direct instantiation: new ${m[0].match(/new\s+(\w+)/)?.[1]}(...)`, file: filePath });
    }
  }
  return facts;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function extractRoutesFromCSharp(content: string, filePath: string): RouteFact[] {
  const astRoutes = extractRoutesAst(content, filePath);
  if (astRoutes.length > 0) return astRoutes;
  return extractRoutesRegex(content, filePath);
}

export function analyzeCSharpFilesForRoutes(filePaths: string[]): RouteFact[] {
  const facts: RouteFact[] = [];
  for (const filePath of filePaths) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    facts.push(...extractRoutesFromCSharp(content, filePath));
  }
  return facts;
}

export const csharpPlugin: ExtractorPlugin = {
  name: 'C# AST/regex analyzer',
  extensions: ['.cs', '.csx'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      const astFacts = analyzeFileAst(content, filePath, input.componentName);
      facts.push(...(astFacts.length > 0
        ? withStrategy(astFacts, 'ast')
        : withStrategy(analyzeFileRegex(content, filePath, input.componentName), 'regex')));
    }
    return facts;
  },
};

// Legacy single-file API (kept for backward compat with existing check-file tests)
export function analyzeCSharp(
  content: string,
  filePath: string,
  componentName: string,
  _mappings: Record<string, string>,
): FlowFact[] {
  return analyzeFileRegex(content, filePath, componentName);
}
