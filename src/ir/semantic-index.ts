import { dirname, extname, normalize, resolve } from 'path';
import { readFileSync } from 'fs';
import { agIrEdge, agIrId, agIrNode, emptyAgIrGraph, mergeAgIrGraphs } from './builders.ts';
import type { AgIrEvidence, AgIrGraph, AgIrNode, AgIrNodeKind } from './types.ts';

type Language = 'typescript' | 'javascript' | 'csharp';
type Properties = Record<string, string | number | boolean | string[]>;

export interface SemanticIndexInput {
  componentName: string;
  files: string[];
}

interface Declaration {
  name: string;
  kind: 'class' | 'interface' | 'function' | 'value' | 'field' | 'property';
  node: AgIrNode;
  file: string;
  componentName: string;
  exported: boolean;
}

interface ImportBinding {
  local: string;
  imported: string;
  specifier: string;
  kind: 'default' | 'named' | 'namespace' | 'require' | 'dynamic';
  line: number;
}

interface ReExport {
  specifier: string;
  imported?: string;
  exported?: string;
  namespace: boolean;
  line: number;
}

interface AssignmentFact {
  object: string;
  property: string;
  value: string;
  valueEnum?: string;
  valueMember?: string;
  previousMember?: string;
  line: number;
}

interface CallFact {
  receiver?: string;
  callee: string;
  argument?: string;
  line: number;
}

interface SemanticFile {
  file: string;
  componentName: string;
  language: Language;
  content: string;
  declarations: Declaration[];
  imports: ImportBinding[];
  reExports: ReExport[];
  aliases: Array<{ local: string; target: string; line: number }>;
  assignments: AssignmentFact[];
  calls: CallFact[];
  returns: Array<{ value: string; line: number }>;
  unresolvedDynamicImports: Array<{ expression: string; line: number }>;
}

interface SemanticIndex {
  files: SemanticFile[];
  byFile: Map<string, SemanticFile>;
  declarationsByName: Map<string, Declaration[]>;
}

function languageForFile(file: string): Language | undefined {
  const ext = extname(file).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.cs') return 'csharp';
  return undefined;
}

function normalizePath(path: string): string {
  return normalize(path).replace(/\\/g, '/');
}

