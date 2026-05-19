// Import resolver — handles `import "path"` statements in .ag files.
// Resolves imports recursively, detects cycles, merges ASTs into one Program.

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { tokenize } from './lexer.ts';
import { parse } from './parser.ts';
import type { Program, Declaration } from './ast.ts';

export class ImportError extends Error {
  constructor(msg: string, public file: string) {
    super(`Import error in '${file}': ${msg}`);
  }
}

/**
 * Load a .ag file, resolve all its imports recursively, and return a merged Program.
 * @param filePath  Absolute path to the root .ag file
 * @param visiting  Current DFS stack — detects true cycles (A→B→A)
 * @param included  Global set of already-processed files — prevents duplicate declarations
 *                  from shared DAG nodes (A→B→D, A→C→D includes D exactly once)
 */
export function loadAndMerge(
  filePath: string,
  visiting: Set<string> = new Set(),
  included: Set<string> = new Set(),
): Program {
  const absPath = resolve(filePath);

  // True cycle: same file appears in its own ancestor chain
  if (visiting.has(absPath)) {
    throw new ImportError(`Circular import detected`, absPath);
  }
  // Already included via another path in the DAG — return empty to avoid duplicate declarations
  if (included.has(absPath)) {
    return { declarations: [] };
  }

  if (!existsSync(absPath)) {
    throw new ImportError(`File not found: ${absPath}`, absPath);
  }

  // Mark included BEFORE recursing so cross-imports from children also see it as done
  visiting.add(absPath);
  included.add(absPath);

  const source = readFileSync(absPath, 'utf8');
  const { imports, rest } = extractImports(source, absPath);

  // Recurse into each import first (depth-first, matches declaration order)
  const allDeclarations: Declaration[] = [];

  for (const importPath of imports) {
    const resolvedImport = resolve(dirname(absPath), importPath);
    const imported = loadAndMerge(resolvedImport, visiting, included);
    allDeclarations.push(...imported.declarations);
  }

  // Parse the remaining source (after stripping import lines)
  const tokens = tokenize(rest);
  const localProgram = parse(tokens);
  allDeclarations.push(...localProgram.declarations);

  visiting.delete(absPath);

  return { declarations: allDeclarations };
}

/**
 * Extract import paths from source, returning them and the remaining source.
 * Import syntax: import "relative/path/to/file.ag"
 */
function extractImports(
  source: string,
  filePath: string,
): { imports: string[]; rest: string } {
  const imports: string[] = [];
  const lines = source.split('\n');
  const resultLines: string[] = [];

  const importRe = /^\s*import\s+"([^"]+)"\s*(?:\/\/.*)?$/;

  for (const line of lines) {
    const m = importRe.exec(line);
    if (m) {
      const importPath = m[1]!;
      if (!importPath.endsWith('.ag')) {
        throw new ImportError(
          `Import path must end with .ag: "${importPath}"`,
          filePath,
        );
      }
      imports.push(importPath);
      // Replace with blank line to preserve line numbers for error messages
      resultLines.push('');
    } else {
      resultLines.push(line);
    }
  }

  return { imports, rest: resultLines.join('\n') };
}
