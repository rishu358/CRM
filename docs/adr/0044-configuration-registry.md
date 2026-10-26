# ADR-0044: One configuration registry, loaded per scope, with the documentation generated from it

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** CLAUDE.md §5.8 and §13, ADR-0041 (production refuses development values), ADR-0042
  (the web app holds no credential), `docs/CONFIGURATION.md`

## Context

The goal is a codebase that anyone can clone, configure with environment variables, and deploy without
editing code (the "handover-ready" work). Configuration was already disciplined (one module per app was
the only reader of `process.env`, enforced by a lint rule), but it was declared in **five** places:
the API's, the worker's, the web app's, the db package's and the storage package's, each with its own Zod
schema. Three consequences:

1. **Nothing could be generated.** A schema says nothing about whether a value is secret, who issues it,
   or what it is for, so `.env.example` and the runbook were written by hand.
2. **They had drifted.** `.env.example` listed nine variables no code reads (`STORAGE_*`, `EMAIL_API_KEY`,
   `NEXT_PUBLIC_API_URL`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`) and omitted real ones
   (`RESEND_API_KEY`, `DATABASE_CA_CERT`). A person following it would have deployed a system that refused
   to start, with no hint why.
3. **The lint exemption was by file name.** Any file called `env.ts` (or inside an `env/` directory) could
   read `process.env`.

## Decision

### 1. A registry, in a new package `packages/env` (`@crm/env`)

Every variable is declared once in `packages/env/src/registry.ts`: its type and default (as the Zod schema
that validates it), the **scopes** that read it, whether it is **secret**, whether it is required, where to
get a value, a value for local development, and a note. Builders (`requiredText`, `defaultedInt`,
`defaultedChoice`, ...) produce the schema and the documentation from one declaration, so they cannot
disagree.

It is a new package rather than a folder inside `packages/config`, which was the first idea. `@crm/config`
is the **tooling** package (ESLint, TypeScript and Tailwind presets). It is a devDependency of every
package, and its production `dependencies` are `eslint`, `@eslint/js`, `globals` and `tailwindcss`. Making
it a runtime dependency of the API, worker and web app would ship those into every production image, and
would put the tool that checks the code inside the code it checks.

### 2. Per-app scopes, not one flat schema

A variable is validated, typed and documented only for the scopes it lists: `api`, `worker`, `web`, `db`
(the CLI scripts) and `perf` (load tests). `loadEnv('web')` returns a type that does not contain
`DATABASE_URL`, so web code cannot even name it.

A single flat schema validated by every process was considered and **rejected**: the web app would then
accept, or worse require, database credentials. It runs on a different platform and must hold none
(CLAUDE.md §3, ADR-0042). Beyond not naming them, `loadEnv('web')` **refuses to start outside local
development** if the environment contains any registered secret that is not in the web scope: the usual way
a database password reaches Vercel is someone pasting the whole `.env` into the project settings, and
nothing in the web app would otherwise ever notice. Local development is exempt because the repository
`.env` is shared by every process there. Which environment this is comes from a new `APP_ENV`
(`local` | `staging` | `production`), which defaults to `production` when `NODE_ENV=production` and to
`local` otherwise, so existing deployments need no new variable.

### 3. Fail fast, and never echo a secret

A process validates its scope before it listens and reports **every** problem at once. A missing required
variable says where to get it. For a secret, the message never includes what was typed (only its length
rule, which is the usual reason); `redactedEnv` produces a safe view for logs or support.

### 4. One reader of `process.env`

`packages/env/src/process-env.ts` is the only file in the application that reads it. The ESLint rule now
forbids it everywhere, with two exceptions: tool configuration (`*.config.ts`, which runs outside the
application and cannot import it), and that one file, exempted in the package that owns it
(`packages/env/eslint.config.js`) rather than by a name pattern in the shared config. Developer scripts
outside the application (`apps/web/scripts`, the performance test's row count) keep their own reads and are
listed in the generated docs as not covered.

### 5. Documentation is generated, and CI fails if it is stale

`pnpm config:docs` writes `.env.example`, `deploy/staging.env.example`, `deploy/production.env.example` and
`docs/CONFIGURATION.md` from the registry; `pnpm config:check` (in CI) regenerates and fails on any
difference. The registry's own tests prove the generated claims: a variable documented as required is
exactly what the loader requires, each documented default is the value the loader applies, every
credential is marked secret, the local example values load in every scope, and **no secret and no
`DATABASE_*` variable is ever in the web scope**. Mutation checks confirmed each of these fails when
broken.

## What changed in behaviour

- **An empty string is "not set".** `FOO=` in an env file, an empty platform field and compose's
  `${FOO:-}` previously reached the schemas as `""`; an optional URL then failed validation. Now every
  optional variable can be left blank, and a defaulted one takes its default.
- **`API_URL`, `WEB_URL`, `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` are validated as URLs in every scope**
  (the API previously accepted any string for the first two; production already refused non-URLs).
- **A loaded environment contains only registered variables** (the old schemas passed unknown variables
  through).
- **`.env.example` no longer lists the nine dead names** and now documents every real variable.
  `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` are not read by any code today; when observability is
  wired in, they are added to the registry like anything else.
- **The release variables docker-compose reads** (`CRM_REGISTRY`, `CRM_VERSION`, `APP_HOST`, `API_HOST`)
  are not application configuration (and `API_HOST` collides with the API's bind interface of the same
  name), so they are written by the generator as a fixed block rather than registered.

## Consequences

- Adding a variable is three steps (registry, `loadEnv`, `pnpm config:docs`), and forgetting any is a
  failing check, not a runtime surprise in someone else's deployment.
- The production rules stay in `@crm/core` (`packages/core/src/config/production.ts`). They need the whole
  picture (is this email provider real, is this URL local) rather than one variable at a time, and are fed
  from each app's loaded environment; they are not duplicated in the registry.
- Branding, deployment-mode and provider variables that later work adds (instance name, `DEPLOYMENT_MODE`,
  further provider choices, key rotation settings) are registry entries from the start.
- Not solved here: encryption-key rotation (`AUTH_SECRET` still signs cookies and encrypts MFA secrets
  directly) and Redis-backed rate limiting; both are separate changes that will add registry entries.
