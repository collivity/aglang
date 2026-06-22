import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTreeSitterIrForFiles } from '../src/analyzers/ast/ir-extractor.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { mergeAgIrGraphs } from '../src/ir/builders.ts';
import { enrichAgIrWithAbstractionResolution, buildImplementorIndex } from '../src/ir/abstraction-resolver.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

function compileSpec(source: string) {
  return emitArtifact(parse(tokenize(source)), 'test-spec.ag');
}

describe('abstraction resolver (extends/implements graph + Go structural heuristic)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(name: string): string {
    const dir = join(tmpdir(), `aglang-abstraction-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('Python: resolves a class extending a base declared in another component', () => {
    const root = tempDir('python');
    mkdirSync(join(root, 'orders'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    const baseFile = join(root, 'data', 'base.py');
    const derivedFile = join(root, 'orders', 'service.py');
    writeFileSync(baseFile, 'class BaseRepository:\n    pass\n');
    writeFileSync(derivedFile, 'class OrderRepository(BaseRepository):\n    pass\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "orders/**/*.py" }
      component Data { runs_on: n paths: "data/**/*.py" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([derivedFile], 'Orders'),
      extractTreeSitterIrForFiles([baseFile], 'Data'),
    ]);

    const resolved = enrichAgIrWithAbstractionResolution(graph, artifact);

    expect(resolved.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'extends', properties: expect.objectContaining({ baseType: 'BaseRepository', resolved: true, targetComponent: 'Data' }) }),
    ]));
  });

  it('Java: resolves extends and multiple implements from one declaration', () => {
    const root = tempDir('java');
    mkdirSync(join(root, 'orders'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    const derivedFile = join(root, 'orders', 'Derived.java');
    writeFileSync(derivedFile, 'class Derived extends Base implements IRepo, IOther {}\n');
    const baseFile = join(root, 'data', 'Base.java');
    writeFileSync(baseFile, 'class Base {}\ninterface IRepo {}\ninterface IOther {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "orders/**/*.java" }
      component Data { runs_on: n paths: "data/**/*.java" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([derivedFile], 'Orders'),
      extractTreeSitterIrForFiles([baseFile], 'Data'),
    ]);

    const resolved = enrichAgIrWithAbstractionResolution(graph, artifact);

    expect(resolved.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'extends', properties: expect.objectContaining({ baseType: 'Base', resolved: true, targetComponent: 'Data' }) }),
      expect.objectContaining({ kind: 'implements', properties: expect.objectContaining({ interface: 'IRepo', resolved: true, targetComponent: 'Data' }) }),
      expect.objectContaining({ kind: 'implements', properties: expect.objectContaining({ interface: 'IOther', resolved: true, targetComponent: 'Data' }) }),
    ]));
  });

  it('Rust: resolves a trait impl but ignores an inherent impl (no trait)', () => {
    const root = tempDir('rust');
    mkdirSync(join(root, 'orders'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    const implFile = join(root, 'orders', 'service.rs');
    writeFileSync(implFile, 'struct OrderRepository {}\nimpl Repo for OrderRepository {}\nimpl OrderRepository {\n    fn helper() {}\n}\n');
    const traitFile = join(root, 'data', 'repo.rs');
    writeFileSync(traitFile, 'trait Repo {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "orders/**/*.rs" }
      component Data { runs_on: n paths: "data/**/*.rs" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([implFile], 'Orders'),
      extractTreeSitterIrForFiles([traitFile], 'Data'),
    ]);

    const resolved = enrichAgIrWithAbstractionResolution(graph, artifact);

    const implementsEdges = resolved.edges.filter(e => e.kind === 'implements');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]).toMatchObject({ properties: expect.objectContaining({ interface: 'Repo', resolved: true, targetComponent: 'Data' }) });
  });

  it('Swift: resolves a protocol conformance (treated uniformly as implements)', () => {
    const root = tempDir('swift');
    mkdirSync(join(root, 'orders'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    const classFile = join(root, 'orders', 'Service.swift');
    writeFileSync(classFile, 'class OrderRepository: Repo {}\n');
    const protocolFile = join(root, 'data', 'Repo.swift');
    writeFileSync(protocolFile, 'protocol Repo {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "orders/**/*.swift" }
      component Data { runs_on: n paths: "data/**/*.swift" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([classFile], 'Orders'),
      extractTreeSitterIrForFiles([protocolFile], 'Data'),
    ]);

    const resolved = enrichAgIrWithAbstractionResolution(graph, artifact);

    expect(resolved.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'implements', properties: expect.objectContaining({ interface: 'Repo', resolved: true, targetComponent: 'Data' }) }),
    ]));
  });

  it('extends/implements resolution skips an ambiguous name declared in multiple components', () => {
    const root = tempDir('python-ambiguous');
    mkdirSync(join(root, 'orders'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'shared'), { recursive: true });
    const derivedFile = join(root, 'orders', 'service.py');
    writeFileSync(derivedFile, 'class OrderRepository(BaseRepository):\n    pass\n');
    const baseFile1 = join(root, 'data', 'base.py');
    const baseFile2 = join(root, 'shared', 'base.py');
    writeFileSync(baseFile1, 'class BaseRepository:\n    pass\n');
    writeFileSync(baseFile2, 'class BaseRepository:\n    pass\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "orders/**/*.py" }
      component Data { runs_on: n paths: "data/**/*.py" }
      component Shared { runs_on: n paths: "shared/**/*.py" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([derivedFile], 'Orders'),
      extractTreeSitterIrForFiles([baseFile1], 'Data'),
      extractTreeSitterIrForFiles([baseFile2], 'Shared'),
    ]);

    const resolved = enrichAgIrWithAbstractionResolution(graph, artifact);

    const extendsEdge = resolved.edges.find(e => e.kind === 'extends' && e.properties?.baseType === 'BaseRepository');
    expect(extendsEdge?.properties?.resolved).toBeUndefined();
  });

  describe('Go structural heuristic', () => {
    function compileGoSpec() {
      return compileSpec(`
        node n : agent_runtime { trust: trusted }
        component Orders { runs_on: n paths: "orders/**/*.go" }
        component Data { runs_on: n paths: "data/**/*.go" }
      `);
    }

    it('matches a struct that declares all required methods of a >=2-method interface', () => {
      const root = tempDir('go-positive');
      mkdirSync(join(root, 'orders'), { recursive: true });
      mkdirSync(join(root, 'data'), { recursive: true });
      const ifaceFile = join(root, 'data', 'repo.go');
      const structFile = join(root, 'orders', 'service.go');
      writeFileSync(ifaceFile, 'package data\n\ntype Repo interface {\n\tSave(order int) error\n\tFind(id int) (string, error)\n}\n');
      writeFileSync(structFile, 'package orders\n\ntype OrderRepository struct {}\n\nfunc (r *OrderRepository) Save(order int) error { return nil }\nfunc (r OrderRepository) Find(id int) (string, error) { return "", nil }\n');

      const graph = mergeAgIrGraphs([
        extractTreeSitterIrForFiles([ifaceFile], 'Data'),
        extractTreeSitterIrForFiles([structFile], 'Orders'),
      ]);
      const resolved = enrichAgIrWithAbstractionResolution(graph, compileGoSpec());

      const match = resolved.edges.find(e => e.kind === 'implements' && e.properties?.structural === true);
      expect(match).toMatchObject({ properties: expect.objectContaining({ interface: 'Repo', resolved: true, targetComponent: 'Data' }) });
      expect(match?.evidence[0]?.confidence).toBe('probable');

      const index = buildImplementorIndex(resolved);
      expect(index.get('Repo')).toEqual(new Set(['Data']));
    });

    it('does not match a struct that only declares part of the required method set', () => {
      const root = tempDir('go-negative');
      mkdirSync(join(root, 'orders'), { recursive: true });
      mkdirSync(join(root, 'data'), { recursive: true });
      const ifaceFile = join(root, 'data', 'repo.go');
      const structFile = join(root, 'orders', 'service.go');
      writeFileSync(ifaceFile, 'package data\n\ntype Repo interface {\n\tSave(order int) error\n\tFind(id int) (string, error)\n}\n');
      writeFileSync(structFile, 'package orders\n\ntype PartialRepository struct {}\n\nfunc (r PartialRepository) Save(order int) error { return nil }\n');

      const graph = mergeAgIrGraphs([
        extractTreeSitterIrForFiles([ifaceFile], 'Data'),
        extractTreeSitterIrForFiles([structFile], 'Orders'),
      ]);
      const resolved = enrichAgIrWithAbstractionResolution(graph, compileGoSpec());

      expect(resolved.edges.some(e => e.kind === 'implements' && e.properties?.structural === true)).toBe(false);
    });

    it('does not match a single-method interface even if a struct happens to share that method name (noise threshold)', () => {
      const root = tempDir('go-noise');
      mkdirSync(join(root, 'orders'), { recursive: true });
      mkdirSync(join(root, 'data'), { recursive: true });
      const ifaceFile = join(root, 'data', 'closer.go');
      const structFile = join(root, 'orders', 'service.go');
      writeFileSync(ifaceFile, 'package data\n\ntype Closer interface {\n\tClose() error\n}\n');
      writeFileSync(structFile, 'package orders\n\ntype UnrelatedThing struct {}\n\nfunc (u UnrelatedThing) Close() error { return nil }\n');

      const graph = mergeAgIrGraphs([
        extractTreeSitterIrForFiles([ifaceFile], 'Data'),
        extractTreeSitterIrForFiles([structFile], 'Orders'),
      ]);
      const resolved = enrichAgIrWithAbstractionResolution(graph, compileGoSpec());

      expect(resolved.edges.some(e => e.kind === 'implements' && e.properties?.structural === true)).toBe(false);
    });
  });
});
