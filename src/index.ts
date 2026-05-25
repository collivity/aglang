#!/usr/bin/env node
// aglc — Architecture Ground Language Compiler CLI

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, cpSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { check } from './checker.ts';
import { emitArtifact, writeArtifact, loadArtifact } from './emitters/artifact.ts';
import { emitAgentsMarkdown } from './emitters/agents.ts';
import { emitSkillManifest, writeSkillManifest } from './emitters/skill.ts';
import { loadAndMerge, ImportError } from './importer.ts';
import { parseDiff, parseProjectFiles } from './runtime/diff-parser.ts';
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
  aglc add [projectRoot] [--name <n>] [--out <file.ag>]     One-shot agent setup: generate → compile → hook → skill.json
  aglc compile <file.ag> [--out <arch.o>]                    Compile .ag spec → architecture.o
  aglc generate [projectRoot] [--out <file.ag>]             Scan codebase → auto-generate starter .ag spec
  aglc emit-context --arch <arch.o> [--out <path>]          Emit AGENTS.md for AI agents
  aglc emit-skill   --arch <arch.o> [--out <path>]          Emit skill.json manifest for AI agents
  aglc install-agent-skill [--path <skills-dir>]            Install packaged aglang Codex skill for local agents
  aglc install [--project <dir>] [--arch <arch.o>]          Install pre-commit git hook
  aglc check --arch <arch.o> --project <dir> [--repo-filter <Name>] [--all] [--json] [--debug-extractors] [--require-ast]  Check staged git diff or whole project vs architecture
  aglc check-file --arch <arch.o> --file <f> [--json] [--dump-smt] [--workflow-z3] [--dump-workflow-smt] [--debug-extractors] [--require-ast]  Analyze a specific file
  aglc graph --arch <arch.o> [--file <f> | --project <dir>] [--json] [--debug-extractors] [--require-ast]  Emit graph facts and Z3 flow projections
  aglc import-openapi <swagger.json> [--out <file.ag>]       Import OpenAPI 3.x spec → .ag contracts
  aglc import-tf <main.tf> [--out <file.ag>]                Import Terraform → .ag node declarations

