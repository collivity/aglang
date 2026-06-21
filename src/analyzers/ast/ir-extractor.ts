import { readFileSync } from 'fs';
import { extname } from 'path';
import type Parser from 'tree-sitter';
import type { Confidence } from '../plugin.ts';
import { getTreeSitter, makeParser } from './loader.ts';
import { queryCaptures, type CaptureMatch } from './walker.ts';
import * as csharpQueries from './queries/csharp.ts';
import * as goQueries from './queries/golang.ts';
import * as javaQueries from './queries/java.ts';
import * as pythonQueries from './queries/python.ts';
import * as rustQueries from './queries/rust.ts';
import * as swiftQueries from './queries/swift.ts';
import * as tsQueries from './queries/typescript.ts';
import { agIrEdge, agIrId, agIrNode, emptyAgIrGraph, mergeAgIrGraphs } from '../../ir/builders.ts';
import type { AgIrEdgeKind, AgIrEvidence, AgIrGraph, AgIrNodeKind } from '../../ir/types.ts';

export type TreeSitterIrLanguage = 'typescript' | 'javascript' | 'python' | 'csharp' | 'golang' | 'rust' | 'java' | 'swift';

type SemanticIntent = 'imports' | 'calls' | 'assignments' | 'routes' | 'types';

interface QuerySpec {
  intent: SemanticIntent;
  queryName: string;
  querySource: string;
}

const EXTENSION_TO_LANGUAGE: Record<string, TreeSitterIrLanguage> = {
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
  '.swift': 'swift',
};

