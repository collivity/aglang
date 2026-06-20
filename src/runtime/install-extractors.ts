import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join } from 'path';

export interface InstallExtractorsResult {
  installed: string[];
  skipped: string[];
}

export function installExtractorTemplates(templatesDir: string, targetDir: string, force = false): InstallExtractorsResult {
  if (!existsSync(templatesDir)) {
    throw new Error(`packaged extractor templates not found at ${templatesDir}`);
  }
  mkdirSync(targetDir, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(templatesDir).filter(file => /\.agq\.ya?ml$/i.test(file)).sort()) {
    const targetPath = join(targetDir, name);
    if (existsSync(targetPath) && !force) {
      skipped.push(name);
      continue;
    }
    copyFileSync(join(templatesDir, name), targetPath);
    installed.push(name);
  }
  return { installed, skipped };
}
