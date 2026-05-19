import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { aglc: 'src/index.ts' },
  format: ['esm'],
  target: 'node18',
  outDir: 'build',
  clean: false,
  splitting: false,
  // z3-solver ships its own WASM — don't bundle it, keep as external dep
  external: ['z3-solver'],
  treeshake: true,
  minify: false,
  sourcemap: false,
});
