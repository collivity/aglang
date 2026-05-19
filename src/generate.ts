// aglc generate — scan a project directory and emit a starter .ag spec file.
//
// Designed to be run by AI agents bootstrapping architecture guardrails for an
// existing codebase. Output is a valid, compilable .ag file that captures:
//   - Infrastructure nodes inferred from code (DB calls, queue usage, etc.)
//   - Component declarations derived from project manifests (package.json, *.csproj, …)
//   - Contract blocks containing discovered HTTP routes
//
// The generated spec is intentionally conservative — it documents what exists,
// not what should exist. The architect / agent then adds invariant blocks to
// establish the actual architectural rules.

import { readdirSync, readFileSync, existsSync } from 'fs';
import type { Dirent } from 'fs';
import { join, relative, extname, basename, sep } from 'path';
import type { ExtractorPlugin, FlowFact } from './analyzers/plugin.ts';
import { csharpPlugin } from './analyzers/csharp.ts';
import { kotlinPlugin } from './analyzers/kotlin.ts';
import { pythonPlugin } from './analyzers/python.ts';
import { goPlugin } from './analyzers/golang.ts';
import { rustPlugin } from './analyzers/rust.ts';
import { javaPlugin, scalaPlugin } from './analyzers/java.ts';
import { typescriptServerPlugin } from './analyzers/typescript-server.ts';
import { swiftPlugin } from './analyzers/swift.ts';
import { extractServerRoutes } from './analyzers/routes.ts';
import type { RouteFact } from './analyzers/routes.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'bin', 'obj', 'target',
  '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv', 'env',
  '.gradle', '.idea', '.vs', 'coverage', '.cache', 'out', 'tmp', 'temp',
  'public', 'static', 'assets', '.svelte-kit',
]);

// Manifest filename → project type
type LangType = 'npm' | 'dotnet' | 'go' | 'java' | 'gradle' | 'rust' | 'swift' | 'python';

const MANIFEST_TO_LANG: Record<string, LangType> = {
  'package.json': 'npm',
  'go.mod': 'go',
  'pom.xml': 'java',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'Cargo.toml': 'rust',
  'Package.swift': 'swift',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'setup.py': 'python',
};

const LANG_GLOB: Record<LangType, string> = {
  npm: '**/*.{ts,tsx,js,jsx}',
  dotnet: '**/*.cs',
  go: '**/*.go',
  java: '**/*.java',
  gradle: '**/*.{java,kt}',
  rust: '**/*.rs',
  swift: '**/*.swift',
  python: '**/*.py',
};

const LANG_EXTENSIONS: Record<LangType, string[]> = {
  npm: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
  dotnet: ['.cs', '.csx'],
  go: ['.go'],
  java: ['.java'],
  gradle: ['.java', '.kt'],
  rust: ['.rs'],
  swift: ['.swift'],
  python: ['.py', '.pyw'],
};

// Maps fact.to category names to aglang node types
const TARGET_TO_NODE_TYPE: Record<string, string> = {
  postgres: 'postgres', postgres_db: 'postgres',
  mysql: 'mysql', mariadb: 'mysql',
  mssql: 'mssql', sqlserver: 'mssql',
  redis: 'redis', redis_cache: 'redis',
  mongodb: 'mongodb',
  dynamodb: 'dynamodb', cosmos_db: 'dynamodb', cosmosdb: 'dynamodb',
  elasticsearch: 'elasticsearch', opensearch: 'elasticsearch',
  cassandra: 'cassandra',
  s3: 's3_bucket', s3_bucket: 's3_bucket', blob_storage: 's3_bucket',
  kafka: 'event_stream', kinesis: 'event_stream',
  sqs: 'message_queue', service_bus: 'message_queue', rabbitmq: 'message_queue',
  firebase: 'firebase', firestore: 'firebase',
  cloudkit: 'cloudkit',
  neo4j: 'neo4j',
  vector_db: 'vector_db',
};

// ── Identifier sanitization ───────────────────────────────────────────────────

function toIdentifier(raw: string): string {
  const words = raw
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '_Unknown';
  const pascal = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
  return /^\d/.test(pascal) ? `_${pascal}` : pascal;
}

