import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';

export interface UiScope {
  all: boolean;
  diff?: string;
  file?: string;
}

export interface UiServerOptions {
  archPath: string;
  projectRoot: string;
  scope: UiScope;
  port?: number;
  open: boolean;
  cliPath: string;
  initialRunId?: string;
}

interface UiConfig {
  schema_version: 1;
  arch: string;
  project_root: string;
  repos: Array<{ name: string; url?: string; local_path?: string; missing: boolean }>;
  last_scope: UiScope;
  last_port?: number;
}

const UI_ROOT = join('.aglang', 'ui');

export function createUiRunId(prefix = 'run'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safeRelativePath(root: string, requested: string): string | undefined {
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return abs;
}

function uiDir(projectRoot: string): string {
  return resolve(projectRoot, UI_ROOT);
}

function runsDir(projectRoot: string): string {
  return join(uiDir(projectRoot), 'runs');
}

function runDir(projectRoot: string, runId: string): string {
  return join(runsDir(projectRoot), runId);
}

function configPath(projectRoot: string): string {
  return join(uiDir(projectRoot), 'config.json');
}

function loadUiConfig(artifact: ArchitectureArtifact, options: UiServerOptions): UiConfig {
  const absProject = resolve(options.projectRoot);
  const path = configPath(absProject);
  let configuredPaths: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      const existing = readJsonFile(path) as { repo_paths?: Record<string, string>; repos?: Array<{ name: string; local_path?: string }> };
      configuredPaths = {
        ...(existing.repo_paths ?? {}),
        ...Object.fromEntries((existing.repos ?? []).map(repo => [repo.name, repo.local_path]).filter(([, value]) => Boolean(value))),
      } as Record<string, string>;
    } catch {
      configuredPaths = {};
    }
  }

  return {
    schema_version: 1,
    arch: resolve(options.archPath),
    project_root: absProject,
    repos: (artifact.repos ?? []).map(repo => {
      const localPath = configuredPaths[repo.name];
      return {
        name: repo.name,
        url: repo.url,
        local_path: localPath,
        missing: Boolean(localPath) && !existsSync(resolve(absProject, localPath)),
      };
    }),
    last_scope: options.scope,
    last_port: options.port,
  };
}

function writeUiConfig(artifact: ArchitectureArtifact, options: UiServerOptions): UiConfig {
  const config = loadUiConfig(artifact, options);
  mkdirSync(dirname(configPath(options.projectRoot)), { recursive: true });
  writeFileSync(configPath(options.projectRoot), JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

function listRuns(projectRoot: string): unknown[] {
  const dir = runsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const id = entry.name;
      const debugPath = join(dir, id, 'debug.json');
      if (!existsSync(debugPath)) return { id };
      try {
        const debug = readJsonFile(debugPath) as Record<string, unknown>;
        const verdict = debug.verdict as Record<string, unknown> | undefined;
        return {
          id,
          generated_at: debug.generated_at,
          scope: debug.scope,
          passed: verdict?.passed,
          violations: Array.isArray(verdict?.violations) ? verdict.violations.length : 0,
          change_violations: Array.isArray(verdict?.change_violations) ? verdict.change_violations.length : 0,
        };
      } catch {
        return { id, unreadable: true };
      }
    })
    .sort((a, b) => String((b as { id: string }).id).localeCompare(String((a as { id: string }).id)));
}

function loadRun(projectRoot: string, id: string): Record<string, unknown> | undefined {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) return undefined;
  const dir = runDir(projectRoot, id);
  if (!existsSync(dir)) return undefined;
  const load = (name: string) => {
    const path = join(dir, name);
    return existsSync(path) ? readJsonFile(path) : undefined;
  };
  return {
    id,
    debug: load('debug.json'),
    graph: load('graph.json'),
    query_traces: load('query-traces.json'),
    verdict: load('verdict.json'),
    rules: load('rules.json'),
    ui: load('ui-index.json'),
  };
}

function normalizeScope(scope: Partial<UiScope> | undefined, fallback: UiScope): UiScope {
  return {
    all: Boolean(scope?.all ?? fallback.all),
    diff: scope?.diff ?? fallback.diff,
    file: scope?.file ?? fallback.file,
  };
}

