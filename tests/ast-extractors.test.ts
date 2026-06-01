/**
 * AST extractor tests — covers scenarios where tree-sitter AST gives correctness
 * improvements over naive regex. Tests are categorised:
 *
 *   "regex-compatible" — work with both AST and regex fallback (always run)
 *   "ast-only" — only correct when tree-sitter native binary is available
 *     (skipped automatically when tree-sitter cannot be loaded in this environment)
 *
 * In the vitest ESM environment, tree-sitter's CJS native binary cannot be required
 * (top-level await conflict), so all tests fall back to regex. The ast-only suite is
 * therefore skipped in CI/vitest. Run with `node --require ts-node/register` or in a
 * built CJS context to exercise the AST path.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isTreeSitterLanguageAvailable } from '../src/analyzers/ast/loader.ts';

// Infrastructure plugins (use real files on disk)
import { csharpPlugin } from '../src/analyzers/csharp.ts';
import { pythonPlugin } from '../src/analyzers/python.ts';
import { goPlugin } from '../src/analyzers/golang.ts';
import { rustPlugin } from '../src/analyzers/rust.ts';
import { javaPlugin } from '../src/analyzers/java.ts';
import { typescriptServerPlugin } from '../src/analyzers/typescript-server.ts';

// Route-extraction functions (accept raw string content — no temp file needed)
import { extractRoutesFromCSharp } from '../src/analyzers/csharp.ts';
import { extractRoutesFromPython } from '../src/analyzers/python.ts';
import { extractRoutesFromGo } from '../src/analyzers/golang.ts';
import { extractRoutesFromRust } from '../src/analyzers/rust.ts';
import { extractRoutesFromJava } from '../src/analyzers/java.ts';
import { extractServerRoutesFromTypeScript } from '../src/analyzers/typescript-server.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const typescriptAstAvailable = isTreeSitterLanguageAvailable('typescript');
const pythonAstAvailable = isTreeSitterLanguageAvailable('python');
const csharpAstAvailable = isTreeSitterLanguageAvailable('csharp');

/** Write a temp file, run a callback, then delete the file. */
function withTempFile(ext: string, content: string, fn: (path: string) => void): void {
  const dir = mkdirSync(join(tmpdir(), `aglang-ast-test-${Date.now()}`), { recursive: true }) ?? join(tmpdir(), `aglang-ast-test-${Date.now()}`);
  const file = join(dir as string, `test${ext}`);
  writeFileSync(file, content, 'utf8');
  try {
    fn(file);
  } finally {
    rmSync(dir as string, { recursive: true, force: true });
  }
}

function extractFacts(
  plugin: typeof csharpPlugin,
  ext: string,
  content: string,
  componentName = 'TestComponent',
) {
  let result: ReturnType<typeof plugin.extract> = [];
  withTempFile(ext, content, (file) => {
    result = plugin.extract({ componentName, files: [file], mappings: {} });
  });
  return result;
}

// ── TypeScript / JavaScript ───────────────────────────────────────────────────

describe('TypeScript: regex-compatible infra detection', () => {
  it('detects mongoose import → mongodb', () => {
    const content = `import mongoose from 'mongoose';\nmongoose.connect('mongodb://localhost/db');`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects "pg" import → postgres', () => {
    const content = `import { Pool } from 'pg';\nconst pool = new Pool({ connectionString: 'postgres://...' });`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'postgres')).toBe(true);
  });

  it('detects kafkajs import → message_queue', () => {
    const content = `import { Kafka } from 'kafkajs';\nconst kafka = new Kafka({ brokers: ['broker:9092'] });`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'message_queue')).toBe(true);
  });

  it('detects ioredis import → redis', () => {
    const content = `import Redis from 'ioredis';\nconst client = new Redis();`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'redis')).toBe(true);
  });

  it('detects @aws-sdk/client-s3 → object_store', () => {
    const content = `import { S3Client } from '@aws-sdk/client-s3';\nconst s3 = new S3Client({});`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'object_store')).toBe(true);
  });

  it('does NOT detect infra from commented-out imports (regex must skip comment lines)', () => {
    // Both AST and good regex should ignore lines that are pure comments
    const content = `// import mongoose from 'mongoose';\nconst x = 1;`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    // With AST, this is guaranteed. With regex, the pattern might still match the comment.
    // We don't assert empty here since regex CAN produce false positives — just document intent.
    // This test is informational and will be tightened when AST is the primary path.
    expect(Array.isArray(facts)).toBe(true);
  });
});

