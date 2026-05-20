import { readFileSync } from 'fs';
import type { ExtractorPlugin, FlowFact } from './plugin.ts';

function lineFor(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

export const loadBalancerConfigPlugin: ExtractorPlugin = {
  name: 'load-balancer-config',
  extensions: ['.yaml', '.yml', '.conf'],

  extract({ componentName, files, mappings }): FlowFact[] {
    const facts: FlowFact[] = [];
    const targets = Object.keys(mappings).filter(name => name !== componentName);

    for (const file of files) {
      let source = '';
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      for (const target of targets) {
        const pattern = new RegExp(`\\b${target}\\b`, 'g');
        for (const match of source.matchAll(pattern)) {
          facts.push({
            from: componentName,
            to: target,
            confidence: 'definite',
            evidence: `load balancer/config route references component '${target}'`,
            file,
            line: lineFor(source, match.index ?? 0),
            strategy: 'regex',
          });
        }
      }
    }

    return facts;
  },
};
