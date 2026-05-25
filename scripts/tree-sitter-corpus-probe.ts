import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { createExtractorDebugSession } from '../src/analyzers/plugin.ts';
import { getTreeSitter, isTreeSitterLanguageAvailable, makeParser } from '../src/analyzers/ast/loader.ts';
import { parseAndQuery } from '../src/analyzers/ast/walker.ts';
import * as csharpQueries from '../src/analyzers/ast/queries/csharp.ts';
import * as goQueries from '../src/analyzers/ast/queries/golang.ts';
import * as pythonQueries from '../src/analyzers/ast/queries/python.ts';
import * as rustQueries from '../src/analyzers/ast/queries/rust.ts';
import * as tsQueries from '../src/analyzers/ast/queries/typescript.ts';

type LangKey = 'typescript' | 'python' | 'csharp' | 'golang' | 'rust';

type QueryProbe = {
  language: LangKey;
  queryName: string;
  querySource: string;
  extensions: string[];
};

type QuerySummary = {
  language: LangKey;
  query: string;
  supported: boolean;
  files_scanned: number;
  files_with_captures: number;
  total_captures: number;
  sample_files: string[];
  query_errors: string[];
};

const DEFAULT_REPO = 'C:\\Users\\pante\\Codespaces\\collivity';

const probes: QueryProbe[] = [
  { language: 'typescript', queryName: 'IMPORT_QUERY', querySource: tsQueries.IMPORT_QUERY, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] },
  { language: 'typescript', queryName: 'IMPORT_NAMED_QUERY', querySource: tsQueries.IMPORT_NAMED_QUERY, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] },
  { language: 'typescript', queryName: 'EXPRESS_ROUTE_QUERY', querySource: tsQueries.EXPRESS_ROUTE_QUERY, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] },
  { language: 'python', queryName: 'DJANGO_PATH_QUERY', querySource: pythonQueries.DJANGO_PATH_QUERY, extensions: ['.py', '.pyw'] },
  { language: 'csharp', queryName: 'USING_QUERY', querySource: csharpQueries.USING_QUERY, extensions: ['.cs', '.csx'] },
  { language: 'csharp', queryName: 'CTOR_PARAM_QUERY', querySource: csharpQueries.CTOR_PARAM_QUERY, extensions: ['.cs', '.csx'] },
  { language: 'csharp', queryName: 'FIELD_QUERY', querySource: csharpQueries.FIELD_QUERY, extensions: ['.cs', '.csx'] },
  { language: 'csharp', queryName: 'PROPERTY_QUERY', querySource: csharpQueries.PROPERTY_QUERY, extensions: ['.cs', '.csx'] },
  { language: 'csharp', queryName: 'NEW_OBJECT_QUERY', querySource: csharpQueries.NEW_OBJECT_QUERY, extensions: ['.cs', '.csx'] },
  { language: 'golang', queryName: 'CALL_QUERY', querySource: goQueries.CALL_QUERY, extensions: ['.go'] },
  { language: 'golang', queryName: 'ROUTE_QUERY', querySource: goQueries.ROUTE_QUERY, extensions: ['.go'] },
  { language: 'rust', queryName: 'ROUTE_ATTR_QUERY', querySource: rustQueries.ROUTE_ATTR_QUERY, extensions: ['.rs'] },
];

function walkFiles(root: string, extensions: Set<string>): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function runProbe(root: string, probe: QueryProbe): QuerySummary {
  const summary: QuerySummary = {
    language: probe.language,
    query: probe.queryName,
    supported: isTreeSitterLanguageAvailable(probe.language),
    files_scanned: 0,
    files_with_captures: 0,
    total_captures: 0,
    sample_files: [],
    query_errors: [],
  };

  if (!summary.supported) return summary;

  const parser = makeParser(probe.language);
  const language = getTreeSitter()?.[probe.language];
  if (!parser || !language) return summary;

  const files = walkFiles(root, new Set(probe.extensions));
  summary.files_scanned = files.length;

  for (const file of files) {
    const debug = createExtractorDebugSession(true, false);
    const content = statSync(file).size > 1_000_000 ? '' : readFileSafely(file);
    if (content === null) continue;
    const captures = parseAndQuery(parser, language, content, probe.querySource, {
      debug,
      extractor: `${probe.language}:${probe.queryName}`,
      queryName: probe.queryName,
      file,
    });
    const queryError = debug.events.find(event => event.stage === 'ast_query_error');
    if (queryError && summary.query_errors.length < 3) {
      summary.query_errors.push(`${file}: ${(queryError.details?.error as string) ?? queryError.message}`);
    }
    if (captures.length === 0) continue;
    summary.files_with_captures += 1;
    summary.total_captures += captures.length;
    if (summary.sample_files.length < 3) summary.sample_files.push(file);
  }

  return summary;
}

function readFileSafely(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function main(): void {
  const repoRoot = path.resolve(process.argv[2] ?? DEFAULT_REPO);
  if (!existsSync(repoRoot)) {
    console.log(JSON.stringify({
      repo: repoRoot,
      skipped: true,
      reason: 'repository not found',
    }, null, 2));
    process.exit(0);
  }

  const summaries = probes.map(probe => runProbe(repoRoot, probe));
  console.log(JSON.stringify({
    repo: repoRoot,
    generated_at: new Date().toISOString(),
    summaries,
  }, null, 2));
}

main();
