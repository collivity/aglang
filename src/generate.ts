// aglc generate — scan a project directory and emit a starter .ag spec file.
//
// Designed to be run by AI agents bootstrapping architecture guardrails for an
// existing codebase. Output is a valid, compilable .ag file set that captures:
//   - Infrastructure nodes inferred from code (DB calls, queue usage, etc.)
//   - Component declarations synthesized from semantic runtime structure
//   - Contract blocks containing discovered HTTP routes
//
// The generated spec is intentionally descriptive — it documents what exists,
// not what should exist. The architect / agent then adds invariant blocks to
// establish the actual architectural rules.

import { existsSync, readdirSync, readFileSync } from 'fs';
import type { Dirent } from 'fs';
import { basename, dirname, extname, join, relative, sep } from 'path';
import type { ExtractorPlugin, FlowFact } from './analyzers/plugin.ts';
import { csharpPlugin } from './analyzers/csharp.ts';
import { goPlugin } from './analyzers/golang.ts';
import { javaPlugin, scalaPlugin } from './analyzers/java.ts';
import { kotlinPlugin } from './analyzers/kotlin.ts';
import { pythonPlugin } from './analyzers/python.ts';
import { rustPlugin } from './analyzers/rust.ts';
import { swiftPlugin } from './analyzers/swift.ts';
import { extractServerRoutes } from './analyzers/routes.ts';
import type { RouteFact } from './analyzers/routes.ts';
import { typescriptServerPlugin } from './analyzers/typescript-server.ts';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'bin', 'obj', 'target',
  '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv', 'env',
  '.gradle', '.idea', '.vs', 'coverage', '.cache', 'out', 'tmp', 'temp',
  'public', 'static', 'assets', '.svelte-kit',
]);

type LangType = 'npm' | 'dotnet' | 'go' | 'java' | 'gradle' | 'rust' | 'swift' | 'python';
type RootKind = 'backend' | 'frontend' | 'mobile' | 'native' | 'library';
type SemanticRole =
  | 'runtime'
  | 'ui'
  | 'viewmodel'
  | 'application'
  | 'repository'
  | 'infrastructure'
  | 'storage'
  | 'messaging'
  | 'tooling'
  | 'test'
  | 'example'
  | 'generated';

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

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const DEFAULT_MAX_DEPTH = 3;
const MAX_FILES_PER_UNIT = 2000;
const IMPORT_COMPONENT_THRESHOLD = 3;
const CONTRACT_UTILITY_ROUTE_RE = /\/(?:health|healthz|ready|readiness|live|liveness|metrics|metric|debug|diagnostics?|internal|test|tests)(?:\/|$)/i;
const DOMAIN_STOP_WORDS = new Set([
  'src', 'main', 'test', 'tests', 'androidtest', 'ios', 'android', 'java', 'kotlin', 'swift', 'cs',
  'app', 'apps', 'lib', 'libs', 'pkg', 'packages', 'module', 'modules', 'feature', 'features',
  'domain', 'domains', 'shared', 'common', 'core', 'platform', 'infra', 'infrastructure',
  'integration', 'integrations', 'service', 'services', 'controller', 'controllers', 'handler', 'handlers',
  'route', 'routes', 'api', 'apis', 'repository', 'repositories', 'repo', 'repos', 'data', 'datasource',
  'datasources', 'storage', 'database', 'databases', 'db', 'model', 'models', 'entity', 'entities',
  'dto', 'dtos', 'view', 'views', 'viewmodel', 'viewmodels', 'screen', 'screens', 'page', 'pages',
  'fragment', 'fragments', 'activity', 'activities', 'composable', 'composables', 'widget', 'widgets',
  'ui', 'presentation', 'navigation', 'coordinator', 'coordinators', 'worker', 'workers', 'jobs',
  'background', 'network', 'http', 'client', 'clients', 'adapter', 'adapters', 'gateway', 'gateways',
  'provider', 'providers', 'config', 'configuration', 'generated', 'gen', 'migrations', 'migration',
  'wwwroot', 'resources', 'res', 'store', 'stores', 'cache', 'caches', 'xctests',
]);
const PACKAGE_PATH_SEGMENTS = new Set([
  'com', 'org', 'io', 'net', 'dev', 'app', 'co', 'ai', 'me', 'uk', 'de', 'fr', 'es',
]);

const TARGET_TO_NODE_TYPE: Record<string, string> = {
  postgres: 'postgres', postgres_db: 'postgres', relational_db: 'postgres',
  mysql: 'mysql', mariadb: 'mysql',
  mssql: 'mssql', sqlserver: 'mssql',
  redis: 'redis', redis_cache: 'redis', cache: 'redis',
  mongodb: 'mongodb',
  dynamodb: 'dynamodb', cosmos_db: 'dynamodb', cosmosdb: 'dynamodb',
  elasticsearch: 'elasticsearch', opensearch: 'elasticsearch',
  cassandra: 'cassandra',
  s3: 's3_bucket', s3_bucket: 's3_bucket', blob_storage: 's3_bucket', object_store: 's3_bucket',
  kafka: 'event_stream', kinesis: 'event_stream',
  sqs: 'message_queue', service_bus: 'message_queue', rabbitmq: 'message_queue', message_queue: 'message_queue',
  firebase: 'firebase', firestore: 'firebase',
  cloudkit: 'cloudkit',
  neo4j: 'neo4j',
  vector_db: 'vector_db',
  graphql_api: 'graphql_api',
  grpc_api: 'grpc_service',
};

