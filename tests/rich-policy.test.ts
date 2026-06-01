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
import type { ExtractorPlugin, GraphFact } from '../src/analyzers/plugin.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) throw new Error(errors.map(e => e.message).join('\n'));
  return emitArtifact(program, 'rich-policy-test.ag');
}

const graphLinePlugin: ExtractorPlugin = {
  name: 'test rich policy graph extractor',
  extensions: ['.facts'],
  extractGraph(input): GraphFact[] {
    const facts: GraphFact[] = [];
    for (const file of input.files) {
      for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
        const parts = line.trim().split(/\s+/);
        if (parts.length === 0 || !parts[0]) continue;
        facts.push({
          id: `${file}:${index + 1}`,
          kind: parts[0]!,
          subject: parts[1] ?? input.componentName,
          properties: {
            subject: parts[1] ?? '',
            path: parts[2] ?? '',
            relation: parts[3] ?? '',
            value: parts[4] ?? '',
            operation: parts[5] ?? '',
            phase: parts[6] ?? '',
            event: parts[1] ?? '',
            scope: parts[2] ?? '',
          },
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

describe('rich Z3 policy families', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempProject(): string {
    const dir = join(tmpdir(), `aglang-rich-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    return dir;
  }

  it('parses, checks, and emits rich policy declarations', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum CartPhase { SingleItem | MultiItem }
      enum OrderStatus { Draft | Submitted }
      data Cart { phase: CartPhase items: List<String> }
      data Order { status: OrderStatus total: Money }
      data UserSession { gdprAccepted: Bool }
      data Route { current: String }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy CartShape {
        require Cart.items.length == 1 when Cart.phase == SingleItem
        require Order.total >= 0
      }
      operation_policy SubmitOrderRules {
        require before submitOrder Cart.phase == SingleItem
        ensure after submitOrder Order.status == Submitted
      }
      event_policy ConsentProtocol {
        require event AcceptConsent preceded_by ShowConsent by UserSession
      }
    `);

    expect(artifact.valuePolicies).toHaveLength(1);
    expect(artifact.operationPolicies).toHaveLength(1);
    expect(artifact.eventPolicies).toHaveLength(1);
    expect(artifact.constraints.join('\n')).toContain('ValueContradiction');
    expect(artifact.constraints.join('\n')).toContain('OperationStateContradiction');
    expect(artifact.constraints.join('\n')).toContain('EventMissingPrecedence');
  });

  it('rejects malformed rich policy references', () => {
    const errors = check(parse(tokenize(`
      node runtime : agent_runtime { trust: trusted }
      enum CartPhase { SingleItem | MultiItem }
      data Cart { phase: CartPhase items: List<String> }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy BadValues {
        require Cart.missing == 1
        require Cart.phase == UnknownPhase
        require Cart.phase >= 1
      }
      event_policy BadEvents {
        require event AcceptConsent preceded_by ShowConsent by MissingScope
      }
    `)));

    expect(errors.some(e => e.message.includes("has no field 'missing'"))).toBe(true);
    expect(errors.some(e => e.message.includes("not a value of enum 'CartPhase'"))).toBe(true);
    expect(errors.some(e => e.message.includes("relation '>=' requires numeric field"))).toBe(true);
    expect(errors.some(e => e.message.includes("unknown scope 'MissingScope'"))).toBe(true);
  });

  it('loads value, operation_event, and event query emits', async () => {
    const dir = tempProject();
    writeFileSync(join(dir, '.aglang', 'extractors', 'rich.agq.yml'), `
id: RichFacts
owner: checkout
version: 1
confidence: definite
match:
  kind: value
emit:
  kind: value
  subject: "$subject"
  path: "$path"
  relation: "$relation"
  value: "$value"
`);
    writeFileSync(join(dir, '.aglang', 'extractors', 'operation.agq.yml'), `
id: OperationFacts
owner: checkout
version: 1
confidence: definite
match:
  kind: operation_event
emit:
  kind: operation_event
  operation: "$operation"
  phase: "$phase"
  subject: "$subject"
  path: "$path"
  relation: "$relation"
  value: "$value"
`);
    writeFileSync(join(dir, '.aglang', 'extractors', 'events.agq.yml'), `
id: EventFacts
owner: checkout
version: 1
confidence: definite
match:
  kind: event
emit:
  kind: event
  event: "$event"
  scope: "$scope"
`);
    const facts = join(dir, 'checkout.facts');
    writeFileSync(facts, [
      'value Cart phase == SingleItem',
      'value Cart items.length == 2',
      'operation_event Cart phase == MultiItem submitOrder before',
      'operation_event Order status == Draft submitOrder after',
      'event AcceptConsent UserSession',
    ].join('\n'));

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum CartPhase { SingleItem | MultiItem }
      enum OrderStatus { Draft | Submitted }
      data Cart { phase: CartPhase items: List<String> }
      data Order { status: OrderStatus }
      data UserSession { id: String }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy CartShape {
        require Cart.items.length == 1 when Cart.phase == SingleItem
      }
      operation_policy SubmitOrderRules {
        require before submitOrder Cart.phase == SingleItem
        ensure after submitOrder Order.status == Submitted
      }
      event_policy ConsentProtocol {
        require event AcceptConsent preceded_by ShowConsent by UserSession
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Checkout', files: [facts] },
    ], artifact, { projectRoot: dir, plugins: [graphLinePlugin] });
    const verdict = await runGate(artifact, delta);

    expect(delta.valueFacts).toHaveLength(2);
    expect(delta.operationEventFacts).toHaveLength(2);
    expect(delta.eventFacts).toHaveLength(1);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.map(v => v.type)).toEqual(expect.arrayContaining([
      'value_policy_violation',
      'operation_policy_violation',
      'event_policy_violation',
    ]));
  });

  it('keeps missing evidence non-blocking', async () => {
    const dir = tempProject();
    const facts = join(dir, 'checkout.facts');
    writeFileSync(facts, 'event AcceptConsent UserSession\n');
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum CartPhase { SingleItem | MultiItem }
      data Cart { phase: CartPhase items: List<String> }
      data UserSession { id: String }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy CartShape {
        require Cart.items.length == 1 when Cart.phase == SingleItem
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'Checkout', files: [facts] },
    ], artifact, { projectRoot: dir, plugins: [graphLinePlugin] });
    const verdict = await runGate(artifact, delta);

    expect(delta.blockingValuePolicyFacts).toHaveLength(0);
    expect(verdict.passed).toBe(true);
  });
});
