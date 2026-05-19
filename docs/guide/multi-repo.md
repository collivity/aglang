# Multi-Repo Architecture

aglang supports a **central architecture repository** pattern — one repo holds all your `.ag` files and enforces architectural rules across multiple codebases.

## The Pattern

```
my-org/
  architecture/       ← central aglang repo (source of truth)
    system.ag
    payments.ag
    mobile.ag
  backend-api/        ← code repo
  android-app/        ← code repo
  web-frontend/       ← code repo
```

Your `.ag` spec lives in one place. Each code repo's CI pulls that spec and runs `aglc check` against itself. No duplication, no drift.

## Declaring Repos in Your Spec

Use the `repo` keyword to declare external repositories and bind components to them:

```ag
// Declare external repositories
repo BackendAPI   "github.com/my-org/backend-api"   branch="main"
repo AndroidApp   "github.com/my-org/android-app"   branch="main"
repo WebFrontend  "github.com/my-org/web-frontend"  branch="main"

node AppServer    : server       { trust: trusted }
node MobileDevice : edge_mobile  { trust: untrusted }
node Database     : postgres     { trust: trusted }

// Bind components to their repos
component PaymentService {
  repo: BackendAPI
  runs_on: AppServer
  paths: "src/payment/**"
}

component MobileCheckout {
  repo: AndroidApp
  runs_on: MobileDevice
  paths: "app/checkout/**"
}

// Invariant enforced across all repos
invariant SecureLedger {
  deny flow MobileCheckout -> PaymentService;
}
```

The `repo` field is **documentation and validation** — it tells humans and tools which codebase owns each component. The paths glob is still relative to whichever repo is being checked.

## CI Setup (Pull Model)

Add a single workflow file to **each code repo**. It pulls the central spec and checks the current repo against it.

### `.github/workflows/arch-check.yml`

```yaml
name: Architecture Check

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  arch-check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code repo
        uses: actions/checkout@v4

      - name: Checkout architecture spec
        uses: actions/checkout@v4
        with:
          repository: my-org/architecture    # ← your architecture repo
          path: .arch-rules
          # For private repos, add: token: ${{ secrets.ARCH_REPO_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Compile architecture spec
        run: npx --yes @collivity/aglang compile .arch-rules/system.ag

      - name: Run architecture check
        run: npx @collivity/aglang check --arch .arch-rules/architecture.o --project . --json
```

::: tip Copy the template
A ready-to-use template is in the aglang repo at [`examples/multi-repo/arch-check.yml`](https://github.com/collivity/aglang/tree/master/examples/multi-repo).
:::

## How It Works

```
my-org/architecture repo          my-org/backend-api repo
────────────────────────          ──────────────────────────
system.ag                         PR #42: change payment code
     │                                       │
     │  (CI clones architecture repo)        │
     └──────────────────────────────────────>│
                                             │
                                        aglc compile system.ag
                                        aglc check --arch architecture.o --project .
                                             │
                                      ┌──────┴──────┐
                                   PASS ✓         FAIL ✗
                                      │              │
                               Merge allowed    PR blocked
                                               + violation report
```

1. **On every PR**, the CI in `backend-api` checks out the central `architecture` repo
2. **Compiles** `system.ag` → `architecture.o` (takes ~1 second)
3. **Checks** the staged/changed files in `backend-api` against the compiled constraints
4. **Reports** violations inline in the PR — no manual review needed

## Private Architecture Repos

If your architecture repo is private, create a [fine-grained Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with `Contents: Read` scope on the architecture repo, then add it as a repository secret:

```yaml
- name: Checkout architecture spec
  uses: actions/checkout@v4
  with:
    repository: my-org/architecture
    path: .arch-rules
    token: ${{ secrets.ARCH_REPO_TOKEN }}
```

## Local Development

Developers can run the same check locally before pushing:

```bash
# Clone the architecture repo once
git clone https://github.com/my-org/architecture .arch-rules

# Compile the spec
npx @collivity/aglang compile .arch-rules/system.ag

# Check your local changes (in your code repo)
npx @collivity/aglang check --arch .arch-rules/architecture.o --project .
```

## Monorepo vs Multi-Repo

| Setup | Recommendation |
|---|---|
| Monorepo (all code in one repo) | Put `system.ag` at the root, use relative `paths` globs |
| Multi-repo (separate repos per service) | Use the `repo` keyword + Pull model CI (this page) |
| Mixed | Declare local components without `repo:`, external ones with `repo:` |
