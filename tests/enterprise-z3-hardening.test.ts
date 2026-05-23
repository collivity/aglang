import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { generateDeltaAssertions } from '../src/runtime/delta-assert.ts';
import { runGate } from '../src/runtime/gate.ts';
import type { ExtractorPlugin, FlowFact } from '../src/analyzers/plugin.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'enterprise-z3-test.ag');
}

const textFlowPlugin: ExtractorPlugin = {
  name: 'test text flow extractor',
  extensions: ['.flow'],
  extract(input): FlowFact[] {
    const facts: FlowFact[] = [];
    for (const file of input.files) {
      const content = readFileSync(file, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = /^\s*(\w+)\s*->\s*(\w+)/.exec(line);
        if (match) {
          facts.push({
            from: match[1]!,
            to: match[2]!,
            confidence: 'definite',
            evidence: line.trim(),
            file,
          });
        }
      }
    }
    return facts;
  },
};

describe('enterprise Z3 hardening tranche', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = join(tmpdir(), `aglang-enterprise-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('blocks transitive reach while keeping direct deny flow syntax unchanged', async () => {
    const dir = tempDir();
    const f = join(dir, 'flows.flow');
    writeFileSync(f, 'UI -> Service\nService -> Db\n');

    const artifact = compile(`
      node edge : edge_desktop { trust: untrusted }
      node app : server { trust: trusted auth: jwt }
      node dbn : postgres { trust: trusted auth: mtls }
      component UI { runs_on: edge paths: "*.flow" }
      component Service { runs_on: app paths: "*.flow" }
      component Db { runs_on: dbn paths: "*.flow" }
      invariant Layers { deny reach UI -> Db }
    `);

    expect(artifact.reachPolicies).toEqual([{ invariant: 'Layers', from: 'UI', to: 'Db' }]);
    const delta = await generateDeltaAssertions([
      { componentName: 'UI', files: [f] },
      { componentName: 'Service', files: [f] },
    ], artifact, { plugins: [textFlowPlugin] });

    expect(delta.blockingReachFacts[0]!.path).toEqual(['UI', 'Service', 'Db']);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('reach_violation');
  });

  it('blocks classified data reaching an untrusted target through multiple hops', async () => {
    const dir = tempDir();
    const f = join(dir, 'flows.flow');
    writeFileSync(f, 'Api -> Worker\nWorker -> Partner\n');

    const artifact = compile(`
      node api_node : server { trust: trusted auth: jwt }
      node worker_node : server { trust: trusted auth: mtls }
      node partner_node : rest_api { trust: untrusted auth: none }
      data CustomerProfile { classification: pii jurisdiction: eu id: UUID }
      component Api { runs_on: api_node paths: "*.flow" handles: CustomerProfile }
      component Worker { runs_on: worker_node paths: "*.flow" }
      component Partner { runs_on: partner_node paths: "*.flow" }
      data_policy Privacy {
        deny classification pii -> untrusted
        deny jurisdiction eu -> Partner
      }
    `);

    expect(artifact.dataPolicies).toHaveLength(1);
    const delta = await generateDeltaAssertions([
      { componentName: 'Api', files: [f] },
      { componentName: 'Worker', files: [f] },
    ], artifact, { plugins: [textFlowPlugin] });

    expect(delta.blockingDataFlowFacts.some(fact => fact.data === 'CustomerProfile' && fact.to === 'Partner')).toBe(true);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.some(v => v.type === 'data_policy_violation')).toBe(true);
  });

  it('blocks trust-boundary auth and classified trusted-to-untrusted data rules', async () => {
    const dir = tempDir();
    const f = join(dir, 'flows.flow');
    writeFileSync(f, 'PublicClient -> Core\nCore -> Webhook\n');

    const artifact = compile(`
      node browser : edge_desktop { trust: untrusted auth: none }
      node core_node : server { trust: trusted auth: none }
      node webhook_node : rest_api { trust: untrusted auth: none }
      data CustomerProfile { classification: pii id: UUID }
      component PublicClient { runs_on: browser paths: "*.flow" }
      component Core { runs_on: core_node paths: "*.flow" handles: CustomerProfile }
      component Webhook { runs_on: webhook_node paths: "*.flow" }
      trust_policy Boundaries {
        require auth untrusted -> trusted
        deny flow trusted -> untrusted when data pii
      }
    `);

    expect(artifact.trustPolicies).toHaveLength(1);
    const delta = await generateDeltaAssertions([
      { componentName: 'PublicClient', files: [f] },
      { componentName: 'Core', files: [f] },
    ], artifact, { plugins: [textFlowPlugin] });

    expect(delta.blockingTrustPolicyFacts).toHaveLength(2);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.every(v => v.type === 'trust_policy_violation')).toBe(true);
  });

  it('blocks transitive DI injection and lifetime reach policies', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'Views'), { recursive: true });
    mkdirSync(join(dir, 'ViewModels'), { recursive: true });
    mkdirSync(join(dir, 'Repos'), { recursive: true });
    const program = join(dir, 'Program.cs');
    const view = join(dir, 'Views', 'OrderView.cs');
    const vm = join(dir, 'ViewModels', 'OrderViewModel.cs');
    const repo = join(dir, 'Repos', 'OrderRepository.cs');
    writeFileSync(program, `
      services.AddSingleton<IOrderView, OrderView>();
      services.AddTransient<IOrderViewModel, OrderViewModel>();
      services.AddScoped<IOrderRepository, OrderRepository>();
    `);
    writeFileSync(view, 'public class OrderView { public OrderView(IOrderViewModel vm) {} } public interface IOrderView {}');
    writeFileSync(vm, 'public class OrderViewModel { public OrderViewModel(IOrderRepository repo) {} } public interface IOrderViewModel {}');
    writeFileSync(repo, 'public class OrderRepository {} public interface IOrderRepository {}');

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      component Views { runs_on: runtime paths: "Views/**/*.cs" }
      component ViewModels { runs_on: runtime paths: "ViewModels/**/*.cs" }
      component Repositories { runs_on: runtime paths: "Repos/**/*.cs" }
      component CompositionRoot { runs_on: runtime paths: "Program.cs" }
      di_policy DependencyInjection {
        deny inject_reach Views -> Repositories
        deny lifetime_reach singleton -> scoped
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'CompositionRoot', files: [program] },
      { componentName: 'Views', files: [view] },
      { componentName: 'ViewModels', files: [vm] },
      { componentName: 'Repositories', files: [repo] },
    ], artifact);

    expect(delta.blockingDiFacts.some(f => f.reachKind === 'inject_reach')).toBe(true);
    expect(delta.blockingDiFacts.some(f => f.reachKind === 'lifetime_reach')).toBe(true);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.filter(v => v.type === 'di_violation')).toHaveLength(2);
  });

  it('blocks a protected C# operation without matching role evidence', async () => {
    const dir = tempDir();
    const controller = join(dir, 'ProjectsController.cs');
    writeFileSync(controller, `
      public class Project {}
      public class ProjectsController {
        [HttpDelete]
        public void DeleteProject(Project project) {}
      }
    `);

    const artifact = compile(`
      node api : server { trust: trusted auth: jwt }
      data Project { id: UUID }
      enum Role { Admin | Member }
      component Api { runs_on: api paths: "*.cs" }
      permission ProjectAccess on Project {
        allow Role.Admin -> delete
        deny Role.Member -> delete
      }
    `);

    expect(artifact.permissionPolicies).toHaveLength(1);
    const delta = await generateDeltaAssertions([
      { componentName: 'Api', files: [controller] },
    ], artifact);

    expect(delta.blockingPermissionFacts).toHaveLength(1);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('permission_violation');
  });
});
