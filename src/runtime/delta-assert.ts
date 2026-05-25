// Delta Assertion Generator
// Reads changed source files, dispatches to registered extractor plugins,
// and emits SMT-LIB assertion strings for the Z3 gate.

import { cpus } from 'os';
import { extname } from 'path';
import type { ChangedComponent } from './diff-parser.ts';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { ExtractionStrategy, ExtractorPlugin, FlowFact, GraphFact, ExtractorDebugEvent } from '../analyzers/plugin.ts';
import { discoverPlugins } from '../analyzers/plugin.ts';
import { createExtractorDebugSession } from '../analyzers/plugin.ts';
import { csharpPlugin, extractAuthFactsFromCSharp, extractDiFactsFromCSharp, type AuthFact, type DiFact } from '../analyzers/csharp.ts';
import { kotlinPlugin } from '../analyzers/kotlin.ts';
import { pythonPlugin } from '../analyzers/python.ts';
import { goPlugin } from '../analyzers/golang.ts';
import { rustPlugin } from '../analyzers/rust.ts';
import { javaPlugin, scalaPlugin } from '../analyzers/java.ts';
import { typescriptServerPlugin } from '../analyzers/typescript-server.ts';
import { swiftPlugin } from '../analyzers/swift.ts';
import { loadBalancerConfigPlugin } from '../analyzers/load-balancer.ts';
import { ExtractionCache, hashArtifact, extractWithCache } from './extraction-cache.ts';
import {
  buildGraphReport,
  flowFactToGraphFact,
  projectGraphToFlows,
  type GraphReport,
} from './graph-projection.ts';

export type { FlowFact, GraphFact };

export interface DataFlowFact {
  data: string;
  to: string;
  via: string;
  path?: string[];
  evidence: string;
  file: string;
  line?: number;
  confidence: FlowFact['confidence'];
}

export interface ReachFact {
  from: string;
  to: string;
  path: string[];
  evidence: string;
  file: string;
  line?: number;
  confidence: FlowFact['confidence'];
  graphEvidence?: FlowFact['graphEvidence'];
}

export interface TrustPolicyFact {
  policy: string;
  rule: ArchitectureArtifact['trustPolicies'][number]['rules'][number];
  from: string;
  to: string;
  path?: string[];
  data?: string;
  classification?: string;
  evidence: string;
  file: string;
  confidence: FlowFact['confidence'];
}

export type RuntimeDiFact = DiFact & {
  reachKind?: 'inject_reach' | 'lifetime_reach';
  path?: string[];
};

export interface PermissionViolationFact {
  permission: string;
  component: string;
  operation: string;
  data: string;
  evidence: string;
  file: string;
  line?: number;
  confidence: 'definite';
}

// Registry of built-in plugins (keyed by extension)
const BUILT_IN_PLUGINS: ExtractorPlugin[] = [
  csharpPlugin,
  kotlinPlugin,
  pythonPlugin,
  goPlugin,
  rustPlugin,
  javaPlugin,
  scalaPlugin,
  typescriptServerPlugin,
  swiftPlugin,
  loadBalancerConfigPlugin,
];

function buildExtensionMap(plugins: ExtractorPlugin[]): Map<string, ExtractorPlugin[]> {
  const map = new Map<string, ExtractorPlugin[]>();
  for (const plugin of plugins) {
    for (const ext of plugin.extensions) {
      const bucket = map.get(ext) ?? [];
      bucket.push(plugin);
      map.set(ext, bucket);
    }
  }
  return map;
}

