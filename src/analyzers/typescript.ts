// TypeScript analyzer — extracts API route calls from .ts/.tsx files
// Used by the contract gate to verify that fetch() calls match declared contracts.

import { readFileSync } from 'fs';

export interface RouteFact {
  method: string;        // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string;          // raw extracted path (may contain template vars)
  normalized: string;    // positional canonical form: /api/products/{}/capture-sessions
  file: string;
}

// Normalize a route path to positional form:
// - Replace named params {productId:guid} / {productId} / ${productId} / :paramName with {}
// - Strip trailing slash, lowercase, collapse double slashes
export function normalizeRoute(path: string): string {
  return path
    .replace(/\$?\{[^}]+\}/g, '{}')    // ${productId}, {productId}, {productId:guid} → {}
    .replace(/:([^/]+)/g, '{}')         // Express/Go/Rust :param → {}
    .toLowerCase()
    .replace(/\/+/g, '/')               // collapse double slashes
    .replace(/\/$/, '');                // strip trailing slash
}

// Extract route facts from TypeScript source content.
// Handles:
//   fetch(`${apiBase}/api/products/${productId}/capture-sessions`, { method: 'POST' })
//   fetch('/api/users', { method: 'DELETE' })
export function extractRoutesFromTypeScript(content: string, filePath: string): RouteFact[] {
  const routes: RouteFact[] = [];

  // Match fetch() calls: fetch(`...`, {...}) or fetch("...", {...}) or fetch('...', {...})
  // Template literal version (most common in the collivity codebase)
  const templateFetchRe = /fetch\(`([^`]+)`(?:\s*,\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})?\)/gs;
  // String literal version
  const stringFetchRe = /fetch\(['"]([^'"]+)['"](?:\s*,\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})?\)/gs;

  const extractFromMatch = (rawUrl: string, optionsStr: string | undefined) => {
    // Extract HTTP method from options object (default GET)
    const methodMatch = optionsStr?.match(/method\s*:\s*['"](\w+)['"]/);
    const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'GET';

    // Normalize the URL:
    // 1. Strip leading ${baseVar} (e.g. ${apiBase}, ${BASE_URL})
    let path = rawUrl.replace(/^\$\{[^}]+\}/, '');
    // 2. Strip scheme + host if present (http://... or https://...)
    path = path.replace(/^https?:\/\/[^/]+/, '');
    // 3. Ensure leading slash
    if (path && !path.startsWith('/')) path = '/' + path;
    // 4. Must look like an API path (starts with /)
    if (!path || !path.startsWith('/')) return;

    const normalized = normalizeRoute(path);
    if (!normalized || normalized === '/') return;

    routes.push({ method, path, normalized, file: filePath });
  };

  let m: RegExpExecArray | null;
  while ((m = templateFetchRe.exec(content)) !== null) {
    extractFromMatch(m[1]!, m[2]);
  }
  while ((m = stringFetchRe.exec(content)) !== null) {
    extractFromMatch(m[1]!, m[2]);
  }

  return routes;
}

// Batch-analyze multiple TypeScript files
export function analyzeTypeScriptFiles(filePaths: string[]): RouteFact[] {
  const facts: RouteFact[] = [];
  for (const filePath of filePaths) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    facts.push(...extractRoutesFromTypeScript(content, filePath));
  }
  return facts;
}