function stripQuotes(value: string): string {
  return value.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

function lineOf(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function evidence(input: {
  file: string;
  language: Language;
  line?: number;
  message: string;
  confidence?: AgIrEvidence['confidence'];
}): AgIrEvidence {
  return {
    extractor: 'semantic-index',
    strategy: 'ast',
    confidence: input.confidence ?? 'definite',
    language: input.language,
    message: input.message,
    span: {
      file: input.file,
      ...(input.line ? { startLine: input.line } : {}),
    },
  };
}

function fileNode(file: string, componentName: string, language: Language): AgIrNode {
  return agIrNode({
    kind: 'file',
    id: agIrId('file', file),
    label: file,
    properties: { component: componentName, language },
  });
}

function componentNode(componentName: string): AgIrNode {
  return agIrNode({ kind: 'component', id: agIrId('component', componentName), label: componentName });
}

function semanticNode(kind: AgIrNodeKind, file: string, name: string, properties: Properties): AgIrNode {
  return agIrNode({
    kind,
    id: agIrId(kind, file, name),
    label: name,
    properties,
  });
}

function unresolvedNode(kind: AgIrNodeKind, label: string, properties?: Properties): AgIrNode {
  return agIrNode({
    kind,
    id: agIrId(kind, 'unresolved', label),
    label,
    ...(properties ? { properties } : {}),
  });
}

function uniquePush<T>(items: T[], item: T, key: (value: T) => string): void {
  if (!items.some(existing => key(existing) === key(item))) items.push(item);
}

function parseTsJs(file: string, componentName: string, language: Language, content: string): SemanticFile {
  const declarations: Declaration[] = [];
  const imports: ImportBinding[] = [];
  const reExports: ReExport[] = [];
  const aliases: Array<{ local: string; target: string; line: number }> = [];
  const assignments: AssignmentFact[] = [];
  const calls: CallFact[] = [];
  const returns: Array<{ value: string; line: number }> = [];
  const unresolvedDynamicImports: Array<{ expression: string; line: number }> = [];

  const addDeclaration = (name: string, kind: Declaration['kind'], index: number, exported: boolean): void => {
    const node = semanticNode(kind === 'class' || kind === 'interface' ? 'type' : 'symbol', file, name, {
      name,
      declarationKind: kind,
      component: componentName,
      file,
      language,
      exported,
    });
    declarations.push({ name, kind, node, file, componentName, exported });
  };

  const classRe = /\b(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?))?(?:\s+implements\s+([^{\r\n]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(content)) !== null) addDeclaration(match[2]!, 'class', match.index, Boolean(match[1]));

  const interfaceRe = /\b(export\s+)?interface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^{\r\n]+))?/g;
  while ((match = interfaceRe.exec(content)) !== null) addDeclaration(match[2]!, 'interface', match.index, Boolean(match[1]));

  const functionRe = /\b(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = functionRe.exec(content)) !== null) addDeclaration(match[2]!, 'function', match.index, Boolean(match[1]));

  const valueRe = /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g;
  while ((match = valueRe.exec(content)) !== null) addDeclaration(match[2]!, 'value', match.index, Boolean(match[1]));

  const importRe = /\bimport\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = importRe.exec(content)) !== null) {
    const clause = match[1]!.trim();
    const specifier = match[2]!;
    const line = lineOf(content, match.index);
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (namespace) {
      imports.push({ local: namespace[1]!, imported: '*', specifier, kind: 'namespace', line });
      continue;
    }
    const named = /\{([^}]+)\}/.exec(clause)?.[1];
    const defaultName = clause.replace(/\{[^}]+\}/, '').replace(/,$/, '').trim();
    if (defaultName && /^[A-Za-z_$][\w$]*$/.test(defaultName)) imports.push({ local: defaultName, imported: 'default', specifier, kind: 'default', line });
    if (named) {
      for (const part of named.split(',').map(item => item.trim()).filter(Boolean)) {
        const [imported, local] = part.split(/\s+as\s+/).map(item => item.trim());
        if (imported) imports.push({ local: local || imported, imported, specifier, kind: 'named', line });
      }
    }
  }

  const sideEffectImportRe = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffectImportRe.exec(content)) !== null) {
    imports.push({ local: match[1]!, imported: '*', specifier: match[1]!, kind: 'namespace', line: lineOf(content, match.index) });
  }

  const requireRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(content)) !== null) {
    imports.push({ local: match[1]!, imported: 'default', specifier: match[2]!, kind: 'require', line: lineOf(content, match.index) });
  }

  const dynamicLiteralRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s*)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicLiteralRe.exec(content)) !== null) {
    imports.push({ local: match[1]!, imported: 'default', specifier: match[2]!, kind: 'dynamic', line: lineOf(content, match.index) });
  }

  const dynamicRe = /\bimport\s*\(\s*([^'"`)][^)]+)\)/g;
  while ((match = dynamicRe.exec(content)) !== null) {
    unresolvedDynamicImports.push({ expression: match[1]!.trim(), line: lineOf(content, match.index) });
  }

  const reExportNamedRe = /\bexport\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportNamedRe.exec(content)) !== null) {
    const specifier = match[2]!;
    for (const part of match[1]!.split(',').map(item => item.trim()).filter(Boolean)) {
      const [imported, exported] = part.split(/\s+as\s+/).map(item => item.trim());
      reExports.push({ specifier, imported, exported: exported || imported, namespace: false, line: lineOf(content, match.index) });
    }
  }
  const reExportAllRe = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportAllRe.exec(content)) !== null) {
    reExports.push({ specifier: match[1]!, namespace: true, line: lineOf(content, match.index) });
  }

  const aliasRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*;/g;
  while ((match = aliasRe.exec(content)) !== null) {
    aliases.push({ local: match[1]!, target: match[2]!, line: lineOf(content, match.index) });
  }

  const assignmentRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g;
  while ((match = assignmentRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, match.index - 400), match.index);
    const guardRe = new RegExp(`${match[1]}\\.${match[2]}\\s*(?:===|==)\\s*([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)`, 'g');
    const guards = [...before.matchAll(guardRe)];
    const guard = guards.at(-1);
    const valueParts = match[3]!.split('.');
    assignments.push({
      object: match[1]!,
      property: match[2]!,
      value: match[3]!,
      ...(valueParts.length === 2 ? { valueEnum: valueParts[0], valueMember: valueParts[1] } : {}),
      ...(guard ? { previousMember: guard[2] } : {}),
      line: lineOf(content, match.index),
    });
  }

  const memberCallRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  while ((match = memberCallRe.exec(content)) !== null) {
    calls.push({ receiver: match[1]!, callee: match[2]!, argument: match[3]?.trim(), line: lineOf(content, match.index) });
  }
  const callRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  while ((match = callRe.exec(content)) !== null) {
    if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'import', 'require'].includes(match[1]!)) continue;
    calls.push({ callee: match[1]!, argument: match[2]?.trim(), line: lineOf(content, match.index) });
  }

  const returnRe = /\breturn\s+([^;\n]+)/g;
  while ((match = returnRe.exec(content)) !== null) returns.push({ value: match[1]!.trim(), line: lineOf(content, match.index) });

  return { file, componentName, language, content, declarations, imports, reExports, aliases, assignments, calls, returns, unresolvedDynamicImports };
}

