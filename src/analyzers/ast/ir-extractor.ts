import { readFileSync } from 'fs';
import { extname } from 'path';
import type { Confidence } from '../plugin.ts';
import { getTreeSitter, makeParser } from './loader.ts';
import { queryCaptures, type CaptureMatch } from './walker.ts';
import * as csharpQueries from './queries/csharp.ts';
import * as goQueries from './queries/golang.ts';
import * as javaQueries from './queries/java.ts';
import * as pythonQueries from './queries/python.ts';
import * as rustQueries from './queries/rust.ts';
import * as tsQueries from './queries/typescript.ts';
import { agIrEdge, agIrId, agIrNode, emptyAgIrGraph, mergeAgIrGraphs } from '../../ir/builders.ts';
import type { AgIrEdgeKind, AgIrEvidence, AgIrGraph, AgIrNodeKind } from '../../ir/types.ts';

export type TreeSitterIrLanguage = 'typescript' | 'javascript' | 'python' | 'csharp' | 'golang' | 'rust' | 'java';

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
  ],
  javascript: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: tsQueries.IMPORT_QUERY },
    { intent: 'imports', queryName: 'IMPORT_NAMED_QUERY', querySource: tsQueries.IMPORT_NAMED_QUERY },
    { intent: 'imports', queryName: 'REQUIRE_QUERY', querySource: tsQueries.REQUIRE_QUERY },
    { intent: 'calls', queryName: 'NEW_EXPR_QUERY', querySource: tsQueries.NEW_EXPR_QUERY },
    { intent: 'routes', queryName: 'EXPRESS_ROUTE_QUERY', querySource: tsQueries.EXPRESS_ROUTE_QUERY },
  ],
  python: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: pythonQueries.IMPORT_QUERY },
    { intent: 'imports', queryName: 'IMPORT_ALIAS_QUERY', querySource: pythonQueries.IMPORT_ALIAS_QUERY },
    { intent: 'imports', queryName: 'FROM_IMPORT_QUERY', querySource: pythonQueries.FROM_IMPORT_QUERY },
    { intent: 'calls', queryName: 'CALL_EXPR_QUERY', querySource: pythonQueries.CALL_EXPR_QUERY },
    { intent: 'routes', queryName: 'DECORATOR_ROUTE_QUERY', querySource: pythonQueries.DECORATOR_ROUTE_QUERY },
    { intent: 'routes', queryName: 'FLASK_ROUTE_QUERY', querySource: pythonQueries.FLASK_ROUTE_QUERY },
    { intent: 'routes', queryName: 'DJANGO_PATH_QUERY', querySource: pythonQueries.DJANGO_PATH_QUERY },
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
    { intent: 'calls', queryName: 'CALL_QUERY', querySource: goQueries.CALL_QUERY },
    { intent: 'routes', queryName: 'ROUTE_QUERY', querySource: goQueries.ROUTE_QUERY },
  ],
  rust: [
    { intent: 'imports', queryName: 'USE_QUERY', querySource: rustQueries.USE_QUERY },
    { intent: 'calls', queryName: 'CALL_QUERY', querySource: rustQueries.CALL_QUERY },
    { intent: 'routes', queryName: 'ROUTE_ATTR_QUERY', querySource: rustQueries.ROUTE_ATTR_QUERY },
  ],
  java: [
    { intent: 'imports', queryName: 'IMPORT_QUERY', querySource: javaQueries.IMPORT_QUERY },
    { intent: 'calls', queryName: 'METHOD_INVOCATION_QUERY', querySource: javaQueries.METHOD_INVOCATION_QUERY },
    { intent: 'calls', queryName: 'NEW_OBJECT_QUERY', querySource: javaQueries.NEW_OBJECT_QUERY },
    { intent: 'routes', queryName: 'ANNOTATION_QUERY', querySource: javaQueries.ANNOTATION_QUERY },
  ],
};

export const TREE_SITTER_IR_QUERY_REGISTRY_VERSION = 'tree-sitter-ir-v1';

function languageForFile(file: string): TreeSitterIrLanguage | undefined {
  return EXTENSION_TO_LANGUAGE[extname(file).toLowerCase()];
}

function stripQuotes(value: string): string {
  return value.replace(/^['"`]/, '').replace(/['"`]$/, '');
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
  graph.nodes.push(target);
  graph.edges.push(agIrEdge({
    kind: input.edgeKind,
    id: agIrId('edge', input.edgeKind, input.from, target.id, input.edgeProperties?.intent),
    from: input.from,
    to: target.id,
    ...(input.edgeProperties ? { properties: input.edgeProperties } : {}),
    evidence: [input.evidence],
  }));
}

function captureToEdge(query: QuerySpec, row: CaptureMatch[], file: string, language: TreeSitterIrLanguage, fileNodeId: string, sourceLines: string[]): { label: string; edge: AgIrEdgeKind; node: AgIrNodeKind; capture: CaptureMatch; properties?: Record<string, string | number | boolean | string[]> } | undefined {
  if (query.intent === 'imports') {
    const capture = first(row, 'module_specifier', 'module_name', 'import_path');
    if (!capture) return undefined;
    if ((language === 'typescript' || language === 'javascript') && sourceLines[capture.startRow]?.trimStart().startsWith('import type ')) {
      return undefined;
    }
    const specifier = stripQuotes(capture.text);
    return {
      label: specifier,
      edge: 'imports',
      node: 'symbol',
      capture,
      properties: {
        specifier,
        moduleKind: specifier.startsWith('.') ? 'relative' : 'package',
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
    const label = capture ? stripQuotes(capture.text) : method!;
    return {
      label,
      edge: 'handles_route',
      node: 'route',
      capture: capture ?? first(row, 'method', 'http_method', 'decorator_method', 'fn_name')!,
      properties: {
        ...(method ? { method } : {}),
        ...(capture ? { path: stripQuotes(capture.text) } : {}),
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
