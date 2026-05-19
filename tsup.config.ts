import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  // z3-solver ships its own WASM — don't bundle it, keep as external dep
  external: ['z3-solver'],
  treeshake: true,
  minify: false,
  sourcemap: false,
});
