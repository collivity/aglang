// Emits the compiled architecture.o artifact
import type { Program } from '../ast.ts';
import { translate } from '../smt/translator.ts';
import { writeFileSync } from 'fs';

export type ArtifactEndpoint =
  | { kind: 'http'; method: string; path: string; returnType?: string }
  | { kind: 'graphql'; operation: string; operationName: string; inputTypes?: string[]; returnType?: string }
  | { kind: 'grpc'; rpcName: string; inputMessage: string; outputMessage: string }
  | { kind: 'queue_publish'; topic: string }
  | { kind: 'queue_subscribe'; topic: string };

export type ArtifactInvariantRule =
  | { kind: 'DenyFlow'; from: string; to: string }
  | { kind: 'RequireEncryption'; from: string; to: string }
  | { kind: 'DenyDataFlow'; data: string; to: string };

export interface ArchitectureArtifact {
  schemaVersion: number;
  sourcePath: string;
  enforcement: Array<{
    declaration: string;
    level: 'formal_z3' | 'deterministic_policy' | 'advisory';
    mechanism: string;
  }>;
  // SMT-LIB constraint strings (permanent rules — enforced by Z3 at commit time)
  constraints: string[];
  // Maps component name → path glob (for diff-time file-to-component lookup)
  mappings: Record<string, string>;
  // All declared invariant names for diagnostics
  invariants: Array<{ name: string; rules: ArtifactInvariantRule[] }>;
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
    endpoints: ArtifactEndpoint[];
  }>;
  // Which components implement or consume which contracts
  componentContracts: Array<{
    component: string;
    implements: string[];
    consumes: string[];
  }>;
  componentData: Array<{
    component: string;
    handles: string[];
  }>;
  // External extractor plugin package names declared in the spec
  plugins: string[];
  // Multi-repo: declared external repositories
  repos: Array<{ name: string; url: string; branch?: string }>;
  // Multi-repo: maps component name → repo alias (for CI reference)
  componentRepos: Record<string, string>;
  // GitHub Actions workflow policies (directly evaluated by workflow gate)
  workflowPolicies: Array<{
    name: string;
    rules: Array<
      | {
          kind: 'ActionRule';
          effect: 'allow' | 'deny';
          action: 'publish' | 'deploy' | 'release';
          workflow: string;
          target: string;
          when?: { kind: 'branch' | 'tag'; value: string } | { kind: 'pull_request' };
        }
      | {
          kind: 'PermissionRule';
          effect: 'allow' | 'deny';
          workflow: string;
          permission: string;
          access: string;
          when?: { kind: 'branch' | 'tag'; value: string } | { kind: 'pull_request' };
        }
      | {
          kind: 'BeforeRule';
          workflow: string;
          before: string;
          after: string;
        }
    >;
  }>;
  // Change coupling policies (evaluated by the change gate)
  changePolicies: Array<{
    name: string;
    rules: Array<{
      kind: 'RequireTouched';
      required: string;
      trigger: string;
    }>;
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
  const componentData: ArchitectureArtifact['componentData'] = [];
  const plugins: string[] = [];
  const repos: ArchitectureArtifact['repos'] = [];
  const componentRepos: Record<string, string> = {};
  const workflowPolicies: ArchitectureArtifact['workflowPolicies'] = [];
  const changePolicies: ArchitectureArtifact['changePolicies'] = [];

  for (const decl of program.declarations) {
    if (decl.kind === 'ComponentDecl') {
      mappings[decl.name] = decl.paths;
      if (decl.repo) {
        componentRepos[decl.name] = decl.repo;
      }
      if ((decl.implements?.length ?? 0) > 0 || (decl.consumes?.length ?? 0) > 0) {
        componentContracts.push({
          component: decl.name,
          implements: decl.implements ?? [],
          consumes: decl.consumes ?? [],
        });
      }
      if ((decl.handles?.length ?? 0) > 0) {
        componentData.push({
          component: decl.name,
          handles: decl.handles ?? [],
        });
      }
    }
    if (decl.kind === 'InvariantDecl') {
      invariants.push({
        name: decl.name,
        rules: decl.rules.map<ArtifactInvariantRule>(r => r.kind === 'DenyDataFlow'
          ? ({ kind: r.kind, data: r.data, to: r.to })
          : ({ kind: r.kind, from: r.from, to: r.to })),
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
        endpoints: decl.endpoints.map(ep => {
          if (ep.kind === 'http') {
            return { kind: 'http' as const, method: ep.method, path: ep.path, ...(ep.returnType ? { returnType: ep.returnType } : {}) };
          } else if (ep.kind === 'graphql') {
            return { kind: 'graphql' as const, operation: ep.operation, operationName: ep.operationName, ...(ep.inputTypes?.length ? { inputTypes: ep.inputTypes } : {}), ...(ep.returnType ? { returnType: ep.returnType } : {}) };
          } else if (ep.kind === 'grpc') {
            return { kind: 'grpc' as const, rpcName: ep.rpcName, inputMessage: ep.inputMessage, outputMessage: ep.outputMessage };
          } else if (ep.kind === 'queue_publish') {
            return { kind: 'queue_publish' as const, topic: ep.topic };
          } else {
            return { kind: 'queue_subscribe' as const, topic: ep.topic };
          }
        }),
      });
    }
    if (decl.kind === 'PluginDecl') {
      if (!plugins.includes(decl.packageName)) {
        plugins.push(decl.packageName);
      }
    }
    if (decl.kind === 'RepoDecl') {
      repos.push({ name: decl.name, url: decl.url, ...(decl.branch ? { branch: decl.branch } : {}) });
    }
    if (decl.kind === 'WorkflowPolicyDecl') {
      workflowPolicies.push({
        name: decl.name,
        rules: decl.rules.map(rule => ({ ...rule })),
      });
    }
    if (decl.kind === 'ChangePolicyDecl') {
      changePolicies.push({
        name: decl.name,
        rules: decl.rules.map(rule => ({ ...rule })),
      });
    }
  }

  return {
    schemaVersion: 9,
    sourcePath,
    enforcement: [
      {
        declaration: 'invariant deny flow',
        level: 'formal_z3',
        mechanism: 'Flow facts extracted from code are asserted against SMT-LIB constraints.',
      },
      {
        declaration: 'invariant deny dataflow',
        level: 'formal_z3',
        mechanism: 'Dataflow facts inferred from handled data and extracted flows are asserted against SMT-LIB constraints.',
      },
      {
        declaration: 'change_policy',
        level: 'formal_z3',
        mechanism: 'Touched-component facts are asserted against SMT-LIB implication rules.',
      },
      {
        declaration: 'contract',
        level: 'deterministic_policy',
        mechanism: 'Route extractors compare implemented and consumed endpoints against declared contracts.',
      },
      {
        declaration: 'workflow_policy',
        level: 'deterministic_policy',
        mechanism: 'GitHub Actions facts are checked for publish/deploy/release, permissions, and step order.',
      },
      {
        declaration: 'invariant require encryption',
        level: 'advisory',
        mechanism: 'Reported as warnings because extractors do not yet prove encryption.',
      },
      {
        declaration: 'machine',
        level: 'advisory',
        mechanism: 'Emitted to AGENTS.md for agent guidance; transition extraction is not enforced yet.',
      },
      {
        declaration: 'permission',
        level: 'advisory',
        mechanism: 'Emitted to AGENTS.md for agent guidance; access-control extraction is not enforced yet.',
      },
    ],
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
    componentData,
    plugins,
    repos,
    componentRepos,
    workflowPolicies,
    changePolicies,
  };
}

export function writeArtifact(artifact: ArchitectureArtifact, outPath: string): void {
  writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
}

export function loadArtifact(json: string): ArchitectureArtifact {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const contracts = raw.contracts as Array<{ name: string; endpoints: unknown[] }> | undefined;
  if (Array.isArray(contracts)) {
    for (const c of contracts) {
      if (Array.isArray(c.endpoints)) {
        c.endpoints = c.endpoints.map((ep: unknown) => {
          const e = ep as Record<string, unknown>;
          return e.kind ? e : { kind: 'http', ...e };
        });
      }
    }
  }
  return raw as unknown as ArchitectureArtifact;
}
