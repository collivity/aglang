import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact, loadArtifact } from '../src/emitters/artifact.ts';
import { runChangeGate } from '../src/runtime/change-gate.ts';
import type { ChangedComponent } from '../src/runtime/diff-parser.ts';
import { formatVerdictJson } from '../src/runtime/diagnostic.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'change-policy-test.ag');
}

const SPEC = `
  node n : agent_runtime { trust: trusted }
  component CliCompiler { runs_on: n paths: "src/index.ts" }
  component CliReferenceDocs { runs_on: n paths: "docs/cli/reference.md" }
  component ReadmeDocs { runs_on: n paths: "README.md" }
  change_policy DocsFreshness {
    require touched CliReferenceDocs when touched CliCompiler
    require touched ReadmeDocs when touched CliCompiler
  }
`;

describe('change_policy DSL and gate', () => {
  it('parses change_policy blocks and emits changePolicies in architecture.o', () => {
    const artifact = compile(SPEC);
    expect(artifact.schemaVersion).toBe(13);
    expect(artifact.changePolicies).toHaveLength(1);
    expect(artifact.enforcement.some(e => e.declaration === 'change_policy' && e.level === 'formal_z3')).toBe(true);
    expect(artifact.changePolicies[0]!.rules).toHaveLength(2);
  });

  it('rejects unknown trigger and required components', () => {
    const program = parse(tokenize(`
      node n : agent_runtime { trust: trusted }
      component CliCompiler { runs_on: n paths: "src/index.ts" }
      change_policy Bad {
        require touched MissingDocs when touched MissingCode
      }
    `));
    const errors = check(program).map(e => e.message);
    expect(errors.some(e => e.includes('MissingDocs'))).toBe(true);
    expect(errors.some(e => e.includes('MissingCode'))).toBe(true);
  });

  it('passes when the trigger component is not touched', async () => {
    const artifact = compile(SPEC);
    const changed: ChangedComponent[] = [
      { componentName: 'ReadmeDocs', files: ['/repo/README.md'] },
    ];
    await expect(runChangeGate(artifact, changed)).resolves.toMatchObject({ violations: [] });
  });

  it('fails when a trigger is touched without required docs', async () => {
    const artifact = compile(SPEC);
    const changed: ChangedComponent[] = [
      { componentName: 'CliCompiler', files: ['/repo/src/index.ts'] },
    ];
    const result = await runChangeGate(artifact, changed);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map(v => v.required).sort()).toEqual(['CliReferenceDocs', 'ReadmeDocs']);
    expect(result.violations[0]!.z3_proof.policy_constraint).toContain('=>');
  });

  it('passes when trigger and required components are touched together', async () => {
    const artifact = compile(SPEC);
    const changed: ChangedComponent[] = [
      { componentName: 'CliCompiler', files: ['/repo/src/index.ts'] },
      { componentName: 'CliReferenceDocs', files: ['/repo/docs/cli/reference.md'] },
      { componentName: 'ReadmeDocs', files: ['/repo/README.md'] },
    ];
    await expect(runChangeGate(artifact, changed)).resolves.toMatchObject({ violations: [] });
  });

  it('loads older artifacts without changePolicies', async () => {
    const artifact = loadArtifact(JSON.stringify({
      schemaVersion: 6,
      sourcePath: 'old.ag',
      constraints: [],
      mappings: {},
      invariants: [],
      nodes: [],
      enums: [],
      dataTypes: [],
      stateMachines: [],
      permissions: [],
      contracts: [],
      componentContracts: [],
      plugins: [],
      repos: [],
      componentRepos: {},
      workflowPolicies: [],
    }));
    await expect(runChangeGate(artifact, [{ componentName: 'Any', files: ['/repo/file'] }])).resolves.toMatchObject({ violations: [] });
  });

  it('includes change_violations in JSON verdicts', async () => {
    const artifact = compile(SPEC);
    const result = await runChangeGate(artifact, [
      { componentName: 'CliCompiler', files: ['/repo/src/index.ts'] },
    ]);
    const json = JSON.parse(formatVerdictJson({
      passed: false,
      violations: [],
      warnings: [],
      change_violations: result.violations,
    }, 'architecture.o'));
    expect(json.passed).toBe(false);
    expect(json.change_violations).toHaveLength(2);
    expect(json.agent_context).toContain('Change violations');
  });
});
