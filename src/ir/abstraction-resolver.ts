import { createRequire } from 'module';
import { extname } from 'path';
import { readFileSync } from 'fs';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import { agIrEdge, agIrId, agIrNode, emptyAgIrGraph, mergeAgIrGraphs } from './builders.ts';
import { componentForFile } from './lowerer.ts';
import type { AgIrEvidence, AgIrGraph } from './types.ts';
import { getTreeSitter, makeParser } from '../analyzers/ast/loader.ts';

const require = createRequire(import.meta.url);
const QueryCtor = (require('tree-sitter') as { Query: new (language: unknown, source: string) => GoQuery }).Query;

interface GoQueryCapture { name: string; node: { text: string; namedChildCount: number } }
interface GoQueryMatch { captures: GoQueryCapture[] }
interface GoQuery { matches(node: unknown): GoQueryMatch[] }

function linkResolutionEvidence(message: string, confidence: AgIrEvidence['confidence']): AgIrEvidence {
  return { extractor: 'abstraction-resolver', strategy: 'ast', confidence, message };
}

function findCapture(match: GoQueryMatch, name: string): GoQueryCapture['node'] | undefined {
  return match.captures.find(c => c.name === name)?.node;
}

// ── Extends/implements resolution (Python/Java/Rust/Swift, syntactic) ────────

function buildDeclaredNameIndex(graph: AgIrGraph, nodes: Map<string, AgIrGraph['nodes'][number]>, artifact: ArchitectureArtifact): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'declares') continue;
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (fromNode?.kind !== 'file' || !toNode) continue;
    const component = componentForFile(fromNode.label, artifact);
    if (!component) continue;
    const set = index.get(toNode.label) ?? new Set<string>();
    set.add(component);
    index.set(toNode.label, set);
  }
  return index;
}

function resolveInheritanceEdges(graph: AgIrGraph, nodes: Map<string, AgIrGraph['nodes'][number]>, artifact: ArchitectureArtifact, patch: AgIrGraph): void {
  const declaredNameIndex = buildDeclaredNameIndex(graph, nodes, artifact);
  for (const edge of graph.edges) {
    if (edge.kind !== 'extends' && edge.kind !== 'implements') continue;
    const name = typeof edge.properties?.baseType === 'string' ? edge.properties.baseType
      : typeof edge.properties?.interface === 'string' ? edge.properties.interface : undefined;
    if (!name) continue;
    const components = declaredNameIndex.get(name);
    // Skip rather than guess when the referenced name is declared in more than one
    // component — same "precision over recall" choice made for every ambiguous case
    // in this codebase (Go's bare constants, Rust's super::/self::, etc.).
    if (!components || components.size !== 1) continue;
    const [targetComponent] = components;
    patch.edges.push(agIrEdge({
      kind: edge.kind,
      id: edge.id,
      from: edge.from,
      to: edge.to,
      properties: { resolved: true, targetComponent: targetComponent! },
      evidence: [linkResolutionEvidence(`Resolved ${edge.kind} relationship '${name}' to component '${targetComponent}'`, 'definite')],
    }));
  }
}

/**
 * Builds the interface/protocol/trait -> implementing-components index from already-resolved
 * `implements` edges. Many components implementing the same interface is the expected,
 * common case here (unlike buildDeclaredNameIndex's ambiguity, which is about one name
 * being declared in multiple places). Exported for future call-resolution use — not
 * consumed by anything yet; see round 5 plan for why that's a separate, later round
 * (needs field/parameter declared-type tracking first).
 */
export function buildImplementorIndex(graph: AgIrGraph): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'implements') continue;
    const targetComponent = typeof edge.properties?.targetComponent === 'string' ? edge.properties.targetComponent : undefined;
    const name = typeof edge.properties?.interface === 'string' ? edge.properties.interface : undefined;
    if (!targetComponent || !name) continue;
    const set = index.get(name) ?? new Set<string>();
    set.add(targetComponent);
    index.set(name, set);
  }
  return index;
}

// ── Go structural interface satisfaction (heuristic, name+arity only) ────────
//
// Go interfaces are satisfied implicitly — a struct never references the interface it
// satisfies anywhere in its own syntax, so there is nothing to read like the other four
// languages' explicit extends/implements clauses. This compares method NAME+ARITY sets
// across the whole project as an approximation, not real type checking: no parameter or
// return type comparison, no embedded-interface handling, no receiver-kind subtleties.
// Always 'probable' confidence. Interfaces with fewer than MIN_METHODS_FOR_MATCH required
// methods are skipped entirely — single-method interfaces (Close() error, String() string,
// Error() string-style) are extremely common in Go and would otherwise match huge numbers
// of unrelated structs on name alone.

const MIN_METHODS_FOR_MATCH = 2;

const GO_INTERFACE_QUERY_SRC = `(type_spec name: (type_identifier) @interface_name type: (interface_type) @interface_body)`;
const GO_INTERFACE_METHOD_QUERY_SRC = `(method_elem name: (field_identifier) @method_name parameters: (parameter_list) @method_params)`;
const GO_STRUCT_METHOD_QUERY_SRC = `
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [
        (type_identifier) @receiver_type
        (pointer_type (type_identifier) @receiver_type)
      ]))
  name: (field_identifier) @method_name
  parameters: (parameter_list) @method_params)
` as const;

