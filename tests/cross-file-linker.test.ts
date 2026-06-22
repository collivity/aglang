import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTreeSitterIrForFiles } from '../src/analyzers/ast/ir-extractor.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { mergeAgIrGraphs } from '../src/ir/builders.ts';
import { enrichAgIrWithCrossFileLinks } from '../src/ir/cross-file-linker.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';

function compileSpec(source: string) {
  return emitArtifact(parse(tokenize(source)), 'test-spec.ag');
}

describe('cross-file linker (Python/Go/Rust/Java)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(name: string): string {
    const dir = join(tmpdir(), `aglang-linker-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('resolves Go aliased cross-component imports and calls, verified against declares', () => {
    const root = tempDir('go');
    writeFileSync(join(root, 'go.mod'), 'module github.com/acme/orders\n\ngo 1.21\n');
    mkdirSync(join(root, 'internal', 'orders'), { recursive: true });
    mkdirSync(join(root, 'internal', 'data'), { recursive: true });
    const serviceFile = join(root, 'internal', 'orders', 'service.go');
    const storeFile = join(root, 'internal', 'data', 'store.go');
    writeFileSync(serviceFile, [
      'package orders',
      '',
      'import (',
      '\tdata "github.com/acme/orders/internal/data"',
      '\t"fmt"',
      ')',
      '',
      'func Place() {',
      '\tdata.SaveOrder()',
      '\tfmt.Println("placed")',
      '}',
      '',
    ].join('\n'));
    writeFileSync(storeFile, 'package data\n\nfunc SaveOrder() {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "internal/orders/**/*.go" }
      component Data { runs_on: n paths: "internal/data/**/*.go" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([serviceFile], 'Orders'),
      extractTreeSitterIrForFiles([storeFile], 'Data'),
    ]);

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    expect(linked.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        properties: expect.objectContaining({ specifier: 'github.com/acme/orders/internal/data', resolved: true, targetComponent: 'Data' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        properties: expect.objectContaining({ receiver: 'data', function: 'SaveOrder', resolved: true, targetComponent: 'Data', declaresVerified: true }),
      }),
    ]));
    // stdlib import must stay unresolved
    expect(linked.edges.some(e => e.kind === 'imports' && e.properties?.specifier === 'fmt' && e.properties?.resolved === true)).toBe(false);
  });

  it('resolves Rust crate:: imports/calls and leaves super:: and external crates unresolved', () => {
    const root = tempDir('rust');
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "orders"\nversion = "0.1.0"\n\n[dependencies]\n');
    mkdirSync(join(root, 'src', 'orders'), { recursive: true });
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    const serviceFile = join(root, 'src', 'orders', 'service.rs');
    const storeFile = join(root, 'src', 'data', 'store.rs');
    writeFileSync(serviceFile, [
      'use crate::data::store;',
      'use super::utils;',
      'use sqlx::PgPool;',
      '',
      'fn place() {',
      '    store::save_order();',
      '}',
      '',
    ].join('\n'));
    writeFileSync(storeFile, 'pub fn save_order() {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "src/orders/**/*.rs" }
      component Data { runs_on: n paths: "src/data/**/*.rs" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([serviceFile], 'Orders'),
      extractTreeSitterIrForFiles([storeFile], 'Data'),
    ]);

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    expect(linked.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        properties: expect.objectContaining({ specifier: 'crate::data::store', resolved: true, targetComponent: 'Data' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        properties: expect.objectContaining({ receiver: 'store', function: 'save_order', resolved: true, targetComponent: 'Data' }),
      }),
    ]));
    expect(linked.edges.some(e => e.kind === 'imports' && e.properties?.specifier === 'super::utils' && e.properties?.resolved === true)).toBe(false);
    expect(linked.edges.some(e => e.kind === 'imports' && e.properties?.specifier === 'sqlx::PgPool' && e.properties?.resolved === true)).toBe(false);
  });

  it('resolves a Python relative from-import via the actually-bound name, not the module path', () => {
    const root = tempDir('python');
    mkdirSync(join(root, 'mypkg', 'orders'), { recursive: true });
    mkdirSync(join(root, 'mypkg', 'data'), { recursive: true });
    writeFileSync(join(root, 'mypkg', '__init__.py'), '');
    writeFileSync(join(root, 'mypkg', 'orders', '__init__.py'), '');
    writeFileSync(join(root, 'mypkg', 'data', '__init__.py'), '');
    const serviceFile = join(root, 'mypkg', 'orders', 'service.py');
    const storeFile = join(root, 'mypkg', 'data', 'store.py');
    writeFileSync(serviceFile, [
      'from ..data import store',
      'import os',
      '',
      'def place():',
      '    store.save_order()',
      '',
    ].join('\n'));
    writeFileSync(storeFile, 'def save_order():\n    pass\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "mypkg/orders/**/*.py" }
      component Data { runs_on: n paths: "mypkg/data/**/*.py" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([serviceFile], 'Orders'),
      extractTreeSitterIrForFiles([storeFile], 'Data'),
    ]);

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    expect(linked.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        properties: expect.objectContaining({ specifier: '..data', resolved: true, targetComponent: 'Data' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        properties: expect.objectContaining({ receiver: 'store', function: 'save_order', resolved: true, targetComponent: 'Data' }),
      }),
    ]));
    expect(linked.edges.some(e => e.kind === 'imports' && e.properties?.specifier === 'os' && e.properties?.resolved === true)).toBe(false);
  });

  it('resolves a Java single-class import/call and resolves a wildcard import to its package directory only', () => {
    const root = tempDir('java');
    const srcRoot = join(root, 'src', 'main', 'java');
    mkdirSync(join(srcRoot, 'com', 'acme', 'orders'), { recursive: true });
    mkdirSync(join(srcRoot, 'com', 'acme', 'data'), { recursive: true });
    const serviceFile = join(srcRoot, 'com', 'acme', 'orders', 'OrderService.java');
    const repoFile = join(srcRoot, 'com', 'acme', 'data', 'OrderRepository.java');
    writeFileSync(serviceFile, [
      'package com.acme.orders;',
      '',
      'import com.acme.data.OrderRepository;',
      'import com.acme.data.*;',
      '',
      'class OrderService {',
      '  void place() {',
      '    OrderRepository.create();',
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFileSync(repoFile, [
      'package com.acme.data;',
      '',
      'class OrderRepository {',
      '  static void create() {}',
      '}',
      '',
    ].join('\n'));

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "src/main/java/com/acme/orders/**/*.java" }
      component Data { runs_on: n paths: "src/main/java/com/acme/data/**/*.java" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([serviceFile], 'Orders'),
      extractTreeSitterIrForFiles([repoFile], 'Data'),
    ]);

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    expect(linked.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        properties: expect.objectContaining({ specifier: 'com.acme.data.OrderRepository', resolved: true, targetComponent: 'Data' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        properties: expect.objectContaining({ receiver: 'OrderRepository', function: 'create', resolved: true, targetComponent: 'Data' }),
      }),
    ]));
    // Wildcard imports have no representative targetFile, so componentForFile's directory-only
    // match fails against typical "**/*.java" globs — documented limitation, not a crash.
    const wildcardImport = linked.edges.find(e => e.kind === 'imports' && e.properties?.specifier === 'com.acme.data');
    expect(wildcardImport?.properties?.targetFile).toBeUndefined();
    expect(wildcardImport?.properties?.resolved).toBeUndefined();
  });

  it('does not resolve instance-variable-mediated calls (documented limitation, all languages)', () => {
    const root = tempDir('go-instance');
    writeFileSync(join(root, 'go.mod'), 'module github.com/acme/orders\n\ngo 1.21\n');
    mkdirSync(join(root, 'internal', 'orders'), { recursive: true });
    mkdirSync(join(root, 'internal', 'data'), { recursive: true });
    const serviceFile = join(root, 'internal', 'orders', 'service.go');
    const storeFile = join(root, 'internal', 'data', 'store.go');
    writeFileSync(serviceFile, [
      'package orders',
      '',
      'import "github.com/acme/orders/internal/data"',
      '',
      'func Place() {',
      '\trepo := data.NewRepository()',
      '\trepo.Save()',
      '}',
      '',
    ].join('\n'));
    writeFileSync(storeFile, 'package data\n\nfunc NewRepository() {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "internal/orders/**/*.go" }
      component Data { runs_on: n paths: "internal/data/**/*.go" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([serviceFile], 'Orders'),
      extractTreeSitterIrForFiles([storeFile], 'Data'),
    ]);

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    const instanceCall = linked.edges.find(e => e.kind === 'calls' && e.properties?.receiver === 'repo' && e.properties?.function === 'Save');
    expect(instanceCall?.properties?.resolved).toBeUndefined();
  });

  it('resolves a Swift cross-target SPM import and call', () => {
    const root = tempDir('swift');
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Orders", targets: [.target(name: "Orders"), .target(name: "DataKit")])\n');
    mkdirSync(join(root, 'Sources', 'Orders'), { recursive: true });
    mkdirSync(join(root, 'Sources', 'DataKit'), { recursive: true });
    const serviceFile = join(root, 'Sources', 'Orders', 'Service.swift');
    const storeFile = join(root, 'Sources', 'DataKit', 'Store.swift');
    writeFileSync(serviceFile, [
      'import DataKit',
      '',
      'class OrderService {',
      '  func place() {',
      '    DataKit.save()',
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFileSync(storeFile, 'func save() {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "Sources/Orders/**/*.swift" }
      component Data { runs_on: n paths: "Sources/DataKit/**/*.swift" }
    `);
    const graph = mergeAgIrGraphs([
      extractTreeSitterIrForFiles([serviceFile], 'Orders'),
      extractTreeSitterIrForFiles([storeFile], 'Data'),
    ]);

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    expect(linked.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        properties: expect.objectContaining({ specifier: 'DataKit', resolved: true, targetComponent: 'Data' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        properties: expect.objectContaining({ receiver: 'DataKit', function: 'save', resolved: true, targetComponent: 'Data' }),
      }),
    ]));
  });

  it('does not resolve a Swift import without a Package.swift (no SPM project)', () => {
    const root = tempDir('swift-no-spm');
    mkdirSync(join(root, 'Sources', 'Orders'), { recursive: true });
    mkdirSync(join(root, 'Sources', 'DataKit'), { recursive: true });
    const serviceFile = join(root, 'Sources', 'Orders', 'Service.swift');
    writeFileSync(serviceFile, 'import DataKit\nfunc place() { DataKit.save() }\n');
    writeFileSync(join(root, 'Sources', 'DataKit', 'Store.swift'), 'func save() {}\n');

    const artifact = compileSpec(`
      node n : agent_runtime { trust: trusted }
      component Orders { runs_on: n paths: "Sources/Orders/**/*.swift" }
      component Data { runs_on: n paths: "Sources/DataKit/**/*.swift" }
    `);
    const graph = extractTreeSitterIrForFiles([serviceFile], 'Orders');

    const linked = enrichAgIrWithCrossFileLinks(graph, artifact, root);

    expect(linked.edges.some(e => e.kind === 'imports' && e.properties?.specifier === 'DataKit' && e.properties?.resolved === true)).toBe(false);
  });
});