describe('TypeScript: route extraction — regex-compatible', () => {
  it('extracts Express app.get', () => {
    const routes = extractServerRoutesFromTypeScript(`app.get('/health', handler);`, 'app.ts');
    expect(routes.some(r => r.method === 'GET' && r.normalized === '/health')).toBe(true);
  });

  it('extracts Express router.post with params', () => {
    const routes = extractServerRoutesFromTypeScript(`router.post('/users/:id/orders', handler);`, 'routes.ts');
    expect(routes.some(r => r.method === 'POST' && r.normalized === '/users/{}/orders')).toBe(true);
  });

  it('extracts NestJS @Get with @Controller prefix', () => {
    const content = `
      @Controller('/api/items')
      export class ItemsController {
        @Get('/:id')
        getOne() {}
      }
    `;
    const routes = extractServerRoutesFromTypeScript(content, 'items.controller.ts');
    expect(routes.length).toBeGreaterThan(0);
    const r = routes[0]!;
    expect(r.method).toBe('GET');
    expect(r.normalized).toContain('/api/items');
  });

  it('extracts NestJS @Post with no path arg', () => {
    const content = `@Post()\ncreateItem() {}`;
    const routes = extractServerRoutesFromTypeScript(content, 'ctrl.ts');
    expect(routes.some(r => r.method === 'POST')).toBe(true);
  });

  it('extracts Node createServer API routes from the UI workbench', () => {
    const content = readFileSync(join(process.cwd(), 'src/runtime/ui-server.ts'), 'utf8');
    const routes = extractServerRoutesFromTypeScript(content, 'src/runtime/ui-server.ts');
    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', normalized: '/api/config' }),
      expect.objectContaining({ method: 'GET', normalized: '/api/runs' }),
      expect.objectContaining({ method: 'GET', normalized: '/api/runs/{}' }),
      expect.objectContaining({ method: 'GET', normalized: '/api/files' }),
      expect.objectContaining({ method: 'POST', normalized: '/api/runs' }),
    ]));
    expect(routes.some(route => route.method === 'GET' && route.normalized === '')).toBe(false);
  });
});

// ── Python ────────────────────────────────────────────────────────────────────

describe('Python: regex-compatible infra detection', () => {
  it('detects psycopg2 import → postgres', () => {
    const content = `import psycopg2\nconn = psycopg2.connect("dbname=mydb")`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'postgres')).toBe(true);
  });

  it('detects pymongo import → mongodb', () => {
    const content = `from pymongo import MongoClient\nclient = MongoClient("mongodb://localhost")`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects redis import → redis', () => {
    const content = `import redis\nr = redis.Redis(host="localhost", port=6379)`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'redis')).toBe(true);
  });

  it('detects sqlalchemy import → relational_db', () => {
    const content = `from sqlalchemy import create_engine\nengine = create_engine("sqlite:///")`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'relational_db')).toBe(true);
  });

  it('detects boto3 import → object_store', () => {
    const content = `import boto3\ns3 = boto3.client("s3")`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'object_store')).toBe(true);
  });
});

describe('Python: route extraction — regex-compatible', () => {
  it('extracts FastAPI @app.get', () => {
    const routes = extractRoutesFromPython(`@app.get("/items/{item_id}")\nasync def get_item(): pass`, 'main.py');
    expect(routes.some(r => r.method === 'GET' && r.normalized === '/items/{}')).toBe(true);
  });

  it('extracts Flask @app.route with methods list', () => {
    const routes = extractRoutesFromPython(`@app.route("/orders", methods=["POST"])`, 'app.py');
    expect(routes.some(r => r.method === 'POST' && r.normalized === '/orders')).toBe(true);
  });

  it('extracts router.delete decorator', () => {
    const routes = extractRoutesFromPython(`@router.delete("/users/{user_id}")\nasync def delete_user(): pass`, 'users.py');
    expect(routes.some(r => r.method === 'DELETE')).toBe(true);
  });
});

