// Shared AST walking utilities used by all language extractors.
// Wraps tree-sitter parse + query API with a consistent interface.

import type { default as Parser } from 'tree-sitter';

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
  language: Parser.Language,
  querySource: string,
): CaptureMatch[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (language as any).query(querySource);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captures: Array<{ name: string; node: any }> = q.captures(tree.rootNode);
    return captures.map(({ name, node }) => ({
      name,
      text: node.text as string,
      startRow: node.startPosition.row as number,
    }));
  } catch {
    return [];
  }
}

/**
 * Parse content string and run a query. Returns captures or empty array on any error.
 * parser must be pre-loaded with the target language.
 */
export function parseAndQuery(
  parser: Parser,
  language: Parser.Language,
  content: string,
  querySource: string,
): CaptureMatch[] {
  try {
    const tree = parser.parse(content);
    return queryCaptures(tree, language, querySource);
  } catch {
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
