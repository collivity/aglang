// Valid topology primitives — built-in ontology

export const VALID_NODE_TYPES = new Set([
  // ── Compute ────────────────────────────────────────────────────────────
  'server',           // bare metal / VM
  'container',        // Docker container (standalone)
  'k8s_pod',          // Kubernetes pod / deployment
  'lambda',           // serverless function (AWS Lambda, Azure Functions, Cloud Run)
  'edge_function',    // CDN-edge compute (Cloudflare Workers, Vercel Edge)
  'edge_mobile',      // mobile device (Android, iOS)
  'edge_desktop',     // browser / Electron desktop
  'edge_embedded',    // IoT / embedded device
  'edge_wearable',    // wearable (Watch, AR glasses)
  'gpu_node',         // GPU inference / training node

  // ── Network / Ingress ──────────────────────────────────────────────────
  'load_balancer',    // L4/L7 LB (AWS ALB/NLB, nginx, HAProxy, GCP LB)
  'api_gateway',      // managed API GW (AWS API GW, Kong, Apigee, Azure APIM)
  'cdn',              // content delivery (CloudFront, Cloudflare, Fastly)
  'service_mesh',     // sidecar mesh (Istio, Linkerd, Consul Connect)
  'vpn',              // private network tunnel (WireGuard, OpenVPN, AWS VPN)
  'private_link',     // cloud private link / VPC peering

  // ── API Protocol nodes (the service IS the protocol) ───────────────────
  'rest_api',         // HTTP/REST service
  'graphql_api',      // GraphQL endpoint (Apollo, Hasura, Strawberry)
  'grpc_service',     // gRPC service
  'websocket_server', // WebSocket long-lived connection
  'event_stream',     // streaming source (Kafka, Kinesis, Azure EventHub)
  'message_queue',    // async queue (SQS, RabbitMQ, Azure Service Bus, NATS)

  // ── Relational databases ────────────────────────────────────────────────
  'postgres',         // PostgreSQL
  'mysql',            // MySQL / MariaDB
  'mssql',            // SQL Server
  'sqlite',           // SQLite (edge / embedded)

  // ── Document / NoSQL databases ─────────────────────────────────────────
  'dynamodb',         // AWS DynamoDB (document + key-value)
  'mongodb',          // MongoDB
  'firestore',        // Google Firestore
  'cosmosdb',         // Azure CosmosDB

  // ── Cache / KV ─────────────────────────────────────────────────────────
  'redis',            // Redis (cache + pub/sub + streams)
  'memcached',        // Memcached
  'elasticache',      // AWS ElastiCache (managed Redis/Memcached)

  // ── Search / Analytics ─────────────────────────────────────────────────
  'elasticsearch',    // Elasticsearch / OpenSearch
  'opensearch',       // AWS OpenSearch Service
  'clickhouse',       // ClickHouse (OLAP)
  'bigquery',         // Google BigQuery

  // ── Wide-column / Time-series ──────────────────────────────────────────
  'cassandra',        // Apache Cassandra / AWS Keyspaces
  'timescaledb',      // TimescaleDB (time-series on Postgres)
  'influxdb',         // InfluxDB

  // ── Graph databases ────────────────────────────────────────────────────
  'neo4j',            // Neo4j
  'neptune',          // AWS Neptune

  // ── Vector / AI databases ──────────────────────────────────────────────
  'vector_db',        // generic vector DB
  'pinecone',         // Pinecone
  'weaviate',         // Weaviate

  // ── Object / File storage ──────────────────────────────────────────────
  's3_bucket',        // AWS S3 / MinIO
  'blob_storage',     // Azure Blob / GCS bucket
  'object_store',     // generic object store

  // ── Auth / Identity ────────────────────────────────────────────────────
  'oauth_provider',   // OAuth 2.0 / OIDC provider (Auth0, Keycloak, Cognito)
  'identity_server',  // custom identity server
  'jwt_issuer',       // JWT signing service / JWKS endpoint

  // ── AI / Agent infrastructure ──────────────────────────────────────────
  'inference_endpoint',   // model inference (OpenAI, Anthropic, local Ollama)
  'embedding_pipeline',   // embedding generation service
  'rag_store',            // retrieval-augmented generation store
  'agent_runtime',        // autonomous agent execution environment
  'model_registry',       // model versioning (MLflow, HuggingFace Hub)
  'guardrail',            // AI output guardrail / safety filter

  // ── CI/CD infrastructure ───────────────────────────────────────────────
  'ci_runner',            // GitHub Actions / GitLab CI runner
  'package_registry',     // npm, PyPI, NuGet, Maven Central
  'container_registry',   // GHCR, Docker Hub, ECR, GCR
  'static_host',          // GitHub Pages, Netlify, Vercel static deploy
  'release_host',         // GitHub Releases or equivalent artifact host

  // ── Legacy / generic (kept for backward compat) ────────────────────────
  'relational_db',    // generic relational DB (prefer specific types)
  'document_db',      // generic document DB
  'time_series_db',   // generic time-series DB
  'cache',            // generic cache
  'graph_db',         // generic graph DB
  'queue',            // generic queue
  'spatial_db',       // spatial / geo DB
  'cluster',          // generic compute cluster
  'serverless',       // generic serverless
  'p2p', 'ble', 'lora', 'grpc_channel', 'websocket',
  'fine_tune_job', 'eval_harness',
]);

export const VALID_RESOURCE_TYPES = new Set([
  'secure_storage',
  'local_preferences',
  'external_api',
  'local_database',
  'reactive_stream',
  'message_bus',
  'file_system',
  'sensor',
  'device_hardware',
]);

export const VALID_COMPONENT_ROLES = new Set([
  'presentation',
  'application',
  'domain',
  'data_access',
  'infrastructure',
  'integration',
  'test',
]);

export const VALID_TRUST_VALUES = new Set(['trusted', 'untrusted', 'semi_trusted']);
export const VALID_CONNECTIVITY_VALUES = new Set(['always_on', 'intermittent', 'offline_first']);

// Valid protocol values for the `protocol:` node property
export const VALID_PROTOCOL_VALUES = new Set([
  'http', 'https', 'h2', 'h3', 'grpc', 'ws', 'wss', 'amqp', 'mqtt', 'tcp', 'udp',
]);

// Valid auth values for the `auth:` node property
export const VALID_AUTH_VALUES = new Set([
  'none', 'jwt', 'oauth2', 'api_key', 'mtls', 'basic', 'cookie', 'saml',
]);

// Base SMT-LIB 2.6 sort and function declarations shared across all compiled specs.
// All architecture entities (nodes and components) use the same Entity sort,
// so Flow can express relationships between any two architectural entities.
export const BASE_SMT_DECLARATIONS: string[] = [
  '; === aglang base sorts ===',
  '(declare-sort Entity 0)',
  '(declare-sort DataType 0)',
  '(declare-fun Flow      (Entity Entity) Bool)',
  '(declare-fun DataFlow  (DataType Entity) Bool)',
  '(declare-fun Encrypted (Entity Entity) Bool)',
  '(declare-fun Trusted   (Entity) Bool)',
  '(declare-fun IsNode    (Entity) Bool)',
  '(declare-fun IsComp    (Entity) Bool)',
  '(declare-fun IsResource (Entity) Bool)',
];