const QUERY_REGISTRY: Record<TreeSitterIrLanguage, QuerySpec[]> = {
  typescript: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: tsQueries.IMPORT_QUERY },
    { intent: 'imports', queryName: 'IMPORT_NAMED_QUERY', querySource: tsQueries.IMPORT_NAMED_QUERY },
    { intent: 'imports', queryName: 'REQUIRE_QUERY', querySource: tsQueries.REQUIRE_QUERY },
    { intent: 'calls', queryName: 'NEW_EXPR_QUERY', querySource: tsQueries.NEW_EXPR_QUERY },
    { intent: 'routes', queryName: 'EXPRESS_ROUTE_QUERY', querySource: tsQueries.EXPRESS_ROUTE_QUERY },
    { intent: 'routes', queryName: 'NESTJS_CONTROLLER_QUERY', querySource: tsQueries.NESTJS_CONTROLLER_QUERY },
    { intent: 'routes', queryName: 'NESTJS_METHOD_QUERY', querySource: tsQueries.NESTJS_METHOD_QUERY },
    { intent: 'routes', queryName: 'NODE_HTTP_ROUTE_QUERY', querySource: tsQueries.NODE_HTTP_ROUTE_QUERY },
  ],
  javascript: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: tsQueries.IMPORT_QUERY },
    { intent: 'imports', queryName: 'IMPORT_NAMED_QUERY', querySource: tsQueries.IMPORT_NAMED_QUERY },
    { intent: 'imports', queryName: 'REQUIRE_QUERY', querySource: tsQueries.REQUIRE_QUERY },
    { intent: 'calls', queryName: 'NEW_EXPR_QUERY', querySource: tsQueries.NEW_EXPR_QUERY },
    { intent: 'routes', queryName: 'EXPRESS_ROUTE_QUERY', querySource: tsQueries.EXPRESS_ROUTE_QUERY },
    { intent: 'routes', queryName: 'NODE_HTTP_ROUTE_QUERY', querySource: tsQueries.NODE_HTTP_ROUTE_QUERY },
  ],
  python: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: pythonQueries.IMPORT_QUERY },
    { intent: 'imports', queryName: 'IMPORT_ALIAS_QUERY', querySource: pythonQueries.IMPORT_ALIAS_QUERY },
    { intent: 'imports', queryName: 'FROM_IMPORT_QUERY', querySource: pythonQueries.FROM_IMPORT_QUERY },
    { intent: 'imports', queryName: 'FROM_IMPORT_RELATIVE_QUERY', querySource: pythonQueries.FROM_IMPORT_RELATIVE_QUERY },
    { intent: 'calls', queryName: 'CALL_EXPR_QUERY', querySource: pythonQueries.CALL_EXPR_QUERY },
    { intent: 'routes', queryName: 'DECORATOR_ROUTE_QUERY', querySource: pythonQueries.DECORATOR_ROUTE_QUERY },
    { intent: 'routes', queryName: 'FLASK_ROUTE_QUERY', querySource: pythonQueries.FLASK_ROUTE_QUERY },
    { intent: 'routes', queryName: 'DJANGO_PATH_QUERY', querySource: pythonQueries.DJANGO_PATH_QUERY },
    { intent: 'types', queryName: 'DECL_QUERY', querySource: pythonQueries.DECL_QUERY },
  ],
  csharp: [
    { intent: 'imports', queryName: 'USING_QUERY', querySource: csharpQueries.USING_QUERY },
    { intent: 'calls', queryName: 'NEW_OBJECT_QUERY', querySource: csharpQueries.NEW_OBJECT_QUERY },
    { intent: 'routes', queryName: 'ATTRIBUTE_QUERY', querySource: csharpQueries.ATTRIBUTE_QUERY },
    { intent: 'types', queryName: 'ATTRIBUTE_NAME_QUERY', querySource: csharpQueries.ATTRIBUTE_NAME_QUERY },
    { intent: 'types', queryName: 'CTOR_PARAM_QUERY', querySource: csharpQueries.CTOR_PARAM_QUERY },
    { intent: 'types', queryName: 'FIELD_QUERY', querySource: csharpQueries.FIELD_QUERY },
    { intent: 'types', queryName: 'PROPERTY_QUERY', querySource: csharpQueries.PROPERTY_QUERY },
  ],
  golang: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: goQueries.IMPORT_QUERY },
    { intent: 'imports', queryName: 'IMPORT_ALIASED_QUERY', querySource: goQueries.IMPORT_ALIASED_QUERY },
    { intent: 'calls', queryName: 'CALL_QUERY', querySource: goQueries.CALL_QUERY },
    { intent: 'routes', queryName: 'ROUTE_QUERY', querySource: goQueries.ROUTE_QUERY },
    { intent: 'types', queryName: 'DECL_QUERY', querySource: goQueries.DECL_QUERY },
  ],
  rust: [
    { intent: 'imports', queryName: 'USE_QUERY', querySource: rustQueries.USE_QUERY },
    { intent: 'imports', queryName: 'USE_ALIASED_QUERY', querySource: rustQueries.USE_ALIASED_QUERY },
    { intent: 'calls', queryName: 'CALL_QUERY', querySource: rustQueries.CALL_QUERY },
    { intent: 'routes', queryName: 'ROUTE_ATTR_QUERY', querySource: rustQueries.ROUTE_ATTR_QUERY },
    { intent: 'types', queryName: 'DECL_QUERY', querySource: rustQueries.DECL_QUERY },
  ],
  java: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: javaQueries.IMPORT_QUERY },
    { intent: 'calls', queryName: 'METHOD_INVOCATION_QUERY', querySource: javaQueries.METHOD_INVOCATION_QUERY },
    { intent: 'calls', queryName: 'NEW_OBJECT_QUERY', querySource: javaQueries.NEW_OBJECT_QUERY },
    { intent: 'routes', queryName: 'ANNOTATION_QUERY', querySource: javaQueries.ANNOTATION_QUERY },
    { intent: 'types', queryName: 'DECL_QUERY', querySource: javaQueries.DECL_QUERY },
  ],
  swift: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: swiftQueries.IMPORT_QUERY },
    { intent: 'calls', queryName: 'CALL_EXPR_QUERY', querySource: swiftQueries.CALL_EXPR_QUERY },
    { intent: 'types', queryName: 'DECL_QUERY', querySource: swiftQueries.DECL_QUERY },
  ],
};

export const TREE_SITTER_IR_QUERY_REGISTRY_VERSION = 'tree-sitter-ir-v1';

function languageForFile(file: string): TreeSitterIrLanguage | undefined {
  return EXTENSION_TO_LANGUAGE[extname(file).toLowerCase()];
}

