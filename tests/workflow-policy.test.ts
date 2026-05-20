import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { extractGitHubWorkflowFacts } from '../src/analyzers/github-actions.ts';
import { runWorkflowGate } from '../src/runtime/workflow-gate.ts';

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'workflow-test.ag');
}

const SPEC = `
  node github_actions : ci_runner { trust: trusted }
  node npm_registry : package_registry { trust: trusted auth: api_key }
  node github_pages : static_host { trust: trusted auth: oauth2 }
  component ReleaseWorkflow { runs_on: github_actions paths: ".github/workflows/release.yml" }
  component DocsWorkflow { runs_on: github_actions paths: ".github/workflows/docs.yml" }
  workflow_policy ReleaseSafety {
    allow publish ReleaseWorkflow -> npm_registry when tag "v*.*.*"
    allow deploy DocsWorkflow -> github_pages when branch "master"
    deny publish * -> npm_registry when pull_request
    deny deploy * -> github_pages when pull_request
    require before ReleaseWorkflow "npm test" -> "npm publish"
    deny permission * contents: write when pull_request
  }
`;

describe('workflow_policy DSL and gate', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workflowFile(name: string, yaml: string): string {
    const dir = join(tmpdir(), `aglang-workflow-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    const workflows = join(dir, '.github', 'workflows');
    mkdirSync(workflows, { recursive: true });
    const file = join(workflows, name);
    writeFileSync(file, yaml);
    return file;
  }

  it('parses workflow_policy blocks and emits workflowPolicies in architecture.o', () => {
    const artifact = compile(SPEC);
    expect(artifact.workflowPolicies).toHaveLength(1);
    expect(artifact.workflowPolicies[0]!.rules).toHaveLength(6);
  });

  it('rejects unknown workflow components and target nodes', () => {
    const program = parse(tokenize(`
      node github_actions : ci_runner { trust: trusted }
      workflow_policy Bad {
        allow publish MissingWorkflow -> missing_registry when tag "v*"
      }
    `));
    const errors = check(program).map(e => e.message);
    expect(errors.some(e => e.includes('MissingWorkflow'))).toBe(true);
    expect(errors.some(e => e.includes('missing_registry'))).toBe(true);
  });

  it('detects tag-only npm publish and required step order', () => {
    const artifact = compile(SPEC);
    const file = workflowFile('release.yml', `
name: Release
on:
  push:
    tags: ["v*.*.*"]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm publish
`);
    const facts = extractGitHubWorkflowFacts(file, artifact);
    expect(facts.actions[0]!.action).toBe('publish');
    expect(facts.triggers[0]!.tags).toEqual(['v*.*.*']);
    expect(runWorkflowGate(artifact, [file]).violations).toHaveLength(0);
  });

  it('blocks npm publish from a non-release workflow', () => {
    const artifact = compile(SPEC);
    const file = workflowFile('docs.yml', `
on:
  push:
    tags: ["v1.2.3"]
jobs:
  publish:
    steps:
      - run: npm publish
`);
    const result = runWorkflowGate(artifact, [file]);
    expect(result.violations.some(v => v.message.includes('not covered by any matching allow rule'))).toBe(true);
  });

  it('blocks publish and write permissions on pull_request workflows', () => {
    const artifact = compile(SPEC);
    const file = workflowFile('release.yml', `
on: pull_request
permissions:
  contents: write
jobs:
  release:
    steps:
      - run: npm publish
`);
    const result = runWorkflowGate(artifact, [file]);
    expect(result.violations.some(v => v.message.includes('publish to npm_registry is denied'))).toBe(true);
    expect(result.violations.some(v => v.message.includes('contents:write is denied'))).toBe(true);
  });

  it('detects branch docs deploy', () => {
    const artifact = compile(SPEC);
    const file = workflowFile('docs.yml', `
on:
  push:
    branches: ["master"]
jobs:
  deploy:
    steps:
      - uses: peaceiris/actions-gh-pages@v3
`);
    const result = runWorkflowGate(artifact, [file]);
    expect(result.violations).toHaveLength(0);
  });
});
