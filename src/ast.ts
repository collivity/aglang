// AST node type definitions for aglang

export type NodeType =
  | { kind: 'simple'; name: string }
  | { kind: 'parameterized'; name: string; param: string };

export interface Prop {
  key: string;
  value: string | string[];
}

export interface NodeDecl {
  kind: 'NodeDecl';
  name: string;
  nodeType: NodeType;
  props: Prop[];
}

export interface ResourceDecl {
  kind: 'ResourceDecl';
  name: string;
  resourceType: NodeType;
  props: Prop[];
}

export interface Field {
  key: string;
  typeExpr: string; // e.g. "S2CellID", "PointCloud | GaussianSplat", "meters(f32)"
}

export interface EnumDecl {
  kind: 'EnumDecl';
  name: string;
  values: string[];
}

export interface DataDecl {
  kind: 'DataDecl';
  name: string;
  fields: Field[];
  classification?: string;
  jurisdiction?: string;
}

export interface ComponentDecl {
  kind: 'ComponentDecl';
  name: string;
  runsOn: string;   // references a NodeDecl name
  paths: string;    // glob pattern pointing at implementation files
  role?: string;     // controlled architecture role, e.g. presentation/application/domain
  layer?: string;    // free-form architectural layer name
  repo?: string;    // optional: references a RepoDecl name
  implements?: string[];  // contract names this component implements
  consumes?: string[];    // contract names this component consumes
  handles?: string[];     // data type names handled/carried by this component
}

export interface ServiceDecl {
  kind: 'ServiceDecl';
  name: string;
  props: Prop[];
}

export type InvariantEndpoint =
  | { kind: 'entity'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'layer'; name: string }
  | { kind: 'resource'; name: string };

export type InvariantRule =
  | { kind: 'DenyFlow'; from: string; to: string; fromEndpoint?: InvariantEndpoint; toEndpoint?: InvariantEndpoint }
  | { kind: 'DenyReach'; from: string; to: string; fromEndpoint?: InvariantEndpoint; toEndpoint?: InvariantEndpoint }
  | { kind: 'RequireEncryption'; from: string; to: string; fromEndpoint?: InvariantEndpoint; toEndpoint?: InvariantEndpoint }
  | { kind: 'DenyDataFlow'; data: string; to: string };

export interface InvariantDecl {
  kind: 'InvariantDecl';
  name: string;
  rules: InvariantRule[];
}

export type Quantifier = 'no' | 'every' | 'some';

export interface Selector {
  subject: string;          // e.g. "data", "node", "service"
  where?: { key: string; op: string; value: string };
}

export interface QueryChain {
  quantifier: Quantifier;
  selector: Selector;
  methods: Array<{ name: string; arg: QueryChain }>;
  without?: string;
}

export interface AssertStmt {
  chain: QueryChain;
}

export interface TestDecl {
  kind: 'TestDecl';
  name: string;
  asserts: AssertStmt[];
}

export interface TransitionRule {
  kind: 'allow' | 'deny';
  from: string;  // enum value or '*' (any)
  to: string;    // enum value or '*' (any)
}

export interface StateMachineDecl {
  kind: 'StateMachineDecl';
  name: string;
  onType: string;    // references a DataDecl name, e.g. "Order"
  onField: string;   // field of that data type, e.g. "status"
  transitions: TransitionRule[];
}

export interface PermissionRule {
  kind: 'allow' | 'deny';
  roleEnum: string;     // EnumDecl name, e.g. "UserRole", or '*'
  roleValue: string;    // enum value, e.g. "Admin", or '*'
  operations: string[]; // e.g. ["read","write"] or ["*"]
  whenField?: string;   // optional field constraint, e.g. "owner_id"
}

export interface PermissionDecl {
  kind: 'PermissionDecl';
  name: string;
  onType: string;  // references a DataDecl or ComponentDecl name
  rules: PermissionRule[];
}