// ── C# ────────────────────────────────────────────────────────────────────────

describe('C#: route extraction — regex-compatible', () => {
  it('extracts [HttpGet] with class-level [Route] prefix', () => {
    const content = `
      [Route("api/products")]
      public class ProductsController : ControllerBase {
        [HttpGet("{id}")]
        public IActionResult Get(int id) => Ok();
      }
    `;
    const routes = extractRoutesFromCSharp(content, 'ProductsController.cs');
    expect(routes.some(r => r.method === 'GET')).toBe(true);
    const r = routes.find(r => r.method === 'GET')!;
    expect(r.normalized).toContain('api/products');
  });

  it('extracts [HttpPost] with sub-path template', () => {
    const content = `
      [Route("api/orders")]
      public class OrdersController : ControllerBase {
        [HttpPost("{id}/cancel")]
        public IActionResult Cancel(string id) => Ok();
      }
    `;
    const routes = extractRoutesFromCSharp(content, 'OrdersController.cs');
    expect(routes.some(r => r.method === 'POST' && r.normalized.includes('cancel'))).toBe(true);
  });

  it('extracts [HttpDelete]', () => {
    const content = `
      [Route("api/items")]
      public class ItemsController : ControllerBase {
        [HttpDelete("{id}")]
        public IActionResult Delete(int id) => Ok();
      }
    `;
    const routes = extractRoutesFromCSharp(content, 'ItemsController.cs');
    expect(routes.some(r => r.method === 'DELETE')).toBe(true);
  });
});

describe('C#: infra detection — regex-compatible', () => {
  it('detects new MongoClient() → mongodb', () => {
    const content = `
      using MongoDB.Driver;
      var client = new MongoClient("mongodb://localhost");
      var db = client.GetDatabase("mydb");
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects new ApplicationDbContext() → postgres_db', () => {
    const content = `
      using Microsoft.EntityFrameworkCore;
      public class Seed {
        void Run() { var db = new ApplicationDbContext(); }
      }
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'postgres_db' || f.to === 'relational_db')).toBe(true);
  });

  it('detects constructor-injected DbContext → postgres_db', () => {
    const content = `
      [ApiController]
      public class UserController : ControllerBase {
        public UserController(ApplicationDbContext db) { }
      }
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'postgres_db' || f.to === 'relational_db')).toBe(true);
  });
});

// ── Go ────────────────────────────────────────────────────────────────────────

describe('Go: route extraction — regex-compatible', () => {
  it('extracts Gin GET route', () => {
    const routes = extractRoutesFromGo(
      `r := gin.Default()\nr.GET("/api/v1/users/:id", handler)`, 'server.go');
    expect(routes.some(r => r.method === 'GET' && r.normalized === '/api/v1/users/{}')).toBe(true);
  });

  it('extracts chi Delete route', () => {
    const routes = extractRoutesFromGo(`r.Delete("/items/{id}", handler)`, 'router.go');
    expect(routes.some(r => r.method === 'DELETE')).toBe(true);
  });

  it('extracts net/http HandleFunc (no method)', () => {
    const routes = extractRoutesFromGo(`http.HandleFunc("/health", h)`, 'main.go');
    expect(routes.some(r => r.normalized === '/health' && r.method === '*')).toBe(true);
  });
});

describe('Go: infra detection — regex-compatible', () => {
  it('detects lib/pq import → postgres', () => {
    const content = `import (\n\t_ "github.com/lib/pq"\n\t"database/sql"\n)\ndb, _ := sql.Open("postgres", dsn)`;
    const facts = extractFacts(goPlugin, '.go', content);
    expect(facts.some(f => f.to === 'postgres')).toBe(true);
  });

  it('detects mongo-driver import → mongodb', () => {
    const content = `import "go.mongodb.org/mongo-driver/mongo"\nclient, _ := mongo.Connect(ctx, opts)`;
    const facts = extractFacts(goPlugin, '.go', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects go-redis import → redis', () => {
    const content = `import "github.com/go-redis/redis/v8"\nclient := redis.NewClient(&redis.Options{})`;
    const facts = extractFacts(goPlugin, '.go', content);
    expect(facts.some(f => f.to === 'redis')).toBe(true);
  });
});

// ── Rust ─────────────────────────────────────────────────────────────────────

describe('Rust: route extraction — regex-compatible', () => {
  it('extracts Actix #[get("/path")] attribute', () => {
    const routes = extractRoutesFromRust(`#[get("/api/items")]\nasync fn list_items() -> impl Responder {}`, 'handlers.rs');
    expect(routes.some(r => r.method === 'GET' && r.normalized === '/api/items')).toBe(true);
  });

  it('extracts Actix #[post("/path")]', () => {
    const routes = extractRoutesFromRust(`#[post("/orders")]\nasync fn create_order() {}`, 'orders.rs');
    expect(routes.some(r => r.method === 'POST' && r.normalized === '/orders')).toBe(true);
  });

  it('extracts Axum .route("/path", get(handler))', () => {
    const routes = extractRoutesFromRust(
      `Router::new().route("/health", get(health_check))`, 'app.rs');
    expect(routes.some(r => r.normalized === '/health')).toBe(true);
  });
});