function dedupeName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name; }
  let i = 2;
  while (used.has(`${name}${i}`)) i++;
  const unique = `${name}${i}`;
  used.add(unique);
  return unique;
}

// ── Manifest detection ────────────────────────────────────────────────────────

interface Manifest {
  lang: LangType;
  file: string;   // absolute path to manifest
  dir: string;    // absolute path to component dir (= dirname of manifest)
}

/** Derive a human-readable component name from the manifest file/content. */
function deriveNameFromManifest(m: Manifest): string {
  // npm: prefer the "name" field from package.json (strip @scope/ prefix)
  if (m.lang === 'npm') {
    try {
      const pkg = JSON.parse(readFileSync(m.file, 'utf8')) as Record<string, unknown>;
      if (typeof pkg.name === 'string' && pkg.name) {
        return toIdentifier((pkg.name as string).replace(/^@[^/]+\//, ''));
      }
    } catch { /* fall through */ }
  }
  // dotnet: use the .csproj filename without extension
  if (m.lang === 'dotnet') {
    const csName = basename(m.file).replace(/\.csproj$/, '');
    if (csName) return toIdentifier(csName);
  }
  // go: use the last path segment of the module name
  if (m.lang === 'go') {
    try {
      const content = readFileSync(m.file, 'utf8');
      const match = content.match(/^module\s+(\S+)/m);
      if (match) {
        const segments = match[1].split('/');
        return toIdentifier(segments[segments.length - 1]);
      }
    } catch { /* fall through */ }
  }
  // rust: use [package] name from Cargo.toml
  if (m.lang === 'rust') {
    try {
      const content = readFileSync(m.file, 'utf8');
      const match = content.match(/^\[package\][^[]*\bname\s*=\s*"([^"]+)"/ms);
      if (match) return toIdentifier(match[1]);
    } catch { /* fall through */ }
  }
  // Default: directory basename
  return toIdentifier(basename(m.dir));
}

function isWorkspaceRoot(manifestFile: string): boolean {
  if (!manifestFile.endsWith('package.json')) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    return Array.isArray(pkg.workspaces) ||
      (typeof pkg.workspaces === 'object' && pkg.workspaces !== null);
  } catch { return false; }
}

function walkForManifests(dir: string, results: Manifest[], depth = 0): void {
  if (depth > 8) return;
  let entries: Dirent<string>[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkForManifests(join(dir, entry.name), results, depth + 1);
    } else {
      const lang = MANIFEST_TO_LANG[entry.name];
      if (lang) {
        const file = join(dir, entry.name);
        if (isWorkspaceRoot(file)) continue;   // skip npm workspace aggregators
        results.push({ lang, file, dir });
      } else if (/\.csproj$/.test(entry.name)) {
        results.push({ lang: 'dotnet', file: join(dir, entry.name), dir });
      }
    }
  }
}

// Remove manifests whose dir is an ancestor of another manifest's dir
// (e.g., a root pom.xml when sub-modules have their own pom.xml)
function filterAncestorManifests(manifests: Manifest[]): Manifest[] {
  return manifests.filter(m => {
    // Keep if no other manifest dir is a descendant of this dir
    return !manifests.some(other =>
      other.dir !== m.dir && other.dir.startsWith(m.dir + sep),
    );
  });
}

// ── File collection ───────────────────────────────────────────────────────────

function collectFiles(dir: string, exts: Set<string>, limit = 300): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    if (results.length >= limit) return;
    let entries: Dirent<string>[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(join(d, entry.name));
      } else if (exts.has(extname(entry.name).toLowerCase())) {
        results.push(join(d, entry.name));
      }
    }
  }
  walk(dir);
  return results;
}

// ── Plugin dispatch ───────────────────────────────────────────────────────────

const ALL_PLUGINS: ExtractorPlugin[] = [
  csharpPlugin, kotlinPlugin, pythonPlugin, goPlugin, rustPlugin,
  javaPlugin, scalaPlugin, typescriptServerPlugin, swiftPlugin,
];

