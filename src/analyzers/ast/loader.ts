// Singleton tree-sitter loader with graceful fallback.
// If the native N-API binary is unavailable (e.g. unsupported platform, CI without
// prebuilt binaries), this module returns null and all callers fall back to regex.

import type { default as Parser } from 'tree-sitter';

type ParserConstructor = typeof Parser;

interface LoadedParsers {
  Parser: ParserConstructor;
  typescript: Parser.Language;
  javascript: Parser.Language;
  python: Parser.Language;
  csharp: Parser.Language;
  golang: Parser.Language;
  rust: Parser.Language;
  java: Parser.Language;
}

let warned = false;
let cached: LoadedParsers | null | undefined = undefined; // undefined = not yet tried

function warnOnce(msg: string): void {
  if (!warned) {
    warned = true;
    console.warn(`[aglang] ${msg} — falling back to regex extractors`);
  }
}

export function getTreeSitter(): LoadedParsers | null {
  if (cached !== undefined) return cached;

  try {
    // Dynamic requires to avoid bundler inlining and to survive import errors gracefully.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ParserCtor = require('tree-sitter') as ParserConstructor;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsLang = require('tree-sitter-typescript').typescript as Parser.Language;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsLang = require('tree-sitter-javascript') as Parser.Language;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pyLang = require('tree-sitter-python') as Parser.Language;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const csLang = require('tree-sitter-c-sharp') as Parser.Language;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const goLang = require('tree-sitter-go') as Parser.Language;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rsLang = require('tree-sitter-rust') as Parser.Language;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const javaLang = require('tree-sitter-java') as Parser.Language;

    cached = {
      Parser: ParserCtor,
      typescript: tsLang,
      javascript: jsLang,
      python: pyLang,
      csharp: csLang,
      golang: goLang,
      rust: rsLang,
      java: javaLang,
    };
    return cached;
  } catch (err) {
    warnOnce(`tree-sitter native binary could not be loaded (${(err as Error).message})`);
    cached = null;
    return null;
  }
}

/** Build a parser pre-loaded with the given language. Returns null if tree-sitter unavailable. */
export function makeParser(langKey: keyof Omit<LoadedParsers, 'Parser'>): Parser | null {
  const ts = getTreeSitter();
  if (!ts) return null;
  const parser = new ts.Parser();
  parser.setLanguage(ts[langKey]);
  return parser;
}
