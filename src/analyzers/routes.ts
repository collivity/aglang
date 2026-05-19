// Shared server-route extraction — used by both contract-gate and the spec generator.
// Each analyzer exports its own route extractor; this module unifies them behind
// a single async function that reads files in parallel.

import { promises as fsp } from 'fs';
import { extname } from 'path';
import { extractRoutesFromCSharp } from './csharp.ts';
import { extractRoutesFromPython } from './python.ts';
import { extractRoutesFromGo } from './golang.ts';
import { extractRoutesFromRust } from './rust.ts';
import { extractRoutesFromJava, extractRoutesFromScala } from './java.ts';
import { extractServerRoutesFromTypeScript } from './typescript-server.ts';
import { extractRoutesFromSwift } from './swift.ts';
import { extractRoutesFromTypeScript } from './typescript.ts';
export type { RouteFact } from './typescript.ts';

const TS_LIKE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

/** Extract server-side route definitions from a list of file paths (parallel IO). */
export async function extractServerRoutes(filePaths: string[]): Promise<import('./typescript.ts').RouteFact[]> {
  const results = await Promise.all(
    filePaths.map(async (filePath) => {
      let content: string;
      try { content = await fsp.readFile(filePath, 'utf8'); } catch { return []; }
      const ext = extname(filePath).toLowerCase();
      if (ext === '.cs' || ext === '.csx') return extractRoutesFromCSharp(content, filePath);
      if (ext === '.py' || ext === '.pyw') return extractRoutesFromPython(content, filePath);
      if (ext === '.go') return extractRoutesFromGo(content, filePath);
      if (ext === '.rs') return extractRoutesFromRust(content, filePath);
      if (ext === '.java') return extractRoutesFromJava(content, filePath);
      if (ext === '.scala') return extractRoutesFromScala(content, filePath);
      if (TS_LIKE.has(ext)) return extractServerRoutesFromTypeScript(content, filePath);
      if (ext === '.swift') return extractRoutesFromSwift(content, filePath);
      return [];
    }),
  );
  return results.flat();
}

/** Extract client-side fetch/HTTP calls from a list of file paths (parallel IO). */
export async function extractClientRoutes(filePaths: string[]): Promise<import('./typescript.ts').RouteFact[]> {
  const results = await Promise.all(
    filePaths.map(async (filePath) => {
      let content: string;
      try { content = await fsp.readFile(filePath, 'utf8'); } catch { return []; }
      const ext = extname(filePath).toLowerCase();
      if (TS_LIKE.has(ext)) return extractRoutesFromTypeScript(content, filePath);
      return [];
    }),
  );
  return results.flat();
}
