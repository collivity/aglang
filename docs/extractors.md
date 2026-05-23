# Extractors

aglang ships with built-in extractors for 8 language ecosystems. Each extractor scans source files and extracts:

- **Routes** — HTTP endpoints, gRPC methods, queue consumers
- **Dependencies** — database clients, HTTP clients, SDK calls
- **Components** — service boundaries inferred from project manifests

## Supported languages

| Language | Manifest | What's extracted |
|----------|----------|-----------------|
| **TypeScript / JavaScript** | `package.json` | Express/Fastify/Hapi routes, fetch/axios calls, DB clients (pg, mysql2, mongoose, redis) |
| **C#** | `.csproj` | ASP.NET controllers + minimal API routes, `HttpClient`, EF Core, Dapper, Npgsql, MongoDB, Redis |
| **Python** | `pyproject.toml`, `requirements.txt`, `setup.py` | FastAPI/Flask/Django routes, SQLAlchemy, psycopg2, pymongo, redis-py |
| **Go** | `go.mod` | net/http + gorilla/mux + gin + echo + fiber handlers, database/sql, gorm, mongo-go-driver |
| **Rust** | `Cargo.toml` | Actix-web, Axum, Rocket handlers, diesel, sqlx, tokio-postgres |
| **Java / Kotlin (JVM)** | `build.gradle`, `pom.xml` | Spring MVC/Boot controllers, JDBC, JPA, MyBatis |
| **Swift** | `Package.swift`, `Podfile` | Vapor routes, URLSession, Alamofire, SPM module imports, UIKit MVVM + Combine Input/Output patterns, Keychain, UserDefaults |
| **Terraform** | `*.tf` | Infrastructure resources → `node` declarations (via `aglc import-tf`) |

## How extraction works

1. **Manifest discovery** — `aglc generate` finds project manifests recursively under `projectRoot`
2. **Language detection** — manifest type determines which extractor runs
3. **Route extraction** — regex + AST patterns pull HTTP routes from controller/handler files
4. **Dependency extraction** — import statements and constructor calls identify external connections
5. **Emit** — results become `component` and `flow` blocks in the `.ag` spec

## Plugin protocol

You can add custom extractors without forking aglang. A plugin is a Node.js module that exports:

```typescript
export interface ExtractorPlugin {
  /** File globs this plugin handles */
  match: string[]

  /**
   * Run against a single source file.
   * Return extracted routes and dependency names.
   */
  extract(filePath: string, source: string): Promise<{
    routes: string[]
    deps: string[]
  }>
}
```

**Register a plugin:**

```typescript
// aglang.config.ts
import type { ExtractorPlugin } from '@collivity/aglang'
import { myExtractor } from './my-extractor'

export const plugins: ExtractorPlugin[] = [myExtractor]
```

Then run `aglc generate` with `--config aglang.config.ts`.

## OpenAPI import

If you have an existing OpenAPI 3.x spec, skip extraction entirely:

```bash
aglc import-openapi swagger.json --out contracts.ag
```

This generates contract blocks for all paths, which you can merge into your main `.ag` file.
