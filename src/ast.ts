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
}

export interface ComponentDecl {
  kind: 'ComponentDecl';
  name: string;
  runsOn: string;   // references a NodeDecl name
  paths: string;    // glob pattern pointing at implementation files
  implements?: string[];  // contract names this component implements
  consumes?: string[];    // contract names this component consumes
}

export interface ServiceDecl {
  kind: 'ServiceDecl';
  name: string;
  props: Prop[];
}

export type InvariantRule =
  | { kind: 'DenyFlow'; from: string; to: string }
  | { kind: 'RequireEncryption'; from: string; to: string };

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

export interface ContractEndpoint {
  method: string;       // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string;         // e.g. "/api/products/{productId}/capture-sessions"
  returnType?: string;  // e.g. "CaptureSessionDto[]" (advisory)
}

export interface ContractDecl {
  kind: 'ContractDecl';
  name: string;
  endpoints: ContractEndpoint[];
}

export interface PluginDecl {
  kind: 'PluginDecl';
  packageName: string;  // npm package or executable name, e.g. "aglc-roslyn"
}

export type Declaration =
  | NodeDecl
  | DataDecl
  | EnumDecl
  | ComponentDecl
  | ServiceDecl
  | InvariantDecl
  | StateMachineDecl
  | PermissionDecl
  | ContractDecl
  | PluginDecl
  | TestDecl;

export interface Program {
  declarations: Declaration[];
}