function buildExtMap(): Map<string, ExtractorPlugin> {
  const m = new Map<string, ExtractorPlugin>();
  for (const p of ALL_PLUGINS) for (const ext of p.extensions) m.set(ext, p);
  return m;
}
const EXT_MAP = buildExtMap();

async function extractFlows(
  componentName: string,
  files: string[],
  mappings: Record<string, string>,
): Promise<FlowFact[]> {
  const byExt = new Map<string, string[]>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (EXT_MAP.has(ext)) {
      const b = byExt.get(ext) ?? [];
      b.push(f);
      byExt.set(ext, b);
    }
  }
  const batches = await Promise.all(
    Array.from(byExt.entries()).map(([ext, batch]) =>
      EXT_MAP.get(ext)!.extract({ componentName, files: batch, mappings }),
    ),
  );
  return batches.flat();
}

// ── Node type inference ───────────────────────────────────────────────────────

function inferNodeType(target: string): string | null {
  const t = target.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return TARGET_TO_NODE_TYPE[t] ?? null;
}

function inferComputeNodeType(componentDir: string): string {
  if (existsSync(join(componentDir, 'Dockerfile'))) return 'container';
  if (
    existsSync(join(componentDir, 'k8s')) ||
    existsSync(join(componentDir, 'kubernetes'))
  ) return 'k8s_pod';
  return 'server';
}

// ── .ag code generation ───────────────────────────────────────────────────────

function indentBlock(lines: string[], indent = '  '): string {
  return lines.map(l => (l ? indent + l : '')).join('\n');
}

function emitNode(name: string, type: string, trust: string): string {
  return `node ${name} : ${type} { trust: ${trust} }`;
}

function emitContract(name: string, routes: RouteFact[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of routes) {
    const key = `${r.method} ${r.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${r.method} "${r.normalized}"`);
  }
  if (lines.length === 0) return '';
  return `contract ${name} {\n${indentBlock(lines)}\n}`;
}