export interface DeltaResult {
  facts: FlowFact[];
  dataFlowFacts: DataFlowFact[];
  reachFacts: ReachFact[];
  graphFacts: GraphFact[];
  blockingFacts: FlowFact[];   // confidence=definite (or probable in strict mode)
  blockingDataFlowFacts: DataFlowFact[];
  blockingReachFacts: ReachFact[];
  blockingTrustPolicyFacts: TrustPolicyFact[];
  diFacts: DiFact[];
  blockingDiFacts: RuntimeDiFact[];
  authFacts: AuthFact[];
  blockingPermissionFacts: PermissionViolationFact[];
  warningFacts: FlowFact[];    // confidence=probable (non-strict)
  smtAssertions: string[];     // only for blocking facts
  // Maps "from::to" → the exact SMT assertion string fed to Z3
  factSmtMap: Map<string, string>;
  diFactSmtMap: Map<string, string>;
  graphReport: GraphReport;
  unresolvedTargets: string[];
  graphWarnings: Array<{ graphFactId: string; message: string }>;
  /** Number of files whose extraction result came from cache */
  cacheHits: number;
  extractorDebug: ExtractorDebugEvent[];
}

function smtId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function diFactMatchesPolicy(fact: DiFact, artifact: ArchitectureArtifact): boolean {
  return (artifact.diPolicies ?? []).some(policy => policy.rules.some(rule => {
    if (fact.kind === 'inject' && rule.kind === 'DenyInject') {
      return rule.from === fact.from && rule.to === fact.to;
    }
    if (fact.kind === 'lifetime_dependency' && rule.kind === 'DenyLifetime') {
      return rule.from === fact.fromLifetime && rule.to === fact.toLifetime;
    }
    if (fact.kind === 'inject' && rule.kind === 'DenyInjectReach') {
      return false;
    }
    if (fact.kind === 'lifetime_dependency' && rule.kind === 'DenyLifetimeReach') {
      return false;
    }
    if (fact.kind === 'resolve' && rule.kind === 'DenyResolve') {
      return rule.from === fact.from && rule.service === fact.service;
    }
    return false;
  }));
}

function buildDiAssertion(fact: DiFact): string {
  const runtimeFact = fact as RuntimeDiFact;
  if (runtimeFact.reachKind === 'inject_reach' && fact.kind === 'inject') {
    return `(assert (InjectReach ${smtId(fact.from)} ${smtId(fact.to)}))`;
  }
  if (runtimeFact.reachKind === 'lifetime_reach' && fact.kind === 'lifetime_dependency') {
    return `(assert (LifetimeReach Lifetime__${fact.fromLifetime} Lifetime__${fact.toLifetime}))`;
  }
  if (fact.kind === 'inject') {
    return `(assert (Injects ${smtId(fact.from)} ${smtId(fact.to)}))`;
  }
  if (fact.kind === 'lifetime_dependency') {
    return `(assert (LifetimeDepends Lifetime__${fact.fromLifetime} Lifetime__${fact.toLifetime}))`;
  }
  return `(assert (Resolves ${smtId(fact.from)} ${smtId(fact.service)}))`;
}

function computeDiReachFacts(diFacts: DiFact[], artifact: ArchitectureArtifact): RuntimeDiFact[] {
  const injectEdges = diFacts.filter((f): f is Extract<DiFact, { kind: 'inject' }> => f.kind === 'inject');
  const lifetimeEdges = diFacts.filter((f): f is Extract<DiFact, { kind: 'lifetime_dependency' }> => f.kind === 'lifetime_dependency');
  const byFrom = new Map<string, typeof injectEdges>();
  for (const edge of injectEdges) {
    const bucket = byFrom.get(edge.from) ?? [];
    bucket.push(edge);
    byFrom.set(edge.from, bucket);
  }
  const reachFacts: RuntimeDiFact[] = [];
  for (const policy of artifact.diPolicies ?? []) {
    for (const rule of policy.rules) {
      if (rule.kind === 'DenyInjectReach') {
        const queue = (byFrom.get(rule.from) ?? []).map(edge => ({ edge, path: [edge.from, edge.to] }));
        const seen = new Set<string>();
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (seen.has(item.edge.to)) continue;
          seen.add(item.edge.to);
          if (item.edge.to === rule.to) {
            reachFacts.push({
              ...item.edge,
              from: rule.from,
              to: rule.to,
              reachKind: 'inject_reach',
              path: item.path,
              evidence: `DI injection path: ${item.path.join(' -> ')}`,
            });
            break;
          }
          for (const next of byFrom.get(item.edge.to) ?? []) {
            if (!item.path.includes(next.to)) queue.push({ edge: next, path: [...item.path, next.to] });
          }
        }
      }
      if (rule.kind === 'DenyLifetimeReach') {
        const byLifetime = new Map<string, typeof lifetimeEdges>();
        for (const edge of lifetimeEdges) {
          const bucket = byLifetime.get(edge.fromLifetime) ?? [];
          bucket.push(edge);
          byLifetime.set(edge.fromLifetime, bucket);
        }
        const queue = (byLifetime.get(rule.from) ?? []).map(edge => ({ edge, lifetimes: [edge.fromLifetime, edge.toLifetime], components: [edge.from, edge.to] }));
        const seen = new Set<string>();
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (seen.has(item.edge.toLifetime)) continue;
          seen.add(item.edge.toLifetime);
          if (item.edge.toLifetime === rule.to) {
            reachFacts.push({
              ...item.edge,
              fromLifetime: rule.from,
              toLifetime: rule.to,
              reachKind: 'lifetime_reach',
              path: item.components,
              evidence: `DI lifetime path: ${item.lifetimes.join(' -> ')} via ${item.components.join(' -> ')}`,
            });
            break;
          }
          for (const next of byLifetime.get(item.edge.toLifetime) ?? []) {
            if (!item.lifetimes.includes(next.toLifetime)) {
              queue.push({
                edge: next,
                lifetimes: [...item.lifetimes, next.toLifetime],
                components: [...item.components, next.to],
              });
            }
          }
        }
      }
    }
  }
  return reachFacts;
}