function parseCSharp(file: string, componentName: string, content: string): SemanticFile {
  const language: Language = 'csharp';
  const declarations: Declaration[] = [];
  const imports: ImportBinding[] = [];
  const assignments: AssignmentFact[] = [];
  const calls: CallFact[] = [];
  const returns: Array<{ value: string; line: number }> = [];

  const addDeclaration = (name: string, kind: Declaration['kind'], index: number, exported = true): void => {
    const node = semanticNode(kind === 'class' || kind === 'interface' ? 'type' : 'symbol', file, name, {
      name,
      declarationKind: kind,
      component: componentName,
      file,
      language,
      exported,
    });
    declarations.push({ name, kind, node, file, componentName, exported });
  };

  let match: RegExpExecArray | null;
  const usingRe = /\busing\s+([A-Za-z_][\w.]*);/g;
  while ((match = usingRe.exec(content)) !== null) {
    imports.push({ local: match[1]!.split('.').pop()!, imported: '*', specifier: match[1]!, kind: 'namespace', line: lineOf(content, match.index) });
  }

  const typeRe = /(?:^|[\r\n])\s*(?:public|internal|private|protected|abstract|sealed|static|partial|\s)*\b(class|interface)\s+([A-Za-z_]\w*)(?:\s*:\s*([^{\r\n]+))?/g;
  while ((match = typeRe.exec(content)) !== null) addDeclaration(match[2]!, match[1] === 'interface' ? 'interface' : 'class', match.index);

  const fieldRe = /\b(?:private|protected|internal|public)?\s*(?:readonly\s+)?([A-Za-z_][\w.<>?]*)\s+([A-Za-z_]\w*)\s*;/g;
  while ((match = fieldRe.exec(content)) !== null) addDeclaration(match[2]!, 'field', match.index, false);

  const propertyRe = /\b(?:private|protected|internal|public)?\s*([A-Za-z_][\w.<>?]*)\s+([A-Za-z_]\w*)\s*\{\s*get;/g;
  while ((match = propertyRe.exec(content)) !== null) addDeclaration(match[2]!, 'property', match.index, false);

  const assignmentRe = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/g;
  while ((match = assignmentRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, match.index - 400), match.index);
    const guards = [...before.matchAll(new RegExp(`${match[1]}\\.${match[2]}\\s*(?:==|is)\\s*([A-Za-z_]\\w*)\\.([A-Za-z_]\\w*)`, 'g'))];
    const guard = guards.at(-1);
    const valueParts = match[3]!.split('.');
    assignments.push({
      object: match[1]!,
      property: match[2]!,
      value: match[3]!,
      ...(valueParts.length === 2 ? { valueEnum: valueParts[0], valueMember: valueParts[1] } : {}),
      ...(guard ? { previousMember: guard[2] } : {}),
      line: lineOf(content, match.index),
    });
  }

  const memberCallRe = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  while ((match = memberCallRe.exec(content)) !== null) {
    calls.push({ receiver: match[1]!, callee: match[2]!, argument: match[3]?.trim(), line: lineOf(content, match.index) });
  }
  const returnRe = /\breturn\s+([^;\n]+)/g;
  while ((match = returnRe.exec(content)) !== null) returns.push({ value: match[1]!.trim(), line: lineOf(content, match.index) });

  return { file, componentName, language, content, declarations, imports, reExports: [], aliases: [], assignments, calls, returns, unresolvedDynamicImports: [] };
}

function buildIndex(inputs: SemanticIndexInput[]): SemanticIndex {
  const files: SemanticFile[] = [];
  for (const input of inputs) {
    for (const rawFile of input.files) {
      const language = languageForFile(rawFile);
      if (!language) continue;
      let content: string;
      try {
        content = readFileSync(rawFile, 'utf8');
      } catch {
        continue;
      }
      const file = normalizePath(rawFile);
      files.push(language === 'csharp'
        ? parseCSharp(file, input.componentName, content)
        : parseTsJs(file, input.componentName, language, content));
    }
  }

  const declarationsByName = new Map<string, Declaration[]>();
  const byFile = new Map<string, SemanticFile>();
  for (const file of files) {
    byFile.set(file.file, file);
    for (const declaration of file.declarations) {
      const bucket = declarationsByName.get(declaration.name) ?? [];
      bucket.push(declaration);
      declarationsByName.set(declaration.name, bucket);
    }
  }
  return { files, byFile, declarationsByName };
}

function possibleImportTargets(importerFile: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return [];
  const base = normalizePath(resolve(dirname(importerFile), specifier));
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs'];
  return [
    ...extensions.map(ext => normalizePath(base + ext)),
    ...extensions.filter(Boolean).map(ext => normalizePath(`${base}/index${ext}`)),
  ];
}

function resolveImportFile(index: SemanticIndex, importerFile: string, specifier: string): SemanticFile | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return possibleImportTargets(importerFile, specifier).map(candidate => index.byFile.get(candidate)).find(Boolean);
}

