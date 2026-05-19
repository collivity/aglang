// Git diff parser — maps changed files to architecture components
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import micromatch from 'micromatch';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';

export interface ChangedComponent {
  componentName: string;
  files: string[]; // absolute paths
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
    for (const [componentName, glob] of Object.entries(artifact.mappings)) {
      if (micromatch.isMatch(relFile, glob)) {
        if (!byComponent.has(componentName)) byComponent.set(componentName, []);
        byComponent.get(componentName)!.push(absFile);
      }
    }
  }

  return [...byComponent.entries()].map(([componentName, files]) => ({ componentName, files }));
}
