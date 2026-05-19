// Recursive-descent parser for aglang
import type { Token, TokenKind } from './lexer.ts';
import type {
  Program, Declaration, NodeDecl, NodeType, Prop,
  DataDecl, Field, EnumDecl, ComponentDecl, ServiceDecl,
  InvariantDecl, InvariantRule, TestDecl, AssertStmt,
  QueryChain, Selector, Quantifier,
  StateMachineDecl, TransitionRule, PermissionDecl, PermissionRule,
  ContractDecl, ContractEndpoint, PluginDecl, RepoDecl,
} from './ast.ts';

export class ParseError extends Error {
  constructor(msg: string, public token: Token) {
    super(`Parse error at ${token.line}:${token.col} — ${msg} (got '${token.value}')`);
  }
}

export function parse(tokens: Token[]): Program {
  let pos = 0;

  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];
  const eof = () => peek().kind === 'EOF';

  function expect(kind: TokenKind, value?: string): Token {
    const t = advance();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new ParseError(`expected ${kind}${value ? ` '${value}'` : ''}`, t);
    }
    return t;
  }

  function match(kind: TokenKind, value?: string): boolean {
    const t = peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  function consume(kind: TokenKind, value?: string): Token | null {
    if (match(kind, value)) return advance();
    return null;
  }

  // Parse a node type: IDENT or IDENT(IDENT)
  function parseNodeType(): NodeType {
    const name = expect('IDENT').value;
    if (consume('LPAREN')) {
      const param = expect('IDENT').value;
      expect('RPAREN');
      return { kind: 'parameterized', name, param };
    }
    return { kind: 'simple', name };
  }

  // Accept either IDENT or KEYWORD as an identifier (keywords are used as property names)
  function expectIdent(): Token {
    const t = advance();
    if (t.kind !== 'IDENT' && t.kind !== 'KEYWORD') {
      throw new ParseError('expected identifier', t);
    }
    return t;
  }

  function matchIdent(): boolean {
    return peek().kind === 'IDENT' || peek().kind === 'KEYWORD';
  }

  // Parse a property value: could be multi-word tokens on the same line
  // Simplified: collect until newline-equivalent (SEMICOLON, RBRACE, or COMMA)
  function parsePropValue(): string | string[] {
    const values: string[] = [];
    const isNextPropKey = () => {
      const t = tokens[pos];
      const next = tokens[pos + 1];
      return (t?.kind === 'IDENT' || t?.kind === 'KEYWORD') && next?.kind === 'COLON';
    };
    while (!match('RBRACE') && !match('SEMICOLON') && !match('EOF') && !isNextPropKey()) {
      const t = advance();
      if (t.kind === 'COMMA') {
        // Multi-value prop — collect subsequent items
        continue;
      }
      values.push(t.value);
    }
    if (values.length === 1) return values[0]!;
    return values;
  }

  // Parse key: value props inside { }
  function parseProps(): Prop[] {
    const props: Prop[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const key = expectIdent().value;
      expect('COLON');
      const value = parsePropValue();
      props.push({ key, value });
    }
    expect('RBRACE');
    return props;
  }

  // node NAME : node_type { props }
  function parseNodeDecl(): NodeDecl {
    expect('KEYWORD', 'node');
    const name = expect('IDENT').value;
    expect('COLON');
    const nodeType = parseNodeType();
    const props = parseProps();
    return { kind: 'NodeDecl', name, nodeType, props };
  }

  // enum Name { Val1 | Val2 | Val3 }
  function parseEnumDecl(): EnumDecl {
    expect('KEYWORD', 'enum');
    const name = expect('IDENT').value;
    const values: string[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      values.push(expect('IDENT').value);
      consume('PIPE'); // optional separator between values
    }
    expect('RBRACE');
    if (values.length === 0) throw new ParseError(`enum '${name}' has no values`, peek());
    return { kind: 'EnumDecl', name, values };
  }

  // data NAME { field: typeExpr }
  function parseDataDecl(): DataDecl {
    expect('KEYWORD', 'data');
    const name = expect('IDENT').value;
    const fields: Field[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const key = expect('IDENT').value;
      expect('COLON');
      // Type expression: collect until next key: or }
      let typeExpr = '';
      while (
        !match('RBRACE') && !eof() &&
        !(peek().kind === 'IDENT' && tokens[pos + 1]?.kind === 'COLON')
      ) {
        const t = advance();
        typeExpr += (typeExpr ? ' ' : '') + t.value;
      }
      fields.push({ key, typeExpr: typeExpr.trim().replace(/\s*<\s*/g, '<').replace(/\s*>\s*/g, '>').replace(/\s*,\s*/g, ', ').replace(/\s*\|\s*/g, ' | ') });
    }
    expect('RBRACE');
    return { kind: 'DataDecl', name, fields };
  }

  // component NAME { runs_on: X  paths: "glob"  repo: RepoName  implements: ContractA  consumes: ContractB }
  function parseComponentDecl(): ComponentDecl {
    expect('KEYWORD', 'component');
    const name = expect('IDENT').value;
    let runsOn = '';
    let paths = '';
    let repoRef: string | undefined;
    const implementsList: string[] = [];
    const consumesList: string[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const key = advance().value; // runs_on, paths, repo, implements, consumes, or unknown
      expect('COLON');
      if (key === 'runs_on') {
        runsOn = expect('IDENT').value;
      } else if (key === 'paths') {
        paths = expect('STRING').value;
      } else if (key === 'repo') {
        repoRef = expect('IDENT').value;
      } else if (key === 'implements') {
        implementsList.push(expect('IDENT').value);
        while (consume('COMMA')) {
          implementsList.push(expect('IDENT').value);
        }
      } else if (key === 'consumes') {
        consumesList.push(expect('IDENT').value);
        while (consume('COMMA')) {
          consumesList.push(expect('IDENT').value);
        }
      } else {
        // skip unknown props
        while (!match('RBRACE') && !eof() &&
          !((peek().kind === 'IDENT' || peek().kind === 'KEYWORD') && tokens[pos + 1]?.kind === 'COLON')) {
          advance();
        }
      }
    }
    expect('RBRACE');
    if (!runsOn) throw new Error(`component '${name}' missing runs_on`);
    if (!paths) throw new Error(`component '${name}' missing paths`);
    return {
      kind: 'ComponentDecl', name, runsOn, paths,
      ...(repoRef ? { repo: repoRef } : {}),
      ...(implementsList.length > 0 ? { implements: implementsList } : {}),
      ...(consumesList.length > 0 ? { consumes: consumesList } : {}),
    };
  }

  // service NAME { props }
  function parseServiceDecl(): ServiceDecl {
    expect('KEYWORD', 'service');
    const name = expect('IDENT').value;
    const props = parseProps();
    return { kind: 'ServiceDecl', name, props };
  }

  // invariant NAME { deny flow A -> B; | require encryption on flow A -> B; }
  function parseInvariantDecl(): InvariantDecl {
    expect('KEYWORD', 'invariant');
    const name = expect('IDENT').value;
    const rules: InvariantRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const action = advance().value; // 'deny' or 'require'
      if (action === 'deny') {
        expect('KEYWORD', 'flow');
        const from = expect('IDENT').value;
        expect('ARROW');
        const to = expect('IDENT').value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyFlow', from, to });
      } else if (action === 'require') {
        expect('KEYWORD', 'encryption');
        expect('KEYWORD', 'on');
        expect('KEYWORD', 'flow');
        const from = expect('IDENT').value;
        expect('ARROW');
        const to = expect('IDENT').value;
        consume('SEMICOLON');
        rules.push({ kind: 'RequireEncryption', from, to });
      }
    }
    expect('RBRACE');
    return { kind: 'InvariantDecl', name, rules };
  }

  // Query chain: no(data where classification == sensitive).flows_through(node where trust == untrusted).without(encryption)
  function parseSelector(): Selector {
    const subject = expect('IDENT').value;
    let where: Selector['where'] | undefined;
    if (consume('KEYWORD', 'where')) {
      const key = expect('IDENT').value;
      const op = advance().value; // == etc
      const value = advance().value;
      where = { key, op, value };
    }
    return { subject, where };
  }

  function parseQueryChain(): QueryChain {
    const quantToken = advance(); // no / every / some
    const quantifier = quantToken.value as Quantifier;
    expect('LPAREN');
    const selector = parseSelector();
    expect('RPAREN');
    const methods: QueryChain['methods'] = [];
    let without: string | undefined;
    while (consume('DOT')) {
      const mname = advance().value;
      if (mname === 'without') {
        expect('LPAREN');
        without = expect('IDENT').value;
        expect('RPAREN');
      } else {
        expect('LPAREN');
        const arg = parseQueryChain();
        expect('RPAREN');
        methods.push({ name: mname, arg });
      }
    }
    return { quantifier, selector, methods, without };
  }

  // machine NAME on DataType.field { allow|deny transition FROM -> TO; }
  function parseStateMachineDecl(): StateMachineDecl {
    expect('KEYWORD', 'machine');
    const name = expect('IDENT').value;
    expect('KEYWORD', 'on');
    const onType = expect('IDENT').value;
    expect('DOT');
    const onField = expect('IDENT').value;
    const transitions: TransitionRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const actionTok = advance(); // allow / deny keyword
      if (actionTok.value !== 'allow' && actionTok.value !== 'deny') {
        throw new ParseError(`expected 'allow' or 'deny' in machine block`, actionTok);
      }
      const kind = actionTok.value as 'allow' | 'deny';
      expect('KEYWORD', 'transition');
      const from = match('STAR') ? (advance(), '*') : expect('IDENT').value;
      expect('ARROW');
      const to = match('STAR') ? (advance(), '*') : expect('IDENT').value;
      consume('SEMICOLON');
      transitions.push({ kind, from, to });
    }
    expect('RBRACE');
    return { kind: 'StateMachineDecl', name, onType, onField, transitions };
  }

  // permission NAME on DataType {
  //   allow|deny RoleEnum.Value -> read | write | delete [when field_name];
  // }
  function parsePermissionDecl(): PermissionDecl {
    expect('KEYWORD', 'permission');
    const name = expect('IDENT').value;
    expect('KEYWORD', 'on');
    const onType = expect('IDENT').value;
    const rules: PermissionRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const actionTok = advance(); // allow / deny keyword
      if (actionTok.value !== 'allow' && actionTok.value !== 'deny') {
        throw new ParseError(`expected 'allow' or 'deny' in permission block`, actionTok);
      }
      const kind = actionTok.value as 'allow' | 'deny';

      // Subject: RoleEnum.Value or *
      let roleEnum = '*';
      let roleValue = '*';
      if (match('STAR')) {
        advance();
      } else {
        roleEnum = expect('IDENT').value;
        expect('DOT');
        roleValue = expect('IDENT').value;
      }

      expect('ARROW');

      // Operations: * or op1 | op2 | op3
      const operations: string[] = [];
      if (match('STAR')) {
        advance();
        operations.push('*');
      } else {
        operations.push(expectIdent().value);
        while (consume('PIPE')) {
          operations.push(expectIdent().value);
        }
      }

      // Optional: when field_name
      let whenField: string | undefined;
      if (consume('KEYWORD', 'when')) {
        whenField = expect('IDENT').value;
      }
      consume('SEMICOLON');
      rules.push({ kind, roleEnum, roleValue, operations, whenField });
    }
    expect('RBRACE');
    return { kind: 'PermissionDecl', name, onType, rules };
  }

  // HTTP methods that may appear as endpoints in contract blocks
  const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
  const CONTRACT_STARTERS = new Set(['query', 'mutation', 'subscription', 'rpc', 'publishes', 'subscribes']);

  function parseReturnType(): string {
    const parts: string[] = [];
    while (!match('RBRACE') && !match('SEMICOLON') && !eof()) {
      const t = peek();
      if (t.kind === 'IDENT' && HTTP_METHODS.has(t.value)) break;
      if (t.kind === 'KEYWORD' && CONTRACT_STARTERS.has(t.value)) break;
      parts.push(advance().value);
    }
    return parts.join('').trim();
  }

  function parseContractDecl(): ContractDecl {
    expect('KEYWORD', 'contract');
    const name = expect('IDENT').value;
    const endpoints: ContractEndpoint[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const t = peek();

      if (t.kind === 'IDENT' && HTTP_METHODS.has(t.value)) {
        advance();
        const path = expect('STRING').value;
        let returnType: string | undefined;
        if (consume('ARROW')) {
          const rt = parseReturnType();
          if (rt) returnType = rt;
        }
        endpoints.push({ kind: 'http', method: t.value, path, ...(returnType ? { returnType } : {}) });

      } else if (t.kind === 'KEYWORD' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        advance();
        const operation = t.value as 'query' | 'mutation' | 'subscription';
        const operationName = expect('IDENT').value;
        const inputTypes: string[] = [];
        if (consume('LPAREN')) {
          while (!match('RPAREN') && !eof()) {
            advance();
            if (consume('COLON')) {
              inputTypes.push(expectIdent().value);
            }
            consume('COMMA');
          }
          expect('RPAREN');
        }
        let returnType: string | undefined;
        if (consume('ARROW')) {
          const rt = parseReturnType();
          if (rt) returnType = rt;
        }
        endpoints.push({
          kind: 'graphql', operation, operationName,
          ...(inputTypes.length > 0 ? { inputTypes } : {}),
          ...(returnType ? { returnType } : {}),
        });

      } else if (t.kind === 'KEYWORD' && t.value === 'rpc') {
        advance();
        const rpcName = expect('IDENT').value;
        expect('LPAREN');
        const inputMessage = expect('IDENT').value;
        expect('RPAREN');
        expect('ARROW');
        const outputMessage = expect('IDENT').value;
        endpoints.push({ kind: 'grpc', rpcName, inputMessage, outputMessage });

      } else if (t.kind === 'KEYWORD' && (t.value === 'publishes' || t.value === 'subscribes')) {
        advance();
        expect('COLON');
        const topic = expect('STRING').value;
        endpoints.push({ kind: t.value === 'publishes' ? 'queue_publish' : 'queue_subscribe', topic });

      } else {
        throw new ParseError('expected endpoint declaration (HTTP method, query, mutation, subscription, rpc, publishes, subscribes)', t);
      }
      consume('SEMICOLON');
    }
    expect('RBRACE');
    return { kind: 'ContractDecl', name, endpoints };
  }

  // repo NAME "url" [branch="main"]
  // e.g.: repo BackendAPI "github.com/my-org/backend-api" branch="main"
  function parseRepoDecl(): RepoDecl {
    expect('KEYWORD', 'repo');
    const name = expect('IDENT').value;
    const url = expect('STRING').value;
    let branch: string | undefined;
    // Optional: branch="main"
    if (matchIdent() && peek().value === 'branch') {
      advance();
      if (consume('EQ')) {
        branch = expect('STRING').value;
      }
    }
    return { kind: 'RepoDecl', name, url, ...(branch ? { branch } : {}) };
  }

  // plugin "package-name"
  function parsePluginDecl(): PluginDecl {
    expect('KEYWORD', 'plugin');
    const packageName = expect('STRING').value;
    return { kind: 'PluginDecl', packageName };
  }

  // test NAME { assert ... }
  function parseTestDecl(): TestDecl {
    expect('KEYWORD', 'test');
    const name = expect('IDENT').value;
    const asserts: AssertStmt[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      expect('KEYWORD', 'assert');
      const chain = parseQueryChain();
      asserts.push({ chain });
    }
    expect('RBRACE');
    return { kind: 'TestDecl', name, asserts };
  }

  const declarations: Declaration[] = [];
  while (!eof()) {
    const t = peek();
    if (t.kind === 'KEYWORD') {
      switch (t.value) {
        case 'node':       declarations.push(parseNodeDecl()); break;
        case 'enum':       declarations.push(parseEnumDecl()); break;
        case 'data':       declarations.push(parseDataDecl()); break;
        case 'component':  declarations.push(parseComponentDecl()); break;
        case 'service':    declarations.push(parseServiceDecl()); break;
        case 'invariant':  declarations.push(parseInvariantDecl()); break;
        case 'machine':    declarations.push(parseStateMachineDecl()); break;
        case 'permission': declarations.push(parsePermissionDecl()); break;
        case 'contract':   declarations.push(parseContractDecl()); break;
        case 'plugin':     declarations.push(parsePluginDecl()); break;
        case 'repo':       declarations.push(parseRepoDecl()); break;
        case 'test':       declarations.push(parseTestDecl()); break;
        default:
          throw new ParseError(`unexpected keyword '${t.value}'`, t);
      }
    } else {
      throw new ParseError('expected a declaration keyword', t);
    }
  }

  return { declarations };
}