function exportedDeclarations(file: SemanticFile): Declaration[] {
  return file.declarations.filter(declaration => declaration.exported);
}

function resolveReExport(index: SemanticIndex, file: SemanticFile, name: string, seen = new Set<string>()): Declaration | undefined {
  if (seen.has(file.file)) return undefined;
  seen.add(file.file);
  for (const reExport of file.reExports) {
    const targetFile = resolveImportFile(index, file.file, reExport.specifier);
    if (!targetFile) continue;
    if (reExport.namespace) {
      const direct = exportedDeclarations(targetFile).find(declaration => declaration.name === name);
      if (direct) return direct;
      const nested = resolveReExport(index, targetFile, name, seen);
      if (nested) return nested;
      continue;
    }
    if (reExport.exported === name || reExport.imported === name) {
      return exportedDeclarations(targetFile).find(declaration => declaration.name === reExport.imported);
    }
  }
  return undefined;
}

function resolveImportBinding(index: SemanticIndex, file: SemanticFile, binding: ImportBinding): Declaration | SemanticFile | undefined {
  const targetFile = resolveImportFile(index, file.file, binding.specifier);
  if (!targetFile) return undefined;
  if (binding.imported === '*' || binding.kind === 'namespace') return targetFile;
  const importedName = binding.imported === 'default' ? 'default' : binding.imported;
  return exportedDeclarations(targetFile).find(declaration => declaration.name === importedName || (importedName === 'default' && declaration.exported))
    ?? resolveReExport(index, targetFile, importedName)
    ?? (binding.imported === 'default' ? exportedDeclarations(targetFile)[0] : undefined);
}

function resolveName(index: SemanticIndex, file: SemanticFile, name: string): Declaration | undefined {
  const clean = name.split('.')[0] ?? name;
  const importBinding = file.imports.find(binding => binding.local === clean);
  if (importBinding) {
    const resolved = resolveImportBinding(index, file, importBinding);
    if (resolved && 'declarations' in resolved) return undefined;
    return resolved;
  }
  const alias = file.aliases.find(item => item.local === clean);
  if (alias) return resolveName(index, file, alias.target);
  return file.declarations.find(declaration => declaration.name === clean)
    ?? index.declarationsByName.get(clean)?.[0];
}

function addScaffold(graph: AgIrGraph, file: SemanticFile): void {
  const component = componentNode(file.componentName);
  const fileN = fileNode(file.file, file.componentName, file.language);
  graph.nodes.push(component, fileN);
  graph.edges.push(agIrEdge({
    kind: 'contains',
    from: component.id,
    to: fileN.id,
    evidence: [evidence({ file: file.file, language: file.language, message: `Component '${file.componentName}' contains '${file.file}'` })],
  }));
}

