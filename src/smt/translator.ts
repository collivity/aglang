// SMT-LIB 2.6 translator — converts checked AST to formula strings
import type { Program, NodeDecl, ComponentDecl, InvariantDecl, EnumDecl, DataDecl } from '../ast.ts';
import { BASE_SMT_DECLARATIONS } from '../stdlib/topology.ts';

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function translate(program: Program): string[] {
  const stmts: string[] = [...BASE_SMT_DECLARATIONS, ''];

  const nodes: NodeDecl[] = [];
  const components: ComponentDecl[] = [];
  const invariants: InvariantDecl[] = [];
  const enums: EnumDecl[] = [];
  const dataTypes: DataDecl[] = [];

  for (const d of program.declarations) {
    if (d.kind === 'NodeDecl') nodes.push(d);
    else if (d.kind === 'ComponentDecl') components.push(d);
    else if (d.kind === 'InvariantDecl') invariants.push(d);
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

  // Data types as uninterpreted sorts — structural details not encoded in SMT
  // (we encode state constraints as reachability predicates, not full types)
  if (dataTypes.length > 0) {
    stmts.push('; === data type sorts ===');
    for (const d of dataTypes) {
      stmts.push(`(declare-sort ${smtId(d.name)} 0)`);
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

  // Translate invariant rules
  if (invariants.length > 0) {
    stmts.push('; === invariant rules ===');
    for (const inv of invariants) {
      stmts.push(`; --- ${inv.name} ---`);
      for (const rule of inv.rules) {
        const from = smtId(rule.from);
        const to = smtId(rule.to);
        if (rule.kind === 'DenyFlow') {
          stmts.push(`(assert (=> (Flow ${from} ${to}) false))`);
        }
        // RequireEncryption: NOT emitted as Z3 constraint.
        // Encryption cannot be determined from static code analysis alone —
        // no extractor currently produces Encrypted=false evidence.
        // These rules are documented in AGENTS.md as advisory invariants.
        // Future: network config / TLS certificate extractors could enable enforcement.
      }
    }
    stmts.push('');
  }

  return stmts;
}
