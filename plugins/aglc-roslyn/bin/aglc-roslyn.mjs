#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

const INFO = {
  name: '@collivity/aglc-roslyn',
  extensions: ['.cs', '.csx'],
  version: '0.1.0',
};

const USING_TO_INFRA = [
  [/MongoDB/, 'mongodb'],
  [/StackExchange\.Redis|Microsoft\.Extensions\.Caching/, 'cache'],
  [/Amazon\.S3|Azure\.Storage\.Blobs|Minio/, 'object_store'],
  [/Microsoft\.EntityFrameworkCore|Npgsql|MySql/, 'relational_db'],
];

const DB_CONTEXT_TYPES = new Set(['ApplicationDbContext', 'DbContext', 'DbSet', 'MongoDatabase', 'IMongoCollection']);
const STORAGE_TYPES = new Set(['IObjectStorageService', 'ObjectStorageService', 'IAmazonS3', 'BlobServiceClient', 'MinioClient', 'AmazonS3Client']);
const EXTERNAL_HTTP_TYPES = new Set(['HttpClient', 'IHttpClientFactory', 'RestClient']);
const CACHE_TYPES = new Set(['IDistributedCache', 'IConnectionMultiplexer', 'ConnectionMultiplexer']);

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--info') {
      args.info = true;
      continue;
    }
    if (arg === '--component') {
      args.componentName = argv[++i];
      continue;
    }
    if (arg === '--mappings') {
      args.mappings = argv[++i];
      continue;
    }
    if (arg === '--files') {
      args.files = argv.slice(i + 1);
      break;
    }
  }
  return args;
}

function normalizeType(typeName) {
  return typeName
    .replace(/\?.*$/, '')
    .replace(/<.*$/, '')
    .split('.')
    .pop();
}

function isController(content, filePath) {
  return /\[ApiController\]|\[Authorize(?:\(|\])|ControllerBase|class\s+\w+Controller\b/.test(content)
    || filePath.includes('Controller');
}

function findProjectContext(filePath) {
  let current = path.dirname(filePath);
  while (true) {
    const entries = safeReadDir(current);
    const csproj = entries.find(entry => entry.endsWith('.csproj'));
    const solution = entries.find(entry => entry.endsWith('.sln'));
    if (csproj || solution) {
      return {
        project: csproj ? path.basename(csproj, '.csproj') : undefined,
        solution: solution ? path.basename(solution, '.sln') : undefined,
      };
    }
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir).map(name => path.join(dir, name));
  } catch {
    return [];
  }
}

function parseTypeList(paramsText) {
  return paramsText
    .split(',')
    .map(part => part.trim())
    .map(part => part.replace(/\b(this|ref|out|in|params)\b/g, '').trim())
    .map(part => part.match(/^([\w.<>,?]+)/)?.[1])
    .filter(Boolean)
    .map(normalizeType);
}

function inferInfraNode(typeName, controller) {
  if (!typeName) return undefined;
  if (DB_CONTEXT_TYPES.has(typeName) || typeName === 'DbContext') return 'relational_db';
  if (typeName.includes('Mongo')) return 'mongodb';
  if (STORAGE_TYPES.has(typeName)) return 'object_store';
  if (CACHE_TYPES.has(typeName)) return 'cache';
  if (EXTERNAL_HTTP_TYPES.has(typeName) && controller) return 'external_api';
  return undefined;
}

function addFact(facts, emitted, componentName, target, confidence, evidence, file, line) {
  const key = `${componentName}::${target}`;
  if (emitted.has(key)) return;
  emitted.add(key);
  facts.push({
    from: componentName,
    to: target,
    confidence,
    evidence,
    file,
    line,
    strategy: 'graph',
  });
}

function lineOf(content, index) {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function analyzeFile(componentName, filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const controller = isController(content, filePath);
  const context = findProjectContext(filePath);
  const scope = [context.solution, context.project].filter(Boolean).join('/');
  const scopeSuffix = scope ? ` in ${scope}` : '';
  const facts = [];
  const emitted = new Set();

  for (const match of content.matchAll(/^\s*using\s+([\w.]+)\s*;/gm)) {
    const namespace = match[1];
    for (const [pattern, infraNode] of USING_TO_INFRA) {
      if (pattern.test(namespace)) {
        addFact(facts, emitted, componentName, infraNode, 'probable', `Roslyn plugin resolved using '${namespace}'${scopeSuffix}`, filePath, lineOf(content, match.index));
      }
    }
  }

  for (const match of content.matchAll(/\b[A-Z]\w*\s*\(([^)]*)\)\s*\{/g)) {
    for (const typeName of parseTypeList(match[1])) {
      const infraNode = inferInfraNode(typeName, controller);
      if (!infraNode) continue;
      addFact(facts, emitted, componentName, infraNode, 'definite', `Roslyn plugin resolved constructor dependency '${typeName}'${scopeSuffix}`, filePath, lineOf(content, match.index));
    }
  }

  for (const match of content.matchAll(/\b(?:public|private|protected|internal)\s+(?:readonly\s+)?([\w.]+(?:<[^>]+>)?)\s+[_A-Za-z]\w*\s*;/g)) {
    const typeName = normalizeType(match[1]);
    const infraNode = inferInfraNode(typeName, controller);
    if (!infraNode) continue;
    addFact(facts, emitted, componentName, infraNode, 'definite', `Roslyn plugin resolved field '${typeName}'${scopeSuffix}`, filePath, lineOf(content, match.index));
  }

  for (const match of content.matchAll(/\b(?:public|private|protected|internal)\s+([\w.]+(?:<[^>]+>)?)\s+[A-Z_]\w*\s*\{\s*get;\s*set;\s*\}/g)) {
    const typeName = normalizeType(match[1]);
    const infraNode = inferInfraNode(typeName, controller);
    if (!infraNode) continue;
    addFact(facts, emitted, componentName, infraNode, 'definite', `Roslyn plugin resolved property '${typeName}'${scopeSuffix}`, filePath, lineOf(content, match.index));
  }

  for (const match of content.matchAll(/\bnew\s+([\w.]+)(?:<[^>]+>)?\s*\(/g)) {
    const typeName = normalizeType(match[1]);
    const infraNode = inferInfraNode(typeName, controller);
    if (!infraNode) continue;
    addFact(facts, emitted, componentName, infraNode, 'definite', `Roslyn plugin resolved object creation '${typeName}'${scopeSuffix}`, filePath, lineOf(content, match.index));
  }

  return facts;
}

const args = parseArgs(process.argv.slice(2));

if (args.info) {
  process.stdout.write(`${JSON.stringify(INFO, null, 2)}\n`);
  process.exit(0);
}

const componentName = args.componentName ?? 'UnknownComponent';
const files = (args.files ?? []).filter(file => ['.cs', '.csx'].includes(path.extname(file).toLowerCase()) && existsSync(file));
const facts = files.flatMap(file => analyzeFile(componentName, path.resolve(file)));

process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