function computeReachFacts(flowFacts: FlowFact[]): ReachFact[] {
  const byFrom = new Map<string, FlowFact[]>();
  for (const fact of flowFacts) {
    const bucket = byFrom.get(fact.from) ?? [];
    bucket.push(fact);
    byFrom.set(fact.from, bucket);
  }
  const reachFacts: ReachFact[] = [];
  const seen = new Set<string>();
  for (const start of byFrom.keys()) {
    const queue: Array<{ current: string; path: string[]; first: FlowFact; confidence: FlowFact['confidence'] }> = [];
    for (const edge of byFrom.get(start) ?? []) {
      queue.push({ current: edge.to, path: [edge.from, edge.to], first: edge, confidence: edge.confidence });
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      const key = `${start}::${item.current}`;
      if (!seen.has(key)) {
        seen.add(key);
        reachFacts.push({
          from: start,
          to: item.current,
          path: item.path,
          confidence: item.confidence,
          evidence: `Reachability path: ${item.path.join(' -> ')}`,
          file: item.first.file,
          line: item.first.line,
          graphEvidence: item.first.graphEvidence,
        });
      }
      for (const next of byFrom.get(item.current) ?? []) {
        if (item.path.includes(next.to)) continue;
        queue.push({
          current: next.to,
          path: [...item.path, next.to],
          first: item.first,
          confidence: item.confidence === 'definite' && next.confidence === 'definite' ? 'definite' : 'probable',
        });
      }
    }
  }
  return reachFacts;
}

function inferDataFlowFacts(reachFacts: ReachFact[], artifact: ArchitectureArtifact): DataFlowFact[] {
  const handles = new Map((artifact.componentData ?? []).map(c => [c.component, c.handles]));
  const dataFlowFacts: DataFlowFact[] = [];
  for (const fact of reachFacts) {
    for (const data of handles.get(fact.from) ?? []) {
      dataFlowFacts.push({
        data,
        to: fact.to,
        via: fact.from,
        path: fact.path,
        evidence: `${fact.from} handles ${data}; ${fact.evidence}`,
        file: fact.file,
        ...(fact.line ? { line: fact.line } : {}),
        confidence: fact.confidence,
      });
    }
  }
  return dataFlowFacts;
}

function entityTrust(entity: string, artifact: ArchitectureArtifact): string | undefined {
  const direct = [...(artifact.nodes ?? []), ...(artifact.resources ?? [])].find(n => n.name === entity)?.trust;
  if (direct) return direct;
  const nodeName = artifact.componentNodes?.[entity];
  return nodeName ? (artifact.nodes ?? []).find(n => n.name === nodeName)?.trust : undefined;
}

