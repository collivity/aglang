import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, sep } from 'path';
import { getTreeSitter, makeParser } from '../analyzers/ast/loader.ts';
import { parseAndQuery } from '../analyzers/ast/walker.ts';
import { PACKAGE_DECLARATION_QUERY } from '../analyzers/ast/queries/java.ts';

export interface ResolvedSpecifier {
  /** A real path on disk usable for componentForFile glob matching — may be a directory. */
  componentPath: string;
  /** A concrete representative file, when one exists (absent for e.g. Java wildcard packages). */
  targetFile?: string;
}

function pickRepresentativeFile(dir: string, ext: string, excludeSuffix?: string): string | undefined {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidate = entries
    .filter(name => name.endsWith(ext) && (!excludeSuffix || !name.endsWith(excludeSuffix)))
    .sort()[0];
  return candidate ? join(dir, candidate) : undefined;
}

// ── Go ───────────────────────────────────────────────────────────────────────

export function readGoModuleName(projectRoot: string): string | undefined {
  const goModPath = join(projectRoot, 'go.mod');
  if (!existsSync(goModPath)) return undefined;
  try {
    const match = readFileSync(goModPath, 'utf8').match(/^module\s+(\S+)/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function resolveGoSpecifier(specifier: string, projectRoot: string, moduleName: string | undefined): ResolvedSpecifier | undefined {
  if (!moduleName) return undefined;
  let remainder: string;
  if (specifier === moduleName) remainder = '';
  else if (specifier.startsWith(`${moduleName}/`)) remainder = specifier.slice(moduleName.length + 1);
  else return undefined; // external package or stdlib — out of scope

  const dir = remainder ? join(projectRoot, ...remainder.split('/')) : projectRoot;
  if (!existsSync(dir)) return undefined;
  const targetFile = pickRepresentativeFile(dir, '.go', '_test.go');
  return { componentPath: dir, ...(targetFile ? { targetFile } : {}) };
}

// ── Rust ─────────────────────────────────────────────────────────────────────

export function readCargoPackageName(projectRoot: string): string | undefined {
  const cargoPath = join(projectRoot, 'Cargo.toml');
  if (!existsSync(cargoPath)) return undefined;
  try {
    const match = readFileSync(cargoPath, 'utf8').match(/^\[package\][^[]*\bname\s*=\s*"([^"]+)"/ms);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function resolveRustSpecifier(specifier: string, projectRoot: string, crateName: string | undefined): ResolvedSpecifier | undefined {
  let remainder: string | undefined;
  if (specifier === 'crate') remainder = '';
  else if (specifier.startsWith('crate::')) remainder = specifier.slice('crate::'.length);
  else if (crateName && specifier === crateName) remainder = '';
  else if (crateName && specifier.startsWith(`${crateName}::`)) remainder = specifier.slice(crateName.length + 2);
  else return undefined; // super::/self::, external crates — out of scope (see plan)

  const srcRoot = join(projectRoot, 'src');
  if (remainder === '') {
    if (!existsSync(srcRoot)) return undefined;
    const targetFile = pickRepresentativeFile(srcRoot, '.rs');
    return { componentPath: srcRoot, ...(targetFile ? { targetFile } : {}) };
  }

  const segments = remainder.split('::');
  const last = segments[segments.length - 1]!;
  const dir = join(srcRoot, ...segments.slice(0, -1));
  const fileCandidate = join(dir, `${last}.rs`);
  if (existsSync(fileCandidate)) return { componentPath: fileCandidate, targetFile: fileCandidate };
  const modDir = join(dir, last);
  const modCandidate = join(modDir, 'mod.rs');
  if (existsSync(modCandidate)) return { componentPath: modDir, targetFile: modCandidate };
  return undefined;
}

// ── Python ───────────────────────────────────────────────────────────────────

function resolvePythonModulePath(pathNoExt: string): ResolvedSpecifier | undefined {
  const asFile = `${pathNoExt}.py`;
  if (existsSync(asFile)) return { componentPath: asFile, targetFile: asFile };
  const initFile = join(pathNoExt, '__init__.py');
  if (existsSync(initFile)) return { componentPath: pathNoExt, targetFile: initFile };
  if (existsSync(pathNoExt)) return { componentPath: pathNoExt }; // PEP 420 namespace package
  return undefined;
}

function findPythonPackageRoot(importerFile: string, projectRoot: string): string {
  let dir = dirname(importerFile);
  while (dir !== projectRoot && existsSync(join(dir, '__init__.py'))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

export function resolvePythonSpecifier(importerFile: string, specifier: string, projectRoot: string): ResolvedSpecifier | undefined {
  if (specifier.startsWith('.')) {
    const match = specifier.match(/^(\.+)(.*)$/);
    if (!match) return undefined;
    const dots = match[1]!.length;
    const remainder = match[2]!;
    let dir = dirname(importerFile);
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    if (!remainder) return resolvePythonModulePath(dir); // from . import x — best-effort: resolves to the package itself
    return resolvePythonModulePath(join(dir, ...remainder.split('.')));
  }
  const root = findPythonPackageRoot(importerFile, projectRoot);
  return resolvePythonModulePath(join(root, ...specifier.split('.')));
}

// ── Swift ────────────────────────────────────────────────────────────────────

// SPM has no relative imports and no nested dotted-path module system: `import
// TargetName` refers directly to a target, conventionally rooted at
// Sources/<TargetName>/. Unlike Go/Rust, there's no module-name prefix to read
// from the manifest first — the specifier IS the target name.
// Documented gap: a target's source path can be overridden via `path:` in
// Package.swift's target declaration; Package.swift is executable Swift code,
// not a simple manifest, so detecting that override is out of scope — this
// resolves the Sources/<TargetName>/ convention only.
export function resolveSwiftSpecifier(specifier: string, projectRoot: string): ResolvedSpecifier | undefined {
  if (!existsSync(join(projectRoot, 'Package.swift'))) return undefined;
  const dir = join(projectRoot, 'Sources', specifier);
  if (!existsSync(dir)) return undefined;
  const targetFile = pickRepresentativeFile(dir, '.swift');
  return { componentPath: dir, ...(targetFile ? { targetFile } : {}) };
}

// ── Java ─────────────────────────────────────────────────────────────────────

function javaPackageNameForFile(filePath: string): string | undefined {
  try {
    const loaded = getTreeSitter();
    const parser = makeParser('java');
    const language = loaded?.java;
    if (!parser || !language) return undefined;
    const content = readFileSync(filePath, 'utf8');
    const captures = parseAndQuery(parser, language, content, PACKAGE_DECLARATION_QUERY);
    return captures.find(c => c.name === 'package_name')?.text;
  } catch {
    return undefined;
  }
}

export function resolveJavaSpecifier(importerFile: string, specifier: string): ResolvedSpecifier | undefined {
  const packageName = javaPackageNameForFile(importerFile);
  if (!packageName) return undefined;
  const packageSegments = packageName.split('.');
  const dirSegments = dirname(importerFile).split(/[\\/]/);
  if (dirSegments.length < packageSegments.length) return undefined;
  const offset = dirSegments.length - packageSegments.length;
  for (let i = 0; i < packageSegments.length; i++) {
    if (dirSegments[offset + i] !== packageSegments[i]) return undefined; // source root not found
  }
  const sourceRoot = dirSegments.slice(0, offset).join(sep);

  const specSegments = specifier.split('.');
  const dir = join(sourceRoot, ...specSegments.slice(0, -1));
  const className = specSegments[specSegments.length - 1]!;
  const targetFile = join(dir, `${className}.java`);
  if (existsSync(targetFile)) return { componentPath: targetFile, targetFile };
  const asDir = join(sourceRoot, ...specSegments); // wildcard import: specifier is a package, not a class
  if (existsSync(asDir)) return { componentPath: asDir };
  return undefined;
}
