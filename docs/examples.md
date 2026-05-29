# Examples

## GDPR-safe load balancing

This example models a load balancer in front of two container-backed services:

- `GdprService` runs in a GDPR-compliant container.
- `NonGdprService` runs in a container that is not approved for EU personal data.
- `LoadBalancer` handles `CustomerProfile` traffic and routes requests based on config.

The goal is formal: EU customer profile data must never be routed to `NonGdprService`.

```ag
node public_lb : load_balancer {
  trust: trusted
}

node gdpr_container : container {
  trust: trusted
  compliance: gdpr
}

node non_gdpr_container : container {
  trust: semi_trusted
  compliance: none
}

data CustomerProfile {
  classification: String
  jurisdiction: String
}

component LoadBalancer {
  runs_on: public_lb
  paths: "infra/lb.yaml"
  handles: CustomerProfile
}

component GdprService {
  runs_on: gdpr_container
  paths: "services/gdpr/**"
  handles: CustomerProfile
}

component NonGdprService {
  runs_on: non_gdpr_container
  paths: "services/non-gdpr/**"
}

invariant GdprResidency {
  deny dataflow CustomerProfile -> NonGdprService
}
```

Now suppose the load balancer config accidentally routes EU customer traffic to the non-GDPR service:

```yaml
routes:
  - path: /eu/customers
    backend: NonGdprService
```

The built-in config extractor detects a route from `LoadBalancer` to `NonGdprService`. Because `LoadBalancer` declares `handles: CustomerProfile`, aglang infers this propagated data reachability fact:

```text
DataCanReach(CustomerProfile, NonGdprService)
```

The invariant compiles to this Z3 constraint:

```smt2
(assert (=> (DataCanReach CustomerProfile NonGdprService) false))
```

The changed config contributes this assertion:

```smt2
(assert (DataCanReach CustomerProfile NonGdprService))
```

Together they are unsatisfiable, so `aglc check` fails with a `dataflow_violation`.

## Transitive Reachability

Use `deny reach` when indirect paths matter:

```ag
invariant Layering {
  deny reach UI -> Db
}
```

If extractors prove `UI -> Service` and `Service -> Db`, aglang emits `CanReach UI Db` and reports a `reach_violation` with `detected.path: ["UI", "Service", "Db"]`.

## Classification And Trust Boundaries

```ag
data CustomerProfile {
  classification: pii
  jurisdiction: eu
  id: UUID
}

data_policy Privacy {
  deny classification pii -> untrusted
  deny jurisdiction eu -> NonGdprService
}

trust_policy Boundaries {
  require auth untrusted -> trusted
  deny flow trusted -> untrusted when data pii
}
```

These policies combine propagated reachability with declared `trust:` and `auth:` metadata. They block only when extractors produce definite flow/data evidence.

Correct config routes the same path to the GDPR-compliant service:

```yaml
routes:
  - path: /eu/customers
    backend: GdprService
```

That produces `DataCanReach(CustomerProfile, GdprService)`, which does not violate `GdprResidency`.

## What this proves

This proves a precise architecture property: data classified by the spec as `CustomerProfile`, when carried by the load balancer, cannot be routed to the explicitly denied target.

It does not automatically infer legal compliance from prose. You still declare the compliance boundary in `.ag`, and extractors must be able to see the routing fact in code or config.

## C# MVVM dependency injection boundaries

This example models a C# desktop or mobile app that uses dependency injection:

- Views must not inject infrastructure services directly.
- ViewModels must not depend on repositories or database contexts directly.
- Singleton services must not depend on scoped services.
- Application code must not use `IServiceProvider` as a service locator.

```ag
node app_runtime : edge_desktop {
  trust: trusted
}

component Views {
  runs_on: app_runtime
  paths: "src/**/Views/**/*.xaml.cs"
}

component ViewModels {
  runs_on: app_runtime
  paths: "src/**/ViewModels/**/*.cs"
}

component BleManager {
  runs_on: app_runtime
  paths: "src/**/Infrastructure/Bluetooth/**/*.cs"
}

component Repositories {
  runs_on: app_runtime
  paths: "src/**/Infrastructure/Persistence/**/*.cs"
}

component DbContexts {
  runs_on: app_runtime
  paths: "src/**/Infrastructure/Persistence/**/*DbContext.cs"
}

component Application {
  runs_on: app_runtime
  paths: "src/**/Application/**/*.cs"
}

di_policy DependencyInjection {
  deny inject Views -> BleManager
  deny inject ViewModels -> Repositories
  deny inject ViewModels -> DbContexts
  deny lifetime singleton -> scoped
  deny resolve IServiceProvider from Application
}
```

Now suppose a view directly injects Bluetooth infrastructure:

```csharp
public partial class DevicePage
{
    public DevicePage(BleManager bleManager)
    {
    }
}
```

The C# extractor maps `DevicePage` to `Views`, maps `BleManager` to the `BleManager` component, and emits:

```smt2
(assert (Injects Views BleManager))
```

The policy compiled from `.ag` contains:

```smt2
(assert (=> (Injects Views BleManager) false))
```

Together those assertions are unsatisfiable, so `aglc check` fails with a `di_violation`.

Lifetime checks work the same way. Given registrations:

```csharp
services.AddSingleton<IBleManager, BleManager>();
services.AddScoped<IOrderRepository, OrderRepository>();
```

and this constructor:

```csharp
public sealed class BleManager
{
    public BleManager(IOrderRepository orders)
    {
    }
}
```

aglang emits:

```smt2
(assert (LifetimeDepends Lifetime__singleton Lifetime__scoped))
```

That contradicts `deny lifetime singleton -> scoped`, so the check blocks before the invalid DI graph lands.

Service-locator rules are also explicit:

