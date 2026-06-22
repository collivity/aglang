# Contributing to aglang

Thanks for considering a contribution. This repo verifies itself with its own tool, which makes the workflow slightly different from a typical TypeScript project — read the "Self-hosting" section before you open a PR, not after.

## Setup

```bash
npm install
npm run build
```

Node.js >= 18. `npm install` runs a `prepare` step that builds the CLI (`build/aglc.js`); the native tree-sitter bindings are real npm dependencies, not optional — if a grammar fails to load, the affected extractor silently falls back to regex (`src/analyzers/ast/loader.ts`), so a missing prebuilt binary won't break your install, but it will quietly reduce extraction quality for that language. Worth knowing if a test behaves differently on your machine.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
npm run arch:check
```

`npm run arch:check` is this repo's own architecture self-check (`aglc check --arch architecture.o --project . --all`). CI also runs a second, diff-aware pass (`aglc check --diff <base>`) that's stricter — see below.

## Self-hosting: why your PR might require touching `architecture.ag`

This repo's own architecture is declared in `architecture.ag` and checked against itself on every PR. The most common thing this catches: a `change_policy` rule requiring that certain files be touched together. For example, editing anything under `src/runtime/**` or `src/ir/**` requires also touching `architecture.ag` (`change_policy DocsFreshness` in `architecture.ag`) — the idea is that core runtime/IR behavior changing should prompt at least a review of whether the architecture spec still describes reality, not a silent drift.

If CI's diff-aware check fails with a `change_violation`, it'll tell you exactly which file triggered it and which file it expects touched in the same change — that's the whole error, not a hint to go digging.

If you do need to touch `architecture.ag`:
1. Make a **real** structural change (a new component, a new invariant, a new policy rule) — not a comment-only edit. Comments are stripped at compile time, so a comment-only touch won't actually change `architecture.o`/`AGENTS.md`, and `change_policy` requires those to differ too once `architecture.ag` changes. If you genuinely have nothing structural to add, say so in the PR description and we'll look at whether the rule needs a real exception mechanism (it currently doesn't have one).
2. Regenerate the downstream artifacts:
   ```bash
   node build/aglc.js compile architecture.ag --out architecture.o
   node build/aglc.js emit-context --arch architecture.o --out AGENTS.md
   node build/aglc.js emit-skill --arch architecture.o --out skill.json
   ```
3. Re-run `npm run arch:check` to confirm it's clean.

`aglc check --diff <ref>` (used by CI, diffing against the PR base) is a much better way to verify this locally than `--all` — `--all` marks every file in the repo as "touched," which trivially satisfies every `change_policy` rule and won't actually exercise it. If you want to check your own branch the way CI will:
```bash
node build/aglc.js check --arch architecture.o --project . --diff master
```

## Tests

Vitest, run via `npm test` / `npx vitest run`. Conventions worth following, established across this codebase's extraction work:
- **Verify grammar shapes empirically before writing a query.** Several real bugs in this codebase (wrong tree-sitter field names, capture names the extractor doesn't recognize) were caught only by parsing real source and inspecting the actual AST, not by assumption. If you're adding or changing a tree-sitter query, write a throwaway probe script first, confirm the shape, then write the query and a low-level test for it before wiring it into anything else.
- **Document limitations as tests, not comments.** Where a feature has a known gap (an unresolvable case, a heuristic that's intentionally conservative), there's usually a test asserting the gap *doesn't* silently produce a wrong answer — see `tests/abstraction-resolver.test.ts`'s noise-threshold test for an example. Prefer adding to that pattern over a code comment alone.
- Real temp directories with real files for anything touching extraction (`tmpdir()` + `mkdirSync`/`writeFileSync`, cleaned up in `afterEach`) — not mocked file systems.

## Architecture/spec authoring

`.ag` files and `.agq.yml` query files are reviewed, committed source artifacts — `aglc check` never calls an LLM, by design. If you're proposing a change to architecture rules or extraction queries (not just implementation), say so explicitly in the PR; these get reviewed differently than ordinary code changes.

## Docs

`docs/` is a VitePress site (`npm run docs:dev` to preview, `npm run docs:build` to build). If you change CLI behavior, update `docs/cli/reference.md`; the `DocsFreshness` policy may require it for changes to `src/index.ts` or `package.json`.

If you change language coverage (a new resolved-call shape, a new heuristic, a closed gap), update `known_limitations` in `src/emitters/skill.ts` too — it's hand-maintained prose, the same as `advisory_note`, and it's the thing agents actually read to know what not to over-trust. It goes stale exactly the way README.md did if nobody's job is to touch it.
