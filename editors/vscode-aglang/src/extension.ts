import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // ── Language Server ──────────────────────────────────────────────────────────
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'aglang' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ag'),
    },
  };

  client = new LanguageClient('aglang', 'aglang Language Server', serverOptions, clientOptions);
  client.start();

  // ── Commands ─────────────────────────────────────────────────────────────────
  const output = vscode.window.createOutputChannel('aglang');

  context.subscriptions.push(
    vscode.commands.registerCommand('aglang.compile', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) { vscode.window.showErrorMessage('aglang: No workspace folder open.'); return; }

      const specPath = await findSpecFile(ws);
      if (!specPath) { vscode.window.showErrorMessage('aglang: No .ag file found in workspace.'); return; }

      const aglc = getAglcPath();
      output.show(true);
      output.appendLine(`\n▶ aglc compile ${specPath}`);

      const terminal = vscode.window.createTerminal({ name: 'aglang compile', cwd: ws });
      terminal.sendText(`${aglc} compile "${specPath}"`);
      terminal.show();
    }),

    vscode.commands.registerCommand('aglang.check', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'aglang') {
        vscode.window.showWarningMessage('aglang: Open an .ag file first.');
        return;
      }
      await editor.document.save();
      const aglc = getAglcPath();
      const terminal = vscode.window.createTerminal({ name: 'aglang check' });
      terminal.sendText(`${aglc} compile "${editor.document.uri.fsPath}"`);
      terminal.show();
    }),

    vscode.commands.registerCommand('aglang.generate', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) { vscode.window.showErrorMessage('aglang: No workspace folder open.'); return; }
      const name = await vscode.window.showInputBox({ prompt: 'Project name for generated spec', value: path.basename(ws) });
      if (!name) return;
      const aglc = getAglcPath();
      const terminal = vscode.window.createTerminal({ name: 'aglang generate', cwd: ws });
      terminal.sendText(`${aglc} add . --name "${name}"`);
      terminal.show();
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

function getAglcPath(): string {
  return vscode.workspace.getConfiguration('aglang').get<string>('executablePath') ?? 'aglc';
}

async function findSpecFile(ws: string): Promise<string | undefined> {
  const uris = await vscode.workspace.findFiles('**/*.ag', '**/node_modules/**', 1);
  return uris[0]?.fsPath;
}
