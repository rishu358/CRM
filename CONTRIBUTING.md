# Contributing

How to change this codebase without breaking what makes it safe to run. Read
[`CLAUDE.md`](CLAUDE.md) first: it is binding for people and for AI assistants alike, and this page
only adds the mechanics. If a request seems to conflict with a rule there, stop and ask; do not work
around it.

Priorities, in order: **Security → Correctness → Speed/UX → Features.**

## Set up

Requires Node 24+, pnpm 9 and Docker. The current steps are in the [README](README.md#getting-started).

**After every pull or merge that adds a workspace package, run `pnpm install`.** A new package exists in
the tree but is linked into nobody's `node_modules` until you do, and the error is a `TS2307: Cannot find
module '@crm/...'` that names whichever app imports it first, not the package that is missing. (This
happened when `@crm/env` arrived, ADR-0044.)

**A shared env file and the web app.** The web app refuses to start outside local development if its
environment holds a secret meant for another process (`DATABASE_URL`, `AUTH_SECRET`, storage keys; see
`docs/CONFIGURATION.md`). Scripts and test runners that start every process from one shared env file must
set `APP_ENV=local` for the web process, or every page answers 500 with a message saying so. On a real
deployment, give the web app only its own variables instead.

Then, once per clone, turn on the repository's hooks:

```bash
pnpm hooks:install      # git config core.hooksPath .githooks
```

| Hook         | What it does                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `pre-commit` | Scans the staged files for secrets with gitleaks (local binary, else Docker). Findings are redacted. |
| `commit-msg` | Rejects a message that is not a Conventional Commit.                                                 |

The hooks need no package: they are plain shell and Node. `git commit --no-verify` skips them, and
CI repeats both checks, so skipping only moves the failure.

## Working on a change

1. **Plan first** for anything non-trivial: files to touch, schema changes, risks. Wait for approval
   (CLAUDE.md §11.1). Prefer small pull requests that each stand alone.
2. **One module end to end:** schema, migration, RLS, repository, service, controller, contracts,
   tests, UI, E2E (CLAUDE.md §11.2).
3. **Branch** from `master`; name it for the change (`feat/contacts-merge`, `fix/session-expiry`).
4. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(contacts): detect duplicates on import`. Types: `feat fix docs style refactor perf test
build ci chore revert`. A `!` after the scope marks a breaking change. Keep the subject under 100
   characters. `wip` commits are fine on a branch but must be reworded or squashed before the pull
   request, because CI checks the pull request's commits.
5. **Open a pull request** and fill in the template; it is the definition of done (CLAUDE.md §12).
   CODEOWNERS are requested automatically for the sensitive paths.

## The checks, and what runs them

```bash
pnpm lint && pnpm typecheck && pnpm format:check
pnpm test                # unit + integration (real Postgres via Testcontainers; needs Docker)
pnpm test:security       # tenant isolation + permissions: must always pass, never skipped
pnpm test:e2e            # Playwright, for the critical flows
pnpm openapi:check       # the API document matches the code
pnpm config:check        # generated .env.example / CONFIGURATION.md are current
pnpm test:scripts        # the repository's own scripts
bash scripts/scan-secrets.sh   # gitleaks over the whole history, failing closed
```

CI runs all of these (`.github/workflows/ci.yml`) plus a dependency audit that fails on high or
critical advisories. Integration tests never mock the database for permission checks.

## Rules that are easy to forget

- **Tenant isolation is not optional.** Every tenant table has `tenant_id` and an RLS policy, every
  request runs in a transaction that sets the tenant, and the app role has no `BYPASSRLS`. Never
  trust the client for tenant, user, role, ownership or price.
- **Every endpoint is authorised through `can()`**; no inline role checks. Hidden fields are removed
  from responses and rejected on write.
- **No hardcoded configuration, and no `process.env` outside `packages/env`.** A domain, URL, email
  address, region, bucket, name or brand string comes from configuration. Add a new variable to
  `packages/env/src/registry.ts` (its scopes, whether it is secret, where to get it), read it with
  `loadEnv(scope)`, run `pnpm config:docs` and commit the regenerated `.env.example`, templates and
  `docs/CONFIGURATION.md`. A new vendor goes behind a provider adapter chosen by an env variable. The
  full rules are CLAUDE.md §13.
- **No secrets in the repository, tests, docs, logs or error messages**, not even "temporary" ones.
  If one is committed, treat it as exposed: rotate it first, then remove it
  ([`SECURITY.md`](SECURITY.md#if-you-committed-a-secret)).
- **Migrations are forward-only** and must be safe on a large live table. Never edit a migration that
  has been merged; write a new one.
- **Ask before adding a dependency** (CLAUDE.md §11.4), and say what its licence is. Prefer
  well-maintained, widely used packages, and prefer no package to a small one.
- **Never disable a lint rule, test, type check or RLS policy to make something pass** (§11.6).
- **Write an ADR** in `docs/adr/` for any decision that would be expensive to reverse (§11.7).

## Versioning and releases

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z` on the commit that
is released. Every user-visible change goes in [`CHANGELOG.md`](CHANGELOG.md) under **Unreleased** as
it merges; a release renames that heading to the version and date. Breaking API changes need a new
API version (CLAUDE.md §8), not a major bump alone.

Cut a release from a green `master`:

```bash
# update CHANGELOG.md, then
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

Build the images from the tagged commit and tag them with the same version (see
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) §3 and §9.5).
