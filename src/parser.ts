// Recursive-descent parser for aglang
import type { Token, TokenKind } from './lexer.ts';
import type {
  Program, Declaration, NodeDecl, NodeType, Prop,
  DataDecl, Field, EnumDecl, ComponentDecl, ServiceDecl, ResourceDecl,
  InvariantDecl, InvariantRule, TestDecl, AssertStmt,
  QueryChain, Selector, Quantifier, InvariantEndpoint,
  StateMachineDecl, TransitionRule, PermissionDecl, PermissionRule,
  ContractDecl, ContractEndpoint, PluginDecl, RepoDecl,
  WorkflowPolicyDecl, WorkflowPolicyRule, WorkflowCondition, WorkflowPolicyAction,
  ChangePolicyDecl, ChangePolicyRule, DiLifetime, DiPolicyDecl, DiPolicyRule,
  DataPolicyDecl, DataPolicyRule, TrustPolicyDecl, TrustPolicyRule,
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

  // resource NAME : resource_type { props }
  function parseResourceDecl(): ResourceDecl {
    expect('KEYWORD', 'resource');
    const name = expect('IDENT').value;
    expect('COLON');
    const resourceType = parseNodeType();
    const props = parseProps();
    return { kind: 'ResourceDecl', name, resourceType, props };
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
    let classification: string | undefined;
    let jurisdiction: string | undefined;
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const key = expectIdent().value;
      expect('COLON');
      if ((key === 'classification' || key === 'jurisdiction') && /^[a-z_]/.test(peek().value)) {
        const value = expectIdent().value;
        if (key === 'classification') classification = value;
        else jurisdiction = value;
        continue;
      }
      // Type expression: collect until next key: or }
      let typeExpr = '';
      while (
        !match('RBRACE') && !eof() &&
        !((peek().kind === 'IDENT' || peek().kind === 'KEYWORD') && tokens[pos + 1]?.kind === 'COLON')
      ) {
        const t = advance();
        typeExpr += (typeExpr ? ' ' : '') + t.value;
      }
      fields.push({ key, typeExpr: typeExpr.trim().replace(/\s*<\s*/g, '<').replace(/\s*>\s*/g, '>').replace(/\s*,\s*/g, ', ').replace(/\s*\|\s*/g, ' | ') });
    }
    expect('RBRACE');
    return {
      kind: 'DataDecl',
      name,
      fields,
      ...(classification ? { classification } : {}),
      ...(jurisdiction ? { jurisdiction } : {}),
    };
  }

  function parseIdentList(): string[] {
    const values = [expect('IDENT').value];
    while (consume('COMMA')) {
      values.push(expect('IDENT').value);
    }
    return values;
  }

  // component NAME { runs_on: X  paths: "glob"  repo: RepoName  implements: ContractA  consumes: ContractB  handles: DataA }
  function parseComponentDecl(): ComponentDecl {
    expect('KEYWORD', 'component');
    const name = expect('IDENT').value;
    let runsOn = '';
    let paths = '';
    let role: string | undefined;
    let layer: string | undefined;
    let repoRef: string | undefined;
    const implementsList: string[] = [];
    const consumesList: string[] = [];
    const handlesList: string[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const key = advance().value; // runs_on, paths, repo, implements, consumes, or unknown
      expect('COLON');
      if (key === 'runs_on') {
        runsOn = expect('IDENT').value;
      } else if (key === 'paths') {
        paths = expect('STRING').value;
      } else if (key === 'role') {
        role = expectIdent().value;
      } else if (key === 'layer') {
        layer = expect('IDENT').value;
      } else if (key === 'repo') {
        repoRef = expect('IDENT').value;
      } else if (key === 'implements') {
        implementsList.push(...parseIdentList());
      } else if (key === 'consumes') {
        consumesList.push(...parseIdentList());
      } else if (key === 'handles') {
        handlesList.push(...parseIdentList());
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
      ...(role ? { role } : {}),
      ...(layer ? { layer } : {}),
      ...(repoRef ? { repo: repoRef } : {}),
      ...(implementsList.length > 0 ? { implements: implementsList } : {}),
      ...(consumesList.length > 0 ? { consumes: consumesList } : {}),
      ...(handlesList.length > 0 ? { handles: handlesList } : {}),
    };
  }

  // service NAME { props }
  function parseServiceDecl(): ServiceDecl {
    expect('KEYWORD', 'service');
    const name = expect('IDENT').value;
    const props = parseProps();
    return { kind: 'ServiceDecl', name, props };
  }

  function endpointName(endpoint: InvariantEndpoint): string {
    return endpoint.name;
  }

  function parseInvariantEndpoint(): InvariantEndpoint {
    const t = advance();
    if (t.value === 'role' || t.value === 'layer' || t.value === 'resource') {
      return {
        kind: t.value as 'role' | 'layer' | 'resource',
        name: expectIdent().value,
      };
    }
    if (t.kind !== 'IDENT' && t.kind !== 'KEYWORD') {
      throw new ParseError('expected invariant endpoint', t);
    }
    return { kind: 'entity', name: t.value };
  }

  // invariant NAME { deny flow A -> B; | require flow A -> B via C; | require operation op in Component; | require encryption on flow A -> B; }
  function parseInvariantDecl(): InvariantDecl {
    expect('KEYWORD', 'invariant');
    const name = expect('IDENT').value;
    const rules: InvariantRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const action = advance().value; // 'deny' or 'require'
      if (action === 'deny') {
        const denied = advance();
        if (denied.value === 'flow' || denied.value === 'reach') {
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({
            kind: denied.value === 'reach' ? 'DenyReach' : 'DenyFlow',
            from: endpointName(fromEndpoint),
            to: endpointName(toEndpoint),
            fromEndpoint,
            toEndpoint,
          });
        } else if (denied.value === 'dataflow') {
          const data = expect('IDENT').value;
          expect('ARROW');
          const to = expect('IDENT').value;
          consume('SEMICOLON');
          rules.push({ kind: 'DenyDataFlow', data, to });
        } else if (denied.value === 'path_without_via') {
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          expect('KEYWORD', 'via');
          const viaEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({
            kind: 'RequireFlowVia',
            from: endpointName(fromEndpoint),
            to: endpointName(toEndpoint),
            via: endpointName(viaEndpoint),
            fromEndpoint,
            toEndpoint,
            viaEndpoint,
          });
        } else if (denied.value === 'data_path_without_via') {
          const data = expect('IDENT').value;
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          expect('KEYWORD', 'via');
          const viaEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({ kind: 'RequireDataFlowVia', data, to: endpointName(toEndpoint), via: endpointName(viaEndpoint), toEndpoint, viaEndpoint });
        } else if (denied.value === 'unauthenticated') {
          expect('KEYWORD', 'flow');
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({ kind: 'DenyUnauthenticatedFlow', from: endpointName(fromEndpoint), to: endpointName(toEndpoint), fromEndpoint, toEndpoint });
        } else if (denied.value === 'unencrypted') {
          expect('KEYWORD', 'flow');
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({ kind: 'DenyUnencryptedFlow', from: endpointName(fromEndpoint), to: endpointName(toEndpoint), fromEndpoint, toEndpoint });
        } else if (denied.value === 'operation') {
          const operation = expectIdent().value;
          let data: string | undefined;
          if (consume('KEYWORD', 'on')) data = expectIdent().value;
          const outside = expectIdent();
          if (outside.value !== 'outside') throw new ParseError(`expected 'outside' after deny operation`, outside);
          const component = expectIdent().value;
          consume('SEMICOLON');
          if (data) rules.push({ kind: 'RequireOperationOnDataIn', operation, data, component });
          else rules.push({ kind: 'RequireOperationIn', operation, component });
        } else if (denied.value === 'dependency') {
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          const without = expectIdent();
          if (without.value !== 'without') throw new ParseError(`expected 'without' after deny dependency`, without);
          const interfaceKeyword = expectIdent();
          if (interfaceKeyword.value !== 'interface') throw new ParseError(`expected 'interface' after deny dependency without`, interfaceKeyword);
          const interfaceName = expectIdent().value;
          consume('SEMICOLON');
          rules.push({ kind: 'RequireDependencyViaInterface', from: endpointName(fromEndpoint), to: endpointName(toEndpoint), interface: interfaceName, fromEndpoint, toEndpoint });
        } else {
          throw new ParseError(`expected 'flow', 'reach', 'dataflow', or counterexample kind after deny`, denied);
        }
      } else if (action === 'require') {
        const required = advance();
        if (required.value === 'encryption') {
          expect('KEYWORD', 'on');
          expect('KEYWORD', 'flow');
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({
            kind: 'DenyUnencryptedFlow',
            from: endpointName(fromEndpoint),
            to: endpointName(toEndpoint),
            fromEndpoint,
            toEndpoint,
          });
        } else if (required.value === 'auth') {
          expect('KEYWORD', 'on');
          expect('KEYWORD', 'flow');
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({
            kind: 'DenyUnauthenticatedFlow',
            from: endpointName(fromEndpoint),
            to: endpointName(toEndpoint),
            fromEndpoint,
            toEndpoint,
          });
        } else if (required.value === 'flow') {
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          expect('KEYWORD', 'via');
          const viaEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({
            kind: 'RequireFlowVia',
            from: endpointName(fromEndpoint),
            to: endpointName(toEndpoint),
            via: endpointName(viaEndpoint),
            fromEndpoint,
            toEndpoint,
            viaEndpoint,
          });
        } else if (required.value === 'operation') {
          const operation = expectIdent().value;
          if (consume('KEYWORD', 'on')) {
            const data = expectIdent().value;
            expect('KEYWORD', 'in');
            const component = expectIdent().value;
            consume('SEMICOLON');
            rules.push({ kind: 'RequireOperationOnDataIn', operation, data, component });
            continue;
          }
          expect('KEYWORD', 'in');
          const component = expectIdent().value;
          consume('SEMICOLON');
          rules.push({ kind: 'RequireOperationIn', operation, component });
        } else if (required.value === 'dataflow') {
          const data = expect('IDENT').value;
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          expect('KEYWORD', 'via');
          const viaEndpoint = parseInvariantEndpoint();
          consume('SEMICOLON');
          rules.push({ kind: 'RequireDataFlowVia', data, to: endpointName(toEndpoint), via: endpointName(viaEndpoint), toEndpoint, viaEndpoint });
        } else if (required.value === 'contract') {
          const contract = expectIdent().value;
          const implementedBy = expectIdent();
          if (implementedBy.value !== 'implemented_by') throw new ParseError(`expected 'implemented_by' after require contract`, implementedBy);
          const component = expectIdent().value;
          consume('SEMICOLON');
          rules.push({ kind: 'RequireContractImplementedBy', contract, component });
        } else if (required.value === 'dependency') {
          const fromEndpoint = parseInvariantEndpoint();
          expect('ARROW');
          const toEndpoint = parseInvariantEndpoint();
          expect('KEYWORD', 'via');
          const interfaceKeyword = expectIdent();
          if (interfaceKeyword.value !== 'interface') throw new ParseError(`expected 'interface' after require dependency via`, interfaceKeyword);
          const interfaceName = expectIdent().value;
          consume('SEMICOLON');
          rules.push({ kind: 'RequireDependencyViaInterface', from: endpointName(fromEndpoint), to: endpointName(toEndpoint), interface: interfaceName, fromEndpoint, toEndpoint });
        } else {
          throw new ParseError(`expected 'auth', 'encryption', 'flow', 'dataflow', 'operation', 'contract', or 'dependency' after require`, required);
        }
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

  function parseWorkflowCondition(): WorkflowCondition | undefined {
    if (!consume('KEYWORD', 'when')) return undefined;
    const t = advance();
    if (t.value === 'pull_request') {
      return { kind: 'pull_request' };
    }
    if (t.value === 'branch' || t.value === 'tag') {
      const value = expect('STRING').value;
      return { kind: t.value as 'branch' | 'tag', value };
    }
    throw new ParseError(`expected workflow condition 'branch', 'tag', or 'pull_request'`, t);
  }

  function parseWorkflowRef(): string {
    if (match('STAR')) {
      advance();
      return '*';
    }
    return expect('IDENT').value;
  }

  function parseWorkflowAction(): WorkflowPolicyAction {
    const t = advance();
    if (t.value === 'publish' || t.value === 'deploy' || t.value === 'release') {
      return t.value;
    }
    throw new ParseError(`expected workflow action 'publish', 'deploy', or 'release'`, t);
  }

  function parseWorkflowPolicyDecl(): WorkflowPolicyDecl {
    expect('KEYWORD', 'workflow_policy');
    const name = expect('IDENT').value;
    const rules: WorkflowPolicyRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const first = advance();
      if (first.value === 'require') {
        expect('KEYWORD', 'before');
        const workflow = expect('IDENT').value;
        const before = expect('STRING').value;
        expect('ARROW');
        const after = expect('STRING').value;
        consume('SEMICOLON');
        rules.push({ kind: 'BeforeRule', workflow, before, after });
        continue;
      }

      if (first.value !== 'allow' && first.value !== 'deny') {
        throw new ParseError(`expected 'allow', 'deny', or 'require' in workflow_policy block`, first);
      }
      const effect = first.value as 'allow' | 'deny';

      if (peek().value === 'permission') {
        advance();
        const workflow = parseWorkflowRef();
        const permission = expectIdent().value;
        expect('COLON');
        const access = expectIdent().value;
        const when = parseWorkflowCondition();
        consume('SEMICOLON');
        rules.push({
          kind: 'PermissionRule',
          effect,
          workflow,
          permission,
          access,
          ...(when ? { when } : {}),
        });
        continue;
      }

      const action = parseWorkflowAction();
      const workflow = parseWorkflowRef();
      expect('ARROW');
      const target = expect('IDENT').value;
      const when = parseWorkflowCondition();
      consume('SEMICOLON');
      rules.push({
        kind: 'ActionRule',
        effect,
        action,
        workflow,
        target,
        ...(when ? { when } : {}),
      });
    }
    expect('RBRACE');
    return { kind: 'WorkflowPolicyDecl', name, rules };
  }

  function parseDiLifetime(): DiLifetime {
    const t = advance();
    if (t.value === 'singleton' || t.value === 'scoped' || t.value === 'transient') {
      return t.value;
    }
    throw new ParseError(`expected DI lifetime 'singleton', 'scoped', or 'transient'`, t);
  }

  function parseDiPolicyDecl(): DiPolicyDecl {
    expect('KEYWORD', 'di_policy');
    const name = expect('IDENT').value;
    const rules: DiPolicyRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const action = advance();
      if (action.value !== 'deny') {
        throw new ParseError(`expected 'deny' in di_policy block`, action);
      }

      const ruleKind = advance();
      if (ruleKind.value === 'inject') {
        const from = expect('IDENT').value;
        expect('ARROW');
        const to = expect('IDENT').value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyInject', from, to });
        continue;
      }

      if (ruleKind.value === 'inject_reach') {
        const from = expect('IDENT').value;
        expect('ARROW');
        const to = expect('IDENT').value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyInjectReach', from, to });
        continue;
      }

      if (ruleKind.value === 'lifetime') {
        const from = parseDiLifetime();
        expect('ARROW');
        const to = parseDiLifetime();
        consume('SEMICOLON');
        rules.push({ kind: 'DenyLifetime', from, to });
        continue;
      }

      if (ruleKind.value === 'lifetime_reach') {
        const from = parseDiLifetime();
        expect('ARROW');
        const to = parseDiLifetime();
        consume('SEMICOLON');
        rules.push({ kind: 'DenyLifetimeReach', from, to });
        continue;
      }

      if (ruleKind.value === 'resolve') {
        const service = expectIdent().value;
        expect('KEYWORD', 'from');
        const from = expect('IDENT').value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyResolve', service, from });
        continue;
      }

      throw new ParseError(`expected 'inject', 'inject_reach', 'lifetime', 'lifetime_reach', or 'resolve' after deny`, ruleKind);
    }
    expect('RBRACE');
    return { kind: 'DiPolicyDecl', name, rules };
  }

  function parseDataPolicyDecl(): DataPolicyDecl {
    expect('KEYWORD', 'data_policy');
    const name = expect('IDENT').value;
    const rules: DataPolicyRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const action = advance();
      if (action.value !== 'deny') {
        throw new ParseError(`expected 'deny' in data_policy block`, action);
      }
      const selector = advance();
      if (selector.value === 'classification') {
        const classification = expectIdent().value;
        expect('ARROW');
        const toTrust = expectIdent().value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyClassification', classification, toTrust });
        continue;
      }
      if (selector.value === 'jurisdiction') {
        const jurisdiction = expectIdent().value;
        expect('ARROW');
        const to = expect('IDENT').value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyJurisdiction', jurisdiction, to });
        continue;
      }
      throw new ParseError(`expected 'classification' or 'jurisdiction' after deny`, selector);
    }
    expect('RBRACE');
    return { kind: 'DataPolicyDecl', name, rules };
  }

  function parseTrustPolicyDecl(): TrustPolicyDecl {
    expect('KEYWORD', 'trust_policy');
    const name = expect('IDENT').value;
    const rules: TrustPolicyRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      const action = advance();
      if (action.value === 'require') {
        expect('KEYWORD', 'auth');
        const fromTrust = expectIdent().value;
        expect('ARROW');
        const toTrust = expectIdent().value;
        consume('SEMICOLON');
        rules.push({ kind: 'RequireAuth', fromTrust, toTrust });
        continue;
      }
      if (action.value === 'deny') {
        expect('KEYWORD', 'flow');
        const fromTrust = expectIdent().value;
        expect('ARROW');
        const toTrust = expectIdent().value;
        expect('KEYWORD', 'when');
        expect('KEYWORD', 'data');
        const classification = expectIdent().value;
        consume('SEMICOLON');
        rules.push({ kind: 'DenyFlowWhenData', fromTrust, toTrust, classification });
        continue;
      }
      throw new ParseError(`expected 'require' or 'deny' in trust_policy block`, action);
    }
    expect('RBRACE');
    return { kind: 'TrustPolicyDecl', name, rules };
  }

  function parseChangePolicyDecl(): ChangePolicyDecl {
    expect('KEYWORD', 'change_policy');
    const name = expect('IDENT').value;
    const rules: ChangePolicyRule[] = [];
    expect('LBRACE');
    while (!match('RBRACE') && !eof()) {
      expect('KEYWORD', 'require');
      expect('KEYWORD', 'touched');
      const required = expect('IDENT').value;
      expect('KEYWORD', 'when');
      expect('KEYWORD', 'touched');
      const trigger = expect('IDENT').value;
      consume('SEMICOLON');
      rules.push({ kind: 'RequireTouched', required, trigger });
    }
    expect('RBRACE');
    return { kind: 'ChangePolicyDecl', name, rules };
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
        case 'resource':   declarations.push(parseResourceDecl()); break;
        case 'enum':       declarations.push(parseEnumDecl()); break;
        case 'data':       declarations.push(parseDataDecl()); break;
        case 'component':  declarations.push(parseComponentDecl()); break;
        case 'service':    declarations.push(parseServiceDecl()); break;
        case 'invariant':  declarations.push(parseInvariantDecl()); break;
        case 'machine':    declarations.push(parseStateMachineDecl()); break;
        case 'permission': declarations.push(parsePermissionDecl()); break;
        case 'contract':   declarations.push(parseContractDecl()); break;
        case 'plugin':     declarations.push(parsePluginDecl()); break;
        case 'workflow_policy': declarations.push(parseWorkflowPolicyDecl()); break;
        case 'di_policy': declarations.push(parseDiPolicyDecl()); break;
        case 'data_policy': declarations.push(parseDataPolicyDecl()); break;
        case 'trust_policy': declarations.push(parseTrustPolicyDecl()); break;
        case 'change_policy': declarations.push(parseChangePolicyDecl()); break;
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
