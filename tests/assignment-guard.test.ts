import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pythonPlugin } from '../src/analyzers/python.ts';
import { goPlugin } from '../src/analyzers/golang.ts';
import { rustPlugin } from '../src/analyzers/rust.ts';
import { javaPlugin } from '../src/analyzers/java.ts';
import { swiftPlugin } from '../src/analyzers/swift.ts';
import type { ExtractorPlugin } from '../src/analyzers/plugin.ts';

describe('assignment-guard extraction (Python/Go/Rust/Java/Swift)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, ext: string, content: string): string {
    const dir = join(tmpdir(), `aglang-assign-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const file = join(dir, `service${ext}`);
    writeFileSync(file, content);
    return file;
  }

  async function assignmentFacts(plugin: ExtractorPlugin, file: string) {
    const facts = await plugin.extractGraph!({ componentName: 'Orders', files: [file], mappings: {} });
    return facts.filter(f => f.kind === 'assignment');
  }

  it('Python: detects a guarded transition and an unguarded one', async () => {
    const file = writeFixture('python', '.py', [
      'if order.status == OrderStatus.Draft:',
      '    order.status = OrderStatus.Active',
      '',
      'cart.status = CartStatus.Closed',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(pythonPlugin, file);

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ object: 'order', property: 'status', valueEnum: 'OrderStatus', valueMember: 'Active', previousMember: 'Draft' }) }),
      expect.objectContaining({ properties: expect.objectContaining({ object: 'cart', property: 'status', valueEnum: 'CartStatus', valueMember: 'Closed' }) }),
    ]));
    const unguarded = facts.find(f => f.properties?.valueMember === 'Closed');
    expect(unguarded?.properties?.previousMember).toBeUndefined();
  });

  it('Java: detects a guarded transition and an unrelated unguarded one', async () => {
    const file = writeFixture('java', '.java', [
      'class OrderService {',
      '  void place() {',
      '    if (order.status == OrderStatus.Draft) {',
      '      order.status = OrderStatus.Active;',
      '    }',
      '    cart.status = CartStatus.Closed;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(javaPlugin, file);

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ object: 'order', property: 'status', valueEnum: 'OrderStatus', valueMember: 'Active', previousMember: 'Draft' }) }),
      expect.objectContaining({ properties: expect.objectContaining({ object: 'cart', property: 'status', valueEnum: 'CartStatus', valueMember: 'Closed' }) }),
    ]));
    const unguarded = facts.find(f => f.properties?.valueMember === 'Closed');
    expect(unguarded?.properties?.previousMember).toBeUndefined();
  });

  it('Go: detects the qualified-constant form but not the bare-constant form (documented gap)', async () => {
    const file = writeFixture('go', '.go', [
      'package orders',
      '',
      'func Place() {',
      '\tif order.Status == data.Draft {',
      '\t\torder.Status = data.Active',
      '\t}',
      '\torder.Status = StatusArchived',
      '}',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(goPlugin, file);

    expect(facts).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ object: 'order', property: 'Status', valueEnum: 'data', valueMember: 'Active', previousMember: 'Draft' }) }),
    ]);
    expect(facts.some(f => f.properties?.valueMember === 'StatusArchived')).toBe(false);
  });

  it('Rust: requires the :: enum separator, not ., and distinguishes guarded from unrelated unguarded', async () => {
    const file = writeFixture('rust', '.rs', [
      'fn place() {',
      '    if order.status == Status::Draft {',
      '        order.status = Status::Active;',
      '    }',
      '    cart.status = CartStatus::Closed;',
      '}',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(rustPlugin, file);

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ object: 'order', property: 'status', valueEnum: 'Status', valueMember: 'Active', previousMember: 'Draft' }) }),
      expect.objectContaining({ properties: expect.objectContaining({ object: 'cart', property: 'status', valueEnum: 'CartStatus', valueMember: 'Closed' }) }),
    ]));
    const unguarded = facts.find(f => f.properties?.valueMember === 'Closed');
    expect(unguarded?.properties?.previousMember).toBeUndefined();
  });

  it('Rust: a dot-separated RHS (wrong separator for this language) is not matched', async () => {
    const file = writeFixture('rust-dot', '.rs', [
      'fn place() {',
      '    order.status = Status.Active;',
      '}',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(rustPlugin, file);

    expect(facts).toEqual([]);
  });

  it('Swift: detects the explicit EnumType.Member form, guarded and unrelated unguarded', async () => {
    const file = writeFixture('swift', '.swift', [
      'if order.status == OrderStatus.Draft {',
      '    order.status = OrderStatus.Active',
      '}',
      'cart.status = CartStatus.Closed',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(swiftPlugin, file);

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ object: 'order', property: 'status', valueEnum: 'OrderStatus', valueMember: 'Active', previousMember: 'Draft' }) }),
      expect.objectContaining({ properties: expect.objectContaining({ object: 'cart', property: 'status', valueEnum: 'CartStatus', valueMember: 'Closed' }) }),
    ]));
    const unguarded = facts.find(f => f.properties?.valueMember === 'Closed');
    expect(unguarded?.properties?.previousMember).toBeUndefined();
  });

  it('Swift: does NOT detect the type-inferred shorthand form (documented gap)', async () => {
    const file = writeFixture('swift-shorthand', '.swift', [
      'if order.status == OrderStatus.Draft {',
      '    order.status = .Active',
      '}',
      '',
    ].join('\n'));

    const facts = await assignmentFacts(swiftPlugin, file);

    expect(facts).toEqual([]);
  });
});
