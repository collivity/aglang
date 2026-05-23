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
