import type { ComponentDecl, InvariantEndpoint, InvariantRule, Program, ResourceDecl } from './ast.ts';

function endpointMatches(
  endpoint: InvariantEndpoint | undefined,
  fallback: string,
  components: ComponentDecl[],
  resources: ResourceDecl[],
): string[] {
  if (!endpoint || endpoint.kind === 'entity') return [fallback];
  if (endpoint.kind === 'role') {
    return components.filter(c => c.role === endpoint.name).map(c => c.name);
  }
  if (endpoint.kind === 'layer') {
    return components.filter(c => c.layer === endpoint.name).map(c => c.name);
  }
  return resources
    .filter(r => r.name === endpoint.name || r.resourceType.name === endpoint.name)
    .map(r => r.name);
}

export function expandInvariantRules(program: Program): Array<{ invariant: string; rule: InvariantRule }> {
  const components = program.declarations.filter((d): d is ComponentDecl => d.kind === 'ComponentDecl');
  const resources = program.declarations.filter((d): d is ResourceDecl => d.kind === 'ResourceDecl');
  const expanded: Array<{ invariant: string; rule: InvariantRule }> = [];

  for (const decl of program.declarations) {
    if (decl.kind !== 'InvariantDecl') continue;
    for (const rule of decl.rules) {
      if (rule.kind === 'DenyDataFlow') {
        expanded.push({ invariant: decl.name, rule });
        continue;
      }
      const froms = endpointMatches(rule.fromEndpoint, rule.from, components, resources);
      const tos = endpointMatches(rule.toEndpoint, rule.to, components, resources);
      for (const from of froms) {
        for (const to of tos) {
          expanded.push({
            invariant: decl.name,
            rule: { kind: rule.kind, from, to },
          });
        }
      }
    }
  }

  return expanded;
}
