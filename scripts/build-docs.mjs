process.env.DEBUG ??= 'vitepress:keep-temp';

import fs from 'node:fs';
import { resolve } from 'node:path';

const copyFileSync = fs.copyFileSync.bind(fs);
fs.copyFileSync = (src, dest, mode) => {
  try {
    copyFileSync(src, dest, mode);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    fs.writeFileSync(dest, fs.readFileSync(src));
  }
};

const { build } = await import('vitepress');

await build('docs', {
  outDir: 'docs-build/site',
  onAfterConfigResolve(config) {
    config.outDir = resolve('docs-build/site');
    config.tempDir = resolve('docs-build/temp');
  }
});
