import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { generateDeltaAssertions } from '../src/runtime/delta-assert.ts';
import { runGate } from '../src/runtime/gate.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'di-policy-test.ag');
}

const SPEC = `
  node runtime : agent_runtime { trust: trusted }
  component Views { runs_on: runtime paths: "src/Views/**/*.cs" }
  component BleManager { runs_on: runtime paths: "src/Infrastructure/Bluetooth/**/*.cs" }
  component ViewModels { runs_on: runtime paths: "src/ViewModels/**/*.cs" }
  component Repositories { runs_on: runtime paths: "src/Infrastructure/Persistence/**/*.cs" }
  component Application { runs_on: runtime paths: "src/Application/**/*.cs" }

  di_policy DependencyInjection {
    deny inject Views -> BleManager
    deny lifetime singleton -> scoped
    deny resolve IServiceProvider from Application
  }
`;

describe('di_policy DSL and C# extraction', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempProject() {
    const dir = join(tmpdir(), `aglang-di-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, 'src', 'Views'), { recursive: true });
    mkdirSync(join(dir, 'src', 'Infrastructure', 'Bluetooth'), { recursive: true });
    mkdirSync(join(dir, 'src', 'Infrastructure', 'Persistence'), { recursive: true });
    mkdirSync(join(dir, 'src', 'Application'), { recursive: true });
    return dir;
  }

  it('parses and emits Z3-backed dependency injection policies', () => {
    const artifact = compile(SPEC);
    expect(artifact.diPolicies).toHaveLength(1);
    expect(artifact.enforcement.some(e => e.declaration === 'di_policy' && e.level === 'formal_z3')).toBe(true);
    expect(artifact.constraints.some(c => c.includes('Injects Views BleManager'))).toBe(true);
    expect(artifact.constraints.some(c => c.includes('LifetimeDepends Lifetime__singleton Lifetime__scoped'))).toBe(true);
  });

  it('blocks a view constructor that injects infrastructure directly', async () => {
    const dir = tempProject();
    const view = join(dir, 'src', 'Views', 'OrderView.xaml.cs');
    const ble = join(dir, 'src', 'Infrastructure', 'Bluetooth', 'BleManager.cs');
    writeFileSync(view, 'public class OrderView { public OrderView(BleManager bleManager) {} }');
    writeFileSync(ble, 'public class BleManager {}');

    const artifact = compile(SPEC);
    const delta = await generateDeltaAssertions([
      { componentName: 'Views', files: [view] },
      { componentName: 'BleManager', files: [ble] },
    ], artifact);

    expect(delta.blockingDiFacts.some(f => f.kind === 'inject')).toBe(true);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('di_violation');
    expect(verdict.violations[0]!.z3_proof.permanent_constraint).toContain('Injects Views BleManager');
  });

  it('blocks a singleton service depending on a scoped service', async () => {
    const dir = tempProject();
    const program = join(dir, 'src', 'Program.cs');
    const ble = join(dir, 'src', 'Infrastructure', 'Bluetooth', 'BleManager.cs');
    const repo = join(dir, 'src', 'Infrastructure', 'Persistence', 'OrderRepository.cs');
    writeFileSync(program, `
      services.AddSingleton<IBleManager, BleManager>();
      services.AddScoped<IOrderRepository, OrderRepository>();
    `);
    writeFileSync(ble, 'public class BleManager { public BleManager(IOrderRepository orders) {} }');
    writeFileSync(repo, 'public class OrderRepository {} public interface IOrderRepository {}');

    const artifact = compile(SPEC);
    const delta = await generateDeltaAssertions([
      { componentName: 'Application', files: [program] },
      { componentName: 'BleManager', files: [ble] },
      { componentName: 'Repositories', files: [repo] },
    ], artifact);

    expect(delta.blockingDiFacts.some(f => f.kind === 'lifetime_dependency')).toBe(true);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.some(v => v.type === 'di_violation' && v.message.includes('singleton'))).toBe(true);
  });

  it('blocks service-locator access from a denied component', async () => {
    const dir = tempProject();
    const handler = join(dir, 'src', 'Application', 'SyncHandler.cs');
    writeFileSync(handler, 'public class SyncHandler { public SyncHandler(IServiceProvider services) {} }');

    const artifact = compile(SPEC);
    const delta = await generateDeltaAssertions([
      { componentName: 'Application', files: [handler] },
    ], artifact);

    expect(delta.blockingDiFacts.some(f => f.kind === 'resolve')).toBe(true);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.z3_proof.permanent_constraint).toContain('Resolves Application IServiceProvider');
  });
});
