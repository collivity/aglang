// Emits the compiled architecture.o artifact
import type { Program } from '../ast.ts';
import { translate } from '../smt/translator.ts';
import { expandInvariantRules } from '../invariant-selectors.ts';
import { writeFileSync } from 'fs';

export type ArtifactEndpoint =
  | { kind: 'http'; method: string; path: string; returnType?: string }
  | { kind: 'graphql'; operation: string; operationName: string; inputTypes?: string[]; returnType?: string }
  | { kind: 'grpc'; rpcName: string; inputMessage: string; outputMessage: string }
  | { kind: 'queue_publish'; topic: string }
  | { kind: 'queue_subscribe'; topic: string };

export type ArtifactInvariantRule =
  | { kind: 'DenyFlow'; from: string; to: string }
  | { kind: 'DenyReach'; from: string; to: string }
  | { kind: 'RequireEncryption'; from: string; to: string }
  | { kind: 'DenyDataFlow'; data: string; to: string };

export type ArtifactDiPolicyRule =
  | { kind: 'DenyInject'; from: string; to: string }
  | { kind: 'DenyInjectReach'; from: string; to: string }
  | { kind: 'DenyLifetime'; from: 'singleton' | 'scoped' | 'transient'; to: 'singleton' | 'scoped' | 'transient' }
  | { kind: 'DenyLifetimeReach'; from: 'singleton' | 'scoped' | 'transient'; to: 'singleton' | 'scoped' | 'transient' }
  | { kind: 'DenyResolve'; service: string; from: string };

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
  reachPolicies: Array<{
    invariant: string;
    from: string;
    to: string;
  }>;
  // Nodes and components for context emission
  nodes: Array<{ name: string; type: string; trust?: string; protocol?: string; auth?: string }>;
  resources: Array<{ name: string; type: string; trust?: string; protocol?: string; auth?: string }>;
  // Enum declarations for context and agent use
  enums: Array<{ name: string; values: string[] }>;
  // Data type declarations for context emission
  dataTypes: Array<{ name: string; fields: Array<{ key: string; typeExpr: string }>; classification?: string; jurisdiction?: string }>;
  // State machine declarations (Z3-backed when extractor queries emit transition facts)
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
  permissionPolicies: ArchitectureArtifact['permissions'];
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
  componentMeta: Array<{
    component: string;
    role?: string;
    layer?: string;
  }>;
  componentNodes: Record<string, string>;
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
  // Dependency injection policies (Z3-backed when extractor emits definite DI facts)
  diPolicies: Array<{
    name: string;
    rules: ArtifactDiPolicyRule[];
  }>;
  dataPolicies: Array<{
    name: string;
    rules: Array<
      | { kind: 'DenyClassification'; classification: string; toTrust: string }
      | { kind: 'DenyJurisdiction'; jurisdiction: string; to: string }
    >;
  }>;
  trustPolicies: Array<{
    name: string;
    rules: Array<
      | { kind: 'RequireAuth'; fromTrust: string; toTrust: string }
      | { kind: 'DenyFlowWhenData'; fromTrust: string; toTrust: string; classification: string }
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
  const reachPolicies: ArchitectureArtifact['reachPolicies'] = [];
  const nodes: ArchitectureArtifact['nodes'] = [];
  const resources: ArchitectureArtifact['resources'] = [];
  const enums: ArchitectureArtifact['enums'] = [];
  const dataTypes: ArchitectureArtifact['dataTypes'] = [];
  const stateMachines: ArchitectureArtifact['stateMachines'] = [];
  const permissions: ArchitectureArtifact['permissions'] = [];
  const contracts: ArchitectureArtifact['contracts'] = [];
  const componentContracts: ArchitectureArtifact['componentContracts'] = [];
  const componentData: ArchitectureArtifact['componentData'] = [];
  const componentMeta: ArchitectureArtifact['componentMeta'] = [];
  const componentNodes: Record<string, string> = {};
  const plugins: string[] = [];
  const repos: ArchitectureArtifact['repos'] = [];
  const componentRepos: Record<string, string> = {};
  const workflowPolicies: ArchitectureArtifact['workflowPolicies'] = [];
  const diPolicies: ArchitectureArtifact['diPolicies'] = [];
  const dataPolicies: ArchitectureArtifact['dataPolicies'] = [];
  const trustPolicies: ArchitectureArtifact['trustPolicies'] = [];
  const changePolicies: ArchitectureArtifact['changePolicies'] = [];

  for (const decl of program.declarations) {
    if (decl.kind === 'ComponentDecl') {
      mappings[decl.name] = decl.paths;
      componentNodes[decl.name] = decl.runsOn;
      if (decl.role || decl.layer) {
        componentMeta.push({
          component: decl.name,
          ...(decl.role ? { role: decl.role } : {}),
          ...(decl.layer ? { layer: decl.layer } : {}),
        });
      }
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
      const rules = expandInvariantRules(program)
        .filter(expanded => expanded.invariant === decl.name)
        .map<ArtifactInvariantRule>(({ rule }) => rule.kind === 'DenyDataFlow'
          ? ({ kind: rule.kind, data: rule.data, to: rule.to })
          : ({ kind: rule.kind, from: rule.from, to: rule.to }));
      invariants.push({ name: decl.name, rules });
      for (const rule of rules) {
        if (rule.kind === 'DenyReach') {
          reachPolicies.push({ invariant: decl.name, from: rule.from, to: rule.to });
        }
      }
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
    if (decl.kind === 'ResourceDecl') {
      const trust = decl.props.find(p => p.key === 'trust');
      const protocol = decl.props.find(p => p.key === 'protocol');
      const auth = decl.props.find(p => p.key === 'auth');
      resources.push({
        name: decl.name,
        type: decl.resourceType.kind === 'parameterized'
          ? `${decl.resourceType.name}(${decl.resourceType.param})`
          : decl.resourceType.name,
        trust: Array.isArray(trust?.value) ? trust!.value[0] : trust?.value,
        protocol: Array.isArray(protocol?.value) ? protocol!.value[0] : protocol?.value,
        auth: Array.isArray(auth?.value) ? auth!.value[0] : auth?.value,
      });
    }
    if (decl.kind === 'EnumDecl') {
      enums.push({ name: decl.name, values: decl.values });
    }
    if (decl.kind === 'DataDecl') {
      dataTypes.push({
        name: decl.name,
        fields: decl.fields.map(f => ({ key: f.key, typeExpr: f.typeExpr })),
        ...(decl.classification ? { classification: decl.classification } : {}),
        ...(decl.jurisdiction ? { jurisdiction: decl.jurisdiction } : {}),
      });
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
    if (decl.kind === 'DiPolicyDecl') {
      diPolicies.push({
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
    if (decl.kind === 'DataPolicyDecl') {
      dataPolicies.push({
        name: decl.name,
        rules: decl.rules.map(rule => ({ ...rule })),
      });
    }
    if (decl.kind === 'TrustPolicyDecl') {
      trustPolicies.push({
        name: decl.name,
        rules: decl.rules.map(rule => ({ ...rule })),
      });
    }
  }

  return {
    schemaVersion: 13,
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
        mechanism: 'Dataflow facts inferred from handled data and extracted reachability are asserted against SMT-LIB constraints.',
      },
      {
        declaration: 'invariant deny reach',
        level: 'formal_z3',
        mechanism: 'Transitive flow reachability facts extracted from code are asserted against SMT-LIB constraints.',
      },
      {
        declaration: 'data_policy',
        level: 'formal_z3',
        mechanism: 'Classified and jurisdictional data reachability facts are asserted against SMT-LIB constraints.',
      },
      {
        declaration: 'trust_policy',
        level: 'formal_z3',
        mechanism: 'Trust boundary facts are checked against extracted reachability, data classification, and declared auth metadata.',
      },
      {
        declaration: 'permission',
        level: 'formal_z3',
        mechanism: 'Extracted protected operations are checked for matching role evidence where extractors can prove authorization facts.',
      },
      {
        declaration: 'change_policy',
        level: 'formal_z3',
        mechanism: 'Touched-component facts are asserted against SMT-LIB implication rules.',
      },
      {
        declaration: 'di_policy',
        level: 'formal_z3',
        mechanism: 'Constructor-injection, lifetime, and service-locator facts are asserted against SMT-LIB constraints.',
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
        level: 'formal_z3',
        mechanism: 'Extracted transition facts are asserted against declared state-machine transition rules.',
      },
    ],
    constraints,
    mappings,
    invariants,
    reachPolicies,
    nodes,
    resources,
    enums,
    dataTypes,
    stateMachines,
    permissions,
    permissionPolicies: permissions,
    contracts,
    componentContracts,
    componentData,
    componentMeta,
    componentNodes,
    plugins,
    repos,
    componentRepos,
    workflowPolicies,
    diPolicies,
    dataPolicies,
    trustPolicies,
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
