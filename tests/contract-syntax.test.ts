import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { importOpenApi } from '../src/import-openapi.ts';
import { importTerraform } from '../src/import-tf.ts';

describe('contract syntax: HTTP (existing, backward compat)', () => {
  it('parses GET/POST HTTP endpoints', () => {
    const program = parse(tokenize(`
      contract MyApi {
        GET "/api/items" -> ItemDto[]
        POST "/api/items" -> ItemDto
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.kind).toBe('ContractDecl');
    expect(decl.endpoints).toHaveLength(2);
    expect(decl.endpoints[0].kind).toBe('http');
    expect(decl.endpoints[0].method).toBe('GET');
    expect(decl.endpoints[0].path).toBe('/api/items');
    expect(decl.endpoints[0].returnType).toBe('ItemDto[]');
    expect(decl.endpoints[1].kind).toBe('http');
    expect(decl.endpoints[1].method).toBe('POST');
  });
});

describe('contract syntax: GraphQL', () => {
  it('parses query endpoint', () => {
    const program = parse(tokenize(`
      contract OrderGraph {
        query GetOrder(id: ID) -> OrderDto
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints[0].kind).toBe('graphql');
    expect(decl.endpoints[0].operation).toBe('query');
    expect(decl.endpoints[0].operationName).toBe('GetOrder');
    expect(decl.endpoints[0].inputTypes).toEqual(['ID']);
    expect(decl.endpoints[0].returnType).toBe('OrderDto');
  });

  it('parses mutation endpoint', () => {
    const program = parse(tokenize(`
      contract OrderGraph {
        mutation CreateOrder -> OrderDto
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints[0].kind).toBe('graphql');
    expect(decl.endpoints[0].operation).toBe('mutation');
    expect(decl.endpoints[0].operationName).toBe('CreateOrder');
    expect(decl.endpoints[0].inputTypes).toBeUndefined();
    expect(decl.endpoints[0].returnType).toBe('OrderDto');
  });

  it('parses subscription endpoint', () => {
    const program = parse(tokenize(`
      contract OrderGraph {
        subscription OnOrderUpdated -> OrderDto
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints[0].kind).toBe('graphql');
    expect(decl.endpoints[0].operation).toBe('subscription');
    expect(decl.endpoints[0].operationName).toBe('OnOrderUpdated');
  });
});

describe('contract syntax: gRPC', () => {
  it('parses rpc endpoint', () => {
    const program = parse(tokenize(`
      contract PaymentService {
        rpc ProcessPayment(PaymentRequest) -> PaymentResponse
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints[0].kind).toBe('grpc');
    expect(decl.endpoints[0].rpcName).toBe('ProcessPayment');
    expect(decl.endpoints[0].inputMessage).toBe('PaymentRequest');
    expect(decl.endpoints[0].outputMessage).toBe('PaymentResponse');
  });

  it('parses multiple rpc endpoints', () => {
    const program = parse(tokenize(`
      contract PaymentService {
        rpc ProcessPayment(PaymentRequest) -> PaymentResponse
        rpc RefundPayment(RefundRequest) -> RefundResponse
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints).toHaveLength(2);
    expect(decl.endpoints[1].rpcName).toBe('RefundPayment');
  });
});

describe('contract syntax: queue topics', () => {
  it('parses publishes topic', () => {
    const program = parse(tokenize(`
      contract OrderEvents {
        publishes: "order.created"
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints[0].kind).toBe('queue_publish');
    expect(decl.endpoints[0].topic).toBe('order.created');
  });

  it('parses subscribes topic', () => {
    const program = parse(tokenize(`
      contract OrderEvents {
        subscribes: "payment.processed"
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints[0].kind).toBe('queue_subscribe');
    expect(decl.endpoints[0].topic).toBe('payment.processed');
  });

  it('parses mixed publishes and subscribes', () => {
    const program = parse(tokenize(`
      contract OrderEvents {
        publishes: "order.created"
        publishes: "order.updated"
        subscribes: "payment.processed"
      }
    `));
    const decl = program.declarations[0]! as any;
    expect(decl.endpoints).toHaveLength(3);
    expect(decl.endpoints[2].kind).toBe('queue_subscribe');
  });
});

describe('contract syntax: mixed (HTTP + gRPC + queue in one file)', () => {
  it('parses mixed contract types in separate blocks', () => {
    const program = parse(tokenize(`
      contract UserApi {
        GET "/users" -> UserDto[]
        POST "/users" -> UserDto
      }
      contract UserRpc {
        rpc GetUser(UserRequest) -> UserDto
      }
      contract UserEvents {
        publishes: "user.created"
        subscribes: "auth.token_revoked"
      }
    `));
    expect(program.declarations).toHaveLength(3);
    const [http, grpc, queue] = program.declarations as any[];
    expect(http.endpoints[0].kind).toBe('http');
    expect(grpc.endpoints[0].kind).toBe('grpc');
    expect(queue.endpoints[0].kind).toBe('queue_publish');
  });
});

describe('artifact emitter: extended endpoints', () => {
  it('emits graphql endpoints to artifact', () => {
    const program = parse(tokenize(`
      contract GraphQL {
        query GetUser(id: ID) -> UserDto
        mutation CreateUser -> UserDto
      }
    `));
    const artifact = emitArtifact(program, 'test.ag');
    expect(artifact.contracts[0]!.endpoints[0].kind).toBe('graphql');
    expect(artifact.contracts[0]!.endpoints[1].kind).toBe('graphql');
    expect((artifact.contracts[0]!.endpoints[0] as any).operationName).toBe('GetUser');
  });

  it('emits grpc endpoints to artifact', () => {
    const program = parse(tokenize(`
      contract Rpc { rpc DoThing(Req) -> Resp }
    `));
    const artifact = emitArtifact(program, 'test.ag');
    const ep = artifact.contracts[0]!.endpoints[0] as any;
    expect(ep.kind).toBe('grpc');
    expect(ep.rpcName).toBe('DoThing');
  });

  it('emits queue endpoints to artifact', () => {
    const program = parse(tokenize(`
      contract Events {
        publishes: "order.created"
        subscribes: "payment.done"
      }
    `));
    const artifact = emitArtifact(program, 'test.ag');
    const [pub, sub] = artifact.contracts[0]!.endpoints as any[];
    expect(pub.kind).toBe('queue_publish');
    expect(pub.topic).toBe('order.created');
    expect(sub.kind).toBe('queue_subscribe');
    expect(sub.topic).toBe('payment.done');
  });
});

describe('OpenAPI importer', () => {
  const petstore = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Petstore', version: '1.0.0' },
    paths: {
      '/pets': {
        get: {
          tags: ['Pets'],
          operationId: 'listPets',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'array', items: { '$ref': '#/components/schemas/Pet' } },
                },
              },
            },
          },
        },
        post: {
          tags: ['Pets'],
          operationId: 'createPet',
          responses: { '201': {} },
        },
      },
      '/pets/{petId}': {
        get: {
          tags: ['Pets'],
          operationId: 'showPet',
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/Pet' },
                },
              },
            },
          },
        },
        delete: { tags: ['Pets'], operationId: 'deletePet', responses: { '204': {} } },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
          },
        },
      },
    },
  });

  it('generates contract blocks grouped by tag', () => {
    const result = importOpenApi(petstore);
    expect(result.contracts).toBe(1);
    expect(result.endpoints).toBe(4);
    expect(result.ag).toContain('contract Pets {');
    expect(result.ag).toContain('GET "/pets"');
    expect(result.ag).toContain('POST "/pets"');
    expect(result.ag).toContain('GET "/pets/{petId}"');
    expect(result.ag).toContain('DELETE "/pets/{petId}"');
  });

  it('extracts return types from response schemas', () => {
    const result = importOpenApi(petstore);
    expect(result.ag).toContain('GET "/pets" -> Pet[]');
    expect(result.ag).toContain('GET "/pets/{petId}" -> Pet');
  });

  it('generates data blocks from component schemas', () => {
    const result = importOpenApi(petstore);
    expect(result.dataTypes).toBe(1);
    expect(result.ag).toContain('data Pet {');
    expect(result.ag).toContain('id: number');
    expect(result.ag).toContain('name: string');
  });

  it('falls back to path segment when no tag', () => {
    const noTags = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/orders': {
          get: { responses: { '200': {} } },
        },
      },
    });
    const result = importOpenApi(noTags);
    expect(result.ag).toContain('contract Orders {');
  });
});