function entityAuth(entity: string, artifact: ArchitectureArtifact): string | undefined {
  const direct = [...(artifact.nodes ?? []), ...(artifact.resources ?? [])].find(n => n.name === entity)?.auth;
  if (direct) return direct;
  const nodeName = artifact.componentNodes?.[entity];
  return nodeName ? (artifact.nodes ?? []).find(n => n.name === nodeName)?.auth : undefined;
}

function dataClassification(data: string, artifact: ArchitectureArtifact): string | undefined {
  return (artifact.dataTypes ?? []).find(d => d.name === data)?.classification;
}

function dataJurisdiction(data: string, artifact: ArchitectureArtifact): string | undefined {
  return (artifact.dataTypes ?? []).find(d => d.name === data)?.jurisdiction;
}

function factMatchesDataPolicies(fact: DataFlowFact, artifact: ArchitectureArtifact): boolean {
  const classification = dataClassification(fact.data, artifact);
  const jurisdiction = dataJurisdiction(fact.data, artifact);
  const targetTrust = entityTrust(fact.to, artifact);
  return (artifact.dataPolicies ?? []).some(policy => policy.rules.some(rule => {
    if (rule.kind === 'DenyClassification') {
      return classification === rule.classification && targetTrust === rule.toTrust;
    }
    return jurisdiction === rule.jurisdiction && fact.to === rule.to;
  }));
}

function inferTrustPolicyFacts(reachFacts: ReachFact[], dataFlowFacts: DataFlowFact[], artifact: ArchitectureArtifact): TrustPolicyFact[] {
  const facts: TrustPolicyFact[] = [];
  for (const policy of artifact.trustPolicies ?? []) {
    for (const rule of policy.rules) {
      if (rule.kind === 'RequireAuth') {
        for (const fact of reachFacts) {
          if (entityTrust(fact.from, artifact) === rule.fromTrust &&
              entityTrust(fact.to, artifact) === rule.toTrust &&
              (!entityAuth(fact.to, artifact) || entityAuth(fact.to, artifact) === 'none')) {
            facts.push({
              policy: policy.name,
              rule,
              from: fact.from,
              to: fact.to,
              path: fact.path,
              evidence: `${fact.evidence}; target auth is '${entityAuth(fact.to, artifact) ?? 'none'}'`,
              file: fact.file,
              confidence: fact.confidence,
            });
          }
        }
      } else {
        for (const fact of dataFlowFacts) {
          const classification = dataClassification(fact.data, artifact);
          if (classification === rule.classification &&
              entityTrust(fact.via, artifact) === rule.fromTrust &&
              entityTrust(fact.to, artifact) === rule.toTrust) {
            facts.push({
              policy: policy.name,
              rule,
              from: fact.via,
              to: fact.to,
              path: fact.path,
              data: fact.data,
              classification,
              evidence: fact.evidence,
              file: fact.file,
              confidence: fact.confidence,
            });
          }
        }
      }
    }
  }
  return facts;
}

function roleMatchesPermission(check: Extract<AuthFact, { kind: 'checks_role' }>, roleEnum: string, roleValue: string): boolean {
  if (roleEnum === '*' || roleValue === '*') return true;
  return check.role === roleValue || check.role === `${roleEnum}.${roleValue}` || check.role === `${roleEnum}__${roleValue}`;
}

function operationMatches(operations: string[], operation: string): boolean {
  return operations.includes('*') || operations.includes(operation);
}

