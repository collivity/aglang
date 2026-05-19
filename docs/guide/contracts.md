# Contracts

Contracts define the agreed-upon interface shape between two components. They serve two purposes:

1. **Documentation** — machine-readable record of what Component A expects from Component B
2. **Enforcement** — future versions can verify that the actual implementation matches the contract

## Basic syntax

```ag
contract PaymentToLedger {
  between: PaymentService and LedgerService
  endpoints: [
    "POST /ledger/debit",
    "POST /ledger/credit",
    "GET  /ledger/balance/{accountId}"
  ]
}
```

## Importing from OpenAPI

If you have an existing OpenAPI 3.x specification, you can import it directly:

```bash
aglc import-openapi swagger.json --out contracts.ag
```

The importer generates `contract` blocks for each path in the spec, which you can then refine.

## Importing from Terraform

Infrastructure contracts can be imported from Terraform:

```bash
aglc import-tf main.tf --out infra.ag
```

This generates `node` declarations for each Terraform resource.

## Combining contracts with invariants

```ag
contract StripeIntegration {
  between: PaymentService and StripeGateway
  endpoints: [
    "POST /v1/charges",
    "POST /v1/refunds"
  ]
}

invariant StripeOnlyViaPayment {
  # Only the PaymentService may call out to StripeGateway
  deny flow PublicAPI -> StripeGateway
}
```

## Contract enforcement

Contracts are currently used for:

- **Spec generation** (`aglc generate` auto-detects API routes)
- **Context emission** (`aglc emit-context` includes contract endpoints in AGENTS.md)
- **Z3 assertions** (endpoint mismatches can be expressed as violations)

Contract-level diff checking (comparing declared vs actual endpoints on each commit) is on the roadmap.
