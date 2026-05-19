// Node Resolver — maps extractor category names to actual declared node names in the artifact.
// Extractors emit facts with generic category targets (e.g. 'postgres', 'redis').
// This module resolves those to the concrete node names declared in the .ag spec,
// so that invariant checking works correctly (invariants reference node names, not types).

import type { ArchitectureArtifact } from '../emitters/artifact.ts';
import type { FlowFact } from './plugin.ts';

// Category → which node types in the .ag ontology match this category.
// Order matters: more specific matches (postgres) are checked before generic (relational_db).
const CATEGORY_TYPE_MAP: Record<string, string[]> = {
  postgres:       ['postgres', 'timescaledb', 'relational_db'],
  mysql:          ['mysql', 'relational_db'],
  mssql:          ['mssql', 'relational_db'],
  sqlite:         ['sqlite', 'relational_db'],
  relational_db:  ['postgres', 'mysql', 'mssql', 'sqlite', 'timescaledb', 'relational_db'],
  mongodb:        ['mongodb', 'document_db', 'cosmosdb', 'firestore'],
  dynamodb:       ['dynamodb', 'document_db'],
  redis:          ['redis', 'elasticache', 'cache', 'memcached'],
  cache:          ['redis', 'elasticache', 'cache', 'memcached'],
  message_queue:  ['message_queue', 'event_stream', 'queue'],
  object_store:   ['s3_bucket', 'blob_storage', 'object_store'],
  external_api:   ['rest_api', 'api_gateway', 'grpc_service', 'graphql_api'],
  elasticsearch:  ['elasticsearch', 'opensearch'],
  cassandra:      ['cassandra'],
  neo4j:          ['neo4j', 'neptune', 'graph_db'],
  vector_db:      ['vector_db', 'pinecone', 'weaviate'],
  // Swift / iOS specific
  firebase:       ['firebase', 'firestore', 'firebase_rtdb', 'firebase_auth', 'firebase_storage'],
  cloudkit:       ['cloudkit', 'icloud'],
  local_store:    ['local_store', 'coredata', 'realm', 'sqlite', 'shared_preferences'],
  graphql_api:    ['graphql_api', 'graphql_server', 'hasura', 'appsync'],
  grpc_api:       ['grpc_service', 'grpc_api'],
};

/**
 * Resolve an extractor category to matching declared node names.
 * Returns the list of node names in the artifact whose type matches the category.
 * Falls back to [category] (unchanged) if no declared node matches — this is
 * a no-op fact that won't match real invariants but preserves the signal for diagnostics.
 */
export function resolveCategoryToNodes(
  category: string,
  nodes: ArchitectureArtifact['nodes'],
): string[] {
  const matchingTypes = CATEGORY_TYPE_MAP[category] ?? [category];
  const matched = nodes
    .filter(n => matchingTypes.includes(n.type))
    .map(n => n.name);
  return matched.length > 0 ? matched : [category];
}

/**
 * Expand FlowFact[] where to= is a category name into concrete node-name facts.
 * Facts where to= is already a declared node name are passed through unchanged.
 * A single fact with to='postgres' may expand into multiple facts if several
 * postgres nodes are declared (e.g. LedgerDatabase, AnalyticsDatabase).
 */
export function resolveFactTargets(
  facts: FlowFact[],
  nodes: ArchitectureArtifact['nodes'],
): FlowFact[] {
  const declaredNodeNames = new Set(nodes.map(n => n.name));
  const result: FlowFact[] = [];

  for (const fact of facts) {
    if (declaredNodeNames.has(fact.to)) {
      // Already a real node name — pass through
      result.push(fact);
    } else {
      // Category name — resolve to actual node names
      const resolved = resolveCategoryToNodes(fact.to, nodes);
      for (const nodeName of resolved) {
        result.push({ ...fact, to: nodeName });
      }
    }
  }

  return result;
}
