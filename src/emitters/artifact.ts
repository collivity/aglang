// Emits the compiled architecture.o artifact
import type { Program, ComponentDecl, InvariantDecl, EnumDecl, DataDecl, NodeDecl, StateMachineDecl, PermissionDecl, ContractDecl } from '../ast.ts';
import { translate } from '../smt/translator.ts';
import { writeFileSync } from 'fs';

export interface ArchitectureArtifact {
  schemaVersion: number;
  sourcePath: string;
  // SMT-LIB constraint strings (permanent rules — enforced by Z3 at commit time)
  constraints: string[];
  // Maps component name → path glob (for diff-time file-to-component lookup)
  mappings: Record<string, string>;
  // All declared invariant names for diagnostics
  invariants: Array<{ name: string; rules: Array<{ kind: string; from: string; to: string }> }>;
  // Nodes and components for context emission
  nodes: Array<{ name: string; type: string; trust?: string; protocol?: string; auth?: string }>;
  // Enum declarations for context and agent use
  enums: Array<{ name: string; values: string[] }>;
  // Data type declarations for context emission
  dataTypes: Array<{ name: string; fields: Array<{ key: string; typeExpr: string }> }>;
  // State machine declarations (advisory — not Z3-enforced yet)
  stateMachines: Array<{
    name: string;
    onType: string;
    onField: string;
    transitions: Array<{ kind: 'allow' | 'deny'; from: string; to: string }>;
  }>;
  // Permission declarations (advisory — not Z3-enforced yet)
  permissions: Array<{
    name: string;
    onType: string;
    rules: Array<{
      kind: 'allow' | 'deny';
      roleEnum: string;
      roleValue: string;
      operations: string[];
      whenField?: string;
    }>;
  }>;
  // API contracts declared in the spec
  contracts: Array<{
    name: string;
    endpoints: Array<{ method: string; path: string; returnType?: string }>;
  }>;
  // Which components implement or consume which contracts
  componentContracts: Array<{
    component: string;
    implements: string[];
    consumes: string[];
  }>;
}

export function emitArtifact(program: Program, sourcePath: string): ArchitectureArtifact {
  const constraints = translate(program);

  const mappings: Record<string, string> = {};
  const invariants: ArchitectureArtifact['invariants'] = [];
  const nodes: ArchitectureArtifact['nodes'] = [];
  const enums: ArchitectureArtifact['enums'] = [];
  const dataTypes: ArchitectureArtifact['dataTypes'] = [];
  const stateMachines: ArchitectureArtifact['stateMachines'] = [];
  const permissions: ArchitectureArtifact['permissions'] = [];
  const contracts: ArchitectureArtifact['contracts'] = [];
  const componentContracts: ArchitectureArtifact['componentContracts'] = [];

  for (const decl of program.declarations) {
    if (decl.kind === 'ComponentDecl') {
      mappings[decl.name] = decl.paths;
      if ((decl.implements?.length ?? 0) > 0 || (decl.consumes?.length ?? 0) > 0) {
        componentContracts.push({
          component: decl.name,
          implements: decl.implements ?? [],
          consumes: decl.consumes ?? [],
        });
      }
    }
    if (decl.kind === 'InvariantDecl') {
      invariants.push({
        name: decl.name,
        rules: decl.rules.map(r => ({ kind: r.kind, from: r.from, to: r.to })),
      });
    }
    if (decl.kind === 'NodeDecl') {
      const trust = decl.props.find(p => p.key === 'trust');
      const protocol = decl.props.find(p => p.key === 'protocol');
      const auth = decl.props.find(p => p.key === 'auth');
      nodes.push({
        name: decl.name,
        type: decl.nodeType.kind === 'parameterized'
          ? `${decl.nodeType.name}(${decl.nodeType.param})`
          : decl.nodeType.name,
        trust: Array.isArray(trust?.value) ? trust!.value[0] : trust?.value,
        protocol: Array.isArray(protocol?.value) ? protocol!.value[0] : protocol?.value,
        auth: Array.isArray(auth?.value) ? auth!.value[0] : auth?.value,
      });
    }
    if (decl.kind === 'EnumDecl') {
      enums.push({ name: decl.name, values: decl.values });
    }
    if (decl.kind === 'DataDecl') {
      dataTypes.push({ name: decl.name, fields: decl.fields.map(f => ({ key: f.key, typeExpr: f.typeExpr })) });
    }
    if (decl.kind === 'StateMachineDecl') {
      stateMachines.push({
        name: decl.name,
        onType: decl.onType,
        onField: decl.onField,
        transitions: decl.transitions.map(t => ({ kind: t.kind, from: t.from, to: t.to })),
      });
    }
    if (decl.kind === 'PermissionDecl') {
      permissions.push({
        name: decl.name,
        onType: decl.onType,
        rules: decl.rules.map(r => ({
          kind: r.kind,
          roleEnum: r.roleEnum,
          roleValue: r.roleValue,
          operations: r.operations,
          ...(r.whenField ? { whenField: r.whenField } : {}),
        })),
      });
    }
    if (decl.kind === 'ContractDecl') {
      contracts.push({
        name: decl.name,
        endpoints: decl.endpoints.map(e => ({
          method: e.method,
          path: e.path,
          ...(e.returnType ? { returnType: e.returnType } : {}),
        })),
      });
    }
  }

  return {
    schemaVersion: 3,
    sourcePath,
    constraints,
    mappings,
    invariants,
    nodes,
    enums,
    dataTypes,
    stateMachines,
    permissions,
    contracts,
    componentContracts,
  };
}

export function writeArtifact(artifact: ArchitectureArtifact, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
}