function inferPermissionViolations(authFacts: AuthFact[], artifact: ArchitectureArtifact): PermissionViolationFact[] {
  const checksByComponent = new Map<string, Array<Extract<AuthFact, { kind: 'checks_role' }>>>();
  for (const fact of authFacts) {
    if (fact.kind === 'checks_role') {
      const bucket = checksByComponent.get(fact.component) ?? [];
      bucket.push(fact);
      checksByComponent.set(fact.component, bucket);
    }
  }
  const violations: PermissionViolationFact[] = [];
  for (const performs of authFacts.filter((f): f is Extract<AuthFact, { kind: 'performs' }> => f.kind === 'performs')) {
    const permission = (artifact.permissionPolicies ?? artifact.permissions ?? []).find(p => p.onType === performs.data);
    if (!permission) continue;
    const allowRules = permission.rules.filter(rule => rule.kind === 'allow' && operationMatches(rule.operations, performs.operation));
    if (allowRules.length === 0) continue;
    const checks = checksByComponent.get(performs.component) ?? [];
    const hasMatchingCheck = allowRules.some(rule => checks.some(check => roleMatchesPermission(check, rule.roleEnum, rule.roleValue)));
    if (!hasMatchingCheck) {
      violations.push({
        permission: permission.name,
        component: performs.component,
        operation: performs.operation,
        data: performs.data,
        evidence: `${performs.evidence}; no matching role check for allow rule`,
        file: performs.file,
        line: performs.line,
        confidence: 'definite',
      });
    }
  }
  return violations;
}

function defaultStrategyForPlugin(plugin: ExtractorPlugin): ExtractionStrategy {
  return /regex/i.test(plugin.name) ? 'regex' : 'legacy-flow';
}