const TARGET_TO_RESOURCE_TYPE: Record<string, string> = {
  secure_storage: 'secure_storage',
  local_preferences: 'local_preferences',
  external_api: 'external_api',
  local_database: 'local_database',
  local_store: 'local_database',
  reactive_stream: 'reactive_stream',
  message_bus: 'message_bus',
  file_system: 'file_system',
  sensor: 'sensor',
  device_hardware: 'device_hardware',
};

interface Manifest {
  lang: LangType;
  file: string;
  dir: string;
}

interface SourceGroup {
  name: string;
  filePath: string;
  importPath: string;
  components: ComponentDesc[];
}

interface ComponentDesc {
  name: string;
  dir: string;
  pathGlob: string;
  computeNodeName: string;
  computeNodeType: string;
  files: string[];
  group?: string;
  semanticLabel?: string;
}

interface RootUnit {
  name: string;
  lang: LangType;
  dir: string;
  exts: Set<string>;
  computeNodeName: string;
  computeNodeType: string;
  files: string[];
}

interface FileProfile {
  file: string;
  relPath: string;
  dirSegments: string[];
  fileName: string;
  fileStem: string;
  role: SemanticRole;
  domain: string | null;
  runtimeWeight: number;
}

interface SemanticSlice {
  key: string;
  label: string;
  domain: string | null;
  role: SemanticRole;
  files: string[];
  weight: number;
}

export interface GeneratedSpecFile {
  path: string;
  content: string;
}

export interface GenerateResult {
  ag: string;
  files: GeneratedSpecFile[];
  components: number;
  infrastructureNodes: number;
  contracts: number;
  warnings: string[];
}

export interface GenerateSpecOptions {
  projectName?: string;
  deep?: boolean;
  maxDepth?: number;
  singleFile?: boolean;
  rootFileName?: string;
}

