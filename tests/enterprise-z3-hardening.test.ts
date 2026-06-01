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
import type { ExtractorPlugin, FlowFact, GraphFact } from '../src/analyzers/plugin.ts';

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

const serializationGraphPlugin: ExtractorPlugin = {
  name: 'test serialization graph extractor',
  extensions: ['.ops'],
  extractGraph(input): GraphFact[] {
    const facts: GraphFact[] = [];
    for (const file of input.files) {
      const content = readFileSync(file, 'utf8');
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const match = /^\s*(\w+)\s+serialization\s*$/.exec(line);
        if (!match) continue;
        facts.push({
          id: `${file}:${index + 1}`,
          kind: 'call',
          subject: match[1]!,
          properties: { method: 'serialize' },
          confidence: 'definite',
          evidence: {
            extractor: 'test',
            strategy: 'graph',
            file,
            line: index + 1,
            message: line.trim(),
          },
        });
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
    expect(verdict.solver_diagnostics?.some(d =>
      d.status === 'unsat' &&
      d.declaration === 'invariant deny reach' &&
      d.rule === 'Layers' &&
      d.components.join(' -> ') === 'UI -> Service -> Db'
    )).toBe(true);
  });

  it('passes require flow via when the path includes the required intermediate', async () => {
    const dir = tempDir();
    const f = join(dir, 'flows.flow');
    writeFileSync(f, 'Api -> Repository\nRepository -> Db\n');

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "*.flow" }
      component Repository { runs_on: runtime paths: "*.flow" }
      component Db { runs_on: runtime paths: "*.flow" }
      invariant RepositoryBoundary { require flow Api -> Db via Repository }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Api', files: [f] },
      { componentName: 'Repository', files: [f] },
    ], artifact, { plugins: [textFlowPlugin] });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingRequireFlowFacts).toHaveLength(0);
    expect(verdict.passed).toBe(true);
  });

  it('blocks require flow via when the path bypasses the required intermediate', async () => {
    const dir = tempDir();
    const f = join(dir, 'flows.flow');
    writeFileSync(f, 'Api -> Db\n');

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "*.flow" }
      component Repository { runs_on: runtime paths: "*.flow" }
      component Db { runs_on: runtime paths: "*.flow" }
      invariant RepositoryBoundary { require flow Api -> Db via Repository }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Api', files: [f] },
    ], artifact, { plugins: [textFlowPlugin] });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingRequireFlowFacts[0]!.path).toEqual(['Api', 'Db']);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('require_flow_violation');
    expect(verdict.violations[0]!.detected.via).toBe('Repository');
  });

  it('enforces query-emitted operation placement requirements', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'serialization.agq.yml'), `
id: SerializationOperations
owner: platform
version: 1
confidence: definite
match:
  kind: call
  method: serialize
emit:
  kind: operation
  operation: serialization
  component: "$subject"
`);
    const f = join(dir, 'ops.ops');
    writeFileSync(f, 'Api serialization\n');

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "*.ops" }
      component Serializer { runs_on: runtime paths: "*.ops" }
      invariant SerializationBoundary {
        require operation serialization in Serializer
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Api', files: [f] },
    ], artifact, { projectRoot: dir, plugins: [serializationGraphPlugin] });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingOperationFacts).toHaveLength(1);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('require_operation_violation');
    expect(verdict.violations[0]!.detected.query?.id).toBe('SerializationOperations');
  });

  it('allows query-emitted operations in the required component', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'serialization.agq.yml'), `
id: SerializationOperations
owner: platform
version: 1
confidence: definite
match:
  kind: call
  method: serialize
emit:
  kind: operation
  operation: serialization
  component: "$subject"
`);
    const f = join(dir, 'ops.ops');
    writeFileSync(f, 'Serializer serialization\n');

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      component Api { runs_on: runtime paths: "*.ops" }
      component Serializer { runs_on: runtime paths: "*.ops" }
      invariant SerializationBoundary {
        require operation serialization in Serializer
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Serializer', files: [f] },
    ], artifact, { projectRoot: dir, plugins: [serializationGraphPlugin] });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingOperationFacts).toHaveLength(1);
    expect(verdict.passed).toBe(true);
  });

  it('blocks definite query-emitted require counterexamples', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'counterexamples.agq.yml'), `
id: CounterexampleFacts
owner: arch
version: 1
confidence: definite
match:
  kind: call
emit:
  kind: auth
  from: Client
  to: Api
  authenticated: false
`);
    writeFileSync(join(dir, '.aglang', 'extractors', 'unencrypted.agq.yml'), `
id: UnencryptedFacts
owner: arch
version: 1
confidence: definite
match:
  kind: call
emit:
  kind: encryption
  from: Api
  to: Partner
  encrypted: false
`);
    writeFileSync(join(dir, '.aglang', 'extractors', 'dependency.agq.yml'), `
id: DependencyFacts
owner: arch
version: 1
confidence: definite
match:
  kind: call
emit:
  kind: dependency
  from: Service
  to: Repository
  interface: ConcreteRepository
`);
    writeFileSync(join(dir, '.aglang', 'extractors', 'operation.agq.yml'), `
id: OperationFacts
owner: arch
version: 1
confidence: definite
match:
  kind: call
emit:
  kind: operation
  operation: serialization
  data: CustomerProfile
  component: Client
`);
    const f = join(dir, 'ops.ops');
    writeFileSync(f, 'Client serialization\n');

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      data CustomerProfile { id: String }
      component Client { runs_on: runtime paths: "*.ops" }
      component Api { runs_on: runtime paths: "*.ops" }
      component Partner { runs_on: runtime paths: "*.ops" }
      component Serializer { runs_on: runtime paths: "*.ops" }
      component Service { runs_on: runtime paths: "*.ops" }
      component Repository { runs_on: runtime paths: "*.ops" }
      invariant Counterexamples {
        require auth on flow Client -> Api
        require encryption on flow Api -> Partner
        require operation serialization on CustomerProfile in Serializer
        require dependency Service -> Repository via interface IOrderRepository
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Client', files: [f] },
    ], artifact, { projectRoot: dir, plugins: [serializationGraphPlugin] });
    const verdict = await runGate(artifact, delta);

    expect(verdict.passed).toBe(false);
    expect(verdict.violations.map(v => v.type)).toEqual(expect.arrayContaining([
      'require_auth_violation',
      'require_encryption_violation',
      'require_operation_violation',
      'require_dependency_violation',
    ]));
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

  it('blocks query-extracted state machine transitions with query provenance', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    const query = join(dir, '.aglang', 'extractors', 'order-transitions.agq.yml');
    writeFileSync(query, `
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
`);
    const source = join(dir, 'orders.ts');
    writeFileSync(source, `
      enum OrderStatus { Draft, Active, Archived }
      function archive(order: { status: OrderStatus }) {
        if (order.status === OrderStatus.Active) {
          order.status = OrderStatus.Archived;
        }
      }
    `);

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum OrderStatus { Draft | Active | Archived }
      data Order { status: OrderStatus }
      component Orders { runs_on: runtime paths: "*.ts" }
      machine OrderLifecycle on Order.status {
        allow transition Draft -> Active
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Orders', files: [source] },
    ], artifact, { projectRoot: dir });

    expect(delta.transitionFacts).toHaveLength(1);
    expect(delta.blockingTransitionFacts[0]!.from).toBe('Active');
    expect(delta.blockingTransitionFacts[0]!.to).toBe('Archived');

    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('state_machine_violation');
    expect(verdict.violations[0]!.detected.query?.id).toBe('OrderLifecycleTransitions');
  });

  it('allows declared query-extracted state machine transitions', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'order-transitions.agq.yml'), `
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
`);
    const source = join(dir, 'orders.ts');
    writeFileSync(source, `
      enum OrderStatus { Draft, Active, Archived }
      function activate(order: { status: OrderStatus }) {
        if (order.status === OrderStatus.Draft) {
          order.status = OrderStatus.Active;
        }
      }
    `);

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum OrderStatus { Draft | Active | Archived }
      data Order { status: OrderStatus }
      component Orders { runs_on: runtime paths: "*.ts" }
      machine OrderLifecycle on Order.status {
        allow transition Draft -> Active
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Orders', files: [source] },
    ], artifact, { projectRoot: dir });

    expect(delta.blockingTransitionFacts).toHaveLength(0);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(true);
  });

  it('blocks explicit denied state machine transitions', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'order-transitions.agq.yml'), `
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
`);
    const source = join(dir, 'orders.ts');
    writeFileSync(source, `
      enum OrderStatus { Draft, Active }
      function regress(order: { status: OrderStatus }) {
        if (order.status === OrderStatus.Active) {
          order.status = OrderStatus.Draft;
        }
      }
    `);

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum OrderStatus { Draft | Active }
      data Order { status: OrderStatus }
      component Orders { runs_on: runtime paths: "*.ts" }
      machine OrderLifecycle on Order.status {
        deny transition Active -> Draft
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Orders', files: [source] },
    ], artifact, { projectRoot: dir });
    const verdict = await runGate(artifact, delta);

    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('state_machine_violation');
  });

  it('blocks unknown-from transitions on allow-only machines when no allow * -> target exists', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'order-transitions.agq.yml'), `
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
`);
    const source = join(dir, 'orders.ts');
    writeFileSync(source, `
      enum OrderStatus { Draft, Active, Archived }
      function archive(order: { status: OrderStatus }) {
        order.status = OrderStatus.Archived;
      }
    `);

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum OrderStatus { Draft | Active | Archived }
      data Order { status: OrderStatus }
      component Orders { runs_on: runtime paths: "*.ts" }
      machine OrderLifecycle on Order.status {
        allow transition Draft -> Active
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Orders', files: [source] },
    ], artifact, { projectRoot: dir });
    const verdict = await runGate(artifact, delta);

    expect(delta.transitionFacts).toHaveLength(1);
    expect(delta.blockingTransitionFacts).toHaveLength(1);
    expect(delta.transitionWarningFacts).toHaveLength(0);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('state_machine_violation');
  });

  it('uses enum-namespaced state constants for machines with shared state names', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum OrderStatus { Active | Closed }
      enum TicketStatus { Active | Closed }
      data Order { status: OrderStatus }
      data Ticket { status: TicketStatus }
      component Orders { runs_on: runtime paths: "orders.ts" }
      component Tickets { runs_on: runtime paths: "tickets.ts" }
      machine OrderLifecycle on Order.status {
        deny transition Active -> Closed
      }
      machine TicketLifecycle on Ticket.status {
        deny transition Active -> Closed
      }
    `);

    const constraints = artifact.constraints.join('\n');
    expect(constraints).toContain('State__OrderStatus__Active');
    expect(constraints).toContain('State__TicketStatus__Active');
  });

  it('extracts C# guarded assignments as blocking transition facts', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'order-transitions.agq.yml'), `
id: OrderLifecycleTransitions
owner: payments
version: 1
confidence: definite
match:
  kind: assignment
  property: Status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: Status
  from: "$previousMember"
  to: "$valueMember"
`);
    const source = join(dir, 'OrderService.cs');
    writeFileSync(source, `
      enum OrderStatus { Draft, Active, Archived }
      class Order { public OrderStatus Status { get; set; } }
      class OrderService {
        void Archive(Order order) {
          if (order.Status == OrderStatus.Active) {
            order.Status = OrderStatus.Archived;
          }
        }
      }
    `);

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum OrderStatus { Draft | Active | Archived }
      data Order { Status: OrderStatus }
      component Orders { runs_on: runtime paths: "*.cs" }
      machine OrderLifecycle on Order.Status {
        allow transition Draft -> Active
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Orders', files: [source] },
    ], artifact, { projectRoot: dir });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingTransitionFacts[0]!.from).toBe('Active');
    expect(delta.blockingTransitionFacts[0]!.to).toBe('Archived');
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.detected.query?.id).toBe('OrderLifecycleTransitions');
  });

  it('extracts Kotlin guarded assignments as blocking transition facts', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    writeFileSync(join(dir, '.aglang', 'extractors', 'order-transitions.agq.yml'), `
id: OrderLifecycleKotlinTransitions
owner: mobile
version: 1
confidence: definite
match:
  extractor: Kotlin regex analyzer
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
`);
    const source = join(dir, 'CheckoutViewModel.kt');
    writeFileSync(source, `
      enum class OrderStatus { Created, PendingPayment, Paid, Fulfilled }
      data class Order(var status: OrderStatus)
      class CheckoutViewModel {
        fun optimisticFulfill(order: Order) {
          if (order.status == OrderStatus.PendingPayment) {
            order.status = OrderStatus.Fulfilled
          }
        }
      }
    `);

    const artifact = compile(`
      node mobile : edge_mobile { trust: untrusted }
      enum OrderStatus { Created | PendingPayment | Paid | Fulfilled }
      data Order { status: OrderStatus }
      component AndroidApp { runs_on: mobile paths: "*.kt" }
      machine OrderLifecycle on Order.status {
        allow transition Created -> PendingPayment
        allow transition PendingPayment -> Paid
        deny transition PendingPayment -> Fulfilled
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'AndroidApp', files: [source] },
    ], artifact, { projectRoot: dir });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingTransitionFacts[0]!.from).toBe('PendingPayment');
    expect(delta.blockingTransitionFacts[0]!.to).toBe('Fulfilled');
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.detected.query?.id).toBe('OrderLifecycleKotlinTransitions');
  });
});
