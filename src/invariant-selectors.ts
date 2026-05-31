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
      if (rule.kind === 'DenyDataFlow' || rule.kind === 'RequireOperationIn' || rule.kind === 'RequireOperationOnDataIn' || rule.kind === 'RequireContractImplementedBy') {
        expanded.push({ invariant: decl.name, rule });
        continue;
      }
      if (rule.kind === 'RequireDataFlowVia') {
        const tos = endpointMatches(rule.toEndpoint, rule.to, components, resources);
        const vias = endpointMatches(rule.viaEndpoint, rule.via, components, resources);
        for (const to of tos) {
          for (const via of vias) {
            expanded.push({ invariant: decl.name, rule: { kind: rule.kind, data: rule.data, to, via } });
          }
        }
        continue;
      }
      const froms = endpointMatches(rule.fromEndpoint, rule.from, components, resources);
      const tos = endpointMatches(rule.toEndpoint, rule.to, components, resources);
      if (rule.kind === 'RequireFlowVia') {
        const vias = endpointMatches(rule.viaEndpoint, rule.via, components, resources);
        for (const from of froms) {
          for (const to of tos) {
            for (const via of vias) {
              expanded.push({
                invariant: decl.name,
                rule: { kind: rule.kind, from, to, via },
              });
            }
          }
        }
      } else {
        for (const from of froms) {
          for (const to of tos) {
            if (rule.kind === 'RequireDependencyViaInterface') {
              expanded.push({
                invariant: decl.name,
                rule: { kind: rule.kind, from, to, interface: rule.interface },
              });
              continue;
            }
            expanded.push({
              invariant: decl.name,
              rule: { kind: rule.kind, from, to },
            });
          }
        }
      }
    }
  }

  return expanded;
}