function runDebugBundle(options: UiServerOptions, scope: UiScope, runId = createUiRunId()): Promise<string> {
  const outDir = runDir(options.projectRoot, runId);
  mkdirSync(outDir, { recursive: true });
  const childArgs = [
    options.cliPath,
    'debug',
    '--arch',
    options.archPath,
    '--project',
    options.projectRoot,
    '--out',
    outDir,
    '--debug-extractors',
  ];
  if (scope.file) childArgs.push('--file', scope.file);
  else if (scope.diff) childArgs.push('--diff', scope.diff);
  else if (scope.all) childArgs.push('--all');

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: options.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGLANG_UI_CHILD: '1' },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        writeUiIndex(options.projectRoot, runId);
        resolvePromise(runId);
      } else {
        reject(new Error(stderr.trim() || `aglc debug failed with exit code ${code}`));
      }
    });
  });
}

function writeUiIndex(projectRoot: string, runId: string): void {
  const loaded = loadRun(projectRoot, runId);
  const graph = loaded?.graph as { facts?: unknown[]; projections?: { flow?: unknown[] } } | undefined;
  const verdict = loaded?.verdict as Record<string, unknown> | undefined;
  const debug = loaded?.debug as Record<string, unknown> | undefined;
  const violations = [
    ...((verdict?.violations as unknown[] | undefined) ?? []),
    ...((verdict?.contract_violations as unknown[] | undefined) ?? []),
    ...((verdict?.workflow_violations as unknown[] | undefined) ?? []),
    ...((verdict?.change_violations as unknown[] | undefined) ?? []),
  ];
  const index = {
    schema_version: 1,
    run_id: runId,
    generated_at: debug?.generated_at,
    counts: {
      graph_facts: graph?.facts?.length ?? 0,
      flow_projections: graph?.projections?.flow?.length ?? 0,
      violations: violations.length,
    },
    violations,
  };
  writeFileSync(join(runDir(projectRoot, runId), 'ui-index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function isInteractiveLocalTerminal(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY && !process.env.CI && process.env.TERM !== 'dumb');
}

function html(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>aglc UI Workbench</title>
  <style>
    :root { color-scheme: light; --bg: #f7f7f4; --panel: #ffffff; --ink: #202124; --muted: #667085; --line: #d7d9cf; --accent: #0f766e; --warn: #b45309; --bad: #b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    button, input, select { font: inherit; }
    .app { display: grid; grid-template-columns: 280px minmax(420px, 1fr) 360px; grid-template-rows: 1fr 280px; height: 100vh; }
    aside, main, section { min-width: 0; min-height: 0; }
    .sidebar { border-right: 1px solid var(--line); background: #fbfbf8; padding: 16px; overflow: auto; }
    .graph { position: relative; overflow: hidden; background: radial-gradient(circle at 1px 1px, #d9ddd3 1px, transparent 0); background-size: 24px 24px; }
    .inspector { border-left: 1px solid var(--line); background: var(--panel); padding: 16px; overflow: auto; }
    .bottom { grid-column: 1 / 4; border-top: 1px solid var(--line); background: var(--panel); display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; overflow: hidden; }
    .pane { padding: 14px; overflow: auto; background: var(--panel); }
    h1 { font-size: 18px; margin: 0 0 14px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 20px 0 8px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .stack { display: grid; gap: 8px; }
    .card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 10px; }
    .run { width: 100%; text-align: left; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: white; cursor: pointer; }
    .run[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(15, 118, 110, .14); }
    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .btn { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: white; cursor: pointer; }
    .btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: white; }
    .node { position: absolute; width: 190px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.96); padding: 10px; box-shadow: 0 8px 24px rgba(16,24,40,.08); cursor: pointer; }
    .node.selected { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15,118,110,.16), 0 8px 24px rgba(16,24,40,.08); }
    .node.fact { border-left: 4px solid #2563eb; }
    .node.violation { border-left: 4px solid var(--bad); }
    svg.edges { position: absolute; inset: 0; pointer-events: none; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.45; }
    code { font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace; }
    .pill { display: inline-flex; border-radius: 999px; padding: 2px 8px; background: #eef2f1; color: #344054; font-size: 12px; }
    .empty { color: var(--muted); padding: 28px; text-align: center; }
    @media (max-width: 980px) { .app { grid-template-columns: 1fr; grid-template-rows: auto 420px auto 320px; } .bottom { grid-column: 1; grid-template-columns: 1fr; } .inspector { border-left: 0; border-top: 1px solid var(--line); } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <h1>aglc UI Workbench</h1>
      <div class="stack">
        <button class="btn primary" id="newRun">Run</button>
        <select id="scope"><option value="all">All files</option><option value="diff">Diff</option><option value="file">File</option></select>
        <input id="scopeValue" placeholder="ref or file path">
      </div>
      <h2>Runs</h2>
      <div id="runs" class="stack"></div>
      <h2>Repositories</h2>
      <div id="repos" class="stack"></div>
    </aside>
    <main class="graph" id="graph"><svg class="edges" id="edges"></svg></main>
    <section class="inspector"><h2>Inspector</h2><div id="inspector" class="stack"></div></section>
    <section class="bottom">
      <div class="pane"><h2>Code Slice</h2><pre id="code"></pre></div>
      <div class="pane"><h2>Query / AST Trace</h2><pre id="trace"></pre></div>
      <div class="pane"><h2>SMT / Proof</h2><pre id="smt"></pre></div>
    </section>
  </div>
  <script>
    const state = { runs: [], run: null, selected: null, config: null };
    const $ = id => document.getElementById(id);
    async function api(path, options) {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    function escapeHtml(text) {
      return String(text ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    function firstArray(...values) { return values.find(Array.isArray) || []; }
    function activeFacts() { return firstArray(state.run?.graph?.facts, state.run?.debug?.graph?.facts); }
    function activeViolations() {
      const verdict = state.run?.verdict || state.run?.debug?.verdict || {};
      return ['violations','contract_violations','workflow_violations','change_violations'].flatMap(key => Array.isArray(verdict[key]) ? verdict[key] : []);
    }
    function renderRuns() {
      $('runs').innerHTML = state.runs.length ? state.runs.map(run => '<button class="run" aria-current="'+(state.run?.id===run.id)+'" data-run="'+run.id+'"><strong>'+escapeHtml(run.id)+'</strong><div class="small muted">'+escapeHtml(run.scope || '')+'</div><span class="pill">'+(run.passed ? 'passed' : 'review')+'</span> <span class="pill">'+(run.violations || 0)+' violations</span></button>').join('') : '<div class="empty">No runs yet</div>';
      document.querySelectorAll('[data-run]').forEach(btn => btn.onclick = () => loadRun(btn.dataset.run));
    }
    function layoutNodes() {
      const facts = activeFacts().slice(0, 36).map((fact, i) => ({ id: fact.id || 'fact-'+i, type: 'fact', title: fact.kind || 'graph fact', subtitle: fact.subject || fact.from || '', raw: fact }));
      const violations = activeViolations().slice(0, 18).map((v, i) => ({ id: v.id || 'violation-'+i, type: 'violation', title: v.type || v.kind || 'violation', subtitle: v.rule || v.policy || '', raw: v }));
      return [...violations, ...facts].map((node, i) => ({ ...node, x: 40 + (i % 4) * 230, y: 40 + Math.floor(i / 4) * 120 }));
    }
    function renderGraph() {
      const graph = $('graph');
      graph.querySelectorAll('.node').forEach(n => n.remove());
      const nodes = layoutNodes();
      $('edges').innerHTML = '';
      if (!nodes.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No graph facts or violations in this run';
        graph.appendChild(empty);
        return;
      }
      nodes.forEach(node => {
        const el = document.createElement('button');
        el.className = 'node '+node.type+(state.selected?.id === node.id ? ' selected' : '');
        el.style.left = node.x+'px';
        el.style.top = node.y+'px';
        el.innerHTML = '<strong>'+escapeHtml(node.title)+'</strong><div class="small muted">'+escapeHtml(node.subtitle)+'</div><div class="small"><code>'+escapeHtml(node.id)+'</code></div>';
        el.onclick = () => { state.selected = node; renderAll(); };
        graph.appendChild(el);
      });
    }
    async function loadCodeForSelection(raw) {
      const file = raw?.file || raw?.detected?.file || raw?.evidence?.file;
      const line = raw?.line || raw?.detected?.line || raw?.evidence?.line;
      if (!file) return '';
      try {
        const result = await api('/api/files?path='+encodeURIComponent(file)+'&line='+encodeURIComponent(line || 1));
        return result.content;
      } catch (error) {
        return String(error.message || error);
      }
    }
    async function renderInspector() {
      const selected = state.selected;
      $('inspector').innerHTML = selected ? '<div class="card"><strong>'+escapeHtml(selected.title)+'</strong><div class="small muted">'+escapeHtml(selected.id)+'</div></div><pre class="card">'+escapeHtml(JSON.stringify(selected.raw, null, 2))+'</pre>' : '<div class="empty">Select a node or violation</div>';
      $('trace').textContent = selected ? JSON.stringify(selected.raw?.query || selected.raw?.ast || selected.raw?.evidence?.ast || selected.raw?.graphEvidence || {}, null, 2) : '';
      $('smt').textContent = selected ? JSON.stringify(selected.raw?.proof || selected.raw?.smt || selected.raw?.solver || {}, null, 2) : '';
      $('code').textContent = selected ? await loadCodeForSelection(selected.raw) : '';
    }
    function renderRepos() {
      const repos = state.config?.repos || [];
      $('repos').innerHTML = repos.length ? repos.map(repo => '<div class="card"><strong>'+escapeHtml(repo.name)+'</strong><div class="small muted">'+escapeHtml(repo.local_path || repo.url || 'no local path configured')+'</div>'+(repo.missing ? '<span class="pill">missing local path</span>' : '')+'</div>').join('') : '<div class="empty">No declared repos</div>';
    }
    async function renderAll() { renderRuns(); renderRepos(); renderGraph(); await renderInspector(); }
    async function refresh() {
      state.config = await api('/api/config');
      state.runs = await api('/api/runs');
      if (!state.run && state.runs[0]) await loadRun(state.runs[0].id, false);
      await renderAll();
    }
    async function loadRun(id, rerender = true) {
      state.run = await api('/api/runs/'+encodeURIComponent(id));
      state.selected = null;
      if (rerender) await renderAll();
    }
    $('newRun').onclick = async () => {
      const mode = $('scope').value;
      const value = $('scopeValue').value.trim();
      const scope = mode === 'file' ? { file: value } : mode === 'diff' ? { diff: value } : { all: true };
      const created = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope }) });
      await refresh();
      await loadRun(created.id);
    };
    refresh().catch(error => { document.body.innerHTML = '<pre>'+escapeHtml(error.stack || error.message || error)+'</pre>'; });
  </script>
</body>
</html>`;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function startUiServer(artifact: ArchitectureArtifact, options: UiServerOptions): Promise<{ url: string; port: number }> {
  const absProject = resolve(options.projectRoot);
  mkdirSync(runsDir(absProject), { recursive: true });
  const config = writeUiConfig(artifact, { ...options, projectRoot: absProject });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        sendText(res, 200, html(), 'text/html; charset=utf-8');
      } else if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, config);
      } else if (req.method === 'GET' && url.pathname === '/api/runs') {
        sendJson(res, 200, listRuns(absProject));
      } else if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length));
        const run = loadRun(absProject, id);
        run ? sendJson(res, 200, run) : sendJson(res, 404, { error: 'run not found' });
      } else if (req.method === 'POST' && url.pathname === '/api/runs') {
        const raw = await readRequestBody(req);
        const body = raw ? JSON.parse(raw) as { scope?: Partial<UiScope> } : {};
        const scope = normalizeScope(body.scope, options.scope);
        const id = await runDebugBundle({ ...options, projectRoot: absProject }, scope);
        sendJson(res, 201, { id });
      } else if (req.method === 'GET' && url.pathname === '/api/files') {
        const requested = url.searchParams.get('path');
        if (!requested) {
          sendJson(res, 400, { error: 'path is required' });
          return;
        }
        const filePath = safeRelativePath(absProject, requested);
        if (!filePath || !existsSync(filePath)) {
          sendJson(res, 404, { error: 'file not found' });
          return;
        }
        const line = Number.parseInt(url.searchParams.get('line') ?? '1', 10);
        const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
        const start = Math.max(1, Number.isFinite(line) ? line - 8 : 1);
        const end = Math.min(lines.length, start + 20);
        const content = lines.slice(start - 1, end).map((text, index) => `${start + index}: ${text}`).join('\n');
        sendJson(res, 200, { path: filePath, language: extname(filePath).slice(1), start, end, content });
      } else {
        sendJson(res, 404, { error: 'not found' });
      }
    } catch (error) {
      sendJson(res, 500, { error: (error as Error).message });
    }
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/`;

  if (options.initialRunId) {
    writeUiIndex(absProject, options.initialRunId);
  } else if (listRuns(absProject).length === 0) {
    await runDebugBundle({ ...options, projectRoot: absProject }, options.scope);
  }

  if (options.open && isInteractiveLocalTerminal()) {
    openBrowser(url);
  }
  return { url, port: actualPort };
}

export function currentCliPath(importMetaUrl: string): string {
  return fileURLToPath(importMetaUrl);
}
