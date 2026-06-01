// SMT-LIB 2.6 translator — converts checked AST to formula strings
import type { Program, NodeDecl, ComponentDecl, InvariantDecl, EnumDecl, DataDecl, ResourceDecl, DiPolicyDecl, DataPolicyDecl, TrustPolicyDecl, PermissionDecl, StateMachineDecl, TransitionRule, ValuePolicyDecl, OperationPolicyDecl, EventPolicyDecl, ValueExpression, PolicyValue } from '../ast.ts';
import { BASE_SMT_DECLARATIONS } from '../stdlib/topology.ts';
import { expandInvariantRules } from '../invariant-selectors.ts';

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function translate(program: Program): string[] {
  const stmts: string[] = [...BASE_SMT_DECLARATIONS, ''];
  const declaredOperations = new Set<string>();
  const declaredInterfaces = new Set<string>();

  const nodes: NodeDecl[] = [];
  const resources: ResourceDecl[] = [];
  const components: ComponentDecl[] = [];
  const invariants: InvariantDecl[] = [];
  const diPolicies: DiPolicyDecl[] = [];
  const dataPolicies: DataPolicyDecl[] = [];
  const trustPolicies: TrustPolicyDecl[] = [];
  const permissions: PermissionDecl[] = [];
  const stateMachines: StateMachineDecl[] = [];
  const valuePolicies: ValuePolicyDecl[] = [];
  const operationPolicies: OperationPolicyDecl[] = [];
  const eventPolicies: EventPolicyDecl[] = [];
  const enums: EnumDecl[] = [];
  const dataTypes: DataDecl[] = [];

  for (const d of program.declarations) {
    if (d.kind === 'NodeDecl') nodes.push(d);
    else if (d.kind === 'ResourceDecl') resources.push(d);
    else if (d.kind === 'ComponentDecl') components.push(d);
    else if (d.kind === 'InvariantDecl') invariants.push(d);
    else if (d.kind === 'DiPolicyDecl') diPolicies.push(d);
    else if (d.kind === 'DataPolicyDecl') dataPolicies.push(d);
    else if (d.kind === 'TrustPolicyDecl') trustPolicies.push(d);
    else if (d.kind === 'PermissionDecl') permissions.push(d);
    else if (d.kind === 'StateMachineDecl') stateMachines.push(d);
    else if (d.kind === 'ValuePolicyDecl') valuePolicies.push(d);
    else if (d.kind === 'OperationPolicyDecl') operationPolicies.push(d);
    else if (d.kind === 'EventPolicyDecl') eventPolicies.push(d);
    else if (d.kind === 'EnumDecl') enums.push(d);
    else if (d.kind === 'DataDecl') dataTypes.push(d);
  }

  // Enum datatypes — constructors are namespaced to avoid collisions
  // e.g. enum OrderStatus { Pending | Shipped } =>
  //   (declare-datatype OrderStatus ((OrderStatus__Pending) (OrderStatus__Shipped)))
  if (enums.length > 0) {
    stmts.push('; === enum declarations ===');
    for (const e of enums) {
      const ctors = e.values.map(v => `(${smtId(e.name)}__${smtId(v)})`).join(' ');
      stmts.push(`(declare-datatype ${smtId(e.name)} (${ctors}))`);
    }
    stmts.push('');
  }

  // Data types as constants over DataType — structural details are not encoded in SMT.
  if (dataTypes.length > 0) {
    stmts.push('; === data type declarations ===');
    const classifications = new Set<string>();
    const jurisdictions = new Set<string>();
    for (const d of dataTypes) {
      stmts.push(`(declare-const ${smtId(d.name)} DataType)`);
      if (d.classification) classifications.add(d.classification);
      if (d.jurisdiction) jurisdictions.add(d.jurisdiction);
    }
    for (const c of classifications) {
      stmts.push(`(declare-const Classification__${smtId(c)} Classification)`);
    }
    for (const j of jurisdictions) {
      stmts.push(`(declare-const Jurisdiction__${smtId(j)} Jurisdiction)`);
    }
    for (const d of dataTypes) {
      if (d.classification) {
        stmts.push(`(assert (ClassifiedAs ${smtId(d.name)} Classification__${smtId(d.classification)}))`);
      }
      if (d.jurisdiction) {
        stmts.push(`(assert (JurisdictionOf ${smtId(d.name)} Jurisdiction__${smtId(d.jurisdiction)}))`);
      }
    }
    stmts.push('');
  }

  // Declare node constants
  if (nodes.length > 0) {
    stmts.push('; === node declarations ===');
    for (const n of nodes) {
      const id = smtId(n.name);
      stmts.push(`(declare-const ${id} Entity)`);
      stmts.push(`(assert (IsNode ${id}))`);
      const trustProp = n.props.find(p => p.key === 'trust');
      if (trustProp) {
        const val = Array.isArray(trustProp.value) ? trustProp.value[0] : trustProp.value;
        const trusted = val === 'trusted' ? 'true' : 'false';
        stmts.push(`(assert (= (Trusted ${id}) ${trusted}))`);
      }
    }
    stmts.push('');
  }

  // Declare component constants
  if (components.length > 0) {
    stmts.push('; === component declarations ===');
    for (const c of components) {
      const cid = smtId(c.name);
      stmts.push(`(declare-const ${cid} Entity)`);
      stmts.push(`(assert (IsComp ${cid}))`);
    }
    stmts.push('');
  }

  // Declare resource constants
  if (resources.length > 0) {
    stmts.push('; === resource declarations ===');
    for (const r of resources) {
      const id = smtId(r.name);
      stmts.push(`(declare-const ${id} Entity)`);
      stmts.push(`(assert (IsResource ${id}))`);
      const trustProp = r.props.find(p => p.key === 'trust');
      if (trustProp) {
        const val = Array.isArray(trustProp.value) ? trustProp.value[0] : trustProp.value;
        const trusted = val === 'trusted' ? 'true' : 'false';
        stmts.push(`(assert (= (Trusted ${id}) ${trusted}))`);
      }
    }
    stmts.push('');
  }

  // Translate invariant rules
  if (invariants.length > 0) {
    stmts.push('; === invariant rules ===');
    const declaredEntities = [...nodes.map(n => n.name), ...resources.map(r => r.name), ...components.map(c => c.name)];
    for (const { invariant, rule } of expandInvariantRules(program)) {
      stmts.push(`; --- ${invariant} ---`);
      if (rule.kind === 'DenyFlow') {
        const from = smtId(rule.from);
        const to = smtId(rule.to);
        stmts.push(`(assert (=> (Flow ${from} ${to}) false))`);
      } else if (rule.kind === 'DenyReach') {
        const from = smtId(rule.from);
        const to = smtId(rule.to);
        stmts.push(`(assert (=> (CanReach ${from} ${to}) false))`);
      } else if (rule.kind === 'DenyDataFlow') {
        const data = smtId(rule.data);
        const to = smtId(rule.to);
        stmts.push(`(assert (=> (DataCanReach ${data} ${to}) false))`);
      } else if (rule.kind === 'RequireFlowVia') {
        stmts.push(`(assert (=> (PathWithoutVia ${smtId(rule.from)} ${smtId(rule.to)} ${smtId(rule.via)}) false))`);
      } else if (rule.kind === 'RequireDataFlowVia') {
        stmts.push(`(assert (=> (DataPathWithoutVia ${smtId(rule.data)} ${smtId(rule.to)} ${smtId(rule.via)}) false))`);
      } else if (rule.kind === 'DenyUnauthenticatedFlow') {
        stmts.push(`(assert (=> (UnauthenticatedFlow ${smtId(rule.from)} ${smtId(rule.to)}) false))`);
      } else if (rule.kind === 'DenyUnencryptedFlow') {
        stmts.push(`(assert (=> (UnencryptedFlow ${smtId(rule.from)} ${smtId(rule.to)}) false))`);
      } else if (rule.kind === 'RequireDependencyViaInterface') {
        const interfaceId = `Interface__${smtId(rule.interface)}`;
        if (!declaredInterfaces.has(interfaceId)) {
          stmts.push(`(declare-const ${interfaceId} InterfaceType)`);
          declaredInterfaces.add(interfaceId);
        }
        stmts.push(`(assert (=> (DependencyWithoutInterface ${smtId(rule.from)} ${smtId(rule.to)} Interface__${smtId(rule.interface)}) false))`);
      } else if (rule.kind === 'RequireOperationIn') {
        const operationId = `Operation__${smtId(rule.operation)}`;
        if (!declaredOperations.has(operationId)) {
          stmts.push(`(declare-const ${operationId} Operation)`);
          declaredOperations.add(operationId);
        }
        for (const entity of declaredEntities) {
          if (entity !== rule.component) {
            stmts.push(`(assert (=> (OperationIn ${smtId(entity)} Operation__${smtId(rule.operation)}) false))`);
          }
        }
      } else if (rule.kind === 'RequireOperationOnDataIn') {
        const operationId = `Operation__${smtId(rule.operation)}`;
        if (!declaredOperations.has(operationId)) {
          stmts.push(`(declare-const ${operationId} Operation)`);
          declaredOperations.add(operationId);
        }
        for (const entity of declaredEntities) {
          if (entity !== rule.component) {
            stmts.push(`(assert (=> (OperationOnDataIn ${smtId(entity)} Operation__${smtId(rule.operation)} ${smtId(rule.data)}) false))`);
          }
        }
      }
      // RequireContractImplementedBy is validated deterministically by the checker.
    }
    stmts.push('');
  }

  if (diPolicies.length > 0) {
    stmts.push('; === dependency injection policy rules ===');
    const services = new Set<string>();
    for (const policy of diPolicies) {
      for (const rule of policy.rules) {
        if (rule.kind === 'DenyResolve') {
          services.add(rule.service);
        }
      }
    }
    for (const service of services) {
      stmts.push(`(declare-const ${smtId(service)} ServiceType)`);
    }
    for (const policy of diPolicies) {
      stmts.push(`; --- ${policy.name} ---`);
      for (const rule of policy.rules) {
        if (rule.kind === 'DenyInject') {
          stmts.push(`(assert (=> (Injects ${smtId(rule.from)} ${smtId(rule.to)}) false))`);
        } else if (rule.kind === 'DenyInjectReach') {
          stmts.push(`(assert (=> (InjectReach ${smtId(rule.from)} ${smtId(rule.to)}) false))`);
        } else if (rule.kind === 'DenyLifetime') {
          stmts.push(`(assert (=> (LifetimeDepends Lifetime__${rule.from} Lifetime__${rule.to}) false))`);
        } else if (rule.kind === 'DenyLifetimeReach') {
          stmts.push(`(assert (=> (LifetimeReach Lifetime__${rule.from} Lifetime__${rule.to}) false))`);
        } else if (rule.kind === 'DenyResolve') {
          stmts.push(`(assert (=> (Resolves ${smtId(rule.from)} ${smtId(rule.service)}) false))`);
        }
      }
    }
    stmts.push('');
  }

  if (dataPolicies.length > 0) {
    stmts.push('; === data policy rules ===');
    for (const policy of dataPolicies) {
      stmts.push(`; --- ${policy.name} ---`);
      for (const rule of policy.rules) {
        if (rule.kind === 'DenyClassification') {
          stmts.push(`(assert (forall ((d DataType) (e Entity)) (=> (and (ClassifiedAs d Classification__${smtId(rule.classification)}) (DataCanReach d e) (= (Trusted e) ${rule.toTrust === 'trusted' ? 'true' : 'false'})) false)))`);
        } else {
          stmts.push(`(assert (forall ((d DataType)) (=> (and (JurisdictionOf d Jurisdiction__${smtId(rule.jurisdiction)}) (DataCanReach d ${smtId(rule.to)})) false)))`);
        }
      }
    }
    stmts.push('');
  }

  if (trustPolicies.length > 0) {
    stmts.push('; === trust policy rules ===');
    for (const policy of trustPolicies) {
      stmts.push(`; --- ${policy.name} ---`);
      for (const rule of policy.rules) {
        if (rule.kind === 'RequireAuth') {
          stmts.push(`; require auth ${rule.fromTrust} -> ${rule.toTrust} is evaluated by the runtime trust gate`);
        } else {
          stmts.push(`; deny flow ${rule.fromTrust} -> ${rule.toTrust} when data ${rule.classification} is evaluated by the runtime trust gate`);
        }
      }
    }
    stmts.push('');
  }

  if (permissions.length > 0) {
    stmts.push('; === permission declarations ===');
    const operations = new Set<string>();
    const roles = new Set<string>();
    for (const permission of permissions) {
      for (const rule of permission.rules) {
        for (const op of rule.operations) operations.add(op);
        if (rule.roleEnum !== '*' && rule.roleValue !== '*') roles.add(`${rule.roleEnum}__${rule.roleValue}`);
      }
    }
    for (const op of operations) {
      const operationId = `Operation__${smtId(op)}`;
      if (!declaredOperations.has(operationId)) {
        stmts.push(`(declare-const ${operationId} Operation)`);
        declaredOperations.add(operationId);
      }
    }
    for (const role of roles) stmts.push(`(declare-const Role__${smtId(role)} RoleType)`);
    stmts.push('');
  }

  if (stateMachines.length > 0) {
    stmts.push('; === state machine transition rules ===');
    const declaredStateValues = new Set<string>();
    for (const machine of stateMachines) {
      const dataDecl = dataTypes.find(d => d.name === machine.onType);
      const field = dataDecl?.fields.find(f => f.key === machine.onField);
      const enumName = field?.typeExpr.replace(/^Optional<(.+)>$/, '$1').trim();
      const enumDecl = enums.find(e => e.name === enumName);
      if (!enumDecl) continue;
      const stateNamespace = enumName!;
      const fieldId = `Field__${smtId(machine.onType)}__${smtId(machine.onField)}`;
      const stateId = (value: string): string => `State__${smtId(stateNamespace)}__${smtId(value)}`;
      stmts.push(`; --- ${machine.name} ---`);
      stmts.push(`(declare-const ${fieldId} Field)`);
      for (const value of enumDecl.values) {
        const id = stateId(value);
        if (!declaredStateValues.has(id)) {
          stmts.push(`(declare-const ${id} StateValue)`);
          declaredStateValues.add(id);
        }
      }
      const denyTransition = (from: string, to: string): void => {
        stmts.push(`(assert (=> (Transition ${smtId(machine.onType)} ${fieldId} ${stateId(from)} ${stateId(to)}) false))`);
      };
      const matches = (rule: TransitionRule, from: string, to: string): boolean =>
        (rule.from === '*' || rule.from === from) && (rule.to === '*' || rule.to === to);
      const allowRules = machine.transitions.filter(t => t.kind === 'allow');
      for (const from of enumDecl.values) {
        for (const to of enumDecl.values) {
          if (from === to) continue;
          const explicitlyDenied = machine.transitions.some(t => t.kind === 'deny' && matches(t, from, to));
          const allowed = allowRules.length === 0 || allowRules.some(t => matches(t, from, to));
          if (explicitlyDenied || !allowed) denyTransition(from, to);
        }
      }
    }
    stmts.push('');
  }

  const fieldPathId = (expr: ValueExpression): string => `FieldPath__${smtId(expr.subject)}__${expr.path.map(smtId).join('__')}`;
  const relationId = (relation: string): string => `Relation__${relation.replace(/[^a-zA-Z0-9_]/g, token => ({ '=': 'eq', '!': 'not', '>': 'gt', '<': 'lt' }[token] ?? '_'))}`;
  const scalarId = (value: PolicyValue): string => {
    if (value === null) return 'Value__null';
    return `Value__${smtId(String(value))}`;
  };
  const declaredFieldPaths = new Set<string>();
  const declaredRelations = new Set<string>();
  const declaredScalarValues = new Set<string>();
  const declareValueExpr = (expr: ValueExpression): void => {
    const fieldId = fieldPathId(expr);
    const relId = relationId(expr.relation);
    const valId = scalarId(expr.value);
    if (!declaredFieldPaths.has(fieldId)) {
      stmts.push(`(declare-const ${fieldId} FieldPath)`);
      declaredFieldPaths.add(fieldId);
    }
    if (!declaredRelations.has(relId)) {
      stmts.push(`(declare-const ${relId} ValueRelation)`);
      declaredRelations.add(relId);
    }
    if (!declaredScalarValues.has(valId)) {
      stmts.push(`(declare-const ${valId} ScalarValue)`);
      declaredScalarValues.add(valId);
    }
  };

  if (valuePolicies.length > 0) {
    stmts.push('; === value policy rules ===');
    for (const policy of valuePolicies) {
      stmts.push(`; --- ${policy.name} ---`);
      for (const rule of policy.rules) {
        declareValueExpr(rule.requirement);
        if (rule.when) declareValueExpr(rule.when);
        const req = rule.requirement;
        const contradiction = `(ValueContradiction ${smtId(req.subject)} ${fieldPathId(req)} ${relationId(req.relation)} ${scalarId(req.value)})`;
        if (rule.when) {
          const cond = rule.when;
          stmts.push(`(assert (=> (and (ValueFact ${smtId(cond.subject)} ${fieldPathId(cond)} ${relationId(cond.relation)} ${scalarId(cond.value)}) ${contradiction}) false))`);
        } else {
          stmts.push(`(assert (=> ${contradiction} false))`);
        }
      }
    }
    stmts.push('');
  }

  if (operationPolicies.length > 0) {
    stmts.push('; === operation policy rules ===');
    for (const policy of operationPolicies) {
      stmts.push(`; --- ${policy.name} ---`);
      for (const rule of policy.rules) {
        const operationId = `Operation__${smtId(rule.operation)}`;
        if (!declaredOperations.has(operationId)) {
          stmts.push(`(declare-const ${operationId} Operation)`);
          declaredOperations.add(operationId);
        }
        declareValueExpr(rule.requirement);
        const req = rule.requirement;
        const phase = rule.kind === 'RequireBefore' ? 'Phase__before' : 'Phase__after';
        stmts.push(`(assert (=> (OperationStateContradiction ${operationId} ${phase} ${smtId(req.subject)} ${fieldPathId(req)} ${relationId(req.relation)} ${scalarId(req.value)}) false))`);
      }
    }
    stmts.push('');
  }

  if (eventPolicies.length > 0) {
    stmts.push('; === event policy rules ===');
    const declaredEvents = new Set<string>();
    for (const policy of eventPolicies) {
      stmts.push(`; --- ${policy.name} ---`);
      for (const rule of policy.rules) {
        for (const event of [rule.event, rule.precededBy]) {
          const eventId = `Event__${smtId(event)}`;
          if (!declaredEvents.has(eventId)) {
            stmts.push(`(declare-const ${eventId} EventType)`);
            declaredEvents.add(eventId);
          }
        }
        stmts.push(`(assert (=> (EventMissingPrecedence Event__${smtId(rule.event)} Event__${smtId(rule.precededBy)} ${smtId(rule.scope)}) false))`);
      }
    }
    stmts.push('');
  }

  return stmts;
}
