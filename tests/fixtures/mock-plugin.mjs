#!/usr/bin/env node
// Mock aglc-compatible subprocess extractor plugin for testing.
// Implements the aglang subprocess plugin protocol:
//   --info       → print capability JSON
//   --component  → extract FlowFact[] JSON

const args = process.argv.slice(2);

if (args.includes('--info')) {
  process.stdout.write(JSON.stringify({
    name: 'mock-extractor',
    extensions: ['.mock'],
    version: '1.0.0',
  }));
  process.exit(0);
}

// Extraction mode
const componentIdx = args.indexOf('--component');
const filesIdx = args.indexOf('--files');
const componentName = componentIdx >= 0 ? args[componentIdx + 1] : 'Unknown';
const files = filesIdx >= 0 ? args.slice(filesIdx + 1) : [];

// Emit a deterministic fake FlowFact for each file
const facts = files.map(f => ({
  from: componentName,
  to: 'MockDatabase',
  confidence: 'definite',
  evidence: `Mock flow detected in ${f}`,
  file: f,
  line: 1,
}));

process.stdout.write(JSON.stringify(facts));
process.exit(0);
