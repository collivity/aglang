// Contract gate — validates API contracts between implementing and consuming components.
// Checks that routes declared in `contract` blocks match actual code in implementing/consuming components.

import { readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import micromatch from 'micromatch';
import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import { normalizeRoute, extractRoutesFromTypeScript, type RouteFact } from '../analyzers/typescript.ts';
import { extractRoutesFromCSharp } from '../analyzers/csharp.ts';

export interface ContractViolation {
  type: 'implements_undeclared' | 'consumes_undeclared' | 'consumes_method_mismatch';
  severity: 'error' | 'warning';
  contract: string;
  component: string;
  role: 'implements' | 'consumes';
  // Declared endpoint from the contract (null if no matching declaration)
  declared: string | null;
  // What was found in the code (null if nothing found)
  extracted: string | null;
  proof: {
    contract_assertion: string;
    extractor_result: string;
    explanation: string;
  };
}

// Normalize a declared contract path (from .ag spec) to positional form
function normalizeContractPath(path: string): string {
  return normalizeRoute(path);
}

// Find all files in a directory tree (no extension filter — caller filters via micromatch)
function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectFiles(fullPath, extensions));
      } else if (extensions.length === 0 || extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return results;
}

// Extract server-side route definitions (implements check)
function extractServerRoutes(filePaths: string[]): RouteFact[] {
  const routes: RouteFact[] = [];
  for (const filePath of filePaths) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    if (filePath.endsWith('.cs') || filePath.endsWith('.csx')) {
      routes.push(...extractRoutesFromCSharp(content, filePath));
    }
    // Future: add extractors for TypeScript (Express/Next.js), Go, Python
  }
  return routes;
}

// Extract client-side fetch/HTTP calls (consumes check)
function extractClientRoutes(filePaths: string[]): RouteFact[] {
  const routes: RouteFact[] = [];
  for (const filePath of filePaths) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
      routes.push(...extractRoutesFromTypeScript(content, filePath));
    }
  }
  return routes;
}

// Expand a component glob into all matching files under projectRoot.
// Uses micromatch.scan() to extract the fixed-prefix directory, then walks it
// and filters with micromatch — handles brace patterns, multi-extension globs, etc.
function globToFiles(globPattern: string, projectRoot: string): string[] {
  // micromatch.scan extracts the base (non-glob prefix) and glob parts
  const scanned = micromatch.scan(globPattern.replace(/\\/g, '/'));
  const baseDir = scanned.base || '.';
  const absDir = resolve(projectRoot, baseDir);

  // Collect all files under the base directory
  const allFiles = collectFiles(absDir, []); // no extension filter — micromatch handles it

  // Normalize to forward-slash relative paths for micromatch
  return allFiles.filter(f => {
    const rel = f.replace(/\\/g, '/');
    return micromatch.isMatch(rel, `**/${globPattern}`) || micromatch.isMatch(rel, globPattern);
  });
}

export interface ContractGateResult {
  violations: ContractViolation[];
  warnings: ContractViolation[];
}

