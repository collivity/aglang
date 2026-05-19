# Contracts

Contracts define the HTTP, GraphQL, gRPC, or queue interface shape a component implements or consumes.

## HTTP syntax

```ag
contract PaymentsApi {
  GET  "/api/payments/{id}" -> Payment
  POST "/api/payments"      -> Payment
}

component ApiControllers {
  runs_on: api_backend
  paths: "web/api/Controllers/**/*.cs"
  implements: PaymentsApi
}

component CreatorUi {
  runs_on: web_client
  paths: "creator-ui/src/**/*.ts"
  consumes: PaymentsApi
}
```

## Other endpoint types

```ag
contract RealtimeApi {
  query GetOrder(OrderInput) -> Order
  mutation CreateOrder(CreateOrderInput) -> Order
  rpc ProvisionVps(ProvisionRequest) returns (ProvisionReply)
  publishes "orders.created"
  subscribes "payments.captured"
}
```

## Importing from OpenAPI

```bash
aglc import-openapi swagger.json --out contracts.ag
```

The importer generates contract blocks from OpenAPI paths and response schemas.

## Contract enforcement

Contracts are currently used for:

- **Spec generation**: `aglc generate` auto-detects API routes.
- **Context emission**: `aglc emit-context` includes contract endpoints in `AGENTS.md`.
- **Commit-time contract gate**: implementing components must expose declared routes, and consuming components warn on undeclared or method-mismatched calls.

The contract gate runs as part of `aglc check` and `aglc check-file` when components declare `implements` or `consumes`.
