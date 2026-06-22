import { extname } from 'path';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import { agIrEdge, emptyAgIrGraph, mergeAgIrGraphs } from './builders.ts';
import { componentForFile } from './lowerer.ts';
import type { AgIrEvidence, AgIrGraph } from './types.ts';
import {
  readGoModuleName, resolveGoSpecifier,
  readCargoPackageName, resolveRustSpecifier,
  resolvePythonSpecifier,
  resolveJavaSpecifier,
  resolveSwiftSpecifier,
  type ResolvedSpecifier,
} from './specifier-resolvers.ts';

type LinkedLanguage = 'python' | 'golang' | 'rust' | 'java' | 'swift';

const EXTENSION_TO_LINKED_LANGUAGE: Record<string, LinkedLanguage> = {
  '.py': 'python',
  '.go': 'golang',
  '.rs': 'rust',
  '.java': 'java',
  '.swift': 'swift',
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function defaultLocalName(language: LinkedLanguage, specifier: string): string | undefined {
  if (language === 'golang') return specifier.split('/').pop();
  if (language === 'rust') return specifier === 'crate' ? undefined : specifier.split('::').pop();
  // Swift target names have no path/dot separators — the specifier is the binding itself
  // (import DataKit; DataKit.foo() — receiver token equals the specifier verbatim).
  if (language === 'swift') return specifier;
  // python / java: dotted specifiers; bare relative dots ('.', '..') have no derivable name
  const stripped = language === 'python' ? specifier.replace(/^\.+/, '') : specifier;
  if (!stripped) return undefined;
  return stripped.split('.').pop();
}

function resolveImportSpecifier(
  language: LinkedLanguage,
  importerFile: string,
  specifier: string,
  projectRoot: string,
  goModuleName: string | undefined,
  cargoPackageName: string | undefined,
): ResolvedSpecifier | undefined {
  if (language === 'golang') return resolveGoSpecifier(specifier, projectRoot, goModuleName);
  if (language === 'rust') return resolveRustSpecifier(specifier, projectRoot, cargoPackageName);
  if (language === 'python') return resolvePythonSpecifier(importerFile, specifier, projectRoot);
  if (language === 'swift') return resolveSwiftSpecifier(specifier, projectRoot);
  return resolveJavaSpecifier(importerFile, specifier);
}

interface ResolvedImportInfo {
  targetComponent: string;
  targetFile?: string;
  /** True when resolution used an explicit alias capture rather than a guessed default name. */
  explicit: boolean;
}

function linkResolutionEvidence(message: string, confidence: AgIrEvidence['confidence']): AgIrEvidence {
  return { extractor: 'cross-file-linker', strategy: 'ast', confidence, message };
}

/**
 * Enriches imports/calls edges for Python, Go, Rust, and Java file nodes with the same
 * resolved/targetComponent properties src/ir/semantic-index.ts already provides for
 * TypeScript/JavaScript/C#. Deliberately does not touch those languages, or lowerer.ts's
 * separate policyFlow-gated relative-import logic, which serves a different consumer
 * (direct SMT lowering, not the .agq.yml extraction-query path this enriches).
 */
export function enrichAgIrWithCrossFileLinks(graph: AgIrGraph, artifact: ArchitectureArtifact, projectRoot: string): AgIrGraph {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const goModuleName = readGoModuleName(projectRoot);
  const cargoPackageName = readCargoPackageName(projectRoot);

  const declaresByFile = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'declares') continue;
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (fromNode?.kind !== 'file' || !toNode) continue;
    const key = normalizePath(fromNode.label);
    const set = declaresByFile.get(key) ?? new Set<string>();
    set.add(toNode.label);
    declaresByFile.set(key, set);
  }

  const patch = emptyAgIrGraph();
  // file id -> local binding name -> resolved import
  const importsByFile = new Map<string, Map<string, ResolvedImportInfo>>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    const fromNode = nodes.get(edge.from);
    if (fromNode?.kind !== 'file') continue;
    const language = EXTENSION_TO_LINKED_LANGUAGE[extname(fromNode.label).toLowerCase()];
    if (!language) continue;
    const specifier = typeof edge.properties?.specifier === 'string' ? edge.properties.specifier : undefined;
    if (!specifier) continue;

    const resolved = resolveImportSpecifier(language, fromNode.label, specifier, projectRoot, goModuleName, cargoPackageName);
    if (!resolved) continue;
    // Prefer matching against a concrete file when one exists — most .ag component globs
    // end in an extension (e.g. "**/*.go") and won't match a bare directory path.
    const targetComponent = componentForFile(resolved.targetFile ?? resolved.componentPath, artifact);
    if (!targetComponent) continue;

    patch.edges.push(agIrEdge({
      kind: 'imports',
      id: edge.id,
      from: edge.from,
      to: edge.to,
      properties: {
        resolved: true,
        targetComponent,
        ...(resolved.targetFile ? { targetFile: resolved.targetFile } : {}),
      },
      evidence: [linkResolutionEvidence(`Resolved ${language} import '${specifier}' to component '${targetComponent}'`, 'definite')],
    }));

    // Priority: an explicit alias ("import X as Y" / "use X as Y") names the binding outright;
    // an importedName ("from X import Y" — Python only) means Y, not anything derived from X,
    // is what's actually in scope at the call site; only fall back to guessing from the
    // specifier's own shape when neither capture is available.
    const explicitAlias = typeof edge.properties?.alias === 'string' ? edge.properties.alias : undefined;
    const importedName = typeof edge.properties?.importedName === 'string' ? edge.properties.importedName : undefined;
    const localName = explicitAlias ?? importedName ?? defaultLocalName(language, specifier);
    if (!localName) continue;
    const fileMap = importsByFile.get(edge.from) ?? new Map<string, ResolvedImportInfo>();
    fileMap.set(localName, { targetComponent, targetFile: resolved.targetFile, explicit: Boolean(explicitAlias ?? importedName) });
    importsByFile.set(edge.from, fileMap);
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue;
    const fromNode = nodes.get(edge.from);
    if (fromNode?.kind !== 'file') continue;
    if (!EXTENSION_TO_LINKED_LANGUAGE[extname(fromNode.label).toLowerCase()]) continue;
    const token = (typeof edge.properties?.receiver === 'string' ? edge.properties.receiver : undefined)
      ?? (typeof edge.properties?.function === 'string' ? edge.properties.function : undefined);
    if (!token) continue;
    const resolvedImport = importsByFile.get(edge.from)?.get(token);
    if (!resolvedImport) continue;

    const calleeName = typeof edge.properties?.function === 'string' ? edge.properties.function : undefined;
    const declaresVerified = resolvedImport.targetFile && calleeName
      ? declaresByFile.get(normalizePath(resolvedImport.targetFile))?.has(calleeName)
      : undefined;

    patch.edges.push(agIrEdge({
      kind: 'calls',
      id: edge.id,
      from: edge.from,
      to: edge.to,
      properties: {
        resolved: true,
        targetComponent: resolvedImport.targetComponent,
        ...(resolvedImport.targetFile ? { targetFile: resolvedImport.targetFile } : {}),
        ...(declaresVerified !== undefined ? { declaresVerified } : {}),
      },
      evidence: [linkResolutionEvidence(
        `Resolved call '${token}' to component '${resolvedImport.targetComponent}' via ${resolvedImport.explicit ? 'an explicit import alias' : 'a default-derived import binding name'}`,
        resolvedImport.explicit ? 'definite' : 'probable',
      )],
    }));
  }

  return mergeAgIrGraphs([graph, patch]);
}