// Run contract gate for a set of changed files.
//
// For `implements` components: checks that every route extracted from the changed file
// is present in the declared contract. (Catches: route renamed away from contract.)
//
// For `consumes` components: checks that every fetch call in the changed file
// matches a route in the declared contract. (Catches: wrong URL, method mismatch.)
//
// For `check` mode with projectRoot: also scans all component files to check completeness.
export function runContractGate(
  artifact: ArchitectureArtifact,
  changedFiles: string[],
  options?: { projectRoot?: string; checkCompleteness?: boolean },
): ContractGateResult {
  const { projectRoot, checkCompleteness = false } = options ?? {};

  const violations: ContractViolation[] = [];
  const warnings: ContractViolation[] = [];

  if (!artifact.contracts?.length || !artifact.componentContracts?.length) {
    return { violations, warnings };
  }

  // Index contracts by name for fast lookup
  const contractsByName = new Map(artifact.contracts.map(c => [c.name, c]));

  // Build normalized endpoint set per contract: `METHOD normalized-path` → endpoint
  const contractEndpointIndex = new Map<string, Map<string, { method: string; path: string; returnType?: string }>>();
  for (const contract of artifact.contracts) {
    const index = new Map<string, { method: string; path: string; returnType?: string }>();
    for (const ep of contract.endpoints) {
      const key = `${ep.method} ${normalizeContractPath(ep.path)}`;
      index.set(key, ep);
    }
    contractEndpointIndex.set(contract.name, index);
  }

  // Map file → component name using micromatch (same logic as index.ts check-file)
  function fileToComponent(filePath: string): string | undefined {
    const normalizedPath = filePath.replace(/\\/g, '/');
    for (const cc of artifact.componentContracts) {
      const glob = artifact.mappings[cc.component];
      if (!glob) continue;
      if (micromatch.isMatch(normalizedPath, `**/${glob}`) || micromatch.isMatch(normalizedPath, glob)) {
        return cc.component;
      }
    }
    return undefined;
  }

  // For each changed file, run the appropriate contract check
  const processedComponents = new Set<string>();

  for (const filePath of changedFiles) {
    const componentName = fileToComponent(filePath);
    if (!componentName) continue;

    const cc = artifact.componentContracts.find(c => c.component === componentName);
    if (!cc) continue;

    // ── IMPLEMENTS check ─────────────────────────────────────────────────────
    // Every route extracted from this file must appear in AT LEAST ONE declared contract.
    if (cc.implements.length > 0) {
      const extractedRoutes = extractServerRoutes([filePath]);
      for (const route of extractedRoutes) {
        const key = `${route.method} ${route.normalized}`;
        const foundInContract = cc.implements.some(name => contractEndpointIndex.get(name)?.has(key));
        if (!foundInContract) {
          // Report against all contracts this component implements
          const contractNames = cc.implements.join(', ');
          violations.push({
            type: 'implements_undeclared',
            severity: 'error',
            contract: contractNames,
            component: componentName,
            role: 'implements',
            declared: null,
            extracted: `${route.method} ${route.path}`,
            proof: {
              contract_assertion: `none of [${contractNames}] declares endpoint ${route.method} ${route.normalized}`,
              extractor_result: `Found route '${route.path}' in ${filePath}`,
              explanation:
                `Component '${componentName}' implements [${contractNames}], but route ` +
                `'${route.method} ${route.path}' (normalized: '${route.normalized}') is not declared in any of those contracts. ` +
                `Either declare the route in a contract or remove it from the implementing component.`,
            },
          });
        }
      }

      // Completeness check: scan ALL component files if requested
      if (checkCompleteness && projectRoot && !processedComponents.has(componentName)) {
        processedComponents.add(componentName);
        const allComponentFiles = globToFiles(artifact.mappings[componentName]!, projectRoot);
        const allRoutes = extractServerRoutes(allComponentFiles);
        const allNormalized = new Map(allRoutes.map(r => [`${r.method} ${r.normalized}`, r]));

        for (const contractName of cc.implements) {
          const contract = contractsByName.get(contractName);
          if (!contract) continue;
          for (const ep of contract.endpoints) {
            const key = `${ep.method} ${normalizeContractPath(ep.path)}`;
            if (!allNormalized.has(key)) {
              violations.push({
                type: 'implements_undeclared',
                severity: 'error',
                contract: contractName,
                component: componentName,
                role: 'implements',
                declared: `${ep.method} ${ep.path}`,
                extracted: null,
                proof: {
                  contract_assertion: `contract ${contractName} declares endpoint ${ep.method} ${ep.path}`,
                  extractor_result: `No matching route found in any file of component '${componentName}'`,
                  explanation:
                    `Contract '${contractName}' declares endpoint '${ep.method} ${ep.path}' ` +
                    `(normalized: '${key}'), but no matching route was found in component '${componentName}' ` +
                    `(path: ${artifact.mappings[componentName]}). This means the contract is not fully implemented.`,
                },
              });
            }
          }
        }
      }
    }

    // ── CONSUMES check ───────────────────────────────────────────────────────
    // Every fetch call in this file should match a route in the declared contract.
    if (cc.consumes.length > 0) {
      const extractedRoutes = extractClientRoutes([filePath]);
      for (const route of extractedRoutes) {
        let foundInAnyContract = false;
        for (const contractName of cc.consumes) {
          const index = contractEndpointIndex.get(contractName);
          if (!index) continue;
          const exactKey = `${route.method} ${route.normalized}`;
          if (index.has(exactKey)) {
            foundInAnyContract = true;
            break;
          }
          // Check method mismatch (same path, different method)
          for (const [key, ep] of index) {
            const [declaredMethod, ...pathParts] = key.split(' ');
            const declaredPath = pathParts.join(' ');
            if (declaredPath === route.normalized && declaredMethod !== route.method) {
              warnings.push({
                type: 'consumes_method_mismatch',
                severity: 'warning',
                contract: contractName,
                component: componentName,
                role: 'consumes',
                declared: `${ep.method} ${ep.path}`,
                extracted: `${route.method} ${route.path}`,
                proof: {
                  contract_assertion: `contract ${contractName} declares ${ep.method} ${normalizeContractPath(ep.path)}`,
                  extractor_result: `fetch() call uses ${route.method} ${route.normalized} in ${filePath}`,
                  explanation:
                    `Contract '${contractName}' declares '${ep.method} ${ep.path}', but component '${componentName}' ` +
                    `calls '${route.method} ${route.path}'. HTTP method mismatch — check your fetch() call.`,
                },
              });
              foundInAnyContract = true; // Don't double-report
            }
          }
        }
        if (!foundInAnyContract) {
          warnings.push({
            type: 'consumes_undeclared',
            severity: 'warning',
            contract: cc.consumes.join(', '),
            component: componentName,
            role: 'consumes',
            declared: null,
            extracted: `${route.method} ${route.path}`,
            proof: {
              contract_assertion: `none of [${cc.consumes.join(', ')}] declares ${route.method} ${route.normalized}`,
              extractor_result: `fetch() call to '${route.path}' found in ${filePath}`,
              explanation:
                `Component '${componentName}' consumes contracts [${cc.consumes.join(', ')}], but fetch() call ` +
                `'${route.method} ${route.path}' (normalized: '${route.normalized}') is not in any of those contracts. ` +
                `This could be an undeclared dependency, a renamed route, or a call to a third-party API.`,
            },
          });
        }
      }
    }
  }

  return { violations, warnings };
}
