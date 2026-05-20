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

The built-in config extractor detects a route from `LoadBalancer` to `NonGdprService`. Because `LoadBalancer` declares `handles: CustomerProfile`, aglang infers this dataflow fact:

```text
DataFlow(CustomerProfile, NonGdprService)
```

The invariant compiles to this Z3 constraint:

```smt2
(assert (=> (DataFlow CustomerProfile NonGdprService) false))
```

The changed config contributes this assertion:

```smt2
(assert (DataFlow CustomerProfile NonGdprService))
```

Together they are unsatisfiable, so `aglc check` fails with a `dataflow_violation`.

Correct config routes the same path to the GDPR-compliant service:

```yaml
routes:
  - path: /eu/customers
    backend: GdprService
```

That produces `DataFlow(CustomerProfile, GdprService)`, which does not violate `GdprResidency`.

## What this proves

This proves a precise architecture property: data classified by the spec as `CustomerProfile`, when carried by the load balancer, cannot be routed to the explicitly denied target.

It does not automatically infer legal compliance from prose. You still declare the compliance boundary in `.ag`, and extractors must be able to see the routing fact in code or config.
