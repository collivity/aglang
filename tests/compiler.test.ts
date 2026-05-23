import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { loadAndMerge, ImportError } from '../src/importer.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

// ── Parser tests ─────────────────────────────────────────────
describe('parser', () => {
  it('parses a simple spec', () => {
    const tokens = tokenize(`
      node web : edge_desktop { trust: untrusted }
      component Ui { runs_on: web  paths: "src/**/*.ts" }
    `);
    const program = parse(tokens);
    expect(program.declarations).toHaveLength(2);
    expect(program.declarations[0]!.kind).toBe('NodeDecl');
    expect(program.declarations[1]!.kind).toBe('ComponentDecl');
  });

  it('parses an invariant with deny flow', () => {
    const tokens = tokenize(`
      invariant Boundary { deny flow A -> B }
    `);
    const program = parse(tokens);
    expect(program.declarations[0]!.kind).toBe('InvariantDecl');
  });

  it('parses an enum', () => {
    const tokens = tokenize(`
      enum Status { Active | Inactive | Deleted }
    `);
    const program = parse(tokens);
    expect(program.declarations[0]!.kind).toBe('EnumDecl');
  });

  it('keeps uppercase classification and jurisdiction entries as data fields', () => {
    const tokens = tokenize(`
      data CustomerProfile {
        classification: String
        jurisdiction: String
      }
    `);
    const program = parse(tokens);
    const data = program.declarations[0]!;
    expect(data.kind).toBe('DataDecl');
    if (data.kind === 'DataDecl') {
      expect(data.classification).toBeUndefined();
      expect(data.fields.map(f => f.key)).toEqual(['classification', 'jurisdiction']);
    }
  });

  it('parses a contract block', () => {
    const tokens = tokenize(`
      contract MyApi {
        GET "/api/items" -> ItemDto[]
        POST "/api/items" -> ItemDto
      }
    `);
    const program = parse(tokens);
    expect(program.declarations[0]!.kind).toBe('ContractDecl');
  });

  it('parses component with implements and consumes', () => {
    const tokens = tokenize(`
      contract SomeApi { GET "/api/x" -> Dto }
      node n : server { trust: trusted }
      component Server {
        runs_on: n
        paths: "src/**/*.cs"
        implements: SomeApi
      }
    `);
    const program = parse(tokens);
    const comp = program.declarations.find(d => d.kind === 'ComponentDecl');
    expect(comp).toBeDefined();
  });

  it('parses resource declarations and component role/layer metadata', () => {
    const tokens = tokenize(`
      node ios : edge_mobile { trust: semi_trusted }
      resource SecureStorage : secure_storage { trust: trusted }
      component HomeScreen {
        runs_on: ios
        paths: "Sources/Home/**/*.swift"
        role: presentation
        layer: Presentation
      }
    `);
    const program = parse(tokens);
    expect(program.declarations.some(d => d.kind === 'ResourceDecl')).toBe(true);
    const comp = program.declarations.find(d => d.kind === 'ComponentDecl');
    expect(comp).toMatchObject({ role: 'presentation', layer: 'Presentation' });
  });

  it('parses selector-style invariant endpoints', () => {
    const tokens = tokenize(`
      invariant StrictBoundaries {
        deny flow role presentation -> resource secure_storage
      }
    `);
    const program = parse(tokens);
    const inv = program.declarations[0]!;
    expect(inv.kind).toBe('InvariantDecl');
    if (inv.kind === 'InvariantDecl') {
      expect(inv.rules[0]).toMatchObject({
        kind: 'DenyFlow',
        fromEndpoint: { kind: 'role', name: 'presentation' },
        toEndpoint: { kind: 'resource', name: 'secure_storage' },
      });
    }
  });
});

