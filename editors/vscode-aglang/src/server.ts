/**
 * aglang Language Server
 *
 * Provides real-time diagnostics for .ag files by wrapping the aglang
 * lexer and parser. Runs as a separate Node.js process; communicates
 * with the VS Code extension host via IPC using the Language Server Protocol.
 */
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  HoverParams,
  Hover,
  MarkupKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

// Bundle the aglang lexer and parser directly into this server.
// The esbuild step resolves these relative paths from the monorepo root.
import { tokenize } from '../../../src/lexer.ts';
import { parse, ParseError } from '../../../src/parser.ts';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false },
      hoverProvider: true,
    },
  };
});

// ── Validation ────────────────────────────────────────────────────────────────

documents.onDidChangeContent(change => validate(change.document));
documents.onDidOpen(change => validate(change.document));

function validate(doc: TextDocument): void {
  const diagnostics: Diagnostic[] = [];
  const text = doc.getText();

  try {
    const tokens = tokenize(text);
    parse(tokens);
  } catch (err) {
    if (err instanceof ParseError) {
      const token = err.token;
      const line = Math.max(0, (token?.line ?? 1) - 1);
      const col = Math.max(0, (token?.col ?? 1) - 1);
      const endCol = col + (token?.value?.length ?? 1);

      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line, character: col },
          end: { line, character: endCol },
        },
        message: err.message.replace(/^Parse error at \d+:\d+ — /, ''),
        source: 'aglang',
      });
    } else if (err instanceof Error && err.message.startsWith("Unexpected character")) {
      // Lexer error — try to extract position from message
      const match = err.message.match(/at line (\d+):(\d+)/);
      const line = match ? parseInt(match[1]!, 10) - 1 : 0;
      const col = match ? parseInt(match[2]!, 10) - 1 : 0;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: { start: { line, character: col }, end: { line, character: col + 1 } },
        message: err.message,
        source: 'aglang',
      });
    } else if (err instanceof Error) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        message: err.message,
        source: 'aglang',
      });
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// ── Completion ────────────────────────────────────────────────────────────────

const KEYWORDS: CompletionItem[] = [
  { label: 'component', kind: CompletionItemKind.Keyword, detail: 'Declare an architecture component' },
  { label: 'node', kind: CompletionItemKind.Keyword, detail: 'Declare an infrastructure node' },
  { label: 'invariant', kind: CompletionItemKind.Keyword, detail: 'Define an architectural invariant' },
  { label: 'contract', kind: CompletionItemKind.Keyword, detail: 'Define an API contract' },
  { label: 'machine', kind: CompletionItemKind.Keyword, detail: 'Define a state machine' },
  { label: 'permission', kind: CompletionItemKind.Keyword, detail: 'Define permission rules' },
  { label: 'plugin', kind: CompletionItemKind.Keyword, detail: 'Declare an external extractor plugin' },
  { label: 'service', kind: CompletionItemKind.Keyword, detail: 'Declare a service node' },
  { label: 'flow', kind: CompletionItemKind.Keyword, detail: 'Declare an allowed or denied flow' },
  { label: 'deny', kind: CompletionItemKind.Keyword, detail: 'Deny a flow in an invariant' },
  { label: 'allow', kind: CompletionItemKind.Keyword, detail: 'Allow an action in a permission block' },
  { label: 'require', kind: CompletionItemKind.Keyword, detail: 'Require a property on a flow' },
  { label: 'encryption', kind: CompletionItemKind.Keyword, detail: 'Encryption requirement' },
  { label: 'transition', kind: CompletionItemKind.Keyword, detail: 'State machine transition' },
  { label: 'when', kind: CompletionItemKind.Keyword, detail: 'Condition clause' },
  { label: 'on', kind: CompletionItemKind.Keyword, detail: 'Used with require … on flow' },
  { label: 'GET', kind: CompletionItemKind.EnumMember, detail: 'HTTP GET method (contract block)' },
  { label: 'POST', kind: CompletionItemKind.EnumMember, detail: 'HTTP POST method (contract block)' },
  { label: 'PUT', kind: CompletionItemKind.EnumMember, detail: 'HTTP PUT method (contract block)' },
  { label: 'PATCH', kind: CompletionItemKind.EnumMember, detail: 'HTTP PATCH method (contract block)' },
  { label: 'DELETE', kind: CompletionItemKind.EnumMember, detail: 'HTTP DELETE method (contract block)' },
  { label: 'directory', kind: CompletionItemKind.Property, detail: 'Component directory glob' },
  { label: 'protocol', kind: CompletionItemKind.Property, detail: 'Service protocol' },
  { label: 'latency', kind: CompletionItemKind.Property, detail: 'Service latency budget (e.g. 200ms)' },
  { label: 'rate_limit', kind: CompletionItemKind.Property, detail: 'Service rate limit (e.g. 1000rps)' },
];

connection.onCompletion((_params: TextDocumentPositionParams): CompletionItem[] => {
  return KEYWORDS;
});

// ── Hover docs ────────────────────────────────────────────────────────────────

const HOVER_DOCS: Record<string, string> = {
  component: '**component** _Name_ `{` … `}`\n\nDeclares an architecture component with a directory mapping. Files under that directory are tagged as belonging to this component at commit time.',
  invariant: '**invariant** _Name_ `{` … `}`\n\nDefines an architectural rule. Violations are detected by Z3 at git-commit time.\n\n```ag\ninvariant NoDirectDB {\n  deny flow PublicAPI -> Database;\n}\n```',
  contract: '**contract** _Name_ `{` … `}`\n\nDefines the HTTP API surface exposed by a component. The `aglc check` command verifies the implementation matches the contract.\n\n```ag\ncontract UserService {\n  GET  /users\n  POST /users\n}\n```',
  flow: '**flow** _A_ `->` _B_\n\nDeclares an explicit data flow between two components or nodes.',
  deny: '**deny flow** _A_ `->` _B_\n\nProhibits a direct flow inside an invariant block.',
  require: '**require encryption on flow** _A_ `->` _B_\n\nMandates that all traffic on this flow must be encrypted.',
  machine: '**machine** _Name_ `{` … `}`\n\nDefines a finite state machine with typed transitions.',
  permission: '**permission** _Role_ `{` … `}`\n\nDefines access-control rules for a role.',
  plugin: '**plugin** `"package-name"`\n\nRegisters an npm package as an external extractor plugin.',
  node: '**node** _Name_`(`_type_`)` `{` … `}`\n\nDeclares an infrastructure node (database, cache, queue, etc.).',
  service: '**service** _Name_ `{` … `}`\n\nDeclares a service with latency, protocol, and rate-limit properties.',
};

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const pos = params.position;
  const line = doc.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line, character: 200 } });
  const wordMatch = line.slice(0, pos.character + 1).match(/\b(\w+)$/);
  const word = wordMatch?.[1];
  if (!word || !HOVER_DOCS[word]) return null;

  return {
    contents: { kind: MarkupKind.Markdown, value: HOVER_DOCS[word]! },
  };
});

// ── Start ─────────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