function addEdge(graph: AgIrGraph, input: {
  kind: Parameters<typeof agIrEdge>[0]['kind'];
  from: string;
  to: string;
  file: SemanticFile;
  line?: number;
  message: string;
  properties?: Properties;
  confidence?: AgIrEvidence['confidence'];
}): void {
  graph.edges.push(agIrEdge({
    kind: input.kind,
    id: agIrId('edge', input.kind, input.from, input.to, input.line, JSON.stringify(input.properties ?? {})),
    from: input.from,
    to: input.to,
    ...(input.properties ? { properties: input.properties } : {}),
    evidence: [evidence({
      file: input.file.file,
      language: input.file.language,
      line: input.line,
      message: input.message,
      confidence: input.confidence,
    })],
  }));
}

function addResolvedTarget(graph: AgIrGraph, file: SemanticFile, fromNode: AgIrNode, target: Declaration | SemanticFile | undefined, line?: number): void {
  if (!target) return;
  const targetNode = 'declarations' in target
    ? fileNode(target.file, target.componentName, target.language)
    : target.node;
  graph.nodes.push(targetNode);
  addEdge(graph, {
    kind: 'resolves_to',
    from: fromNode.id,
    to: targetNode.id,
    file,
    line,
    message: `'${fromNode.label}' resolves to '${targetNode.label}'`,
    properties: {
      resolved: true,
      targetFile: 'declarations' in target ? target.file : target.file,
      targetComponent: 'declarations' in target ? target.componentName : target.componentName,
    },
  });
}

function addTypeRelations(graph: AgIrGraph, index: SemanticIndex, file: SemanticFile): void {
  const typeDeclRe = file.language === 'csharp'
    ? /(?:^|[\r\n])\s*(?:public|internal|private|protected|abstract|sealed|static|partial|\s)*\b(class|interface)\s+([A-Za-z_]\w*)(?:\s*:\s*([^{\r\n]+))?/g
    : /\b(?:export\s+)?(?:abstract\s+)?(class|interface)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?))?(?:\s+implements\s+([^{\r\n]+))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = typeDeclRe.exec(file.content)) !== null) {
    const source = file.declarations.find(declaration => declaration.name === match![2]);
    if (!source) continue;
    graph.nodes.push(source.node);
    const line = lineOf(file.content, match.index);
    if (file.language === 'csharp') {
      const bases = (match[3] ?? '').split(',').map(item => item.trim().split(/[<\s]/)[0]).filter(Boolean);
      bases.forEach((base, indexInList) => {
        const resolved = resolveName(index, file, base);
        const target = resolved?.node ?? unresolvedNode('type', base, { language: file.language, unresolved: true });
        graph.nodes.push(target);
        addEdge(graph, {
          kind: indexInList === 0 && !base.startsWith('I') ? 'extends' : 'implements',
          from: source.node.id,
          to: target.id,
          file,
          line,
          message: `${source.name} relates to ${base}`,
          properties: { baseType: base, ...(resolved ? { resolved: true, targetComponent: resolved.componentName, targetFile: resolved.file } : { unresolved: true }) },
          confidence: resolved ? 'definite' : 'probable',
        });
      });
      continue;
    }
    const extendsPart = match[3]?.trim();
    const implementsPart = match[4]?.replace(/\s*\{.*/s, '').trim();
    if (extendsPart) {
      for (const base of extendsPart.split(',').map(item => item.trim().split(/[<\s]/)[0]).filter(Boolean)) {
        const resolved = resolveName(index, file, base);
        const target = resolved?.node ?? unresolvedNode('type', base, { language: file.language, unresolved: true });
        graph.nodes.push(target);
        addEdge(graph, {
          kind: 'extends',
          from: source.node.id,
          to: target.id,
          file,
          line,
          message: `${source.name} extends ${base}`,
          properties: { baseType: base, ...(resolved ? { resolved: true, targetComponent: resolved.componentName, targetFile: resolved.file } : { unresolved: true }) },
          confidence: resolved ? 'definite' : 'probable',
        });
      }
    }
    if (implementsPart) {
      for (const iface of implementsPart.split(',').map(item => item.trim().split(/[<\s]/)[0]).filter(Boolean)) {
        const resolved = resolveName(index, file, iface);
        const target = resolved?.node ?? unresolvedNode('type', iface, { language: file.language, unresolved: true });
        graph.nodes.push(target);
        addEdge(graph, {
          kind: 'implements',
          from: source.node.id,
          to: target.id,
          file,
          line,
          message: `${source.name} implements ${iface}`,
          properties: { interface: iface, ...(resolved ? { resolved: true, targetComponent: resolved.componentName, targetFile: resolved.file } : { unresolved: true }) },
          confidence: resolved ? 'definite' : 'probable',
        });
      }
    }
  }
}

