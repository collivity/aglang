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
  return emitArtifact(program, 'numeric-value-policy-test.ag');
}

// Same line-based test fixture format as tests/rich-policy.test.ts, so numeric/non-numeric
// behavior is exercised through the real extraction -> delta -> gate pipeline, not just the
// compiled artifact's constraints array in isolation.
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
          properties: { subject: parts[1] ?? '', path: parts[2] ?? '', relation: parts[3] ?? '', value: parts[4] ?? '' },
          confidence: 'definite',
          evidence: { extractor: 'test', strategy: 'graph', file, line: index + 1, message: line.trim() },
        });
      }
    }
    return facts;
  },
};

const VALUE_QUERY = `
id: NumericValueFacts
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

describe('numeric value_policy / operation_policy SMT encoding', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempProject(): string {
    const dir = join(tmpdir(), `aglang-numeric-vp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, '.aglang', 'extractors'), { recursive: true });
    return dir;
  }

  it('compiles a numeric requirement to a real FieldValueInt comparison, not an opaque atom', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      data Order { total: Int }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy OrderShape {
        require Order.total <= 1000
      }
    `);
    const block = artifact.constraints.join('\n');
    expect(block).toContain('(declare-const FieldPath__Order__total FieldPath)');
    expect(block).toContain('(assert (=> (> (FieldValueInt Order FieldPath__Order__total) 1000) false))');
    // The negated requirement must not fall back to the opaque atom path.
    expect(block).not.toContain('ValueContradiction Order');
  });

  it('compiles a Float field to FieldValueReal with a real-literal (decimal-point) value', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      data Sensor { reading: Float }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy SensorShape {
        require Sensor.reading < 100
      }
    `);
    const block = artifact.constraints.join('\n');
    expect(block).toContain('(declare-fun FieldValueReal (DataType FieldPath) Real)');
    expect(block).toContain('(assert (=> (>= (FieldValueReal Sensor FieldPath__Sensor__reading) 100.0) false))');
  });

  it('still compiles a non-numeric (enum) requirement through the existing ValueContradiction atom path', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum CartPhase { SingleItem | MultiItem }
      data Cart { phase: CartPhase }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy CartShape {
        require Cart.phase == SingleItem
      }
    `);
    const startIdx = artifact.constraints.findIndex(c => c.includes('value policy rules'));
    const block = artifact.constraints.slice(startIdx, startIdx + 6).join('\n');
    expect(block).toContain('(assert (=> (ValueContradiction Cart FieldPath__Cart__phase Relation__eqeq Value__SingleItem) false))');
    expect(block).not.toContain('FieldValueInt');
    expect(block).not.toContain('FieldValueReal');
  });

  it('detects a real numeric violation end-to-end with a genuine arithmetic z3_proof', async () => {
    const dir = tempProject();
    writeFileSync(join(dir, '.aglang', 'extractors', 'value.agq.yml'), VALUE_QUERY);
    const facts = join(dir, 'checkout.facts');
    writeFileSync(facts, ['value Order total == 1500'].join('\n'));

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      data Order { total: Int }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy OrderShape {
        require Order.total <= 1000
      }
    `);
    const delta = await generateDeltaAssertions(
      [{ componentName: 'Checkout', files: [facts] }],
      artifact,
      { projectRoot: dir, plugins: [graphLinePlugin] },
    );
    const verdict = await runGate(artifact, delta);

    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]!.type).toBe('value_policy_violation');
    expect(verdict.violations[0]!.z3_proof.permanent_constraint).toBe(
      '(assert (=> (> (FieldValueInt Order FieldPath__Order__total) 1000) false))',
    );
    expect(verdict.violations[0]!.z3_proof.delta_assertion).toBe(
      '(assert (= (FieldValueInt Order FieldPath__Order__total) 1500))',
    );

    // The fix that closed this gap: a per-rule solver slice with real isolation, not just one
    // global solve — every other rule family already had this, value_policy didn't.
    const sliceDiag = verdict.solver_diagnostics?.find(d => d.declaration === 'value_policy');
    expect(sliceDiag).toBeDefined();
    expect(sliceDiag!.status).toBe('unsat');
  });

  it('does not flag a numeric fact that satisfies the requirement', async () => {
    const dir = tempProject();
    writeFileSync(join(dir, '.aglang', 'extractors', 'value.agq.yml'), VALUE_QUERY);
    const facts = join(dir, 'checkout.facts');
    writeFileSync(facts, ['value Order total == 500'].join('\n'));

    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      data Order { total: Int }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy OrderShape {
        require Order.total <= 1000
      }
    `);
    const delta = await generateDeltaAssertions(
      [{ componentName: 'Checkout', files: [facts] }],
      artifact,
      { projectRoot: dir, plugins: [graphLinePlugin] },
    );
    const verdict = await runGate(artifact, delta);

    expect(verdict.passed).toBe(true);
    expect(verdict.violations).toHaveLength(0);
  });

  it('joins a numeric requirement with a non-numeric when-condition in one mixed assertion', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      enum CartPhase { SingleItem | MultiItem }
      data Cart { phase: CartPhase items: List<String> }
      component Checkout { runs_on: runtime paths: "*.facts" }
      value_policy CartShape {
        require Cart.items.length == 1 when Cart.phase == SingleItem
      }
    `);
    const block = artifact.constraints.join('\n');
    expect(block).toContain(
      '(assert (=> (and (ValueFact Cart FieldPath__Cart__phase Relation__eqeq Value__SingleItem) ' +
      '(distinct (FieldValueInt Cart FieldPath__Cart__items__length) 1)) false))',
    );
  });

  it('compiles operation_policy numeric requirements to OperationFieldValueInt', () => {
    const artifact = compile(`
      node runtime : agent_runtime { trust: trusted }
      data Order { total: Int }
      component Checkout { runs_on: runtime paths: "*.facts" }
      operation_policy SubmitOrderRules {
        require before submitOrder Order.total >= 0
      }
    `);
    const block = artifact.constraints.join('\n');
    expect(block).toContain(
      '(assert (=> (< (OperationFieldValueInt Operation__submitOrder Phase__before Order FieldPath__Order__total) 0) false))',
    );
  });
});