```csharp
public sealed class SyncHandler
{
    public SyncHandler(IServiceProvider services)
    {
    }
}
```

With `deny resolve IServiceProvider from Application`, this emits `(assert (Resolves Application IServiceProvider))` and fails in Z3.

## Multi-runtime order lifecycle

This example models a common Stripe-style order workflow spread across several runtimes:

- Android starts checkout but must not mark an order as fulfilled.
- The backend API creates the payment intent and moves `Created -> PendingPayment`.
- The Stripe webhook is the authority for `PendingPayment -> Paid` and `Paid -> Refunded`.
- A worker performs fulfillment with `Paid -> FulfillmentQueued -> Fulfilled`.

The machine is declared once, even though the code that mutates orders is scattered:

```ag
node android_device : edge_mobile {
  trust: untrusted
}

node api_runtime : server {
  trust: trusted
  auth: jwt
}

node worker_runtime : server {
  trust: trusted
  auth: mtls
}

enum OrderStatus {
  Created | PendingPayment | Paid | FulfillmentQueued | Fulfilled | Cancelled | Refunded
}

data Order {
  id: UUID
  status: OrderStatus
  stripe_payment_intent_id: Optional<String>
}

component AndroidApp {
  runs_on: android_device
  paths: "android/**/*.kt"
}

component BackendApi {
  runs_on: api_runtime
  paths: "backend/api/**/*.ts"
}

component StripeWebhook {
  runs_on: api_runtime
  paths: "backend/webhooks/**/*.ts"
}

component FulfillmentWorker {
  runs_on: worker_runtime
  paths: "workers/**/*.ts"
}

machine OrderLifecycle on Order.status {
  allow transition Created -> PendingPayment
  allow transition PendingPayment -> Paid
  allow transition PendingPayment -> Cancelled
  allow transition Paid -> FulfillmentQueued
  allow transition FulfillmentQueued -> Fulfilled
  allow transition Paid -> Refunded
  deny transition Created -> Paid
  deny transition Created -> Fulfilled
  deny transition PendingPayment -> Fulfilled
  deny transition Cancelled -> *
  deny transition Refunded -> *
}
```

The reviewed query files in `.aglang/extractors/` tell aglang which graph facts count as order transitions. A TypeScript query can be scoped to the TypeScript extractor:

```yaml
id: StripeOrderLifecycleTypeScriptAssignments
owner: examples
version: 1
confidence: definite
match:
  extractor: TypeScript/Node.js server analyzer
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
```

Android/Kotlin can participate in the same lifecycle with a second query:

```yaml
id: StripeOrderLifecycleKotlinAssignments
owner: examples
version: 1
confidence: definite
match:
  extractor: Kotlin regex analyzer
  kind: assignment
  property: status
  valueEnum: OrderStatus
emit:
  kind: transition
  data: Order
  field: status
  from: "$previousMember"
  to: "$valueMember"
```

Given this Android code:

```kotlin
class CheckoutViewModel {
    fun optimisticFulfill(order: Order) {
        if (order.status == OrderStatus.PendingPayment) {
            order.status = OrderStatus.Fulfilled
        }
    }
}
```

the Kotlin extractor emits a graph fact for the guarded assignment. The query turns that into this transition evidence:

```text
Order.status PendingPayment -> Fulfilled
```

That edge is explicitly denied by `OrderLifecycle`, so `aglc check` fails. The human-readable diagnostic includes the machine, transition, source file, query id, graph fact id, and Z3 proof:

```text
aglang State Machine Violation

Machine Violated:  OrderLifecycle
Transition:        Order.status PendingPayment -> Fulfilled

Detected in file:
  examples/stripe-order-workflow/android/CheckoutViewModel.kt

Evidence: [confidence: definite]
  Extraction query 'StripeOrderLifecycleKotlinAssignments' matched assignment:
  order.status = OrderStatus.Fulfilled

Query: StripeOrderLifecycleKotlinAssignments@1
  examples/stripe-order-workflow/.aglang/extractors/order-lifecycle-kotlin.agq.yml
  GraphFact: kotlin-semantic:...CheckoutViewModel.kt:19:assignment:...

Z3 Proof (conflicting assertions):
  Permanent rule: (assert (=> (Transition Order Field__Order__status State__OrderStatus__PendingPayment State__OrderStatus__Fulfilled) false))
  Delta (your code): (assert (Transition Order Field__Order__status State__OrderStatus__PendingPayment State__OrderStatus__Fulfilled))
```

The same check also emits a structured JSON verdict for agents and CI:

```json
{
  "type": "state_machine_violation",
  "invariant": "OrderLifecycle",
  "rule": {
    "kind": "Transition",
    "from": "PendingPayment",
    "to": "Fulfilled",
    "data": "Order",
    "field": "status"
  },
  "detected": {
    "from": "PendingPayment",
    "to": "Fulfilled",
    "data": "Order",
    "confidence": "definite",
    "file": "examples/stripe-order-workflow/android/CheckoutViewModel.kt",
    "query": {
      "id": "StripeOrderLifecycleKotlinAssignments",
      "version": 1,
      "file": "examples/stripe-order-workflow/.aglang/extractors/order-lifecycle-kotlin.agq.yml",
      "graphFactId": "kotlin-semantic:...CheckoutViewModel.kt:19:assignment:..."
    }
  }
}
```

Run the example locally:

```bash
aglc compile examples/stripe-order-workflow/architecture.ag --out /tmp/aglang-stripe-order-workflow.o
aglc check --arch /tmp/aglang-stripe-order-workflow.o --project examples/stripe-order-workflow --all
```

This is the main value of state machines in aglang: a lifecycle rule declared once is enforced against transition evidence from multiple runtimes and languages.
