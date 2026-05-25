// Shared AST walking utilities used by all language extractors.
// Wraps tree-sitter parse + query API with a consistent interface.

import { createRequire } from 'module';
import type { default as Parser } from 'tree-sitter';
import type { ExtractorDebugSession } from '../plugin.ts';

const require = createRequire(import.meta.url);
const QueryCtor = (require('tree-sitter') as { Query: new (language: unknown, source: string) => { captures(node: unknown): Array<{ name: string; node: unknown }> } }).Query;

export interface CaptureMatch {
  name: string;
  text: string;
  startRow: number; // 0-indexed
}

/**
 * Run a tree-sitter query against a parsed tree and return named captures.
 * Returns empty array if parser or query is null.
 */
export function queryCaptures(
  tree: Parser.Tree,
  language: any,
  querySource: string,
): CaptureMatch[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = new QueryCtor(language, querySource);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captures: Array<{ name: string; node: any }> = q.captures(tree.rootNode);
  return captures.map(({ name, node }) => ({
    name,
    text: node.text as string,
    startRow: node.startPosition.row as number,
  }));
}

/**
 * Parse content string and run a query. Returns captures or empty array on any error.
 * parser must be pre-loaded with the target language.
 */
export function parseAndQuery(
  parser: Parser,
  language: any,
  content: string,
  querySource: string,
  options?: {
    debug?: ExtractorDebugSession;
    extractor?: string;
    queryName?: string;
    file?: string;
  },
): CaptureMatch[] {
  try {
    const tree = parser.parse(content);
    const captures = queryCaptures(tree, language, querySource);
    options?.debug?.log({
      extractor: options.extractor ?? 'unknown',
      stage: 'ast_query',
      message: `Query '${options.queryName ?? 'anonymous'}' returned ${captures.length} capture(s)`,
      file: options.file,
      details: {
        query: options.queryName ?? 'anonymous',
        captures: captures.length,
      },
    });
    return captures;
  } catch (error) {
    options?.debug?.log({
      extractor: options.extractor ?? 'unknown',
      stage: 'ast_query_error',
      message: `Query '${options.queryName ?? 'anonymous'}' failed`,
      file: options.file,
      details: {
        query: options.queryName ?? 'anonymous',
        error: (error as Error).message,
      },
    });
    return [];
  }
}

/**
 * Group captures by startRow so callers can process all captures on a single line together.
 */
export function groupByRow(captures: CaptureMatch[]): Map<number, CaptureMatch[]> {
  const map = new Map<number, CaptureMatch[]>();
  for (const c of captures) {
    const list = map.get(c.startRow) ?? [];
    list.push(c);
    map.set(c.startRow, list);
  }
  return map;
}

/** Convenience: get text of first capture with given name, or undefined. */
export function firstCapture(captures: CaptureMatch[], name: string): string | undefined {
  return captures.find(c => c.name === name)?.text;
}
