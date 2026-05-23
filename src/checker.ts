// Type checker — validates the AST against the stdlib ontology (multi-pass)
import type { Program, NodeDecl, ComponentDecl, InvariantDecl, EnumDecl, DataDecl, StateMachineDecl, PermissionDecl, ContractDecl, WorkflowPolicyDecl, ChangePolicyDecl, ResourceDecl, InvariantEndpoint, DiPolicyDecl, DataPolicyDecl, TrustPolicyDecl } from './ast.ts';
import { VALID_NODE_TYPES, VALID_RESOURCE_TYPES, VALID_COMPONENT_ROLES, VALID_TRUST_VALUES, VALID_CONNECTIVITY_VALUES, VALID_PROTOCOL_VALUES, VALID_AUTH_VALUES } from './stdlib/topology.ts';

export interface CheckError {
  message: string;
}

// Primitive types allowed in data block fields
const PRIMITIVE_TYPES = new Set([
  'UUID', 'String', 'Int', 'Float', 'Bool', 'Money', 'Timestamp', 'DateTime', 'Bytes', 'Json',
]);

// Validate a type expression string against known types
// Supports: UUID, String, List<X>, Map<K,V>, Optional<X>, user-defined enums/data
function validateTypeExpr(
  expr: string,
  knownTypes: Set<string>,
  context: string,
  errors: CheckError[],
): void {
  // Normalize spaces around angle brackets (parser joins tokens with spaces)
  const trimmed = expr.trim().replace(/\s*<\s*/g, '<').replace(/\s*>\s*/g, '>').replace(/\s*,\s*/g, ',');
  // Generic containers
  const genericMatch = trimmed.match(/^(List|Map|Optional)<(.+)>$/);
  if (genericMatch) {
    const [, container, inner] = genericMatch;
    if (container === 'Map') {
      const comma = inner!.indexOf(',');
      if (comma === -1) {
        errors.push({ message: `${context}: Map<K,V> requires two type args, got '${trimmed}'` });
        return;
      }
      validateTypeExpr(inner!.slice(0, comma).trim(), knownTypes, context, errors);
      validateTypeExpr(inner!.slice(comma + 1).trim(), knownTypes, context, errors);
    } else {
      validateTypeExpr(inner!, knownTypes, context, errors);
    }
    return;
  }
  // Union types: TypeA | TypeB
  if (trimmed.includes('|')) {
    for (const part of trimmed.split('|')) {
      validateTypeExpr(part.trim(), knownTypes, context, errors);
    }
    return;
  }
  if (!PRIMITIVE_TYPES.has(trimmed) && !knownTypes.has(trimmed)) {
    errors.push({ message: `${context}: unknown type '${trimmed}'. Use a primitive (${[...PRIMITIVE_TYPES].join(', ')}) or a declared enum/data name.` });
  }
}

