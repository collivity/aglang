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
  return emitArtifact(program, 'state-machine-guard-test.ag');
}

// Same line-based fixture format as tests/rich-policy.test.ts/numeric-value-policy.test.ts:
// "transition <subject> <field> <from> <to>" or "value <subject> <path> <relation> <value>".
const graphLinePlugin: ExtractorPlugin = {
  name: 'state machine guard test graph extractor',
  extensions: ['.facts'],
  extractGraph(input): GraphFact[] {
    const facts: GraphFact[] = [];
    for (const file of input.files) {
      for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
        const parts = line.trim().split(/\s+/);
        if (parts.length === 0 || !parts[0]) continue;
        const evidence = { extractor: 'test', strategy: 'graph' as const, file, line: index + 1, message: line.trim() };
        if (parts[0] === 'transition') {
          facts.push({
            id: `${file}:${index + 1}`,
            kind: 'transition',
            subject: parts[1] ?? input.componentName,
            properties: { dataSubject: parts[1] ?? '', previousMember: parts[3] ?? '', valueMember: parts[4] ?? '' },
            confidence: 'definite',
            evidence,
          });
        } else if (parts[0] === 'value') {
          facts.push({
            id: `${file}:${index + 1}`,
            kind: 'value',
            subject: parts[1] ?? input.componentName,
            properties: { subject: parts[1] ?? '', path: parts[2] ?? '', relation: parts[3] ?? '', value: parts[4] ?? '' },
            confidence: 'definite',
            evidence,
          });
        }
      }
    }
    return facts;
  },
};

const QUERIES = `
id: OrderTransitions
owner: checkout
version: 1
confidence: definite
match:
  kind: transition
emit:
  kind: transition
  data: "$dataSubject"
  field: status
  from: "$previousMember"
  to: "$valueMember"
---
id: OrderValues
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
`;

const SPEC = `
node runtime : agent_runtime { trust: trusted }
enum OrderStatus { Pending | Shipped }
data Order { status: OrderStatus total: Int }
component Checkout { runs_on: runtime paths: "*.facts" }
machine OrderLifecycle on Order.status {
  deny transition Pending -> Shipped when Order.total > 1000;
  allow transition Pending -> Shipped;
}
`;

describe('guarded state-machine transitions', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempProject(): string {
    const dir = join(tmpdir(), `aglang-sm-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    const [transitionQuery, valueQuery] = QUERIES.split('---');
    writeFileSync(join(dir, '.aglang', 'extractors', 'transition.agq.yml'), transitionQuery!);
    writeFileSync(join(dir, '.aglang', 'extractors', 'value.agq.yml'), valueQuery!);
    return dir;
  }

  async function runWithFacts(dir: string, lines: string[]) {
    const facts = join(dir, 'checkout.facts');
    writeFileSync(facts, lines.join('\n'));
    const artifact = compile(SPEC);
    const delta = await generateDeltaAssertions(
      [{ componentName: 'Checkout', files: [facts] }],
      artifact,
      { projectRoot: dir, plugins: [graphLinePlugin] },
    );
    return runGate(artifact, delta);
  }

  it('compiles the guard to a real combined Transition + FieldValueInt assertion, not two disconnected predicates', () => {
    const artifact = compile(SPEC);
    const start = artifact.constraints.findIndex(c => c.includes('state machine transition rules'));
    const block = artifact.constraints.slice(start, start + 10).join('\n');
    expect(block).toContain(
      '(assert (=> (and (Transition Order Field__Order__status State__OrderStatus__Pending State__OrderStatus__Shipped) ' +
      '(> (FieldValueInt Order FieldPath__Order__total) 1000)) false))',
    );
  });

  it('blocks when a correlated ValueFact satisfies the guard, with a genuine arithmetic z3_proof', async () => {
    const dir = tempProject();
    const verdict = await runWithFacts(dir, [
      'transition Order status Pending Shipped',
      'value Order total == 1500',
    ]);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]!.type).toBe('state_machine_violation');
    expect(verdict.violations[0]!.z3_proof.permanent_constraint).toBe(
      '(assert (=> (and (Transition Order Field__Order__status State__OrderStatus__Pending State__OrderStatus__Shipped) ' +
      '(> (FieldValueInt Order FieldPath__Order__total) 1000)) false))',
    );
    expect(verdict.violations[0]!.z3_proof.delta_assertion).toBe(
      '(assert (Transition Order Field__Order__status State__OrderStatus__Pending State__OrderStatus__Shipped))\n' +
      '(assert (= (FieldValueInt Order FieldPath__Order__total) 1500))',
    );
  });

  it('does not block when no correlated ValueFact exists at all (fail-closed, not "any fact anywhere")', async () => {
    const dir = tempProject();
    const verdict = await runWithFacts(dir, [
      'transition Order status Pending Shipped',
    ]);
    expect(verdict.passed).toBe(true);
    expect(verdict.violations).toHaveLength(0);
  });

  it('does not block when a correlated ValueFact exists but does not satisfy the guard relation', async () => {
    const dir = tempProject();
    const verdict = await runWithFacts(dir, [
      'transition Order status Pending Shipped',
      'value Order total == 500',
    ]);
    expect(verdict.passed).toBe(true);
    expect(verdict.violations).toHaveLength(0);
  });

  it('gets its own isolated solver slice, matching every other rule family', async () => {
    const dir = tempProject();
    const verdict = await runWithFacts(dir, [
      'transition Order status Pending Shipped',
      'value Order total == 1500',
    ]);
    const sliceDiag = verdict.solver_diagnostics?.find(d => d.declaration === 'machine');
    expect(sliceDiag).toBeDefined();
    expect(sliceDiag!.status).toBe('unsat');
  });

  it('documented limitation: correlation is type-level, not instance-level -- an unrelated Order fact satisfying the guard still blocks an unrelated transition', async () => {
    // Two ValueFacts for the same subject "Order" (no instance discriminator exists in this
    // model, the same gap value_policy.when already has) -- one would satisfy the guard, one
    // would not. Because correlation matches by subject+path only, the presence of *any*
    // satisfying fact blocks the transition, even though nothing proves it's "the same" Order
    // that's transitioning. This is the documented limitation (docs/extractors.md), exercised
    // here so it's a known, asserted behavior rather than an undiscovered surprise.
    const dir = tempProject();
    const verdict = await runWithFacts(dir, [
      'transition Order status Pending Shipped',
      'value Order total == 500',
      'value Order total == 1500',
    ]);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toHaveLength(1);
  });
});
