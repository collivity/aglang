#!/usr/bin/env node
// aglc — Architecture Ground Language Compiler CLI

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { resolve, dirname, basename, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { check } from './checker.ts';
import { emitArtifact, writeArtifact, loadArtifact } from './emitters/artifact.ts';
import { emitAgentsMarkdown } from './emitters/agents.ts';
import { emitSkillManifest, writeSkillManifest } from './emitters/skill.ts';
import { loadAndMerge, ImportError } from './importer.ts';
import { parseDiff, parseDiffAgainst, parseProjectFiles, type ChangedComponent, type DiffSelection } from './runtime/diff-parser.ts';
import { generateDeltaAssertions } from './runtime/delta-assert.ts';
import { runGate } from './runtime/gate.ts';
import { runContractGate } from './runtime/contract-gate.ts';
import { runWorkflowGate, workflowDebugPathForArch } from './runtime/workflow-gate.ts';
import { runChangeGate } from './runtime/change-gate.ts';
import { formatVerdict, formatVerdictJson } from './runtime/diagnostic.ts';
import type { ArchitectureArtifact } from './emitters/artifact.ts';
import { generateSpec } from './generate.ts';

const args = process.argv.slice(2);
const command = args[0];
const jsonMode = args.includes('--json');
const debugExtractors = args.includes('--debug-extractors');
const requireAst = args.includes('--require-ast');

// In JSON mode, progress logs go to stderr so stdout stays machine-parseable
const log = jsonMode
  ? (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n')
  : console.log.bind(console);
const logErr = console.error.bind(console);

function usage() {
  console.log(`
aglc — Architecture Ground Language Compiler

Commands:
  aglc request-scan [--project <dir>] [--out <task.json>]       Emit an agent task packet for architecture evidence scanning
  aglc request-review [--project <dir>] [--out <task.json>]     Emit an agent task packet for architecture/spec/query review
  aglc add [projectRoot] [--name <n>] [--out <file.ag>] [--max-depth <n>] [--single-file]     Legacy starter: generate draft → compile → skill.json
  aglc compile <file.ag> [--out <arch.o>]                    Compile .ag spec → architecture.o
  aglc generate [projectRoot] [--out <file.ag>] [--max-depth <n>] [--single-file]  Legacy draft generator; review before use
  aglc emit-context --arch <arch.o> [--out <path>]          Emit AGENTS.md for AI agents
  aglc emit-skill   --arch <arch.o> [--out <path>]          Emit skill.json manifest for AI agents
  aglc install-agent-skill [--path <skills-dir>]            Install packaged aglang Codex skill for local agents
  aglc check --arch <arch.o> --project <dir> [--repo-filter <Name>] [--diff <ref>] [--all] [--json] [--debug-extractors] [--require-ast]  Check staged, ref diff, or whole project vs architecture
  aglc check-file --arch <arch.o> --file <f> [--json] [--dump-smt] [--workflow-z3] [--dump-workflow-smt] [--debug-extractors] [--require-ast]  Analyze a specific file
  aglc explain --arch <arch.o> --project <dir> --violation <id> [--json] [--diff <ref>] [--all]  Explain a violation from the current check scope
  aglc graph --arch <arch.o> [--file <f> | --project <dir>] [--json] [--debug-extractors] [--require-ast]  Emit graph facts and Z3 flow projections
  aglc debug --arch <arch.o> --project <dir> [--file <f>] [--diff <ref>] [--all] [--out <dir>] [--debug-extractors]  Write debug bundle for agents and engineers
  aglc import-openapi <swagger.json> [--out <file.ag>]       Import OpenAPI 3.x spec → .ag contracts
  aglc import-tf <main.tf> [--out <file.ag>]                Import Terraform → .ag node declarations

Flags:
  --json      Output machine-readable JSON to stdout; progress logs go to stderr
  --max-depth       Maximum recursive component synthesis depth for generate/add (default: 3)
  --single-file     Inline generated components instead of emitting imported sub-specs
  --debug-extractors   Include extractor trace output and fallback reasons
  --require-ast        Fail when an AST-capable extractor falls back to regex for a detected fact
  --diff <ref>         Check files changed in git range <ref>...HEAD and mark reported violations as new
  --dump-smt           Write the full SMT-LIB script fed to Z3 → examples/debug.smt2
  --workflow-z3        Include workflow policy SMT debug snippets in verdicts
  --dump-workflow-smt  Write workflow policy SMT debug snippets → workflow-debug.smt2
`);
  process.exit(1);
}

function extractorErrorJson(archPath: string, message: string): string {
  return JSON.stringify({
    schema_version: 2,
    passed: false,
    timestamp: new Date().toISOString(),
    artifact: archPath,
    violations: [],
    contract_violations: [],
    workflow_violations: [],
    change_violations: [],
    warnings: [],
    contract_warnings: [],
    workflow_warnings: [],
    extractor_error: message,
    agent_context: `Extractor failure: ${message}`,
  }, null, 2);
}

async function componentForFile(artifact: ArchitectureArtifact, absFile: string): Promise<string | undefined> {
  const { default: micromatch } = await import('micromatch');
  for (const [comp, glob] of Object.entries(artifact.mappings)) {
    if (micromatch.isMatch(absFile, `**/${glob}`) || micromatch.isMatch(absFile, glob)) {
      return comp;
    }
  }

  for (const [comp, glob] of Object.entries(artifact.mappings)) {
    const keyword = glob.split('/').find(p => p && !p.includes('*'));
    if (keyword && absFile.includes(keyword)) {
      return comp;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// COMPILE
// ─────────────────────────────────────────────────────────────
async function compile(agPath: string, outOverride?: string) {
  const absPath = resolve(agPath);
  if (!existsSync(absPath)) {
    logErr(`Error: file not found: ${absPath}`);
    process.exit(1);
  }

  log(`[aglc] Resolving imports for ${basename(absPath)}...`);
  let ast;
  try {
    ast = loadAndMerge(absPath);
  } catch (e) {
    if (e instanceof ImportError) {
      logErr(`\n${e.message}`);
    } else {
      logErr(`\nParse error: ${(e as Error).message}`);
    }
    process.exit(1);
  }

  log(`[aglc] Type checking...`);
  const errors = check(ast);
  if (errors.length > 0) {
    logErr('\nType check errors:');
    for (const e of errors) {
      logErr(`  ✗ ${e.message}`);
    }
    process.exit(1);
  }

  log(`[aglc] Translating to SMT-LIB...`);
  const artifact = emitArtifact(ast, absPath);

  const outPath = resolve(outOverride ?? resolve(dirname(absPath), 'architecture.o'));
  try {
    writeArtifact(artifact, outPath);
  } catch (e) {
    logErr(`Error: could not write architecture artifact: ${outPath}`);
    logErr(`  ${(e as Error).message}`);
    logErr(`  Try a writable output path with: aglc compile ${agPath} --out <path>`);
    process.exit(1);
  }

  log(`\n✓ Compiled successfully → ${outPath}`);
  log(`  Components: ${Object.keys(artifact.mappings).length}`);
  log(`  Invariants: ${artifact.invariants.length}`);
  log(`  State machines: ${artifact.stateMachines.length}`);
  log(`  Permissions: ${artifact.permissions.length}`);
  log(`  Contracts: ${(artifact.contracts ?? []).length}`);
  log(`  Repos: ${(artifact.repos ?? []).length}`);
  log(`  SMT-LIB constraints: ${artifact.constraints.filter(s => s.startsWith('(')).length}`);
  if ((artifact.repos ?? []).length > 0) {
    log(`\n  Multi-repo components:`);
    for (const [comp, repoName] of Object.entries(artifact.componentRepos ?? {})) {
      const repoInfo = (artifact.repos ?? []).find(r => r.name === repoName);
      log(`    ${comp} → ${repoName} (${repoInfo?.url ?? 'unknown'})`);
    }
    log(`\n  To enforce in each repo's CI, see: https://collivity.github.io/aglang/guide/multi-repo`);
  }
}

// ─────────────────────────────────────────────────────────────
// EMIT-CONTEXT (AGENTS.md)
// ─────────────────────────────────────────────────────────────
function emitContext(archPath: string, outPath: string) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }

  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  const md = emitAgentsMarkdown(artifact);
  writeFileSync(outPath, md, 'utf8');
  log(`✓ Emitted context → ${outPath}`);
  log(`  Nodes: ${(artifact.nodes ?? []).length}, Components: ${Object.keys(artifact.mappings).length}`);
  log(`  Invariants: ${artifact.invariants.length}, State machines: ${(artifact.stateMachines ?? []).length}, Permissions: ${(artifact.permissions ?? []).length}`);
  log(`  Enums: ${(artifact.enums ?? []).length}, Data types: ${(artifact.dataTypes ?? []).length}`);
}

// ─────────────────────────────────────────────────────────────
// EMIT-SKILL (skill.json)
// ─────────────────────────────────────────────────────────────
function emitSkill(archPath: string, outPath: string) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }

  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  const manifest = emitSkillManifest(artifact, archPath);
  writeSkillManifest(manifest, outPath);
  log(`✓ Emitted skill manifest → ${outPath}`);
  log(`  Skill: ${manifest.skill} v${manifest.version}`);
  log(`  Use 'check_file' command in your agent to validate files before committing.`);
}

// ─────────────────────────────────────────────────────────────
// CHECK (git diff mode)
// ─────────────────────────────────────────────────────────────
function buildDiffSelection(absProject: string, changed: ChangedComponent[], mode: DiffSelection['mode'], base: string): DiffSelection {
  return {
    base,
    mode,
    changed_files: changed.flatMap(c => c.files.map(file => relative(absProject, file).replace(/\\/g, '/'))),
    changed_components: changed.map(c => c.componentName),
  };
}

function buildRuleCoverage(artifact: ArchitectureArtifact, changed: ChangedComponent[], delta: Awaited<ReturnType<typeof generateDeltaAssertions>>) {
  const changedComponents = new Set(changed.map(c => c.componentName));
  const coverage: Array<{ rule: string; declaration: string; components: string[]; evidence: string[] }> = [];
  for (const invariant of artifact.invariants ?? []) {
    const components = new Set<string>();
    const evidence: string[] = [];
    for (const rule of invariant.rules) {
      const values = rule.kind === 'DenyDataFlow'
        ? [rule.to]
        : rule.kind === 'RequireDataFlowVia'
          ? [rule.to, rule.via]
        : rule.kind === 'RequireOperationIn' || rule.kind === 'RequireOperationOnDataIn' || rule.kind === 'RequireContractImplementedBy'
          ? [rule.component]
        : rule.kind === 'RequireFlowVia'
          ? [rule.from, rule.to, rule.via]
        : rule.kind === 'RequireDependencyViaInterface'
          ? [rule.from, rule.to]
          : [rule.from, rule.to];
      if (values.some(v => changedComponents.has(v))) {
        values.forEach(v => { if (changedComponents.has(v)) components.add(v); });
      }
    }
    for (const fact of [...delta.facts, ...delta.reachFacts]) {
      if (fact.from && fact.to && invariant.rules.some(rule =>
        rule.kind !== 'DenyDataFlow' &&
        rule.kind !== 'RequireOperationIn' &&
        rule.kind !== 'RequireOperationOnDataIn' &&
        rule.kind !== 'RequireContractImplementedBy' &&
        rule.kind !== 'RequireDataFlowVia' &&
        rule.from === fact.from &&
        rule.to === fact.to
      )) {
        components.add(fact.from);
        components.add(fact.to);
        evidence.push(fact.evidence);
      }
    }
    if (components.size > 0 || evidence.length > 0) {
      coverage.push({ rule: invariant.name, declaration: 'invariant', components: [...components], evidence: [...new Set(evidence)].slice(0, 5) });
    }
  }
  for (const policy of artifact.changePolicies ?? []) {
    const components = new Set<string>();
    for (const rule of policy.rules) {
      if (changedComponents.has(rule.trigger) || changedComponents.has(rule.required)) {
        components.add(rule.trigger);
        components.add(rule.required);
      }
    }
    if (components.size > 0) {
      coverage.push({ rule: policy.name, declaration: 'change_policy', components: [...components], evidence: ['changed component set'] });
    }
  }
  for (const policy of artifact.diPolicies ?? []) {
    const components = new Set<string>();
    for (const fact of delta.diFacts) {
      if (policy.rules.some(rule => 'from' in rule && rule.from === fact.from)) {
        components.add(fact.from);
        if ('to' in fact) components.add(fact.to);
      }
    }
    if (components.size > 0) {
      coverage.push({ rule: policy.name, declaration: 'di_policy', components: [...components], evidence: delta.diFacts.map(f => f.evidence).slice(0, 5) });
    }
  }
  return coverage;
}

function annotateBaselineStatus(payload: Record<string, unknown>, status: 'new' | 'existing' | 'resolved' | 'unchanged'): void {
  for (const key of ['violations', 'contract_violations', 'workflow_violations', 'change_violations']) {
    const items = payload[key];
    if (Array.isArray(items)) {
      payload[key] = items.map(item => typeof item === 'object' && item ? { ...item, status } : item);
    }
  }
}

async function checkDiff(archPath: string, projectRoot: string, repoFilter?: string, all = false, diffBase?: string) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }

  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  const absProject = resolve(projectRoot);

  // When --repo-filter is given, only examine components mapped to that repo
  const repoComponents = repoFilter
    ? new Set(
        Object.entries(artifact.componentRepos ?? {})
          .filter(([, repo]) => repo === repoFilter)
          .map(([comp]) => comp)
      )
    : null;

  if (repoFilter && repoComponents!.size === 0) {
    const declared = (artifact.repos ?? []).map(r => r.name).join(', ') || '(none)';
    logErr(`[aglc] Error: --repo-filter "${repoFilter}" does not match any declared repo. Declared: ${declared}`);
    process.exit(1);
  }

  if (repoFilter) {
    log(`[aglc] Repo filter: ${repoFilter} (components: ${[...repoComponents!].join(', ')})`);
  }

  const mode: DiffSelection['mode'] = all ? 'all' : diffBase ? 'git_ref' : 'staged';
  log(all
    ? `[aglc] Scanning all tracked component files in ${absProject}...`
    : diffBase
      ? `[aglc] Parsing git diff ${diffBase}...HEAD in ${absProject}...`
      : `[aglc] Parsing git diff in ${absProject}...`);
  let changed = all
    ? parseProjectFiles(absProject, artifact)
    : diffBase
      ? parseDiffAgainst(absProject, artifact, diffBase)
      : parseDiff(absProject, artifact);

  if (repoComponents) {
    changed = changed.filter(c => repoComponents.has(c.componentName));
  }

  if (changed.length === 0) {
    const msg = all
      ? 'No files matched tracked components. Check allowed.'
      : diffBase
        ? `No files changed against ${diffBase}...HEAD in tracked components. Check allowed.`
        : 'No staged changes in tracked components. Commit allowed.';
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ schema_version: 2, passed: true, violations: [], contract_violations: [], workflow_violations: [], change_violations: [], warnings: [], contract_warnings: [], workflow_warnings: [], timestamp: new Date().toISOString(), artifact: archPath, diff: buildDiffSelection(absProject, changed, mode, diffBase ?? (all ? 'workspace' : 'staged')), rule_coverage: [], agent_context: msg }, null, 2) + '\n');
    } else {
      log(`[aglc] ${msg}`);
    }
    process.exit(0);
  }

  log(`[aglc] Changed components: ${changed.map(c => c.componentName).join(', ')}`);
  log(`[aglc] Generating delta assertions...`);
  let delta;
  try {
    delta = await generateDeltaAssertions(changed, artifact, { debugExtractors, requireAst, projectRoot: absProject });
  } catch (error) {
    const message = (error as Error).message;
    if (jsonMode) {
      process.stdout.write(extractorErrorJson(archPath, message) + '\n');
    } else {
      logErr(`[aglc] Extractor failure: ${message}`);
    }
    process.exit(1);
  }

  // Run contract gate for all changed files (with completeness check since we have projectRoot)
  const allChangedFiles = changed.flatMap(c => c.files);
  const contractResult = await runContractGate(artifact, allChangedFiles, {
    projectRoot: absProject,
    checkCompleteness: true,
  });
  const workflowResult = runWorkflowGate(artifact, allChangedFiles, {
    projectRoot: absProject,
    workflowZ3: args.includes('--workflow-z3'),
    dumpWorkflowSmt: args.includes('--dump-workflow-smt') ? workflowDebugPathForArch(archPath) : undefined,
  });
  const changeResult = await runChangeGate(artifact, changed);

  if (
    delta.blockingFacts.length === 0 &&
    delta.blockingReachFacts.length === 0 &&
    delta.blockingDataFlowFacts.length === 0 &&
    delta.blockingTrustPolicyFacts.length === 0 &&
    delta.blockingDiFacts.length === 0 &&
    delta.blockingPermissionFacts.length === 0 &&
    delta.blockingTransitionFacts.length === 0 &&
    delta.warningFacts.length === 0 &&
    delta.transitionWarningFacts.length === 0 &&
    contractResult.violations.length === 0 &&
    workflowResult.violations.length === 0 &&
    changeResult.violations.length === 0
  ) {
    const msg = 'No architectural violations detected. Commit allowed.';
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        schema_version: 2,
        passed: true,
        violations: [],
        contract_violations: [],
        workflow_violations: [],
        change_violations: [],
        warnings: [],
        contract_warnings: contractResult.warnings,
        workflow_warnings: workflowResult.warnings,
        timestamp: new Date().toISOString(),
        artifact: archPath,
        diff: buildDiffSelection(absProject, changed, mode, diffBase ?? (all ? 'workspace' : 'staged')),
        rule_coverage: buildRuleCoverage(artifact, changed, delta),
        ...(debugExtractors ? { extractor_debug: delta.extractorDebug } : {}),
        agent_context: msg,
      }, null, 2) + '\n');
    } else {
      if (contractResult.warnings.length > 0) {
        console.log(formatVerdict({
          passed: true, violations: [], warnings: [],
          contract_violations: [], contract_warnings: contractResult.warnings,
        }));
      } else {
        log(`[aglc] ${msg}`);
      }
    }
    process.exit(0);
  }

  log(`[aglc] Running Z3 solver...`);
  const verdict = await runGate(artifact, delta);

  verdict.contract_violations = contractResult.violations;
  verdict.contract_warnings = contractResult.warnings;
  verdict.workflow_violations = workflowResult.violations;
  verdict.workflow_warnings = workflowResult.warnings;
  verdict.change_violations = changeResult.violations;
  verdict.passed = verdict.passed && contractResult.violations.length === 0 && workflowResult.violations.length === 0 && changeResult.violations.length === 0;

  if (jsonMode) {
    const payload = JSON.parse(formatVerdictJson(verdict, archPath)) as Record<string, unknown>;
    payload.diff = buildDiffSelection(absProject, changed, mode, diffBase ?? (all ? 'workspace' : 'staged'));
    payload.rule_coverage = buildRuleCoverage(artifact, changed, delta);
    annotateBaselineStatus(payload, diffBase ? 'new' : 'unchanged');
    if (debugExtractors) payload.extractor_debug = delta.extractorDebug;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    console.log(formatVerdict(verdict));
  }
  process.exit(verdict.passed ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────
// CHECK-FILE (single file, for testing/debugging)
// ─────────────────────────────────────────────────────────────
async function checkFile(archPath: string, filePath: string) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    logErr(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const dumpSmt = args.includes('--dump-smt');
  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  const absFile = resolve(filePath);

  if ((artifact.workflowPolicies ?? []).length > 0 && /\.github[\\/]+workflows[\\/]+[^\\/]+\.ya?ml$/i.test(absFile)) {
    const workflowResult = runWorkflowGate(artifact, [absFile], {
      workflowZ3: args.includes('--workflow-z3'),
      dumpWorkflowSmt: args.includes('--dump-workflow-smt') ? workflowDebugPathForArch(archPath) : undefined,
    });
    const passed = workflowResult.violations.length === 0;
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        schema_version: 2,
        passed,
        violations: [],
        contract_violations: [],
        workflow_violations: workflowResult.violations,
        change_violations: [],
        warnings: [],
        contract_warnings: [],
        workflow_warnings: workflowResult.warnings,
        timestamp: new Date().toISOString(),
        artifact: archPath,
        agent_context: passed ? 'Workflow policy check passed.' : `${workflowResult.violations.length} workflow violation(s) detected.`,
      }, null, 2) + '\n');
    } else {
      console.log(formatVerdict({
        passed,
        violations: [],
        warnings: [],
        contract_violations: [],
        contract_warnings: [],
        workflow_violations: workflowResult.violations,
        workflow_warnings: workflowResult.warnings,
        change_violations: [],
      }));
    }
    process.exit(passed ? 0 : 1);
  }

  const componentName = await componentForFile(artifact, absFile);

  if (!componentName) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ schema_version: 2, passed: true, violations: [], contract_violations: [], workflow_violations: [], change_violations: [], warnings: [], contract_warnings: [], workflow_warnings: [], timestamp: new Date().toISOString(), artifact: archPath, agent_context: `File does not belong to any tracked component: ${absFile}` }, null, 2) + '\n');
    } else {
      log(`[aglc] File does not belong to any tracked component: ${absFile}`);
    }
    process.exit(0);
  }

  log(`[aglc] Analyzing ${absFile}`);
  log(`[aglc] Component: ${componentName}`);

  let delta;
  try {
    delta = await generateDeltaAssertions(
      [{ componentName, files: [absFile] }],
      artifact,
      { debugExtractors, requireAst, projectRoot: process.cwd() },
    );
  } catch (error) {
    const message = (error as Error).message;
    if (jsonMode) {
      process.stdout.write(extractorErrorJson(archPath, message) + '\n');
    } else {
      logErr(`[aglc] Extractor failure: ${message}`);
    }
    process.exit(1);
  }

  // Run contract gate (if any contracts are declared)
  const contractResult = await runContractGate(artifact, [absFile]);
  const workflowResult = runWorkflowGate(artifact, [absFile], {
    workflowZ3: args.includes('--workflow-z3'),
    dumpWorkflowSmt: args.includes('--dump-workflow-smt') ? workflowDebugPathForArch(archPath) : undefined,
  });
  if (contractResult.violations.length > 0 || contractResult.warnings.length > 0) {
    log(`[aglc] Contract check: ${contractResult.violations.length} violation(s), ${contractResult.warnings.length} warning(s)`);
  }

  if (delta.facts.length === 0 && delta.diFacts.length === 0 && delta.transitionFacts.length === 0 && contractResult.violations.length === 0 && workflowResult.violations.length === 0) {
    if (contractResult.warnings.length > 0) {
      // Pass but show warnings
    } else {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({
          schema_version: 2,
          passed: true,
          violations: [],
          contract_violations: [],
          workflow_violations: [],
          change_violations: [],
          warnings: [],
          contract_warnings: [],
          workflow_warnings: [],
          timestamp: new Date().toISOString(),
          artifact: archPath,
          ...(debugExtractors ? { extractor_debug: delta.extractorDebug } : {}),
          agent_context: 'No architectural flow patterns detected.',
        }, null, 2) + '\n');
      } else {
        log(`[aglc] No architectural flow patterns detected. ✓`);
      }
      process.exit(0);
    }
  }

  if (delta.facts.length > 0) {
    log(`[aglc] Detected flows:`);
    for (const f of delta.facts) {
      const tag = f.confidence === 'definite' ? '🔴' : f.confidence === 'probable' ? '🟡' : '⚪';
      log(`  ${tag} [${f.confidence}] ${f.from} → ${f.to}: ${f.evidence}`);
    }
  }

  if (delta.diFacts.length > 0) {
    log(`[aglc] Detected dependency injection facts:`);
    for (const f of delta.diFacts) {
      const target = f.kind === 'resolve' ? f.service : f.to;
      log(`  🔴 [${f.confidence}] ${f.kind} ${f.from} → ${target}: ${f.evidence}`);
    }
  }

  if (delta.transitionFacts.length > 0) {
    log(`[aglc] Detected state-machine transition facts:`);
    for (const f of delta.transitionFacts) {
      const tag = f.confidence === 'definite' ? '🔴' : f.confidence === 'probable' ? '🟡' : '⚪';
      log(`  ${tag} [${f.confidence}] ${f.data}.${f.field} ${f.from ?? '*'} → ${f.to}: ${f.evidence}`);
    }
  }

  // Dump full SMT-LIB script to file if requested
  if (dumpSmt) {
    const smtScript = [...artifact.constraints, '', ...delta.smtAssertions].join('\n');
    const smtPath = resolve(dirname(archPath), 'debug.smt2');
    writeFileSync(smtPath, smtScript, 'utf8');
    log(`[aglc] SMT-LIB script written → ${smtPath}`);
  }

  log(`[aglc] Running Z3 solver...`);
  const verdict = await runGate(artifact, delta);

  // Merge contract gate results into verdict
  verdict.contract_violations = contractResult.violations;
  verdict.contract_warnings = contractResult.warnings;
  verdict.workflow_violations = workflowResult.violations;
  verdict.workflow_warnings = workflowResult.warnings;
  verdict.change_violations = [];
  verdict.passed = verdict.passed && contractResult.violations.length === 0 && workflowResult.violations.length === 0;

  if (jsonMode) {
    const payload = JSON.parse(formatVerdictJson(verdict, archPath)) as Record<string, unknown>;
    if (debugExtractors) payload.extractor_debug = delta.extractorDebug;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    console.log(formatVerdict(verdict));
  }
  process.exit(verdict.passed ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────
// EXPLAIN (stable violation lookup)
// ─────────────────────────────────────────────────────────────
function fixClassForViolation(type: string): string {
  if (type === 'change_violation') return 'add_companion_change';
  if (type === 'permission_violation') return 'fix_auth_policy';
  if (type === 'state_machine_violation') return 'fix_state_transition';
  if (type === 'di_violation') return 'move_registration';
  if (type === 'trust_policy_violation' || type === 'data_policy_violation') return 'fix_auth_policy';
  return 'move_dependency';
}

function suggestedFixForViolation(v: Record<string, unknown>): string {
  const type = String(v.type ?? '');
  if (type === 'change_violation') {
    return `Touch the required companion component '${String(v.required ?? '')}' in the same checked diff, or revise the change_policy only with explicit architecture approval.`;
  }
  const detected = (v.detected && typeof v.detected === 'object') ? v.detected as Record<string, unknown> : {};
  if (type === 'state_machine_violation') {
    return `Move the state assignment in ${String(detected.file ?? '')} to a declared transition path, or update the machine declaration with approval.`;
  }
  if (type === 'permission_violation' || type === 'trust_policy_violation') {
    return `Add or correct the required authentication/authorization evidence near ${String(detected.file ?? '')}, or update the declared policy with approval.`;
  }
  if (type === 'di_violation') {
    return `Move the DI registration or constructor dependency so '${String(detected.from ?? '')}' no longer depends on '${String(detected.to ?? '')}'.`;
  }
  return `Remove or invert the dependency from '${String(detected.from ?? '')}' to '${String(detected.to ?? '')}', or move the code behind an allowed component boundary.`;
}

async function explainViolation(archPath: string, projectRoot: string, violationId: string, all = false, diffBase?: string) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }
  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  const absProject = resolve(projectRoot);
  const mode: DiffSelection['mode'] = all ? 'all' : diffBase ? 'git_ref' : 'staged';
  const changed = all
    ? parseProjectFiles(absProject, artifact)
    : diffBase
      ? parseDiffAgainst(absProject, artifact, diffBase)
      : parseDiff(absProject, artifact);

  let delta;
  try {
    delta = await generateDeltaAssertions(changed, artifact, { debugExtractors, requireAst, projectRoot: absProject });
  } catch (error) {
    const message = (error as Error).message;
    if (jsonMode) process.stdout.write(extractorErrorJson(archPath, message) + '\n');
    else logErr(`[aglc] Extractor failure: ${message}`);
    process.exit(1);
  }

  const allChangedFiles = changed.flatMap(c => c.files);
  const contractResult = await runContractGate(artifact, allChangedFiles, { projectRoot: absProject, checkCompleteness: true });
  const workflowResult = runWorkflowGate(artifact, allChangedFiles, {
    projectRoot: absProject,
    workflowZ3: args.includes('--workflow-z3'),
    dumpWorkflowSmt: args.includes('--dump-workflow-smt') ? workflowDebugPathForArch(archPath) : undefined,
  });
  const changeResult = await runChangeGate(artifact, changed);
  const verdict = await runGate(artifact, delta);
  verdict.contract_violations = contractResult.violations;
  verdict.workflow_violations = workflowResult.violations;
  verdict.change_violations = changeResult.violations;

  const allViolations = [
    ...verdict.violations,
    ...changeResult.violations,
    ...contractResult.violations,
    ...workflowResult.violations,
  ] as unknown as Array<Record<string, unknown>>;
  const found = allViolations.find(v => v.id === violationId);
  if (!found) {
    const payload = {
      schema_version: 2,
      found: false,
      violation_id: violationId,
      diff: buildDiffSelection(absProject, changed, mode, diffBase ?? (all ? 'workspace' : 'staged')),
      message: `No violation with id '${violationId}' was found in the selected check scope.`,
    };
    if (jsonMode) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else logErr(payload.message);
    process.exit(2);
  }

  const explanation = {
    schema_version: 2,
    found: true,
    violation_id: violationId,
    type: found.type,
    rule: found.invariant ?? found.policy ?? found.contract,
    declaration: found.type === 'change_violation' ? 'change_policy' : found.type === 'workflow_violation' ? 'workflow_policy' : found.type === 'contract_violation' ? 'contract' : 'invariant_or_policy',
    spec_citation: artifact.sourcePath,
    source: (found.detected && typeof found.detected === 'object')
      ? {
          file: (found.detected as Record<string, unknown>).file,
          line: (found.graph_evidence as Record<string, unknown> | undefined)?.line,
          evidence: (found.detected as Record<string, unknown>).evidence,
        }
      : { evidence: found.evidence ?? found.message },
    graph_fact_chain: (found.graph_evidence ? [found.graph_evidence] : []),
    z3_proof: found.z3_proof ?? found.proof ?? null,
    fix_class: fixClassForViolation(String(found.type ?? '')),
    suggested_fix: suggestedFixForViolation(found),
    diff: buildDiffSelection(absProject, changed, mode, diffBase ?? (all ? 'workspace' : 'staged')),
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(explanation, null, 2) + '\n');
  } else {
    console.log(`Violation ${violationId}`);
    console.log(`Type: ${String(explanation.type)}`);
    console.log(`Rule: ${String(explanation.rule)}`);
    console.log(`Fix class: ${explanation.fix_class}`);
    console.log(`Suggested fix: ${explanation.suggested_fix}`);
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// INSTALL-AGENT-SKILL (generic Codex skill shipped with npm package)
// ─────────────────────────────────────────────────────────────
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function defaultSkillsDir(): string {
  const codexHome = process.env.CODEX_HOME;
  const userProfile = process.env.USERPROFILE;
  const home = process.env.HOME;
  return resolve(codexHome ?? (userProfile ? resolve(userProfile, '.codex') : resolve(home ?? '.', '.codex')), 'skills');
}

function installAgentSkill(outDir: string) {
  const source = resolve(packageRoot(), 'skills', 'aglang');
  if (!existsSync(source)) {
    logErr(`Error: packaged aglang skill not found at ${source}`);
    logErr(`Reinstall @collivity/aglang or run from a complete package.`);
    process.exit(1);
  }

  const target = resolve(outDir, 'aglang');
  mkdirSync(outDir, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  log(`✓ Installed aglang agent skill → ${target}`);
  log(`  Agents that discover ${outDir} can now load the aglang interface automatically when relevant.`);
}

// ─────────────────────────────────────────────────────────────
// GRAPH (debug graph projection output)
// ─────────────────────────────────────────────────────────────
async function graphCommand(archPath: string, filePath: string | undefined, projectRoot: string | undefined) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }

  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  let changed;
  let graphProjectRoot = process.cwd();

  if (filePath) {
    if (!existsSync(filePath)) {
      logErr(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    const absFile = resolve(filePath);
    const componentName = await componentForFile(artifact, absFile);
    if (!componentName) {
      const empty = {
        facts: [],
        projections: { flow: [] },
        smt: { assertions: ['; === delta assertions from graph projections ==='] },
        unresolvedTargets: [],
        warnings: [{ graphFactId: '', message: `File does not belong to any tracked component: ${absFile}` }],
      };
      process.stdout.write(JSON.stringify(empty, null, 2) + '\n');
      process.exit(0);
    }
    changed = [{ componentName, files: [absFile] }];
  } else {
    const absProject = resolve(projectRoot ?? '.');
    graphProjectRoot = absProject;
    changed = args.includes('--all')
      ? parseProjectFiles(absProject, artifact)
      : parseDiff(absProject, artifact);
  }

  let delta;
  try {
    delta = await generateDeltaAssertions(changed, artifact, { debugExtractors, requireAst, projectRoot: graphProjectRoot });
  } catch (error) {
    const message = (error as Error).message;
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
    } else {
      logErr(`[aglc] Extractor failure: ${message}`);
    }
    process.exit(1);
  }
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ...delta.graphReport,
      ...(debugExtractors ? { extractor_debug: delta.extractorDebug } : {}),
    }, null, 2) + '\n');
  } else {
    log(`[aglc] Graph facts: ${delta.graphFacts.length}`);
    log(`[aglc] Flow projections: ${delta.facts.length}`);
    log(`[aglc] SMT assertions: ${delta.smtAssertions.filter(s => s.startsWith('(assert')).length}`);
    if (debugExtractors && delta.extractorDebug.length > 0) {
      log(`[aglc] Extractor debug events: ${delta.extractorDebug.length}`);
      for (const event of delta.extractorDebug) {
        log(`  [${event.extractor}] ${event.stage}: ${event.message}`);
      }
    }
    for (const w of delta.graphWarnings) {
      log(`  warning: ${w.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// DEBUG (agent + engineer evidence bundle)
// ─────────────────────────────────────────────────────────────
function architectureRulesSummary(artifact: ArchitectureArtifact) {
  return {
    sourcePath: artifact.sourcePath,
    components: Object.entries(artifact.mappings ?? {}).map(([name, paths]) => ({
      name,
      paths,
      repo: artifact.componentRepos?.[name],
    })),
    invariants: artifact.invariants ?? [],
    dataPolicies: artifact.dataPolicies ?? [],
    trustPolicies: artifact.trustPolicies ?? [],
    diPolicies: artifact.diPolicies ?? [],
    changePolicies: artifact.changePolicies ?? [],
    contracts: artifact.contracts ?? [],
    workflowPolicies: artifact.workflowPolicies ?? [],
    stateMachines: artifact.stateMachines ?? [],
    permissions: artifact.permissions ?? [],
    enforcement: artifact.enforcement ?? [],
  };
}

function debugAgentTasks(payload: Record<string, unknown>, changed: ChangedComponent[], delta: Awaited<ReturnType<typeof generateDeltaAssertions>>) {
  const violations = [
    ...((payload.violations as unknown[]) ?? []),
    ...((payload.contract_violations as unknown[]) ?? []),
    ...((payload.workflow_violations as unknown[]) ?? []),
    ...((payload.change_violations as unknown[]) ?? []),
  ];
  const tasks = [
    {
      id: 'explain_blocking_violations',
      when: 'violations_present',
      instruction: 'For each stable violation id, run aglc explain with the same scope and summarize the implementation repair before editing.',
      violation_ids: violations
        .map(v => typeof v === 'object' && v ? (v as Record<string, unknown>).id : undefined)
        .filter(Boolean),
    },
    {
      id: 'review_weak_or_missing_evidence',
      when: 'warnings_or_empty_graph',
      instruction: 'Review warnings, empty graph projections, and unmapped files. Ask the engineer before changing .ag or .agq.yml.',
      warning_count: ((payload.warnings as unknown[]) ?? []).length,
      graph_fact_count: delta.graphFacts.length,
    },
    {
      id: 'report_scope_to_engineer',
      when: 'always',
      instruction: 'Show the engineer which files mapped to which components, which rules were checked, and which evidence was extracted.',
      changed_components: changed.map(c => c.componentName),
    },
  ];
  return tasks;
}

function markdownList(items: string[]): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : '- None';
}

function writeEngineerDebugReport(outDir: string, bundle: Record<string, unknown>) {
  const changed = bundle.changed as ChangedComponent[];
  const payload = bundle.verdict as Record<string, unknown>;
  const delta = bundle.delta_summary as Record<string, unknown>;
  const rules = bundle.rules as ReturnType<typeof architectureRulesSummary>;
  const tasks = bundle.agent_tasks as Array<Record<string, unknown>>;
  const violations = [
    ...((payload.violations as unknown[]) ?? []),
    ...((payload.contract_violations as unknown[]) ?? []),
    ...((payload.workflow_violations as unknown[]) ?? []),
    ...((payload.change_violations as unknown[]) ?? []),
  ] as Array<Record<string, unknown>>;
  const md = [
    '# aglc Debug Report',
    '',
    `- Artifact: \`${String(bundle.artifact)}\``,
    `- Project: \`${String(bundle.project_root)}\``,
    `- Scope: \`${String(bundle.scope)}\``,
    `- Passed: \`${String(payload.passed)}\``,
    '',
    '## Files And Components',
    '',
    markdownList(changed.map(c => `${c.componentName}: ${c.files.map(f => relative(String(bundle.project_root), f).replace(/\\/g, '/')).join(', ')}`)),
    '',
    '## Evidence Summary',
    '',
    `- Flow facts: ${String(delta.flow_facts)}`,
    `- Graph facts: ${String(delta.graph_facts)}`,
    `- Reach facts: ${String(delta.reach_facts)}`,
    `- DI facts: ${String(delta.di_facts)}`,
    `- Blocking transition facts: ${String(delta.blocking_transition_facts)}`,
    `- Warnings: ${String(delta.warnings)}`,
    '',
    '## Rule Surface',
    '',
    `- Components: ${rules.components.length}`,
    `- Invariants: ${rules.invariants.length}`,
    `- Data policies: ${rules.dataPolicies.length}`,
    `- Trust policies: ${rules.trustPolicies.length}`,
    `- DI policies: ${rules.diPolicies.length}`,
    `- Change policies: ${rules.changePolicies.length}`,
    `- Workflow policies: ${rules.workflowPolicies.length}`,
    `- State machines: ${rules.stateMachines.length}`,
    '',
    '## Violations',
    '',
    markdownList(violations.map(v => {
      const id = v.id ? ` ${String(v.id)}` : '';
      const rule = v.invariant ?? v.policy ?? v.contract ?? 'unknown rule';
      const message = v.message ?? v.evidence ?? '';
      return `${String(v.type ?? 'violation')}${id}: ${String(rule)} - ${String(message)}`;
    })),
    '',
    '## Solver Diagnostics',
    '',
    markdownList(((payload.solver_diagnostics as Array<Record<string, unknown>> | undefined) ?? []).map(d =>
      `${String(d.status)} ${String(d.rule)} (${String(d.declaration)}) ${d.reason ? `- ${String(d.reason)}` : ''}`,
    )),
    '',
    '## Agent Tasks',
    '',
    markdownList(tasks.map(t => `${String(t.id)}: ${String(t.instruction)}`)),
    '',
    '## Files Written',
    '',
    '- `debug.json` - complete structured packet',
    '- `graph.json` - extracted graph/projection evidence',
    '- `verdict.json` - check verdict for the selected scope',
    '- `rules.json` - architecture rules and component mappings',
    '- `agent-tasks.json` - suggested agent follow-up tasks',
  ].join('\n');
  writeFileSync(resolve(outDir, 'engineer.md'), md + '\n', 'utf8');
}

async function debugCommand(archPath: string, projectRoot: string, filePath: string | undefined, all = false, diffBase?: string, outPath?: string) {
  if (!existsSync(archPath)) {
    logErr(`Error: architecture.o not found: ${archPath}`);
    process.exit(1);
  }
  const artifact: ArchitectureArtifact = loadArtifact(readFileSync(archPath, 'utf8'));
  const absProject = resolve(projectRoot);
  const outDir = resolve(outPath ?? resolve('.aglang', 'debug'));
  const mode: DiffSelection['mode'] = filePath ? 'all' : all ? 'all' : diffBase ? 'git_ref' : 'staged';

  let changed: ChangedComponent[];
  let scope: string;
  if (filePath) {
    if (!existsSync(filePath)) {
      logErr(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    const absFile = resolve(filePath);
    const componentName = await componentForFile(artifact, absFile);
    if (!componentName) {
      changed = [];
      scope = `file:${absFile}`;
    } else {
      changed = [{ componentName, files: [absFile] }];
      scope = `file:${absFile}`;
    }
  } else {
    changed = all
      ? parseProjectFiles(absProject, artifact)
      : diffBase
        ? parseDiffAgainst(absProject, artifact, diffBase)
        : parseDiff(absProject, artifact);
    scope = all ? 'all' : diffBase ? `diff:${diffBase}...HEAD` : 'staged';
  }

  let delta;
  try {
    delta = await generateDeltaAssertions(changed, artifact, { debugExtractors: true, requireAst, projectRoot: absProject });
  } catch (error) {
    const message = (error as Error).message;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'debug.json'), extractorErrorJson(archPath, message) + '\n', 'utf8');
    logErr(`[aglc] Extractor failure: ${message}`);
    process.exit(1);
  }

  const allChangedFiles = changed.flatMap(c => c.files);
  const contractResult = await runContractGate(artifact, allChangedFiles, { projectRoot: absProject, checkCompleteness: true });
  const workflowResult = runWorkflowGate(artifact, allChangedFiles, { projectRoot: absProject });
  const changeResult = await runChangeGate(artifact, changed);
  const verdict = await runGate(artifact, delta);
  verdict.contract_violations = contractResult.violations;
  verdict.contract_warnings = contractResult.warnings;
  verdict.workflow_violations = workflowResult.violations;
  verdict.workflow_warnings = workflowResult.warnings;
  verdict.change_violations = changeResult.violations;
  verdict.passed = verdict.passed && contractResult.violations.length === 0 && workflowResult.violations.length === 0 && changeResult.violations.length === 0;

  const verdictPayload = JSON.parse(formatVerdictJson(verdict, archPath)) as Record<string, unknown>;
  verdictPayload.diff = buildDiffSelection(absProject, changed, mode, diffBase ?? (all ? 'workspace' : filePath ? 'file' : 'staged'));
  verdictPayload.rule_coverage = buildRuleCoverage(artifact, changed, delta);
  annotateBaselineStatus(verdictPayload, diffBase ? 'new' : 'unchanged');
  verdictPayload.extractor_debug = delta.extractorDebug;

  const rules = architectureRulesSummary(artifact);
  const deltaSummary = {
    flow_facts: delta.facts.length,
    graph_facts: delta.graphFacts.length,
    reach_facts: delta.reachFacts.length,
    di_facts: delta.diFacts.length,
    blocking_facts: delta.blockingFacts.length,
    blocking_reach_facts: delta.blockingReachFacts.length,
    blocking_dataflow_facts: delta.blockingDataFlowFacts.length,
    blocking_di_facts: delta.blockingDiFacts.length,
    blocking_transition_facts: delta.blockingTransitionFacts.length,
    warnings: delta.warningFacts.length + delta.transitionWarningFacts.length + delta.graphWarnings.length,
  };
  const agentTasks = debugAgentTasks(verdictPayload, changed, delta);
  const bundle = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    artifact: resolve(archPath),
    project_root: absProject,
    scope,
    changed,
    delta_summary: deltaSummary,
    verdict: verdictPayload,
    graph: delta.graphReport,
    rules,
    agent_tasks: agentTasks,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'debug.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(outDir, 'graph.json'), JSON.stringify(delta.graphReport, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(outDir, 'verdict.json'), JSON.stringify(verdictPayload, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(outDir, 'rules.json'), JSON.stringify(rules, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(outDir, 'agent-tasks.json'), JSON.stringify(agentTasks, null, 2) + '\n', 'utf8');
  writeEngineerDebugReport(outDir, bundle);

  log(`✓ Wrote aglc debug bundle → ${outDir}`);
  log(`  Verdict: ${verdictPayload.passed ? 'passed' : 'failed'}`);
  log(`  Files: debug.json, engineer.md, graph.json, verdict.json, rules.json, agent-tasks.json`);
}

// ─────────────────────────────────────────────────────────────
// IMPORT-OPENAPI
// ─────────────────────────────────────────────────────────────
async function importOpenApiCmd(specPath: string, outPath: string | undefined) {
  const { importOpenApi } = await import('./import-openapi.ts');
  const { readFileSync, writeFileSync } = await import('fs');
  if (!existsSync(specPath)) {
    logErr(`Error: file not found: ${specPath}`);
    process.exit(1);
  }
  const json = readFileSync(specPath, 'utf8');
  const result = importOpenApi(json);
  if (outPath) {
    writeFileSync(outPath, result.ag, 'utf8');
    log(`✓ Imported OpenAPI spec → ${outPath}`);
  } else {
    process.stdout.write(result.ag);
  }
  log(`  Contracts: ${result.contracts}, Endpoints: ${result.endpoints}, Data types: ${result.dataTypes}`);
}

// ─────────────────────────────────────────────────────────────
// IMPORT-TF
// ─────────────────────────────────────────────────────────────
async function importTfCmd(hclPath: string, outPath: string | undefined) {
  const { importTerraform } = await import('./import-tf.ts');
  const { readFileSync, writeFileSync } = await import('fs');
  if (!existsSync(hclPath)) {
    logErr(`Error: file not found: ${hclPath}`);
    process.exit(1);
  }
  const hcl = readFileSync(hclPath, 'utf8');
  const result = importTerraform(hcl);
  if (outPath) {
    writeFileSync(outPath, result.ag, 'utf8');
    log(`✓ Imported Terraform → ${outPath}`);
  } else {
    process.stdout.write(result.ag);
  }
  log(`  Nodes imported: ${result.nodes}, Resource types skipped (unmapped): ${result.skipped}`);
}

// ─────────────────────────────────────────────────────────────
// ADD (one-shot agent bootstrap)
// ─────────────────────────────────────────────────────────────
async function addProject(projectRoot: string, opts: { name?: string; out?: string }) {
  const absProject = resolve(projectRoot);
  if (!existsSync(absProject)) {
    logErr(`Error: directory not found: ${absProject}`);
    process.exit(1);
  }

  const agOut = opts.out ?? resolve(absProject, 'architecture.ag');
  const archOut = resolve(dirname(agOut), 'architecture.o');
  const skillOut = resolve(absProject, 'skill.json');

  // 1. Generate starter .ag spec
  log(`[aglc add] Generating draft spec from deterministic repo evidence in ${absProject}...`);
  const result = await generateSpec(absProject, {
    projectName: opts.name,
    maxDepth: getNumberArg('--max-depth') ?? 3,
    singleFile: args.includes('--single-file'),
  });

  if (result.warnings.length > 0) {
    for (const w of result.warnings) log(`  ⚠ ${w}`);
  }

  writeGeneratedSpecFiles(dirname(agOut), basename(agOut), result.files);
  log(`  ✓ Generated spec → ${agOut}`);
  if (result.files.length > 1) log(`    Imported sub-specs: ${result.files.length - 1}`);
  log(`    Components: ${result.components} | Infra nodes: ${result.infrastructureNodes} | Contracts: ${result.contracts}`);

  // 2. Compile → architecture.o
  log(`[aglc add] Compiling spec...`);
  let ast;
  try {
    ast = loadAndMerge(agOut);
  } catch (e) {
    logErr(`\nParse error: ${(e as Error).message}`);
    process.exit(1);
  }

  const errors = check(ast);
  if (errors.length > 0) {
    logErr('\nType check errors in generated spec (please report this as a bug):');
    for (const e of errors) logErr(`  ✗ ${e.message}`);
    process.exit(1);
  }

  const artifact = emitArtifact(ast, agOut);
  writeArtifact(artifact, archOut);
  log(`  ✓ Compiled → ${archOut}`);

  // 3. Emit skill.json
  const manifest = emitSkillManifest(artifact, archOut);
  writeSkillManifest(manifest, skillOut);
  log(`  ✓ Emitted skill manifest → ${skillOut}`);

  // 4. Summary
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  aglang setup complete                                   ║
╠══════════════════════════════════════════════════════════╣
║  Spec:       ${agOut.padEnd(43)} ║
║  Artifact:   ${archOut.padEnd(43)} ║
║  Skill:      ${skillOut.padEnd(43)} ║
╠══════════════════════════════════════════════════════════╣
║  Next steps:                                             ║
║  1. Use plan mode to review ${agOut.padEnd(31)} ║
║     and refine architecture intent with the agent        ║
║  2. Add or adjust invariants through that guided session ║
║  3. Re-compile approved changes:                         ║
║     aglc compile ${agOut.padEnd(39)} ║
║  4. Run aglc check explicitly in local workflows or CI   ║
╚══════════════════════════════════════════════════════════╝`);
}


function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function getNumberArg(flag: string): number | undefined {
  const value = getArg(flag);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function writeGeneratedSpecFiles(outDir: string, rootFileName: string, files: Array<{ path: string; content: string }>) {
  for (const file of files) {
    const target = file.path === rootFileName
      ? join(outDir, rootFileName)
      : join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
}

type AgentTaskKind = 'architecture_discovery' | 'architecture_review';

function defaultTaskPath(kind: AgentTaskKind): string {
  return kind === 'architecture_discovery'
    ? resolve('.aglang', 'tasks', 'architecture-discovery.json')
    : resolve('.aglang', 'tasks', 'architecture-review.json');
}

function buildAgentTask(kind: AgentTaskKind, projectRoot: string) {
  const absProject = resolve(projectRoot);
  const now = new Date().toISOString();
  if (kind === 'architecture_discovery') {
    return {
      schema_version: 1,
      task: kind,
      created_at: now,
      project_root: absProject,
      intent:
        'Agent should inspect the project semantically and propose architecture evidence. aglc does not infer architecture intent.',
      required_outputs: {
        review_notes: 'architecture-review.md',
        architecture_proposal: 'architecture.proposed.ag',
        semantic_queries: '.aglang/extractors/*.agq.yml',
      },
      rules: [
        'Do not overwrite architecture.ag, architecture.o, AGENTS.md, or skill.json.',
        'Separate observed facts from intended architecture rules.',
        'Mark uncertain findings as questions instead of enforcement.',
        'Propose .ag and .agq.yml changes only for human review.',
        'Do not claim aglc discovered intent automatically.',
      ],
      suggested_agent_steps: [
        'Read repository docs, manifests, CI workflows, and existing architecture files if present.',
        'Identify candidate components, owners, runtime nodes, contracts, data types, and state machines.',
        'Record observed dependencies and unknown/unmapped areas with evidence.',
        'Draft candidate .ag and .agq.yml artifacts for review, not enforcement.',
        'Ask the human to approve architecture intent before compile/check enforcement.',
      ],
    };
  }
  return {
    schema_version: 1,
    task: kind,
    created_at: now,
    project_root: absProject,
    intent:
      'Agent should review proposed architecture artifacts and produce approval questions before aglc compiles or checks them.',
    inputs: {
      architecture_source: 'architecture.ag',
      proposed_architecture: 'architecture.proposed.ag',
      semantic_queries: '.aglang/extractors/*.agq.yml',
      generated_context: ['AGENTS.md', 'skill.json'],
    },
    required_outputs: {
      review_notes: 'architecture-review.md',
      approval_questions: 'architecture-approval-questions.md',
    },
    rules: [
      'Do not edit architecture intent unless explicitly authorized.',
      'Validate that proposed rules are backed by evidence and are intended policy, not incidental implementation.',
      'Flag weak extractor/query evidence and empty query matches.',
      'Recommend aglc compile only after human approval.',
    ],
    suggested_agent_steps: [
      'Compare proposed .ag rules with observed code and docs.',
      'Review .agq.yml queries for overbroad or underbroad matches.',
      'List rules that need an owner, rationale, or test fixture.',
      'Produce concise approval questions for uncertain architecture intent.',
    ],
  };
}

function writeAgentTask(kind: AgentTaskKind, projectRoot: string, outPath: string | undefined) {
  const task = buildAgentTask(kind, projectRoot);
  const target = resolve(outPath ?? defaultTaskPath(kind));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(task, null, 2) + '\n', 'utf8');
  log(`✓ Wrote agent task packet → ${target}`);
  log(`  Task: ${kind}`);
  log(`  Project: ${resolve(projectRoot)}`);
}

(async () => {
  if (command === 'request-scan') {
    writeAgentTask('architecture_discovery', getArg('--project') ?? '.', getArg('--out'));

  } else if (command === 'request-review') {
    writeAgentTask('architecture_review', getArg('--project') ?? '.', getArg('--out'));

  } else if (command === 'add') {
    const projectRoot = args[1] && !args[1].startsWith('--') ? args[1] : '.';
    const name = getArg('--name');
    const out = getArg('--out');
    await addProject(projectRoot, { name, out });

  } else if (command === 'compile') {
    const agFile = args[1];
    if (!agFile) usage();
    await compile(agFile!, getArg('--out'));

  } else if (command === 'emit-context') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const outPath = getArg('--out') ?? 'AGENTS.md';
    emitContext(archPath, outPath);

  } else if (command === 'emit-skill') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const outPath = getArg('--out') ?? 'skill.json';
    emitSkill(archPath, outPath);

  } else if (command === 'install-agent-skill') {
    installAgentSkill(getArg('--path') ?? defaultSkillsDir());

  } else if (command === 'check') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const projectRoot = getArg('--project') ?? '.';
    const repoFilter = getArg('--repo-filter');
    await checkDiff(archPath, projectRoot, repoFilter, args.includes('--all'), getArg('--diff'));

  } else if (command === 'check-file') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const filePath = getArg('--file');
    if (!filePath) usage();
    await checkFile(archPath, filePath!);

  } else if (command === 'explain') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const projectRoot = getArg('--project') ?? '.';
    const violationId = getArg('--violation');
    if (!violationId) usage();
    await explainViolation(archPath, projectRoot, violationId!, args.includes('--all'), getArg('--diff'));

  } else if (command === 'graph') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const filePath = getArg('--file');
    const projectRoot = getArg('--project');
    await graphCommand(archPath, filePath, projectRoot);

  } else if (command === 'debug') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const projectRoot = getArg('--project') ?? '.';
    await debugCommand(archPath, projectRoot, getArg('--file'), args.includes('--all'), getArg('--diff'), getArg('--out'));

  } else if (command === 'import-openapi') {
    const specPath = args[1];
    if (!specPath) usage();
    const outPath = getArg('--out');
    await importOpenApiCmd(specPath!, outPath);

  } else if (command === 'import-tf') {
    const hclPath = args[1];
    if (!hclPath) usage();
    const outPath = getArg('--out');
    await importTfCmd(hclPath!, outPath);

  } else if (command === 'generate') {
    const projectRoot = resolve(args[1] ?? '.');
    const outPath = getArg('--out');
    const projectName = getArg('--name');
    const result = await generateSpec(projectRoot, {
      projectName,
      maxDepth: getNumberArg('--max-depth') ?? 3,
      singleFile: args.includes('--single-file') || !outPath,
      rootFileName: outPath ? basename(outPath) : 'architecture.ag',
    });
    if (outPath) {
      writeGeneratedSpecFiles(dirname(outPath), basename(outPath), result.files);
      log(`✓ Generated ${outPath}`);
      if (result.files.length > 1) log(`  Imported sub-specs: ${result.files.length - 1}`);
    } else {
      process.stdout.write(result.ag + '\n');
    }
    log(`  Components: ${result.components} | Infrastructure nodes: ${result.infrastructureNodes} | Contracts: ${result.contracts}`);
    for (const w of result.warnings) log(`  ⚠ ${w}`);

  } else {
    usage();
  }
})();