export function buildProjectSemanticIr(inputs: SemanticIndexInput[]): AgIrGraph {
  const index = buildIndex(inputs);
  const graph = emptyAgIrGraph();

  for (const file of index.files) {
    addScaffold(graph, file);
    const fileId = agIrId('file', file.file);
    for (const declaration of file.declarations) {
      graph.nodes.push(declaration.node);
      addEdge(graph, {
        kind: 'declares',
        from: fileId,
        to: declaration.node.id,
        file,
        message: `${file.file} declares ${declaration.name}`,
        properties: { name: declaration.name, declarationKind: declaration.kind, exported: declaration.exported },
      });
      if (declaration.exported) {
        addEdge(graph, {
          kind: 'exports',
          from: fileId,
          to: declaration.node.id,
          file,
          message: `${file.file} exports ${declaration.name}`,
          properties: { name: declaration.name, declarationKind: declaration.kind },
        });
      }
    }

    for (const binding of file.imports) {
      const bindingNode = semanticNode('symbol', file.file, `import:${binding.local}`, {
        name: binding.local,
        imported: binding.imported,
        specifier: binding.specifier,
        importKind: binding.kind,
        component: file.componentName,
        file: file.file,
        language: file.language,
      });
      graph.nodes.push(bindingNode);
      const resolved = resolveImportBinding(index, file, binding);
      const moduleFile = resolveImportFile(index, file.file, binding.specifier);
      const importTarget = moduleFile
        ? fileNode(moduleFile.file, moduleFile.componentName, moduleFile.language)
        : unresolvedNode('symbol', binding.specifier, { specifier: binding.specifier, moduleKind: binding.specifier.startsWith('.') ? 'relative' : 'package' });
      graph.nodes.push(importTarget);
      addEdge(graph, {
        kind: 'imports',
        from: fileId,
        to: importTarget.id,
        file,
        line: binding.line,
        message: `${file.file} imports ${binding.specifier}`,
        properties: {
          specifier: binding.specifier,
          local: binding.local,
          imported: binding.imported,
          importKind: binding.kind,
          moduleKind: binding.specifier.startsWith('.') ? 'relative' : 'package',
          ...(moduleFile ? { resolved: true, targetFile: moduleFile.file, targetComponent: moduleFile.componentName } : {}),
        },
        confidence: moduleFile || !binding.specifier.startsWith('.') ? 'definite' : 'probable',
      });
      addEdge(graph, {
        kind: 'alias_of',
        from: bindingNode.id,
        to: importTarget.id,
        file,
        line: binding.line,
        message: `Import binding '${binding.local}' aliases '${binding.specifier}'`,
        properties: { local: binding.local, imported: binding.imported, specifier: binding.specifier },
      });
      addResolvedTarget(graph, file, bindingNode, resolved, binding.line);
    }

    for (const reExport of file.reExports) {
      const targetFile = resolveImportFile(index, file.file, reExport.specifier);
      const target = targetFile ? fileNode(targetFile.file, targetFile.componentName, targetFile.language) : unresolvedNode('symbol', reExport.specifier);
      graph.nodes.push(target);
      addEdge(graph, {
        kind: 'exports',
        from: fileId,
        to: target.id,
        file,
        line: reExport.line,
        message: `${file.file} re-exports ${reExport.specifier}`,
        properties: {
          specifier: reExport.specifier,
          ...(reExport.imported ? { imported: reExport.imported } : {}),
          ...(reExport.exported ? { exported: reExport.exported } : {}),
          namespace: reExport.namespace,
          reExport: true,
          ...(targetFile ? { resolved: true, targetFile: targetFile.file, targetComponent: targetFile.componentName } : {}),
        },
        confidence: targetFile ? 'definite' : 'probable',
      });
    }

    for (const alias of file.aliases) {
      const local = semanticNode('symbol', file.file, `alias:${alias.local}`, {
        name: alias.local,
        alias: true,
        component: file.componentName,
        file: file.file,
        language: file.language,
      });
      const resolved = resolveName(index, file, alias.target);
      const target = resolved?.node ?? unresolvedNode('symbol', alias.target, { unresolved: true });
      graph.nodes.push(local, target);
      addEdge(graph, {
        kind: 'alias_of',
        from: local.id,
        to: target.id,
        file,
        line: alias.line,
        message: `${alias.local} aliases ${alias.target}`,
        properties: { local: alias.local, target: alias.target, ...(resolved ? { resolved: true, targetComponent: resolved.componentName, targetFile: resolved.file } : { unresolved: true }) },
        confidence: resolved ? 'definite' : 'probable',
      });
    }

    for (const assignment of file.assignments) {
      const field = semanticNode('field', file.file, `${assignment.object}.${assignment.property}`, {
        object: assignment.object,
        property: assignment.property,
        component: file.componentName,
        file: file.file,
        language: file.language,
      });
      graph.nodes.push(field);
      addEdge(graph, {
        kind: 'assigns',
        from: fileId,
        to: field.id,
        file,
        line: assignment.line,
        message: `${assignment.object}.${assignment.property} = ${assignment.value}`,
        properties: {
          object: assignment.object,
          property: assignment.property,
          value: assignment.value,
          ...(assignment.valueEnum ? { valueEnum: assignment.valueEnum } : {}),
          ...(assignment.valueMember ? { valueMember: assignment.valueMember } : {}),
          ...(assignment.previousMember ? { previousMember: assignment.previousMember } : {}),
        },
      });
      addEdge(graph, {
        kind: 'writes',
        from: fileId,
        to: field.id,
        file,
        line: assignment.line,
        message: `${file.file} writes ${assignment.object}.${assignment.property}`,
        properties: { object: assignment.object, property: assignment.property, value: assignment.value },
      });
    }

    for (const call of file.calls) {
      const resolved = resolveName(index, file, call.receiver ?? call.callee);
      const operation = resolved?.node ?? unresolvedNode('operation', call.receiver ? `${call.receiver}.${call.callee}` : call.callee, { unresolved: true });
      graph.nodes.push(operation);
      addEdge(graph, {
        kind: 'calls',
        from: fileId,
        to: operation.id,
        file,
        line: call.line,
        message: call.receiver ? `${call.receiver}.${call.callee}(...)` : `${call.callee}(...)`,
        properties: {
          function: call.callee,
          ...(call.receiver ? { receiver: call.receiver } : {}),
          ...(call.argument ? { argument: call.argument } : {}),
          ...(resolved ? { resolved: true, targetComponent: resolved.componentName, targetFile: resolved.file, targetSymbol: resolved.name } : { unresolved: true }),
        },
        confidence: resolved ? 'definite' : 'probable',
      });
    }

    for (const ret of file.returns) {
      const value = semanticNode('symbol', file.file, `return:${ret.line}`, {
        value: ret.value,
        component: file.componentName,
        file: file.file,
        language: file.language,
      });
      graph.nodes.push(value);
      addEdge(graph, {
        kind: 'returns',
        from: fileId,
        to: value.id,
        file,
        line: ret.line,
        message: `return ${ret.value}`,
        properties: { value: ret.value },
      });
    }

    for (const unresolved of file.unresolvedDynamicImports) {
      const target = unresolvedNode('symbol', `dynamic import: ${unresolved.expression}`, {
        dynamic: true,
        unresolved: true,
        expression: unresolved.expression,
      });
      graph.nodes.push(target);
      addEdge(graph, {
        kind: 'imports',
        from: fileId,
        to: target.id,
        file,
        line: unresolved.line,
        message: `Unresolved dynamic import '${unresolved.expression}'`,
        properties: { importKind: 'dynamic', dynamic: true, unresolved: true, expression: unresolved.expression },
        confidence: 'possible',
      });
    }

    addTypeRelations(graph, index, file);
  }

  return mergeAgIrGraphs([graph]);
}

export function enrichAgIrWithSemanticIndex(base: AgIrGraph, inputs: SemanticIndexInput[]): AgIrGraph {
  return mergeAgIrGraphs([base, buildProjectSemanticIr(inputs)]);
}