describe('Terraform importer', () => {
  const hcl = `
resource "aws_db_instance" "main_db" {
  engine = "postgres"
  instance_class = "db.t3.micro"
}

resource "aws_elasticache_cluster" "session_cache" {
  engine = "redis"
}

resource "aws_s3_bucket" "media_storage" {
  bucket = "my-media-bucket"
}

resource "aws_sqs_queue" "order_queue" {
  name = "order-events.fifo"
}

resource "aws_unrecognized_thing" "ignored" {
  foo = "bar"
}
`;

  it('generates node declarations for recognized resources', () => {
    const result = importTerraform(hcl);
    expect(result.nodes).toBe(4);
    expect(result.ag).toContain('node MainDb : postgres {');
    expect(result.ag).toContain('node SessionCache : redis {');
    expect(result.ag).toContain('node MediaStorage : object_store {');
    expect(result.ag).toContain('node OrderQueue : queue {');
  });

  it('skips unrecognized resource types', () => {
    const result = importTerraform(hcl);
    expect(result.skipped).toBe(1);
    expect(result.ag).not.toContain('aws_unrecognized_thing');
  });

  it('includes terraform resource type comment', () => {
    const result = importTerraform(hcl);
    expect(result.ag).toContain('// terraform: aws_db_instance.main_db');
  });

  it('handles Google Cloud resources', () => {
    const gcp = `resource "google_sql_database_instance" "app_db" {}\nresource "google_storage_bucket" "assets" {}`;
    const result = importTerraform(gcp);
    expect(result.nodes).toBe(2);
    expect(result.ag).toContain('node AppDb : postgres {');
    expect(result.ag).toContain('node Assets : object_store {');
  });

  it('handles Azure resources', () => {
    const azure = `resource "azurerm_redis_cache" "cache" {}\nresource "azurerm_postgresql_server" "pgdb" {}`;
    const result = importTerraform(azure);
    expect(result.nodes).toBe(2);
    expect(result.ag).toContain('node Cache : redis {');
    expect(result.ag).toContain('node Pgdb : postgres {');
  });
});
