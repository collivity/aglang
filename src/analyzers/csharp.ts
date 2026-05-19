// C# static analyzer — detects flow patterns in .cs files
// Implements ExtractorPlugin for batch analysis of C# components.

import { readFileSync } from 'fs';
import type { ExtractorPlugin, ExtractorInput, FlowFact } from './plugin.ts';
import { normalizeRoute } from './typescript.ts';

// Re-export FlowFact for backward compatibility
export type { FlowFact };

export interface RouteFact {
  method: string;    // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string;      // raw path from attributes
  normalized: string;
  file: string;
}

// Extract HTTP routes from C# controller files by parsing attribute annotations.
// Handles:
//   [Route("api/products/{productId:guid}/capture-sessions")]
//   [HttpGet] / [HttpPost] / [HttpGet("sub-route")]
export function extractRoutesFromCSharp(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];

  // Class-level route prefix: [Route("api/...")]
  const classRouteMatch = content.match(/\[Route\s*\(\s*"([^"]+)"\s*\)\]/);
  const classRoute = classRouteMatch ? classRouteMatch[1]! : '';

  // Method-level HTTP verbs: [HttpGet], [HttpGet("sub-path")], [HttpPost], etc.
  const methodRouteRe = /\[Http(Get|Post|Put|Delete|Patch)(?:\s*\(\s*"([^"]*)"\s*\))?\]/g;
  let m: RegExpExecArray | null;
  while ((m = methodRouteRe.exec(content)) !== null) {
    const method = m[1]!.toUpperCase();
    const subPath = m[2] ?? '';
    let fullPath: string;
    if (classRoute) {
      fullPath = '/' + classRoute + (subPath ? '/' + subPath : '');
    } else {
      fullPath = subPath ? '/' + subPath : '/';
    }
    // Collapse double slashes
    fullPath = fullPath.replace(/\/+/g, '/');
    routes.push({ method, path: fullPath, normalized: normalizeRoute(fullPath), file: filePath });
  }

  return routes;
}

// Batch-analyze multiple C# files for routes
export function analyzeCSharpFilesForRoutes(filePaths: string[]): RouteFact[] {
  const facts: RouteFact[] = [];
  for (const filePath of filePaths) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    facts.push(...extractRoutesFromCSharp(content, filePath));
  }
  return facts;
}

// Types that signal direct database access (bypassing the service layer)
const DB_CONTEXT_TYPES = ['ApplicationDbContext', 'DbContext', 'MongoDatabase', 'IMongoCollection'];

// Types that signal direct object storage access
const STORAGE_TYPES = ['IObjectStorageService', 'ObjectStorageService', 'IAmazonS3', 'BlobServiceClient', 'MinioClient'];

// Types that signal external HTTP calls
const EXTERNAL_HTTP_TYPES = ['HttpClient', 'IHttpClientFactory', 'RestClient'];

// Types that signal direct cache access
const CACHE_TYPES = ['IDistributedCache', 'IConnectionMultiplexer', 'StackExchange.Redis'];

function analyzeFile(
  content: string,
  filePath: string,
  componentName: string,
  _mappings: Record<string, string>,
): FlowFact[] {
  const facts: FlowFact[] = [];

  const isController =
    /class\s+\w+Controller/.test(content) ||
    filePath.includes('Controller') ||
    /\[ApiController\]/.test(content);

  // Constructor-injected dependencies (strongest evidence — DI = explicit coupling)
  const ctorParamRe = /(?:public\s+\w+\s*\(([^)]+)\))/g;
  let m: RegExpExecArray | null;
  while ((m = ctorParamRe.exec(content)) !== null) {
    const params = m[1]!;
    for (const dbType of DB_CONTEXT_TYPES) {
      if (params.includes(dbType)) {
        facts.push({
          from: componentName,
          to: 'postgres_db',
          confidence: 'definite',
          evidence: `Constructor injects '${dbType}' directly into ${isController ? 'Controller' : 'class'}`,
          file: filePath,
        });
      }
    }
    for (const storageType of STORAGE_TYPES) {
      if (params.includes(storageType) && isController) {
        facts.push({
          from: componentName,
          to: 'object_store',
          confidence: 'definite',
          evidence: `Controller constructor injects '${storageType}'`,
          file: filePath,
        });
      }
    }
    for (const cacheType of CACHE_TYPES) {
      if (params.includes(cacheType) && isController) {
        facts.push({
          from: componentName,
          to: 'cache',
          confidence: 'definite',
          evidence: `Controller constructor injects '${cacheType}'`,
          file: filePath,
        });
      }
    }
  }

  // Field declarations (weaker than ctor injection, but still explicit)
  const fieldRe = /private\s+(?:readonly\s+)?(\w+)(?:<[^>]+>)?\s+_\w+\s*;/g;
  while ((m = fieldRe.exec(content)) !== null) {
    const typeName = m[1]!;
    if (DB_CONTEXT_TYPES.includes(typeName) && isController) {
      facts.push({
        from: componentName,
        to: 'postgres_db',
        confidence: 'definite',
        evidence: `Field of type '${typeName}' in Controller`,
        file: filePath,
      });
    }
    if (CACHE_TYPES.includes(typeName) && isController) {
      facts.push({
        from: componentName,
        to: 'cache',
        confidence: 'definite',
        evidence: `Field of type '${typeName}' in Controller`,
        file: filePath,
      });
    }
  }

  // Direct `new` instantiation of infrastructure clients (probable — could be in test helpers)
  const newInstClients: Array<[RegExp, string]> = [
    [/new\s+ApplicationDbContext\s*\(/g,    'postgres_db'],
    [/new\s+MongoClient\s*\(/g,             'mongodb'],
    [/new\s+AmazonS3Client\s*\(/g,          'object_store'],
    [/new\s+BlobServiceClient\s*\(/g,       'object_store'],
    [/new\s+ConnectionMultiplexer\s*\(/g,   'cache'],
  ];
  for (const [re, targetNode] of newInstClients) {
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      facts.push({
        from: componentName,
        to: targetNode,
        confidence: 'probable',
        evidence: `Direct instantiation: new ${m[0].match(/new\s+(\w+)/)?.[1]}(...)`,
        file: filePath,
      });
    }
  }

  return facts;
}

export const csharpPlugin: ExtractorPlugin = {
  name: 'C# regex analyzer',
  extensions: ['.cs', '.csx'],
  extract(input: ExtractorInput): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const filePath of input.files) {
      let content: string;
      try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
      facts.push(...analyzeFile(content, filePath, input.componentName, input.mappings));
    }
    return facts;
  },
};

// Legacy single-file API (kept for backward compat with existing check-file tests)
export function analyzeCSharp(
  content: string,
  filePath: string,
  componentName: string,
  mappings: Record<string, string>,
): FlowFact[] {
  return analyzeFile(content, filePath, componentName, mappings);
}