function emitComponent(
  name: string,
  runsOn: string,
  pathGlob: string,
  contractName: string | null,
): string {
  const lines = [`runs_on: ${runsOn}`, `paths: "${pathGlob}"`];
  if (contractName) lines.push(`implements: ${contractName}`);
  return `component ${name} {\n${indentBlock(lines)}\n}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GenerateResult {
  ag: string;
  components: number;
  infrastructureNodes: number;
  contracts: number;
  warnings: string[];
}

export async function generateSpec(
  projectRoot: string,
  opts: { projectName?: string } = {},
): Promise<GenerateResult> {
  const warnings: string[] = [];
  const projectName = opts.projectName ?? 'GeneratedSpec';

  // Step 1: Detect manifests
  const rawManifests: Manifest[] = [];
  walkForManifests(projectRoot, rawManifests);
  const manifests = filterAncestorManifests(rawManifests);

  // Fallback: if no manifests found, treat each top-level subdir as a component
  if (manifests.length === 0) {
    warnings.push(
      'No project manifests found (package.json, *.csproj, go.mod, …). ' +
      'Add invariants manually.',
    );
  }

  // Step 2: Build component descriptors
  const usedNames = new Set<string>();
  const usedComputeNodeNames = new Set<string>();

  interface ComponentDesc {
    name: string;
    lang: LangType;
    dir: string;
    pathGlob: string;    // root-relative
    computeNodeName: string;
    computeNodeType: string;
    files: string[];
  }

  const components: ComponentDesc[] = [];
  for (const m of manifests) {
    const rawName = deriveNameFromManifest(m);
    const name = dedupeName(rawName, usedNames);
    const relDir = relative(projectRoot, m.dir).replace(/\\/g, '/') || '.';
    const globBase = relDir === '.' ? '' : relDir + '/';
    const pathGlob = globBase + LANG_GLOB[m.lang];
    const exts = new Set(LANG_EXTENSIONS[m.lang]);
    const files = collectFiles(m.dir, exts);
    const computeType = inferComputeNodeType(m.dir);
    const computeNodeName = dedupeName(toIdentifier(`${name}Server`), usedComputeNodeNames);

    components.push({ name, lang: m.lang, dir: m.dir, pathGlob, computeNodeName, computeNodeType: computeType, files });
  }

  // Fallback: treat project root as one component if no manifests
  if (components.length === 0) {
    const name = toIdentifier(projectName);
    const allSourceExts = new Set(Object.values(LANG_EXTENSIONS).flat());
    const files = collectFiles(projectRoot, allSourceExts);
    components.push({
      name,
      lang: 'npm',
      dir: projectRoot,
      pathGlob: '**/*.{ts,js,cs,py,go,rs,java,swift}',
      computeNodeName: 'AppServer',
      computeNodeType: 'server',
      files,
    });
  }

  // Step 3: Extract flows and routes for each component
  const mappings: Record<string, string> = {};
  for (const c of components) mappings[c.name] = c.pathGlob;

  const allInfraNodes = new Map<string, string>();  // name → nodeType
  const allComputeNodes = new Map<string, string>(); // name → nodeType

  interface ContractDesc { componentName: string; contractName: string; routes: RouteFact[] }
  const contracts: ContractDesc[] = [];

  for (const comp of components) {
    allComputeNodes.set(comp.computeNodeName, comp.computeNodeType);

    // Extract infrastructure flows
    const facts = await extractFlows(comp.name, comp.files, mappings);
    for (const fact of facts) {
      const nodeType = inferNodeType(fact.to);
      if (nodeType && !allInfraNodes.has(fact.to)) {
        allInfraNodes.set(fact.to, nodeType);
      }
    }

    // Extract server routes → contracts
    const routes = await extractServerRoutes(comp.files);
    if (routes.length > 0) {
      const contractName = `${comp.name}Contract`;
      contracts.push({ componentName: comp.name, contractName, routes });
    }
  }

  // Step 4: Emit .ag source
  const lines: string[] = [];

  lines.push(
    `// Generated by aglc generate — review and customize`,
    `// Project: ${projectName}`,
    `// Components: ${components.length} | Infrastructure nodes: ${allInfraNodes.size} | Contracts: ${contracts.length}`,
    `// Add invariant blocks below to enforce architectural rules.`,
    ``,
  );

  // Compute (server/container) nodes
  lines.push(`// ── Compute nodes ────────────────────────────────────────────`);
  for (const [nodeName, nodeType] of allComputeNodes) {
    lines.push(emitNode(nodeName, nodeType, 'trusted'));
  }
  lines.push('');

  // Infrastructure nodes
  if (allInfraNodes.size > 0) {
    lines.push(`// ── Infrastructure nodes (detected from code analysis) ───────`);
    for (const [nodeName, nodeType] of allInfraNodes) {
      lines.push(emitNode(nodeName, nodeType, 'trusted'));
    }
    lines.push('');
  }

  // Contract blocks
  if (contracts.length > 0) {
    lines.push(`// ── Contracts (HTTP endpoints found in code) ─────────────────`);
    for (const { contractName, routes } of contracts) {
      const block = emitContract(contractName, routes);
      if (block) {
        lines.push(block);
        lines.push('');
      }
    }
  }

  // Component blocks
  lines.push(`// ── Components ───────────────────────────────────────────────`);
  const contractByComp = new Map(contracts.map(c => [c.componentName, c.contractName]));
  for (const comp of components) {
    const contractName = contractByComp.get(comp.name) ?? null;
    lines.push(emitComponent(comp.name, comp.computeNodeName, comp.pathGlob, contractName));
    lines.push('');
  }

  // Invariant placeholder
  lines.push(`// ── Invariants ────────────────────────────────────────────────`);
  lines.push(`// Add deny/require flow rules here. Example:`);
  if (components.length >= 2 && allInfraNodes.size > 0) {
    const [firstComp] = components;
    const [[firstInfraNode]] = allInfraNodes;
    lines.push(`// invariant NoDirectDbAccess {`);
    lines.push(`//   deny flow ${firstComp.name} -> ${firstInfraNode}`);
    lines.push(`// }`);
  } else {
    lines.push(`// invariant MyRule {`);
    lines.push(`//   deny flow ComponentA -> ComponentB`);
    lines.push(`// }`);
  }

  return {
    ag: lines.join('\n'),
    components: components.length,
    infrastructureNodes: allInfraNodes.size,
    contracts: contracts.length,
    warnings,
  };
}