// ── Checker tests ─────────────────────────────────────────────
describe('checker', () => {
  it('passes a valid spec', () => {
    const tokens = tokenize(`
      node db : postgres { trust: trusted }
      node api : server { trust: trusted }
      component Api { runs_on: api  paths: "src/**/*.ts" }
      component Data { runs_on: db  paths: "data/**/*.ts" }
      invariant Layered { deny flow Api -> db }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors).toHaveLength(0);
  });

  it('rejects unknown node in component runs_on', () => {
    const tokens = tokenize(`
      component Orphan { runs_on: nonexistent  paths: "src/**/*.ts" }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/nonexistent/);
  });

  it('rejects unknown component in invariant flow rule', () => {
    const tokens = tokenize(`
      node n : server { trust: trusted }
      invariant Bad { deny flow Ghost -> n }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects duplicate node names', () => {
    const tokens = tokenize(`
      node db : postgres { trust: trusted }
      node db : mysql { trust: trusted }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors.some(e => e.message.includes("Duplicate node name 'db'"))).toBe(true);
  });

  it('rejects duplicate component names', () => {
    const tokens = tokenize(`
      node n : server { trust: trusted }
      component A { runs_on: n  paths: "a/**/*.ts" }
      component A { runs_on: n  paths: "b/**/*.ts" }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors.some(e => e.message.includes("Duplicate component name 'A'"))).toBe(true);
  });

  it('rejects duplicate contract names', () => {
    const tokens = tokenize(`
      contract C { GET "/x" -> Dto }
      contract C { POST "/y" -> Dto }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors.some(e => e.message.includes("Duplicate contract name 'C'"))).toBe(true);
  });

  it('rejects implements referencing unknown contract', () => {
    const tokens = tokenize(`
      node n : server { trust: trusted }
      component Srv { runs_on: n  paths: "src/**/*.cs"  implements: NonExistentContract }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors.some(e => e.message.includes('NonExistentContract'))).toBe(true);
  });

  it('accepts valid resource and role selector invariants', () => {
    const tokens = tokenize(`
      node ios : edge_mobile { trust: semi_trusted }
      resource SecureStorage : secure_storage { trust: trusted }
      component HomeScreen {
        runs_on: ios
        paths: "Sources/Home/**/*.swift"
        role: presentation
      }
      invariant StrictBoundaries {
        deny flow role presentation -> resource secure_storage
      }
    `);
    const program = parse(tokens);
    const errors = check(program);
    expect(errors).toHaveLength(0);
  });

  it('rejects invalid component roles', () => {
    const tokens = tokenize(`
      node n : server { trust: trusted }
      component Weird { runs_on: n paths: "**/*.ts" role: screen_controller }
    `);
    const errors = check(parse(tokens));
    expect(errors.some(e => e.message.includes("invalid role 'screen_controller'"))).toBe(true);
  });

  it('rejects resource selectors that match no declared resource', () => {
    const tokens = tokenize(`
      node ios : edge_mobile { trust: semi_trusted }
      component HomeScreen {
        runs_on: ios
        paths: "Sources/Home/**/*.swift"
        role: presentation
      }
      invariant StrictBoundaries {
        deny flow role presentation -> resource secure_storage
      }
    `);
    const errors = check(parse(tokens));
    expect(errors.some(e => e.message.includes("resource selector 'secure_storage' matches no resources"))).toBe(true);
  });

  it('emits resources and expands selector invariants in the artifact', () => {
    const program = parse(tokenize(`
      node ios : edge_mobile { trust: semi_trusted }
      resource SecureStorage : secure_storage { trust: trusted }
      component HomeScreen {
        runs_on: ios
        paths: "Sources/Home/**/*.swift"
        role: presentation
      }
      invariant StrictBoundaries {
        deny flow role presentation -> resource secure_storage
      }
    `));
    const artifact = emitArtifact(program, 'test.ag');
    expect(artifact.resources).toEqual([
      { name: 'SecureStorage', type: 'secure_storage', trust: 'trusted', protocol: undefined, auth: undefined },
    ]);
    expect(artifact.invariants[0]!.rules).toEqual([
      { kind: 'DenyFlow', from: 'HomeScreen', to: 'SecureStorage' },
    ]);
    expect(artifact.constraints).toContain('(assert (=> (Flow HomeScreen SecureStorage) false))');
  });
});

// ── Importer tests ─────────────────────────────────────────────
describe('importer', () => {
  it('loads a simple single-file spec', () => {
    const program = loadAndMerge(resolve(FIXTURES, 'simple.ag'));
    expect(program.declarations.length).toBeGreaterThan(0);
  });

  it('handles a shared DAG (A→B→D, A→C→D) without false cycle error', () => {
    // dag-root.ag imports child-a.ag and child-b.ag, both of which import shared.ag
    expect(() => loadAndMerge(resolve(FIXTURES, 'dag-root.ag'))).not.toThrow();
  });

  it('loads shared declarations exactly once (no duplicates from DAG)', () => {
    const program = loadAndMerge(resolve(FIXTURES, 'dag-root.ag'));
    // shared.ag declares `shared_node` — it should appear exactly once
    const sharedNodes = program.declarations.filter(
      d => d.kind === 'NodeDecl' && (d as { name: string }).name === 'shared_node',
    );
    expect(sharedNodes).toHaveLength(1);
  });

  it('throws ImportError on actual circular imports', () => {
    expect(() => loadAndMerge(resolve(FIXTURES, 'cycle-a.ag'))).toThrow(ImportError);
  });

  it('throws ImportError for missing files', () => {
    expect(() => loadAndMerge(resolve(FIXTURES, 'does-not-exist.ag'))).toThrow(ImportError);
  });
});