function toIdentifier(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '_Unknown';
  const pascal = words.map(w => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^\d/.test(pascal) ? `_${pascal}` : pascal;
}

function dedupeName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name}${i}`)) i++;
  const unique = `${name}${i}`;
  used.add(unique);
  return unique;
}

function deriveNameFromManifest(m: Manifest): string {
  if (m.lang === 'npm') {
    try {
      const pkg = JSON.parse(readFileSync(m.file, 'utf8')) as Record<string, unknown>;
      if (typeof pkg.name === 'string' && pkg.name) {
        return toIdentifier(pkg.name.replace(/^@[^/]+\//, ''));
      }
    } catch {}
  }
  if (m.lang === 'dotnet') {
    const csName = basename(m.file).replace(/\.csproj$/, '');
    if (csName) return toIdentifier(csName);
  }
  if (m.lang === 'go') {
    try {
      const content = readFileSync(m.file, 'utf8');
      const match = content.match(/^module\s+(\S+)/m);
      if (match) {
        const segments = match[1].split('/');
        return toIdentifier(segments[segments.length - 1]!);
      }
    } catch {}
  }
  if (m.lang === 'rust') {
    try {
      const content = readFileSync(m.file, 'utf8');
      const match = content.match(/^\[package\][^[]*\bname\s*=\s*"([^"]+)"/ms);
      if (match) return toIdentifier(match[1]!);
    } catch {}
  }
  return toIdentifier(basename(m.dir));
}

function isWorkspaceRoot(manifestFile: string): boolean {
  if (!manifestFile.endsWith('package.json')) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    return Array.isArray(pkg.workspaces)
      || (typeof pkg.workspaces === 'object' && pkg.workspaces !== null);
  } catch {
    return false;
  }
}

function walkForManifests(dir: string, results: Manifest[], depth = 0): void {
  if (depth > 8) return;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkForManifests(join(dir, entry.name), results, depth + 1);
      continue;
    }
    const lang = MANIFEST_TO_LANG[entry.name];
    if (lang) {
      const file = join(dir, entry.name);
      if (isWorkspaceRoot(file)) continue;
      results.push({ lang, file, dir });
    } else if (/\.csproj$/i.test(entry.name)) {
      results.push({ lang: 'dotnet', file: join(dir, entry.name), dir });
    }
  }
}

function collectFiles(
  dir: string,
  exts: Set<string>,
  limit = MAX_FILES_PER_UNIT,
  excludedDirs: Set<string> = new Set(),
): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    if (results.length >= limit) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirs.has(abs)) continue;
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(abs);
      } else if (exts.has(extname(entry.name).toLowerCase())) {
        results.push(abs);
      }
    }
  }
  walk(dir);
  return results;
}

function inferLanguageFromFiles(files: string[]): LangType | null {
  const score = new Map<LangType, number>();
  for (const [lang, exts] of Object.entries(LANG_EXTENSIONS) as Array<[LangType, string[]]>) {
    score.set(lang, 0);
    const extSet = new Set(exts);
    for (const file of files) {
      if (extSet.has(extname(file).toLowerCase())) {
        score.set(lang, (score.get(lang) ?? 0) + 1);
      }
    }
  }
  const winner = Array.from(score.entries()).sort((a, b) => b[1] - a[1])[0];
  return winner && winner[1] > 0 ? winner[0] : null;
}

function inferComputeNodeType(componentDir: string): string {
  if (existsSync(join(componentDir, 'Dockerfile'))) return 'container';
  if (existsSync(join(componentDir, 'k8s')) || existsSync(join(componentDir, 'kubernetes'))) return 'k8s_pod';
  return 'server';
}

const ALL_PLUGINS: ExtractorPlugin[] = [
  csharpPlugin, kotlinPlugin, pythonPlugin, goPlugin, rustPlugin,
  javaPlugin, scalaPlugin, typescriptServerPlugin, swiftPlugin,
];

function buildExtMap(): Map<string, ExtractorPlugin> {
  const m = new Map<string, ExtractorPlugin>();
  for (const p of ALL_PLUGINS) {
    for (const ext of p.extensions) m.set(ext, p);
  }
  return m;
}

const EXT_MAP = buildExtMap();

async function extractFlows(componentName: string, files: string[], mappings: Record<string, string>): Promise<FlowFact[]> {
  const byExt = new Map<string, string[]>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!EXT_MAP.has(ext)) continue;
    const bucket = byExt.get(ext) ?? [];
    bucket.push(f);
    byExt.set(ext, bucket);
  }
  const batches = await Promise.all(
    Array.from(byExt.entries()).map(([ext, batch]) =>
      EXT_MAP.get(ext)!.extract({ componentName, files: batch, mappings }),
    ),
  );
  return batches.flat();
}

function inferNodeType(target: string): string | null {
  const normalized = target.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return TARGET_TO_NODE_TYPE[normalized] ?? null;
}

function inferResourceType(target: string): string | null {
  const normalized = target.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return TARGET_TO_RESOURCE_TYPE[normalized] ?? null;
}

function sanitizeRouteMethod(method: string): string | null {
  const normalized = method.trim().toUpperCase();
  if (HTTP_METHODS.has(normalized)) return normalized;
  if (normalized === '*') return null;
  const stripped = normalized.replace(/[^A-Z]/g, '');
  return HTTP_METHODS.has(stripped) ? stripped : null;
}

function indentBlock(lines: string[], indent = '  '): string {
  return lines.map(line => (line ? indent + line : '')).join('\n');
}

function emitNode(name: string, type: string, trust: string): string {
  return `node ${name} : ${type} { trust: ${trust} }`;
}

function emitResource(name: string, type: string, trust: string): string {
  return `resource ${name} : ${type} { trust: ${trust} }`;
}

function emitContract(name: string, routes: RouteFact[], warnings: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const route of routes) {
    const method = sanitizeRouteMethod(route.method);
    if (!method) {
      warnings.push(`Skipped unsupported contract method '${route.method}' for route '${route.normalized}' in ${route.file}`);
      continue;
    }
    const key = `${method} ${route.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${method} "${route.normalized}"`);
  }
  if (lines.length === 0) return '';
  return `contract ${name} {\n${indentBlock(lines)}\n}`;
}

function emitComponent(name: string, runsOn: string, pathGlob: string, contractName: string | null): string {
  const lines = [`runs_on: ${runsOn}`, `paths: "${pathGlob}"`];
  if (contractName) lines.push(`implements: ${contractName}`);
  return `component ${name} {\n${indentBlock(lines)}\n}`;
}

function workflowComponentName(fileName: string, used: Set<string>): string {
  const base = fileName.replace(/\.ya?ml$/i, '');
  return dedupeName(`${toIdentifier(base)}Workflow`, used);
}

function detectWorkflowTargets(projectRoot: string): {
  workflows: Array<{ name: string; pathGlob: string; source: string }>;
  targets: Map<string, string>;
} {
  const workflowsDir = join(projectRoot, '.github', 'workflows');
  const workflows: Array<{ name: string; pathGlob: string; source: string }> = [];
  const targets = new Map<string, string>();
  const used = new Set<string>();
  if (!existsSync(workflowsDir)) return { workflows, targets };
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return { workflows, targets };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const abs = join(workflowsDir, entry.name);
    const source = readFileSync(abs, 'utf8');
    workflows.push({
      name: workflowComponentName(entry.name, used),
      pathGlob: `.github/workflows/${entry.name}`,
      source,
    });
    const lower = source.toLowerCase();
    if (/\bnpm\s+publish\b|npm-publish/.test(lower)) targets.set('npm_registry', 'package_registry');
    if (/peaceiris\/actions-gh-pages|actions\/deploy-pages|github-pages/.test(lower)) targets.set('github_pages', 'static_host');
    if (/\bgh\s+release\s+create\b|softprops\/action-gh-release|actions\/create-release/.test(lower)) targets.set('github_releases', 'release_host');
    if (/\bdocker\s+push\b|docker\/build-push-action/.test(lower)) targets.set('container_registry', 'container_registry');
  }
  return { workflows, targets };
}

function manifestRoots(projectRoot: string, usedNames: Set<string>, usedNodes: Set<string>): RootUnit[] {
  const manifests: Manifest[] = [];
  walkForManifests(projectRoot, manifests);
  const manifestDirs = manifests.map(m => m.dir).sort((a, b) => a.length - b.length);
  const roots: RootUnit[] = [];
  for (const manifest of manifests) {
    const exts = new Set(LANG_EXTENSIONS[manifest.lang]);
    const excludedDirs = new Set(
      manifestDirs.filter(dir => dir !== manifest.dir && dir.startsWith(manifest.dir + sep)),
    );
    const files = collectFiles(manifest.dir, exts, MAX_FILES_PER_UNIT, excludedDirs);
    const name = dedupeName(deriveNameFromManifest(manifest), usedNames);
    const computeNodeName = dedupeName(toIdentifier(`${name}Server`), usedNodes);
    roots.push({
      name,
      lang: manifest.lang,
      dir: manifest.dir,
      exts,
      computeNodeName,
      computeNodeType: inferComputeNodeType(manifest.dir),
      files,
    });
  }
  return roots;
}

function fallbackRoots(projectRoot: string, projectName: string, usedNames: Set<string>, usedNodes: Set<string>): RootUnit[] {
  const allSourceExts = new Set(Object.values(LANG_EXTENSIONS).flat());
  const rootFiles = collectFiles(projectRoot, allSourceExts);
  if (rootFiles.length === 0) return [];
  const lang = inferLanguageFromFiles(rootFiles) ?? 'npm';
  const name = dedupeName(toIdentifier(projectName), usedNames);
  const computeNodeName = dedupeName(toIdentifier(`${name}Server`), usedNodes);
  return [{
    name,
    lang,
    dir: projectRoot,
    exts: new Set(LANG_EXTENSIONS[lang]),
    computeNodeName,
    computeNodeType: inferComputeNodeType(projectRoot),
    files: rootFiles.filter(file => new Set(LANG_EXTENSIONS[lang]).has(extname(file).toLowerCase())),
  }];
}

function extGlob(exts: string[]): string {
  const cleaned = exts.map(ext => ext.replace(/^\./, ''));
  if (cleaned.length === 1) return `*.${cleaned[0]}`;
  return `*.{${cleaned.join(',')}}`;
}

function relativeGlob(projectRoot: string, dir: string, lang: LangType, recursive = true): string {
  const relDir = relative(projectRoot, dir).replace(/\\/g, '/') || '.';
  const globBase = relDir === '.' ? '' : `${relDir}/`;
  if (recursive) return globBase + LANG_GLOB[lang];
  return globBase + extGlob(LANG_EXTENSIONS[lang]);
}

function lowerSegments(relPath: string): string[] {
  return relPath.split(/[\\/]+/).filter(Boolean).map(segment => segment.toLowerCase());
}

function stemName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function stripSemanticSuffix(raw: string): string {
  const stripped = raw
    .replace(/(ViewModel|ViewController|Controller|Screen|Activity|Fragment|Page|Service|Repository|Store|Worker|Coordinator|Client|Api|Manager|Presenter|UseCase|Interactor|Handler|Job|Module|Feature)$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  return stripped;
}

function isPackageSegment(segment: string): boolean {
  return PACKAGE_PATH_SEGMENTS.has(segment) || /^[a-z]{1,3}$/.test(segment);
}

function classifyRole(relPath: string, content: string): SemanticRole {
  const normalizedPath = relPath.replace(/\\/g, '/').toLowerCase();
  const lc = content.toLowerCase();

  if (normalizedPath === 'package.swift') return 'tooling';

  if (
    /(^|\/)(tests?|__tests__|spec|specs|androidtest|xctests)(\/|$)/.test(normalizedPath)
    || /\.(test|spec)\./.test(normalizedPath)
    || /\bimport\s+xctest\b/.test(lc)
  ) return 'test';

  if (/(^|\/)(example|examples|sample|samples|demo|demos|playground)(\/|$)/.test(normalizedPath)) {
    return 'example';
  }

  if (
    /(^|\/)(scripts|tools|tooling|build|ci|config|configs|migrations|migration|fixtures)(\/|$)/.test(normalizedPath)
    || normalizedPath.includes('/.github/')
  ) return 'tooling';

  if (
    /(^|\/)(generated|gen|autogen|codegen)(\/|$)/.test(normalizedPath)
    || /\.designer\./.test(normalizedPath)
  ) return 'generated';

  if (
    /\bviewmodel\b/.test(normalizedPath)
    || /class\s+\w+viewmodel\b/.test(lc)
    || /observableobject|viewmodelblueprint/.test(lc)
  ) return 'viewmodel';

  if (
    /\b(screen|screens|activity|activities|fragment|fragments|page|pages|viewcontroller|views?|composable|composables|presentation|swiftui)\b/.test(normalizedPath)
    || /@composable\b|swiftui|uiviewcontroller|react\.createelement|from ['"]react['"]|jsx/.test(lc)
  ) return 'ui';

  if (
    /\b(worker|workers|job|jobs|queue|queues|sync|background|workmanager|consumer|producer)\b/.test(normalizedPath)
    || /\bworkmanager\b|\bkafka\b|\brabbitmq\b|\bconsumer\b|\bproducer\b/.test(lc)
  ) return 'messaging';

  if (
    /\b(storage|preferences|preference|keychain|room|realm|coredata|sqlite|database|datastore|persistence)\b/.test(normalizedPath)
    || /\buserdefaults\b|\bsecitem(add|copymatching|update|delete)\b|\bnspersistentcontainer\b|\broomdatabase\b/.test(lc)
  ) return 'storage';

  if (
    /\b(repository|repositories|dao|daos|store|stores|datasource|datasources)\b/.test(normalizedPath)
    || /class\s+\w+repository\b|interface\s+\w+repository\b/.test(lc)
  ) return 'repository';

  if (
    /\b(client|clients|gateway|gateways|adapter|adapters|integration|integrations|provider|providers|network|http)\b/.test(normalizedPath)
    || /\burlsession\b|\balamofire\b|\bretrofit\b|\bokhttp\b|\bhttpclient\b|\bgrpc\b|\bapollo\b/.test(lc)
  ) return 'infrastructure';

  if (
    /\b(controller|controllers|service|services|usecase|usecases|interactor|interactors|handler|handlers|route|routes)\b/.test(normalizedPath)
    || /\bapicontroller\b|app\.(get|post|put|delete|patch)\s*\(|@controller\b|@(get|post|put|delete|patch)\b/.test(lc)
  ) return 'application';

  return 'runtime';
}

function roleWeight(role: SemanticRole): number {
  switch (role) {
    case 'application':
    case 'runtime':
      return 5;
    case 'ui':
    case 'viewmodel':
    case 'repository':
    case 'storage':
    case 'infrastructure':
    case 'messaging':
      return 4;
    case 'tooling':
    case 'generated':
      return 1;
    case 'test':
    case 'example':
      return 0;
  }
}

function deriveDomain(relPath: string, fileStem: string, role: SemanticRole): string | null {
  const segments = lowerSegments(dirname(relPath));

  for (let i = 0; i < segments.length - 1; i++) {
    if (['feature', 'features', 'domain', 'domains', 'module', 'modules'].includes(segments[i]!)) {
      const next = segments[i + 1];
      if (next && !DOMAIN_STOP_WORDS.has(next) && !isPackageSegment(next)) {
        return toIdentifier(next);
      }
    }
  }

  const candidates = segments.filter(segment =>
    !DOMAIN_STOP_WORDS.has(segment)
    && !isPackageSegment(segment)
    && !/^\d+$/.test(segment),
  );
  if (candidates.length > 0) {
    return toIdentifier(candidates[candidates.length - 1]!);
  }

  if (['application', 'viewmodel', 'ui', 'repository'].includes(role)) {
    const stemCandidate = stripSemanticSuffix(fileStem);
    const normalizedStem = stemCandidate.toLowerCase();
    if (stemCandidate && !['index', 'main', 'program', 'app', 'server', 'client', 'src'].includes(normalizedStem)) {
      return toIdentifier(stemCandidate);
    }
  }

  return null;
}

function profileFiles(root: RootUnit): FileProfile[] {
  const profiles: FileProfile[] = [];
  for (const file of root.files) {
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {}
    const relPath = relative(root.dir, file).replace(/\\/g, '/');
    const fileName = basename(file);
    const fileStem = stemName(fileName);
    const role = classifyRole(relPath, content);
    profiles.push({
      file,
      relPath,
      dirSegments: lowerSegments(dirname(relPath)),
      fileName,
      fileStem,
      role,
      domain: deriveDomain(relPath, fileStem, role),
      runtimeWeight: roleWeight(role),
    });
  }
  return profiles;
}

function detectRootKind(root: RootUnit, profiles: FileProfile[]): RootKind {
  if (root.lang === 'swift') return 'native';
  if (root.lang === 'gradle') return 'mobile';

  const roleCounts = profiles.reduce((acc, profile) => {
    acc[profile.role] = (acc[profile.role] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const hasUi = (roleCounts.ui ?? 0) > 0;
  const hasViewModel = (roleCounts.viewmodel ?? 0) > 0;
  const hasBackend = (roleCounts.application ?? 0) > 0 || root.lang === 'dotnet' || root.lang === 'go' || root.lang === 'java' || root.lang === 'python';

  if (hasUi && hasViewModel) return root.lang === 'npm' ? 'frontend' : 'mobile';
  if (hasUi && !hasBackend) return 'frontend';
  if (hasBackend) return 'backend';
  return 'library';
}

function isRuntimeRole(role: SemanticRole): boolean {
  return !['tooling', 'test', 'example', 'generated'].includes(role);
}

function semanticLabelForProfile(kind: RootKind, profile: FileProfile): string {
  const domain = profile.domain;
  if (kind === 'backend') {
    if (profile.role === 'storage' || profile.role === 'repository') {
      return domain && domain !== 'Core' ? domain : 'Persistence';
    }
    if (profile.role === 'infrastructure') {
      return domain && domain !== 'Core' ? domain : 'ExternalIntegrations';
    }
    if (profile.role === 'messaging') {
      return domain && domain !== 'Core' ? domain : 'Background';
    }
    return domain ?? 'Core';
  }

  if (kind === 'mobile' || kind === 'native') {
    const safeDomain = domain ?? (profile.role === 'storage' || profile.role === 'infrastructure' ? 'Platform' : 'Core');
    const suffix = profile.role === 'ui' ? 'Ui'
      : profile.role === 'viewmodel' ? 'ViewModel'
      : profile.role === 'repository' ? 'Data'
      : profile.role === 'storage' ? 'Storage'
      : profile.role === 'infrastructure' ? 'Network'
      : profile.role === 'messaging' ? 'Background'
      : 'Domain';
    return `${safeDomain}${suffix}`;
  }

  if (kind === 'frontend') {
    const safeDomain = domain ?? 'App';
    if (profile.role === 'ui') return `${safeDomain}Ui`;
    if (profile.role === 'viewmodel') return `${safeDomain}ViewModel`;
    if (profile.role === 'infrastructure') return domain ? `${domain}Api` : 'Api';
    return safeDomain;
  }

  const safeDomain = domain ?? 'Core';
  return profile.role === 'storage' ? 'Persistence'
    : profile.role === 'infrastructure' ? 'Integrations'
    : safeDomain;
}

function mergeKey(label: string, role: SemanticRole, kind: RootKind): string {
  if (kind === 'backend' || kind === 'library') return label;
  return `${label}:${role}`;
}

function buildSemanticSlices(kind: RootKind, profiles: FileProfile[], maxDepth: number, deep: boolean): SemanticSlice[] {
  if (!deep || maxDepth <= 1) {
    const runtimeFiles = profiles.filter(profile => isRuntimeRole(profile.role)).map(profile => profile.file);
    const files = runtimeFiles.length > 0 ? runtimeFiles : profiles.map(profile => profile.file);
    return [{
      key: 'root',
      label: 'Core',
      domain: null,
      role: 'runtime',
      files: uniqueFiles(files),
      weight: files.length,
    }];
  }

  const runtimeProfiles = profiles.filter(profile => isRuntimeRole(profile.role));
  const source = runtimeProfiles.length > 0 ? runtimeProfiles : profiles;

  const slices = new Map<string, SemanticSlice>();
  for (const profile of source) {
    const label = semanticLabelForProfile(kind, profile);
    const key = mergeKey(label, profile.role, kind);
    const existing = slices.get(key);
    if (existing) {
      existing.files.push(profile.file);
      existing.weight += profile.runtimeWeight;
      continue;
    }
    slices.set(key, {
      key,
      label,
      domain: profile.domain,
      role: profile.role,
      files: [profile.file],
      weight: profile.runtimeWeight,
    });
  }

  const byDomain = new Map<string, SemanticSlice[]>();
  for (const slice of slices.values()) {
    const domainKey = slice.domain ?? slice.label;
    const bucket = byDomain.get(domainKey) ?? [];
    bucket.push(slice);
    byDomain.set(domainKey, bucket);
  }

  if (kind === 'frontend') {
    for (const [domainKey, domainSlices] of byDomain.entries()) {
      const totalFiles = domainSlices.reduce((sum, slice) => sum + slice.files.length, 0);
      if (domainSlices.length < 2 || totalFiles > 4) continue;
      const mergedLabel = domainKey === 'Platform' ? domainKey : domainSlices[0]!.domain ?? domainKey;
      const mergedFiles = domainSlices.flatMap(slice => slice.files);
      const mergedWeight = domainSlices.reduce((sum, slice) => sum + slice.weight, 0);
      for (const slice of domainSlices) slices.delete(slice.key);
      slices.set(`merged:${domainKey}`, {
        key: `merged:${domainKey}`,
        label: mergedLabel,
        domain: domainSlices[0]!.domain,
        role: 'runtime',
        files: mergedFiles,
        weight: mergedWeight,
      });
    }
  }

  const ordered = Array.from(slices.values())
    .filter(slice => slice.files.length > 0)
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

  const maxSlices = Math.max(1, maxDepth * 3);
  if (ordered.length <= maxSlices) return ordered;

  const keep = ordered.slice(0, maxSlices - 1);
  const merged = ordered.slice(maxSlices - 1);
  keep.push({
    key: 'merged:overflow',
    label: kind === 'backend' ? 'Core' : 'Platform',
    domain: null,
    role: 'runtime',
    files: uniqueFiles(merged.flatMap(slice => slice.files)),
    weight: merged.reduce((sum, slice) => sum + slice.weight, 0),
  });
  return keep;
}

function componentNameForSlice(root: RootUnit, slice: SemanticSlice, sliceCount: number, usedNames: Set<string>): string {
  const label = toIdentifier(slice.label);
  const base = (sliceCount === 1 && (label === 'Core' || label === 'App' || label === 'Domain'))
    ? root.name
    : (label === root.name ? root.name : `${root.name}${label}`);
  return dedupeName(base, usedNames);
}

function buildComponentsForRoot(
  projectRoot: string,
  root: RootUnit,
  usedNames: Set<string>,
  deep: boolean,
  maxDepth: number,
  singleFile: boolean,
): { components: ComponentDesc[]; group?: SourceGroup } {
  const profiles = profileFiles(root);
  const kind = detectRootKind(root, profiles);
  const slices = buildSemanticSlices(kind, profiles, maxDepth, deep);
  if (slices.length === 0) {
    return {
      components: [{
        name: root.name,
        dir: root.dir,
        pathGlob: relativeGlob(projectRoot, root.dir, root.lang),
        computeNodeName: root.computeNodeName,
        computeNodeType: root.computeNodeType,
        files: root.files,
      }],
    };
  }

  const components: ComponentDesc[] = slices.map(slice => {
    const dir = commonDirectory(slice.files) ?? root.dir;
    return {
      name: componentNameForSlice(root, slice, slices.length, usedNames),
      dir,
      pathGlob: relativeGlob(projectRoot, dir, root.lang),
      computeNodeName: root.computeNodeName,
      computeNodeType: root.computeNodeType,
      files: uniqueFiles(slice.files),
      semanticLabel: slice.label,
    } satisfies ComponentDesc;
  });

  if (singleFile || components.length < IMPORT_COMPONENT_THRESHOLD) {
    return { components };
  }

  const groupFile = `components/${basename(root.dir).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || root.name.toLowerCase()}.ag`;
  for (const component of components) component.group = groupFile;
  return {
    components,
    group: {
      name: root.name,
      filePath: groupFile,
      importPath: groupFile.replace(/\\/g, '/'),
      components,
    },
  };
}

function commonDirectory(files: string[]): string | null {
  if (files.length === 0) return null;
  const firstSegments = dirname(files[0]!).replace(/\\/g, '/').split('/').filter(Boolean);
  let sharedLength = firstSegments.length;
  for (const file of files.slice(1)) {
    const segments = dirname(file).replace(/\\/g, '/').split('/').filter(Boolean);
    sharedLength = Math.min(sharedLength, segments.length);
    let i = 0;
    while (i < sharedLength && firstSegments[i] === segments[i]) i++;
    sharedLength = i;
    if (sharedLength === 0) {
      return dirname(files[0]!);
    }
  }
  const prefix = firstSegments.slice(0, sharedLength).join(sep);
  return prefix || dirname(files[0]!);
}

function uniqueFiles(files: string[]): string[] {
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function renderComponentsSection(components: ComponentDesc[], contracts: Map<string, string>): string {
  const lines: string[] = [];
  lines.push('// ── Runtime components ──────────────────────────────────────');
  for (const comp of components) {
    lines.push(emitComponent(comp.name, comp.computeNodeName, comp.pathGlob, contracts.get(comp.name) ?? null));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function routeLooksUtility(route: RouteFact): boolean {
  return CONTRACT_UTILITY_ROUTE_RE.test(route.normalized);
}

function normalizeContractName(componentName: string): string {
  return componentName.endsWith('Api') ? componentName : `${componentName}Api`;
}

export async function generateSpec(
  projectRoot: string,
  opts: GenerateSpecOptions = {},
): Promise<GenerateResult> {
  const warnings: string[] = [];
  const projectName = opts.projectName ?? 'GeneratedSpec';
  const deep = opts.deep ?? true;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const singleFile = opts.singleFile ?? false;
  const rootFileName = opts.rootFileName ?? 'architecture.ag';

  const usedNames = new Set<string>();
  const usedComputeNodeNames = new Set<string>();

  let roots = manifestRoots(projectRoot, usedNames, usedComputeNodeNames);
  if (roots.length === 0) {
    warnings.push('No project manifests found (package.json, *.csproj, go.mod, …). Falling back to source-layout synthesis.');
    roots = fallbackRoots(projectRoot, projectName, usedNames, usedComputeNodeNames);
  }
  if (roots.length === 0) {
    warnings.push('No supported source files found. Add invariants manually.');
  }

  const sourceGroups: SourceGroup[] = [];
  const components: ComponentDesc[] = [];
  for (const root of roots) {
    const result = buildComponentsForRoot(projectRoot, root, usedNames, deep, maxDepth, singleFile);
    components.push(...result.components);
    if (!singleFile && result.group) sourceGroups.push(result.group);
  }

  const mappings: Record<string, string> = {};
  for (const component of components) mappings[component.name] = component.pathGlob;

  const allInfraNodes = new Map<string, string>();
  const allResources = new Map<string, string>();
  const allComputeNodes = new Map<string, string>();
  const contracts = new Map<string, string>();
  const contractBlocks: string[] = [];

  for (const comp of components) {
    allComputeNodes.set(comp.computeNodeName, comp.computeNodeType);

    const facts = await extractFlows(comp.name, comp.files, mappings);
    for (const fact of facts) {
      const nodeType = inferNodeType(fact.to);
      if (nodeType && !allInfraNodes.has(fact.to)) allInfraNodes.set(fact.to, nodeType);

      const resourceType = inferResourceType(fact.to);
      const resourceName = toIdentifier(fact.to);
      if (resourceType && !allResources.has(resourceName)) allResources.set(resourceName, resourceType);
    }

    const routes = await extractServerRoutes(comp.files);
    if (routes.length === 0) continue;
    const runtimeRoutes = routes.filter(route => !route.file.toLowerCase().includes(`${sep}test`) && !route.file.toLowerCase().includes(`${sep}spec`));
    const publicRoutes = runtimeRoutes.filter(route => !routeLooksUtility(route));
    const chosenRoutes = publicRoutes.length > 0 ? publicRoutes : runtimeRoutes;
    if (chosenRoutes.length === 0) continue;

    const contractName = normalizeContractName(comp.name);
    const block = emitContract(contractName, chosenRoutes, warnings);
    if (block) {
      contracts.set(comp.name, contractName);
      contractBlocks.push(block);
    }
  }

  const workflowInfo = detectWorkflowTargets(projectRoot);
  const imports = sourceGroups.length > 0 ? sourceGroups.map(group => `import "${group.importPath}"`) : [];
  const lines: string[] = [];

  if (imports.length > 0) lines.push(...imports, '');

  lines.push(
    '// Generated by aglc generate — review and customize',
    `// Project: ${projectName}`,
    `// Runtime components: ${components.length} | Infrastructure nodes: ${allInfraNodes.size} | Resources: ${allResources.size} | Contracts: ${contractBlocks.length}`,
    '// Generated from semantic runtime synthesis. Refine intent in plan mode before adding invariants.',
    '',
  );

  lines.push('// ── Runtime nodes ────────────────────────────────────────────');
  for (const [nodeName, nodeType] of allComputeNodes) {
    lines.push(emitNode(nodeName, nodeType, 'trusted'));
  }
  if (workflowInfo.workflows.length > 0) lines.push(emitNode('github_actions', 'ci_runner', 'trusted'));
  lines.push('');

  if (allInfraNodes.size > 0) {
    lines.push('// ── Infrastructure nodes (detected from code analysis) ───────');
    for (const [nodeName, nodeType] of allInfraNodes) {
      lines.push(emitNode(nodeName, nodeType, 'trusted'));
    }
    lines.push('');
  }

  if (workflowInfo.targets.size > 0) {
    lines.push('// ── CI/CD targets (detected from GitHub Actions) ─────────────');
    for (const [nodeName, nodeType] of workflowInfo.targets) {
      const auth = nodeType === 'static_host' || nodeType === 'release_host' ? 'oauth2' : 'api_key';
      lines.push(`node ${nodeName} : ${nodeType} { trust: trusted auth: ${auth} }`);
    }
    lines.push('');
  }

  if (allResources.size > 0) {
    lines.push('// ── Resources (detected platform capabilities) ───────────────');
    for (const [resourceName, resourceType] of allResources) {
      const trust = resourceType === 'external_api' ? 'untrusted' : 'trusted';
      lines.push(emitResource(resourceName, resourceType, trust));
    }
    lines.push('');
  }

  if (contractBlocks.length > 0) {
    lines.push('// ── Public contracts (runtime-facing endpoints) ──────────────');
    for (const block of contractBlocks) lines.push(block, '');
  }

  if (singleFile || sourceGroups.length === 0) {
    lines.push(renderComponentsSection(components, contracts), '');
  }

  if (workflowInfo.workflows.length > 0) {
    lines.push('// ── GitHub Actions workflows ────────────────────────────────');
    for (const wf of workflowInfo.workflows) {
      lines.push(emitComponent(wf.name, 'github_actions', wf.pathGlob, null));
      lines.push('');
    }
  }

  lines.push('// ── Invariants ────────────────────────────────────────────────');
  lines.push('// Use plan mode to review this reference architecture before adding enforceable rules.');
  lines.push('// invariant MyRule {');
  lines.push('//   deny flow ComponentA -> ComponentB');
  lines.push('// }');

  if (workflowInfo.workflows.length > 0 && workflowInfo.targets.size > 0) {
    lines.push('');
    lines.push('// ── Workflow policies ───────────────────────────────────────');
    lines.push('// Review branch/tag names before enabling these examples.');
    lines.push('// workflow_policy ReleaseSafety {');
    for (const wf of workflowInfo.workflows) {
      const lower = wf.source.toLowerCase();
      if (workflowInfo.targets.has('npm_registry') && /\bnpm\s+publish\b|npm-publish/.test(lower)) {
        lines.push(`//   allow publish ${wf.name} -> npm_registry when tag "v*.*.*"`);
        lines.push(`//   require before ${wf.name} "npm test" -> "npm publish"`);
      }
      if (workflowInfo.targets.has('github_pages') && /peaceiris\/actions-gh-pages|actions\/deploy-pages|github-pages/.test(lower)) {
        lines.push(`//   allow deploy ${wf.name} -> github_pages when branch "master"`);
      }
    }
    if (workflowInfo.targets.has('npm_registry')) lines.push('//   deny publish * -> npm_registry when pull_request');
    if (workflowInfo.targets.has('github_pages')) lines.push('//   deny deploy * -> github_pages when pull_request');
    lines.push('//   deny permission * contents: write when pull_request');
    lines.push('// }');
  }

  const rootContent = lines.join('\n');
  const files: GeneratedSpecFile[] = [{ path: rootFileName, content: rootContent }];

  if (!singleFile) {
    for (const group of sourceGroups) {
      const groupContent = [
        `// Generated semantic component slice for ${group.name}`,
        `// Imported by ${basename(rootFileName)}`,
        '',
        renderComponentsSection(group.components, contracts),
      ].join('\n');
      files.push({ path: group.filePath, content: groupContent });
    }
  }

  return {
    ag: rootContent,
    files,
    components: components.length,
    infrastructureNodes: allInfraNodes.size,
    contracts: contractBlocks.length,
    warnings,
  };
}