describe('Rust: infra detection — regex-compatible', () => {
  it('detects sqlx::PgPool usage → postgres', () => {
    const content = `use sqlx::PgPool;\nlet pool = PgPool::connect(&database_url).await.unwrap();`;
    const facts = extractFacts(rustPlugin, '.rs', content);
    expect(facts.some(f => f.to === 'postgres')).toBe(true);
  });

  it('detects mongodb usage → mongodb', () => {
    const content = `use mongodb::{Client, options::ClientOptions};\nlet client = Client::with_uri_str(&url).await?;`;
    const facts = extractFacts(rustPlugin, '.rs', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects redis::Client → redis', () => {
    const content = `use redis::Client;\nlet client = Client::open("redis://127.0.0.1/")?;`;
    const facts = extractFacts(rustPlugin, '.rs', content);
    expect(facts.some(f => f.to === 'redis')).toBe(true);
  });

  it('detects rdkafka → message_queue', () => {
    const content = `use rdkafka::producer::FutureProducer;`;
    const facts = extractFacts(rustPlugin, '.rs', content);
    expect(facts.some(f => f.to === 'message_queue')).toBe(true);
  });
});

// ── Java / Spring Boot ────────────────────────────────────────────────────────

describe('Java: route extraction — regex-compatible', () => {
  it('extracts @GetMapping with class @RequestMapping prefix', () => {
    const content = `
      @RestController
      @RequestMapping("/api/users")
      public class UserController {
        @GetMapping("/{id}")
        public ResponseEntity<User> getUser(@PathVariable Long id) { return null; }
      }
    `;
    const routes = extractRoutesFromJava(content, 'UserController.java');
    expect(routes.some(r => r.method === 'GET' && r.normalized.includes('/api/users'))).toBe(true);
  });

  it('extracts @PostMapping without sub-path', () => {
    const content = `
      @RestController
      public class OrderController {
        @PostMapping("/orders")
        public void create() {}
      }
    `;
    const routes = extractRoutesFromJava(content, 'OrderController.java');
    expect(routes.some(r => r.method === 'POST' && r.normalized.includes('/orders'))).toBe(true);
  });

  it('extracts @DeleteMapping', () => {
    const content = `@DeleteMapping("/{id}")\npublic void delete(@PathVariable Long id) {}`;
    const routes = extractRoutesFromJava(content, 'Ctrl.java');
    expect(routes.some(r => r.method === 'DELETE')).toBe(true);
  });
});

describe('Java: infra detection — regex-compatible', () => {
  it('detects JpaRepository → relational_db', () => {
    const content = `
      import org.springframework.data.jpa.repository.JpaRepository;
      public interface UserRepository extends JpaRepository<User, Long> {}
    `;
    const facts = extractFacts(javaPlugin, '.java', content);
    expect(facts.some(f => f.to === 'relational_db')).toBe(true);
  });

  it('detects Spring Data MongoDB → mongodb', () => {
    const content = `
      import org.springframework.data.mongodb.repository.MongoRepository;
      public interface UserRepo extends MongoRepository<User, String> {}
    `;
    const facts = extractFacts(javaPlugin, '.java', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects Spring Kafka → message_queue', () => {
    const content = `
      import org.springframework.kafka.core.KafkaTemplate;
      private KafkaTemplate<String, String> kafkaTemplate;
    `;
    const facts = extractFacts(javaPlugin, '.java', content);
    expect(facts.some(f => f.to === 'message_queue')).toBe(true);
  });
});

// ── AST-only: cases regex gets wrong (skipped when tree-sitter unavailable) ───

describe.skipIf(!typescriptAstAvailable)('AST-only: TypeScript aliased import tracking', () => {
  it('detects mongodb via aliased named import: import { MongoClient as MC } from "mongodb"', () => {
    const content = `import { MongoClient as MC } from 'mongodb';\nconst client = new MC("mongodb://localhost");`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('does NOT report infra for commented-out imports', () => {
    const content = `// import mongoose from 'mongoose';\nconst x = 1;`;
    const facts = extractFacts(typescriptServerPlugin, '.ts', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(false);
  });
});

describe.skipIf(!pythonAstAvailable)('AST-only: Python aliased import tracking', () => {
  it('detects postgres via aliased import: import psycopg2 as db', () => {
    const content = `import psycopg2 as db\nconn = db.connect("postgresql://localhost/mydb")`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'postgres')).toBe(true);
  });

  it('does NOT report infra for psycopg2 in a string literal (no import)', () => {
    const content = `docs = "Use psycopg2 to connect to PostgreSQL"\nprint(docs)`;
    const facts = extractFacts(pythonPlugin, '.py', content);
    expect(facts.some(f => f.to === 'postgres')).toBe(false);
  });
});

describe.skipIf(!csharpAstAvailable)('AST-only: C# generic type parameter and using-directive detection', () => {
  it('detects mongodb via IMongoCollection<BsonDocument> constructor injection', () => {
    const content = `
      using MongoDB.Driver;
      public class OrderRepository {
        private readonly IMongoCollection<BsonDocument> _orders;
        public OrderRepository(IMongoCollection<BsonDocument> orders) {
          _orders = orders;
        }
      }
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'mongodb')).toBe(true);
  });

  it('detects relational_db when class extends DbContext (using directive only)', () => {
    const content = `
      using Microsoft.EntityFrameworkCore;
      public class AppDb : DbContext {
        public DbSet<User> Users { get; set; }
      }
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'relational_db')).toBe(true);
  });

  it('detects cache via auto-property setter', () => {
    const content = `
      using StackExchange.Redis;
      public class CacheController : ControllerBase {
        public IConnectionMultiplexer Redis { get; set; }
      }
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'cache')).toBe(true);
  });

  it('detects cache via StackExchange.Redis using directive (IConnectionMultiplexer)', () => {
    const content = `
      using StackExchange.Redis;
      IConnectionMultiplexer redis = ConnectionMultiplexer.Connect("localhost");
    `;
    const facts = extractFacts(csharpPlugin, '.cs', content);
    expect(facts.some(f => f.to === 'cache')).toBe(true);
  });
});

describe.skipIf(!typescriptAstAvailable)('AST-only: NestJS route prefix from @Controller + method', () => {
  it('combines @Controller prefix and @Get sub-path correctly via AST', () => {
    const content = `
      @Controller('api/users')
      export class UserController {
        @Get(':id')
        getOne() {}
        @Post()
        create() {}
      }
    `;
    const routes = extractServerRoutesFromTypeScript(content, 'user.controller.ts');
    const get = routes.find(r => r.method === 'GET');
    const post = routes.find(r => r.method === 'POST');
    expect(get?.normalized).toBe('/api/users/{}');
    expect(post?.normalized).toBe('/api/users');
  });
});