Flags:
  --json      Output machine-readable JSON to stdout; progress logs go to stderr
  --debug-extractors   Include extractor trace output and fallback reasons
  --require-ast        Fail when an AST-capable extractor falls back to regex for a detected fact
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
// INSTALL (git pre-commit hook)
// ─────────────────────────────────────────────────────────────
function installHook(projectRoot: string, archPath: string) {
  const absProject = resolve(projectRoot);
  const hooksDir = resolve(absProject, '.git', 'hooks');

  if (!existsSync(resolve(absProject, '.git'))) {
    console.error(`Error: no .git directory found in ${absProject}`);
    process.exit(1);
  }

  mkdirSync(hooksDir, { recursive: true });
  const hookPath = resolve(hooksDir, 'pre-commit');
  const absArch = resolve(archPath);

  // Shell-safe: use single-quoted POSIX strings, no variable interpolation in values.
  // Use `npx aglc` — consumers have aglc as a listed dependency; npx will find the bin.
  // Paths are validated above (resolve()) and written as single-quoted literals so no
  // shell metacharacters ($, `, (, ), etc.) can be injected from path values.
  const safeSingleQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const hookScript = `#!/bin/sh
# aglang pre-commit hook — auto-generated by aglc install
# Checks staged files against architectural invariants before committing.
# To bypass (emergency only): git commit --no-verify

ARCH=${safeSingleQuote(absArch)}
PROJECT=${safeSingleQuote(absProject)}

if [ ! -f "$ARCH" ]; then
  echo "[aglc] Warning: architecture.o not found at $ARCH, skipping check."
  exit 0
fi

npx --no aglc check --arch "$ARCH" --project "$PROJECT"
if [ $? -ne 0 ]; then
  exit 1
fi
exit 0
`;

  writeFileSync(hookPath, hookScript, { encoding: 'utf8' });
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // chmod may not work on Windows — that's fine, WSL/Git will handle it
  }

  console.log(`✓ Installed pre-commit hook → ${hookPath}`);
  console.log(`  Architecture artifact: ${absArch}`);
  console.log(`  Project root:          ${absProject}`);
  console.log('');
  console.log('  On every git commit, aglc will check staged files against your architecture.');
  console.log('  To bypass (emergency only): git commit --no-verify');
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
async function checkDiff(archPath: string, projectRoot: string, repoFilter?: string, all = false) {
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

  log(all ? `[aglc] Scanning all tracked component files in ${absProject}...` : `[aglc] Parsing git diff in ${absProject}...`);
  let changed = all ? parseProjectFiles(absProject, artifact) : parseDiff(absProject, artifact);

  if (repoComponents) {
    changed = changed.filter(c => repoComponents.has(c.componentName));
  }

  if (changed.length === 0) {
    const msg = all
      ? 'No files matched tracked components. Check allowed.'
      : 'No staged changes in tracked components. Commit allowed.';
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ schema_version: 2, passed: true, violations: [], contract_violations: [], workflow_violations: [], change_violations: [], warnings: [], contract_warnings: [], workflow_warnings: [], timestamp: new Date().toISOString(), artifact: archPath, agent_context: msg }, null, 2) + '\n');
    } else {
      log(`[aglc] ${msg}`);
    }
    process.exit(0);
  }

  log(`[aglc] Changed components: ${changed.map(c => c.componentName).join(', ')}`);
  log(`[aglc] Generating delta assertions...`);
  let delta;
  try {
    delta = await generateDeltaAssertions(changed, artifact, { debugExtractors, requireAst });
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
    delta.warningFacts.length === 0 &&
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
      { debugExtractors, requireAst },
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

  if (delta.facts.length === 0 && delta.diFacts.length === 0 && contractResult.violations.length === 0 && workflowResult.violations.length === 0) {
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
    changed = args.includes('--all')
      ? parseProjectFiles(absProject, artifact)
      : parseDiff(absProject, artifact);
  }

  let delta;
  try {
    delta = await generateDeltaAssertions(changed, artifact, { debugExtractors, requireAst });
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
  log(`[aglc add] Scanning ${absProject} for project manifests...`);
  const result = await generateSpec(absProject, { projectName: opts.name });

  if (result.warnings.length > 0) {
    for (const w of result.warnings) log(`  ⚠ ${w}`);
  }

  writeFileSync(agOut, result.ag, 'utf8');
  log(`  ✓ Generated spec → ${agOut}`);
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

  // 3. Install pre-commit hook
  log(`[aglc add] Installing git pre-commit hook...`);
  const hasGit = existsSync(resolve(absProject, '.git'));
  if (!hasGit) {
    log(`  ⚠ No .git directory found in ${absProject} — skipping hook installation.`);
    log(`    Run 'git init && aglc install --project . --arch ${archOut}' manually.`);
  } else {
    installHook(absProject, archOut);
  }

  // 4. Emit skill.json
  const manifest = emitSkillManifest(artifact, archOut);
  writeSkillManifest(manifest, skillOut);
  log(`  ✓ Emitted skill manifest → ${skillOut}`);

  // 5. Summary
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  aglang setup complete                                   ║
╠══════════════════════════════════════════════════════════╣
║  Spec:       ${agOut.padEnd(43)} ║
║  Artifact:   ${archOut.padEnd(43)} ║
║  Skill:      ${skillOut.padEnd(43)} ║
╠══════════════════════════════════════════════════════════╣
║  Next steps:                                             ║
║  1. Open ${agOut.padEnd(47)} ║
║     Add 'invariant' blocks to enforce architectural rules ║
║  2. Re-compile after editing:                            ║
║     aglc compile ${agOut.padEnd(39)} ║
║  3. Every git commit is now checked automatically        ║
╚══════════════════════════════════════════════════════════╝`);
}


function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

(async () => {
  if (command === 'add') {
    const projectRoot = args[1] && !args[1].startsWith('--') ? args[1] : '.';
    const name = getArg('--name');
    const out = getArg('--out');
    await addProject(projectRoot, { name, out });

  } else if (command === 'compile') {
    const agFile = args[1];
    if (!agFile) usage();
    await compile(agFile!, getArg('--out'));

  } else if (command === 'install') {
    const projectRoot = getArg('--project') ?? '.';
    const archPath = getArg('--arch') ?? 'architecture.o';
    installHook(projectRoot, archPath);

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
    await checkDiff(archPath, projectRoot, repoFilter, args.includes('--all'));

  } else if (command === 'check-file') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const filePath = getArg('--file');
    if (!filePath) usage();
    await checkFile(archPath, filePath!);

  } else if (command === 'graph') {
    const archPath = getArg('--arch') ?? 'architecture.o';
    const filePath = getArg('--file');
    const projectRoot = getArg('--project');
    await graphCommand(archPath, filePath, projectRoot);

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
    const result = await generateSpec(projectRoot, { projectName });
    if (outPath) {
      const { writeFileSync } = await import('fs');
      writeFileSync(outPath, result.ag, 'utf8');
      log(`✓ Generated ${outPath}`);
    } else {
      process.stdout.write(result.ag + '\n');
    }
    log(`  Components: ${result.components} | Infrastructure nodes: ${result.infrastructureNodes} | Contracts: ${result.contracts}`);
    for (const w of result.warnings) log(`  ⚠ ${w}`);

  } else {
    usage();
  }
})();
