import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readGoModuleName, resolveGoSpecifier,
  readCargoPackageName, resolveRustSpecifier,
  resolvePythonSpecifier,
  resolveJavaSpecifier,
  resolveSwiftSpecifier,
} from '../src/ir/specifier-resolvers.ts';

describe('specifier-resolvers', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempProject(name: string): string {
    const dir = join(tmpdir(), `aglang-resolvers-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  describe('Go', () => {
    it('parses the full module path from go.mod', () => {
      const root = tempProject('go-mod');
      writeFileSync(join(root, 'go.mod'), 'module github.com/acme/orders\n\ngo 1.21\n');
      expect(readGoModuleName(root)).toBe('github.com/acme/orders');
    });

    it('resolves a subpackage specifier to its directory and a representative .go file', () => {
      const root = tempProject('go-resolve');
      mkdirSync(join(root, 'internal', 'data'), { recursive: true });
      writeFileSync(join(root, 'internal', 'data', 'store.go'), 'package data\n');
      writeFileSync(join(root, 'internal', 'data', 'store_test.go'), 'package data\n');

      const resolved = resolveGoSpecifier('github.com/acme/orders/internal/data', root, 'github.com/acme/orders');

      expect(resolved?.componentPath).toBe(join(root, 'internal', 'data'));
      expect(resolved?.targetFile).toBe(join(root, 'internal', 'data', 'store.go'));
    });

    it('returns undefined for external/stdlib packages', () => {
      const root = tempProject('go-external');
      expect(resolveGoSpecifier('fmt', root, 'github.com/acme/orders')).toBeUndefined();
      expect(resolveGoSpecifier('github.com/lib/pq', root, 'github.com/acme/orders')).toBeUndefined();
    });
  });

  describe('Rust', () => {
    it('parses the package name from Cargo.toml', () => {
      const root = tempProject('cargo');
      writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "orders"\nversion = "0.1.0"\n\n[dependencies]\n');
      expect(readCargoPackageName(root)).toBe('orders');
    });

    it('resolves crate:: and bare-crate-name specifiers to a file or mod.rs', () => {
      const root = tempProject('rust-resolve');
      mkdirSync(join(root, 'src', 'data'), { recursive: true });
      writeFileSync(join(root, 'src', 'data', 'store.rs'), 'pub fn save() {}\n');
      mkdirSync(join(root, 'src', 'shared'), { recursive: true });
      writeFileSync(join(root, 'src', 'shared', 'mod.rs'), 'pub fn util() {}\n');

      const viaCrate = resolveRustSpecifier('crate::data::store', root, 'orders');
      expect(viaCrate?.targetFile).toBe(join(root, 'src', 'data', 'store.rs'));

      const viaBareName = resolveRustSpecifier('orders::shared', root, 'orders');
      expect(viaBareName?.targetFile).toBe(join(root, 'src', 'shared', 'mod.rs'));
    });

    it('returns undefined for super::/self:: and external crates', () => {
      const root = tempProject('rust-external');
      expect(resolveRustSpecifier('super::utils', root, 'orders')).toBeUndefined();
      expect(resolveRustSpecifier('self::helpers', root, 'orders')).toBeUndefined();
      expect(resolveRustSpecifier('sqlx::PgPool', root, 'orders')).toBeUndefined();
    });
  });

  describe('Python', () => {
    it('resolves an absolute dotted import via the detected package root', () => {
      const root = tempProject('py-absolute');
      mkdirSync(join(root, 'mypkg', 'data'), { recursive: true });
      writeFileSync(join(root, 'mypkg', '__init__.py'), '');
      writeFileSync(join(root, 'mypkg', 'data', '__init__.py'), '');
      writeFileSync(join(root, 'mypkg', 'data', 'store.py'), 'def save(): pass\n');
      const importer = join(root, 'mypkg', 'api', 'handler.py');
      mkdirSync(join(root, 'mypkg', 'api'), { recursive: true });
      writeFileSync(join(root, 'mypkg', 'api', '__init__.py'), '');
      writeFileSync(importer, '');

      const resolved = resolvePythonSpecifier(importer, 'mypkg.data.store', root);

      expect(resolved?.targetFile).toBe(join(root, 'mypkg', 'data', 'store.py'));
    });

    it('resolves relative imports (single and double dot) relative to the importing file', () => {
      const root = tempProject('py-relative');
      mkdirSync(join(root, 'mypkg', 'data'), { recursive: true });
      mkdirSync(join(root, 'mypkg', 'shared'), { recursive: true });
      writeFileSync(join(root, 'mypkg', 'data', 'store.py'), 'def save(): pass\n');
      writeFileSync(join(root, 'mypkg', 'shared', 'util.py'), 'def helper(): pass\n');
      const importer = join(root, 'mypkg', 'data', 'handler.py');
      writeFileSync(importer, '');

      const sameDir = resolvePythonSpecifier(importer, '.store', root);
      expect(sameDir?.targetFile).toBe(join(root, 'mypkg', 'data', 'store.py'));

      const parentDir = resolvePythonSpecifier(importer, '..shared.util', root);
      expect(parentDir?.targetFile).toBe(join(root, 'mypkg', 'shared', 'util.py'));
    });

    it('returns undefined for external packages', () => {
      const root = tempProject('py-external');
      const importer = join(root, 'mypkg', 'handler.py');
      mkdirSync(join(root, 'mypkg'), { recursive: true });
      writeFileSync(importer, '');
      expect(resolvePythonSpecifier(importer, 'sqlalchemy', root)).toBeUndefined();
    });
  });

  describe('Java', () => {
    it('resolves a single-class import via package-declaration source-root detection', () => {
      const root = tempProject('java-resolve');
      const srcRoot = join(root, 'src', 'main', 'java');
      mkdirSync(join(srcRoot, 'com', 'acme', 'orders'), { recursive: true });
      mkdirSync(join(srcRoot, 'com', 'acme', 'data'), { recursive: true });
      const importer = join(srcRoot, 'com', 'acme', 'orders', 'OrderService.java');
      writeFileSync(importer, 'package com.acme.orders;\nclass OrderService {}\n');
      writeFileSync(join(srcRoot, 'com', 'acme', 'data', 'OrderRepository.java'), 'package com.acme.data;\nclass OrderRepository {}\n');

      const resolved = resolveJavaSpecifier(importer, 'com.acme.data.OrderRepository');

      expect(resolved?.targetFile).toBe(join(srcRoot, 'com', 'acme', 'data', 'OrderRepository.java'));
    });

    it('resolves a wildcard-style package import to the directory, with no single targetFile', () => {
      const root = tempProject('java-wildcard');
      const srcRoot = join(root, 'src', 'main', 'java');
      mkdirSync(join(srcRoot, 'com', 'acme', 'orders'), { recursive: true });
      mkdirSync(join(srcRoot, 'com', 'acme', 'data'), { recursive: true });
      const importer = join(srcRoot, 'com', 'acme', 'orders', 'OrderService.java');
      writeFileSync(importer, 'package com.acme.orders;\nclass OrderService {}\n');
      writeFileSync(join(srcRoot, 'com', 'acme', 'data', 'OrderRepository.java'), 'package com.acme.data;\nclass OrderRepository {}\n');

      const resolved = resolveJavaSpecifier(importer, 'com.acme.data');

      expect(resolved?.componentPath).toBe(join(srcRoot, 'com', 'acme', 'data'));
      expect(resolved?.targetFile).toBeUndefined();
    });

    it('returns undefined when the package has no class file matching the specifier', () => {
      const root = tempProject('java-external');
      const srcRoot = join(root, 'src', 'main', 'java');
      mkdirSync(join(srcRoot, 'com', 'acme', 'orders'), { recursive: true });
      const importer = join(srcRoot, 'com', 'acme', 'orders', 'OrderService.java');
      writeFileSync(importer, 'package com.acme.orders;\nclass OrderService {}\n');

      expect(resolveJavaSpecifier(importer, 'org.springframework.data.jpa.repository.JpaRepository')).toBeUndefined();
    });
  });

  describe('Swift', () => {
    it('resolves a target name to its Sources/<Target>/ directory and a representative .swift file', () => {
      const root = tempProject('swift-resolve');
      writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Orders", targets: [.target(name: "DataKit")])\n');
      mkdirSync(join(root, 'Sources', 'DataKit'), { recursive: true });
      writeFileSync(join(root, 'Sources', 'DataKit', 'Store.swift'), 'public func save() {}\n');

      const resolved = resolveSwiftSpecifier('DataKit', root);

      expect(resolved?.componentPath).toBe(join(root, 'Sources', 'DataKit'));
      expect(resolved?.targetFile).toBe(join(root, 'Sources', 'DataKit', 'Store.swift'));
    });

    it('returns undefined without a Package.swift, and for a target that does not exist', () => {
      const root = tempProject('swift-no-package');
      mkdirSync(join(root, 'Sources', 'DataKit'), { recursive: true });
      writeFileSync(join(root, 'Sources', 'DataKit', 'Store.swift'), 'public func save() {}\n');
      expect(resolveSwiftSpecifier('DataKit', root)).toBeUndefined();

      writeFileSync(join(root, 'Package.swift'), 'let package = Package(name: "Orders")\n');
      expect(resolveSwiftSpecifier('Foundation', root)).toBeUndefined();
    });
  });
});
