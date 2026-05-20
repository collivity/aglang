// Singleton tree-sitter loader with graceful fallback.
// If the native N-API binary is unavailable (e.g. unsupported platform, CI without
// prebuilt binaries), this module returns null and all callers fall back to regex.

import { createRequire } from 'module';
import type { default as Parser } from 'tree-sitter';

type ParserConstructor = typeof Parser;

interface LoadedParsers {
  Parser: ParserConstructor;
  typescript?: Parser.Language;
  javascript?: Parser.Language;
  python?: Parser.Language;
  csharp?: Parser.Language;
  golang?: Parser.Language;
  rust?: Parser.Language;
  java?: Parser.Language;
}

const require = createRequire(import.meta.url);
const warned = new Set<string>();
let cached: LoadedParsers | null | undefined = undefined; // undefined = not yet tried

function warnOnce(key: string, msg: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[aglang] ${msg} — falling back to regex extractors`);
  }
}

function tryLoadLanguage(name: string, loader: () => Parser.Language): Parser.Language | undefined {
  try {
    return loader();
  } catch (err) {
    warnOnce(name, `tree-sitter ${name} grammar could not be loaded (${(err as Error).message})`);
    return undefined;
  }
}

export function getTreeSitter(): LoadedParsers | null {
  if (cached !== undefined) return cached;

  try {
    // Dynamic requires via createRequire work from the built ESM CLI and keep
    // individual grammar failures from disabling every AST extractor.
    const ParserCtor = require('tree-sitter') as ParserConstructor;

    cached = {
      Parser: ParserCtor,
      typescript: tryLoadLanguage('typescript', () => require('tree-sitter-typescript').typescript as Parser.Language),
      javascript: tryLoadLanguage('javascript', () => require('tree-sitter-javascript') as Parser.Language),
      python: tryLoadLanguage('python', () => require('tree-sitter-python') as Parser.Language),
      csharp: tryLoadLanguage('csharp', () => require('tree-sitter-c-sharp') as Parser.Language),
      golang: tryLoadLanguage('golang', () => require('tree-sitter-go') as Parser.Language),
      rust: tryLoadLanguage('rust', () => require('tree-sitter-rust') as Parser.Language),
      java: tryLoadLanguage('java', () => require('tree-sitter-java') as Parser.Language),
    };
    return cached;
  } catch (err) {
    warnOnce('tree-sitter', `tree-sitter native binary could not be loaded (${(err as Error).message})`);
    cached = null;
    return null;
  }
}

/** Build a parser pre-loaded with the given language. Returns null if tree-sitter unavailable. */
export function makeParser(langKey: keyof Omit<LoadedParsers, 'Parser'>): Parser | null {
  const ts = getTreeSitter();
  if (!ts) return null;
  const language = ts[langKey];
  if (!language) return null;
  const parser = new ts.Parser();
  parser.setLanguage(language);
  return parser;
}

export function isTreeSitterLanguageAvailable(langKey: keyof Omit<LoadedParsers, 'Parser'>): boolean {
  return Boolean(getTreeSitter()?.[langKey]);
}
