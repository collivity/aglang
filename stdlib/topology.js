// Valid topology primitives — built-in ontology
export const VALID_NODE_TYPES = new Set([
    // Compute
    'edge_mobile', 'edge_desktop', 'edge_embedded', 'edge_wearable',
    'server', 'cluster', 'serverless', 'gpu_node',
    // Storage
    'relational_db', 'document_db', 'vector_db', 'time_series_db',
    'object_store', 'spatial_db', 'cache', 'event_stream', 'queue', 'graph_db',
    // Network
    'cdn', 'api_gateway', 'service_mesh', 'vpn', 'private_link',
    'websocket', 'grpc_channel', 'p2p', 'ble', 'lora',
    // AI / Agent
    'inference_endpoint', 'embedding_pipeline', 'rag_store', 'agent_runtime',
    'model_registry', 'fine_tune_job', 'eval_harness', 'guardrail',
]);
export const VALID_TRUST_VALUES = new Set(['trusted', 'untrusted', 'semi_trusted']);
export const VALID_CONNECTIVITY_VALUES = new Set(['always_on', 'intermittent', 'offline_first']);
// Base SMT-LIB 2.6 sort and function declarations shared across all compiled specs.
// These are prepended to every architecture.o constraints array.
export const BASE_SMT_DECLARATIONS = [
    '; === aglang base sorts ===',
    '(declare-sort Component 0)',
    '(declare-sort Node 0)',
    '(declare-fun Flow (Component Component) Bool)',
    '(declare-fun Encrypted (Component Component) Bool)',
    '(declare-fun RunsOn (Component Node) Bool)',
    '(declare-fun Trusted (Node) Bool)',
];
