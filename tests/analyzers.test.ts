import { describe, it, expect } from 'vitest';
import { normalizeRoute, extractRoutesFromTypeScript } from '../src/analyzers/typescript.ts';
import { extractRoutesFromCSharp } from '../src/analyzers/csharp.ts';

// ── Route normalization ─────────────────────────────────────────
describe('normalizeRoute', () => {
  it('normalizes TypeScript template literal params', () => {
    expect(normalizeRoute('/api/products/${productId}/sessions')).toBe('/api/products/{}/sessions');
  });

  it('normalizes C# route attribute params', () => {
    expect(normalizeRoute('/api/products/{productId:guid}/sessions')).toBe('/api/products/{}/sessions');
  });

  it('normalizes contract style params', () => {
    expect(normalizeRoute('/api/products/{productId}/sessions')).toBe('/api/products/{}/sessions');
  });

  it('is idempotent on already-normalized routes', () => {
    const n = '/api/products/{}/sessions';
    expect(normalizeRoute(n)).toBe(n);
  });

  it('lowercases the path', () => {
    expect(normalizeRoute('/API/Users')).toBe('/api/users');
  });

  it('strips trailing slashes', () => {
    expect(normalizeRoute('/api/items/')).toBe('/api/items');
  });
});

// ── TypeScript fetch extractor ─────────────────────────────────
describe('extractRoutesFromTypeScript', () => {
  it('extracts GET from fetch()', () => {
    const code = `fetch('/api/items', { method: 'GET' })`;
    const routes = extractRoutesFromTypeScript(code, 'api-client.ts');
    expect(routes.some(r => r.method === 'GET' && r.path === '/api/items')).toBe(true);
  });

  it('defaults to GET when no method specified', () => {
    const code = `fetch('/api/users')`;
    const routes = extractRoutesFromTypeScript(code, 'api-client.ts');
    expect(routes.some(r => r.method === 'GET' && r.path === '/api/users')).toBe(true);
  });

  it('extracts POST', () => {
    const code = `fetch('/api/orders', { method: 'POST', body: JSON.stringify(data) })`;
    const routes = extractRoutesFromTypeScript(code, 'client.ts');
    expect(routes.some(r => r.method === 'POST' && r.path === '/api/orders')).toBe(true);
  });

  it('normalizes template literal paths in fetch calls', () => {
    const code = `fetch(\`/api/products/\${productId}/sessions\`)`;
    const routes = extractRoutesFromTypeScript(code, 'client.ts');
    expect(routes.some(r => r.normalized === '/api/products/{}/sessions')).toBe(true);
  });

  it('returns empty for non-fetch code', () => {
    const code = `const x = 42; console.log(x);`;
    const routes = extractRoutesFromTypeScript(code, 'utils.ts');
    expect(routes).toHaveLength(0);
  });
});

// ── C# route extractor ─────────────────────────────────────────
describe('extractRoutesFromCSharp', () => {
  it('extracts [HttpGet] routes', () => {
    const code = `
      [ApiController]
      [Route("api/items")]
      public class ItemsController : ControllerBase {
        [HttpGet]
        public IActionResult GetAll() => Ok();
      }
    `;
    const routes = extractRoutesFromCSharp(code, 'ItemsController.cs');
    expect(routes.some(r => r.method === 'GET')).toBe(true);
  });

  it('extracts [HttpPost] routes with template', () => {
    const code = `
      [Route("api/orders")]
      public class OrdersController : ControllerBase {
        [HttpPost("{id}")]
        public IActionResult Create(string id) => Ok();
      }
    `;
    const routes = extractRoutesFromCSharp(code, 'OrdersController.cs');
    expect(routes.some(r => r.method === 'POST')).toBe(true);
  });
});
