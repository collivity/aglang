import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { parseProjectFiles } from '../src/runtime/diff-parser.ts';

function compileSpec(source: string) {
  const tokens = tokenize(source);
  const program = parse(tokens);
  return emitArtifact(program, 'test-spec.ag');
}

describe('project-wide check file discovery', () => {
  it('maps all component files from architecture.o without staged git changes', () => {
    const tmpDir = join(tmpdir(), `aglang-all-check-${Date.now()}`);
    mkdirSync(join(tmpDir, 'src', 'cli'), { recursive: true });
    mkdirSync(join(tmpDir, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'cli', 'index.ts'), 'export const cli = true;\n');
    writeFileSync(join(tmpDir, 'src', 'runtime', 'gate.ts'), 'export const gate = true;\n');
    writeFileSync(join(tmpDir, 'README.md'), '# ignored\n');

    try {
      const artifact = compileSpec(`
        node n : node_runtime { trust: trusted }
        component CliCompiler { runs_on: n paths: "src/cli/**/*.ts" }
        component RuntimeGate { runs_on: n paths: "src/runtime/**/*.ts" }
      `);

      const changed = parseProjectFiles(tmpDir, artifact);
      const byComponent = new Map(changed.map(c => [c.componentName, c.files]));

      expect(byComponent.get('CliCompiler')).toHaveLength(1);
      expect(byComponent.get('RuntimeGate')).toHaveLength(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
