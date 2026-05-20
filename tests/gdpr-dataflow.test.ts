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
  return emitArtifact(program, 'gdpr-test.ag');
}

describe('GDPR classified dataflow semantics', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('blocks EU personal data routed from a load balancer to a non-GDPR service', async () => {
    const dir = join(tmpdir(), `aglang-gdpr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, 'infra'), { recursive: true });
    const lbFile = join(dir, 'infra', 'lb.yaml');
    writeFileSync(lbFile, `
routes:
  - path: /eu/customers
    backend: NonGdprService
`);

    const artifact = compile(`
      node public_lb : load_balancer { trust: trusted }
      node gdpr_container : container { trust: trusted compliance: gdpr }
      node non_gdpr_container : container { trust: semi_trusted compliance: none }

      data CustomerProfile {
        classification: String
        jurisdiction: String
      }

      component LoadBalancer {
        runs_on: public_lb
        paths: "infra/lb.yaml"
        handles: CustomerProfile
      }

      component GdprService {
        runs_on: gdpr_container
        paths: "services/gdpr/**"
        handles: CustomerProfile
      }

      component NonGdprService {
        runs_on: non_gdpr_container
        paths: "services/non-gdpr/**"
      }

      invariant GdprResidency {
        deny dataflow CustomerProfile -> NonGdprService
      }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'LoadBalancer', files: [lbFile] },
    ], artifact);

    expect(delta.facts.some(f => f.from === 'LoadBalancer' && f.to === 'NonGdprService')).toBe(true);
    expect(delta.blockingDataFlowFacts).toHaveLength(1);
    expect(delta.smtAssertions.some(s => s.includes('DataFlow CustomerProfile NonGdprService'))).toBe(true);

    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations[0]!.type).toBe('dataflow_violation');
    expect(verdict.violations[0]!.z3_proof.permanent_constraint).toContain('DataFlow CustomerProfile NonGdprService');
  });

  it('allows the same data routed only to the GDPR service', async () => {
    const dir = join(tmpdir(), `aglang-gdpr-pass-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(join(dir, 'infra'), { recursive: true });
    const lbFile = join(dir, 'infra', 'lb.yaml');
    writeFileSync(lbFile, `
routes:
  - path: /eu/customers
    backend: GdprService
`);

    const artifact = compile(`
      node public_lb : load_balancer { trust: trusted }
      node gdpr_container : container { trust: trusted compliance: gdpr }
      node non_gdpr_container : container { trust: semi_trusted compliance: none }
      data CustomerProfile { classification: String jurisdiction: String }
      component LoadBalancer { runs_on: public_lb paths: "infra/lb.yaml" handles: CustomerProfile }
      component GdprService { runs_on: gdpr_container paths: "services/gdpr/**" handles: CustomerProfile }
      component NonGdprService { runs_on: non_gdpr_container paths: "services/non-gdpr/**" }
      invariant GdprResidency { deny dataflow CustomerProfile -> NonGdprService }
    `);

    const delta = await generateDeltaAssertions([
      { componentName: 'LoadBalancer', files: [lbFile] },
    ], artifact);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(true);
  });
});
