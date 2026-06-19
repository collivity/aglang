import { dirname, normalize, resolve } from 'path';
import micromatch from 'micromatch';
import type { FlowFact } from '../analyzers/plugin.ts';
import { resolveCategoryToTargets } from '../analyzers/node-resolver.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { AgIrEdge, AgIrEvidence, AgIrGraph, AgIrNode } from './types.ts';

const PACKAGE_CATEGORY_ALIASES: Record<string, string> = {
  pg: 'postgres',
  'node-postgres': 'postgres',
  mongodb: 'mongodb',
};

export interface IrLowererWarning {
  edgeId: string;
  message: string;
}

export interface IrUnresolvedEdge {
  edgeId: string;
  kind: AgIrEdge['kind'];
  from: string;
  to: string;
  reason: string;
}

export interface IrLoweredFlowProvenance {
  edgeId: string;
  from: string;
  to: string;
  source: 'ag-ir';
}

export interface IrPolicyFacts {
  flowFacts: FlowFact[];
  warnings: IrLowererWarning[];
  unresolvedEdges: IrUnresolvedEdge[];
  provenance: IrLoweredFlowProvenance[];
}

function evidenceFile(evidence?: AgIrEvidence[]): string {
  return evidence?.find(item => item.span?.file)?.span?.file ?? '';
}

function evidenceLine(evidence?: AgIrEvidence[]): number | undefined {
  return evidence?.find(item => item.span?.startLine)?.span?.startLine;
}

function evidenceConfidence(evidence?: AgIrEvidence[]): FlowFact['confidence'] {
  return evidence?.find(item => item.confidence)?.confidence ?? 'definite';
}

function evidenceMessage(edge: AgIrEdge, target: AgIrNode): string {
  const message = edge.evidence.find(item => item.message)?.message;
  return message ?? `Ag-IR ${edge.kind} edge to ${target.label}`;
}

function declaredEntitySet(artifact: ArchitectureArtifact): Set<string> {
  const fromSmt = (artifact.constraints ?? [])
    .map(s => s.match(/^\(declare-const\s+([^\s]+)\s+Entity\)/)?.[1])
    .filter((name): name is string => Boolean(name));
  return new Set([
    ...Object.keys(artifact.mappings ?? {}),
    ...(artifact.nodes ?? []).map(node => node.name),
    ...(artifact.resources ?? []).map(resource => resource.name),
    ...fromSmt,
  ]);
}

function normalizeForMatch(path: string): string {
  return normalize(path).replace(/\\/g, '/');
}

function componentForFile(file: string, artifact: ArchitectureArtifact): string | undefined {
  const normalized = normalizeForMatch(file);
  for (const [component, glob] of Object.entries(artifact.mappings ?? {})) {
    const pattern = normalizeForMatch(glob);
    if (micromatch.isMatch(normalized, `**/${pattern}`) || micromatch.isMatch(normalized, pattern)) {
      return component;
    }
  }
  return undefined;
}

function componentForNode(node: AgIrNode, artifact: ArchitectureArtifact, containsFileComponent: Map<string, string>): string | undefined {
  if (node.kind === 'component') return node.label;
  if (typeof node.properties?.component === 'string') return node.properties.component;
  if (node.kind === 'file') {
    return containsFileComponent.get(node.id) ?? componentForFile(node.label, artifact);
  }
  return undefined;
}

function possibleImportTargets(importerFile: string, specifier: string): string[] {
  const base = specifier.startsWith('.')
    ? resolve(dirname(importerFile), specifier)
    : specifier;
  if (!specifier.startsWith('.')) return [];
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.cs', '.go', '.rs', '.java'];
  const indexExtensions = extensions.filter(ext => ext.length > 0).map(ext => `/index${ext}`);
  return [...extensions.map(ext => normalizeForMatch(base + ext)), ...indexExtensions.map(suffix => normalizeForMatch(base + suffix))];
}

function resolveRelativeImport(edge: AgIrEdge, fromNode: AgIrNode, target: AgIrNode, artifact: ArchitectureArtifact, fileNodes: AgIrNode[]): string | undefined {
  if (fromNode.kind !== 'file' || target.kind !== 'symbol') return undefined;
  if (!target.label.startsWith('.')) return undefined;
  const candidates = new Set(possibleImportTargets(fromNode.label, target.label));
  const matchedFile = fileNodes.find(file => candidates.has(normalizeForMatch(file.label)));
  if (matchedFile) return componentForFile(matchedFile.label, artifact) ?? (typeof matchedFile.properties?.component === 'string' ? matchedFile.properties.component : undefined);
  const resolvedPath = possibleImportTargets(fromNode.label, target.label)[0];
  if (resolvedPath) return componentForFile(resolvedPath, artifact);
  return undefined;
}

function modulePackageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function resolveDeclaredTarget(label: string, artifact: ArchitectureArtifact, declaredEntities: Set<string>): string[] {
  if (declaredEntities.has(label)) return [label];
  const packageName = modulePackageName(label);
  if (declaredEntities.has(packageName)) return [packageName];
  const resolved = resolveCategoryToTargets(PACKAGE_CATEGORY_ALIASES[packageName] ?? packageName, artifact);
  return resolved.filter(target => declaredEntities.has(target));
}

function addUniqueFlow(out: FlowFact[], fact: FlowFact): void {
  const key = `${fact.from}::${fact.to}`;
  if (out.some(existing => `${existing.from}::${existing.to}` === key)) return;
  out.push(fact);
}

export function derivePolicyFactsFromAgIr(
  graph: AgIrGraph,
  artifact: ArchitectureArtifact,
): IrPolicyFacts {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const fileNodes = graph.nodes.filter(node => node.kind === 'file');
  const declaredEntities = declaredEntitySet(artifact);
  const containsFileComponent = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains') continue;
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from?.kind === 'component' && to?.kind === 'file') containsFileComponent.set(to.id, from.label);
  }

  const flowFacts: FlowFact[] = [];
  const warnings: IrLowererWarning[] = [];
  const unresolvedEdges: IrUnresolvedEdge[] = [];
  const provenance: IrLoweredFlowProvenance[] = [];

  for (const edge of graph.edges) {
    if (!['imports', 'depends_on', 'calls', 'accesses_resource'].includes(edge.kind)) continue;
    if (edge.evidence.some(item => item.raw && typeof item.raw.graphFactId === 'string')) continue;
    const fromNode = nodes.get(edge.from);
    const targetNode = nodes.get(edge.to);
    if (!fromNode || !targetNode) continue;

    const from = componentForNode(fromNode, artifact, containsFileComponent);
    if (!from) {
      unresolvedEdges.push({ edgeId: edge.id, kind: edge.kind, from: edge.from, to: edge.to, reason: 'source component could not be resolved' });
      warnings.push({ edgeId: edge.id, message: `Could not resolve source component for Ag-IR ${edge.kind} edge` });
      continue;
    }

    let targets: string[] = [];
    if (edge.kind === 'imports') {
      const relativeTarget = resolveRelativeImport(edge, fromNode, targetNode, artifact, fileNodes);
      targets = relativeTarget ? [relativeTarget] : resolveDeclaredTarget(targetNode.label, artifact, declaredEntities);
    } else if (edge.kind === 'depends_on' || edge.kind === 'accesses_resource') {
      targets = resolveDeclaredTarget(targetNode.label, artifact, declaredEntities);
      if (targets.length === 0) {
        const component = componentForNode(targetNode, artifact, containsFileComponent);
        if (component) targets = [component];
      }
    } else if (edge.kind === 'calls') {
      if (targetNode.kind === 'component' || targetNode.kind === 'resource') {
        targets = resolveDeclaredTarget(targetNode.label, artifact, declaredEntities);
      }
    }

    if (targets.length === 0) {
      unresolvedEdges.push({ edgeId: edge.id, kind: edge.kind, from: fromNode.label, to: targetNode.label, reason: 'target could not be resolved to a declared component or resource' });
      warnings.push({ edgeId: edge.id, message: `Could not resolve Ag-IR ${edge.kind} target '${targetNode.label}'` });
      continue;
    }

    for (const to of targets) {
      if (from === to) continue;
      const file = evidenceFile(edge.evidence) || (fromNode.kind === 'file' ? fromNode.label : '');
      const fact: FlowFact = {
        from,
        to,
        confidence: evidenceConfidence(edge.evidence),
        evidence: evidenceMessage(edge, targetNode),
        file,
        line: evidenceLine(edge.evidence),
        strategy: 'ast',
        graphEvidence: {
          graphFactId: edge.id,
          kind: edge.kind,
          extractor: edge.evidence[0]?.extractor ?? 'ag-ir-lowerer',
          strategy: edge.evidence[0]?.strategy ?? 'ast',
          file,
          line: evidenceLine(edge.evidence),
          evidence: evidenceMessage(edge, targetNode),
        },
      };
      addUniqueFlow(flowFacts, fact);
      provenance.push({ edgeId: edge.id, from, to, source: 'ag-ir' });
    }
  }

  return { flowFacts, warnings, unresolvedEdges, provenance };
}