export function check(program: Program): CheckError[] {
  const errors: CheckError[] = [];

  // Pass 1: collect all declared names (nodes, components, enums, data types, state machines)
  const declaredNodes = new Map<string, NodeDecl>();
  const declaredResources = new Map<string, ResourceDecl>();
  const declaredComponents = new Map<string, ComponentDecl>();
  const declaredInvariants = new Map<string, InvariantDecl>();
  const declaredEnums = new Map<string, EnumDecl>();
  const declaredData = new Map<string, DataDecl>();
  const declaredMachines = new Map<string, StateMachineDecl>();   // key = "Type.field"
  const declaredPermissions = new Map<string, PermissionDecl>();
  const declaredContracts = new Map<string, ContractDecl>();
  const declaredWorkflowPolicies = new Map<string, WorkflowPolicyDecl>();
  const declaredDiPolicies = new Map<string, DiPolicyDecl>();
  const declaredChangePolicies = new Map<string, ChangePolicyDecl>();
  const declaredDataPolicies = new Map<string, DataPolicyDecl>();
  const declaredTrustPolicies = new Map<string, TrustPolicyDecl>();

  for (const decl of program.declarations) {
    switch (decl.kind) {
      case 'NodeDecl':
        if (declaredNodes.has(decl.name)) errors.push({ message: `Duplicate node name '${decl.name}'` });
        else declaredNodes.set(decl.name, decl);
        break;
      case 'ResourceDecl':
        if (declaredResources.has(decl.name)) errors.push({ message: `Duplicate resource name '${decl.name}'` });
        else declaredResources.set(decl.name, decl);
        break;
      case 'ComponentDecl':
        if (declaredComponents.has(decl.name)) errors.push({ message: `Duplicate component name '${decl.name}'` });
        else declaredComponents.set(decl.name, decl);
        break;
      case 'InvariantDecl':
        if (declaredInvariants.has(decl.name)) errors.push({ message: `Duplicate invariant name '${decl.name}'` });
        else declaredInvariants.set(decl.name, decl);
        break;
      case 'EnumDecl':
        if (declaredEnums.has(decl.name)) errors.push({ message: `Duplicate enum name '${decl.name}'` });
        else declaredEnums.set(decl.name, decl);
        break;
      case 'DataDecl':
        if (declaredData.has(decl.name)) errors.push({ message: `Duplicate data type name '${decl.name}'` });
        else declaredData.set(decl.name, decl);
        break;
      case 'StateMachineDecl':
        if (declaredMachines.has(decl.name)) errors.push({ message: `Duplicate state machine name '${decl.name}'` });
        else declaredMachines.set(decl.name, decl);
        break;
      case 'PermissionDecl':
        if (declaredPermissions.has(decl.name)) errors.push({ message: `Duplicate permission name '${decl.name}'` });
        else declaredPermissions.set(decl.name, decl);
        break;
      case 'ContractDecl':
        if (declaredContracts.has(decl.name)) errors.push({ message: `Duplicate contract name '${decl.name}'` });
        else declaredContracts.set(decl.name, decl);
        break;
      case 'PluginDecl':
        // Plugin package names are free-form strings — no duplication check needed (same plugin can be re-declared in merged imports)
        break;
      case 'WorkflowPolicyDecl':
        if (declaredWorkflowPolicies.has(decl.name)) errors.push({ message: `Duplicate workflow policy name '${decl.name}'` });
        else declaredWorkflowPolicies.set(decl.name, decl);
        break;
      case 'DiPolicyDecl':
        if (declaredDiPolicies.has(decl.name)) errors.push({ message: `Duplicate di_policy name '${decl.name}'` });
        else declaredDiPolicies.set(decl.name, decl);
        break;
      case 'ChangePolicyDecl':
        if (declaredChangePolicies.has(decl.name)) errors.push({ message: `Duplicate change policy name '${decl.name}'` });
        else declaredChangePolicies.set(decl.name, decl);
        break;
      case 'DataPolicyDecl':
        if (declaredDataPolicies.has(decl.name)) errors.push({ message: `Duplicate data_policy name '${decl.name}'` });
        else declaredDataPolicies.set(decl.name, decl);
        break;
      case 'TrustPolicyDecl':
        if (declaredTrustPolicies.has(decl.name)) errors.push({ message: `Duplicate trust_policy name '${decl.name}'` });
        else declaredTrustPolicies.set(decl.name, decl);
        break;
      case 'RepoDecl':
        // Collect declared repos for cross-reference validation below
        break;
    }
  }

  // Collect declared repo names for component reference validation
  const declaredRepos = new Set<string>(
    program.declarations.filter(d => d.kind === 'RepoDecl').map(d => (d as import('./ast.ts').RepoDecl).name)
  );

  // All user-defined type names (enums + data structs)
  const userTypes = new Set<string>([...declaredEnums.keys(), ...declaredData.keys()]);
  // All valid flow endpoints (components + nodes)
  const validFlowEndpoints = new Set<string>([...declaredNodes.keys(), ...declaredResources.keys(), ...declaredComponents.keys()]);
  const declaredRoles = new Set(
    [...declaredComponents.values()]
      .map(c => c.role)
      .filter((role): role is string => Boolean(role)),
  );
  const declaredLayers = new Set(
    [...declaredComponents.values()]
      .map(c => c.layer)
      .filter((layer): layer is string => Boolean(layer)),
  );
  const declaredClassifications = new Set(
    [...declaredData.values()]
      .map(d => d.classification)
      .filter((value): value is string => Boolean(value)),
  );
  const declaredJurisdictions = new Set(
    [...declaredData.values()]
      .map(d => d.jurisdiction)
      .filter((value): value is string => Boolean(value)),
  );

  function resourceMatches(name: string): boolean {
    if (declaredResources.has(name)) return true;
    return [...declaredResources.values()].some(r => r.resourceType.name === name);
  }

  function validateInvariantEndpoint(invName: string, endpoint: InvariantEndpoint | undefined, fallback: string, label: string): void {
    if (!endpoint || endpoint.kind === 'entity') {
      if (!validFlowEndpoints.has(fallback)) {
        errors.push({ message: `Invariant '${invName}': unknown ${label} '${fallback}'` });
      }
      return;
    }
    if (endpoint.kind === 'role') {
      if (!VALID_COMPONENT_ROLES.has(endpoint.name)) {
        errors.push({ message: `Invariant '${invName}': unknown role selector '${endpoint.name}'. Valid roles: ${[...VALID_COMPONENT_ROLES].join(', ')}` });
      } else if (!declaredRoles.has(endpoint.name)) {
        errors.push({ message: `Invariant '${invName}': role selector '${endpoint.name}' matches no components` });
      }
    }
    if (endpoint.kind === 'layer' && !declaredLayers.has(endpoint.name)) {
      errors.push({ message: `Invariant '${invName}': layer selector '${endpoint.name}' matches no components` });
    }
    if (endpoint.kind === 'resource') {
      if (!VALID_RESOURCE_TYPES.has(endpoint.name) && !declaredResources.has(endpoint.name)) {
        errors.push({ message: `Invariant '${invName}': unknown resource selector '${endpoint.name}'. Use a resource name or valid resource type: ${[...VALID_RESOURCE_TYPES].join(', ')}` });
      } else if (!resourceMatches(endpoint.name)) {
        errors.push({ message: `Invariant '${invName}': resource selector '${endpoint.name}' matches no resources` });
      }
    }
  }

  // Pass 2: validate each declaration
  for (const decl of program.declarations) {
    if (decl.kind === 'NodeDecl') {
      const typeName = decl.nodeType.name;
      if (!VALID_NODE_TYPES.has(typeName)) {
        errors.push({ message: `Unknown node type '${typeName}' in node '${decl.name}'. Valid types: ${[...VALID_NODE_TYPES].join(', ')}` });
      }
      for (const prop of decl.props) {
        const val = Array.isArray(prop.value) ? prop.value[0] : prop.value;
        if (prop.key === 'trust' && !VALID_TRUST_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid trust value '${val}' in node '${decl.name}'. Valid: ${[...VALID_TRUST_VALUES].join(', ')}` });
        }
        if (prop.key === 'connectivity' && !VALID_CONNECTIVITY_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid connectivity value '${val}' in node '${decl.name}'. Valid: ${[...VALID_CONNECTIVITY_VALUES].join(', ')}` });
        }
        if (prop.key === 'protocol' && !VALID_PROTOCOL_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid protocol value '${val}' in node '${decl.name}'. Valid: ${[...VALID_PROTOCOL_VALUES].join(', ')}` });
        }
        if (prop.key === 'auth' && !VALID_AUTH_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid auth value '${val}' in node '${decl.name}'. Valid: ${[...VALID_AUTH_VALUES].join(', ')}` });
        }
      }
    }

    if (decl.kind === 'ResourceDecl') {
      const typeName = decl.resourceType.name;
      if (!VALID_RESOURCE_TYPES.has(typeName)) {
        errors.push({ message: `Unknown resource type '${typeName}' in resource '${decl.name}'. Valid types: ${[...VALID_RESOURCE_TYPES].join(', ')}` });
      }
      for (const prop of decl.props) {
        const val = Array.isArray(prop.value) ? prop.value[0] : prop.value;
        if (prop.key === 'trust' && !VALID_TRUST_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid trust value '${val}' in resource '${decl.name}'. Valid: ${[...VALID_TRUST_VALUES].join(', ')}` });
        }
        if (prop.key === 'protocol' && !VALID_PROTOCOL_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid protocol value '${val}' in resource '${decl.name}'. Valid: ${[...VALID_PROTOCOL_VALUES].join(', ')}` });
        }
        if (prop.key === 'auth' && !VALID_AUTH_VALUES.has(val ?? '')) {
          errors.push({ message: `Invalid auth value '${val}' in resource '${decl.name}'. Valid: ${[...VALID_AUTH_VALUES].join(', ')}` });
        }
      }
    }

    if (decl.kind === 'EnumDecl') {
      if (decl.values.length === 0) {
        errors.push({ message: `Enum '${decl.name}' has no values` });
      }
      const seen = new Set<string>();
      for (const v of decl.values) {
        if (seen.has(v)) {
          errors.push({ message: `Enum '${decl.name}' has duplicate value '${v}'` });
        }
        seen.add(v);
      }
    }

    if (decl.kind === 'DataDecl') {
      if (decl.classification && !/^[A-Za-z_][\w]*$/.test(decl.classification)) {
        errors.push({ message: `data '${decl.name}': invalid classification '${decl.classification}'` });
      }
      if (decl.jurisdiction && !/^[A-Za-z_][\w]*$/.test(decl.jurisdiction)) {
        errors.push({ message: `data '${decl.name}': invalid jurisdiction '${decl.jurisdiction}'` });
      }
      for (const field of decl.fields) {
        validateTypeExpr(field.typeExpr, userTypes, `data '${decl.name}' field '${field.key}'`, errors);
      }
    }

    if (decl.kind === 'ComponentDecl') {
      if (!declaredNodes.has(decl.runsOn)) {
        errors.push({ message: `Component '${decl.name}' references unknown node '${decl.runsOn}'` });
      }
      if (decl.repo && !declaredRepos.has(decl.repo)) {
        errors.push({ message: `Component '${decl.name}' references undeclared repo '${decl.repo}'. Declare it with: repo ${decl.repo} "github.com/your-org/your-repo"` });
      }
      if (decl.role && !VALID_COMPONENT_ROLES.has(decl.role)) {
        errors.push({ message: `Component '${decl.name}' has invalid role '${decl.role}'. Valid roles: ${[...VALID_COMPONENT_ROLES].join(', ')}` });
      }
      for (const contractName of (decl.implements ?? [])) {
        if (!declaredContracts.has(contractName)) {
          errors.push({ message: `Component '${decl.name}' implements unknown contract '${contractName}'` });
        }
      }
      for (const contractName of (decl.consumes ?? [])) {
        if (!declaredContracts.has(contractName)) {
          errors.push({ message: `Component '${decl.name}' consumes unknown contract '${contractName}'` });
        }
      }
      for (const dataName of (decl.handles ?? [])) {
        if (!declaredData.has(dataName)) {
          errors.push({ message: `Component '${decl.name}' handles unknown data type '${dataName}'` });
        }
      }
    }

    if (decl.kind === 'InvariantDecl') {
      for (const rule of decl.rules) {
        if (rule.kind === 'DenyDataFlow') {
          if (!declaredData.has(rule.data)) {
            errors.push({ message: `Invariant '${decl.name}': unknown data type '${rule.data}'` });
          }
          if (!validFlowEndpoints.has(rule.to)) {
            errors.push({ message: `Invariant '${decl.name}': unknown dataflow target '${rule.to}'` });
          }
        } else {
          validateInvariantEndpoint(decl.name, rule.fromEndpoint, rule.from, 'source');
          validateInvariantEndpoint(decl.name, rule.toEndpoint, rule.to, 'target');
        }
      }
    }

    if (decl.kind === 'ServiceDecl') {
      const hasFailureMode = decl.props.some(p => p.key === 'failure_mode');
      const hasRunsOn = decl.props.some(p => p.key === 'runs_on');
      if (!hasFailureMode) {
        errors.push({ message: `Service '${decl.name}' missing required 'failure_mode' property` });
      }
      if (!hasRunsOn) {
        errors.push({ message: `Service '${decl.name}' missing required 'runs_on' property` });
      }
    }

    if (decl.kind === 'StateMachineDecl') {
      const dataDecl = declaredData.get(decl.onType);
      if (!dataDecl) {
        errors.push({ message: `machine '${decl.name}': unknown data type '${decl.onType}'` });
      } else {
        const field = dataDecl.fields.find(f => f.key === decl.onField);
        if (!field) {
          errors.push({ message: `machine '${decl.name}': '${decl.onType}' has no field '${decl.onField}'` });
        } else {
          // Field must resolve to an enum (strip Optional<> wrapper)
          const rawType = field.typeExpr.replace(/^Optional<(.+)>$/, '$1').trim();
          const enumDecl = declaredEnums.get(rawType);
          if (!enumDecl) {
            errors.push({ message: `machine '${decl.name}': field '${decl.onField}' has type '${field.typeExpr}' which is not an enum — state machines require an enum-typed field` });
          } else {
            // Validate all non-wildcard transition values are valid enum members
            const validValues = new Set(enumDecl.values);
            for (const t of decl.transitions) {
              if (t.from !== '*' && !validValues.has(t.from)) {
                errors.push({ message: `machine '${decl.name}': '${t.from}' is not a value of enum '${rawType}'` });
              }
              if (t.to !== '*' && !validValues.has(t.to)) {
                errors.push({ message: `machine '${decl.name}': '${t.to}' is not a value of enum '${rawType}'` });
              }
            }
          }
        }
      }
    }

    if (decl.kind === 'PermissionDecl') {
      // onType must be a known data type or component
      const knownTargets = new Set([...declaredData.keys(), ...declaredComponents.keys()]);
      if (!knownTargets.has(decl.onType)) {
        errors.push({ message: `permission '${decl.name}': unknown target type '${decl.onType}' — must be a data type or component name` });
      }
      for (const rule of decl.rules) {
        if (rule.roleEnum !== '*') {
          const enumDecl = declaredEnums.get(rule.roleEnum);
          if (!enumDecl) {
            errors.push({ message: `permission '${decl.name}': '${rule.roleEnum}' is not a declared enum` });
          } else if (rule.roleValue !== '*' && !enumDecl.values.includes(rule.roleValue)) {
            errors.push({ message: `permission '${decl.name}': '${rule.roleValue}' is not a value of enum '${rule.roleEnum}'` });
          }
        }
        if (rule.whenField) {
          const dataDecl = declaredData.get(decl.onType);
          if (dataDecl && !dataDecl.fields.find(f => f.key === rule.whenField)) {
            errors.push({ message: `permission '${decl.name}': 'when ${rule.whenField}' — field '${rule.whenField}' does not exist on '${decl.onType}'` });
          }
        }
      }
    }

    if (decl.kind === 'WorkflowPolicyDecl') {
      const allowedActions = new Set(['publish', 'deploy', 'release']);
      for (const rule of decl.rules) {
        if (rule.kind === 'ActionRule') {
          if (!allowedActions.has(rule.action)) {
            errors.push({ message: `workflow_policy '${decl.name}': unknown action '${rule.action}'` });
          }
          if (rule.workflow !== '*' && !declaredComponents.has(rule.workflow)) {
            errors.push({ message: `workflow_policy '${decl.name}': unknown workflow component '${rule.workflow}'` });
          }
          if (!declaredNodes.has(rule.target)) {
            errors.push({ message: `workflow_policy '${decl.name}': unknown CI/CD target node '${rule.target}'` });
          }
        }
        if (rule.kind === 'PermissionRule') {
          if (rule.workflow !== '*' && !declaredComponents.has(rule.workflow)) {
            errors.push({ message: `workflow_policy '${decl.name}': unknown workflow component '${rule.workflow}'` });
          }
          if (!['read', 'write', 'none'].includes(rule.access)) {
            errors.push({ message: `workflow_policy '${decl.name}': invalid permission access '${rule.access}' (expected read, write, or none)` });
          }
        }
        if (rule.kind === 'BeforeRule' && !declaredComponents.has(rule.workflow)) {
          errors.push({ message: `workflow_policy '${decl.name}': unknown workflow component '${rule.workflow}'` });
        }
      }
    }

    if (decl.kind === 'DiPolicyDecl') {
      for (const rule of decl.rules) {
        if (rule.kind === 'DenyInject') {
          if (!declaredComponents.has(rule.from)) {
            errors.push({ message: `di_policy '${decl.name}': unknown source component '${rule.from}'` });
          }
          if (!declaredComponents.has(rule.to)) {
            errors.push({ message: `di_policy '${decl.name}': unknown target component '${rule.to}'` });
          }
        }
        if (rule.kind === 'DenyInjectReach') {
          if (!declaredComponents.has(rule.from)) {
            errors.push({ message: `di_policy '${decl.name}': unknown source component '${rule.from}'` });
          }
          if (!declaredComponents.has(rule.to)) {
            errors.push({ message: `di_policy '${decl.name}': unknown target component '${rule.to}'` });
          }
        }
        if (rule.kind === 'DenyResolve' && !declaredComponents.has(rule.from)) {
          errors.push({ message: `di_policy '${decl.name}': unknown source component '${rule.from}'` });
        }
      }
    }

    if (decl.kind === 'DataPolicyDecl') {
      for (const rule of decl.rules) {
        if (rule.kind === 'DenyClassification') {
          if (!declaredClassifications.has(rule.classification)) {
            errors.push({ message: `data_policy '${decl.name}': unknown classification '${rule.classification}'` });
          }
          if (!VALID_TRUST_VALUES.has(rule.toTrust)) {
            errors.push({ message: `data_policy '${decl.name}': invalid target trust '${rule.toTrust}'. Valid: ${[...VALID_TRUST_VALUES].join(', ')}` });
          }
        }
        if (rule.kind === 'DenyJurisdiction') {
          if (!declaredJurisdictions.has(rule.jurisdiction)) {
            errors.push({ message: `data_policy '${decl.name}': unknown jurisdiction '${rule.jurisdiction}'` });
          }
          if (!validFlowEndpoints.has(rule.to)) {
            errors.push({ message: `data_policy '${decl.name}': unknown target '${rule.to}'` });
          }
        }
      }
    }

    if (decl.kind === 'TrustPolicyDecl') {
      for (const rule of decl.rules) {
        if (!VALID_TRUST_VALUES.has(rule.fromTrust)) {
          errors.push({ message: `trust_policy '${decl.name}': invalid source trust '${rule.fromTrust}'. Valid: ${[...VALID_TRUST_VALUES].join(', ')}` });
        }
        if (!VALID_TRUST_VALUES.has(rule.toTrust)) {
          errors.push({ message: `trust_policy '${decl.name}': invalid target trust '${rule.toTrust}'. Valid: ${[...VALID_TRUST_VALUES].join(', ')}` });
        }
        if (rule.kind === 'DenyFlowWhenData' && !declaredClassifications.has(rule.classification)) {
          errors.push({ message: `trust_policy '${decl.name}': unknown classification '${rule.classification}'` });
        }
      }
    }

    if (decl.kind === 'ChangePolicyDecl') {
      for (const rule of decl.rules) {
        if (!declaredComponents.has(rule.required)) {
          errors.push({ message: `change_policy '${decl.name}': unknown required component '${rule.required}'` });
        }
        if (!declaredComponents.has(rule.trigger)) {
          errors.push({ message: `change_policy '${decl.name}': unknown trigger component '${rule.trigger}'` });
        }
      }
    }
  }

  return errors;
}