// Simple concurrency limiter — runs up to `limit` async tasks at a time.
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function generateDeltaAssertions(
  changed: ChangedComponent[],
  artifact: ArchitectureArtifact,
  options: { strict?: boolean; plugins?: ExtractorPlugin[]; projectRoot?: string; debugExtractors?: boolean; requireAst?: boolean } = {},
): Promise<DeltaResult> {
  // Discover external plugins declared in the artifact, then merge with built-ins and caller-supplied
  const externalPlugins = discoverPlugins(artifact.plugins ?? []);
  const plugins = [...BUILT_IN_PLUGINS, ...externalPlugins, ...(options.plugins ?? [])];
  const extensionMap = buildExtensionMap(plugins);
  const strict = options.strict ?? false;
  const debugSession = createExtractorDebugSession(options.debugExtractors ?? false, options.requireAst ?? false);

  // Set up extraction cache (keyed by sha256 of architecture.o to auto-invalidate on recompile)
  const artifactHash = hashArtifact(JSON.stringify(artifact));
  const cache = options.projectRoot
    ? ExtractionCache.forProject(options.projectRoot, artifactHash)
    : null;

  const allGraphFacts: GraphFact[] = [];
  const csharpInputs: Array<{ componentName: string; files: string[] }> = [];
  let cacheHits = 0;
  const concurrency = cpus().length || 4;
  let graphFactSequence = 0;

  await runConcurrent(changed, concurrency, async ({ componentName, files }) => {
    // Group files by extension and dispatch to plugins as batches
    const byExt = new Map<string, string[]>();
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (extensionMap.has(ext)) {
        const bucket = byExt.get(ext) ?? [];
        bucket.push(f);
        byExt.set(ext, bucket);
      }
    }
    const csFiles = files.filter(f => ['.cs', '.csx'].includes(extname(f).toLowerCase()));
    if (csFiles.length > 0) {
      csharpInputs.push({ componentName, files: csFiles });
    }

    await Promise.all(
      Array.from(byExt.entries()).map(async ([ext, batch]) => {
        const pluginsForExt = extensionMap.get(ext)!;
        await Promise.all(pluginsForExt.map(async (plugin) => {
          if (plugin.extractGraph) {
            const facts = await plugin.extractGraph({ componentName, files: batch, mappings: artifact.mappings, debug: debugSession, requireAst: options.requireAst });
            allGraphFacts.push(...facts.map(f => ({
              ...f,
              evidence: {
                ...f.evidence,
                extractor: f.evidence.extractor ?? plugin.name,
                strategy: f.evidence.strategy ?? 'graph',
              },
            })));
          } else {
            const facts = await extractWithCache(cache, batch, (uncached) =>
              plugin.extract({ componentName, files: uncached, mappings: artifact.mappings, debug: debugSession, requireAst: options.requireAst }),
            );
            allGraphFacts.push(...facts.map(f =>
              flowFactToGraphFact(
                f.strategy ? f : { ...f, strategy: defaultStrategyForPlugin(plugin) },
                graphFactSequence++,
                plugin.name,
              )
            ));
          }
        }));
      }),
    );

  });

  // Count cache hits by checking which facts are from cached files
  // (Approximate: actual hit counting happens inside extractWithCache)
  cacheHits; // reported as 0 unless we thread it through — kept for future instrumentation

  // Flush cache to disk
  cache?.flush();

  // Deduplicate graph facts by stable ID, then project to flow facts.
  const graphSeen = new Set<string>();
  const uniqueGraphFacts: GraphFact[] = [];
  for (const f of allGraphFacts) {
    if (!graphSeen.has(f.id)) {
      graphSeen.add(f.id);
      uniqueGraphFacts.push(f);
    }
  }

  const projection = projectGraphToFlows(uniqueGraphFacts, artifact, { strict });
  const graphReport = buildGraphReport(uniqueGraphFacts, projection);
  const reachFacts = computeReachFacts(projection.flowFacts);
  const blockingReachFacts = reachFacts.filter(f =>
    artifact.invariants.some(inv => inv.rules.some(rule =>
      rule.kind === 'DenyReach' && rule.from === f.from && rule.to === f.to,
    )),
  );
  const dataFlowFacts = inferDataFlowFacts(reachFacts, artifact);
  const blockingDataFlowFacts = dataFlowFacts.filter(f =>
    artifact.invariants.some(inv => inv.rules.some(rule =>
      rule.kind === 'DenyDataFlow' && rule.data === f.data && rule.to === f.to,
    )) || factMatchesDataPolicies(f, artifact),
  );
  const reachAssertions = blockingReachFacts.map(f => `(assert (CanReach ${smtId(f.from)} ${smtId(f.to)}))`);
  const dataFlowAssertions = blockingDataFlowFacts.map(f => `(assert (DataCanReach ${smtId(f.data)} ${smtId(f.to)}))`);
  const blockingTrustPolicyFacts = inferTrustPolicyFacts(reachFacts, dataFlowFacts, artifact);
  const diFacts = extractDiFactsFromCSharp(csharpInputs, artifact.mappings);
  const directBlockingDiFacts = diFacts.filter(f => diFactMatchesPolicy(f, artifact));
  const diReachFacts = computeDiReachFacts(diFacts, artifact);
  const blockingDiFacts = [...directBlockingDiFacts, ...diReachFacts];
  const diFactSmtMap = new Map<string, string>();
  const diAssertions = blockingDiFacts.map(f => {
    const assertion = buildDiAssertion(f);
    if (f.kind === 'resolve') {
      diFactSmtMap.set(`${f.kind}:${f.from}::${f.service}`, assertion);
    } else if (f.kind === 'inject') {
      diFactSmtMap.set(`${f.kind}:${f.from}::${f.to}`, assertion);
    } else {
      diFactSmtMap.set(`${f.kind}:${f.fromLifetime}::${f.toLifetime}:${f.from}::${f.to}`, assertion);
    }
    return assertion;
  });
  const authFacts = extractAuthFactsFromCSharp(csharpInputs, artifact.permissionPolicies ?? artifact.permissions ?? []);
  const blockingPermissionFacts = inferPermissionViolations(authFacts, artifact);

  return {
    facts: projection.flowFacts,
    dataFlowFacts,
    reachFacts,
    graphFacts: uniqueGraphFacts,
    blockingFacts: projection.blockingFacts,
    blockingDataFlowFacts,
    blockingReachFacts,
    blockingTrustPolicyFacts,
    diFacts,
    blockingDiFacts,
    authFacts,
    blockingPermissionFacts,
    warningFacts: projection.warningFacts,
    smtAssertions: [...projection.smtAssertions, ...reachAssertions, ...dataFlowAssertions, ...diAssertions],
    factSmtMap: projection.factSmtMap,
    diFactSmtMap,
    graphReport,
    unresolvedTargets: projection.unresolvedTargets,
    graphWarnings: projection.warnings,
    cacheHits,
    extractorDebug: debugSession.events,
  };
}
