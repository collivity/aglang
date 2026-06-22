import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { aglc: 'src/index.ts' },
  format: ['esm'],
  target: 'node18',
  outDir: 'build',
  clean: false,
  splitting: false,
  // Native/WASM packages must stay external so the published CLI loads their
  // package-local bindings instead of trying to require them from the ESM bundle.
  external: [
    'z3-solver',
    'tree-sitter',
    'tree-sitter-c-sharp',
    'tree-sitter-go',
    'tree-sitter-java',
    'tree-sitter-javascript',
    'tree-sitter-python',
    'tree-sitter-rust',
    'tree-sitter-typescript',
  ],
  treeshake: true,
  minify: false,
  sourcemap: false,
});
