import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { loadAndMerge } from '../src/importer.ts';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { generateSpec } from '../src/generate.ts';

function compileAg(ag: string): string[] {
  try {
    const tokens = tokenize(ag);
    const program = parse(tokens);
    return check(program).map(error => error.message);
  } catch (error) {
    return [`parse error: ${(error as Error).message}`];
  }
}

function compileGeneratedFiles(rootDir: string, files: Array<{ path: string; content: string }>): string[] {
  for (const file of files) {
    const abs = join(rootDir, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, 'utf8');
  }
  try {
    const program = loadAndMerge(join(rootDir, 'architecture.ag'));
    return check(program).map(error => error.message);
  } catch (error) {
    return [`parse error: ${(error as Error).message}`];
  }
}

describe('generateSpec', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `aglc-gen-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns compilable .ag for an empty dir', async () => {
    const result = await generateSpec(dir, { projectName: 'EmptyProject' });
    expect(result.ag).toBeTruthy();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('keeps a simple Node project as one root component', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api', version: '1.0.0' }));
    writeFileSync(join(dir, 'server.ts'), `const app = { get() {} }; app.get('/users', () => {});`);

    const result = await generateSpec(dir, { singleFile: true });

    expect(result.components).toBe(1);
    expect(result.ag).toContain('component Api');
    expect(result.ag).toContain('contract Api');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('keeps mixed-language roots together instead of dropping the root backend', async () => {
    writeFileSync(join(dir, 'api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
    writeFileSync(join(dir, 'Program.cs'), 'var builder = WebApplication.CreateBuilder(args);');
    mkdirSync(join(dir, 'Services'), { recursive: true });
    writeFileSync(join(dir, 'Services', 'EmailService.cs'), 'namespace app.Services; public class EmailService {}');
    mkdirSync(join(dir, 'creator-ui'), { recursive: true });
    writeFileSync(join(dir, 'creator-ui', 'package.json'), JSON.stringify({ name: 'creator-ui' }));
    writeFileSync(join(dir, 'creator-ui', 'src.tsx'), `import React from 'react'; export function App() { return <div />; }`);

    const result = await generateSpec(dir);
    const generated = result.files.map(file => file.content).join('\n');

    expect(generated).toContain('component Api');
    expect(generated).toContain('component CreatorUi');
    expect(compileGeneratedFiles(dir, result.files)).toHaveLength(0);
  });

  it('keeps monorepo workspace roots out and emits sub-packages', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['packages/*'],
    }));
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'worker'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api' }));
    writeFileSync(join(dir, 'packages', 'api', 'server.ts'), `const app = { get() {} }; app.get('/users', () => {});`);
    writeFileSync(join(dir, 'packages', 'worker', 'package.json'), JSON.stringify({ name: 'worker' }));
    writeFileSync(join(dir, 'packages', 'worker', 'index.ts'), `export async function run() { return 1; }`);

    const result = await generateSpec(dir);
    const generated = result.files.map(file => file.content).join('\n');

    expect(result.components).toBe(2);
    expect(generated).toContain('component Api');
    expect(generated).toContain('component Worker');
    expect(compileGeneratedFiles(dir, result.files)).toHaveLength(0);
  });

  it('synthesizes business app domains instead of structural buckets', async () => {
    writeFileSync(join(dir, 'api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
    writeFileSync(join(dir, 'Program.cs'), 'var builder = WebApplication.CreateBuilder(args);');

    mkdirSync(join(dir, 'Controllers', 'Auth'), { recursive: true });
    writeFileSync(join(dir, 'Controllers', 'Auth', 'AuthController.cs'), `
      [ApiController]
      [Route("api/auth")]
      public class AuthController : ControllerBase { [HttpPost("login")] public void Login() {} }
    `);

    mkdirSync(join(dir, 'Services', 'Catalog'), { recursive: true });
    writeFileSync(join(dir, 'Services', 'Catalog', 'CatalogService.cs'), 'namespace App.Services.Catalog; public class CatalogService {}');

    mkdirSync(join(dir, 'Repositories', 'Photo'), { recursive: true });
    writeFileSync(join(dir, 'Repositories', 'Photo', 'PhotoRepository.cs'), 'namespace App.Repositories.Photo; public class PhotoRepository {}');

    mkdirSync(join(dir, 'Integrations'), { recursive: true });
    writeFileSync(join(dir, 'Integrations', 'StripeClient.cs'), 'public class StripeClient { }');

    const result = await generateSpec(dir, { singleFile: true });

    expect(result.ag).toContain('component ApiAuth');
    expect(result.ag).toContain('component ApiCatalog');
    expect(result.ag).toContain('component ApiPhoto');
    expect(result.ag).toContain('component ApiExternalIntegrations');
    expect(result.ag).not.toContain('component ApiControllers');
    expect(result.ag).not.toContain('component ApiServices');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('emits imported semantic sub-specs for broader roots by default', async () => {
    writeFileSync(join(dir, 'api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
    writeFileSync(join(dir, 'Program.cs'), 'var builder = WebApplication.CreateBuilder(args);');
    mkdirSync(join(dir, 'Controllers', 'Auth'), { recursive: true });
    mkdirSync(join(dir, 'Services', 'Catalog'), { recursive: true });
    mkdirSync(join(dir, 'Repositories', 'Photo'), { recursive: true });
    mkdirSync(join(dir, 'Workers', 'Sync'), { recursive: true });
    writeFileSync(join(dir, 'Controllers', 'Auth', 'AuthController.cs'), '[ApiController] [Route("api/auth")] public class AuthController : ControllerBase {}');
    writeFileSync(join(dir, 'Services', 'Catalog', 'CatalogService.cs'), 'public class CatalogService {}');
    writeFileSync(join(dir, 'Repositories', 'Photo', 'PhotoRepository.cs'), 'public class PhotoRepository {}');
    writeFileSync(join(dir, 'Workers', 'Sync', 'SyncWorker.cs'), 'public class SyncWorker {}');

    const result = await generateSpec(dir);

    expect(result.files.length).toBeGreaterThan(1);
    expect(result.ag).toContain('import "components/');
    expect(compileGeneratedFiles(dir, result.files)).toHaveLength(0);
  });

  it('supports single-file generation for semantic slices', async () => {
    writeFileSync(join(dir, 'api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
    writeFileSync(join(dir, 'Program.cs'), 'var builder = WebApplication.CreateBuilder(args);');
    mkdirSync(join(dir, 'Controllers', 'Auth'), { recursive: true });
    mkdirSync(join(dir, 'Services', 'Catalog'), { recursive: true });
    writeFileSync(join(dir, 'Controllers', 'Auth', 'AuthController.cs'), '[ApiController] [Route("api/auth")] public class AuthController : ControllerBase {}');
    writeFileSync(join(dir, 'Services', 'Catalog', 'CatalogService.cs'), 'public class CatalogService {}');

    const result = await generateSpec(dir, { singleFile: true });

    expect(result.files).toHaveLength(1);
    expect(result.ag).not.toContain('import "components/');
    expect(result.ag).toContain('component ApiAuth');
    expect(result.ag).toContain('component ApiCatalog');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('synthesizes Kotlin mobile layers into semantic components', async () => {
    const appDir = join(dir, 'mobile-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'build.gradle.kts'), 'plugins { kotlin("android") version "1.0" }');
    mkdirSync(join(appDir, 'feature', 'home', 'ui'), { recursive: true });
    mkdirSync(join(appDir, 'feature', 'home', 'viewmodel'), { recursive: true });
    mkdirSync(join(appDir, 'feature', 'home', 'data'), { recursive: true });
    mkdirSync(join(appDir, 'core', 'network'), { recursive: true });
    mkdirSync(join(appDir, 'core', 'storage'), { recursive: true });
    writeFileSync(join(appDir, 'feature', 'home', 'ui', 'HomeScreen.kt'), '@Composable fun HomeScreen() {}');
    writeFileSync(join(appDir, 'feature', 'home', 'viewmodel', 'HomeViewModel.kt'), 'class HomeViewModel : ViewModel()');
    writeFileSync(join(appDir, 'feature', 'home', 'data', 'HomeRepository.kt'), 'class HomeRepository');
    writeFileSync(join(appDir, 'core', 'network', 'ApiClient.kt'), 'class ApiClient');
    writeFileSync(join(appDir, 'core', 'storage', 'PrefsStore.kt'), 'class PrefsStore');

    const result = await generateSpec(appDir, { singleFile: true });

    expect(result.ag).toContain('component MobileAppHomeUi');
    expect(result.ag).toContain('component MobileAppHomeViewModel');
    expect(result.ag).toContain('component MobileAppHomeData');
    expect(result.ag).toContain('component MobileAppPlatformNetwork');
    expect(result.ag).toContain('component MobileAppPlatformStorage');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('synthesizes Swift MVVM/native app layers into semantic components', async () => {
    const appDir = join(dir, 'ios-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'Package.swift'), 'import PackageDescription\nlet package = Package(name: "ios-app")');
    mkdirSync(join(appDir, 'Features', 'Login', 'Views'), { recursive: true });
    mkdirSync(join(appDir, 'Features', 'Login', 'ViewModels'), { recursive: true });
    mkdirSync(join(appDir, 'Features', 'Login', 'Repositories'), { recursive: true });
    mkdirSync(join(appDir, 'Core', 'Storage'), { recursive: true });
    mkdirSync(join(appDir, 'Core', 'Network'), { recursive: true });
    writeFileSync(join(appDir, 'Features', 'Login', 'Views', 'LoginViewController.swift'), 'import UIKit\nclass LoginViewController: UIViewController {}');
    writeFileSync(join(appDir, 'Features', 'Login', 'ViewModels', 'LoginViewModel.swift'), 'class LoginViewModel: ObservableObject {}');
    writeFileSync(join(appDir, 'Features', 'Login', 'Repositories', 'LoginRepository.swift'), 'class LoginRepository {}');
    writeFileSync(join(appDir, 'Core', 'Storage', 'KeychainStore.swift'), 'import Security\nSecItemAdd([:] as CFDictionary, nil)');
    writeFileSync(join(appDir, 'Core', 'Network', 'ApiClient.swift'), 'import Foundation\nURLSession.shared.dataTask(with: URL(string: "https://example.com")!)');

    const result = await generateSpec(appDir, { singleFile: true });

    expect(result.ag).toContain('component IosAppLoginUi');
    expect(result.ag).toContain('component IosAppLoginViewModel');
    expect(result.ag).toContain('component IosAppLoginData');
    expect(result.ag).toContain('component IosAppPlatformStorage');
    expect(result.ag).toContain('component IosAppPlatformNetwork');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('filters health and metrics noise from contracts when public routes exist', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api' }));
    writeFileSync(join(dir, 'server.ts'), `
      const app = { get(path, handler) {}, post(path, handler) {} };
      app.get('/health', () => {});
      app.get('/metrics', () => {});
      app.post('/orders', () => {});
    `);

    const result = await generateSpec(dir, { singleFile: true });

    expect(result.ag).toContain('POST "/orders"');
    expect(result.ag).not.toContain('/health');
    expect(result.ag).not.toContain('/metrics');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('skips unsupported wildcard contract methods without generating invalid syntax', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api' }));
    writeFileSync(join(dir, 'server.ts'), `
      const app = { all(path, handler) {}, get(path, handler) {} };
      app.all('/convert', () => {});
      app.get('/health', () => {});
    `);

    const result = await generateSpec(dir, { singleFile: true });

    expect(result.ag).toContain('GET "/health"');
    expect(result.ag).not.toContain('* "/convert"');
    expect(compileAg(result.ag)).toHaveLength(0);
  });

  it('uses root-relative paths and only // comments', async () => {
    mkdirSync(join(dir, 'backend'), { recursive: true });
    writeFileSync(join(dir, 'backend', 'go.mod'), 'module example.com/backend\n\ngo 1.21\n');
    writeFileSync(join(dir, 'backend', 'main.go'), 'package main\nfunc main() {}');

    const result = await generateSpec(dir);
    const generated = result.files.map(file => file.content).join('\n');
    const hashLines = generated.split('\n').filter(line => line.trimStart().startsWith('#'));

    expect(generated).toContain('backend/');
    expect(hashLines).toHaveLength(0);
    expect(result.ag).not.toContain('trust: public');
    expect(compileGeneratedFiles(dir, result.files)).toHaveLength(0);
  });
});
