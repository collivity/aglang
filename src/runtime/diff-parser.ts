// Git diff parser — maps changed files to architecture components
import { execFileSync, execSync } from 'child_process';
import { readdirSync } from 'fs';
import { join, relative } from 'path';
import micromatch from 'micromatch';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';

export interface ChangedComponent {
  componentName: string;
  files: string[]; // absolute paths
}

export interface DiffSelection {
  base: string;
  mode: 'git_ref' | 'staged' | 'all';
  changed_files: string[];
  changed_components: string[];
}

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'docs-build',
  '.vitepress-out',
  '.npm-cache',
  '.playwright-mcp',
]);

function collectProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORES.has(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(projectRoot);
  return files;
}

function addFileToComponents(
  byComponent: Map<string, string[]>,
  projectRoot: string,
  artifact: ArchitectureArtifact,
  absFile: string,
): void {
  const relFile = relative(projectRoot, absFile).replace(/\\/g, '/');
  for (const [componentName, glob] of Object.entries(artifact.mappings)) {
    if (micromatch.isMatch(relFile, glob)) {
      if (!byComponent.has(componentName)) byComponent.set(componentName, []);
      byComponent.get(componentName)!.push(absFile);
    }
  }
}

/**
 * Get the list of staged files from git, then match each to a declared component
 * via the glob mappings in architecture.o.
 *
 * @param projectRoot  absolute path to the implementation project (e.g. collivity/)
 * @param artifact     loaded architecture.o
 */
export function parseDiff(
  projectRoot: string,
  artifact: ArchitectureArtifact,
): ChangedComponent[] {
  let stagedFiles: string[];

  try {
    const output = execSync('git diff --cached --name-only', {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    stagedFiles = output.trim().split('\n').filter(Boolean);
  } catch (err) {
    // git diff failed — fail closed rather than silently allowing the commit
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[aglc] Could not read staged files from git: ${msg}\nEnsure you are inside a git repository with staged changes.`);
  }

  const byComponent = new Map<string, string[]>();

  for (const relFile of stagedFiles) {
    const absFile = join(projectRoot, relFile);
    addFileToComponents(byComponent, projectRoot, artifact, absFile);
  }

  return [...byComponent.entries()].map(([componentName, files]) => ({ componentName, files }));
}

export function parseDiffAgainst(
  projectRoot: string,
  artifact: ArchitectureArtifact,
  baseRef: string,
): ChangedComponent[] {
  let changedFiles: string[];

  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    changedFiles = output.trim().split('\n').filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[aglc] Could not read files changed against '${baseRef}...HEAD': ${msg}`);
  }

  const byComponent = new Map<string, string[]>();

  for (const relFile of changedFiles) {
    const absFile = join(projectRoot, relFile);
    addFileToComponents(byComponent, projectRoot, artifact, absFile);
  }

  return [...byComponent.entries()].map(([componentName, files]) => ({ componentName, files }));
}

/**
 * Match every project file against declared component globs. Used by
 * `aglc check --all` to validate the complete working tree instead of only the
 * staged git diff.
 */
export function parseProjectFiles(
  projectRoot: string,
  artifact: ArchitectureArtifact,
): ChangedComponent[] {
  const byComponent = new Map<string, string[]>();
  for (const absFile of collectProjectFiles(projectRoot)) {
    addFileToComponents(byComponent, projectRoot, artifact, absFile);
  }
  return [...byComponent.entries()].map(([componentName, files]) => ({ componentName, files }));
}
