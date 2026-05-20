import { readFileSync } from 'fs';
import { basename } from 'path';
import { parse as parseYaml } from 'yaml';
import micromatch from 'micromatch';

export type WorkflowActionKind = 'publish' | 'deploy' | 'release';

export interface WorkflowTriggerFact {
  event: string;
  branches: string[];
  tags: string[];
}

export interface WorkflowActionFact {
  action: WorkflowActionKind;
  target: string;
  step: string;
  index: number;
  evidence: string;
}

export interface WorkflowPermissionFact {
  permission: string;
  access: string;
  job?: string;
  evidence: string;
}

export interface WorkflowFacts {
  component: string;
  file: string;
  name: string;
  triggers: WorkflowTriggerFact[];
  permissions: WorkflowPermissionFact[];
  actions: WorkflowActionFact[];
  stepOrder: Array<{ text: string; index: number; job: string; evidence: string }>;
  secrets: string[];
}

export interface WorkflowArtifactView {
  mappings?: Record<string, string>;
  nodes?: Array<{ name: string; type: string }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function triggerOptions(value: unknown): { branches: string[]; tags: string[] } {
  const obj = asRecord(value);
  return {
    branches: asStringArray(obj.branches ?? obj['branches-ignore']),
    tags: asStringArray(obj.tags ?? obj['tags-ignore']),
  };
}

function extractTriggers(onValue: unknown): WorkflowTriggerFact[] {
  if (typeof onValue === 'string') return [{ event: onValue, branches: [], tags: [] }];
  if (Array.isArray(onValue)) {
    return onValue.map(event => ({ event: String(event), branches: [], tags: [] }));
  }
  const obj = asRecord(onValue);
  return Object.entries(obj).map(([event, options]) => ({ event, ...triggerOptions(options) }));
}

function mapTarget(artifact: WorkflowArtifactView, preferredName: string, nodeType: string): string {
  if ((artifact.nodes ?? []).some(n => n.name === preferredName)) return preferredName;
  return (artifact.nodes ?? []).find(n => n.type === nodeType)?.name ?? preferredName;
}

function detectActions(
  step: Record<string, unknown>,
  index: number,
  artifact: WorkflowArtifactView,
): WorkflowActionFact[] {
  const facts: WorkflowActionFact[] = [];
  const run = typeof step.run === 'string' ? step.run : '';
  const uses = typeof step.uses === 'string' ? step.uses : '';
  const label = String(step.name ?? uses ?? run.split(/\r?\n/)[0] ?? `step ${index + 1}`);
  const text = `${uses}\n${run}`.toLowerCase();

  if (/\bnpm\s+publish\b/.test(text) || /JS-DevTools\/npm-publish/i.test(uses) || /npm-publish/i.test(uses)) {
    facts.push({
      action: 'publish',
      target: mapTarget(artifact, 'npm_registry', 'package_registry'),
      step: label,
      index,
      evidence: uses ? `uses ${uses}` : `run: ${run.split(/\r?\n/)[0]}`,
    });
  }
  if (/\bgh\s+release\s+create\b/.test(text) || /softprops\/action-gh-release/i.test(uses) || /actions\/create-release/i.test(uses)) {
    facts.push({
      action: 'release',
      target: mapTarget(artifact, 'github_releases', 'release_host'),
      step: label,
      index,
      evidence: uses ? `uses ${uses}` : `run: ${run.split(/\r?\n/)[0]}`,
    });
  }
  if (/peaceiris\/actions-gh-pages/i.test(uses) || /actions\/deploy-pages/i.test(uses) || /github-pages/i.test(text)) {
    facts.push({
      action: 'deploy',
      target: mapTarget(artifact, 'github_pages', 'static_host'),
      step: label,
      index,
      evidence: uses ? `uses ${uses}` : `run: ${run.split(/\r?\n/)[0]}`,
    });
  }
  if (/\bdocker\s+push\b/.test(text) || /docker\/build-push-action/i.test(uses)) {
    facts.push({
      action: 'publish',
      target: mapTarget(artifact, 'container_registry', 'container_registry'),
      step: label,
      index,
      evidence: uses ? `uses ${uses}` : `run: ${run.split(/\r?\n/)[0]}`,
    });
  }

  return facts;
}

function extractPermissions(value: unknown, job?: string): WorkflowPermissionFact[] {
  if (typeof value === 'string') {
    return [{ permission: '*', access: value, job, evidence: job ? `${job} permissions: ${value}` : `permissions: ${value}` }];
  }
  return Object.entries(asRecord(value)).map(([permission, access]) => ({
    permission,
    access: String(access),
    job,
    evidence: job ? `${job} permissions.${permission}: ${String(access)}` : `permissions.${permission}: ${String(access)}`,
  }));
}

function workflowComponentForFile(artifact: WorkflowArtifactView, file: string): string {
  for (const [component, glob] of Object.entries(artifact.mappings ?? {})) {
    if (micromatch.isMatch(file.replace(/\\/g, '/'), `**/${glob}`) || micromatch.isMatch(file.replace(/\\/g, '/'), glob)) {
      return component;
    }
  }
  const base = basename(file).replace(/\.(ya?ml)$/i, '');
  return base
    .replace(/(^|[-_\s])([a-zA-Z0-9])/g, (_m, _sep, ch: string) => ch.toUpperCase())
    .replace(/[^a-zA-Z0-9_]/g, '') + 'Workflow';
}

export function extractGitHubWorkflowFacts(file: string, artifact: WorkflowArtifactView): WorkflowFacts {
  const source = readFileSync(file, 'utf8');
  const doc = asRecord(parseYaml(source) ?? {});
  const component = workflowComponentForFile(artifact, file);
  const triggers = extractTriggers(doc.on ?? doc['on']);
  const permissions = extractPermissions(doc.permissions);
  const actions: WorkflowActionFact[] = [];
  const stepOrder: WorkflowFacts['stepOrder'] = [];
  const secrets = new Set<string>();
  let stepIndex = 0;

  const secretMatches = source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g);
  for (const match of secretMatches) secrets.add(match[1]!);

  for (const [jobName, jobValue] of Object.entries(asRecord(doc.jobs))) {
    const job = asRecord(jobValue);
    permissions.push(...extractPermissions(job.permissions, jobName));
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      const run = typeof step.run === 'string' ? step.run : '';
      const uses = typeof step.uses === 'string' ? step.uses : '';
      const name = String(step.name ?? uses ?? run.split(/\r?\n/)[0] ?? `step ${stepIndex + 1}`);
      const text = [name, uses, run].filter(Boolean).join('\n');
      stepOrder.push({ text, index: stepIndex, job: jobName, evidence: name });
      actions.push(...detectActions(step, stepIndex, artifact));
      stepIndex++;
    }
  }

  return {
    component,
    file,
    name: String(doc.name ?? component),
    triggers,
    permissions: permissions.filter(p => p.access !== 'undefined'),
    actions,
    stepOrder,
    secrets: [...secrets],
  };
}
