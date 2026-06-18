import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, resolve } from 'path';
import { getTreeSitter, makeParser } from '../src/analyzers/ast/loader.ts';
import { queryCaptures } from '../src/analyzers/ast/walker.ts';
import * as csharpQueries from '../src/analyzers/ast/queries/csharp.ts';
import * as goQueries from '../src/analyzers/ast/queries/golang.ts';
import * as javaQueries from '../src/analyzers/ast/queries/java.ts';
import * as pythonQueries from '../src/analyzers/ast/queries/python.ts';
import * as rustQueries from '../src/analyzers/ast/queries/rust.ts';
import * as tsQueries from '../src/analyzers/ast/queries/typescript.ts';

type LanguageName = 'typescript' | 'javascript' | 'python' | 'csharp' | 'golang' | 'rust' | 'java';

type Options = {
  target: string;
  lang?: LanguageName;
  mode: 'tree' | 'captures';
  query?: string;
  maxFiles: number;
  maxChars: number;
};

const extensionToLanguage: Record<string, LanguageName> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.cs': 'csharp',
  '.go': 'golang',
  '.rs': 'rust',
  '.java': 'java',
};

const queries: Record<LanguageName, Record<string, string>> = {
  typescript: tsQueries,
  javascript: tsQueries,
  python: pythonQueries,
  csharp: csharpQueries,
  golang: goQueries,
  rust: rustQueries,
  java: javaQueries,
};

function usage(): never {
  console.error([
    'Usage:',
    '  npx tsx scripts/debug-tree-sitter.ts --target <file-or-folder> [--lang golang] [--mode tree|captures] [--query ROUTE_QUERY] [--max-files 1] [--max-chars 20000]',
    '',
    'Examples:',
    '  npx tsx scripts/debug-tree-sitter.ts --target C:\\Users\\pante\\Codespaces\\aglang-analysis-repos\\kubernetes\\cmd\\cloud-controller-manager\\main.go --mode tree',
    '  npx tsx scripts/debug-tree-sitter.ts --target C:\\Users\\pante\\Codespaces\\aglang-analysis-repos\\kubernetes\\cmd\\cloud-controller-manager --lang golang --mode captures --query IMPORT_QUERY --max-files 5',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    target: '',
    mode: 'tree',
    maxFiles: 1,
    maxChars: 20000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (arg === '--target' && value) {
      options.target = value;
      i++;
    } else if (arg === '--lang' && value) {
      options.lang = value as LanguageName;
      i++;
    } else if (arg === '--mode' && value) {
      if (value !== 'tree' && value !== 'captures') usage();
      options.mode = value;
      i++;
    } else if (arg === '--query' && value) {
      options.query = value;
      i++;
    } else if (arg === '--max-files' && value) {
      options.maxFiles = Number(value);
      i++;
    } else if (arg === '--max-chars' && value) {
      options.maxChars = Number(value);
      i++;
    } else {
      usage();
    }
  }

  if (!options.target) usage();
  if (!Number.isFinite(options.maxFiles) || options.maxFiles < 1) usage();
  if (!Number.isFinite(options.maxChars) || options.maxChars < 1) usage();
  return options;
}

function inferLanguage(file: string, override?: LanguageName): LanguageName | undefined {
  return override ?? extensionToLanguage[extname(file).toLowerCase()];
}

function collectFiles(target: string, lang: LanguageName | undefined, maxFiles: number): string[] {
  const root = resolve(target);
  if (!existsSync(root)) throw new Error(`Target does not exist: ${root}`);
  const files: string[] = [];

  function visit(path: string): void {
    if (files.length >= maxFiles) return;
    const stat = statSync(path);
    if (stat.isFile()) {
      if (inferLanguage(path, lang)) files.push(path);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) {
      if (entry === '.git' || entry === 'node_modules' || entry === 'vendor') continue;
      visit(join(path, entry));
      if (files.length >= maxFiles) return;
    }
  }

  visit(root);
  return files;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n... truncated ${value.length - maxChars} chars ...`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const loaded = getTreeSitter();
  if (!loaded) throw new Error('tree-sitter native parser could not be loaded');

  const files = collectFiles(options.target, options.lang, options.maxFiles);
  if (files.length === 0) throw new Error(`No supported source files found under ${resolve(options.target)}`);

  for (const file of files) {
    const languageName = inferLanguage(file, options.lang);
    if (!languageName) continue;
    const parser = makeParser(languageName);
    const language = loaded[languageName];
    if (!parser || !language) throw new Error(`tree-sitter ${languageName} grammar could not be loaded`);

    const source = readFileSync(file, 'utf8');
    const tree = parser.parse(source);
    console.log(`\n=== ${file} (${languageName}) ===`);

    if (options.mode === 'tree') {
      console.log(truncate(tree.rootNode.toString(), options.maxChars));
      continue;
    }

    const queryName = options.query;
    if (!queryName) throw new Error('--query is required when --mode captures is used');
    const querySource = queries[languageName][queryName];
    if (!querySource) {
      throw new Error(`Unknown ${languageName} query '${queryName}'. Available: ${Object.keys(queries[languageName]).join(', ')}`);
    }
    console.log(JSON.stringify(queryCaptures(tree, language, querySource), null, 2));
  }
}

main();
