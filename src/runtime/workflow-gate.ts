import { existsSync, readdirSync, writeFileSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import micromatch from 'micromatch';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import { extractGitHubWorkflowFacts, type WorkflowFacts, type WorkflowActionFact } from '../analyzers/github-actions.ts';

export interface WorkflowViolation {
  type: 'workflow_violation';
  policy: string;
  rule: unknown;
  workflow: string;
  file: string;
  message: string;
  evidence: string;
  workflow_smt?: string;
}

export interface WorkflowGateResult {
  violations: WorkflowViolation[];
  warnings: Array<{ workflow: string; file: string; message: string }>;
  facts: WorkflowFacts[];
  smt: string[];
}

type WorkflowRule = NonNullable<ArchitectureArtifact['workflowPolicies']>[number]['rules'][number];

function isWorkflowYaml(file: string): boolean {
  return /\.github[\\/]+workflows[\\/]+[^\\/]+\.ya?ml$/i.test(file);
}

function listWorkflowFiles(projectRoot: string): string[] {
  const dir = resolve(projectRoot, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /\.ya?ml$/i.test(f))
    .map(f => join(dir, f));
}

function conditionText(rule: Extract<WorkflowRule, { when?: unknown }>): string {
  if (!('when' in rule) || !rule.when) return 'always';
  if (rule.when.kind === 'pull_request') return 'pull_request';
  return `${rule.when.kind} ${rule.when.value}`;
}

function hasMatchingCondition(facts: WorkflowFacts, rule: Extract<WorkflowRule, { when?: unknown }>): boolean {
  if (!('when' in rule) || !rule.when) return true;
  if (rule.when.kind === 'pull_request') {
    return facts.triggers.some(t => t.event === 'pull_request' || t.event === 'pull_request_target');
  }
  if (rule.when.kind === 'branch') {
    return facts.triggers.some(t =>
      t.event === 'push' &&
      (t.branches.length === 0 || t.branches.some(branch => micromatch.isMatch(branch, rule.when!.kind === 'branch' ? rule.when!.value : '*'))),
    );
  }
  if (rule.when.kind === 'tag') {
    return facts.triggers.some(t =>
      t.event === 'push' &&
      t.tags.length > 0 &&
      t.tags.some(tag => micromatch.isMatch(tag, rule.when!.kind === 'tag' ? rule.when!.value : '*')),
    );
  }
  return false;
}

function workflowMatches(ruleWorkflow: string, workflow: string): boolean {
  return ruleWorkflow === '*' || ruleWorkflow === workflow;
}

function targetMatches(ruleTarget: string, action: WorkflowActionFact): boolean {
  return ruleTarget === action.target;
}

function actionMatches(rule: Extract<WorkflowRule, { kind: 'ActionRule' }>, facts: WorkflowFacts, action: WorkflowActionFact): boolean {
  return rule.action === action.action &&
    workflowMatches(rule.workflow, facts.component) &&
    targetMatches(rule.target, action) &&
    hasMatchingCondition(facts, rule);
}

function isWrite(access: string): boolean {
  return access === 'write' || access === 'admin' || access === 'all';
}

function permissionMatches(rule: Extract<WorkflowRule, { kind: 'PermissionRule' }>, facts: WorkflowFacts, permission: { permission: string; access: string }): boolean {
  return workflowMatches(rule.workflow, facts.component) &&
    (rule.permission === '*' || rule.permission === permission.permission) &&
    rule.access === permission.access &&
    hasMatchingCondition(facts, rule);
}

function hasStepBefore(facts: WorkflowFacts, before: string, after: string): boolean {
  const beforeStep = facts.stepOrder.find(s => s.text.includes(before));
  const afterStep = facts.stepOrder.find(s => s.text.includes(after));
  return Boolean(beforeStep && afterStep && beforeStep.job === afterStep.job && beforeStep.index < afterStep.index);
}

function workflowSmt(policy: string, message: string): string {
  const id = `${policy}_${message}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80);
  return `; ${message}\n(declare-const ${id} Bool)\n(assert ${id})\n(assert (not ${id}))`;
}

export function discoverWorkflowFiles(projectRoot: string, changedFiles: string[] = []): string[] {
  const fromChanged = changedFiles.filter(isWorkflowYaml);
  return fromChanged.length > 0 ? [...new Set(fromChanged)] : listWorkflowFiles(projectRoot);
}

export function runWorkflowGate(
  artifact: ArchitectureArtifact,
  files: string[],
  options: { projectRoot?: string; workflowZ3?: boolean; dumpWorkflowSmt?: string } = {},
): WorkflowGateResult {
  const policies = artifact.workflowPolicies ?? [];
  const workflowFiles = files.filter(f => /\.ya?ml$/i.test(extname(f)) || isWorkflowYaml(f));
  const facts = workflowFiles.map(file => extractGitHubWorkflowFacts(file, artifact));
  const violations: WorkflowViolation[] = [];
  const warnings: WorkflowGateResult['warnings'] = [];
  const smt: string[] = ['; === aglang workflow policy debug SMT ==='];

  for (const policy of policies) {
    const allowRules = policy.rules.filter((r): r is Extract<WorkflowRule, { kind: 'ActionRule' }> =>
      r.kind === 'ActionRule' && r.effect === 'allow',
    );
    const denyActionRules = policy.rules.filter((r): r is Extract<WorkflowRule, { kind: 'ActionRule' }> =>
      r.kind === 'ActionRule' && r.effect === 'deny',
    );
    const denyPermissionRules = policy.rules.filter((r): r is Extract<WorkflowRule, { kind: 'PermissionRule' }> =>
      r.kind === 'PermissionRule' && r.effect === 'deny',
    );

    for (const wf of facts) {
      for (const action of wf.actions) {
        for (const rule of denyActionRules) {
          if (actionMatches(rule, wf, action)) {
            const message = `${action.action} to ${action.target} is denied for ${wf.component} when ${conditionText(rule)}`;
            const proof = workflowSmt(policy.name, message);
            smt.push(proof);
            violations.push({
              type: 'workflow_violation',
              policy: policy.name,
              rule,
              workflow: wf.component,
              file: wf.file,
              message,
              evidence: action.evidence,
              ...(options.workflowZ3 ? { workflow_smt: proof } : {}),
            });
          }
        }

        const scopedAllows = allowRules.filter(rule => rule.action === action.action && rule.target === action.target);
        if (scopedAllows.length > 0 && !scopedAllows.some(rule => actionMatches(rule, wf, action))) {
          const message = `${action.action} to ${action.target} is not covered by any matching allow rule`;
          const proof = workflowSmt(policy.name, message);
          smt.push(proof);
          violations.push({
            type: 'workflow_violation',
            policy: policy.name,
            rule: scopedAllows,
            workflow: wf.component,
            file: wf.file,
            message,
            evidence: action.evidence,
            ...(options.workflowZ3 ? { workflow_smt: proof } : {}),
          });
        }
      }

      for (const permission of wf.permissions.filter(p => isWrite(p.access))) {
        for (const rule of denyPermissionRules) {
          if (permissionMatches(rule, wf, permission)) {
            const message = `${permission.permission}:${permission.access} is denied for ${wf.component} when ${conditionText(rule)}`;
            const proof = workflowSmt(policy.name, message);
            smt.push(proof);
            violations.push({
              type: 'workflow_violation',
              policy: policy.name,
              rule,
              workflow: wf.component,
              file: wf.file,
              message,
              evidence: permission.evidence,
              ...(options.workflowZ3 ? { workflow_smt: proof } : {}),
            });
          }
        }
      }

      for (const rule of policy.rules.filter((r): r is Extract<WorkflowRule, { kind: 'BeforeRule' }> => r.kind === 'BeforeRule')) {
        if (rule.workflow === wf.component && !hasStepBefore(wf, rule.before, rule.after)) {
          const message = `required step order missing: "${rule.before}" before "${rule.after}"`;
          const proof = workflowSmt(policy.name, message);
          smt.push(proof);
          violations.push({
            type: 'workflow_violation',
            policy: policy.name,
            rule,
            workflow: wf.component,
            file: wf.file,
            message,
            evidence: `steps: ${wf.stepOrder.map(s => s.evidence).join(' -> ') || '(none)'}`,
            ...(options.workflowZ3 ? { workflow_smt: proof } : {}),
          });
        }
      }
    }
  }

  if (options.dumpWorkflowSmt) {
    writeFileSync(options.dumpWorkflowSmt, smt.join('\n'), 'utf8');
  } else if (options.projectRoot && options.workflowZ3 && smt.length > 1) {
    writeFileSync(resolve(options.projectRoot, 'workflow-debug.smt2'), smt.join('\n'), 'utf8');
  }

  return { violations, warnings, facts, smt };
}

export function workflowDebugPathForArch(archPath: string): string {
  return resolve(dirname(archPath), 'workflow-debug.smt2');
}
