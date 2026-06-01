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
import { transitionAllowed } from '../src/runtime/state-machine.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'state-machine-wildcard-test.ag');
}

describe('state machine wildcard transitions', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = join(tmpdir(), `aglang-sm-wildcard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    return dir;
  }

  const consentQuery = `
id: ConsentTransitions
owner: compliance
version: 1
confidence: definite
match:
  kind: assignment
  property: consent
  valueEnum: ConsentStatus
emit:
  kind: transition
  data: UserSession
  field: consent
  from: "$previousMember"
  to: "$valueMember"
`;

  it('transitionAllowed rejects unguarded writes when deny * -> target is declared', () => {
    const artifact = compile(`
      enum ConsentStatus { Unknown | Presented | Accepted | Rejected }
      data UserSession { consent: ConsentStatus }
      machine ConsentLifecycle on UserSession.consent {
        allow transition Unknown -> Presented
        allow transition Presented -> Accepted
        deny transition Unknown -> Accepted
      }
    `);
    const machine = artifact.stateMachines[0]!;
    expect(transitionAllowed(machine, { to: 'Accepted' })).toBe(false);
    expect(transitionAllowed(machine, { from: 'Presented', to: 'Accepted' })).toBe(true);
    expect(transitionAllowed(machine, { from: 'Unknown', to: 'Accepted' })).toBe(false);
  });

  it('blocks unguarded consent -> Accepted when deny * -> Accepted is declared', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.aglang', 'extractors', 'consent.agq.yml'), consentQuery);
    const source = join(dir, 'consent.ts');
    writeFileSync(source, `
      enum ConsentStatus { Unknown, Presented, Accepted, Rejected }
      export function acceptWithoutBanner(session: { consent: ConsentStatus }) {
        session.consent = ConsentStatus.Accepted;
      }
    `);

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum ConsentStatus { Unknown | Presented | Accepted | Rejected }
      data UserSession { consent: ConsentStatus }
      component ConsentModule { runs_on: runtime paths: "*.ts" }
      machine ConsentLifecycle on UserSession.consent {
        allow transition Unknown -> Presented
        allow transition Presented -> Accepted
        deny transition Unknown -> Accepted
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'ConsentModule', files: [source] },
    ], artifact, { projectRoot: dir });

    expect(delta.transitionFacts).toHaveLength(1);
    expect(delta.transitionFacts[0]!.from).toBeUndefined();
    expect(delta.blockingTransitionFacts).toHaveLength(1);
    expect(delta.transitionWarningFacts).toHaveLength(0);

    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('state_machine_violation');
  });

  it('blocks allow-only machines when from is unknown and no allow * -> target exists', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.aglang', 'extractors', 'order.agq.yml'), `
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

    expect(delta.blockingTransitionFacts).toHaveLength(1);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('state_machine_violation');
  });
});