function stripQuotes(value: string): string {
  return value.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

function normalizeHttpMethod(method: string): string {
  return method.replace(/^Http/i, '').toUpperCase();
}

function nodePrefixRoutePath(path: string): string {
  return `${path.replace(/\/$/, '')}/:id`;
}

function first(captures: CaptureMatch[], ...names: string[]): CaptureMatch | undefined {
  return captures.find(capture => names.includes(capture.name));
}

function capturesByRow(captures: CaptureMatch[]): CaptureMatch[][] {
  const rows = new Map<number, CaptureMatch[]>();
  for (const capture of captures) {
    const row = rows.get(capture.startRow) ?? [];
    row.push(capture);
    rows.set(capture.startRow, row);
  }
  return [...rows.values()];
}

function evidence(file: string, language: TreeSitterIrLanguage, query: QuerySpec, capture: CaptureMatch, confidence: Confidence = 'definite'): AgIrEvidence {
  return {
    extractor: 'tree-sitter-ir',
    strategy: 'ast',
    confidence,
    language,
    query: query.queryName,
    capture: capture.name,
    message: `${query.intent} evidence from ${query.queryName}`,
    span: {
      file,
      startLine: capture.startRow + 1,
      startColumn: capture.startColumn,
      endLine: capture.endRow === undefined ? undefined : capture.endRow + 1,
      endColumn: capture.endColumn,
      startByte: capture.startByte,
      endByte: capture.endByte,
    },
    raw: {
      nodeKind: capture.nodeKind,
      text: capture.text,
    },
  };
}

function addFileScaffold(graph: AgIrGraph, file: string, componentName?: string): { fileNodeId: string; componentNodeId?: string } {
  const fileNodeId = agIrId('file', file);
  graph.nodes.push(agIrNode({
    kind: 'file',
    id: fileNodeId,
    label: file,
    properties: componentName ? { component: componentName } : undefined,
  }));
  if (!componentName) return { fileNodeId };
  const componentNodeId = agIrId('component', componentName);
  graph.nodes.push(agIrNode({ kind: 'component', id: componentNodeId, label: componentName }));
  graph.edges.push(agIrEdge({
    kind: 'contains',
    from: componentNodeId,
    to: fileNodeId,
    evidence: [{
      extractor: 'tree-sitter-ir',
      strategy: 'ast',
      confidence: 'definite',
      message: `Component '${componentName}' contains '${file}'`,
      span: { file },
    }],
  }));
  return { fileNodeId, componentNodeId };
}

function nodeForSemanticTarget(kind: AgIrNodeKind, label: string, properties?: Record<string, string | number | boolean | string[]>) {
  return agIrNode({
    kind,
    id: agIrId(kind, label),
    label,
    ...(properties ? { properties } : {}),
  });
}

function addSemanticEdge(graph: AgIrGraph, input: {
  edgeKind: AgIrEdgeKind;
  from: string;
  targetKind: AgIrNodeKind;
  targetLabel: string;
  targetProperties?: Record<string, string | number | boolean | string[]>;
  edgeProperties?: Record<string, string | number | boolean | string[]>;
  evidence: AgIrEvidence;
}) {
  const target = nodeForSemanticTarget(input.targetKind, input.targetLabel, input.targetProperties);
  const edgeDiscriminator = input.edgeKind === 'handles_route'
    ? `${input.edgeProperties?.method ?? ''}:${input.edgeProperties?.path ?? input.targetLabel}`
    : input.edgeProperties?.intent;
  graph.nodes.push(target);
  graph.edges.push(agIrEdge({
    kind: input.edgeKind,
    id: agIrId('edge', input.edgeKind, input.from, target.id, edgeDiscriminator),
    from: input.from,
    to: target.id,
    ...(input.edgeProperties ? { properties: input.edgeProperties } : {}),
    evidence: [input.evidence],
  }));
}

function addRouteEdge(graph: AgIrGraph, input: {
  file: string;
  language: TreeSitterIrLanguage;
  fileNodeId: string;
  method: string;
  path: string;
  queryName: string;
  capture: CaptureMatch;
  properties?: Record<string, string | number | boolean | string[]>;
}) {
  const method = normalizeHttpMethod(input.method);
  const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
  addSemanticEdge(graph, {
    edgeKind: 'handles_route',
    from: input.fileNodeId,
    targetKind: 'route',
    targetLabel: path,
    targetProperties: {
      language: input.language,
      intent: 'routes',
    },
    edgeProperties: {
      intent: 'routes',
      query: input.queryName,
      method,
      path,
      ...(input.properties ?? {}),
    },
    evidence: {
      extractor: 'tree-sitter-ir',
      strategy: 'ast',
      confidence: 'definite',
      language: input.language,
      query: input.queryName,
      capture: input.capture.name,
      message: `${method} ${path}`,
      span: {
        file: input.file,
        startLine: input.capture.startRow + 1,
        startColumn: input.capture.startColumn,
        endLine: input.capture.endRow === undefined ? undefined : input.capture.endRow + 1,
        endColumn: input.capture.endColumn,
        startByte: input.capture.startByte,
        endByte: input.capture.endByte,
      },
      raw: {
        nodeKind: input.capture.nodeKind,
        text: input.capture.text,
      },
    },
  });
}

function captureToEdge(query: QuerySpec, row: CaptureMatch[], file: string, language: TreeSitterIrLanguage, fileNodeId: string, sourceLines: string[]): { label: string; edge: AgIrEdgeKind; node: AgIrNodeKind; capture: CaptureMatch; properties?: Record<string, string | number | boolean | string[]> } | undefined {
  if (query.intent === 'imports') {
    const capture = first(row, 'module_specifier', 'module_name', 'import_path');
    if (!capture) return undefined;
    if ((language === 'typescript' || language === 'javascript') && sourceLines[capture.startRow]?.trimStart().startsWith('import type ')) {
      return undefined;
    }
    const specifier = stripQuotes(capture.text);
    const alias = first(row, 'alias', 'import_alias')?.text;
    const importedName = first(row, 'import_name')?.text;
    return {
      label: specifier,
      edge: 'imports',
      node: 'symbol',
      capture,
      properties: {
        specifier,
        moduleKind: specifier.startsWith('.') ? 'relative' : 'package',
        ...(alias ? { alias } : {}),
        // For "from X import Y" forms, Y (not anything derived from X) is the name
        // bound in the importing file's scope — see cross-file-linker.ts.
        ...(importedName ? { importedName } : {}),
      },
    };
  }
  if (query.intent === 'calls') {
    const capture = first(row, 'fn_name', 'class_name', 'method');
    if (!capture) return undefined;
    const receiver = first(row, 'receiver')?.text;
    return {
      label: receiver ? `${receiver}.${capture.text}` : capture.text,
      edge: 'calls',
      node: 'operation',
      capture,
      properties: {
        function: capture.text,
        ...(receiver ? { receiver } : {}),
      },
    };
  }
  if (query.intent === 'routes') {
    const capture = first(row, 'route_path', 'route_suffix', 'controller_prefix');
    const method = first(row, 'method', 'http_method', 'decorator_method', 'fn_name')?.text;
    if (!capture && !method) return undefined;
    const prefixCapture = first(row, 'starts_with');
    const rawPath = capture ? stripQuotes(capture.text) : undefined;
    const path = rawPath && prefixCapture ? nodePrefixRoutePath(rawPath) : rawPath;
    const label = path ?? method!;
    return {
      label,
      edge: 'handles_route',
      node: 'route',
      capture: capture ?? first(row, 'method', 'http_method', 'decorator_method', 'fn_name')!,
      properties: {
        ...(method ? { method: normalizeHttpMethod(method) } : {}),
        ...(path ? { path } : {}),
        ...(prefixCapture ? { prefix: true } : {}),
      },
    };
  }
  if (query.intent === 'types') {
    const capture = first(row, 'class_name', 'type_name', 'property_name', 'field_name', 'attribute_name');
    if (!capture) return undefined;
    return { label: capture.text, edge: 'declares', node: 'symbol', capture };
  }
  if (query.intent === 'assignments') {
    const capture = first(row, 'property', 'field', 'value');
    if (!capture) return undefined;
    const value = first(row, 'value')?.text;
    return {
      label: capture.text,
      edge: 'assigns',
      node: 'field',
      capture,
      properties: {
        field: capture.text,
        ...(value ? { value } : {}),
      },
    };
  }
  return undefined;
}

function addCompositeTypeScriptRoutes(graph: AgIrGraph, input: {
  file: string;
  languageName: TreeSitterIrLanguage;
  fileNodeId: string;
  language: unknown;
  tree: Parser.Tree;
}) {
  if (input.languageName !== 'typescript' && input.languageName !== 'javascript') return;

  const controllerCaptures = queryCaptures(input.tree, input.language, tsQueries.NESTJS_CONTROLLER_QUERY);
  const controllerPrefix = controllerCaptures.find(capture => capture.name === 'controller_prefix')?.text ?? '';
  const methodCaptures = queryCaptures(input.tree, input.language, tsQueries.NESTJS_METHOD_QUERY);
  for (let i = 0; i < methodCaptures.length; i++) {
    const cap = methodCaptures[i]!;
    if (cap.name !== 'http_method') continue;
    const nextCap = methodCaptures[i + 1];
    const subPath = nextCap?.name === 'route_suffix' ? nextCap.text : '';
    const path = (`/${controllerPrefix}/${subPath}`).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    addRouteEdge(graph, {
      file: input.file,
      language: input.languageName,
      fileNodeId: input.fileNodeId,
      method: cap.text,
      path,
      queryName: 'NESTJS_COMPOSITE_ROUTE',
      capture: cap,
      properties: { framework: 'nestjs' },
    });
  }
}

function addCompositeCSharpRoutes(graph: AgIrGraph, input: {
  file: string;
  languageName: TreeSitterIrLanguage;
  fileNodeId: string;
  language: unknown;
  tree: Parser.Tree;
}) {
  if (input.languageName !== 'csharp') return;

  const attrCaptures = queryCaptures(input.tree, input.language, csharpQueries.ATTRIBUTE_QUERY);
  let classRoute = '';
  const httpMethods: Array<{ method: string; subPath: string; capture: CaptureMatch }> = [];

  for (let i = 0; i < attrCaptures.length; i++) {
    const nameCap = attrCaptures[i];
    if (nameCap?.name !== 'attr_name') continue;
    const argCap = attrCaptures[i + 1]?.name === 'attr_arg' ? attrCaptures[i + 1] : undefined;
    if (nameCap.text === 'Route' && argCap) {
      classRoute = stripQuotes(argCap.text);
      i++;
      continue;
    }
    const method = /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/i.exec(nameCap.text)?.[1];
    if (!method) continue;
    httpMethods.push({ method, subPath: argCap ? stripQuotes(argCap.text) : '', capture: nameCap });
    if (argCap) i++;
  }

  for (const route of httpMethods) {
    const path = (`/${classRoute}/${route.subPath}`).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    addRouteEdge(graph, {
      file: input.file,
      language: input.languageName,
      fileNodeId: input.fileNodeId,
      method: route.method,
      path,
      queryName: 'CSHARP_COMPOSITE_ROUTE',
      capture: route.capture,
      properties: { framework: 'aspnet' },
    });
  }
}

export function extractTreeSitterIrForFile(file: string, componentName?: string): AgIrGraph {
  try {
    const languageName = languageForFile(file);
    const loaded = getTreeSitter();
    if (!languageName || !loaded?.[languageName]) return emptyAgIrGraph();
    const parser = makeParser(languageName);
    const language = loaded[languageName];
    if (!parser || !language) return emptyAgIrGraph();

    const graph = emptyAgIrGraph();
    const { fileNodeId } = addFileScaffold(graph, file, componentName);
    const content = readFileSync(file, 'utf8');
    const sourceLines = content.split(/\r?\n/);
    const tree = parser.parse(content);

    addCompositeTypeScriptRoutes(graph, { file, languageName, fileNodeId, language, tree });
    addCompositeCSharpRoutes(graph, { file, languageName, fileNodeId, language, tree });

    for (const query of QUERY_REGISTRY[languageName]) {
      let captures: CaptureMatch[] = [];
      try {
        captures = queryCaptures(tree, language, query.querySource);
      } catch {
        continue;
      }
      for (const row of capturesByRow(captures)) {
        const semantic = captureToEdge(query, row, file, languageName, fileNodeId, sourceLines);
        if (!semantic) continue;
        addSemanticEdge(graph, {
          edgeKind: semantic.edge,
          from: fileNodeId,
          targetKind: semantic.node,
          targetLabel: semantic.label,
          targetProperties: {
            language: languageName,
            intent: query.intent,
          },
          edgeProperties: {
            intent: query.intent,
            query: query.queryName,
            ...(semantic.properties ?? {}),
          },
          evidence: evidence(file, languageName, query, semantic.capture),
        });
      }
    }

    return graph;
  } catch {
    return emptyAgIrGraph();
  }
}

export function extractTreeSitterIrForFiles(files: string[], componentName?: string): AgIrGraph {
  return mergeAgIrGraphs(files.map(file => extractTreeSitterIrForFile(file, componentName)));
}

export function supportedTreeSitterIrExtensions(): string[] {
  return Object.keys(EXTENSION_TO_LANGUAGE);
}
