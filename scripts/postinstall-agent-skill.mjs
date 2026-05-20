import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

try {
  if (process.env.AGLANG_SKIP_AGENT_SKILL_INSTALL === '1') {
    process.exit(0);
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = resolve(packageRoot, 'skills', 'aglang');
  if (!existsSync(source)) {
    process.exit(0);
  }

  const codexHome =
    process.env.CODEX_HOME ??
    (process.env.USERPROFILE
      ? resolve(process.env.USERPROFILE, '.codex')
      : resolve(process.env.HOME ?? '.', '.codex'));
  const skillsDir = resolve(codexHome, 'skills');
  const target = resolve(skillsDir, 'aglang');

  mkdirSync(skillsDir, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  console.log(`[aglang] Installed Codex skill -> ${target}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[aglang] Skipped Codex skill auto-install: ${message}`);
  process.exit(0);
}
