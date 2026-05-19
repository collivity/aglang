// Diagnostic layer — maps Z3 verdict back to human-readable compiler error and JSON
import type { GateVerdict, GateViolation } from './gate.ts';
import type { ContractViolation } from './contract-gate.ts';

const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const MAGENTA = '\x1b[35m';

function formatViolationBlock(v: GateViolation): string[] {
  return [
    '',
    `${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}`,
    `${RED}${BOLD}║        aglang Architecture Compilation Error             ║${RESET}`,
    `${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}`,
    '',
    `${BOLD}Invariant Violated:${RESET}  ${YELLOW}${v.invariant}${RESET}`,
    `${BOLD}Rule:${RESET}                ${v.rule.kind} ${CYAN}${v.rule.from}${RESET} → ${CYAN}${v.rule.to}${RESET}`,
    '',
    `${BOLD}Detected in file:${RESET}`,
    `  ${v.detected.file}`,
    '',
    `${BOLD}Evidence:${RESET} [confidence: ${v.detected.confidence}]`,
    `  ${v.detected.evidence}`,
    '',
    `${BOLD}Explanation:${RESET}`,
    `  ${v.message}`,
    `  The architecture requires that ${v.rule.from} does NOT directly access ${v.rule.to}.`,
    '',
    `${BOLD}Z3 Proof (conflicting assertions):${RESET}`,
    `  ${CYAN}Permanent rule:${RESET} ${v.z3_proof.permanent_constraint}`,
    `  ${CYAN}Delta (your code):${RESET} ${v.z3_proof.delta_assertion}`,
    `  These two assertions are mutually UNSAT — formal proof of violation.`,
  ];
}

function formatContractViolationBlock(v: ContractViolation): string[] {
  const isError = v.severity === 'error';
  const color = isError ? RED : YELLOW;
  const icon = isError ? '╔' : '┌';
  const bar = isError ? '║' : '│';
  const close = isError ? '╚' : '└';
  const title = isError
    ? 'aglang Contract Violation'
    : 'aglang Contract Warning';
  return [
    '',
    `${color}${BOLD}${icon}══════════════════════════════════════════════════════════╗${RESET}`,
    `${color}${BOLD}${bar}        ${title.padEnd(56)}${bar}${RESET}`,
    `${color}${BOLD}${close}══════════════════════════════════════════════════════════╝${RESET}`,
    '',
    `${BOLD}Contract:${RESET}   ${MAGENTA}${v.contract}${RESET}`,
    `${BOLD}Component:${RESET}  ${CYAN}${v.component}${RESET}  (role: ${v.role})`,
    `${BOLD}Type:${RESET}       ${v.type}`,
    '',
    ...(v.declared ? [`${BOLD}Declared:${RESET}   ${v.declared}`] : []),
    ...(v.extracted ? [`${BOLD}Extracted:${RESET}  ${v.extracted}`] : []),
    '',
    `${BOLD}Proof:${RESET}`,
    `  ${CYAN}Contract:${RESET}  ${v.proof.contract_assertion}`,
    `  ${CYAN}Code:${RESET}      ${v.proof.extractor_result}`,
    `  ${v.proof.explanation}`,
  ];
}

export function formatVerdict(verdict: GateVerdict): string {
  const parts: string[] = [];

  // Warnings (probable facts, non-blocking)
  if (verdict.warnings.length > 0) {
    parts.push('');
    parts.push(`${YELLOW}${BOLD}⚠ aglang warnings (non-blocking):${RESET}`);
    for (const w of verdict.warnings) {
      parts.push(`  ${YELLOW}⚠${RESET} ${w.from} → ${w.to}`);
      parts.push(`    ${w.evidence}`);
      parts.push(`    ${w.file}`);
    }
  }

  // Contract warnings (non-blocking)
  if ((verdict.contract_warnings?.length ?? 0) > 0) {
    for (const v of verdict.contract_warnings!) {
      parts.push(...formatContractViolationBlock(v));
    }
  }

  if (verdict.passed && (verdict.contract_violations?.length ?? 0) === 0) {
    parts.push(`${BOLD}${GREEN}✓ aglang: Architecture check passed. Commit allowed.${RESET}`);
    return parts.join('\n');
  }

  for (const v of verdict.violations) {
    parts.push(...formatViolationBlock(v));
  }

  for (const v of (verdict.contract_violations ?? [])) {
    parts.push(...formatContractViolationBlock(v));
  }

  parts.push('');
  parts.push(`${RED}${BOLD}Commit Aborted.${RESET} Fix all layering violations before committing.`);
  parts.push(`Tip: run ${CYAN}aglc check-file --json${RESET} for machine-readable violation details.`);
  parts.push('');

  return parts.join('\n');
}

// Machine-readable JSON verdict for agents and CI pipelines
export function formatVerdictJson(verdict: GateVerdict, artifactPath: string): string {
  const contractViolations = verdict.contract_violations ?? [];
  const contractWarnings = verdict.contract_warnings ?? [];
  const totalViolations = verdict.violations.length + contractViolations.length;
  const overallPassed = verdict.passed && contractViolations.length === 0;

  return JSON.stringify({
    schema_version: 2,
    passed: overallPassed,
    timestamp: new Date().toISOString(),
    artifact: artifactPath,
    violations: verdict.violations,
    contract_violations: contractViolations,
    warnings: verdict.warnings,
    contract_warnings: contractWarnings,
    smt_model: verdict.model ?? null,
    agent_context: overallPassed
      ? 'Architecture check passed. No violations detected.'
      : `${totalViolations} violation(s) detected. See violations[] and contract_violations[]. ` +
        `Flow violations include z3_proof with conflicting SMT assertions. ` +
        `Contract violations include proof with the contract assertion vs extracted code. ` +
        `Read AGENTS.md for full architectural rules and fix your code accordingly.`,
  }, null, 2);
}
