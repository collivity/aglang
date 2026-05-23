// SMT-LIB 2.6 translator — converts checked AST to formula strings
import type { Program, NodeDecl, ComponentDecl, InvariantDecl, EnumDecl, DataDecl, ResourceDecl, DiPolicyDecl } from '../ast.ts';
import { BASE_SMT_DECLARATIONS } from '../stdlib/topology.ts';
import { expandInvariantRules } from '../invariant-selectors.ts';

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function translate(program: Program): string[] {
  const stmts: string[] = [...BASE_SMT_DECLARATIONS, ''];

  const nodes: NodeDecl[] = [];
  const resources: ResourceDecl[] = [];
  const components: ComponentDecl[] = [];
  const invariants: InvariantDecl[] = [];
  const diPolicies: DiPolicyDecl[] = [];
  const enums: EnumDecl[] = [];
  const dataTypes: DataDecl[] = [];

  for (const d of program.declarations) {
    if (d.kind === 'NodeDecl') nodes.push(d);
    else if (d.kind === 'ResourceDecl') resources.push(d);
    else if (d.kind === 'ComponentDecl') components.push(d);
    else if (d.kind === 'InvariantDecl') invariants.push(d);
    else if (d.kind === 'DiPolicyDecl') diPolicies.push(d);
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
    for (const d of dataTypes) {
      stmts.push(`(declare-const ${smtId(d.name)} DataType)`);
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
    for (const { invariant, rule } of expandInvariantRules(program)) {
      stmts.push(`; --- ${invariant} ---`);
      if (rule.kind === 'DenyFlow') {
        const from = smtId(rule.from);
        const to = smtId(rule.to);
        stmts.push(`(assert (=> (Flow ${from} ${to}) false))`);
      } else if (rule.kind === 'DenyDataFlow') {
        const data = smtId(rule.data);
        const to = smtId(rule.to);
        stmts.push(`(assert (=> (DataFlow ${data} ${to}) false))`);
      }
      // RequireEncryption: NOT emitted as Z3 constraint.
      // Encryption cannot be determined from static code analysis alone —
      // no extractor currently produces Encrypted=false evidence.
      // These rules are documented in AGENTS.md as advisory invariants.
      // Future: network config / TLS certificate extractors could enable enforcement.
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
        } else if (rule.kind === 'DenyLifetime') {
          stmts.push(`(assert (=> (LifetimeDepends Lifetime__${rule.from} Lifetime__${rule.to}) false))`);
        } else if (rule.kind === 'DenyResolve') {
          stmts.push(`(assert (=> (Resolves ${smtId(rule.from)} ${smtId(rule.service)}) false))`);
        }
      }
    }
    stmts.push('');
  }

  return stmts;
}
