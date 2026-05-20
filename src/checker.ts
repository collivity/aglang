// Type checker — validates the AST against the stdlib ontology (multi-pass)
import type { Program, NodeDecl, ComponentDecl, InvariantDecl, EnumDecl, DataDecl, StateMachineDecl, PermissionDecl, ContractDecl, WorkflowPolicyDecl, ChangePolicyDecl } from './ast.ts';
import { VALID_NODE_TYPES, VALID_TRUST_VALUES, VALID_CONNECTIVITY_VALUES, VALID_PROTOCOL_VALUES, VALID_AUTH_VALUES } from './stdlib/topology.ts';

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
  const declaredComponents = new Map<string, ComponentDecl>();
  const declaredInvariants = new Map<string, InvariantDecl>();
  const declaredEnums = new Map<string, EnumDecl>();
  const declaredData = new Map<string, DataDecl>();
  const declaredMachines = new Map<string, StateMachineDecl>();   // key = "Type.field"
  const declaredPermissions = new Map<string, PermissionDecl>();
  const declaredContracts = new Map<string, ContractDecl>();
  const declaredWorkflowPolicies = new Map<string, WorkflowPolicyDecl>();
  const declaredChangePolicies = new Map<string, ChangePolicyDecl>();

  for (const decl of program.declarations) {
    switch (decl.kind) {
      case 'NodeDecl':
        if (declaredNodes.has(decl.name)) errors.push({ message: `Duplicate node name '${decl.name}'` });
        else declaredNodes.set(decl.name, decl);
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
      case 'ChangePolicyDecl':
        if (declaredChangePolicies.has(decl.name)) errors.push({ message: `Duplicate change policy name '${decl.name}'` });
        else declaredChangePolicies.set(decl.name, decl);
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
  const validFlowEndpoints = new Set<string>([...declaredNodes.keys(), ...declaredComponents.keys()]);

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
    }

    if (decl.kind === 'InvariantDecl') {
      for (const rule of decl.rules) {
        if (!validFlowEndpoints.has(rule.from)) {
          errors.push({ message: `Invariant '${decl.name}': unknown source '${rule.from}'` });
        }
        if (!validFlowEndpoints.has(rule.to)) {
          errors.push({ message: `Invariant '${decl.name}': unknown target '${rule.to}'` });
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