function methodSignature(nameNode: GoQueryCapture['node'], paramsNode: GoQueryCapture['node']): string {
  const arity = paramsNode.text === '()' ? 0 : paramsNode.namedChildCount;
  return `${nameNode.text}/${arity}`;
}

function collectGoMethodSets(goFiles: Array<{ file: string; component: string }>): {
  interfaces: Map<string, { component: string; methods: Set<string> }>;
  structs: Map<string, { component: string; methods: Set<string> }>;
} {
  const interfaces = new Map<string, { component: string; methods: Set<string> }>();
  const structs = new Map<string, { component: string; methods: Set<string> }>();
  const language = getTreeSitter()?.golang;
  const parser = makeParser('golang');
  if (!language || !parser) return { interfaces, structs };

  const ifaceQuery = new QueryCtor(language, GO_INTERFACE_QUERY_SRC);
  const ifaceMethodQuery = new QueryCtor(language, GO_INTERFACE_METHOD_QUERY_SRC);
  const structMethodQuery = new QueryCtor(language, GO_STRUCT_METHOD_QUERY_SRC);

  for (const { file, component } of goFiles) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const tree = parser.parse(content);

    for (const match of ifaceQuery.matches(tree.rootNode)) {
      const nameNode = findCapture(match, 'interface_name');
      const bodyNode = findCapture(match, 'interface_body');
      if (!nameNode || !bodyNode) continue;
      const methods = new Set<string>();
      for (const methodMatch of ifaceMethodQuery.matches(bodyNode)) {
        const methodName = findCapture(methodMatch, 'method_name');
        const methodParams = findCapture(methodMatch, 'method_params');
        if (methodName && methodParams) methods.add(methodSignature(methodName, methodParams));
      }
      const existing = interfaces.get(nameNode.text);
      existing?.methods.forEach(m => methods.add(m));
      interfaces.set(nameNode.text, { component, methods });
    }

    for (const match of structMethodQuery.matches(tree.rootNode)) {
      const receiverType = findCapture(match, 'receiver_type');
      const methodName = findCapture(match, 'method_name');
      const methodParams = findCapture(match, 'method_params');
      if (!receiverType || !methodName || !methodParams) continue;
      const entry = structs.get(receiverType.text) ?? { component, methods: new Set<string>() };
      entry.methods.add(methodSignature(methodName, methodParams));
      structs.set(receiverType.text, entry);
    }
  }

  return { interfaces, structs };
}

function resolveGoStructuralInterfaces(graph: AgIrGraph, nodes: Map<string, AgIrGraph['nodes'][number]>, artifact: ArchitectureArtifact, patch: AgIrGraph): void {
  const goFiles: Array<{ file: string; component: string }> = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'file' || extname(node.label).toLowerCase() !== '.go') continue;
    const component = componentForFile(node.label, artifact);
    if (component) goFiles.push({ file: node.label, component });
  }
  if (goFiles.length === 0) return;

  const { interfaces, structs } = collectGoMethodSets(goFiles);
  for (const [interfaceName, iface] of interfaces) {
    if (iface.methods.size < MIN_METHODS_FOR_MATCH) continue;
    for (const [structName, struct] of structs) {
      const satisfies = [...iface.methods].every(m => struct.methods.has(m));
      if (!satisfies) continue;
      const fromId = agIrId('type', 'go', structName);
      const toId = agIrId('type', 'go', interfaceName);
      patch.nodes.push(
        agIrNode({ id: fromId, kind: 'type', label: structName }),
        agIrNode({ id: toId, kind: 'type', label: interfaceName }),
      );
      patch.edges.push(agIrEdge({
        kind: 'implements',
        id: agIrId('edge', 'implements', fromId, toId, 'go-structural'),
        from: fromId,
        to: toId,
        properties: { interface: interfaceName, resolved: true, targetComponent: iface.component, structural: true },
        evidence: [linkResolutionEvidence(
          `Structural match: '${structName}' (component '${struct.component}') declares all ${iface.methods.size} method(s) required by interface '${interfaceName}' (component '${iface.component}') — name+arity only, not type-checked`,
          'probable',
        )],
      }));
    }
  }
}

/**
 * Resolves extends/implements edges (Python/Java/Rust/Swift) and adds Go's structural
 * interface-satisfaction heuristic, patching resolved/targetComponent the same way
 * cross-file-linker.ts resolves imports/calls. Deliberately does not wire any of this
 * into call-site resolution — see buildImplementorIndex's docstring.
 */
export function enrichAgIrWithAbstractionResolution(graph: AgIrGraph, artifact: ArchitectureArtifact): AgIrGraph {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const patch = emptyAgIrGraph();
  resolveInheritanceEdges(graph, nodes, artifact, patch);
  resolveGoStructuralInterfaces(graph, nodes, artifact, patch);
  return mergeAgIrGraphs([graph, patch]);
}