export type ContractEndpoint =
  | { kind: 'http'; method: string; path: string; returnType?: string }
  | { kind: 'graphql'; operation: 'query' | 'mutation' | 'subscription'; operationName: string; inputTypes?: string[]; returnType?: string }
  | { kind: 'grpc'; rpcName: string; inputMessage: string; outputMessage: string }
  | { kind: 'queue_publish'; topic: string }
  | { kind: 'queue_subscribe'; topic: string };

export interface ContractDecl {
  kind: 'ContractDecl';
  name: string;
  endpoints: ContractEndpoint[];
}

export interface RepoDecl {
  kind: 'RepoDecl';
  name: string;      // friendly alias, e.g. BackendAPI
  url: string;       // git remote URL, e.g. github.com/my-org/backend-api
  branch?: string;   // default branch, e.g. main
}

export interface PluginDecl {
  kind: 'PluginDecl';
  packageName: string;  // npm package or executable name, e.g. "aglc-roslyn"
}

export type WorkflowPolicyAction = 'publish' | 'deploy' | 'release';
export type WorkflowPolicyEffect = 'allow' | 'deny';
export type WorkflowCondition =
  | { kind: 'branch'; value: string }
  | { kind: 'tag'; value: string }
  | { kind: 'pull_request' };

export type WorkflowPolicyRule =
  | {
      kind: 'ActionRule';
      effect: WorkflowPolicyEffect;
      action: WorkflowPolicyAction;
      workflow: string;
      target: string;
      when?: WorkflowCondition;
    }
  | {
      kind: 'PermissionRule';
      effect: WorkflowPolicyEffect;
      workflow: string;
      permission: string;
      access: string;
      when?: WorkflowCondition;
    }
  | {
      kind: 'BeforeRule';
      workflow: string;
      before: string;
      after: string;
    };

export interface WorkflowPolicyDecl {
  kind: 'WorkflowPolicyDecl';
  name: string;
  rules: WorkflowPolicyRule[];
}

export type DiLifetime = 'singleton' | 'scoped' | 'transient';

export type DiPolicyRule =
  | { kind: 'DenyInject'; from: string; to: string }
  | { kind: 'DenyInjectReach'; from: string; to: string }
  | { kind: 'DenyLifetime'; from: DiLifetime; to: DiLifetime }
  | { kind: 'DenyLifetimeReach'; from: DiLifetime; to: DiLifetime }
  | { kind: 'DenyResolve'; service: string; from: string };

export interface DiPolicyDecl {
  kind: 'DiPolicyDecl';
  name: string;
  rules: DiPolicyRule[];
}

export interface ChangePolicyRule {
  kind: 'RequireTouched';
  required: string;
  trigger: string;
}

export interface ChangePolicyDecl {
  kind: 'ChangePolicyDecl';
  name: string;
  rules: ChangePolicyRule[];
}

export type DataPolicyRule =
  | { kind: 'DenyClassification'; classification: string; toTrust: string }
  | { kind: 'DenyJurisdiction'; jurisdiction: string; to: string };

export interface DataPolicyDecl {
  kind: 'DataPolicyDecl';
  name: string;
  rules: DataPolicyRule[];
}

export type TrustPolicyRule =
  | { kind: 'RequireAuth'; fromTrust: string; toTrust: string }
  | { kind: 'DenyFlowWhenData'; fromTrust: string; toTrust: string; classification: string };

export interface TrustPolicyDecl {
  kind: 'TrustPolicyDecl';
  name: string;
  rules: TrustPolicyRule[];
}

export type Declaration =
  | NodeDecl
  | ResourceDecl
  | DataDecl
  | EnumDecl
  | ComponentDecl
  | ServiceDecl
  | InvariantDecl
  | StateMachineDecl
  | PermissionDecl
  | ContractDecl
  | PluginDecl
  | WorkflowPolicyDecl
  | DiPolicyDecl
  | ChangePolicyDecl
  | DataPolicyDecl
  | TrustPolicyDecl
  | RepoDecl
  | TestDecl;

export interface Program {
  declarations: Declaration[];
}
