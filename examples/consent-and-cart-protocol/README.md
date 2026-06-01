# Consent and cart protocol example

Demonstrates two patterns discussed in the aglang docs:

1. **Consent-first UX** — model consent as `UserSession.consent` + `machine ConsentLifecycle`, with `.agq.yml` emitting transition facts from assignments.
2. **Shared cart protocol** — model cart shape as `CartPhase` on `SharedCart.phase` instead of raw array length.
3. **Compliance gate (imports)** — `require flow Checkout -> ApiClient via Compliance` uses component import facts (no UI navigation extractors).
4. **Rich policy facts** — `value_policy`, `operation_policy`, and `event_policy` show cart length, submit-order pre/postconditions, and consent event precedence.

## Files

| Path | Role |
|------|------|
| `architecture.ag` | Machines, components, `ConsentBeforeApi` invariant, rich policies |
| `.aglang/extractors/*.agq.yml` | Match `assignment` graph facts → `transition` |
| `src/consent.ts` | Guarded consent transitions + `acceptWithoutBanner` (bad) |
| `src/cart.ts` | Legal cart transitions + `jumpToMultiItem` (bad) |
| `src/checkout.ts` | Imports API without compliance (bad) |
| `src/checkout-good.ts` | Routes API through `compliance.ts` |
| `src/compliance.ts` | Compliance gate module |

## Try it

From the repository root:

```bash
npm run build
node build/aglc.js compile examples/consent-and-cart-protocol/architecture.ag --out /tmp/consent-cart.o
node build/aglc.js check --arch /tmp/consent-cart.o --project examples/consent-and-cart-protocol --all --json
```

Expect violations for `acceptWithoutBanner`, `jumpToMultiItem`, and `checkout.ts` bypassing `Compliance`. Rich value, operation, and event policies block when you add reviewed `.agq.yml` facts that emit `kind: value`, `kind: operation_event`, or `kind: event`.

## Navigation screens

UI route graphs (Compose `NavHost`, Next.js app router, etc.) are **not** extracted here. Add project-specific `.agq.yml` files that emit `flow` facts when you model screens as components.
